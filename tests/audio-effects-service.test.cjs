const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { createAudioEffectsService } = require('../electron/services/audioEffectsService')

const temporaryRoot = path.resolve(__dirname, '../.agent/tools')
const tick = () => new Promise(resolve => setImmediate(resolve))
const clone = value => structuredClone(value)
async function waitFor(predicate) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error('Timed out waiting for asynchronous file work')
    await tick()
  }
}

async function fixture(t, { enabled = false, chain = [], persist, beforeRequest } = {}) {
  await fs.mkdir(temporaryRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'audio-effects-service-'))
  const nativePath = path.join(root, 'host')
  const pluginPath = path.join(root, 'example.vst3')
  await fs.writeFile(nativePath, '')
  await fs.writeFile(pluginPath, '')
  const plugin = { id: 'plugin', path: pluginPath, classId: 'A'.repeat(32), name: '示例效果', vendor: 'Test' }
  await fs.writeFile(path.join(root, 'plugins.json'), JSON.stringify([plugin]))
  const messages = [], children = [], snapshots = [], persisted = []
  let disconnectGate = null
  class Worker extends EventEmitter {
    constructor() { super(); this.loaded = new Set(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter() }
    postMessage(request, ports = []) {
      messages.push({ ...clone(request), ports })
      void (async () => {
        let result = true
        try {
          await beforeRequest?.(request, this)
          if (request.operation === 'configure') {
            this.loaded = new Set(request.args.chain.map(item => item.instanceId))
            this.emit('message', { type: 'status', running: true, latencySamples: 96, sampleRate: 48000, error: '' })
          } else if (request.operation === 'native') {
            const { command, payload } = request.args
            if (payload?.instanceId && !this.loaded.has(payload.instanceId)) throw new Error('实例尚未加载')
            if (command === 'getState') result = { component: Buffer.from('current:' + payload.instanceId).toString('base64'), controller: '' }
          } else if (request.operation === 'disconnect') {
            if (disconnectGate) await disconnectGate
            this.loaded.clear()
            this.emit('message', { type: 'status', running: false, error: '' })
          } else if (request.operation === 'scan') result = [{ classId: plugin.classId, name: plugin.name, isEffect: true }]
          queueMicrotask(() => this.emit('message', { id: request.id, ok: true, result }))
        } catch (error) { queueMicrotask(() => this.emit('message', { id: request.id, ok: false, error: error.message })) }
      })()
    }
    kill() { this.killed = true }
  }
  const service = createAudioEffectsService({ root, nativePath, workerPath: path.join(root, 'worker.cjs'),
    utilityProcess: { fork() { const child = new Worker(); children.push(child); return child } },
    persistConfig: async value => { persisted.push(clone(value)); await persist?.(value, persisted.length) },
    onStatus: snapshot => snapshots.push(snapshot), logger: { warn() {} }, platform: 'win32', scanDirectories: [] })
  t.after(async () => {
    await service.stop()
    assert.ok(root.startsWith(temporaryRoot + path.sep))
    await fs.rm(root, { recursive: true, force: true })
  })
  await service.initialize({ enabled, chain, searchPaths: [] })
  return { service, root, messages, children, snapshots, persisted, gateDisconnect(promise) { disconnectGate = promise } }
}

test('failed preference persistence retains desired changes without changing audible configuration, then retry applies', async t => {
  const setup = await fixture(t, { persist: (value, attempt) => { if (attempt === 1) throw new Error('disk busy') } })
  await assert.rejects(setup.service.setEnabled(true), /disk busy/)
  let state = setup.service.getStatus()
  assert.equal(state.enabled, true)
  assert.equal(state.appliedEnabled, false)
  assert.equal(state.pendingChanges, true)
  assert.match(state.saveError, /disk busy/)
  assert.equal(setup.messages.filter(message => message.operation === 'configure').length, 0)
  await setup.service.configure({ enabled: false, searchPaths: [], chain: [] })
  assert.equal(setup.service.getStatus().enabled, true)
  assert.equal(setup.service.getStatus().pendingChanges, true)
  assert.match(setup.service.getStatus().saveError, /disk busy/)
  state = await setup.service.retrySave()
  assert.equal(state.appliedEnabled, true)
  assert.equal(state.pendingChanges, false)
  assert.equal(state.running, true)
  assert.equal(state.saveError, '')
  assert.equal(setup.messages.filter(message => message.operation === 'configure').length, 1)
})

test('a durable external import matching an unsaved draft clears pending state and applies the effects', async t => {
  const setup = await fixture(t, { persist: () => { throw new Error('disk busy') } })
  await assert.rejects(setup.service.setEnabled(true), /disk busy/)
  assert.equal(setup.service.getStatus().pendingChanges, true)
  assert.equal(setup.service.getStatus().appliedEnabled, false)
  const state = await setup.service.configure({ enabled: true, chain: [], searchPaths: [] })
  assert.equal(state.pendingChanges, false)
  assert.equal(state.appliedEnabled, true)
  assert.equal(state.running, true)
  assert.equal(state.saveError, '')
  assert.equal(setup.messages.filter(message => message.operation === 'configure').length, 1)
  assert.equal(setup.persisted.length, 1)
})

test('a synchronous settings broadcast from the current commit does not configure the native chain twice', async t => {
  let broadcast
  const setup = await fixture(t, { persist: value => { broadcast = setup.service.configure(value) } })
  await setup.service.setEnabled(true)
  await broadcast
  assert.equal(setup.service.getStatus().pendingChanges, false)
  assert.equal(setup.service.getStatus().appliedEnabled, true)
  assert.equal(setup.messages.filter(message => message.operation === 'configure').length, 1)
  assert.equal(setup.persisted.length, 1)
})

test('retrying a failed plugin addition loads the new instance before attempting to save its state', async t => {
  const setup = await fixture(t, { enabled: true,
    chain: [{ instanceId: 'existing', pluginId: 'plugin', bypassed: false }],
    persist: (value, attempt) => { if (attempt === 1) throw new Error('disk busy') } })
  await assert.rejects(setup.service.addPlugin('plugin'), /disk busy/)
  const pending = setup.service.getStatus()
  assert.equal(pending.chain.length, 2)
  assert.equal(pending.appliedChain.length, 1)
  const state = await setup.service.retrySave()
  assert.equal(state.appliedChain.length, 2)
  assert.equal(state.saveError, '')
  assert.equal(state.pendingChanges, false)
  const configurations = setup.messages.filter(message => message.operation === 'configure')
  assert.equal(configurations.at(-1).args.chain[0].state, undefined)
  const lastConfigure = setup.messages.findLastIndex(message => message.operation === 'configure')
  const newInstance = state.chain[1].instanceId
  assert.ok(setup.messages.findIndex(message => message.operation === 'native' && message.args.command === 'getState' && message.args.payload.instanceId === newInstance) > lastConfigure)
})

test('state restore is provided only for a fresh instance, and reordering preserves current native parameters', async t => {
  const setup = await fixture(t, { enabled: true, chain: [
    { instanceId: 'first', pluginId: 'plugin' }, { instanceId: 'second', pluginId: 'plugin' }
  ] })
  await setup.service.movePlugin({ instanceId: 'second', index: 0 })
  const configuration = setup.messages.filter(message => message.operation === 'configure').at(-1)
  assert.deepEqual(configuration.args.chain.map(item => item.instanceId), ['second', 'first'])
  assert.ok(configuration.args.chain.every(item => item.state === undefined))
  const saved = path.join(setup.root, 'states', crypto.createHash('sha256').update('first').digest('hex') + '.json')
  assert.equal(JSON.parse(await fs.readFile(saved, 'utf8')).component, Buffer.from('current:first').toString('base64'))
})

test('release saves state and serializes host teardown before a new renderer audio connection', async t => {
  const setup = await fixture(t, { enabled: true, chain: [{ instanceId: 'instance', pluginId: 'plugin' }] })
  const firstPort = { name: 'first', close() {} }, secondPort = { name: 'second', close() {} }
  await setup.service.connectAudio(firstPort)
  let allowDisconnect
  setup.gateDisconnect(new Promise(resolve => { allowDisconnect = resolve }))
  const release = setup.service.releaseAudio()
  const reconnect = setup.service.connectAudio(secondPort)
  for (let attempt = 0; attempt < 100 && !setup.messages.some(message => message.operation === 'disconnect'); attempt++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.ok(setup.messages.some(message => message.operation === 'disconnect'))
  assert.equal(setup.messages.filter(message => message.operation === 'connect').length, 1)
  allowDisconnect()
  await Promise.all([release, reconnect])
  assert.equal(setup.children.length, 1)
  assert.equal(setup.messages.filter(message => message.operation === 'connect').length, 2)
  assert.equal(setup.service.getStatus().appliedEnabled, true)
  assert.equal(setup.service.getStatus().running, true)
  assert.ok(setup.messages.findLastIndex(message => message.operation === 'connect') > setup.messages.findIndex(message => message.operation === 'disconnect'))
})

test('late events from a failed utility instance cannot overwrite its replacement or current tempo', async t => {
  const setup = await fixture(t, { enabled: true })
  await setup.service.connectAudio({ close() {} })
  const connectionGeneration = setup.service.getStatus().audioConnectionGeneration
  const previous = setup.children[0]
  previous.emit('exit', 1)
  assert.equal(setup.service.getStatus().reconnectRequired, true)
  await setup.service.retry()
  assert.equal(setup.service.getStatus().audioConnectionGeneration, connectionGeneration + 1)
  assert.equal(setup.service.getStatus().reconnectRequired, true)
  await setup.service.connectAudio({ close() {} })
  assert.equal(setup.service.getStatus().reconnectRequired, false)
  const current = setup.children[1]
  current.emit('message', { type: 'track', trackId: 'current', generation: 4 })
  previous.emit('message', { type: 'status', running: false, error: 'late failure' })
  previous.emit('message', { type: 'track', trackId: 'old', generation: 99 })
  await tick()
  assert.equal(setup.service.getStatus().running, true)
  assert.equal(setup.service.getStatus().tempo.trackId, 'current')
  current.emit('message', { type: 'track', trackId: '', generation: 5 })
  assert.equal(setup.service.getStatus().tempo.status, 'waiting')
})

test('rescan removes no-longer-discovered registrations while preserving missing chain placeholders', async t => {
  const setup = await fixture(t, { chain: [{ instanceId: 'instance', pluginId: 'plugin' }] })
  await setup.service.scan()
  for (let attempt = 0; attempt < 100 && setup.service.getStatus().scanning; attempt++) await new Promise(resolve => setTimeout(resolve, 2))
  const state = setup.service.getStatus()
  assert.equal(state.scanning, false)
  assert.equal(state.plugins.length, 0)
  assert.equal(state.chain[0].instanceId, 'instance')
  assert.equal(state.chain[0].missing, true)
})

test('state autosave is a one-shot dirty debounce; idle playback and meter updates do not poll getState', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const setup = await fixture(t, { enabled: true, chain: [{ instanceId: 'instance', pluginId: 'plugin' }] })
  const saves = () => setup.messages.filter(message => message.operation === 'native' && message.args.command === 'getState').length
  t.mock.timers.tick(5000)
  for (let i = 0; i < 40; i++) await tick()
  assert.equal(saves(), 1)
  t.mock.timers.tick(60000)
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(saves(), 1)
  const child = setup.children[0]
  child.emit('message', { type: 'parameters', changes: [{ paramId: 10, value: 0.7 }] })
  t.mock.timers.tick(6000)
  await tick()
  assert.equal(saves(), 1)
  child.emit('message', { type: 'status', dirty: true, instanceId: 'instance' })
  child.emit('message', { type: 'status', dirty: true, instanceId: 'instance' })
  child.emit('message', { type: 'parameters', invalidated: true, instanceId: 'instance' })
  t.mock.timers.tick(4999)
  await tick()
  assert.equal(saves(), 1)
  t.mock.timers.tick(1)
  await waitFor(() => saves() === 2)
  assert.equal(saves(), 2)
  t.mock.timers.tick(60000)
  await tick()
  assert.equal(saves(), 2)
  await setup.service.setEnabled(false)
  const disabledSaves = saves()
  child.emit('message', { type: 'status', dirty: true, instanceId: 'instance' })
  t.mock.timers.tick(5000)
  await waitFor(() => saves() === disabledSaves + 1)
  assert.equal(setup.service.getStatus().appliedEnabled, false)
  assert.equal(saves(), disabledSaves + 1, 'edits in an open plugin window must save even when the global effect is off')
})

test('a delayed automatic tempo save cannot overwrite a newer manual override, and shutdown waits for both', async t => {
  const setup = await fixture(t, { enabled: true })
  const originalRename = fs.rename
  let release, firstWriteBlocked = false, tempoWrites = 0
  const gate = new Promise(resolve => { release = resolve })
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === path.join(setup.root, 'tempo.json')) {
      tempoWrites++
      if (tempoWrites === 1) { firstWriteBlocked = true; await gate }
    }
    return originalRename(source, destination)
  })
  try {
    const child = setup.children[0]
    child.emit('message', { type: 'track', trackId: 'song', generation: 1 })
    child.emit('message', { type: 'tempo', trackId: 'song', generation: 1, status: 'detected', bpm: 120 })
    await waitFor(() => firstWriteBlocked)
    const manual = setup.service.setTempoOverride({ trackId: 'song', bpm: 140 })
    await waitFor(() => setup.service.getStatus().tempo.manualBpm === 140)
    let shutdownFinished = false
    const shutdown = setup.service.stop().then(() => { shutdownFinished = true })
    await tick()
    assert.equal(tempoWrites, 1)
    assert.equal(shutdownFinished, false)
    release()
    await Promise.all([manual, shutdown])
    const stored = new Map(JSON.parse(await fs.readFile(path.join(setup.root, 'tempo.json'), 'utf8')))
    assert.equal(stored.get('song').automaticBpm, 120)
    assert.equal(stored.get('song').manualBpm, 140)
    assert.equal(tempoWrites, 3)
  } finally { release() }
})

for (const operation of ['remove', 'bypass']) {
  test(`${operation} of an unsupported plugin rebuilds the remaining chain without reading the failed host`, async t => {
    const setup = await fixture(t, { enabled: true, chain: [
      { instanceId: 'healthy', pluginId: 'plugin' }, { instanceId: 'unsupported', pluginId: 'plugin' }
    ], beforeRequest(request, child) {
      if (request.operation === 'configure' && request.args.chain.some(item => item.instanceId === 'unsupported')) {
        child.emit('message', { type: 'status', running: false, error: 'Unsupported plugin class' })
        throw new Error('Unsupported plugin class')
      }
    } })
    assert.equal(setup.service.getStatus().running, false)
    const state = operation === 'remove' ? await setup.service.removePlugin('unsupported') :
      await setup.service.setBypass({ instanceId: 'unsupported', bypassed: true })
    assert.equal(state.running, true)
    assert.equal(state.error, '')
    assert.equal(state.pendingChanges, false)
    assert.deepEqual(setup.messages.filter(message => message.operation === 'configure').at(-1).args.chain.map(item => item.instanceId), ['healthy'])
    assert.equal(setup.messages.some(message => message.operation === 'native'), false)
    await setup.service.retrySave()
    assert.ok(setup.messages.filter(message => message.operation === 'native').every(message => message.args.payload.instanceId === 'healthy'))
    if (operation === 'bypass') assert.equal(state.chain.find(item => item.instanceId === 'unsupported').bypassed, true)
  })
}

test('a host pipe failing during removal state capture does not block persisting and applying the repaired chain', async t => {
  let failCapture = false
  const setup = await fixture(t, { enabled: true, chain: [{ instanceId: 'healthy', pluginId: 'plugin' }, { instanceId: 'removed', pluginId: 'plugin' }],
    beforeRequest(request, child) {
      if (failCapture && request.operation === 'native' && request.args.command === 'getState') {
        failCapture = false
        child.emit('message', { type: 'status', running: false, error: 'write EPIPE' })
        throw new Error('write EPIPE')
      }
    } })
  failCapture = true
  const state = await setup.service.removePlugin('removed')
  assert.equal(state.running, true)
  assert.equal(state.error, '')
  assert.equal(state.saveError, '')
  assert.deepEqual(state.appliedChain.map(item => item.instanceId), ['healthy'])
  assert.deepEqual(setup.persisted.at(-1).chain.map(item => item.instanceId), ['healthy'])
})

test('a genuine state-file write failure still protects the existing chain during removal', async t => {
  const setup = await fixture(t, { enabled: true, chain: [{ instanceId: 'instance', pluginId: 'plugin' }] })
  const originalRename = fs.rename
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination.startsWith(path.join(setup.root, 'states') + path.sep)) throw new Error('State disk unavailable')
    return originalRename(source, destination)
  })
  await assert.rejects(setup.service.removePlugin('instance'), /State disk unavailable/)
  assert.equal(setup.service.getStatus().chain.length, 1)
  assert.equal(setup.service.getStatus().appliedChain.length, 1)
  assert.equal(setup.persisted.length, 0)
})

test('buffer changes are validated and durable, retaining the applied value on failure without native reconfiguration', async t => {
  let fail = true
  const setup = await fixture(t, { enabled: true, persist: () => { if (fail) throw new Error('disk busy') } })
  const configurations = () => setup.messages.filter(message => message.operation === 'configure').length
  assert.equal(setup.service.getStatus().bufferMs, 128)
  for (const invalid of [0, 65, 1024, '256', NaN, null, {}]) await assert.rejects(setup.service.setBufferMs(invalid), /缓冲/)
  assert.equal(setup.persisted.length, 0)
  await assert.rejects(setup.service.setBufferMs(256), /disk busy/)
  assert.equal(setup.service.getStatus().bufferMs, 256)
  assert.equal(setup.service.getStatus().appliedBufferMs, 128)
  fail = false
  await setup.service.retrySave()
  assert.equal(setup.service.getStatus().appliedBufferMs, 256)
  for (const bufferMs of [64, 128, 256, 512]) {
    await setup.service.setBufferMs(bufferMs)
    assert.equal(setup.service.getStatus().appliedBufferMs, bufferMs)
    assert.equal(setup.persisted.at(-1).bufferMs, bufferMs)
  }
  await setup.service.configure({ enabled: true, bufferMs: 128, chain: [], searchPaths: [] })
  assert.equal(setup.service.getStatus().appliedBufferMs, 128)
  assert.equal(configurations(), 1)
})

test('saving the buffer also applies a previously unsaved chain change once it becomes durable', async t => {
  const setup = await fixture(t, { persist: (value, attempt) => { if (attempt === 1) throw new Error('disk busy') } })
  await assert.rejects(setup.service.setEnabled(true), /disk busy/)
  const state = await setup.service.setBufferMs(256)
  assert.equal(state.appliedEnabled, true)
  assert.equal(state.appliedBufferMs, 256)
  assert.equal(state.pendingChanges, false)
  assert.equal(setup.messages.filter(message => message.operation === 'configure').length, 1)
})

test('opening a bypassed plugin loads only that explicitly requested editor after restart', async t => {
  const setup = await fixture(t, { enabled: true, chain: [
    { instanceId: 'requested', pluginId: 'plugin', bypassed: true }, { instanceId: 'other', pluginId: 'plugin', bypassed: true }
  ] })
  assert.deepEqual(setup.messages.find(message => message.operation === 'configure').args.chain, [])
  const state = await setup.service.openEditor({ instanceId: 'requested', alwaysOnTop: true })
  assert.deepEqual(setup.messages.filter(message => message.operation === 'configure').at(-1).args.chain.map(item => item.instanceId), ['requested'])
  assert.ok(state.chain.every(item => item.bypassed))
  assert.equal(state.chain.find(item => item.instanceId === 'requested').editorOpen, true)
  assert.equal(state.error, '')
  await setup.service.retrySave()
  assert.ok(setup.messages.filter(message => message.operation === 'native').every(message => message.args.payload.instanceId === 'requested'))
})
