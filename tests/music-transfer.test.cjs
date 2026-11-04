const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { Readable } = require('node:stream')
const { EventEmitter } = require('node:events')

function mp3(fill) {
  const frame = Buffer.alloc(417, fill)
  Buffer.from([255, 251, 144, 100]).copy(frame)
  return Buffer.concat(Array.from({ length: 40 }, () => frame))
}

/** Keep real files and transfer/validation logic; replace only HTTP and selected filesystem failures. */
async function fixture(t, { etag = '"new"', ignoreRange = false } = {}) {
  const base = path.resolve(__dirname, '../.agent/tools')
  await fs.mkdir(base, { recursive: true })
  const directory = await fs.mkdtemp(path.join(base, 'music-transfer-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'audio.part')
  const checkpointFile = path.join(directory, 'checkpoint.json')
  const oldAudio = mp3(17), audio = etag === '"old"' ? oldAudio : mp3(34)
  const prefix = oldAudio.subarray(0, 4170)
  const originalCheckpoint = { etag: '"old"', total: oldAudio.length }
  await fs.writeFile(file, prefix)
  await fs.writeFile(checkpointFile, JSON.stringify(originalCheckpoint))
  const requests = [], responses = [], handles = [], faults = {}
  const http = {
    get(_url, options, callback) {
      const headers = options.headers
      requests.push(headers)
      const start = Number(headers.Range?.match(/^bytes=(\d+)-$/)?.[1] || 0)
      const append = !ignoreRange && start > 0 && headers['If-Range'] === etag
      const response = Readable.from([append ? audio.subarray(start) : audio])
      response.statusCode = append ? 206 : 200
      response.headers = { etag, 'content-length': String(audio.length - (append ? start : 0)),
        ...(append ? { 'content-range': `bytes ${start}-${audio.length - 1}/${audio.length}` } : {}) }
      responses.push(response)
      const request = new EventEmitter()
      request.setTimeout = () => {}
      queueMicrotask(() => callback(response))
      return request
    }
  }
  const failOnce = name => {
    if (!faults[name]) return
    const error = faults[name]
    delete faults[name]
    throw error
  }
  const filesystem = { ...fs, async open(target, mode, ...args) {
    if (target !== file || mode === 'r') return fs.open(target, mode, ...args)
    failOnce('open')
    const handle = await fs.open(target, mode, ...args)
    const record = { closed: false, synced: false }
    handles.push(record)
    return new Proxy(handle, { get(value, key) {
      if (key === 'sync') return async () => { failOnce('sync'); await handle.sync(); record.synced = true }
      if (key === 'close') return async () => { await handle.close(); record.closed = true; failOnce('close') }
      return typeof value[key] === 'function' ? value[key].bind(value) : value[key]
    } })
  } }
  const module = { exports: {} }
  vm.runInNewContext(readFileSync(path.join(__dirname, '../electron/services/musicTransfer.cjs'), 'utf8'), {
    module, Buffer, URL,
    require(name) {
      if (name === 'node:http') return http
      if (name === 'node:fs/promises') return filesystem
      return require(name)
    }
  })
  const checkpoint = async () => JSON.parse(await fs.readFile(checkpointFile, 'utf8'))
  const saveCheckpoint = value => fs.writeFile(checkpointFile, JSON.stringify(value))
  async function transfer(onCheckpoint = saveCheckpoint) {
    return module.exports.transferFile('http://127.0.0.1/audio', file,
      { allowLocalTestUrls: true, checkpoint: await checkpoint(), onCheckpoint })
  }
  return { file, prefix, audio, originalCheckpoint, requests, responses, handles, faults,
    checkpoint, saveCheckpoint, transfer }
}

test('a failed replacement open preserves the old resume identity and retry never mixes audio', async t => {
  const f = await fixture(t)
  f.faults.open = Object.assign(new Error('file temporarily busy'), { code: 'EACCES' })
  await assert.rejects(f.transfer(), { code: 'EACCES' })
  assert.deepEqual(await f.checkpoint(), f.originalCheckpoint)
  assert.deepEqual(await fs.readFile(f.file), f.prefix)
  assert.equal(f.responses[0].destroyed, true)
  await f.transfer()
  assert.equal(f.requests[1]['If-Range'], '"old"')
  assert.deepEqual(await fs.readFile(f.file), f.audio)
})

for (const committed of [false, true]) {
  test(`checkpoint failure ${committed ? 'after' : 'before'} publication leaves an empty safe restart and releases resources`, async t => {
    const f = await fixture(t)
    await assert.rejects(f.transfer(async next => {
      if (committed) await f.saveCheckpoint(next)
      throw Object.assign(new Error('checkpoint failure'), { code: 'EIO' })
    }), { code: 'EIO' })
    assert.equal((await fs.stat(f.file)).size, 0)
    assert.equal(f.handles[0].synced, true)
    assert.equal(f.handles[0].closed, true)
    assert.equal(f.responses[0].destroyed, true)
    await f.transfer()
    assert.equal(f.requests[1].Range, undefined)
    assert.deepEqual(await fs.readFile(f.file), f.audio)
  })
}

test('failed truncation sync does not publish a new checkpoint or leave resources open', async t => {
  const f = await fixture(t)
  f.faults.sync = Object.assign(new Error('disk unavailable'), { code: 'EIO' })
  await assert.rejects(f.transfer(), { code: 'EIO' })
  assert.deepEqual(await f.checkpoint(), f.originalCheckpoint)
  assert.equal((await fs.stat(f.file)).size, 0)
  assert.equal(f.handles[0].closed, true)
  assert.equal(f.responses[0].destroyed, true)
  await f.transfer()
  assert.deepEqual(await fs.readFile(f.file), f.audio)
})

test('a file close error still destroys the response after checkpoint failure', async t => {
  const f = await fixture(t)
  f.faults.close = Object.assign(new Error('close failed'), { code: 'EIO' })
  await assert.rejects(f.transfer(async () => { throw new Error('checkpoint failed') }))
  assert.equal(f.handles[0].closed, true)
  assert.equal(f.responses[0].destroyed, true)
})

test('matching strong ETag resumes the existing prefix byte for byte', async t => {
  const f = await fixture(t, { etag: '"old"' })
  const result = await f.transfer()
  assert.equal(f.requests[0].Range, `bytes=${f.prefix.length}-`)
  assert.equal(f.responses[0].statusCode, 206)
  assert.equal(result.format, 'mp3')
  assert.equal(result.size, f.audio.length)
  assert.deepEqual(await fs.readFile(f.file), f.audio)
})

for (const ignoreRange of [false, true]) {
  test(`a full response ${ignoreRange ? 'ignoring Range' : 'with a changed ETag'} replaces the old prefix before publishing its identity`, async t => {
    const f = await fixture(t, { ignoreRange, etag: ignoreRange ? '"old"' : '"new"' })
    const result = await f.transfer(async next => {
      assert.equal((await fs.stat(f.file)).size, 0)
      assert.equal(f.handles[0].synced, true)
      await f.saveCheckpoint(next)
    })
    assert.equal(f.responses[0].statusCode, 200)
    assert.equal(result.size, f.audio.length)
    assert.deepEqual(await fs.readFile(f.file), f.audio)
  })
}
