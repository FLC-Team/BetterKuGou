const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/utils/listeningHistory.js'), 'utf8').replace(/^export /gm, '')
const { createListeningHistory } = vm.runInNewContext(`${source}; ({createListeningHistory})`, { AbortController })
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(upload) {
  let clock = 0, position = 0, enabled = true, identity = { userId: 'A', token: 'placeholder' }
  const requests = [], timers = new Map(), failures = []
  let timerId = 0
  const tracker = createListeningHistory({ getIdentity: () => identity, isEnabled: () => enabled,
    now: () => clock, unixTime: () => 1700000000, onFailure: value => failures.push(value),
    upload: async (song, options) => { requests.push({ song, options }); return upload?.(requests.length) },
    setTimer: callback => { timers.set(++timerId, callback); return timerId }, clearTimer: id => timers.delete(id),
  })
  const sample = (extra = {}) => tracker.sample({ position, duration: 180, playing: true, ready: true, ...extra })
  return { tracker, requests, timers, failures, sample,
    begin(song = { album_audio_id: 9 }, options) { tracker.begin(song, options); sample() },
    advance(seconds = 1, extra = {}) { clock += seconds * 1000; position += seconds; sample(extra) },
    seek(value) { position = value; tracker.discontinuity(); sample() },
    setEnabled(value) { enabled = value; tracker.syncEnabled(); sample() }, setAccount(value) { identity = value },
    retry() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback() },
  }
}

test('only 30 seconds of real advancing playback qualify and each instance uploads once', async () => {
  const f = fixture()
  f.begin()
  for (let n = 0; n < 29; n++) f.advance()
  assert.equal(f.requests.length, 0)
  f.advance()
  await flush()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].options.time, 1700000000)
  assert.equal(f.requests[0].options.pc, 1)
  for (let n = 0; n < 40; n++) f.advance()
  assert.equal(f.requests.length, 1)
})

test('short songs qualify after half their duration while unknown durations require thirty seconds', () => {
  const short = fixture()
  short.begin()
  for (let n = 0; n < 9; n++) short.advance(1, { duration: 20 })
  assert.equal(short.requests.length, 0)
  short.advance(1, { duration: 20 })
  assert.equal(short.requests.length, 1)
  const unknown = fixture()
  unknown.begin()
  for (let n = 0; n < 29; n++) unknown.advance(1, { duration: NaN })
  assert.equal(unknown.requests.length, 0)
  unknown.advance(1, { duration: NaN })
  assert.equal(unknown.requests.length, 1)
})

test('pause, buffering, seeks and suspended clocks never create listening credit', () => {
  const f = fixture()
  f.begin()
  for (let n = 0; n < 10; n++) f.advance()
  for (let n = 0; n < 20; n++) f.advance(1, { playing: false })
  for (let n = 0; n < 20; n++) f.advance(1, { waiting: true })
  for (let n = 0; n < 20; n++) f.advance(1, { seeking: true })
  f.seek(170)
  f.advance(40)
  f.sample()
  for (let n = 0; n < 19; n++) f.advance()
  assert.equal(f.requests.length, 0)
  f.advance()
  assert.equal(f.requests.length, 1)
})

test('quality replacement and rollback preserve the instance but natural repeat starts fresh credit', () => {
  const f = fixture()
  f.begin()
  for (let n = 0; n < 20; n++) f.advance()
  f.begin({ album_audio_id: 9 }, { preserve: true })
  for (let n = 0; n < 10; n++) f.advance()
  assert.equal(f.requests.length, 1)
  f.begin({ album_audio_id: 9 })
  for (let n = 0; n < 29; n++) f.advance()
  assert.equal(f.requests.length, 1)
  f.advance()
  assert.equal(f.requests.length, 2)
})

test('transport retries are bounded, keep one original time, and stop on permanent errors', async () => {
  const f = fixture(() => { throw Object.assign(new Error('offline'), { code: 'ERR_NETWORK' }) })
  f.begin()
  for (let n = 0; n < 30; n++) f.advance()
  await flush()
  f.retry(); await flush()
  f.retry(); await flush()
  assert.equal(f.requests.length, 3)
  assert.equal(f.timers.size, 0)
  assert.ok(f.requests.every(request => request.options.time === 1700000000))
  assert.equal(f.failures.length, 1)
  const denied = fixture(() => { throw Object.assign(new Error('denied'), { code: 'LIBRARY_REQUEST_FAILED' }) })
  denied.begin()
  for (let n = 0; n < 30; n++) denied.advance()
  await flush()
  assert.equal(denied.timers.size, 0)
})

test('account changes, disabling, replacing songs and disposing discard old session retries', async () => {
  for (const change of [f => f.setAccount({ userId: 'B', token: 'placeholder-b' }), f => f.setEnabled(false)]) {
    const f = fixture(() => { throw Object.assign(new Error('offline'), { code: 'ERR_NETWORK' }) })
    f.begin()
    for (let n = 0; n < 30; n++) f.advance()
    await flush()
    change(f)
    if (f.timers.size) f.retry()
    await flush()
    assert.equal(f.requests.length, 1)
    assert.equal(f.requests[0].options.signal.aborted, true)
  }
  const f = fixture(() => { throw new Error('offline') })
  f.begin()
  for (let n = 0; n < 30; n++) f.advance()
  await flush()
  f.begin({ album_audio_id: 10 })
  assert.equal(f.timers.size, 0)
  assert.equal(f.requests[0].options.signal.aborted, true)
  f.tracker.dispose()
  for (let n = 0; n < 50; n++) f.advance()
  assert.equal(f.requests.length, 1)
})

test('anonymous users and cloud files without an owned catalogue ID never upload', () => {
  for (const song of [{ hash: 'only' }, { album_audio_id: 0 }, { album_audio_id: 9, source: 'cloud', sourceUserId: 'B' }]) {
    const f = fixture()
    f.begin(song)
    for (let n = 0; n < 50; n++) f.advance()
    assert.equal(f.requests.length, 0)
  }
})

test('disabling and re-enabling keeps a completed play instance deduplicated', async () => {
  const f = fixture()
  f.begin()
  for (let n = 0; n < 30; n++) f.advance()
  await flush()
  for (let cycle = 0; cycle < 2; cycle++) {
    f.setEnabled(false)
    for (let n = 0; n < 40; n++) f.advance()
    f.begin({ album_audio_id: 9 }, { preserve: true })
    f.setEnabled(true)
    for (let n = 0; n < 40; n++) f.advance()
  }
  assert.equal(f.requests.length, 1)
})

test('disabling cancels an in-flight upload and never resends its unknown result', async () => {
  for (const outcome of ['resolve', 'reject']) {
    let finish
    const pending = new Promise((resolve, reject) => { finish = outcome === 'resolve' ? resolve : reject })
    const f = fixture(() => pending)
    f.begin()
    for (let n = 0; n < 30; n++) f.advance()
    f.setEnabled(false)
    assert.equal(f.requests[0].options.signal.aborted, true)
    f.setEnabled(true)
    finish(Object.assign(new Error('cancelled transport'), { code: 'ERR_CANCELED' }))
    await flush()
    for (let n = 0; n < 40; n++) f.advance()
    assert.equal(f.requests.length, 1, outcome)
    assert.equal(f.timers.size, 0)
  }
})

test('disabling cancels queued retries and re-enabling does not restart an attempted upload', async () => {
  const f = fixture(() => { throw Object.assign(new Error('offline'), { code: 'ERR_NETWORK' }) })
  f.begin()
  for (let n = 0; n < 30; n++) f.advance()
  await flush()
  assert.equal(f.timers.size, 1)
  f.setEnabled(false)
  assert.equal(f.timers.size, 0)
  f.setEnabled(true)
  for (let n = 0; n < 40; n++) f.advance()
  assert.equal(f.requests.length, 1)
})

test('unqualified plays retain enabled listening credit without counting disabled time', () => {
  const f = fixture()
  f.begin()
  for (let n = 0; n < 20; n++) f.advance()
  f.setEnabled(false)
  for (let n = 0; n < 40; n++) f.advance()
  f.setEnabled(true)
  for (let n = 0; n < 9; n++) f.advance()
  assert.equal(f.requests.length, 0)
  f.advance()
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].options.signal.aborted, false)
})

test('a play that starts disabled can qualify after enabling, including a disabled source replacement', () => {
  const f = fixture()
  f.setEnabled(false)
  f.begin()
  for (let n = 0; n < 40; n++) f.advance()
  f.begin({ album_audio_id: 9 }, { preserve: true })
  f.setEnabled(true)
  for (let n = 0; n < 29; n++) f.advance()
  assert.equal(f.requests.length, 0)
  f.advance()
  assert.equal(f.requests.length, 1)
})

test('disabled play records still reset at account, stop and new-play boundaries', () => {
  const f = fixture()
  f.begin()
  for (let n = 0; n < 20; n++) f.advance()
  f.setEnabled(false)
  f.setAccount({ userId: 'B', token: 'placeholder-b' })
  f.setEnabled(true)
  for (let n = 0; n < 40; n++) f.advance()
  assert.equal(f.requests.length, 0)
  f.begin()
  for (let n = 0; n < 30; n++) f.advance()
  assert.equal(f.requests.length, 1)
  f.setEnabled(false)
  f.tracker.reset()
  f.setEnabled(true)
  for (let n = 0; n < 40; n++) f.advance()
  assert.equal(f.requests.length, 1)
  f.begin({ album_audio_id: 10 })
  for (let n = 0; n < 30; n++) f.advance()
  assert.equal(f.requests.length, 2)
})
