const test = require('node:test')
const assert = require('node:assert/strict')
const { encodeFrame, createFrameDecoder, MAX_JSON_BYTES } = require('../electron/services/audioEffectsProtocol.cjs')

test('native frames survive arbitrary pipe splitting and retain planar channel samples', () => {
  const pcm = Float32Array.from([1, .5, -.5, -1, .25, .75, -.75, -.25])
  const frames = [encodeFrame({ id: 1, command: 'configure', name: '音频效果' }),
    encodeFrame({ type: 'audio', generation: 2, sequence: 3, frames: 4, channels: 2 }, pcm),
    encodeFrame({ id: 2, ok: true, result: { latencySamples: 512 } })]
  const output = [], decode = createFrameDecoder((header, audio) => output.push({ header, audio }))
  const bytes = Buffer.concat(frames)
  for (let index = 0; index < bytes.length; index += 11) decode(bytes.subarray(index, index + 11))
  assert.equal(output.length, 3)
  assert.equal(output[0].header.name, '音频效果')
  assert.deepEqual(output[1].audio, pcm)
  assert.equal(output[1].header.sequence, 3)
  assert.equal(output[2].header.result.latencySamples, 512)
})

test('invalid native length and JSON headers are rejected before consuming payloads', () => {
  for (const [json, pcm] of [[0, 0], [MAX_JSON_BYTES + 1, 0], [2, 3], [2, 1024 * 1024 + 4]]) {
    const bytes = Buffer.alloc(8); bytes.writeUInt32LE(json); bytes.writeUInt32LE(pcm, 4)
    assert.throws(() => createFrameDecoder(() => assert.fail('malformed frame delivered'))(bytes))
  }
  const invalid = Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 91, 93])
  assert.throws(() => createFrameDecoder(() => assert.fail('array header delivered'))(invalid))
})
