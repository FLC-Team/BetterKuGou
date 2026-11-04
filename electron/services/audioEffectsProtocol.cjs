const MAX_JSON_BYTES = 32 * 1024 * 1024
const MAX_PCM_BYTES = 1024 * 1024

/** A bounded frame keeps plugin diagnostics and binary audio out of JSON serialization. */
function encodeFrame(header, pcm) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const samples = pcm ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : Buffer.alloc(0)
  if (json.length > MAX_JSON_BYTES || samples.length > MAX_PCM_BYTES) throw new Error('音效数据超出允许大小')
  const prefix = Buffer.allocUnsafe(8)
  prefix.writeUInt32LE(json.length, 0)
  prefix.writeUInt32LE(samples.length, 4)
  return Buffer.concat([prefix, json, samples])
}

/** Decode partial/coalesced pipe writes; reject lengths before allocating their payload. */
function createFrameDecoder(onFrame) {
  let pending = Buffer.alloc(0)
  return chunk => {
    if (pending.length + chunk.length > MAX_JSON_BYTES + MAX_PCM_BYTES + 8) throw new Error('音效协议缓冲超出限制')
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= 8) {
      const jsonLength = pending.readUInt32LE(0), pcmLength = pending.readUInt32LE(4)
      if (!jsonLength || jsonLength > MAX_JSON_BYTES || pcmLength > MAX_PCM_BYTES || pcmLength % 4) throw new Error('音效宿主返回了无效数据')
      const length = 8 + jsonLength + pcmLength
      if (pending.length < length) return
      const header = JSON.parse(pending.subarray(8, 8 + jsonLength).toString('utf8'))
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('音效宿主消息无效')
      // A fresh aligned buffer also prevents a small message retaining a large pipe allocation.
      const pcm = new Float32Array(pcmLength / 4)
      if (pcmLength) Buffer.from(pcm.buffer).set(pending.subarray(8 + jsonLength, length))
      pending = pending.subarray(length)
      onFrame(header, pcm)
    }
  }
}

module.exports = { encodeFrame, createFrameDecoder, MAX_JSON_BYTES, MAX_PCM_BYTES }
