const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createAudioEffectsWorker } = require('../electron/services/audioEffectsWorker.cjs')
const { encodeFrame, createFrameDecoder } = require('../electron/services/audioEffectsProtocol.cjs')

const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  const children = [], published = [], requests = []
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
      if (header.id) queueMicrotask(() => child.stdout.emit('data', encodeFrame({ id: header.id, ok: true,
        result: header.command === 'configure' ? { latencySamples: 128, sampleRate: header.sampleRate } : true })))
      else if (header.type === 'audio') queueMicrotask(() => child.stdout.emit('data', encodeFrame({ ...header, latencySamples: 128 }, pcm)))
    })
    child.stdin.write = buffer => { decode(buffer); return true }
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
  return { worker, children, published, requests, Port, call }
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
