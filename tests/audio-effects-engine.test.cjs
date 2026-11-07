const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')

function worklet({ rate = 48000, bridge = 1024, bufferMs, transform, responseDelayFrames = 0 } = {}) {
  let Processor
  const reports = []
  const outgoing = []
  const pending = []
  const context = {
    Float32Array, Set, sampleRate: rate, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => reports.push(structuredClone(message)) } } },
    registerProcessor: (name, implementation) => { assert.equal(name, 'bk-audio-effects'); Processor = implementation }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/audio-effects-worklet.js'), 'utf8'), context)
  const processor = new Processor({ processorOptions: bufferMs === undefined ? { bridgeFrames: bridge } : { bufferMs } })
  const hostPort = {
    start() {}, close() { this.closed = true },
    postMessage(message) {
      const copy = structuredClone(message)
      outgoing.push(copy)
      if (copy.type === 'audio' && transform) pending.push({ ...copy, pcm: transform(copy.pcm, copy), dueAt: context.currentTime + responseDelayFrames / rate })
    }
  }
  processor.control({ type: 'connect', port: hostPort })
  processor.control({ type: 'track', trackId: 'song-A', position: 0, playing: true, changed: true })
  const render = (input, analysis = input) => {
    const source = Array.isArray(input) ? input : [input]
    const tap = Array.isArray(analysis) ? analysis : [analysis]
    const output = [new Float32Array(source[0].length), new Float32Array(source[0].length)]
    processor.process([source, tap], [output])
    context.currentTime += source[0].length / rate
    while (pending.length && pending[0].dueAt <= context.currentTime) processor.receive(pending.shift())
    return output
  }
  return { processor, reports, outgoing, hostPort, render, context }
}

for (const rate of [44100, 48000, 96000, 192000]) {
  test(`dry passthrough supports ${rate} Hz and a non-128 render quantum`, () => {
    const fixture = worklet({ rate })
    const left = Float32Array.from({ length: 192 }, (_, i) => Math.sin(i / 10) * 0.25)
    const right = Float32Array.from(left, sample => -sample)
    const output = fixture.render([left, right])
    assert.deepEqual(output[0], left)
    assert.deepEqual(output[1], right)
    assert.equal(fixture.outgoing.filter(message => message.type === 'audio').length, 0)
    assert.equal(fixture.outgoing[0].sampleRate, rate)
  })
}

test('native echo uses ordered stereo blocks and the direct port without UI audio messages', () => {
  const fixture = worklet({ transform: pcm => Float32Array.from(pcm, sample => sample * 2) })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  const output = []
  const source = Float32Array.from({ length: 8192 }, (_, i) => Math.sin(i / 33) * 0.2)
  for (let i = 0; i < source.length; i += 128) output.push(...fixture.render(source.subarray(i, i + 128))[0])
  for (let index = 2048; index < output.length; index++) assert.ok(Math.abs(output[index] - source[index - 1024] * 2) < 1e-6)
  const audio = fixture.outgoing.filter(message => message.type === 'audio')
  assert.equal(audio.length, 16)
  assert.ok(audio.every((message, index) => message.sequence === index && message.frames === 512 && message.channels === 2))
  assert.ok(fixture.reports.every(message => message.type !== 'audio'))
  assert.equal(fixture.processor.pending.size, 0)
})

test('host failure keeps dry audio aligned with bridge and plugin latency and bounds queued messages', () => {
  const fixture = worklet()
  fixture.processor.control({ type: 'latency', samples: 256 })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  const source = Float32Array.from({ length: 32768 }, (_, index) => (index % 1000) / 2000)
  const output = []
  for (let index = 0; index < source.length; index += 128) output.push(...fixture.render(source.subarray(index, index + 128))[0])
  for (let index = 1280; index < output.length; index++) assert.equal(output[index], source[index - 1280])
  assert.equal(fixture.outgoing.filter(message => message.type === 'audio').length, 32)
  assert.equal(fixture.processor.pending.size, 32)
  assert.equal(fixture.processor.overloaded, true)
  assert.ok(fixture.reports.some(message => message.error?.includes('超时')))
})

test('pause freezes buffered output and resume continues without dropping decoded samples', () => {
  const fixture = worklet({ transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 32; i++) fixture.render(new Float32Array(128).fill(i / 100))
  const frame = fixture.processor.frame
  const generation = fixture.processor.generation
  fixture.processor.control({ type: 'transport', playing: false, position: frame / 48000 })
  for (let i = 0; i < 5; i++) assert.ok(fixture.render(new Float32Array(128).fill(0.9))[0].every(value => value === 0))
  assert.equal(fixture.processor.frame, frame)
  assert.equal(fixture.processor.generation, generation)
  fixture.processor.control({ type: 'transport', playing: true, position: frame / 48000 })
  const resumed = fixture.render(new Float32Array(128).fill(0.32))[0]
  assert.ok(resumed.every(value => Math.abs(value - 0.24) < 1e-6))
})

test('seek clears old audio and rejects delayed native responses and obsolete tempo', () => {
  const fixture = worklet({ transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 20; i++) fixture.render(new Float32Array(128).fill(0.2))
  const oldMessage = fixture.outgoing.find(message => message.type === 'audio')
  fixture.processor.control({ type: 'transport', playing: true, seeking: true, position: 50 })
  const generation = fixture.processor.generation
  fixture.processor.receive(oldMessage)
  fixture.processor.receive({ type: 'tempo', trackId: 'song-B', bpm: 200 })
  assert.equal(fixture.processor.tempo, null)
  assert.ok(fixture.processor.wetSlots.every(slot => slot.sequence === -1))
  const first = fixture.render(new Float32Array(128).fill(0.7))[0]
  assert.ok(first.every(value => value === 0))
  assert.equal(fixture.reports.filter(message => message.type === 'presentation').at(-1).position, 50)
  assert.equal(fixture.processor.generation, generation)
})

test('BPM analysis uses the active source tap before deck and master gain', () => {
  const fixture = worklet({ transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 16; i++) fixture.render(new Float32Array(128), new Float32Array(128).fill(0.4))
  const analysis = fixture.outgoing.find(message => message.type === 'analysis')
  assert.equal(analysis.frames, 2048)
  assert.equal(analysis.channels, 1)
  assert.equal(analysis.trackId, 'song-A')
  assert.ok(analysis.pcm.every(value => Math.abs(value - 0.4) < 1e-6))
  assert.ok(fixture.outgoing.filter(message => message.type === 'audio').every(message => message.pcm.every(value => value === 0)))
})

test('planar stereo packets retain left/right order and analysis continues during effects bypass', () => {
  const fixture = worklet({ transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 4; i++) fixture.render([new Float32Array(128).fill(0.2), new Float32Array(128).fill(-0.3)])
  const packet = fixture.outgoing.find(message => message.type === 'audio')
  assert.ok(packet.pcm.subarray(0, 512).every(sample => Math.abs(sample - 0.2) < 1e-6))
  assert.ok(packet.pcm.subarray(512).every(sample => Math.abs(sample + 0.3) < 1e-6))
  fixture.processor.control({ type: 'enabled', value: false, position: 0 })
  const priorAudio = fixture.outgoing.filter(message => message.type === 'audio').length
  for (let i = 0; i < 96; i++) fixture.render(new Float32Array(128).fill(0.4))
  assert.equal(fixture.outgoing.filter(message => message.type === 'audio').length, priorAudio)
  const analysis = fixture.outgoing.filter(message => message.type === 'analysis')
  assert.equal(analysis.length, 4)
  assert.equal(fixture.processor.pendingAnalysis.size, 4)
  fixture.processor.receive({ type: 'analysis-ack', generation: fixture.processor.generation, sequence: analysis[0].sequence })
  for (let i = 0; i < 16; i++) fixture.render(new Float32Array(128).fill(0.4))
  assert.equal(fixture.outgoing.filter(message => message.type === 'analysis').length, 5)
})

test('a latency change rewarms wet blocks while preserving dry history and reports one resync reason', () => {
  const fixture = worklet()
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 32; i++) fixture.render(new Float32Array(128).fill(0.25))
  const frame = fixture.processor.frame
  const generation = fixture.processor.generation
  fixture.processor.control({ type: 'latency', samples: 256 })
  fixture.processor.control({ type: 'latency', samples: 256 })
  assert.equal(fixture.processor.frame, frame)
  assert.equal(fixture.processor.generation, generation + 1)
  assert.equal(fixture.reports.filter(message => message.reason === 'resync-required').length, 1)
  assert.ok(fixture.render(new Float32Array(128).fill(0.25))[0].every(value => value === 0.25))
  fixture.processor.control({ type: 'clear' })
  assert.equal(fixture.processor.trackId, '')
  assert.equal(fixture.processor.pending.size, 0)
  assert.ok(fixture.render(new Float32Array(128).fill(0.5))[0].every(value => value === 0))
  assert.ok(fixture.outgoing.some(message => message.type === 'track' && message.trackId === ''))
})

test('native bypass acknowledgements release credit without treating undelayed PCM as processed output', () => {
  const fixture = worklet()
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 4; i++) fixture.render(new Float32Array(128).fill(0.4))
  const packet = fixture.outgoing.find(message => message.type === 'audio')
  fixture.processor.receive({ ...packet, bypassed: true, reason: 'reconfiguring', latencySamples: 0 })
  assert.equal(fixture.processor.pending.size, 0)
  assert.ok(fixture.processor.wetSlots.every(slot => slot.sequence === -1))
})

test('natural end drains buffered music and bounded plugin tails, then holds the final presentation position', () => {
  const fixture = worklet({ transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  fixture.processor.control({ type: 'tail', samples: 512 })
  for (let i = 0; i < 32; i++) fixture.render(new Float32Array(128).fill(0.25))
  const end = fixture.processor.frame / 48000
  fixture.processor.control({ type: 'transport', playing: false, ended: true, position: end })
  const drained = []
  for (let i = 0; i < 16; i++) drained.push(...fixture.render(new Float32Array(128))[0])
  assert.ok(drained.slice(0, 1024).every(value => Math.abs(value - 0.25) < 1e-6))
  assert.ok(drained.slice(1536).every(value => value === 0))
  assert.equal(fixture.processor.draining, false)
  const last = fixture.reports.filter(message => message.type === 'presentation').at(-1)
  assert.equal(last.position, end)
  assert.equal(last.advancing, false)
  const frame = fixture.processor.frame
  fixture.processor.control({ type: 'transport', playing: false, ended: true, position: end })
  fixture.render(new Float32Array(128))
  assert.equal(fixture.processor.frame, frame)
})

test('a new committed track cancels an old drain deadline without resetting the shared effect chain', () => {
  const fixture = worklet({ transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 32; i++) fixture.render(new Float32Array(128).fill(0.25))
  fixture.processor.control({ type: 'tail', samples: -1 })
  fixture.processor.control({ type: 'transport', playing: false, ended: true, position: fixture.processor.frame / 48000 })
  assert.equal(fixture.processor.drainUntil - fixture.processor.frame, 1024 + 48000 * 10)
  const generation = fixture.processor.generation
  fixture.render(new Float32Array(128))
  fixture.processor.control({ type: 'track', trackId: 'song-B', position: 0, playing: true, changed: true })
  for (let i = 0; i < 32; i++) fixture.render(new Float32Array(128).fill(0.5))
  assert.equal(fixture.processor.generation, generation)
  assert.equal(fixture.processor.playing, true)
  assert.equal(fixture.processor.draining, false)
  assert.ok(fixture.render(new Float32Array(128).fill(0.5))[0].every(value => Math.abs(value - 0.5) < 1e-6))
})

test('an infinite native tail is silenced after ten seconds plus the bridge delay', () => {
  const fixture = worklet({ transform: pcm => new Float32Array(pcm.length).fill(0.1) })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  fixture.processor.receive({ type: 'status', tailSamples: -1 })
  for (let i = 0; i < 32; i++) fixture.render(new Float32Array(128))
  fixture.processor.control({ type: 'transport', playing: false, ended: true, position: fixture.processor.frame / 48000 })
  const until = fixture.processor.frame + 1024 + 48000 * 10
  let last
  while (fixture.processor.frame < until) last = fixture.render(new Float32Array(128))[0]
  assert.ok(last.every(value => Math.abs(value - 0.1) < 1e-6))
  assert.ok(fixture.render(new Float32Array(128))[0].every(value => value === 0))
  assert.equal(fixture.processor.draining, false)
  assert.equal(fixture.processor.frame, until)
})

function pageFixture() {
  const listeners = new Set()
  const page = {
    addEventListener(type, callback) { if (type === 'message') listeners.add(callback) },
    removeEventListener(type, callback) { if (type === 'message') listeners.delete(callback) },
    emit(data, ports, source = page) { for (const callback of [...listeners]) callback({ data, ports, source }) }
  }
  return { page, listeners }
}

function engineModule(globals = {}) {
  const source = fs.readFileSync(path.join(root, 'src/utils/audioEffectsEngine.js'), 'utf8').replace(/export /g, '')
  return vm.runInNewContext(`${source}\n;({ createAudioEffectsEngine, connectAudioEffectsPort })`, {
    URL, Date, AbortController, setTimeout, clearTimeout, ...globals
  })
}

test('audio port handshake validates the page and request and releases its listener', async () => {
  const { page, listeners } = pageFixture()
  const { connectAudioEffectsPort } = engineModule()
  const expectedPort = { close() {} }
  const api = { connectAudio(connectionId) {
    page.emit({ type: 'bk-audio-effects-port', connectionId }, [{ wrong: true }], {})
    page.emit({ type: 'bk-audio-effects-port', connectionId: 'other' }, [{ wrong: true }])
    page.emit({ type: 'bk-audio-effects-port', connectionId }, [expectedPort])
    return { connectionId }
  } }
  assert.equal(await connectAudioEffectsPort(api, page), expectedPort)
  assert.equal(listeners.size, 0)
  const cancellation = new AbortController()
  const pending = connectAudioEffectsPort({ connectAudio() { return {} } }, page, 10000, cancellation.signal)
  cancellation.abort()
  await assert.rejects(pending, /取消/)
  assert.equal(listeners.size, 0)
  await assert.rejects(connectAudioEffectsPort({ connectAudio() { return {} } }, page, 5), /超时/)
  assert.equal(listeners.size, 0)
})

function graphFixture({ getStatus = async () => ({ state: 'ready', audioConnectionGeneration: 1, reconnectRequired: false }), ...options } = {}) {
  const { page } = pageFixture()
  const nodes = []
  const sent = []
  let actualContext
  let actualWorklet
  let statusListener
  let connections = 0
  class Node {
    constructor(kind) { this.kind = kind; this.links = []; this.gain = {
      value: 1, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value }, setTargetAtTime(value) { this.value = value }
    }; nodes.push(this) }
    connect(node, output = 0, input = 0) { this.links.push({ node, output, input }); return node }
    disconnect(node, output, input) { this.links = node ? this.links.filter(link => link.node !== node || (input !== undefined && link.input !== input)) : [] }
  }
  class Context {
    constructor() { actualContext = this; this.sampleRate = 44100; this.currentTime = 0; this.destination = new Node('destination'); this.sources = 0; this.audioWorklet = { addModule: async () => {} } }
    createGain() { return new Node('gain') }
    createAnalyser() {
      const analyser = new Node('analyser')
      Object.defineProperty(analyser, 'frequencyBinCount', { get: () => analyser.fftSize / 2 })
      analyser.getFloatFrequencyData = spectrum => {
        spectrum.fill(-Infinity)
        for (const [bin, decibels] of this.spectrum || []) spectrum[bin] = decibels
      }
      return analyser
    }
    createMediaElementSource() { this.sources++; return new Node('source') }
    async resume() { this.resumed = true }
    async close() { this.closed = true }
  }
  class WorkletNode extends Node {
    constructor(context, name, options) { super('worklet'); actualWorklet = this; this.options = options; this.port = {
      postMessage(message, transfer) { if (message.port) assert.equal(transfer?.[0], message.port); sent.push(message) }, close() {}
    } }
  }
  const port = { close() {} }
  const api = { connectAudio(connectionId) { connections++; page.emit({ type: 'bk-audio-effects-port', connectionId }, [port]); return { connectionId } },
    getStatus,
    onStatus: callback => { statusListener = callback; return () => { statusListener = null } } }
  const { createAudioEffectsEngine } = engineModule()
  const engine = createAudioEffectsEngine({ api, page, AudioContextClass: Context, AudioWorkletNodeClass: WorkletNode, ...options })
  return { engine, nodes, sent, context: () => actualContext, worklet: () => actualWorklet,
    status: value => statusListener?.(value), connections: () => connections }
}

test('output identities cross the same delay boundary as PCM across rapid input changes', () => {
  const fixture = worklet({ bridge: 1024 })
  fixture.processor.control({ type: 'latency', samples: 48000 })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 500; i++) fixture.render(new Float32Array(128).fill(0.2))
  const boundary = fixture.processor.frame
  fixture.processor.control({ type: 'track', trackId: 'song-B', token: 2, position: 0, playing: true, changed: true })
  assert.equal(fixture.reports.at(-2).trackId, 'song-A')
  assert.equal(fixture.reports.filter(value => value.type === 'presentation').at(-1).sourceTrackId, 'song-B')
  for (let i = 0; i < 100; i++) assert.ok(fixture.render(new Float32Array(128).fill(0.4))[0].every(value => Math.abs(value - 0.2) < 1e-6))
  fixture.processor.control({ type: 'track', trackId: 'song-C', token: 3, position: 0, playing: true, changed: true })
  let heardB = false, heardC = false
  for (let i = 0; i < 500; i++) {
    const start = fixture.processor.frame
    const output = fixture.render(new Float32Array(128).fill(0.7))[0]
    const reports = fixture.reports.filter(value => value.type === 'presentation')
    const audibleFrame = start - 49024
    if (audibleFrame < boundary) assert.ok(output.every(value => Math.abs(value - 0.2) < 1e-6))
    else if (audibleFrame < boundary + 12800) {
      heardB = true
      assert.ok(output.every(value => Math.abs(value - 0.4) < 1e-6))
      assert.equal(reports.at(-1).trackId, 'song-B')
    } else {
      heardC = true
      assert.ok(output.every(value => Math.abs(value - 0.7) < 1e-6))
      assert.equal(reports.at(-1).trackId, 'song-C')
    }
  }
  assert.equal(heardB && heardC, true)
})

test('continuous same-source repeats preserve delayed tails without inserting a latency-sized silence', () => {
  const fixture = worklet({ bridge: 1024 })
  fixture.processor.control({ type: 'latency', samples: 48000 })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 600; i++) fixture.render(new Float32Array(128).fill(0.2))
  const generation = fixture.processor.generation
  const end = fixture.processor.frame
  fixture.processor.control({ type: 'transport', playing: false, ended: true, position: end / 48000 })
  fixture.processor.control({ type: 'track', trackId: 'song-A', token: 2, position: 0, playing: true, changed: true })
  assert.equal(fixture.processor.generation, generation)
  let repeated = false
  for (let i = 0; i < 500; i++) {
    const output = fixture.render(new Float32Array(128).fill(0.7))[0]
    assert.ok(output.every(value => value > 0.19), 'the old tail and repeated audio remain audible')
    const report = fixture.reports.filter(value => value.type === 'presentation').at(-1)
    if (report.token === 2) {
      repeated = true
      assert.ok(report.position < 0.3)
    }
  }
  assert.equal(repeated, true)
  fixture.processor.control({ type: 'transport', playing: true, seeking: true, position: 8 })
  assert.ok(fixture.render(new Float32Array(128).fill(0.4))[0].every(value => value === 0), 'an explicit seek still flushes queued audio')
  assert.equal(fixture.processor.presentationMarkers.length, 0)
})

test('engine retains the output clock while new input is paused and rejects stale source tokens', async () => {
  const fixture = graphFixture()
  const a = { crossOrigin: 'anonymous', currentTime: 40 }
  const b = { crossOrigin: 'anonymous', currentTime: 0.1 }
  await fixture.engine.attach(a); await fixture.engine.attach(b)
  fixture.engine.setActiveTrack({ audio: a, trackId: 'A', position: 40, playing: true })
  fixture.engine.setEnabled(true)
  const aToken = fixture.engine.activePresentationToken
  fixture.worklet().port.onmessage({ data: { type: 'presentation', trackId: 'A', token: aToken, sourceTrackId: 'A', sourceToken: aToken,
    position: 39, contextTime: 0, advancing: true } })
  fixture.engine.setActiveTrack({ audio: b, trackId: 'B', position: 0, playing: true })
  const bToken = fixture.engine.activePresentationToken
  fixture.worklet().port.onmessage({ data: { type: 'presentation', trackId: 'A', token: aToken, sourceTrackId: 'B', sourceToken: bToken,
    position: 39.2, contextTime: 0.2, advancing: true, maxPosition: 40 } })
  fixture.context().currentTime = 0.3
  assert.equal(fixture.engine.getPresentedPlayback().trackId, 'A')
  assert.ok(Math.abs(fixture.engine.getPresentedPlayback().position - 39.3) < 1e-6)
  fixture.engine.transport({ playing: false })
  fixture.context().currentTime = 3
  assert.ok(Math.abs(fixture.engine.getPresentedPlayback().position - 39.3) < 1e-6)
  fixture.worklet().port.onmessage({ data: { type: 'presentation', trackId: 'B', sourceTrackId: 'A', sourceToken: aToken, position: 12 } })
  assert.equal(fixture.engine.getPresentedPlayback().trackId, 'A')
  fixture.engine.transport({ playing: false, seeking: true, position: 20 })
  const epoch = fixture.sent.filter(value => value.type === 'transport').at(-1).epoch
  b.currentTime = 20
  fixture.worklet().port.onmessage({ data: { type: 'presentation', trackId: 'A', token: aToken,
    sourceTrackId: 'B', sourceToken: bToken, epoch: epoch - 1, position: 39.4, contextTime: 3, advancing: false } })
  assert.equal(fixture.engine.getPresentedPlayback().trackId, 'B')
  assert.equal(fixture.engine.getPresentedPlayback().position, 20, 'late pre-seek reports cannot revive the prior output clock')
  fixture.worklet().onprocessorerror()
  assert.equal(fixture.engine.getPresentedPlayback().trackId, 'B')
  assert.equal(fixture.engine.getPresentedPlayback().position, 20)
  await fixture.engine.dispose()
})

test('one media source survives detach/re-attach and master gain follows the effect graph', async () => {
  const fixture = graphFixture()
  fixture.engine.setEnabled(true)
  const audio = { crossOrigin: 'anonymous', volume: 0.2, muted: true, currentTime: 10 }
  const deck = await fixture.engine.attach(audio)
  assert.equal(fixture.sent.find(value => value.type === 'enabled').epoch, 1, 'initialization retains an enable epoch received before the graph existed')
  fixture.engine.setDeckGain(audio, 0.5)
  fixture.engine.setMaster(0.25, false)
  assert.equal(audio.volume, 1)
  assert.equal(audio.muted, false)
  assert.equal(deck.gain.gain.value, 0.5)
  const master = fixture.worklet().links[0].node
  assert.equal(master.gain.value, 0.25)
  assert.equal(master.links[0].node.kind, 'destination')
  assert.equal(fixture.worklet().options.processorOptions.bufferMs, 128)
  fixture.engine.detach(audio)
  await fixture.engine.attach(audio)
  assert.equal(fixture.context().sources, 1)
  await assert.rejects(fixture.engine.attach({ crossOrigin: null }), /跨域/)
  await fixture.engine.dispose()
  assert.equal(fixture.context().closed, true)
})

test('background beats use actual bass attacks on the presented mix and release the tap on close', async () => {
  const fixture = graphFixture()
  const { engine } = fixture
  const audio = { crossOrigin: 'anonymous', currentTime: 3 }
  await engine.attach(audio)
  assert.equal(engine.readBackgroundBeat(), 0)
  assert.ok(!fixture.nodes.some(node => node.kind === 'analyser'))
  engine.setActiveTrack({ audio, trackId: 'A', playing: true })
  const context = fixture.context()
  const sample = (time, spectrum) => {
    context.currentTime = time
    context.spectrum = spectrum
    return engine.readBackgroundBeat()
  }
  assert.equal(sample(0, []), 0)
  assert.equal(sample(0.02, [[18, -5]]), 0, 'higher frequencies do not pulse the background')
  assert.equal(sample(0.04, [[3, -15]]), 1)
  const sustained = sample(0.22, [[3, -15]])
  assert.ok(sustained > 0 && sustained < 0.4, 'sustained bass only decays after the attack')
  engine.setMaster(0, true)
  sample(0.24, [])
  assert.equal(sample(0.26, [[3, -15]]), 1, 'volume and mute only affect the audible gain')

  engine.transport({ playing: false })
  assert.equal(sample(0.28, [[3, -15]]), 0)
  engine.transport({ playing: true, seeking: true })
  assert.equal(sample(0.30, [[3, -15]]), 0, 'resume and seek establish a fresh baseline')
  engine.stopBackgroundBeat()
  assert.deepEqual(fixture.worklet().links.map(link => link.node.kind), ['gain'])

  fixture.worklet().onprocessorerror()
  assert.equal(sample(0.32, []), 0)
  assert.equal(sample(0.34, [[3, -15]]), 1, 'dry recovery also follows its real audio')
  await engine.dispose()
  assert.ok(fixture.nodes.every(node => node.links.every(link => link.node.kind !== 'analyser')))
})

test('presentation advances from worklet time and freezes at pause; processor failure reconnects dry audio', async () => {
  const fixture = graphFixture()
  const audio = { crossOrigin: 'anonymous', currentTime: 10 }
  await fixture.engine.attach(audio)
  fixture.engine.setActiveTrack({ audio, trackId: 'A', position: 0, playing: true })
  fixture.engine.setEnabled(true)
  fixture.worklet().port.onmessage({ data: { type: 'presentation', trackId: 'A', position: 9.9, contextTime: 1, advancing: true } })
  fixture.context().currentTime = 1.02
  assert.ok(Math.abs(fixture.engine.getPresentationTime(audio, 10) - 9.92) < 1e-6)
  fixture.engine.transport({ playing: false })
  fixture.context().currentTime = 10
  assert.ok(Math.abs(fixture.engine.getPresentationTime(audio, 10) - 9.92) < 1e-6)
  fixture.worklet().onprocessorerror()
  assert.equal(fixture.engine.getPresentationTime(audio, 10), 10)
  assert.equal(fixture.engine.ready, false)
  await fixture.engine.dispose()
})

test('a replacement utility generation transfers a fresh port once without rebuilding media sources', async () => {
  const fixture = graphFixture()
  const audio = { crossOrigin: 'anonymous', currentTime: 10 }
  await fixture.engine.attach(audio)
  await Promise.resolve()
  fixture.status({ running: false, reconnectRequired: true, audioConnectionGeneration: 1, error: 'utility exited' })
  assert.equal(fixture.connections(), 1)
  fixture.status({ running: true, reconnectRequired: true, audioConnectionGeneration: 2, error: '' })
  fixture.status({ running: true, reconnectRequired: true, audioConnectionGeneration: 2, error: '' })
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(fixture.connections(), 2)
  assert.equal(fixture.sent.filter(message => message.type === 'connect').length, 2)
  assert.equal(fixture.context().sources, 1)
  await fixture.engine.dispose()
})

test('replacing the direct port preserves dry history and resumes new-generation PCM', () => {
  const fixture = worklet({ transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let i = 0; i < 32; i++) fixture.render(new Float32Array(128).fill(0.25))
  const generation = fixture.processor.generation
  const sent = []
  const nextPort = { start() {}, close() {}, postMessage(message) { sent.push(structuredClone(message)) } }
  fixture.processor.control({ type: 'connect', port: nextPort })
  assert.equal(fixture.hostPort.closed, true)
  assert.equal(fixture.processor.generation, generation + 1)
  assert.ok(fixture.render(new Float32Array(128).fill(0.25))[0].every(value => value === 0.25))
  for (let i = 0; i < 3; i++) fixture.render(new Float32Array(128).fill(0.25))
  assert.ok(sent.some(message => message.type === 'audio' && message.generation === generation + 1))
  assert.ok(sent.some(message => message.type === 'track' && message.trackId === 'song-A'))
})

for (const rate of [44100, 48000, 96000, 192000]) for (const bufferMs of [64, 128, 256, 512]) {
  test(`${bufferMs} ms at ${rate} Hz retains every wet block until its audible deadline`, () => {
    const fixture = worklet({ rate, bufferMs, transform: pcm => Float32Array.from(pcm, sample => sample * 2) })
    const { processor } = fixture
    const bridge = Math.ceil(rate * bufferMs / 1000 / 128) * 128
    assert.equal(processor.bridgeFrames, bridge)
    assert.ok(processor.wetSlots.length > Math.ceil(bridge / 512))
    assert.ok(processor.capacity > rate * 10 + bridge)
    processor.control({ type: 'enabled', value: true, position: 0 })
    for (let frame = 0; frame < bridge + 4096; frame += 128) {
      const output = fixture.render(new Float32Array(128).fill(0.2))[0]
      if (frame > bridge + 1024) assert.ok(output.every(value => Math.abs(value - 0.4) < 1e-6))
    }
    assert.equal(processor.overloaded, false)
    assert.equal(processor.pending.size, 0)
    assert.equal(fixture.outgoing[0].bufferMs, bufferMs)
  })
}

test('larger buffers tolerate native replies exceeding the old 32-block deadline at 192 kHz', () => {
  const fixture = worklet({ rate: 192000, bufferMs: 256, responseDelayFrames: 19200,
    transform: pcm => Float32Array.from(pcm, sample => sample * 2) })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let frame = 0; frame < 80000; frame += 128) {
    const output = fixture.render(new Float32Array(128).fill(0.2))[0]
    if (frame > fixture.processor.bridgeFrames + 2048) assert.ok(output.every(value => Math.abs(value - 0.4) < 1e-6))
  }
  assert.equal(fixture.processor.overloaded, false)
  assert.ok(fixture.processor.pending.size > 32)
  assert.ok(fixture.processor.pending.size < fixture.processor.maxPendingBlocks)
  assert.equal(fixture.reports.some(message => message.state === 'failed'), false)
})

test('live buffer edits preserve the dry history, fade between read positions and invalidate old wet packets', () => {
  const fixture = worklet({ bufferMs: 64, transform: pcm => pcm })
  const { processor } = fixture
  processor.control({ type: 'enabled', value: true, position: 0 })
  for (let frame = 0; frame < 48000; frame += 128) fixture.render(new Float32Array(128).fill(0.25))
  const oldPacket = fixture.outgoing.findLast(message => message.type === 'audio')
  const frame = processor.frame, dry = processor.dry, generation = processor.generation
  for (const value of [512, 128, 256, 64]) {
    processor.control({ type: 'buffer', bufferMs: value, epoch: value })
    assert.equal(processor.dry, dry)
    assert.ok(processor.frame >= frame)
    assert.equal(processor.bufferMs, value)
    assert.ok(processor.generation > generation)
    processor.receive(oldPacket)
    assert.ok(processor.wetSlots.every(slot => slot.sequence === -1))
    for (let index = 0; index < 260; index++) assert.ok(fixture.render(new Float32Array(128).fill(0.25))[0].every(sample => sample === 0.25))
    const presentation = fixture.reports.findLast(message => message.type === 'presentation')
    assert.equal(presentation.epoch, value)
    assert.ok(Math.abs(presentation.position - (processor.frame - processor.bridgeFrames) / 48000) < 2048 / 48000)
    assert.equal(presentation.latencySamples, processor.bridgeFrames)
  }
  assert.equal(fixture.outgoing.filter(message => message.type === 'configure').length, 1, 'buffer changes must not rebuild the native effect chain')
  assert.equal(fixture.outgoing.filter(message => message.type === 'buffer').length, 4)
})

test('a paused buffer change remains silent and resumes its fade without advancing the output clock', () => {
  const fixture = worklet({ bufferMs: 64, transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let frame = 0; frame < 48000; frame += 128) fixture.render(new Float32Array(128).fill(0.3))
  fixture.processor.control({ type: 'transport', playing: false })
  const frame = fixture.processor.frame
  fixture.processor.control({ type: 'buffer', bufferMs: 512, epoch: 2 })
  const fade = fixture.processor.latencyFade
  for (let index = 0; index < 8; index++) assert.ok(fixture.render(new Float32Array(128))[0].every(sample => sample === 0))
  assert.equal(fixture.processor.frame, frame)
  assert.equal(fixture.processor.latencyFade, fade)
  assert.equal(fixture.reports.findLast(message => message.type === 'presentation').advancing, false)
  fixture.processor.control({ type: 'transport', playing: true })
  assert.ok(fixture.render(new Float32Array(128).fill(0.3))[0].every(sample => Math.abs(sample - 0.3) < 1e-6))
})

test('increasing a buffer restores the preceding song identity if its samples become audible again', () => {
  const fixture = worklet({ bufferMs: 64, transform: pcm => pcm })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let frame = 0; frame < 48000; frame += 128) fixture.render(new Float32Array(128).fill(0.1))
  fixture.processor.control({ type: 'track', trackId: 'song-B', token: 2, position: 0, playing: true, changed: true })
  for (let frame = 0; frame < 9600; frame += 128) fixture.render(new Float32Array(128).fill(0.2))
  assert.equal(fixture.reports.findLast(message => message.type === 'presentation').trackId, 'song-B')
  fixture.processor.control({ type: 'buffer', bufferMs: 512, epoch: 9 })
  for (let frame = 0; frame < 4096; frame += 128) fixture.render(new Float32Array(128).fill(0.2))
  const report = fixture.reports.findLast(message => message.type === 'presentation')
  assert.equal(report.trackId, 'song-A')
  assert.equal(report.sourceTrackId, 'song-B')
  assert.equal(report.epoch, 9)
})

test('late acknowledgements recover an overloaded bridge without erasing dry audio or the presented marker', () => {
  const fixture = worklet({ bufferMs: 128 })
  fixture.processor.control({ type: 'enabled', value: true, position: 0 })
  for (let frame = 0; frame < 48000; frame += 128) fixture.render(new Float32Array(128).fill(0.3))
  assert.equal(fixture.processor.overloaded, true)
  const frame = fixture.processor.frame, generation = fixture.processor.generation
  const packets = fixture.outgoing.filter(message => message.type === 'audio')
  for (const packet of packets.slice(0, Math.ceil(packets.length / 2))) fixture.processor.receive(packet)
  assert.equal(fixture.processor.overloaded, false)
  assert.equal(fixture.processor.frame, frame)
  assert.equal(fixture.processor.generation, generation + 1)
  assert.equal(fixture.processor.presentedMarker.trackId, 'song-A')
  assert.ok(fixture.render(new Float32Array(128).fill(0.3))[0].every(sample => Math.abs(sample - 0.3) < 1e-6))
  assert.ok(fixture.reports.some(message => message.detail === 'host-recovered' && message.error === ''))
})

test('engine consumes only applied buffer preferences and rejects reports from before the edit', async () => {
  const fixture = graphFixture({ bufferMs: 64 })
  const audio = { crossOrigin: 'anonymous', currentTime: 3 }
  await fixture.engine.attach(audio)
  fixture.engine.setActiveTrack({ audio, trackId: 'A', playing: true })
  fixture.engine.setEnabled(true)
  fixture.worklet().port.onmessage({ data: { type: 'presentation', trackId: 'A', sourceTrackId: 'A',
    sourceToken: fixture.engine.activePresentationToken, epoch: 1, position: 2.9, contextTime: 0, advancing: false } })
  fixture.status({ revision: 1, bufferMs: 512, appliedBufferMs: 128, pendingChanges: true })
  assert.equal(fixture.engine.bufferMs, 128)
  const change = fixture.sent.findLast(message => message.type === 'buffer')
  assert.equal(change.bufferMs, 128)
  assert.equal(change.epoch, 2)
  assert.equal(fixture.context().sources, 1)
  fixture.worklet().port.onmessage({ data: { type: 'presentation', trackId: 'A', sourceTrackId: 'A', epoch: 1, position: 99 } })
  assert.equal(fixture.engine.getPresentedPlayback().position, 2.9)
  fixture.status({ revision: 2, bufferMs: 512, appliedBufferMs: 512 })
  assert.equal(fixture.engine.bufferMs, 512)
  assert.equal(fixture.engine.setBufferMs(300), false)
  assert.equal(fixture.engine.setBufferMs('128'), false)
  assert.equal(fixture.engine.bufferMs, 512)
  fixture.status({ revision: 3, bufferMs: 'invalid' })
  assert.equal(fixture.engine.bufferMs, 128)
  await fixture.engine.dispose()
})

test('a late initial status cannot restore an older buffer or host failure after a newer push', async () => {
  let finishStatus
  const fixture = graphFixture({ getStatus: () => new Promise(resolve => { finishStatus = resolve }) })
  await fixture.engine.init()
  fixture.status({ revision: 7, bufferMs: 512, appliedBufferMs: 512, running: true })
  const controlCount = fixture.sent.length
  finishStatus({ revision: 6, bufferMs: 64, appliedBufferMs: 64, error: 'old host failure' })
  await Promise.resolve()
  assert.equal(fixture.engine.bufferMs, 512)
  assert.equal(fixture.sent.length, controlCount, 'old snapshots cannot send buffer or host-state controls')
  fixture.worklet().port.onmessage({ data: { type: 'status', latencySamples: 24576 } })
  assert.equal(fixture.engine.latencySamples, 24576, 'worklet reports are independent of service snapshot revisions')
  fixture.status({ revision: 8, bufferMs: 256, appliedBufferMs: 256 })
  assert.equal(fixture.engine.bufferMs, 256)
  await fixture.engine.dispose()
})

test('invalid buffer controls cannot invalidate the audible clock or allocate unbounded queues', () => {
  const fixture = worklet({ bufferMs: 128 })
  const { processor } = fixture
  const generation = processor.generation, slots = processor.wetSlots, epoch = processor.presentationEpoch
  for (const value of [-1, 0, 300, '512', Infinity, null]) processor.control({ type: 'buffer', bufferMs: value, epoch: 999 })
  assert.equal(processor.generation, generation)
  assert.equal(processor.wetSlots, slots)
  assert.equal(processor.presentationEpoch, epoch)
  assert.equal(processor.bufferMs, 128)
})

test('rapid buffer changes join the actual mixed output without a discontinuity or replaying pre-seek samples', () => {
  const fixture = worklet({ bufferMs: 64, transform: pcm => pcm })
  const { processor } = fixture
  processor.control({ type: 'enabled', value: true, position: 0 })
  let previous = 0
  const renderSine = () => {
    const frame = processor.frame
    const output = fixture.render(Float32Array.from({ length: 128 }, (_, i) => Math.sin((frame + i) * 2 * Math.PI * 440 / 48000) * 0.5))[0]
    const boundaryJump = Math.abs(output[0] - previous)
    previous = output.at(-1)
    return { output, boundaryJump }
  }
  for (let index = 0; index < 500; index++) renderSine()
  for (const [index, bufferMs] of [512, 128, 256, 64, 512, 128].entries()) {
    processor.control({ type: 'buffer', bufferMs, epoch: index + 2 })
    const { output, boundaryJump } = renderSine()
    assert.ok(boundaryJump < 1e-6, `edit ${index + 1} starts from the last actual sample`)
    assert.ok(output.every(Number.isFinite))
    for (let i = 1; i < output.length; i++) assert.ok(Math.abs(output[i] - output[i - 1]) < 0.07)
  }
  processor.control({ type: 'buffer', bufferMs: 512, epoch: 9 })
  processor.control({ type: 'transport', playing: true, seeking: true, position: 12, epoch: 10 })
  assert.equal(processor.smoothOutput, false, 'seek discards the old output correction')
  assert.ok(fixture.render(new Float32Array(128).fill(0.3))[0].every(sample => sample === 0))
})

test('a buffer edit before first playback cannot carry an obsolete correction into startup', () => {
  const fixture = worklet({ bufferMs: 64, transform: pcm => pcm })
  fixture.processor.control({ type: 'transport', playing: false })
  fixture.processor.control({ type: 'buffer', bufferMs: 512, epoch: 1 })
  fixture.processor.control({ type: 'buffer', bufferMs: 128, epoch: 2 })
  fixture.processor.control({ type: 'enabled', value: true, position: 0, epoch: 3 })
  fixture.processor.control({ type: 'transport', playing: true })
  assert.equal(fixture.processor.smoothOutput, false)
  assert.ok(fixture.render(new Float32Array(128).fill(0.3))[0].every(sample => sample === 0))
})
