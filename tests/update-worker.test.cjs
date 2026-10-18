const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter, once } = require('node:events')
const { Readable, PassThrough, Writable } = require('node:stream')
const { Worker } = require('node:worker_threads')
const { parseVersion, compareVersions, selectAssets, createTransport, createUpdateEngine, attachWorker } = require('../electron/services/updateWorker.cjs')

const repository = 'FLC-Team/BetterKuGou'
const target = { currentVersion: '1.0.0', channel: 'stable', platform: 'win32', arch: 'x64' }
const packageBytes = Buffer.from('fixture installer content')
const packageDigest = `sha256:${crypto.createHash('sha256').update(packageBytes).digest('hex')}`

function rawRelease(version = '1.1.0', changes = {}) {
  const tag = `v${version}`
  const name = `BetterKuGou-v${version}-setup.exe`
  return {
    id: 51, tag_name: tag, name: version, draft: false, prerelease: false, body: 'Release notes', published_at: '2026-10-16T00:00:00Z',
    assets: [{ id: 71, name, size: packageBytes.length, digest: packageDigest, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` }],
    ...changes
  }
}

function normalizedPackage(version = '1.1.0') {
  const raw = rawRelease(version)
  return { release: { id: raw.id, version, tag: raw.tag_name }, asset: { id: raw.assets[0].id, name: raw.assets[0].name, size: raw.assets[0].size, url: raw.assets[0].browser_download_url, digest: packageDigest, format: 'exe' } }
}

/** 控制传输而保留真实 Node 流、文件系统和哈希流程，完全不访问外网。 */
function requestFixture(handler) {
  const calls = []
  function request(url, options, callback) {
    const req = new EventEmitter()
    req.setTimeout = () => {}
    req.destroy = error => {
      if (req.destroyed) return
      req.destroyed = true
      if (error) queueMicrotask(() => req.emit('error', error))
    }
    req.end = () => queueMicrotask(async () => {
      calls.push({ url: String(url), options })
      try {
        const config = await handler(String(url), calls.length)
        if (req.destroyed || config?.hang) return
        if (config?.error) { req.emit('error', config.error); return }
        const body = config?.body ?? ''
        const response = config?.stream ?? Readable.from(Array.isArray(body) ? body : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
        response.statusCode = config?.status ?? 200
        response.headers = config?.headers ?? { 'content-type': 'application/json' }
        callback(response)
      } catch (error) { req.emit('error', error) }
    })
    return req
  }
  return { request, calls }
}

function jsonResponse(value) { return { body: JSON.stringify(value) } }

function createEngine(t, handler, options = {}) {
  const toolsRoot = path.resolve(__dirname, '../.agent/tools')
  fs.mkdirSync(toolsRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(toolsRoot, 'update-worker-test-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), toolsRoot)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const fixture = requestFixture(handler)
  return { engine: createUpdateEngine({ downloadRoot: directory, request: fixture.request, ...options }), directory, ...fixture }
}

test('SemVer compares numeric components, prereleases, build metadata and rejects malformed versions', () => {
  assert.equal(parseVersion('v0.1.6-alpha-pre1').version, '0.1.6-alpha-pre1')
  for (const bad of ['1.2', '01.2.3', '1.2.3-01', '1.2.3-', 'vbad', null]) assert.equal(parseVersion(bad), null)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3-beta.10'), 1)
  assert.equal(compareVersions('1.2.3-beta.10', '1.2.3-beta.2'), 1)
  assert.equal(compareVersions('1.2.3-2', '1.2.3-alpha'), -1)
  assert.equal(compareVersions('1.2.3-alpha', '1.2.3-alpha.1'), -1)
  assert.equal(compareVersions('1.2.3+one', '1.2.3+two'), 0)
  assert.equal(compareVersions('999999999999999999.0.0', '999999999999999998.0.0'), 1)
})

test('asset matching keeps Windows universal setup and strictly matches macOS/Linux architectures', () => {
  const assets = [
    { id: 1, name: 'BetterKuGou-v1.0.0-setup.exe', format: 'exe' },
    { id: 2, name: 'BetterKuGou-1.0.0-arm64.dmg', format: 'dmg' },
    { id: 3, name: 'BetterKuGou-1.0.0.dmg', format: 'dmg' },
    { id: 4, name: 'BetterKuGou-1.0.0.AppImage', format: 'AppImage' },
    { id: 5, name: 'betterkugou_1.0.0_amd64.deb', format: 'deb' },
    { id: 6, name: 'betterkugou-1.0.0.aarch64.rpm', format: 'rpm' },
    { id: 7, name: 'BetterKuGou-1.0.0-arm64.AppImage', format: 'AppImage' },
    { id: 8, name: 'BetterKuGou-1.0.0-riscv64.AppImage', format: 'AppImage' }
  ]
  assert.deepEqual(selectAssets(assets, { platform: 'win32', arch: 'arm64' }).map(a => a.id), [1])
  assert.deepEqual(selectAssets(assets, { platform: 'darwin', arch: 'arm64' }).map(a => a.id), [2])
  assert.deepEqual(selectAssets(assets, { platform: 'darwin', arch: 'x64', releaseVersion: '1.0.0' }).map(a => a.id), [3])
  assert.deepEqual(selectAssets(assets, { platform: 'linux', arch: 'x64', releaseVersion: '1.0.0' }).map(a => a.id), [4, 5])
  assert.deepEqual(selectAssets(assets, { platform: 'linux', arch: 'arm64' }).map(a => a.id), [7, 6])
  assert.deepEqual(selectAssets(assets, { platform: 'linux', arch: 'ia32' }), [])
})

test('check uses the fixed proxy first, sorts versions and excludes draft and tag prereleases on stable', async t => {
  const { engine, calls } = createEngine(t, () => jsonResponse([
    rawRelease('1.9.0'), rawRelease('1.10.0'), rawRelease('3.0.0', { draft: true }), rawRelease('4.0.0-beta.1'), rawRelease('5.0.0', { prerelease: true }), rawRelease('nightly')
  ]), { now: () => Date.parse('2026-10-17T00:00:00Z') })
  const result = await engine.check(target)
  assert.equal(result.release.version, '1.10.0')
  assert.equal(result.release.defaultAssetId, 71)
  assert.equal(result.release.assets[0].digest, packageDigest)
  assert.equal(result.checkedAt, '2026-10-17T00:00:00.000Z')
  assert.equal(result.source, 'proxy')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^https:\/\/git\.tangbai\.cc\/https:\/\/api\.github\.com\/repos\/FLC-Team\/BetterKuGou\/releases\?per_page=100&page=1$/)
  assert.equal((await engine.check({ ...target, channel: 'beta' })).release.version, '5.0.0')
})

test('check paginates before choosing latest instead of trusting release publication order', async t => {
  const firstPage = Array.from({ length: 100 }, (_, index) => rawRelease('0.9.0', { id: index + 1 }))
  const { engine, calls } = createEngine(t, url => jsonResponse(url.endsWith('page=1') ? firstPage : [rawRelease('2.0.0')]))
  const result = await engine.check(target)
  assert.equal(result.release.version, '2.0.0')
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /page=2$/)
})

test('current/newer installed version yields no update; absent channel releases remain distinguishable', async t => {
  const { engine } = createEngine(t, () => jsonResponse([rawRelease('1.0.0')]))
  const current = await engine.check(target)
  assert.deepEqual(current, { release: null, hasReleases: true, latestVersion: '1.0.0', source: 'proxy', checkedAt: current.checkedAt })
  assert.equal((await engine.check({ ...target, currentVersion: '2.0.0' })).release, null)
  const empty = createEngine(t, () => jsonResponse([]))
  const noRelease = await empty.engine.check(target)
  assert.equal(noRelease.hasReleases, false)
  assert.equal(noRelease.latestVersion, null)
  const noAssets = createEngine(t, () => jsonResponse([rawRelease('2.0.0')]))
  assert.deepEqual((await noAssets.engine.check({ ...target, platform: 'darwin', arch: 'arm64' })).release.assets, [])
})

for (const failure of [
  { name: 'HTML', response: { headers: { 'content-type': 'text/html' }, body: '<html>Proxy failure</html>' } },
  { name: 'invalid JSON', response: { body: '{' } },
  { name: 'invalid schema', response: jsonResponse({ message: 'error' }) },
  { name: 'HTTP 403', response: { status: 403 } },
  { name: 'network failure', response: { error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) } }
]) {
  test(`metadata ${failure.name} falls back to GitHub with the same repository`, async t => {
    const { engine, calls } = createEngine(t, url => url.startsWith('https://git.tangbai.cc/') ? failure.response : jsonResponse([rawRelease()]))
    const result = await engine.check(target)
    assert.equal(result.source, 'github')
    assert.equal(calls.length, 2)
    assert.match(calls[1].url, /^https:\/\/api\.github\.com\/repos\/FLC-Team\/BetterKuGou\//)
  })
}

test('metadata size and request timeout are bounded, with cancellation bypassing fallback', async t => {
  const large = createEngine(t, url => url.startsWith('https://git.tangbai.cc/') ? { body: Buffer.alloc(8 * 1024 * 1024 + 1) } : jsonResponse([]))
  assert.equal((await large.engine.check(target)).source, 'github')
  const timed = createEngine(t, () => ({ hang: true }), { metadataTimeout: 15 })
  await assert.rejects(timed.engine.check(target), { code: 'TIMEOUT' })
  assert.equal(timed.calls.length, 2)
  const abort = new AbortController()
  const pending = createEngine(t, () => ({ hang: true }))
  const running = pending.engine.check(target, { signal: abort.signal })
  await new Promise(resolve => setImmediate(resolve))
  abort.abort()
  await assert.rejects(running, { code: 'CANCELLED' })
  assert.equal(pending.calls.length, 1)
})

test('HTTPS redirects follow approved hosts and reject insecure, unknown and looping destinations', async () => {
  const approved = requestFixture((_url, index) => index === 1
    ? { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }
    : { headers: { 'content-type': 'application/octet-stream' }, body: packageBytes })
  const response = await createTransport({ request: approved.request }).open('https://github.com/FLC-Team/BetterKuGou/releases')
  const chunks = []
  for await (const chunk of response) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), packageBytes)
  for (const location of ['http://github.com/fixture', 'https://untrusted.example/fixture', 'https://github.com:444/fixture']) {
    const bad = requestFixture(() => ({ status: 302, headers: { location } }))
    await assert.rejects(createTransport({ request: bad.request }).open('https://github.com/fixture'), { code: 'NETWORK' })
  }
  const loop = requestFixture(() => ({ status: 302, headers: { location: '/loop' } }))
  await assert.rejects(createTransport({ request: loop.request }).open('https://github.com/fixture'), { code: 'NETWORK' })
  assert.equal(loop.calls.length, 6)
})

test('downloads stream to a dedicated file, verify SHA256 and reuse intact cache without network', async t => {
  const { engine, directory, calls } = createEngine(t, () => ({ headers: { 'content-type': 'application/octet-stream', 'content-length': String(packageBytes.length) }, body: [packageBytes.subarray(0, 5), packageBytes.subarray(5)] }))
  const progress = []
  const record = await engine.download(normalizedPackage(), { onProgress: value => progress.push(value) })
  assert.equal(path.dirname(record.path), directory)
  assert.equal(record.source, 'proxy')
  assert.equal(record.digest, packageDigest)
  assert.equal(record.format, 'exe')
  assert.deepEqual(fs.readFileSync(record.path), packageBytes)
  assert.equal(progress[0].percent, 0)
  assert.equal(progress.at(-1).percent, 100)
  assert.deepEqual(await engine.verify({ file: record }), record)
  assert.equal((await engine.download(normalizedPackage())).source, 'cache')
  assert.equal(calls.length, 1)
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.part')).length, 0)
})

for (const failure of [
  { name: 'network', response: { error: new Error('connection reset') } },
  { name: 'HTML payload', response: { headers: { 'content-type': 'text/html' }, body: packageBytes } },
  { name: 'content length', response: { headers: { 'content-length': '999' }, body: packageBytes } },
  { name: 'truncated stream', response: { headers: {}, body: packageBytes.subarray(0, 4) } },
  { name: 'wrong hash', response: { headers: {}, body: Buffer.alloc(packageBytes.length, 3) } }
]) {
  test(`download ${failure.name} retries from scratch on GitHub and removes temporary files`, async t => {
    const { engine, calls, directory } = createEngine(t, url => url.startsWith('https://git.tangbai.cc/') ? failure.response : { headers: {}, body: packageBytes })
    const record = await engine.download(normalizedPackage())
    assert.equal(record.source, 'github')
    assert.equal(calls.length, 2)
    assert.deepEqual(fs.readFileSync(record.path), packageBytes)
    assert.equal(fs.readdirSync(directory).length, 1)
  })
}

test('corrupt cached files are rejected by verify and safely replaced by a fresh validated download', async t => {
  const { engine, calls } = createEngine(t, () => ({ headers: {}, body: packageBytes }))
  const record = await engine.download(normalizedPackage())
  fs.writeFileSync(record.path, Buffer.alloc(packageBytes.length, 9))
  await assert.rejects(engine.verify({ file: record }), { code: 'HASH_MISMATCH' })
  assert.equal((await engine.download(normalizedPackage())).source, 'proxy')
  assert.equal(calls.length, 2)
  fs.truncateSync(record.path, 1)
  await assert.rejects(engine.verify({ file: record }), { code: 'SIZE_MISMATCH' })
  fs.unlinkSync(record.path)
  await assert.rejects(engine.verify({ file: record }), { code: 'DISK_ERROR' })
})

test('missing release digest still computes a hash but never reuses an unchecked same-size cache', async t => {
  const { engine, calls } = createEngine(t, () => ({ headers: {}, body: packageBytes }))
  const payload = normalizedPackage()
  payload.asset.digest = null
  const record = await engine.download(payload)
  assert.equal(record.digest, packageDigest)
  await engine.download(payload)
  assert.equal(calls.length, 2)
})

test('cancellation stops a partial download without trying GitHub and cleans the partial file', async t => {
  const response = new PassThrough()
  let writes = 0
  const fsApi = { ...fs, createWriteStream(...arguments_) {
    writes += 1
    return fs.createWriteStream(...arguments_)
  } }
  const { engine, calls, directory } = createEngine(t, () => ({ headers: {}, stream: response }), { fsApi })
  const abort = new AbortController()
  const running = engine.download(normalizedPackage(), { signal: abort.signal, onProgress: () => { abort.abort() } })
  await assert.rejects(running, { code: 'CANCELLED' })
  assert.equal(calls.length, 1)
  assert.equal(writes, 0, 'a cancelled initial progress callback must not start writing a file')
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('cancellation waits for a pending file open to close before removing its partial file', async t => {
  const response = new PassThrough()
  const abort = new AbortController()
  let releaseOpen
  let output
  let reportOpen
  let cleanupBeforeClose = false
  const opened = new Promise(resolve => { reportOpen = resolve })
  const delayedFs = { ...fs, createWriteStream(filename, options) {
    output = fs.createWriteStream(filename, { ...options, fs: { ...fs, open(...arguments_) {
      releaseOpen = () => fs.open(...arguments_)
      reportOpen()
    } } })
    return output
  }, promises: { ...fs.promises, async unlink(filename) {
    if (filename.endsWith('.part') && !output.closed) {
      cleanupBeforeClose = true
      throw Object.assign(new Error('file has not opened yet'), { code: 'ENOENT' })
    }
    return fs.promises.unlink(filename)
  } } }
  const { engine, calls, directory } = createEngine(t, () => ({ headers: {}, stream: response }), { fsApi: delayedFs })
  let settled = false
  const running = engine.download(normalizedPackage(), { signal: abort.signal }).then(
    () => { settled = true; assert.fail('cancelled download must reject') },
    error => { settled = true; return error }
  )
  await opened
  abort.abort()
  // Drain the abort's stream callbacks while the actual file open is held.
  await new Promise(resolve => setImmediate(resolve))
  const settledBeforeOpen = settled
  releaseOpen()
  const error = await running
  if (!output.closed) await new Promise(resolve => output.once('close', resolve))
  assert.equal(error.code, 'CANCELLED')
  assert.equal(settledBeforeOpen, false, 'cancellation must await the pending file handle')
  assert.equal(cleanupBeforeClose, false, 'the file must close before unlink')
  assert.equal(calls.length, 1)
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('disk write failures never switch download source', async t => {
  const failingFs = { ...fs, createWriteStream() {
    return new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('permission denied'), { code: 'EACCES' })) } })
  } }
  const { engine, calls, directory } = createEngine(t, () => ({ headers: {}, body: packageBytes }), { fsApi: failingFs })
  await assert.rejects(engine.download(normalizedPackage()), { code: 'DISK_ERROR' })
  assert.equal(calls.length, 1)
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('disk cache read errors fail before downloading rather than switching sources', async t => {
  const failingFs = { ...fs, promises: { ...fs.promises, async lstat(filename) {
    if (filename.endsWith('.exe')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return fs.promises.lstat(filename)
  } } }
  const { engine, calls } = createEngine(t, () => ({ headers: {}, body: packageBytes }), { fsApi: failingFs })
  await assert.rejects(engine.download(normalizedPackage()), { code: 'DISK_ERROR' })
  assert.equal(calls.length, 0)
})

test('mid-stream errors and total download timeout both discard partial bytes before fallback', async t => {
  for (const kind of ['disconnect', 'timeout']) {
    const { engine, calls, directory } = createEngine(t, url => {
      if (!url.startsWith('https://git.tangbai.cc/')) return { headers: {}, body: packageBytes }
      if (kind === 'timeout') return { headers: {}, stream: new PassThrough() }
      return { headers: {}, stream: Readable.from((async function * () {
        yield Buffer.from('partial')
        throw Object.assign(new Error('connection reset while reading'), { code: 'ECONNRESET' })
      })()) }
    }, { downloadTimeout: 15 })
    const record = await engine.download(normalizedPackage())
    assert.equal(record.source, 'github')
    assert.equal(calls.length, 2)
    assert.deepEqual(fs.readFileSync(record.path), packageBytes)
    assert.equal(fs.readdirSync(directory).length, 1)
  }
})

test('both invalid downloads fail with integrity error and leave no runnable or partial package', async t => {
  const { engine, calls, directory } = createEngine(t, () => ({ headers: {}, body: Buffer.alloc(packageBytes.length, 8) }))
  await assert.rejects(engine.download(normalizedPackage()), { code: 'HASH_MISMATCH' })
  assert.equal(calls.length, 2)
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('progress messages are throttled during chunk streaming and end with verified completion', async t => {
  let clock = 0
  const chunks = Array.from(packageBytes, byte => Buffer.from([byte]))
  const { engine } = createEngine(t, () => ({ headers: {}, body: chunks }), { now: () => { clock += 100; return clock } })
  const progress = []
  await engine.download(normalizedPackage(), { onProgress: event => progress.push(event) })
  assert.equal(progress[0].received, 0)
  assert.equal(progress.at(-1).received, packageBytes.length)
  assert.equal(progress.at(-1).percent, 100)
  assert.ok(progress.length < chunks.length)
  assert.ok(progress.every(event => event.source === 'proxy' && event.total === packageBytes.length))
})

test('worker rejects arbitrary repository URLs, file names and verify paths before network or access', async t => {
  const { engine, calls } = createEngine(t, () => { throw new Error('must not request') })
  for (const changes of [{ url: 'https://evil.example/file.exe' }, { name: '../escape-setup.exe' }, { url: 'https://github.com/other/repo/releases/download/v1.1.0/file-setup.exe' }]) {
    const payload = normalizedPackage()
    Object.assign(payload.asset, changes)
    await assert.rejects(engine.download(payload), { code: 'INVALID_INPUT' })
  }
  await assert.rejects(engine.verify({ file: { path: path.resolve(__dirname, '../package.json'), size: 1, digest: packageDigest } }), { code: 'INVALID_PATH' })
  assert.equal(calls.length, 0)
})

test('worker serializes commands while cancel interrupts immediately and retains request identities', async () => {
  const port = new EventEmitter()
  const messages = []
  port.postMessage = message => { messages.push(message); port.emit('posted', message) }
  port.close = () => { port.closed = true; port.emit('closed') }
  const starts = []
  const engine = { check(payload, { signal, onProgress }) {
    starts.push(payload.id)
    if (payload.id === 1) return new Promise((_resolve, reject) => {
      onProgress({ received: 1, total: 10, percent: 10, source: 'proxy' })
      signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), 10), { once: true })
    })
    return Promise.resolve({ release: null })
  } }
  attachWorker(port, engine)
  const firstProgress = once(port, 'posted')
  port.emit('message', { id: 1, action: 'check' })
  await firstProgress
  port.emit('message', { id: 10, action: 'cancel', targetId: 999 })
  assert.equal(messages.at(-1).result.cancelled, false)
  port.emit('message', { id: 11, action: 'cancel', targetId: 1 })
  port.emit('message', { id: 2, action: 'check' })
  const closed = once(port, 'closed')
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(starts, [1, 2])
  assert.ok(messages.some(message => message.id === 1 && message.error?.code === 'CANCELLED'))
  assert.ok(messages.some(message => message.id === 2 && message.type === 'result'))
  port.emit('message', { id: 12, action: 'stop' })
  await closed
  assert.equal(port.closed, true)
})

test('worker stop aborts the running task, rejects queued work and closes the port after cleanup', async () => {
  const port = new EventEmitter()
  const messages = []
  port.postMessage = message => messages.push(message)
  port.close = () => port.emit('closed')
  let started
  const ready = new Promise(resolve => { started = resolve })
  const starts = []
  attachWorker(port, { async check(payload, { signal }) {
    starts.push(payload.id)
    started()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true }))
  } })
  port.emit('message', { id: 1, action: 'check' })
  await ready
  port.emit('message', { id: 2, action: 'check' })
  const closed = once(port, 'closed')
  port.emit('message', { id: 3, action: 'stop' })
  await closed
  assert.deepEqual(starts, [1])
  assert.ok(messages.some(message => message.id === 1 && message.error?.code === 'CANCELLED'))
  assert.ok(messages.some(message => message.id === 2 && message.error?.code === 'CANCELLED'))
  assert.ok(messages.some(message => message.id === 3 && message.result?.stopped))
})

test('rapid channel changes cancel queued commands while previous cancellation is still releasing IO', async () => {
  const port = new EventEmitter()
  const messages = []
  port.postMessage = message => { messages.push(message); port.emit('posted', message) }
  port.close = () => port.emit('closed')
  const starts = []
  attachWorker(port, { check(payload, { signal, onProgress }) {
    starts.push(payload.id)
    if (payload.id === 1) return new Promise((_resolve, reject) => {
      onProgress({ received: 0, total: 1, percent: 0, source: 'proxy' })
      signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), 15), { once: true })
    })
    return Promise.resolve({ release: null })
  } })
  const ready = once(port, 'posted')
  port.emit('message', { id: 1, action: 'check' })
  await ready
  port.emit('message', { id: 101, action: 'cancel', targetId: 1 })
  port.emit('message', { id: 2, action: 'check' })
  port.emit('message', { id: 102, action: 'cancel', targetId: 2 })
  assert.equal(messages.at(-1).result.cancelled, true)
  port.emit('message', { id: 3, action: 'check' })
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.deepEqual(starts, [1, 3])
  assert.ok(messages.some(message => message.id === 2 && message.error?.code === 'CANCELLED'))
  assert.ok(messages.some(message => message.id === 3 && message.type === 'result'))
  const closed = once(port, 'closed')
  port.emit('message', { id: 103, action: 'stop' })
  await closed
})

test('real Node Worker starts without Electron or injected URL and stops using the agreed protocol', async t => {
  const { directory } = createEngine(t, () => { throw new Error('unused') })
  const worker = new Worker(path.resolve(__dirname, '../electron/services/updateWorker.cjs'), { workerData: { downloadRoot: directory, source: 'https://untrusted.example/' } })
  t.after(async () => { await worker.terminate() })
  worker.postMessage({ id: 1, action: 'unknown' })
  const [error] = await once(worker, 'message')
  assert.equal(error.id, 1)
  assert.equal(error.error.code, 'INVALID_INPUT')
  const exited = once(worker, 'exit')
  worker.postMessage({ id: 2, action: 'stop' })
  const [result] = await once(worker, 'message')
  assert.equal(result.result.stopped, true)
  const [exitCode] = await exited
  assert.equal(exitCode, 0)
})
