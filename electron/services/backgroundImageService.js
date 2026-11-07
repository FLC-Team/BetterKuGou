const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
async function createBackgroundImageService(userDataPath, logger) {
  const { MAX_BACKGROUND_IMAGE_BYTES, normalizeBackgroundImageId } = await import('../backgroundImage.mjs')
  const directory = path.join(userDataPath, 'background-images')
  const filenameFor = id => path.join(directory, `${id}.webp`)

  function isWebp(buffer) {
    return buffer.length >= 16 && buffer.length <= MAX_BACKGROUND_IMAGE_BYTES &&
      buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.readUInt32LE(4) === buffer.length - 8 &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
  }

  async function readImage(id) {
    const filename = filenameFor(id)
    try {
      const stat = await fs.lstat(filename)
      if (!stat.isFile() || stat.size > MAX_BACKGROUND_IMAGE_BYTES) return null
      const buffer = await fs.readFile(filename)
      return isWebp(buffer) ? buffer : null
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  /** Publish a bounded WebP snapshot atomically before a setting can refer to it. */
  async function store(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BACKGROUND_IMAGE_BYTES) {
      throw new Error('背景图片格式或大小无效。')
    }
    const buffer = Buffer.from(bytes)
    if (!isWebp(buffer)) throw new Error('背景图片格式或大小无效。')
    const id = createHash('sha256').update(buffer).digest('hex')
    const temporary = path.join(directory, `${randomUUID()}.tmp`)
    try {
      if ((await readImage(id))?.equals(buffer)) return id
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 })
      try {
        await fs.rename(temporary, filenameFor(id))
      } catch (error) {
        // Another import can publish the same content while Windows holds the destination open.
        if (!(await readImage(id))?.equals(buffer)) throw error
      }
      return id
    } catch (error) {
      logger.error('background-image', '保存背景图片失败', { code: error.code, name: error.name })
      throw new Error('无法保存背景图片，请重试。')
    } finally {
      await fs.rm(temporary, { force: true }).catch(cleanupError => {
        logger.warn('background-image', '清理背景图片临时文件失败', { code: cleanupError.code, name: cleanupError.name })
      })
    }
  }

  /** Serve only managed image snapshots from the fixed user-data directory. */
  async function handleRequest(request) {
    let url
    try { url = new URL(request.url) } catch { return new Response(null, { status: 400 }) }
    const id = normalizeBackgroundImageId(url.pathname.slice(1))
    if (url.protocol !== 'bk-background:' || url.host !== 'image' ||
        url.username || url.password || url.search || url.hash || !id) {
      return new Response(null, { status: 404 })
    }
    if (request.method !== 'GET') return new Response(null, { status: 405 })

    try {
      const buffer = await readImage(id)
      if (!buffer) return new Response(null, { status: 404 })
      return new Response(buffer, { headers: { 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff' } })
    } catch (error) {
      logger.error('background-image', '读取背景图片失败', { code: error.code, name: error.name })
      return new Response(null, { status: 500 })
    }
  }

  return { store, handleRequest }
}

module.exports = { createBackgroundImageService }
