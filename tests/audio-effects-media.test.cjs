const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createAudioEffectsMedia } = require('../electron/services/audioEffectsMedia')
const { requestStream } = require('../electron/services/musicTransfer.cjs')

async function fixture(t) {
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, range: request.headers.range, cookie: request.headers.cookie })
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/audio' }); response.end(); return }
    const range = request.headers.range
    if (range) response.writeHead(206, { 'Content-Type': 'audio/wav', 'Content-Length': 4, 'Content-Range': 'bytes 2-5/8', 'Accept-Ranges': 'bytes' })
    else response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': 8, 'Accept-Ranges': 'bytes' })
    response.end(request.method === 'HEAD' ? undefined : range ? '2345' : '01234567')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const media = createAudioEffectsMedia({ request: (url, options) => requestStream(url, { ...options, allowLocalTestUrls: true }) })
  t.after(() => media.dispose())
  return { media, requests, url: `http://127.0.0.1:${server.address().port}` }
}

test('opaque media leases deliver real GET/HEAD/Range streams with CORS and no credentials', async t => {
  const { media, requests, url } = await fixture(t)
  const lease = media.acquire({ url: `${url}/audio`, identity: 'catalog:track:128' })
  let response = await media.handleRequest(new Request(lease.url))
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(await response.text(), '01234567')
  response = await media.handleRequest(new Request(lease.url, { headers: { Range: 'bytes=2-5' } }))
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/8')
  assert.equal(await response.text(), '2345')
  response = await media.handleRequest(new Request(lease.url, { method: 'HEAD' }))
  assert.equal(response.headers.get('content-length'), '8')
  assert.equal(await response.text(), '')
  assert.deepEqual(requests.map(value => value.method), ['GET', 'GET', 'HEAD'])
  assert.ok(requests.every(value => value.cookie === undefined))
  media.release(lease.leaseId)
  assert.equal((await media.handleRequest(new Request(lease.url))).status, 404)
})

test('media method survives redirects and ungranted paths/multiple ranges cannot reach upstream', async t => {
  const { media, requests, url } = await fixture(t)
  const lease = media.acquire({ url: `${url}/redirect`, identity: 'cloud:account:track' })
  assert.equal((await media.handleRequest(new Request(lease.url, { method: 'HEAD' }))).status, 200)
  assert.deepEqual(requests.map(value => value.method), ['HEAD', 'HEAD'])
  assert.equal((await media.handleRequest(new Request('bk-audio://media/anything'))).status, 404)
  assert.equal((await media.handleRequest(new Request(`${lease.url}?url=${url}`))).status, 404)
  assert.equal((await media.handleRequest(new Request(lease.url, { headers: { Range: 'bytes=0-1,4-5' } }))).status, 416)
  assert.equal((await media.handleRequest(new Request(lease.url, { method: 'POST' }))).status, 405)
  assert.equal(requests.length, 2)
  assert.throws(() => media.acquire({ url: 'file:///private', identity: 'track' }))
  assert.throws(() => media.acquire({ url: 'https://user:secret@example.com/music', identity: 'track' }))
})
