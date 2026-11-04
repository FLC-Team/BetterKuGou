const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { requestStream } = require('./musicTransfer.cjs')

/** Only opaque, short-lived playback leases can reach the CORS-safe streaming protocol. */
function createAudioEffectsMedia({ request = requestStream } = {}) {
  const leases = new Map()
  function acquire({ url, identity } = {}) {
    if (typeof url !== 'string' || url.length > 16384 || typeof identity !== 'string' || identity.length > 1024) throw new Error('播放来源无效')
    const source = new URL(url)
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) throw new Error('播放来源无效')
    if (leases.size >= 16) throw new Error('活动音源过多，请重试')
    const leaseId = crypto.randomUUID()
    leases.set(leaseId, { url, identity, requests: new Set() })
    return { leaseId, url: `bk-audio://media/${leaseId}` }
  }
  function release(leaseId) {
    const lease = leases.get(leaseId)
    if (!lease) return false
    leases.delete(leaseId)
    for (const controller of lease.requests) controller.abort()
    lease.requests.clear()
    return true
  }
  async function handleRequest(incoming) {
    const parsed = new URL(incoming.url)
    const id = parsed.pathname.slice(1)
    const lease = parsed.hostname === 'media' && !parsed.search && !parsed.hash && leases.get(id)
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
    if (!lease) return new Response(null, { status: 404, headers: cors })
    const method = incoming.method || 'GET'
    if (!['GET', 'HEAD'].includes(method)) return new Response(null, { status: 405, headers: { ...cors, Allow: 'GET, HEAD' } })
    const headers = {}
    const range = incoming.headers?.get?.('range'), ifRange = incoming.headers?.get?.('if-range')
    if (range) {
      if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 100) return new Response(null, { status: 416, headers: cors })
      headers.Range = range
      if (ifRange && ifRange.length <= 256 && !/[\r\n]/.test(ifRange)) headers['If-Range'] = ifRange
    }
    const controller = new AbortController()
    lease.requests.add(controller)
    const abort = () => controller.abort()
    incoming.signal?.addEventListener('abort', abort, { once: true })
    const finish = () => { lease.requests.delete(controller); incoming.signal?.removeEventListener('abort', abort) }
    try {
      const response = await request(lease.url, { method, headers, signal: controller.signal })
      if (!leases.has(id) || controller.signal.aborted) { response.destroy(); finish(); return new Response(null, { status: 410, headers: cors }) }
      if (![200, 206, 416].includes(response.statusCode)) { const status = response.statusCode; response.destroy(); finish(); return new Response(null, { status: status >= 400 && status <= 599 ? status : 502, headers: cors }) }
      const outgoing = { ...cors }
      for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = response.headers[key]
        if (typeof value === 'string' && !/[\r\n]/.test(value)) outgoing[key] = value
      }
      if (method === 'HEAD' || response.statusCode === 416) { response.destroy(); finish(); return new Response(null, { status: response.statusCode, headers: outgoing }) }
      response.once('close', finish)
      response.once('error', finish)
      return new Response(Readable.toWeb(response), { status: response.statusCode, headers: outgoing })
    } catch {
      finish()
      return new Response(null, { status: controller.signal.aborted ? 410 : 502, headers: cors })
    }
  }
  return { acquire, release, handleRequest, dispose() { for (const id of leases.keys()) release(id) } }
}
module.exports = { createAudioEffectsMedia }
