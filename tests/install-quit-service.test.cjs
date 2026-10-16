const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { once } = require('node:events')
const { createInstallQuitService } = require('../electron/services/installQuitService')

const quiet = Object.fromEntries(['trace', 'error'].map(name => [name, () => {}]))
const turn = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t, options = {}) {
  const notifications = []
  let quits = 0
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\BetterKuGou.InstallQuit.Test.${process.pid}.${randomUUID()}`
    : { host: '127.0.0.1', port: 0 }
  const service = createInstallQuitService({
    endpoint, logger: quiet, onPrepare: value => { notifications.push(value) },
    onQuit: () => { quits += 1 }, ...options
  })
  assert.equal(await service.start(), true)
  t.after(() => service.stop())
  async function client({ paused = false } = {}) {
    const address = service.getAddress()
    const socket = net.connect(typeof address === 'string' ? address : { host: '127.0.0.1', port: address.port })
    t.after(() => socket.destroy())
    const lines = [], waiters = []
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (waiters.length) waiters.shift()(line)
        else lines.push(line)
      }
    })
    if (paused) socket.pause()
    // Connections deliberately disappear in cancellation tests.
    socket.on('error', () => {})
    await once(socket, 'connect')
    const read = () => lines.length ? Promise.resolve(lines.shift()) : new Promise(resolve => waiters.push(resolve))
    const hello = async () => {
      socket.write('HELLO/1\n')
      assert.equal(await read(), 'READY/1')
    }
    return { socket, read, hello }
  }
  async function request() {
    const connection = await client()
    await connection.hello()
    const before = notifications.length
    connection.socket.write('QUIT/1\n')
    for (let i = 0; notifications.length === before && i < 100; i++) await turn()
    assert.equal(notifications.at(-1)?.phase, 'prepare')
    return { ...connection, requestId: notifications.at(-1).requestId }
  }
  return { service, notifications, client, request, quits: () => quits }
}

test('real local pipe probes do not prepare or quit; one successful save acknowledges before normal quit', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const probe = await f.client()
  await probe.hello()
  assert.equal(f.notifications.length, 0)
  probe.socket.end()
  const active = await f.request()
  assert.match(active.requestId, /^[a-f0-9-]{36}$/)
  assert.equal(f.service.complete(active.requestId, { success: true }), true)
  assert.equal(f.service.complete(active.requestId, { success: true }), false)
  assert.equal(await active.read(), 'SAVED/1')
  await turn()
  assert.equal(f.quits(), 1)
})

test('disconnect cancels the exact request and a late old acknowledgment cannot quit a newer request', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const old = await f.request()
  old.socket.destroy()
  for (let i = 0; f.notifications.at(-1)?.phase !== 'canceled' && i < 100; i++) await turn()
  assert.equal(f.notifications.at(-1).requestId, old.requestId)
  assert.equal(f.notifications.at(-1).phase, 'canceled')
  assert.equal(f.service.complete(old.requestId, { success: true }), false)
  const active = await f.request()
  assert.notEqual(active.requestId, old.requestId)
  assert.equal(f.service.complete(old.requestId, { success: true }), false)
  assert.equal(f.quits(), 0)
  assert.equal(f.service.complete(active.requestId, { success: true }), true)
  assert.equal(await active.read(), 'SAVED/1')
})

test('save failures use fixed codes, cancel rendering, and allow a fresh retry without quitting', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const first = await f.request()
  assert.equal(f.service.complete(first.requestId, { success: 'true' }), false)
  assert.equal(f.service.complete(first.requestId, { success: false, errorCode: 'private file path' }), true)
  assert.equal(await first.read(), 'FAIL/1 SAVE_FAILED')
  assert.equal(f.notifications.at(-1).phase, 'canceled')
  assert.equal(f.quits(), 0)
  const second = await f.request()
  assert.equal(f.service.cancel('RENDERER_CHANGED', second.requestId), true)
  assert.equal(await second.read(), 'FAIL/1 RENDERER_CHANGED')
  assert.equal(f.service.complete(second.requestId, { success: true }), false)
})

test('capability and prepare deadlines invalidate requests, including late successful saves', { timeout: 5000 }, async t => {
  const f = await fixture(t, { handshakeTimeoutMs: 40, prepareTimeoutMs: 40 })
  const silent = await f.client()
  assert.equal(await silent.read(), 'FAIL/1 TIMEOUT')
  const active = await f.request()
  assert.equal(await active.read(), 'FAIL/1 TIMEOUT')
  assert.equal(f.service.complete(active.requestId, { success: true }), false)
  assert.equal(f.notifications.at(-1).phase, 'canceled')
  assert.equal(f.quits(), 0)
})

test('malformed or unordered commands fail, and concurrent installers cannot replace a pending save', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const invalid = await f.client()
  invalid.socket.write('QUIT/1\n')
  assert.equal(await invalid.read(), 'FAIL/1 PROTOCOL')
  const oversized = await f.client()
  oversized.socket.write('X'.repeat(65))
  assert.equal(await oversized.read(), 'FAIL/1 PROTOCOL')
  const active = await f.request()
  const other = await f.client()
  await other.hello()
  other.socket.write('QUIT/1\n')
  assert.equal(await other.read(), 'FAIL/1 BUSY')
  assert.equal(f.notifications.filter(value => value.phase === 'prepare').length, 1)
  assert.equal(f.service.complete(active.requestId, { success: true }), true)
  assert.equal(await active.read(), 'SAVED/1')
})

test('shutdown is shared, cancels outstanding rendering, releases local listener and never waits for an ack', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  const address = f.service.getAddress()
  const active = await f.request()
  const first = f.service.stop()
  assert.equal(first, f.service.stop())
  await first
  assert.equal(f.service.complete(active.requestId, { success: true }), false)
  assert.equal(f.notifications.at(-1).errorCode, 'SHUTTING_DOWN')
  assert.equal(f.quits(), 0)
  const replacement = net.createServer()
  replacement.listen(typeof address === 'string' ? address : { host: '127.0.0.1', port: address.port })
  await once(replacement, 'listening')
  await new Promise(resolve => replacement.close(resolve))
})

test('a pipe conflict degrades safely and unavailable renderers fail without requesting quit', { timeout: 5000 }, async t => {
  const f = await fixture(t, { onPrepare: () => false })
  const active = await f.client()
  await active.hello()
  active.socket.write('QUIT/1\n')
  assert.equal(await active.read(), 'FAIL/1 RENDERER_UNAVAILABLE')
  assert.equal(f.quits(), 0)
  const address = f.service.getAddress()
  const duplicate = createInstallQuitService({
    endpoint: typeof address === 'string' ? address : { host: '127.0.0.1', port: address.port }, logger: quiet
  })
  assert.equal(await duplicate.start(), false)
  await duplicate.stop()
})

test('excess connections that never read cannot keep the listener alive during cleanup', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  for (let i = 0; i < 8; i++) {
    await f.client({ paused: true })
    await turn()
  }
  const address = f.service.getAddress()
  const excess = net.connect(typeof address === 'string' ? address : { host: '127.0.0.1', port: address.port })
  excess.pause()
  t.after(() => excess.destroy())
  await new Promise(resolve => { excess.once('connect', resolve); excess.on('error', resolve) })
  await turn()
  let deadline
  try {
    await Promise.race([
      f.service.stop(),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('listener cleanup waited on an excess client')), 1000) })
    ])
  } finally {
    clearTimeout(deadline)
  }
  assert.equal(f.quits(), 0)
})
