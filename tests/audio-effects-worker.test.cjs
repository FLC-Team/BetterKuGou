const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createAudioEffectsWorker } = require('../electron/services/audioEffectsWorker.cjs')
const { encodeFrame, createFrameDecoder } = require('../electron/services/audioEffectsProtocol.cjs')

const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, { holdAudio = false } = {}) {
  const children = [], published = [], requests = [], audioReplies = [], controlReplies = [], heldCommands = new Set()
  let next = 0
  class Port extends EventEmitter {
    constructor() { super(); this.messages = [] }
    postMessage(message) { this.messages.push(structuredClone(message)) }
    start() {}
    close() { this.closed = true }
    send(data) { this.emit('message', { data }) }
  }
  const spawnChild = (file, args) => {
    const child = new EventEmitter()
    child.args = args
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter()
    child.stdin.writable = true; child.stdin.writableLength = 0
    const decode = createFrameDecoder((header, pcm) => {
      requests.push({ child, header, pcm })
      if (header.id) {
        const reply = () => child.stdout.emit('data', encodeFrame({ id: header.id, ok: true,
          result: header.command === 'configure' ? { latencySamples: 128, sampleRate: header.sampleRate } : true }))
        if (heldCommands.has(header.command)) controlReplies.push(reply); else queueMicrotask(reply)
      }
      else if (header.type === 'audio') {
        const reply = () => child.stdout.emit('data', encodeFrame({ ...header, latencySamples: 128 }, pcm))
        if (holdAudio) audioReplies.push(reply); else queueMicrotask(reply)
      }
    })
    child.writeCallbacks = []
    child.stdin.write = (buffer, callback) => { child.writeCallbacks.push(callback); decode(buffer); return true }
    child.kill = () => { child.killed = true; return true }
    children.push(child)
    return child
  }
  const worker = createAudioEffectsWorker({ send: message => published.push(message), spawnChild })
  const call = async (operation, args = {}, ports = []) => {
    const id = ++next
    await worker.handle({ id, operation, args }, ports)
    const response = published.find(message => message.id === id)
    if (!response?.ok) throw new Error(response?.error || 'no response')
    return response.result
  }
  t.after(() => worker.stop())
  return { worker, children, published, requests, Port, call, audioReplies, controlReplies, heldCommands,
    replyAudio(count = 1) { for (let i = 0; i < count; i++) { assert.ok(audioReplies.length); audioReplies.shift()() } } }
}

test('worker forwards actual planar PCM, acknowledges analysis, and stops native host on disconnect', async t => {
  const setup = fixture(t)
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  port.send({ type: 'configure', sampleRate: 96000 })
  await tick()
  const pcm = new Float32Array(1024); pcm.fill(0.2, 0, 512); pcm.fill(-0.3, 512)
  port.send({ type: 'audio', sequence: 0, generation: 1, position: 0, frames: 512, channels: 2, pcm })
  port.send({ type: 'analysis', sequence: 3, generation: 1, position: 0, frames: 512, trackId: 'track', pcm: pcm.subarray(0, 512) })
  await tick()
  const result = port.messages.find(message => message.type === 'audio')
  assert.deepEqual(result.pcm, pcm)
  assert.equal(setup.requests.find(request => request.header.type === 'audio').header.sampleRate, 96000)
  assert.ok(port.messages.some(message => message.type === 'analysis-ack' && message.sequence === 3))
  await setup.call('disconnect')
  assert.equal(port.closed, true)
  assert.equal(setup.children[0].killed, true)
  assert.ok(setup.requests.some(request => request.header.command === 'shutdown'))
  const replacement = new setup.Port()
  await setup.call('connect', {}, [replacement])
  await setup.call('configure', { enabled: true, chain: [] })
  assert.equal(setup.children.length, 2)
  setup.children[0].emit('exit', 1)
  assert.equal(setup.children[1].killed, undefined)
})

test('native crash preserves the known plugin delay for aligned dry fallback', async t => {
  const setup = fixture(t)
  await setup.call('initialize', { nativePath: 'fixture-host' })
  await setup.call('configure', { enabled: true, chain: [] })
  setup.children[0].emit('exit', 1)
  const failed = setup.published.filter(message => message.type === 'status').at(-1)
  assert.equal(failed.running, false)
  assert.equal(failed.latencySamples, 128)
  assert.match(failed.error, /退出/)
})

test('renderer PCM packets cannot inject native control ids, commands or plugin configuration', async t => {
  const setup = fixture(t)
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  port.send({ type: 'track', trackId: 'current-track', generation: 1 })
  const packet = { type: 'audio', sequence: 0, generation: 1, position: 0, frames: 512, pcm: new Float32Array(1024),
    id: 1, command: 'configure', chain: [{ path: 'unapproved.vst3' }], sampleRate: 1, channels: 12, tempo: 999 }
  port.send(packet)
  port.send({ ...packet, sequence: -1 })
  port.send({ ...packet, generation: -1 })
  await tick()
  const audio = setup.requests.filter(request => request.header.type === 'audio')
  assert.equal(audio.length, 1)
  assert.deepEqual(audio[0].header, { type: 'audio', sequence: 0, generation: 1, position: 0, frames: 512,
    channels: 2, sampleRate: 48000, playing: false, tempo: 120, trackId: 'current-track' })
  assert.equal(port.messages.filter(message => message.type === 'audio').length, 1)
})

test('scan handles split UTF-8 names and cancellation immediately permits another module', async t => {
  const setup = fixture(t)
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const first = setup.call('scan', { path: 'first.vst3' })
  const bytes = Buffer.from(JSON.stringify([{ name: '混响插件', classId: 'A'.repeat(32) }]))
  for (const byte of bytes) setup.children[0].stdout.emit('data', Buffer.from([byte]))
  setup.children[0].emit('exit', 0)
  assert.equal((await first)[0].name, '混响插件')
  const cancelled = setup.call('scan', { path: 'stuck.vst3' })
  const rejection = assert.rejects(cancelled, /取消/)
  await setup.call('cancelScan')
  await rejection
  const next = setup.call('scan', { path: 'next.vst3' })
  setup.children[2].stdout.emit('data', Buffer.from('[]'))
  setup.children[2].emit('exit', 0)
  assert.deepEqual(await next, [])
  assert.equal(setup.children[1].killed, true)
})

test('track changes reach the service even while automatic tempo analysis is disabled', async t => {
  const setup = fixture(t)
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  port.send({ type: 'track', trackId: 'next-track', generation: 3 })
  port.send({ type: 'reset', generation: 4 })
  assert.ok(setup.published.some(message => message.type === 'track' && message.trackId === 'next-track' && message.generation === 4))
  await setup.call('tempo', { trackId: 'next-track', bpm: 132 })
  port.send({ type: 'track', trackId: '', generation: 4 })
  assert.equal(await setup.call('tempo', { trackId: 'next-track', bpm: 200 }), false)
  assert.deepEqual(setup.published.filter(message => message.type === 'track').map(message => message.trackId), ['next-track', 'next-track', ''])
  port.send({ type: 'analysis', sequence: 5, generation: 4, position: 0, frames: 512, trackId: '', pcm: new Float32Array(512) })
  assert.ok(port.messages.some(message => message.type === 'analysis-ack' && message.sequence === 5))
  assert.equal(setup.children.length, 0)
})

const audioPacket = (sequence, generation = 1) => ({ type: 'audio', sequence, generation, position: 0,
  frames: 512, channels: 2, pcm: new Float32Array(1024) })

test('synchronous EPIPE retires the failed native host and stale callbacks cannot fail its replacement', async t => {
  const setup = fixture(t)
  await setup.call('initialize', { nativePath: 'fixture-host' })
  await setup.call('configure', { enabled: true, chain: [] })
  const old = setup.children[0], callback = old.writeCallbacks[0]
  old.stdin.write = () => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) }
  await assert.rejects(setup.call('native', { command: 'getState', payload: { instanceId: 'instance' } }), /EPIPE/)
  assert.equal(old.killed, true)
  assert.equal(setup.published.filter(message => message.type === 'status').at(-1).running, false)
  await setup.call('configure', { enabled: true, chain: [] })
  callback(new Error('late write EPIPE'))
  old.stdin.emit('error', new Error('late write EPIPE'))
  old.emit('exit', 1)
  assert.equal(setup.children.length, 2)
  assert.equal(setup.children[1].killed, undefined)
  assert.equal(setup.published.filter(message => message.type === 'status').at(-1).running, true)
})

test('an asynchronous pipe write failure promptly rejects its native request', async t => {
  const setup = fixture(t)
  await setup.call('initialize', { nativePath: 'fixture-host' })
  await setup.call('configure', { enabled: true, chain: [] })
  setup.children[0].stdin.write = (buffer, callback) => { queueMicrotask(() => callback(new Error('write EPIPE'))); return false }
  await assert.rejects(setup.call('native', { command: 'getState' }), /EPIPE/)
  assert.equal(setup.children[0].killed, true)
})

test('native credit stays at sixteen, every ACK advances the queue, and repeated resets preserve old credit until flush', async t => {
  const setup = fixture(t, { holdAudio: true })
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  port.send({ type: 'configure', sampleRate: 192000, bufferMs: 512 }); await tick()
  for (let i = 0; i < 80; i++) port.send(audioPacket(i))
  const audio = () => setup.requests.filter(request => request.header.type === 'audio')
  assert.equal(audio().length, 16)
  setup.replyAudio(); assert.equal(audio().length, 17)
  port.send({ type: 'reset', generation: 2 })
  for (let i = 0; i < 40; i++) port.send(audioPacket(i, 2))
  port.send({ type: 'reset', generation: 3 })
  for (let i = 0; i < 40; i++) port.send(audioPacket(i, 3))
  await tick()
  assert.equal(audio().length, 17)
  assert.equal(setup.requests.filter(request => request.header.command === 'flush').length, 0)
  setup.replyAudio(15); await tick()
  assert.equal(audio().length, 17)
  setup.replyAudio(); await tick()
  assert.equal(audio().length, 33)
  assert.ok(audio().slice(17).every(request => request.header.generation === 3))
  assert.deepEqual(setup.requests.filter(request => request.header.command === 'flush').map(request => request.header.generation), [3])
  assert.equal(port.messages.filter(message => message.type === 'audio').length, 1, 'obsolete native replies release credit but never play in the current generation')
})

test('the JS audio queue is bounded by buffer duration and changing it does not reconfigure native plugins', async t => {
  const setup = fixture(t, { holdAudio: true })
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  port.send({ type: 'configure', sampleRate: 192000, bufferMs: 512 }); await tick()
  for (let i = 0; i < 300; i++) port.send(audioPacket(i))
  assert.equal(setup.requests.filter(request => request.header.type === 'audio').length, 16)
  assert.equal(port.messages.filter(message => message.type === 'audio' && message.bypassed).length, 84)
  const before = setup.requests.filter(request => request.header.command === 'configure').length
  port.send({ type: 'buffer', bufferMs: 64 })
  port.send({ type: 'configure', sampleRate: 192000, bufferMs: 64 }); await tick()
  assert.equal(setup.requests.filter(request => request.header.command === 'configure').length, before)
  assert.equal(port.messages.filter(message => message.type === 'audio' && message.bypassed).length, 252)
  assert.equal(setup.children[0].killed, undefined)
})

test('state capture drains only sent audio and buffers new blocks until its control response', async t => {
  const setup = fixture(t, { holdAudio: true })
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  for (let i = 0; i < 16; i++) port.send(audioPacket(i))
  const capture = setup.call('native', { command: 'getState', payload: { instanceId: 'instance' } })
  for (let i = 16; i < 32; i++) port.send(audioPacket(i))
  await tick()
  assert.equal(setup.requests.filter(request => request.header.command === 'getState').length, 0)
  setup.replyAudio(15); await tick()
  assert.equal(setup.requests.filter(request => request.header.type === 'audio').length, 16)
  setup.replyAudio(); await capture
  const controlIndex = setup.requests.findIndex(request => request.header.command === 'getState')
  const resumedIndex = setup.requests.findIndex(request => request.header.type === 'audio' && request.header.sequence === 16)
  assert.ok(controlIndex > -1 && resumedIndex > controlIndex)
  assert.equal(setup.requests.filter(request => request.header.type === 'audio').length, 32)
})

test('sample-rate reconfiguration drains all old-format native packets before sending the new setup', async t => {
  const setup = fixture(t, { holdAudio: true })
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  for (let i = 0; i < 16; i++) port.send(audioPacket(i))
  port.send({ type: 'configure', sampleRate: 96000, bufferMs: 128 })
  for (let i = 16; i < 32; i++) port.send(audioPacket(i))
  await tick()
  assert.equal(setup.requests.filter(request => request.header.command === 'configure').length, 1)
  setup.replyAudio(16); await tick()
  const changed = setup.requests.findIndex(request => request.header.command === 'configure' && request.header.sampleRate === 96000)
  const nextAudio = setup.requests.findIndex(request => request.header.type === 'audio' && request.header.sequence === 16)
  assert.ok(changed > -1 && nextAudio > changed)
  assert.ok(setup.requests.slice(nextAudio).filter(request => request.header.type === 'audio').every(request => request.header.sampleRate === 96000))
})

test('an ACK and replacement send in the same millisecond still time out if the remaining audio stalls', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000 })
  const setup = fixture(t, { holdAudio: true })
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  t.mock.timers.tick(10000)
  for (let i = 0; i < 17; i++) port.send(audioPacket(i))
  setup.replyAudio()
  t.mock.timers.tick(2000)
  assert.equal(setup.children[0].killed, undefined)
  t.mock.timers.tick(500)
  assert.equal(setup.children[0].killed, true)
  assert.match(setup.published.filter(message => message.type === 'status').at(-1).error, /超时/)
})

test('an obsolete configure completion cannot dispatch PCM prepared for a newer sample rate', async t => {
  const setup = fixture(t, { holdAudio: true })
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  setup.heldCommands.add('configure')
  port.send({ type: 'configure', sampleRate: 96000, bufferMs: 128 }); await tick()
  port.send({ type: 'configure', sampleRate: 192000, bufferMs: 128 })
  for (let i = 0; i < 16; i++) port.send(audioPacket(i))
  setup.controlReplies.shift()(); await tick()
  assert.equal(setup.requests.filter(request => request.header.type === 'audio').length, 0)
  assert.equal(setup.controlReplies.length, 1)
  setup.controlReplies.shift()(); await tick()
  const sent = setup.requests.filter(request => request.header.type === 'audio')
  assert.equal(sent.length, 16)
  assert.ok(sent.every(request => request.header.sampleRate === 192000))
})

test('a control waiting for audio completion cannot cross into a replacement host', async t => {
  const setup = fixture(t, { holdAudio: true })
  await setup.call('initialize', { nativePath: 'fixture-host' })
  const port = new setup.Port()
  await setup.call('connect', {}, [port])
  await setup.call('configure', { enabled: true, chain: [] })
  port.send(audioPacket(0))
  const old = setup.children[0]
  const capture = setup.call('native', { command: 'getState', payload: { instanceId: 'old-instance' } })
  const rejected = assert.rejects(capture, /退出/)
  await tick()
  const recovery = setup.call('configure', { enabled: true, chain: [] })
  // Queue the replacement setup before releasing the drain continuation.
  await Promise.resolve()
  setup.replyAudio()
  old.emit('exit', 1)
  await Promise.all([rejected, recovery])
  assert.equal(setup.children.length, 2)
  assert.equal(setup.requests.filter(request => request.child === setup.children[1] && request.header.command === 'getState').length, 0)
  assert.equal(setup.children[1].killed, undefined)
})
