const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { test } = require('node:test')

const binary = process.env.BK_TEST_HOST_BINARY || path.resolve(__dirname, '..', 'bin', `${process.platform}-${process.arch}`, `bk-audio-host${process.platform === 'win32' ? '.exe' : ''}`)
const available = fs.existsSync(binary)

/** Use the production framed protocol, retaining unsolicited events for assertions. */
function host(mode = '--echo') {
  const child = spawn(binary, [mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const events = []
  const pending = new Map()
  let buffer = Buffer.alloc(0)
  let sequence = 0
  let stderr = ''
  child.stderr.on('data', data => { stderr += data.toString() })
  const closed = new Promise(resolve => child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Host exited ${code}/${signal}: ${stderr}`)) }
    pending.clear()
    resolve({ code, signal, stderr })
  }))
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 8) {
      const jsonBytes = buffer.readUInt32LE(0)
      const pcmBytes = buffer.readUInt32LE(4)
      assert.ok(jsonBytes > 0 && jsonBytes <= 32 * 1024 * 1024)
      assert.ok(pcmBytes <= 1024 * 1024)
      if (buffer.length < 8 + jsonBytes + pcmBytes) break
      const header = JSON.parse(buffer.toString('utf8', 8, 8 + jsonBytes))
      const pcm = Buffer.from(buffer.subarray(8 + jsonBytes, 8 + jsonBytes + pcmBytes))
      buffer = buffer.subarray(8 + jsonBytes + pcmBytes)
      const key = header.id ?? (header.type === 'audio' ? `audio:${header.sequence}` : null)
      const waiter = pending.get(key)
      if (waiter) { pending.delete(key); clearTimeout(waiter.timer); waiter.resolve({ header, pcm }) }
      else events.push(header)
    }
  })
  function send(header, pcm = Buffer.alloc(0)) {
    const json = Buffer.from(JSON.stringify(header))
    const prefix = Buffer.alloc(8)
    prefix.writeUInt32LE(json.length, 0)
    prefix.writeUInt32LE(pcm.length, 4)
    const key = header.id ?? `audio:${header.sequence}`
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Host timeout: ${JSON.stringify(header)} ${stderr}`)); child.kill() }, 15000)
      pending.set(key, { resolve, reject, timer })
    })
    child.stdin.write(Buffer.concat([prefix, json, pcm]))
    return result
  }
  return {
    child, events, closed,
    async command(command, fields = {}) {
      const { header } = await send({ id: ++sequence, command, ...fields })
      assert.equal(header.ok, true, JSON.stringify(header.error))
      return header.result
    },
    send,
    async audio(pcm, fields = {}) {
      const result = await send({ type: 'audio', sequence: ++sequence, generation: 1, frames: pcm.length / 8, channels: 2, sampleRate: 48000, position: 0, tempo: 120, playing: true, ...fields }, pcm)
      return result
    },
    async shutdown() {
      await this.command('shutdown')
      const result = await closed
      assert.equal(result.code, 0, result.stderr)
    }
  }
}

test('native BPM synthetic pulses across sample rates and silence', { skip: !available }, () => {
  const result = spawnSync(binary, ['--self-test'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /passed/)
})

test('native echo preserves framed stereo PCM and rejects unknown commands', { skip: !available, timeout: 10000 }, async t => {
  const client = host()
  t.after(() => client.child.kill())
  const pcm = Buffer.alloc(4096)
  for (let i = 0; i < 1024; i++) pcm.writeFloatLE(Math.sin(i / 31) * 0.25, i * 4)
  const response = await client.audio(pcm)
  assert.equal(response.header.frames, 512)
  assert.equal(response.header.latencySamples, 0)
  assert.deepEqual(response.pcm, pcm)
  const invalid = await client.send({ id: 'invalid', command: 'unknown' })
  assert.equal(invalid.header.ok, false)
  assert.equal(client.child.stdin.writableEnded, false, 'Shutdown must complete without the parent closing stdin')
  assert.equal(client.child.stdin.destroyed, false)
  await client.shutdown()
})

test('native parser rejects oversized frames before allocating payload', { skip: !available, timeout: 10000 }, async t => {
  const client = host()
  t.after(() => client.child.kill())
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(32 * 1024 * 1024 + 1)
  client.child.stdin.end(prefix)
  const result = await client.closed
  assert.equal(result.code, 0)
  assert.ok(client.events.some(event => event.error === 'Invalid protocol lengths'))
})

test('native stdin closure terminates even a stuck processing thread', { skip: !available, timeout: 7000 }, async t => {
  const client = host()
  t.after(() => client.child.kill())
  const pending = client.audio(Buffer.alloc(4096), { testHang: true }).catch(error => error)
  await new Promise(resolve => setTimeout(resolve, 100))
  client.child.stdin.end()
  const result = await client.closed
  assert.equal(result.code, 2)
  assert.ok(await pending instanceof Error)
})

test('native real effects: scan classes, audio, state, reuse, independent editors', {
  skip: !available || process.env.BK_AUDIO_TEST_PLUGINS !== '1', timeout: 120000 + Number(process.env.BK_TEST_EDITOR_HOLD_SECONDS || 0) * 1000
}, async t => {
  const paths = [process.env.BK_TEST_EQ_PLUGIN, process.env.BK_TEST_SERUM_PLUGIN].filter(Boolean)
  assert.equal(paths.length, 2, 'Set BK_TEST_EQ_PLUGIN and BK_TEST_SERUM_PLUGIN to installed VST3 modules')
  const effects = paths.map(pluginPath => {
    const scan = spawnSync(binary, ['--scan', pluginPath], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    assert.equal(scan.status, 0, scan.stderr)
    const classes = JSON.parse(scan.stdout)
    assert.ok(classes.every(item => /^[\dA-F]{32}$/i.test(item.classId)))
    const effect = classes.find(item => item.isEffect)
    assert.ok(effect)
    return effect
  })
  const client = host('--host')
  t.after(() => client.child.kill())
  const chain = effects.map((effect, index) => ({ instanceId: `test-${index}`, path: effect.path, classId: effect.classId, bypassed: false }))
  await client.command('configure', { sampleRate: 48000, maxBlockSize: 512, chain })
  for (const effect of (process.env.BK_TEST_EDITOR_ONLY_EQ ? chain.slice(0, 1) : chain)) await client.command('openEditor', { instanceId: effect.instanceId })
  if (process.env.BK_TEST_EDITOR_HOLD_SECONDS) { console.log(`Editor inspection host PID: ${client.child.pid}`); await new Promise(resolve => setTimeout(resolve, Number(process.env.BK_TEST_EDITOR_HOLD_SECONDS) * 1000)) }
  await new Promise(resolve => setTimeout(resolve, 1500))
  const parameters = await client.command('getParameters', { instanceId: 'test-0' })
  const gain = parameters.find(item => /output level|output gain/i.test(item.title))
  assert.ok(gain, 'EQ must expose an output level parameter')
  t.diagnostic(`EQ output control: ${JSON.stringify(gain)}`)
  await client.command('setBypass', { instanceId: 'test-1', bypassed: true })
  const before = await client.command('getState', { instanceId: 'test-0' })
  assert.ok(before.component.length > 0)
  await client.command('setParameter', { instanceId: 'test-0', paramId: gain.paramId, value: 0.5 })
  const pcm = Buffer.alloc(4096)
  for (let i = 0; i < 512; i++) { const value = Math.sin(2 * Math.PI * 1000 * i / 48000) * 0.2; pcm.writeFloatLE(value, i * 4); pcm.writeFloatLE(value, (i + 512) * 4) }
  async function energy() {
    let measured = 0
    let bypassed = 0
    for (let block = 0; block < 120; block++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      const response = await client.audio(pcm, { position: block * 512 / 48000 })
      if (response.header.bypassed) { bypassed++; continue }
      let rms = 0
      for (let i = 0; i < response.pcm.length; i += 4) { const value = response.pcm.readFloatLE(i); assert.ok(Number.isFinite(value)); rms += value * value }
      measured = rms / 1024
    }
    assert.ok(bypassed < 120, 'At least one block must process through the native chain')
    return measured
  }
  const normal = await energy()
  await client.command('setParameter', { instanceId: 'test-0', paramId: gain.paramId, value: 0.25 })
  const quiet = await energy()
  t.diagnostic(`EQ processed energy: ${normal} -> ${quiet}`)
  assert.ok(normal > 1e-6 && quiet < normal * 0.5, `Output control must affect processed PCM: ${normal} -> ${quiet}`)
  chain[0].state = before
  await client.command('configure', { sampleRate: 48000, maxBlockSize: 512, chain })
  const reused = await client.command('getParameters', { instanceId: 'test-0' })
  assert.ok(Math.abs(reused.find(item => item.paramId === gain.paramId).value - 0.25) < 0.001, 'Reconfigure must not restore stale saved state')
  const saved = await client.command('getState', { instanceId: 'test-0' })
  await client.command('setParameter', { instanceId: 'test-0', paramId: gain.paramId, value: 0.5 })
  await client.command('setState', { instanceId: 'test-0', state: saved })
  const restored = await client.command('getParameters', { instanceId: 'test-0' })
  assert.ok(Math.abs(restored.find(item => item.paramId === gain.paramId).value - 0.25) < 0.001)
  assert.ok(await energy() < normal * 0.5, 'An older queued edit must not overwrite restored DSP state on the next block')
  await client.command('setParameter', { instanceId: 'test-0', paramId: gain.paramId, value: 0.7 })
  const pausedState = await client.command('getState', { instanceId: 'test-0' })
  await client.command('configure', { sampleRate: 48000, maxBlockSize: 512, chain: [] })
  chain[0].state = pausedState
  await client.command('configure', { sampleRate: 48000, maxBlockSize: 512, chain })
  const pausedRestored = await client.command('getParameters', { instanceId: 'test-0' })
  assert.ok(Math.abs(pausedRestored.find(item => item.paramId === gain.paramId).value - 0.7) < 0.001, 'Saving without a new audio block must include the latest GUI/parameter change')
  assert.ok(await energy() > 1e-6, 'The complete EQ + Serum FX chain must produce audio')
  const mode = parameters.find(item => /processing mode/i.test(item.title))
  assert.ok(mode, 'EQ should expose a processing mode to test dynamic latency')
  const previousStatuses = client.events.length
  await client.command('setParameter', { instanceId: 'test-0', paramId: mode.paramId, value: 1 })
  for (let i = 0; i < 10; i++) { await client.audio(pcm); await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.ok(client.events.slice(previousStatuses).some(event => event.type === 'status' && event.latencySamples > 0), 'Linear phase processing must publish changed chain latency')
  await client.command('setParameter', { instanceId: 'test-0', paramId: mode.paramId, value: mode.value })
  for (const effect of chain) await client.command('openEditor', { instanceId: effect.instanceId })
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.ok(client.events.filter(event => event.type === 'editor' && event.open).length >= 2)
  for (const effect of chain) await client.command('closeEditor', { instanceId: effect.instanceId })
  await client.shutdown()
})
