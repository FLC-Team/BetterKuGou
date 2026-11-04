const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/utils/trailingSilence.js'), 'utf8')
  .replace(/\bexport (?=(?:async )?function|const)/g, '')
const { findTrailingSilence, createTrailingSilenceAnalyzer } = vm.runInNewContext(
  `${source}\n;({ findTrailingSilence, createTrailingSilenceAnalyzer })`, { AbortController, setTimeout, clearTimeout })

function pcm({ duration = 30, sampleRate = 8000, channels = 1, silence = 3 } = {}) {
  const length = Math.round(duration * sampleRate)
  const data = Array.from({ length: channels }, () => {
    const samples = new Float32Array(length)
    samples.fill(0.1, 0, Math.round((duration - silence) * sampleRate))
    return samples
  })
  return { duration, sampleRate, length, numberOfChannels: channels, getChannelData: channel => data[channel], data }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function tick() { await new Promise(resolve => setImmediate(resolve)) }
function fixture(options = {}) {
  const calls = [], released = [], errors = [], fetches = [], decodes = []
  const buffer = options.buffer || pcm()
  const apiSource = { status: 1, leaseId: 'a'.repeat(48), url: `bk-cache://media/${'a'.repeat(48)}`,
    size: 8, sha256: 'b'.repeat(64), audioMetadata: { duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate },
    ...options.source }
  const analyzer = createTrailingSilenceAnalyzer({
    getSource: async request => { calls.push(request); return options.getSource ? options.getSource(request) : apiSource },
    releaseSource: async id => { released.push(id); return options.release?.(id) }, onError: error => errors.push(error),
    fetch: async (url, config) => { fetches.push([url, config]); return options.fetch ? options.fetch(url, config) : new Response(new Uint8Array(apiSource.size), { headers: { 'content-length': String(apiSource.size) } }) },
    createContext: rate => ({ async decodeAudioData(bytes) { decodes.push([rate, bytes.byteLength]); return options.decode ? options.decode(bytes) : buffer } }),
    timeoutMs: options.timeoutMs || 1000
  })
  return { analyzer, calls, released, errors, fetches, decodes, apiSource,
    request: (song = { hash: 'song-a' }, quality = '128', duration = buffer.duration, session = 1) => analyzer.request(song, quality, duration, session) }
}

test('only the terminal suffix is skipped, with a quarter second of silence retained', async () => {
  const result = await findTrailingSilence(pcm(), 30)
  assert.equal(result.silenceStart, 27)
  assert.equal(result.skipAt, 27.25)
  assert.equal(result.duration, 30)
  assert.equal(await findTrailingSilence(pcm({ silence: 1.49 }), 30), null)
  assert.equal((await findTrailingSilence(pcm({ silence: 1.5 }), 30)).skipAt, 28.75)
})

test('analysis requires a sound boundary within the bounded tail window, rejecting all-silent files', async () => {
  assert.equal((await findTrailingSilence(pcm({ duration: 300, silence: 15 }), 300)).silenceStart, 285)
  assert.equal(await findTrailingSilence(pcm({ duration: 300, silence: 100 }), 300), null)
  assert.equal(await findTrailingSilence(pcm({ duration: 20, silence: 8 }), 20), null)
  assert.equal(await findTrailingSilence(pcm({ duration: 10, silence: 8 }), 10), null)
  assert.equal(await findTrailingSilence(pcm({ duration: 30, silence: 30 }), 30), null)
})

test('late speech, a transient and a faint sustained tail all prevent a premature skip', async () => {
  const speech = pcm()
  speech.data[0].fill(0.02, 29 * 8000, 29.1 * 8000)
  assert.equal(await findTrailingSilence(speech, 30), null)
  const transient = pcm()
  transient.data[0][29.5 * 8000] = 0.002
  assert.equal(await findTrailingSilence(transient, 30), null)
  const quiet = pcm()
  quiet.data[0].fill(0.0008, 27 * 8000)
  assert.equal(await findTrailingSilence(quiet, 30), null)
})

test('channels are not mixed: one audible channel and phase cancellation cannot become silence', async () => {
  const stereo = pcm({ channels: 2 })
  stereo.data[1].fill(0.1)
  assert.equal(await findTrailingSilence(stereo, 30), null)
  stereo.data[0].fill(-0.1)
  assert.equal(await findTrailingSilence(stereo, 30), null)
  stereo.data[0].fill(NaN, 29 * 8000)
  assert.equal(await findTrailingSilence(stereo, 30), null)
})

test('unknown, inconsistent or oversized PCM never produces a skip point', async () => {
  const buffer = pcm()
  for (const duration of [NaN, Infinity, 30.101, 0]) assert.equal(await findTrailingSilence(buffer, duration), null)
  assert.equal(await findTrailingSilence({ ...buffer, length: 128 * 1024 ** 2 }, 30), null)
  assert.equal(await findTrailingSilence({ ...buffer, numberOfChannels: 0 }, 30), null)
  assert.equal(await findTrailingSilence({ ...buffer, duration: 30.05 }, 30.05), null)
  assert.equal(await findTrailingSilence({ ...buffer, sampleRate: 16000 }, 30), null)
  assert.equal(await findTrailingSilence({ ...buffer, getChannelData: () => new Float32Array(10) }, 30), null)
  const malformed = pcm({ silence: 30 })
  malformed.data[0][27 * 8000 - 1] = NaN
  assert.equal(await findTrailingSilence(malformed, 30), null, 'non-finite data cannot stand in for a preceding audible boundary')
})

test('large tail scans yield between bounded blocks and stop when the current song changes', async () => {
  let yields = 0, current = true
  const buffer = pcm({ duration: 300, channels: 2, silence: 15, sampleRate: 48000 })
  const result = await findTrailingSilence(buffer, 300, { isCurrent: () => current,
    yieldControl: async () => { yields++; current = false } })
  assert.equal(result, null)
  assert.equal(yields, 1)
})

test('analyzer obtains an exact leased source, decodes at the original rate and always releases it', async () => {
  const f = fixture()
  const result = await f.request({ hash: 'song-a', source: 'cloud', sourceUserId: 'owner-a' }, 'original')
  assert.equal(result.skipAt, 27.25)
  assert.equal(f.calls[0].purpose, 'analysis')
  assert.equal(f.calls[0].allowFallback, false)
  assert.equal(f.calls[0].sourceUserId, 'owner-a')
  assert.deepEqual(f.decodes, [[8000, 8]])
  assert.deepEqual(f.released, ['a'.repeat(48)])
  assert.equal(f.fetches[0][1].credentials, 'omit')
  f.analyzer.dispose()
})

test('unsupported, absent, online, over-budget and mismatched sources do not fetch or decode', async () => {
  for (const source of [null, { size: 65 * 1024 ** 2 }, { url: 'https://example.invalid/audio.wav' },
    { sha256: undefined }, { audioMetadata: null }, { audioMetadata: { duration: 30, channels: 2, sampleRate: 192000 } },
    { audioMetadata: { duration: 30.2, channels: 1, sampleRate: 8000 } }]) {
    const f = fixture(source === null ? { getSource: async () => null } : { source })
    assert.equal(await f.request(), null)
    assert.equal(f.fetches.length, 0)
    assert.equal(f.decodes.length, 0)
    assert.equal(f.released.length, source === null ? 0 : 1)
    f.analyzer.dispose()
  }
})

test('truncated, oversized, partial and misleading responses cannot reach the decoder', async () => {
  for (const response of [new Response(new Uint8Array(7)), new Response(new Uint8Array(9)),
    new Response(new Uint8Array(8), { status: 206 }),
    new Response(new Uint8Array(8), { headers: { 'content-length': '999' } })]) {
    const f = fixture({ fetch: async () => response })
    assert.equal(await f.request(), null)
    assert.equal(f.decodes.length, 0)
    assert.equal(f.released.length, 1)
    f.analyzer.dispose()
  }
})

test('late acquired leases are released after cancellation, without starting a fetch', async () => {
  const acquired = deferred()
  const f = fixture({ getSource: () => acquired.promise })
  const pending = f.request()
  await tick()
  f.analyzer.cancel()
  assert.equal(await pending, null)
  acquired.resolve(f.apiSource)
  await tick()
  assert.equal(f.fetches.length, 0)
  assert.equal(f.released.length, 1)
})

test('native decodes stay serial across replacement requests and their stale results are ignored', async () => {
  const first = deferred()
  let count = 0
  const f = fixture({ decode: () => ++count === 1 ? first.promise : pcm() })
  const pending = f.request()
  await tick()
  assert.equal(f.decodes.length, 1)
  const latest = f.request({ hash: 'song-b' })
  assert.equal(await pending, null)
  await tick()
  assert.equal(f.decodes.length, 1)
  first.resolve(pcm())
  assert.equal((await latest).skipAt, 27.25)
  assert.equal(f.decodes.length, 2)
  assert.equal(f.released.length, 2)
  f.analyzer.dispose()
})

test('thousands of rapid cancellations retain only the latest identity behind a native decode', async () => {
  const stalled = deferred()
  let count = 0
  const f = fixture({ timeoutMs: 5000, decode: () => ++count === 1 ? stalled.promise : pcm() })
  const first = f.request()
  await tick()
  const requests = []
  for (let index = 0; index < 2000; index++) {
    requests.push(f.request({ hash: `song-${index}`, get unrelatedLargeMetadata() { throw new Error('must not retain full song objects') } }))
  }
  assert.equal(await first, null)
  assert.ok((await Promise.all(requests.slice(0, -1))).every(result => result === null))
  assert.equal(f.calls.length, 1)
  assert.equal(f.decodes.length, 1)
  stalled.resolve(pcm())
  assert.equal((await requests.at(-1)).skipAt, 27.25)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].hash, 'song-1999')
  assert.equal(f.decodes.length, 2)
  assert.equal(f.released.length, 2)
  f.analyzer.dispose()
})

test('a canceled decode must settle and release its lease before the next source is acquired', async () => {
  const native = deferred(), release = deferred()
  let decodes = 0, releases = 0
  const f = fixture({ decode: () => ++decodes === 1 ? native.promise : pcm(),
    release: () => ++releases === 1 ? release.promise : Promise.resolve() })
  const first = f.request()
  await tick()
  const latest = f.request({ hash: 'song-b' })
  assert.equal(await first, null)
  assert.equal(f.released.length, 0)
  native.resolve(pcm())
  await tick()
  assert.equal(f.released.length, 1)
  assert.equal(f.calls.length, 1, 'cleanup remains serialized while the lease release is in flight')
  release.resolve()
  assert.equal((await latest).skipAt, 27.25)
  assert.equal(f.calls.length, 2)
  assert.equal(f.released.length, 2)
  f.analyzer.dispose()
})

test('timeouts during acquisition and native rejection release late leases without resurrecting pending work', async () => {
  const acquired = deferred()
  const f = fixture({ timeoutMs: 10, getSource: () => acquired.promise })
  assert.equal(await f.request(), null)
  assert.equal(f.released.length, 0)
  acquired.resolve(f.apiSource)
  await tick()
  assert.equal(f.released.length, 1)
  assert.equal(f.decodes.length, 0)
  f.analyzer.dispose()

  const native = deferred()
  const failure = fixture({ decode: async () => { await native.promise; throw new Error('late native failure') } })
  const pending = failure.request()
  await tick()
  failure.analyzer.dispose()
  assert.equal(await pending, null)
  assert.equal(failure.released.length, 0)
  native.resolve()
  await tick()
  assert.equal(failure.released.length, 1)
  assert.equal(failure.errors.length, 0, 'an obsolete native rejection is handled without a late error notification')
})

test('native decoder sample rate and channel count must match the resource metadata', async () => {
  for (const decoded of [pcm({ sampleRate: 16000 }), pcm({ channels: 2 }), { ...pcm(), duration: 30.05 }]) {
    const f = fixture({ decode: async () => decoded })
    assert.equal(await f.request(), null)
    assert.equal(f.released.length, 1)
    f.analyzer.dispose()
  }
})

test('decode failure, timeout and disposal return null and preserve lease cleanup', async () => {
  const failure = fixture({ decode: async () => { throw new Error('unsupported codec') } })
  assert.equal(await failure.request(), null)
  assert.equal(failure.errors.length, 1)
  assert.equal(failure.released.length, 1)
  const stalled = deferred()
  const timeout = fixture({ timeoutMs: 10, decode: () => stalled.promise })
  assert.equal(await timeout.request(), null)
  timeout.analyzer.dispose()
  stalled.resolve(pcm())
  await tick()
  assert.equal(timeout.released.length, 1)
  assert.equal(await timeout.request(), null)
})

test('memory results are reused only for the same account, content and playback quality', async () => {
  const f = fixture()
  const first = await f.request()
  first.skipAt = 0
  assert.equal((await f.request()).skipAt, 27.25)
  assert.equal(f.decodes.length, 1)
  await f.request({ hash: 'song-a' }, '320')
  await f.request({ hash: 'song-a' }, '320', 30, 2)
  f.apiSource.sha256 = 'c'.repeat(64)
  await f.request({ hash: 'song-a' }, '320', 30, 2)
  assert.equal(f.decodes.length, 4)
  assert.equal(f.released.length, 5)
  f.analyzer.dispose()
})

test('the in-memory analysis cache evicts the oldest entry after thirty-two results', async () => {
  const f = fixture()
  for (let i = 0; i < 33; i++) await f.request({ hash: `song-${i}` })
  assert.equal(f.decodes.length, 33)
  await f.request({ hash: 'song-32' })
  assert.equal(f.decodes.length, 33)
  await f.request({ hash: 'song-0' })
  assert.equal(f.decodes.length, 34)
  f.analyzer.dispose()
})
