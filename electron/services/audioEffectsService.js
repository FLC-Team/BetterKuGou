const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { normalizeAudioEffects, AUDIO_EFFECTS_BUFFER_MS_OPTIONS } = require('../audioEffectsConfig.cjs')

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const cleanText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) : ''

function defaultPluginDirectories(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Common', 'VST3'),
    env.CommonProgramFiles && path.join(env.CommonProgramFiles, 'VST3'),
    env['CommonProgramFiles(x86)'] && path.join(env['CommonProgramFiles(x86)'], 'VST3')].filter(Boolean)
  if (platform === 'darwin') return [path.join(home, 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/VST3', '/Network/Library/Audio/Plug-Ins/VST3']
  return [path.join(home, '.vst3'), '/usr/lib64/vst3', '/usr/lib/vst3', '/usr/local/lib64/vst3', '/usr/local/lib/vst3']
}

/** Enumerate bundles without descending into them; real paths prevent symlink cycles. */
async function discoverPlugins(directories, cancelled = () => false) {
  const visited = new Set(), modules = [], queue = directories.map(directory => ({ directory, depth: 0 }))
  while (queue.length && modules.length < 4096 && visited.size < 20000 && !cancelled()) {
    const { directory, depth } = queue.shift()
    let real, entries
    try { real = await fsp.realpath(directory); if (visited.has(real)) continue; visited.add(real); entries = await fsp.readdir(real, { withFileTypes: true }) }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error }
    for (const entry of entries) {
      if (cancelled()) break
      const target = path.join(real, entry.name)
      if (/\.vst3$/i.test(entry.name)) modules.push(await fsp.realpath(target).catch(() => target))
      else if (depth < 16 && (entry.isDirectory() || entry.isSymbolicLink())) queue.push({ directory: target, depth: depth + 1 })
    }
  }
  return [...new Set(modules)]
}

/** Private atomic snapshots never contain audio URLs, credentials or the audio samples themselves. */
async function writeJson(file, value) {
  const content = JSON.stringify(value)
  if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('插件参数超过 32 MB，当前效果保留但尚未保存')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await fsp.writeFile(temporary, content, { flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try { await fsp.rename(temporary, file); break }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)))
      }
    }
  } finally { await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

async function readJson(file, fallback) {
  try {
    if ((await fsp.stat(file)).size > 32 * 1024 * 1024) throw new Error('音效保存文件过大')
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

/** Own configuration and native lifetimes, while the utility process owns all high-frequency PCM. */
function createAudioEffectsService({ root, nativePath, workerPath, utilityProcess, persistConfig,
  onStatus = () => {}, logger = console, platform = process.platform, scanDirectories = defaultPluginDirectories(platform) }) {
  let config = normalizeAudioEffects(), revision = 0, worker = null, workerReady = null, requestId = 0
  let appliedConfig = normalizeAudioEffects(), configPending = false
  let canonicalConfig = normalizeAudioEffects()
  let stopped = false, faulted = false, running = false, latencySamples = 0, tailSamples = 0, sampleRate = 48000
  let error = '', saveError = '', scanning = false, scanEpoch = 0, scanProgress = null, scanErrors = []
  let registry = new Map(), states = new Map(), editors = new Map(), tempoCache = new Map()
  let loadedInstances = new Set()
  let tempo = { trackId: '', bpm: 120, automaticBpm: null, manualBpm: null, status: 'waiting' }
  let mutations = Promise.resolve(), saveTask = Promise.resolve(), configureTask = Promise.resolve(), saveTimer = null, stoppingTask = null
  let connectionTask = Promise.resolve()
  let audioConnectionGeneration = 0, audioConnected = false, reconnectRequired = false
  const pending = new Map()
  const supported = ['win32', 'darwin', 'linux'].includes(platform) && fs.existsSync(nativePath)
  const message = value => cleanText(value?.message || String(value || '音效操作失败'))
  const stateFile = id => path.join(root, 'states', `${digest(id)}.json`)
  const runtimeSignature = value => JSON.stringify({ enabled: value.enabled, chain: value.chain })
  const describeChain = value => value.chain.map(item => ({ ...item, name: registry.get(item.pluginId)?.name || '未找到的插件',
    missing: !registry.has(item.pluginId), ...editors.get(item.instanceId) }))
  const getStatus = () => ({ revision, supported, enabled: config.enabled, appliedEnabled: appliedConfig.enabled,
    bufferMs: config.bufferMs, appliedBufferMs: canonicalConfig.bufferMs,
    appliedChain: describeChain(appliedConfig), pendingChanges: configPending || runtimeSignature(config) !== runtimeSignature(appliedConfig),
    audioConnectionGeneration, reconnectRequired,
    running, scanning, scanProgress,
    scanErrors: scanErrors.slice(-30), searchPaths: [...config.searchPaths],
    plugins: [...registry.values()].map(({ path: _path, ...plugin }) => plugin),
    chain: describeChain(config), latencySamples, tailSamples, sampleRate,
    latencyMs: latencySamples / sampleRate * 1000, error, saveError, tempo: { ...tempo } })
  const publish = () => { revision++; const snapshot = getStatus(); onStatus(snapshot); return snapshot }
  const mutate = action => {
    const result = mutations.catch(() => {}).then(() => { if (stopped) throw new Error('应用正在退出'); return action() })
    mutations = result
    return result
  }
  const connection = action => {
    const result = connectionTask.catch(() => {}).then(action)
    connectionTask = result
    return result
  }

  function workerFailed(reason, child) {
    if (child !== worker) return
    worker = null; workerReady = null; running = false; faulted = true
    reconnectRequired = reconnectRequired || audioConnected
    audioConnected = false
    error = message(reason)
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(error)) }
    pending.clear()
    editors.clear()
    loadedInstances.clear()
    try { child.kill?.() } catch (failure) { logger.warn('audio-effects', '结束失效音效进程失败', failure) }
    publish()
  }

  async function rpc(operation, args = {}, ports = [], timeout = 15000) {
    if (!worker) await ensureWorker()
    return new Promise((resolve, reject) => {
      const id = ++requestId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('音效操作没有及时完成')) }, timeout)
      pending.set(id, { resolve, reject, timer })
      try { worker.postMessage({ id, operation, args }, ports) }
      catch (failure) { clearTimeout(timer); pending.delete(id); reject(failure) }
    })
  }

  async function ensureWorker() {
    if (workerReady) return workerReady
    if (!supported) throw new Error('此安装包缺少当前平台的音效宿主，请先构建原生音效组件')
    if (stopped) throw new Error('应用正在退出')
    const child = utilityProcess.fork(workerPath, [], { serviceName: 'BetterKuGou Audio Effects', stdio: 'pipe' })
    audioConnectionGeneration++
    worker = child
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    child.on('message', data => {
      if (worker !== child) return
      if (data.id && pending.has(data.id)) {
        const task = pending.get(data.id); pending.delete(data.id); clearTimeout(task.timer)
        if (data.ok) task.resolve(data.result); else task.reject(new Error(message(data.error)))
      } else if (data.type === 'status') {
        if (typeof data.running === 'boolean') running = data.running
        if (Number.isFinite(data.sampleRate)) sampleRate = data.sampleRate
        if (Number.isFinite(data.latencySamples)) latencySamples = data.latencySamples
        if (Number.isSafeInteger(data.tailSamples) && data.tailSamples >= -1) tailSamples = data.tailSamples
        if (typeof data.error === 'string') { error = cleanText(data.error); if (error) faulted = true }
        if (!running && !data.reconfiguring) { editors.clear(); loadedInstances.clear() }
        if (data.dirty === true) scheduleSave()
        publish()
      } else if (data.type === 'editor') {
        if (identifier(data.instanceId)) { editors.set(data.instanceId, { editorOpen: data.open === true }); publish() }
      } else if (data.type === 'track') {
        if (typeof data.trackId !== 'string' || data.trackId.length > 1024 || !Number.isSafeInteger(data.generation)) return
        const cached = tempoCache.get(data.trackId) || {}
        tempo = { trackId: data.trackId, automaticBpm: cached.automaticBpm || null, manualBpm: cached.manualBpm || null,
          bpm: cached.manualBpm || cached.automaticBpm || 120, status: !data.trackId ? 'waiting' : cached.manualBpm ? 'manual' : cached.automaticBpm ? 'detected' : 'analyzing', generation: data.generation }
        void rpc('tempo', { trackId: tempo.trackId, bpm: tempo.bpm }).catch(failure => logger.warn('audio-effects', '同步歌曲速度失败', failure))
        publish()
      } else if (data.type === 'tempo' && data.trackId === tempo.trackId && data.generation === tempo.generation) {
        if (Number.isFinite(data.bpm) && data.bpm >= 40 && data.bpm <= 240 && !tempo.automaticBpm && ['detected', 'confirmed'].includes(data.status)) {
          tempo.automaticBpm = data.bpm
          if (!tempo.manualBpm) { tempo.bpm = data.bpm; tempo.status = 'detected' }
          tempoCache.set(tempo.trackId, { automaticBpm: data.bpm, manualBpm: tempo.manualBpm, confidence: data.confidence, algorithm: 1 })
          while (tempoCache.size > 10000) tempoCache.delete(tempoCache.keys().next().value)
          void rpc('tempo', { trackId: tempo.trackId, bpm: tempo.bpm }).catch(failure => logger.warn('audio-effects', '应用识别速度失败', failure))
          void saveTempo()
        } else if (!tempo.manualBpm && !tempo.automaticBpm && ['uncertain', 'analyzing'].includes(data.status)) tempo.status = data.status
        publish()
      } else if (data.type === 'dirty' || (data.type === 'parameters' && data.invalidated === true)) scheduleSave()
    })
    child.on('exit', () => workerFailed(new Error('音效桥接进程已退出，当前使用原始声音'), child))
    child.on('error', failure => workerFailed(failure, child))
    workerReady = rpc('initialize', { nativePath }).catch(failure => { workerFailed(failure, child); throw failure })
    return workerReady
  }

  async function nativeChain(desired = config, loadInstanceId = null) {
    const result = []
    for (const item of desired.chain) {
      const plugin = registry.get(item.pluginId)
      if (!plugin) continue
      const existing = running && loadedInstances.has(item.instanceId) &&
        appliedConfig.chain.some(active => active.instanceId === item.instanceId && active.pluginId === item.pluginId)
      // A failed module must not be loaded again just to bypass it. Keep already
      // loaded bypassed instances so their editor and state remain available.
      if (item.bypassed && !existing && item.instanceId !== loadInstanceId) continue
      if (!states.has(item.instanceId)) states.set(item.instanceId, await readJson(stateFile(item.instanceId), null))
      result.push({ ...item, path: plugin.path, classId: plugin.classId, state: existing ? undefined : states.get(item.instanceId) || undefined })
    }
    return result
  }

  function applyRuntime({ recover = false, loadInstanceId = null } = {}) {
    configureTask = configureTask.catch(() => {}).then(async () => {
      if (stopped || configPending || (faulted && !recover)) return
      if (recover) { faulted = false; error = '' }
      const desired = normalizeAudioEffects(config)
      if (!desired.enabled && !worker) { appliedConfig = desired; publish(); return }
      await ensureWorker()
      if (stopped) return
      const native = await nativeChain(desired, loadInstanceId)
      await rpc('configure', { enabled: desired.enabled, chain: native })
      loadedInstances = new Set(running ? native.map(item => item.instanceId) : [])
      appliedConfig = desired
      publish()
      if (desired.enabled) scheduleSave()
    }).catch(failure => { error = message(failure); faulted = true; running = false; loadedInstances.clear(); publish(); throw failure })
    return configureTask
  }

  function saveTempo() {
    saveTask = saveTask.catch(() => {}).then(async () => {
      try { await writeJson(path.join(root, 'tempo.json'), [...tempoCache]) }
      catch (failure) { saveError = message(failure); publish() }
    })
    return saveTask
  }

  function saveStates({ allowUnavailable = false } = {}) {
    saveTask = saveTask.catch(() => {}).then(async () => {
      try {
        if (running && worker && !faulted) {
          for (const item of appliedConfig.chain) {
            if (!registry.has(item.pluginId) || !loadedInstances.has(item.instanceId)) continue
            const owner = worker
            let state
            try { state = await rpc('native', { command: 'getState', payload: { instanceId: item.instanceId } }) }
            catch (failure) {
              if (!allowUnavailable || (running && !faulted && worker === owner)) throw failure
              logger.warn('audio-effects', '音效进程已失效，保留上次参数快照并继续修改效果链', failure)
              break
            }
            if (!state || typeof state.component !== 'string') throw new Error('插件未返回可恢复的参数')
            states.set(item.instanceId, state)
            await writeJson(stateFile(item.instanceId), state)
          }
        }
        await writeJson(path.join(root, 'tempo.json'), [...tempoCache])
        if (saveError && !configPending) { saveError = ''; publish() }
      } catch (failure) { saveError = message(failure); publish(); throw failure }
    })
    return saveTask
  }

  function scheduleSave() {
    if (saveTimer || stopped || !worker || !running) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveStates().catch(failure => logger.warn('audio-effects', '保存插件参数失败', failure))
    }, 5000)
  }

  async function commit(next) {
    config = normalizeAudioEffects(next)
    configPending = true
    publish()
    try { await persistConfig(config); canonicalConfig = normalizeAudioEffects(config); configPending = false; saveError = '' }
    catch (failure) { saveError = message(failure); publish(); throw failure }
  }

  async function initialize(initialConfig) {
    config = normalizeAudioEffects(initialConfig)
    canonicalConfig = normalizeAudioEffects(config)
    if (!config.enabled) appliedConfig = normalizeAudioEffects(config)
    try {
      const entries = await readJson(path.join(root, 'plugins.json'), [])
      for (const plugin of Array.isArray(entries) ? entries.slice(0, 8192) : []) {
        if (!identifier(plugin.id) || typeof plugin.path !== 'string' || !path.isAbsolute(plugin.path) ||
          typeof plugin.classId !== 'string' || !/^[a-f\d]{32}$/i.test(plugin.classId) || !fs.existsSync(plugin.path)) continue
        registry.set(plugin.id, { ...plugin, name: cleanText(plugin.name), vendor: cleanText(plugin.vendor) })
      }
      const cached = await readJson(path.join(root, 'tempo.json'), [])
      for (const entry of Array.isArray(cached) ? cached.slice(-10000) : []) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || entry[0].length > 1024 || !entry[1]) continue
        const value = entry[1]
        tempoCache.set(entry[0], { automaticBpm: value.algorithm === 1 && Number.isFinite(value.automaticBpm) && value.automaticBpm >= 40 && value.automaticBpm <= 240 ? value.automaticBpm : null,
          manualBpm: Number.isFinite(value.manualBpm) && value.manualBpm >= 20 && value.manualBpm <= 400 ? value.manualBpm : null, algorithm: 1 })
      }
    } catch (failure) { saveError = message(failure) }
    publish()
    if (config.enabled) await applyRuntime().catch(() => {})
    return getStatus()
  }

  function configure(next) {
    const normalized = normalizeAudioEffects(next)
    const serialized = JSON.stringify(normalized)
    // Session checkpoints and unrelated settings broadcasts carry the last durable
    // audio settings; they must not replace an unsaved audio-effects draft.
    if (JSON.stringify(canonicalConfig) === serialized) return Promise.resolve(getStatus())
    return mutate(async () => {
      // A commit can synchronously broadcast its settings before persistConfig
      // resolves. By the time this queued callback runs, that commit is canonical.
      if (JSON.stringify(canonicalConfig) === serialized) return getStatus()
      if (configPending) saveError = ''
      config = normalized; canonicalConfig = normalizeAudioEffects(normalized); configPending = false
      publish()
      if (runtimeSignature(config) !== runtimeSignature(appliedConfig)) await applyRuntime({ recover: true })
      return getStatus()
    })
  }

  async function scan() {
    if (scanning) return getStatus()
    await ensureWorker()
    scanning = true; scanErrors = []; scanProgress = { completed: 0, total: 0, name: '' }
    const epoch = ++scanEpoch
    publish()
    void (async () => {
      try {
        const modules = await discoverPlugins([...config.searchPaths, ...scanDirectories], () => epoch !== scanEpoch || stopped)
        const available = new Set(modules)
        const found = new Map([...registry].filter(([, plugin]) => available.has(plugin.path)))
        for (let index = 0; index < modules.length && epoch === scanEpoch && !stopped; index++) {
          const file = modules[index]
          scanProgress = { completed: index, total: modules.length, name: path.basename(file) }; publish()
          try {
            const plugins = await rpc('scan', { path: file }, [], 35000)
            if (epoch !== scanEpoch || stopped) break
            for (const plugin of plugins) {
              const classId = String(plugin.classId || '').replace(/[^a-f\d]/gi, '').toUpperCase()
              if (!/^[a-f\d]{32}$/i.test(classId) || plugin.isEffect === false) continue
              const id = digest(`${file}\0${classId}`)
              found.set(id, { id, path: file, classId, name: cleanText(plugin.name), vendor: cleanText(plugin.vendor),
                category: cleanText(plugin.category), version: cleanText(plugin.version), hasEditor: plugin.hasEditor !== false })
            }
          } catch (failure) { if (epoch === scanEpoch) scanErrors.push({ name: path.basename(file), error: message(failure) }) }
        }
        if (epoch === scanEpoch && !stopped) {
          registry = found
          await writeJson(path.join(root, 'plugins.json'), [...registry.values()])
          scanProgress = { completed: modules.length, total: modules.length, name: '' }
          if (config.enabled && !faulted) await applyRuntime()
        }
      } catch (failure) { if (epoch === scanEpoch) error = message(failure) }
      finally { if (epoch === scanEpoch) { scanning = false; publish() } }
    })()
    return getStatus()
  }

  const api = {
    initialize, configure, getStatus, listPlugins: () => getStatus(), scan,
    async cancelScan() { ++scanEpoch; scanning = false; if (worker) await rpc('cancelScan'); return publish() },
    addDirectory: directory => mutate(async () => {
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await fsp.stat(directory)).isDirectory()) throw new Error('请选择有效插件目录')
      await commit({ ...config, searchPaths: [...new Set([...config.searchPaths, await fsp.realpath(directory)])] }); return getStatus()
    }),
    addPlugin: pluginId => mutate(async () => {
      if (!registry.has(pluginId)) throw new Error('插件尚未扫描或已被移除')
      if (config.chain.length >= 64) throw new Error('效果链最多支持 64 个插件实例')
      await saveStates()
      await commit({ ...config, chain: [...config.chain, { instanceId: crypto.randomUUID(), pluginId, bypassed: false, alwaysOnTop: false }] })
      await applyRuntime(); return getStatus()
    }),
    removePlugin: instanceId => mutate(async () => {
      if (!config.chain.some(item => item.instanceId === instanceId)) throw new Error('插件实例不存在')
      await saveStates({ allowUnavailable: true })
      await commit({ ...config, chain: config.chain.filter(item => item.instanceId !== instanceId) })
      editors.delete(instanceId)
      await applyRuntime({ recover: true }); return getStatus()
    }),
    movePlugin: ({ instanceId, index } = {}) => mutate(async () => {
      if (!Number.isInteger(index) || index < 0 || index >= config.chain.length) throw new Error('插件位置无效')
      const next = [...config.chain], from = next.findIndex(item => item.instanceId === instanceId)
      if (from < 0) throw new Error('插件实例不存在')
      next.splice(index, 0, next.splice(from, 1)[0])
      await saveStates(); await commit({ ...config, chain: next }); await applyRuntime(); return getStatus()
    }),
    setBypass: ({ instanceId, bypassed } = {}) => mutate(async () => {
      if (typeof bypassed !== 'boolean' || !config.chain.some(item => item.instanceId === instanceId)) throw new Error('插件旁路状态无效')
      await commit({ ...config, chain: config.chain.map(item => item.instanceId === instanceId ? { ...item, bypassed } : item) })
      if (running && !faulted && loadedInstances.has(instanceId)) {
        try {
          await rpc('native', { command: 'setBypass', payload: { instanceId, bypassed } })
          appliedConfig = normalizeAudioEffects({ ...appliedConfig, chain: appliedConfig.chain.map(item => item.instanceId === instanceId ? { ...item, bypassed } : item) })
        } catch (failure) {
          if (!faulted && running) throw failure
          await applyRuntime({ recover: true })
        }
      } else await applyRuntime({ recover: true })
      return publish()
    }),
    setEnabled: enabled => mutate(async () => {
      if (typeof enabled !== 'boolean') throw new Error('音效开关无效')
      if (!enabled) await saveStates({ allowUnavailable: true })
      await commit({ ...config, enabled }); await applyRuntime({ recover: true }); return getStatus()
    }),
    setBufferMs: bufferMs => mutate(async () => {
      if (!AUDIO_EFFECTS_BUFFER_MS_OPTIONS.includes(bufferMs)) throw new Error('音频缓冲必须为 64、128、256 或 512 毫秒')
      await commit({ ...config, bufferMs })
      if (runtimeSignature(config) !== runtimeSignature(appliedConfig)) await applyRuntime({ recover: true })
      return publish()
    }),
    openEditor: ({ instanceId, alwaysOnTop = false } = {}) => mutate(async () => {
      if (!config.chain.some(item => item.instanceId === instanceId) || typeof alwaysOnTop !== 'boolean') throw new Error('插件窗口请求无效')
      if (!loadedInstances.has(instanceId)) await applyRuntime({ recover: true, loadInstanceId: instanceId })
      await rpc('native', { command: 'openEditor', payload: { instanceId, alwaysOnTop } })
      editors.set(instanceId, { editorOpen: true })
      appliedConfig = normalizeAudioEffects({ ...appliedConfig, chain: appliedConfig.chain.map(item => item.instanceId === instanceId ? { ...item, alwaysOnTop } : item) })
      await commit({ ...config, chain: config.chain.map(item => item.instanceId === instanceId ? { ...item, alwaysOnTop } : item) }); return publish()
    }),
    closeEditor: instanceId => mutate(async () => {
      if (!config.chain.some(item => item.instanceId === instanceId)) throw new Error('插件实例不存在')
      await rpc('native', { command: 'closeEditor', payload: { instanceId } })
      editors.set(instanceId, { editorOpen: false }); await saveStates(); return publish()
    }),
    setTempoOverride: ({ trackId, bpm } = {}) => mutate(async () => {
      if (trackId !== tempo.trackId || !trackId || (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 400))) throw new Error('歌曲或 BPM 无效，请输入 20–400')
      tempo.manualBpm = bpm
      tempo.bpm = bpm || tempo.automaticBpm || 120
      tempo.status = bpm ? 'manual' : tempo.automaticBpm ? 'detected' : 'analyzing'
      tempoCache.set(trackId, { ...tempoCache.get(trackId), manualBpm: bpm, automaticBpm: tempo.automaticBpm, algorithm: 1 })
      await rpc('tempo', { trackId, bpm: tempo.bpm }); await saveTempo(); return publish()
    }),
    retry: () => mutate(async () => { await applyRuntime({ recover: true }); return publish() }),
    retrySave: () => mutate(async () => {
      try { await persistConfig(config); canonicalConfig = normalizeAudioEffects(config); configPending = false }
      catch (failure) { configPending = true; saveError = message(failure); publish(); throw failure }
      if (runtimeSignature(config) !== runtimeSignature(appliedConfig)) await applyRuntime({ recover: true })
      await saveStates()
      return publish()
    }),
    connectAudio: port => connection(async () => {
      if (stopped) { port?.close?.(); throw new Error('应用正在退出') }
      try {
        await ensureWorker(); await rpc('connect', {}, [port]); if (!faulted) await applyRuntime()
        audioConnected = true; reconnectRequired = false; publish()
        return true
      }
      catch (failure) { port?.close?.(); throw failure }
    }),
    releaseAudio: () => connection(async () => {
      audioConnected = false; reconnectRequired = false
      if (!worker) { publish(); return }
      await saveStates().catch(failure => logger.warn('audio-effects', '释放播放通道前保存参数失败', failure))
      try { await rpc('disconnect', {}, [], 3000) }
      finally {
        clearTimeout(saveTimer); saveTimer = null
        running = false
        editors.clear()
        loadedInstances.clear()
        appliedConfig = normalizeAudioEffects()
        tempo = { trackId: '', bpm: 120, automaticBpm: null, manualBpm: null, status: 'waiting' }
        publish()
      }
    }),
    stop() {
      if (stoppingTask) return stoppingTask
      stopped = true; ++scanEpoch; clearTimeout(saveTimer)
      stoppingTask = (async () => {
        await connectionTask.catch(() => {})
        await mutations.catch(() => {})
        await saveStates().catch(failure => logger.warn('audio-effects', '退出时保存音效参数失败', failure))
        if (worker) { const child = worker; try { await rpc('stop', {}, [], 3000) } catch (failure) { logger.warn('audio-effects', '音效退出超时', failure) } finally { worker = null; child.kill() } }
        for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('应用已退出')) }
        pending.clear()
      })()
      return stoppingTask
    }
  }
  return api
}

module.exports = { createAudioEffectsService, defaultPluginDirectories, discoverPlugins, writeJson }
