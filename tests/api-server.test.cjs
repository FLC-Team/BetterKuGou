const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { constructServer } = require('../KuGouMusicApi/server')
const apiCache = require('../KuGouMusicApi/util/apicache')

async function createServer(t, handler, route = '/test') {
  const app = await constructServer([{ route, module: handler }])
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const key of [...apiCache.getIndex().all]) apiCache.clear(key)
    apiCache.clear()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}${route}`
}

test('POST body fields reach the API module and query fields retain their existing priority', async t => {
  let received
  const url = await createServer(t, async params => {
    received = params
    return { status: 200, headers: {}, body: { status: 1 }, cookie: [] }
  })
  const response = await fetch(url + '?mobile=query-mobile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile: 'body-mobile', password: 'placeholder-password', code: 'placeholder-code', album_audio_id: '1,2' })
  })
  assert.equal(response.status, 200)
  assert.equal(received.mobile, 'query-mobile')
  assert.equal(received.password, 'placeholder-password')
  assert.equal(received.code, 'placeholder-code')
  assert.equal(received.album_audio_id, '1,2')
  assert.equal(received.body.mobile, 'body-mobile')
})

test('POST requests and authenticated GET requests never share cached results', async t => {
  let calls = 0
  const url = await createServer(t, async params => ({
    status: 200, headers: {}, cookie: [], body: { count: ++calls, value: params.username || params.cookie?.token }
  }))
  for (const username of ['first-placeholder', 'second-placeholder']) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username })
    })
    assert.equal((await response.json()).value, username)
  }
  const first = await fetch(url, { headers: { Cookie: 'token=first-placeholder' } })
  const second = await fetch(url, { headers: { Cookie: 'token=second-placeholder' } })
  assert.equal((await first.json()).value, 'first-placeholder')
  assert.equal((await second.json()).value, 'second-placeholder')
  assert.equal(calls, 4)
})

test('public GET requests retain the existing short-lived cache', async t => {
  let calls = 0
  const url = await createServer(t, async () => ({
    status: 200, headers: {}, cookie: [], body: { count: ++calls }
  }))
  assert.equal((await (await fetch(url)).json()).count, 1)
  assert.equal((await (await fetch(url)).json()).count, 1)
  assert.equal(calls, 1)
})

function getWithBody(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const request = http.request(url, {
      method: 'GET', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, response => {
      let content = ''
      response.on('data', chunk => { content += chunk })
      response.on('end', () => resolve(JSON.parse(content)))
    })
    request.on('error', reject)
    request.end(data)
  })
}

test('GET bodies cannot populate a cache shared with other authenticated or anonymous requests', async t => {
  let calls = 0
  const url = await createServer(t, async params => ({
    status: 200, headers: {}, cookie: [], body: { count: ++calls, value: params.cookie?.token }
  }))
  assert.equal((await getWithBody(url, { cookie: { token: 'first-placeholder' } })).value, 'first-placeholder')
  assert.equal((await getWithBody(url, { cookie: { token: 'second-placeholder' } })).value, 'second-placeholder')
  assert.equal((await (await fetch(url)).json()).value, undefined)
  assert.equal(calls, 3)
})

test('private routes bypass caching with the same case-insensitive matching as Express', async t => {
  let calls = 0
  const url = await createServer(t, async () => ({
    status: 200, headers: {}, cookie: [], body: { count: ++calls }
  }), '/login/qr/key')
  const uppercase = url.replace('/login/qr/key', '/LOGIN/QR/KEY')
  assert.equal((await (await fetch(uppercase)).json()).count, 1)
  assert.equal((await (await fetch(uppercase)).json()).count, 2)
})

test('cached public responses preserve the CORS origin of each requesting renderer', async t => {
  let calls = 0
  const url = await createServer(t, async () => ({
    status: 200, headers: {}, cookie: [], body: { count: ++calls }
  }))
  for (const origin of ['http://first.example', 'http://second.example', 'http://first.example']) {
    const response = await fetch(url, { headers: { Origin: origin } })
    assert.equal(response.headers.get('access-control-allow-origin'), origin)
    await response.json()
  }
  assert.equal(calls, 2)
})

test('API error logs retain exception context while redacting query credentials and request configuration', async t => {
  const diagnostics = []
  const original = console.error
  console.error = (...args) => diagnostics.push(args)
  t.after(() => { console.error = original })
  const url = await createServer(t, async () => {
    const error = new Error('Request /login?token=message-placeholder&username=private-placeholder failed')
    error.code = 'ECONNRESET'
    error.config = { password: 'config-placeholder' }
    throw error
  })
  const response = await fetch(url + '?cookie=token%3Dcookie-placeholder%26userid%3Did-placeholder&accesskey=key-placeholder')
  assert.equal(response.status, 404)
  assert.equal(diagnostics.length, 1)
  const serialized = JSON.stringify(diagnostics)
  for (const secret of ['message-placeholder', 'private-placeholder', 'config-placeholder', 'cookie-placeholder', 'id-placeholder', 'key-placeholder']) {
    assert.equal(serialized.includes(secret), false, secret)
  }
  assert.equal(diagnostics[0][2].exception.code, 'ECONNRESET')
  assert.equal(diagnostics[0][2].exception.name, 'Error')
  assert.ok(diagnostics[0][2].exception.stack)
})

test('API startup reports a bind failure and exits with a failure code', async t => {
  const url = await createServer(t, async () => ({ status: 200, headers: {}, cookie: [], body: {} }))
  const port = new URL(url).port
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../KuGouMusicApi/app.js')], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: port, HOST: '127.0.0.1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Startup test timed out')) }, 5000)
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }) })
  })
  assert.equal(result.code, 1)
  assert.match(result.output, /API startup/)
  assert.match(result.output, /EADDRINUSE/)
})
