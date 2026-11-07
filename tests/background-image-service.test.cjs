const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createBackgroundImageService } = require('../electron/services/backgroundImageService')

test('managed backgrounds publish atomically, persist and serve only bounded image files', async t => {
  const toolsRoot = path.resolve(__dirname, '../.agent/tools')
  await fs.mkdir(toolsRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(toolsRoot, 'background-image-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const { backgroundImageUrl, normalizeBackgroundImageId, MAX_BACKGROUND_IMAGE_BYTES } = await import('../electron/backgroundImage.mjs')
  const logger = { error: (...args) => assert.fail(JSON.stringify(args)), warn: (...args) => assert.fail(JSON.stringify(args)) }
  const service = await createBackgroundImageService(root, logger)
  const pixel = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')

  const [id, sameId] = await Promise.all([service.store(pixel), service.store(pixel)])
  assert.match(id, /^[0-9a-f]{64}$/)
  assert.equal(sameId, id)
  assert.deepEqual(await fs.readdir(path.join(root, 'background-images')), [`${id}.webp`])

  const restarted = await createBackgroundImageService(root, logger)
  const url = backgroundImageUrl(id)
  const response = await restarted.handleRequest(new Request(url))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/webp')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pixel)

  for (const value of ['../settings.json', 'file:///settings.json', 'a'.repeat(63), id + '/']) {
    assert.equal(normalizeBackgroundImageId(value), '')
    assert.equal(backgroundImageUrl(value), '')
  }
  for (const value of [`${url}?path=settings.json`, 'bk-background://image/../settings.json', 'bk-background://image/' + '0'.repeat(64)]) {
    assert.equal((await restarted.handleRequest(new Request(value))).status, 404)
  }
  assert.equal((await restarted.handleRequest(new Request(url, { method: 'POST' }))).status, 405)
  await assert.rejects(service.store(Buffer.from('image/svg+xml')), /格式或大小/)
  await assert.rejects(service.store(new Uint8Array(MAX_BACKGROUND_IMAGE_BYTES + 1)), /格式或大小/)
})
