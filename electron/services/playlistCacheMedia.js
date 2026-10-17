const fs = require('node:fs')
const { Readable } = require('node:stream')

/** Parse one RFC 7233 byte range, including suffix and open-ended ranges. */
function parseByteRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2]) || size <= 0) return false
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : size - 1
  if (start == null) {
    if (!Number.isSafeInteger(end) || end <= 0) return false
    start = Math.max(0, size - end)
    end = size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false
  return { start, end: Math.min(end, size - 1) }
}

/** Serve only a previously granted resource; no caller-controlled path is interpreted. */
function createMediaResponse(request, resource, onClose = () => {}) {
  const method = request.method || 'GET'
  if (!['GET', 'HEAD'].includes(method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  const range = parseByteRange(request.headers?.get?.('range'), resource.size)
  const headers = {
    'Content-Type': resource.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff'
  }
  if (range === false) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${resource.size}` } })
  const start = range?.start ?? 0
  const end = range?.end ?? resource.size - 1
  headers['Content-Length'] = String(end - start + 1)
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${resource.size}`
  if (method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })
  const stream = fs.createReadStream(resource.path, { start, end })
  let closed = false
  const finish = () => { if (!closed) { closed = true; onClose() } }
  stream.once('close', finish)
  stream.once('error', finish)
  return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers })
}

module.exports = { parseByteRange, createMediaResponse }
