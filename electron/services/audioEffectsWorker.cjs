const { spawn } = require('node:child_process')
const { encodeFrame, createFrameDecoder } = require('./audioEffectsProtocol.cjs')

/** Owns native children and the renderer port; main/renderer UI threads never relay PCM. */
function createAudioEffectsWorker({ send, spawnChild = spawn }) {
  let host = null, port = null, scanner = null, cancelScanner = null, hostGeneration = 0, nextId = 0, lifetime = 0
  let nativePath = '', runtime = { sampleRate: 48000, maxBlockSize: 512 }, chain = []
  let enabled = false, stopping = false, configured = false, configuring = Promise.resolve()
  let tempo = 120, trackId = '', analysisGeneration = 0, watchdog = null, lastAudioAt = 0, lastReplyAt = 0
  let latencySamples = 0
  const pending = new Map()
  const publish = message => { send(message); if (message.type === 'status') port?.postMessage(message) }
  const errorText = error => String(error?.message || error || '音效宿主发生错误').slice(0, 500)

  function failed(error, child = host) {
    if (child !== host) return
    configured = false
    const previous = host
    host = null
    hostGeneration++
    clearInterval(watchdog)
    watchdog = null
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(errorText(error))) }
    pending.clear()
    previous?.kill()
    publish({ type: 'status', running: false, error: stopping ? '' : errorText(error), latencySamples })
  }

  function write(header, pcm) {
    if (!host?.stdin?.writable) throw new Error('音效宿主未运行')
    if (host.stdin.writableLength > 2 * 1024 * 1024) throw new Error('音效处理跟不上播放，已旁路')
    host.stdin.write(encodeFrame(header, pcm))
  }

  function request(command, args = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('音效操作超时')); failed(new Error('音效宿主没有响应')) }, timeout)
      pending.set(id, { resolve, reject, timer })
      try { write({ ...args, id, command }) } catch (error) { pending.delete(id); clearTimeout(timer); reject(error) }
    })
  }

  function start() {
    if (host) return
    stopping = false
    const child = spawnChild(nativePath, ['--host'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    host = child
    const generation = ++hostGeneration
    const decode = createFrameDecoder((header, pcm) => {
      if (generation !== hostGeneration) return
      if (header.id && pending.has(header.id)) {
        const task = pending.get(header.id)
        pending.delete(header.id)
        clearTimeout(task.timer)
        if (header.ok) task.resolve(header.result)
        else task.reject(new Error(typeof header.error === 'string' ? header.error : header.error?.message || '插件操作失败'))
      } else if (header.type === 'audio') {
        lastReplyAt = Date.now()
        if (Number.isSafeInteger(header.latencySamples) && header.latencySamples >= 0) latencySamples = header.latencySamples
        port?.postMessage({ ...header, pcm })
      } else if (header.type === 'tempo') {
        if (header.trackId === trackId && header.generation === analysisGeneration) send(header)
      } else if (['status', 'parameters', 'editor', 'dirty'].includes(header.type)) publish(header)
    })
    child.stdout.on('data', chunk => { try { decode(chunk) } catch (error) { failed(error, child) } })
    // Plugin messages are diagnostic only. Never forward paths, presets or license text to the renderer.
    child.stderr.on('data', () => {})
    child.stdin.on('error', error => failed(error, child))
    child.on('error', error => failed(error, child))
    child.on('exit', () => failed(new Error('音效宿主已退出，当前使用原始声音'), child))
    lastReplyAt = Date.now()
    watchdog = setInterval(() => {
      if (lastAudioAt > lastReplyAt && Date.now() - lastReplyAt > 2000) failed(new Error('插件处理超时，当前使用原始声音'))
    }, 500)
  }

  async function configure() {
    const epoch = lifetime
    const task = async () => {
      if (epoch !== lifetime || stopping) return
      if (!enabled && !host) { publish({ type: 'status', running: false, enabled: false, latencySamples: 0 }); return }
      start()
      const child = host
      configured = false
      port?.postMessage({ type: 'status', running: false, reconfiguring: true })
      let result
      try { result = await request('configure', { ...runtime, chain, tempo }) }
      catch (error) { if (epoch === lifetime) failed(error, child); throw error }
      if (epoch !== lifetime || stopping) return
      configured = true
      if (Number.isSafeInteger(result?.latencySamples) && result.latencySamples >= 0) latencySamples = result.latencySamples
      publish({ type: 'status', ...result, running: true, enabled, error: '' })
    }
    configuring = configuring.catch(() => {}).then(task)
    return configuring
  }

  /** Scan in a disposable child: a module timeout cannot kill the active effect chain. */
  function scan(file) {
    if (scanner) return Promise.reject(new Error('已有插件正在扫描'))
    return new Promise((resolve, reject) => {
      const child = spawnChild(nativePath, ['--scan', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      scanner = child
      const output = []
      let outputSize = 0, finished = false
      const finish = (error, result) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (scanner === child) { scanner = null; cancelScanner = null }
        if (error) reject(error); else resolve(result)
      }
      const timer = setTimeout(() => { child.kill(); finish(new Error('插件扫描超过 30 秒，已跳过')) }, 30000)
      cancelScanner = () => { child.kill(); finish(new Error('插件扫描已取消')) }
      child.stdout.on('data', chunk => {
        if (finished) return
        outputSize += chunk.length
        if (outputSize > 8 * 1024 * 1024) { child.kill(); finish(new Error('插件扫描结果过大')) }
        else output.push(Buffer.from(chunk))
      })
      child.stderr.on('data', () => {})
      child.on('error', error => finish(error))
      child.on('exit', code => {
        if (code !== 0) return finish(new Error('插件无法加载或架构不匹配'))
        try {
          const result = JSON.parse(Buffer.concat(output).toString('utf8'))
          finish(null, Array.isArray(result) ? result : result.plugins || result.result || [])
        } catch { finish(new Error('插件扫描返回无效结果')) }
      })
    })
  }

  function connect(nextPort) {
    if (!nextPort?.on || !nextPort?.postMessage || !nextPort?.start) throw new Error('音频通道无效')
    stopping = false
    port?.close()
    port = nextPort
    const current = port
    port.on('message', ({ data }) => {
      if (port !== current || !data || typeof data !== 'object') return
      try {
        if (data.type === 'configure') {
          const sampleRate = Number(data.sampleRate)
          if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return
          runtime = { sampleRate, maxBlockSize: 512 }
          void configure().catch(() => { /* configure reports the failure against its captured native instance. */ })
        } else if (data.type === 'track') {
          if (typeof data.trackId !== 'string' || data.trackId.length > 1024 || !Number.isSafeInteger(data.generation) || data.generation < 0) return
          trackId = data.trackId; analysisGeneration = data.generation
          send({ type: 'track', trackId, generation: analysisGeneration })
        } else if (data.type === 'audio' || data.type === 'analysis') {
          if (data.type === 'analysis') port?.postMessage({ type: 'analysis-ack', generation: data.generation, sequence: data.sequence })
          if (!host || !configured || !enabled) return
          const frames = data.frames, channels = data.type === 'audio' ? 2 : 1
          if (!Number.isSafeInteger(frames) || frames < 1 || frames > 8192 || !(data.pcm instanceof Float32Array) || data.pcm.length !== frames * channels) return
          if (data.type === 'audio' && frames !== 512) return
          if (!Number.isSafeInteger(data.generation) || data.generation < 0 || !Number.isSafeInteger(data.sequence) || data.sequence < 0 ||
            !Number.isFinite(data.position) || data.position < 0) return
          // The dedicated renderer port carries PCM, never native RPC ids or plugin paths.
          // Native replies echo audio headers, so forwarding arbitrary keys could also
          // confuse the separate pending-control response table.
          const header = { type: data.type, generation: data.generation, sequence: data.sequence,
            frames, channels, sampleRate: runtime.sampleRate, position: data.position, playing: data.playing === true }
          if (data.type === 'analysis') {
            if (typeof data.trackId !== 'string' || data.trackId.length > 1024) return
            header.trackId = data.trackId
            if (trackId !== data.trackId || analysisGeneration !== data.generation) {
              trackId = data.trackId; analysisGeneration = data.generation
              send({ type: 'track', trackId, generation: analysisGeneration })
            }
          } else { lastAudioAt = Date.now(); header.tempo = tempo; header.trackId = trackId }
          write(header, data.pcm)
        } else if (data.type === 'reset') {
          if (!Number.isSafeInteger(data.generation) || data.generation < 0) return
          analysisGeneration = data.generation
          send({ type: 'track', trackId, generation: analysisGeneration })
          if (host) { const child = host; void request('flush', { generation: data.generation }).catch(error => failed(error, child)) }
        } else if (data.type === 'transport') {
          if (host) { const child = host; void request('transport', { playing: data.playing === true, position: Math.max(0, Number(data.position) || 0) }).catch(error => failed(error, child)) }
        }
      } catch (error) { failed(error) }
    })
    port.start()
    port.postMessage({ type: 'status', running: configured, enabled, tempo })
  }

  async function stop() {
    stopping = true
    lifetime++
    port?.close(); port = null
    cancelScanner?.()
    if (host) {
      const child = host
      try { await request('shutdown', {}, 1500) } catch { /* The bounded shutdown path already terminates an unresponsive owned child. */ }
      if (child === host) failed(new Error(''), child)
    }
    configured = false
    trackId = ''; analysisGeneration = 0; tempo = 120
    clearInterval(watchdog)
  }

  async function handle(message, ports = []) {
    const { id, operation, args = {} } = message || {}
    try {
      let result
      if (operation === 'initialize') { nativePath = args.nativePath; result = true }
      else if (operation === 'connect') { connect(ports[0]); result = true }
      else if (operation === 'configure') { stopping = false; enabled = args.enabled === true; chain = args.chain || []; result = await configure() }
      else if (operation === 'scan') result = await scan(args.path)
      else if (operation === 'cancelScan') { cancelScanner?.(); result = true }
      else if (operation === 'tempo') {
        if (typeof args.trackId === 'string' && args.trackId !== trackId) result = false
        else {
          tempo = Number.isFinite(args.bpm) && args.bpm >= 20 && args.bpm <= 400 ? args.bpm : 120
          port?.postMessage({ type: 'tempo', bpm: tempo, trackId: args.trackId })
          result = true
        }
      } else if (operation === 'native') { if (!host) throw new Error('请先启用音频效果'); result = await request(args.command, args.payload || {}) }
      else if (operation === 'stop' || operation === 'disconnect') { await stop(); result = true }
      else throw new Error('未知的音效操作')
      if (id) send({ id, ok: true, result })
    } catch (error) { if (id) send({ id, ok: false, error: errorText(error) }) }
  }
  return { handle, stop }
}

if (process.parentPort) {
  const worker = createAudioEffectsWorker({ send: message => process.parentPort.postMessage(message) })
  process.parentPort.on('message', event => { void worker.handle(event.data, event.ports) })
  process.parentPort.on('close', () => { void worker.stop().finally(() => process.exit(0)) })
}
module.exports = { createAudioEffectsWorker }
