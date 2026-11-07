const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { isMainThread, parentPort, workerData } = require('node:worker_threads')
const { selectAssets } = require('./updateAssets.cjs')

const REPOSITORY = 'FLC-Team/BetterKuGou'
const PROXY = 'https://git.tangbai.cc/'
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases`
const PAGE_SIZE = 100
const MAX_PAGES = 10
const MAX_METADATA_BYTES = 8 * 1024 * 1024
const REDIRECT_HOSTS = new Set(['git.tangbai.cc', 'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
const DISK_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE', 'ENFILE', 'EDQUOT', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EBADF', 'EFBIG', 'EEXIST', 'EINVAL'])

function updateError(code, message) {
  return Object.assign(new Error(message), { code })
}

function assertNotCancelled(signal) {
  if (signal?.aborted) throw updateError('CANCELLED', '更新任务已取消')
}

/** 严格解析 SemVer；数值保持字符串，避免大版本号或预发布序号的精度丢失。 */
function parseVersion(input) {
  if (typeof input !== 'string' || input.length > 200) return null
  const version = input.trim().replace(/^v/, '')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version)
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some(item => /^\d+$/.test(item) && item.length > 1 && item.startsWith('0'))) return null
  return { version, core: match.slice(1, 4), prerelease }
}

function compareNumeric(left, right) {
  return left.length === right.length ? (left === right ? 0 : left > right ? 1 : -1) : left.length > right.length ? 1 : -1
}

function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left
  const b = typeof right === 'string' ? parseVersion(right) : right
  if (!a || !b) throw updateError('INVALID_INPUT', '无法识别应用版本')
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumeric(a.core[index], b.core[index])
    if (compared) return compared
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return compareNumeric(x, y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function validAssetName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,179}$/.test(name) && !name.endsWith('.')
}

function validDownloadUrl(value, tag, name) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return false
    return decodeURIComponent(url.pathname) === `/${REPOSITORY}/releases/download/${tag}/${name}`
  } catch { return false }
}

function normalizeAsset(asset, tag) {
  if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0 || !validAssetName(asset.name)
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 10 * 1024 ** 3
    || (asset.state != null && asset.state !== 'uploaded')
    || !validDownloadUrl(asset.browser_download_url, tag, asset.name)) return null
  const digest = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.toLowerCase() : null
  return { id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url, digest }
}

function normalizeRelease(raw, target) {
  const version = parseVersion(raw?.tag_name)
  if (!version || !Number.isSafeInteger(raw.id) || raw.id <= 0 || !Array.isArray(raw.assets)) return null
  if (raw.draft || (target.channel === 'stable' && (raw.prerelease || version.prerelease.length))) return null
  const assets = selectAssets(raw.assets.map(asset => normalizeAsset(asset, raw.tag_name)).filter(Boolean), { ...target, releaseVersion: version.version })
  return {
    id: raw.id, version: version.version, tag: raw.tag_name, channel: target.channel,
    platform: target.platform, arch: target.arch,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 500) : raw.tag_name,
    notes: typeof raw.body === 'string' ? raw.body.slice(0, 50000) : '',
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
    url: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(raw.tag_name)}`,
    assets, defaultAssetId: assets[0]?.id ?? null
  }
}

/** 网络传输仅接受固定 HTTPS 主机，限制跳转次数，并在 DNS、响应和流读取阶段均可取消。 */
function createTransport({ request = https.request, metadataTimeout = 15000, downloadTimeout = 30 * 60 * 1000, idleTimeout = 30000 } = {}) {
  async function open(url, { signal, metadata = false, allowRedirect = true, redirects = 0 } = {}) {
    assertNotCancelled(signal)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !REDIRECT_HOSTS.has(parsed.hostname)) throw updateError('NETWORK', '更新服务器跳转到不受支持的地址')
    if (redirects > 5) throw updateError('NETWORK', '更新服务器跳转次数过多')
    const response = await new Promise((resolve, reject) => {
      let responseRef
      let requestRef
      let timer
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
      }
      const fail = error => {
        const failure = error?.code === 'CANCELLED' || error?.code === 'TIMEOUT' ? error : updateError('NETWORK', `更新网络请求失败：${error?.message || '连接中断'}`)
        responseRef?.destroy(failure)
        requestRef?.destroy(failure)
        reject(failure)
      }
      const cancel = () => fail(updateError('CANCELLED', '更新任务已取消'))
      try {
        requestRef = request(parsed, { method: 'GET', headers: { 'User-Agent': 'BetterKuGou-Updater', Accept: metadata ? 'application/vnd.github+json' : 'application/octet-stream', 'Accept-Encoding': 'identity' } }, incoming => {
          responseRef = incoming
          incoming.once('end', cleanup)
          incoming.once('close', cleanup)
          incoming.once('error', cleanup)
          // 保留响应错误监听，避免在 pipeline 尚未接管时出现未处理异常。
          incoming.on('error', () => {})
          resolve(incoming)
        })
        requestRef.on('error', error => { cleanup(); reject(error?.code === 'CANCELLED' || error?.code === 'TIMEOUT' ? error : updateError('NETWORK', `更新网络请求失败：${error.message}`)) })
        timer = setTimeout(() => fail(updateError('TIMEOUT', '更新请求超时')), metadata ? metadataTimeout : downloadTimeout)
        requestRef.setTimeout?.(idleTimeout, () => fail(updateError('TIMEOUT', '更新连接长时间没有响应')))
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
        requestRef.end()
      } catch (error) { cleanup(); reject(error) }
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location
      response.destroy()
      if (!allowRedirect || !location) throw updateError('NETWORK', '更新服务器返回无效跳转')
      return open(new URL(location, parsed).href, { signal, metadata, allowRedirect, redirects: redirects + 1 })
    }
    if (response.statusCode !== 200) {
      response.destroy()
      throw updateError('HTTP_ERROR', `更新服务器返回 HTTP ${response.statusCode}`)
    }
    return response
  }
  return { open }
}

/** Worker 内执行分页、流式落盘及哈希，主进程仅接收小型状态对象。测试依赖只能由此导出接口注入。 */
function createUpdateEngine({ downloadRoot, request, now = Date.now, fsApi = fs, ...timeouts }) {
  if (typeof downloadRoot !== 'string' || !path.isAbsolute(downloadRoot)) throw updateError('INVALID_PATH', '更新下载目录必须为绝对路径')
  const root = path.resolve(downloadRoot)
  const transport = createTransport({ request, ...timeouts })

  /** 发布列表与官方核验共用有大小上限的 JSON 读取，取消时立即停止流。 */
  async function readMetadata(url, { signal, maxBytes = MAX_METADATA_BYTES, allowRedirect = true } = {}) {
    const response = await transport.open(url, { signal, metadata: true, allowRedirect })
    if (!/\b(?:application\/json|application\/[\w.+-]+\+json)\b/i.test(response.headers['content-type'] || '')) {
      response.destroy()
      throw updateError('INVALID_METADATA', '更新服务器未返回版本 JSON')
    }
    const chunks = []
    let bytes = 0
    for await (const chunk of response) {
      assertNotCancelled(signal)
      bytes += chunk.length
      if (bytes > maxBytes) throw updateError('INVALID_METADATA', '更新版本信息过大')
      chunks.push(chunk)
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw updateError('INVALID_METADATA', '更新版本 JSON 无效') }
    return { value, bytes }
  }

  /** 优先选择当前架构与已装格式的新版，保留兼容格式和无包说明作为回退。 */
  async function check(target, { signal } = {}) {
    const current = parseVersion(target?.currentVersion)
    if (!current || !['stable', 'beta'].includes(target.channel) || !['win32', 'darwin', 'linux'].includes(target.platform) || !['x64', 'ia32', 'arm64', 'armv7l'].includes(target.arch)) throw updateError('INVALID_INPUT', '检查更新参数无效')
    const preferredFormat = target.platform === 'linux' ? target.preferredFormat : null
    let lastError
    for (const source of ['proxy', 'github']) {
      try {
        let latest = null
        let latestCompatible = null
        let latestPreferred = null
        let totalBytes = 0
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          assertNotCancelled(signal)
          const original = `${RELEASE_API}?per_page=${PAGE_SIZE}&page=${page}`
          const { value: raw, bytes } = await readMetadata(source === 'proxy' ? PROXY + original : original, {
            signal, maxBytes: Math.min(MAX_METADATA_BYTES, MAX_METADATA_BYTES * 2 - totalBytes)
          })
          totalBytes += bytes
          if (!Array.isArray(raw) || raw.length > PAGE_SIZE || raw.some(item => !item || typeof item !== 'object' || typeof item.tag_name !== 'string' || !Array.isArray(item.assets) || !Number.isSafeInteger(item.id))) throw updateError('INVALID_METADATA', '更新版本数据结构无效')
          for (const item of raw) {
            const candidate = normalizeRelease(item, target)
            if (candidate && (!latest || compareVersions(candidate.version, latest.version) > 0)) latest = candidate
            if (candidate?.assets.length && (!latestCompatible || compareVersions(candidate.version, latestCompatible.version) > 0)) latestCompatible = candidate
            if (preferredFormat && candidate?.assets[0]?.format === preferredFormat
              && (!latestPreferred || compareVersions(candidate.version, latestPreferred.version) > 0)) latestPreferred = candidate
          }
          if (raw.length < PAGE_SIZE) break
          if (page === MAX_PAGES) throw updateError('INVALID_METADATA', '更新版本分页超过限制')
        }
        assertNotCancelled(signal)
        const next = [latestPreferred, latestCompatible, latest].find(candidate => candidate && compareVersions(candidate.version, current) > 0)
        return { release: next ?? null, hasReleases: Boolean(latest), latestVersion: latest?.version ?? null, source, checkedAt: new Date(now()).toISOString() }
      } catch (error) {
        assertNotCancelled(signal)
        if (error.code === 'CANCELLED') throw error
        lastError = error
      }
    }
    throw lastError
  }

  /** 下载和缓存共用官方摘要，代理发现的版本、资产和渠道必须与 GitHub 对应。 */
  async function authenticateAsset(release, asset, signal) {
    let official
    try {
      const { value } = await readMetadata(`${RELEASE_API}/tags/${encodeURIComponent(release.tag)}`, { signal, allowRedirect: false })
      official = value
    } catch (error) {
      assertNotCancelled(signal)
      throw updateError('UNVERIFIED_RELEASE', `无法向 GitHub 核验安装包发布信息：${error.message}`)
    }
    if (official?.id !== release.id || official.tag_name !== release.tag || official.draft !== false
      || typeof official.prerelease !== 'boolean' || (release.channel === 'stable' && official.prerelease)
      || !Array.isArray(official.assets)) throw updateError('UNVERIFIED_RELEASE', '安装包对应的版本与 GitHub 官方发布不一致，请重新检查更新')
    const officialAsset = normalizeAsset(official.assets.find(item => item?.id === asset.id && item.state === 'uploaded'), release.tag)
    const [published] = selectAssets(officialAsset ? [officialAsset] : [], { platform: release.platform, arch: release.arch, releaseVersion: release.version })
    if (!published || published.name !== asset.name || published.size !== asset.size || published.format !== asset.format
      || published.platform !== asset.platform || published.arch !== asset.arch) throw updateError('UNVERIFIED_RELEASE', '安装包信息与 GitHub 官方发布不一致，请重新检查更新')
    if (!published.digest) throw updateError('UNVERIFIED_RELEASE', 'GitHub 官方发布未提供安装包的 SHA256 校验值，无法安全下载')
    return published
  }

  function containedFile(candidate) {
    if (typeof candidate !== 'string' || path.dirname(path.resolve(candidate)) !== root) throw updateError('INVALID_PATH', '更新文件不在专用下载目录中')
    return path.resolve(candidate)
  }

  async function ensureRoot() {
    try {
      await fsApi.promises.mkdir(root, { recursive: true })
      const info = await fsApi.promises.lstat(root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw updateError('INVALID_PATH', '更新下载目录不能为符号链接')
    } catch (error) {
      if (error.code === 'INVALID_PATH') throw error
      throw updateError('DISK_ERROR', `无法访问更新下载目录：${error.message}`)
    }
  }

  async function verify({ file }, { signal } = {}) {
    assertNotCancelled(signal)
    const filename = containedFile(file?.path)
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || !/^sha256:[a-f0-9]{64}$/i.test(file.digest || '')) throw updateError('INVALID_INPUT', '更新文件校验记录无效')
    await ensureRoot()
    let stream
    const cancel = () => stream?.destroy(updateError('CANCELLED', '更新任务已取消'))
    try {
      const info = await fsApi.promises.lstat(filename)
      if (!info.isFile() || info.isSymbolicLink()) throw updateError('INVALID_PATH', '更新文件不能为符号链接或目录')
      if (info.size !== file.size) throw updateError('SIZE_MISMATCH', '更新文件大小校验失败，请重新下载')
      const hash = crypto.createHash('sha256')
      stream = fsApi.createReadStream(filename)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      for await (const chunk of stream) { assertNotCancelled(signal); hash.update(chunk) }
      if (`sha256:${hash.digest('hex')}` !== file.digest.toLowerCase()) throw updateError('HASH_MISMATCH', '更新文件 SHA256 校验失败，请重新下载')
      assertNotCancelled(signal)
      return { ...file, path: filename, digest: file.digest.toLowerCase() }
    } catch (error) {
      assertNotCancelled(signal)
      if (['SIZE_MISMATCH', 'HASH_MISMATCH', 'INVALID_PATH', 'CANCELLED'].includes(error.code)) throw error
      throw Object.assign(updateError('DISK_ERROR', `无法读取更新文件：${error.message}`), { causeCode: error.code })
    } finally { signal?.removeEventListener('abort', cancel) }
  }

  async function download({ release, asset }, { signal, onProgress = () => {} } = {}) {
    assertNotCancelled(signal)
    const version = parseVersion(release?.tag)
    if (!version || version.version !== release.version || !['stable', 'beta'].includes(release.channel)
      || (release.channel === 'stable' && version.prerelease.length)
      || !Number.isSafeInteger(release.id) || release.id <= 0 || !asset || !Number.isSafeInteger(asset.id) || asset.id <= 0
      || !validAssetName(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 10 * 1024 ** 3 || !validDownloadUrl(asset.url, release.tag, asset.name)) throw updateError('INVALID_INPUT', '更新安装包信息无效')
    const [compatible] = selectAssets([asset], { platform: release.platform, arch: release.arch, releaseVersion: version.version })
    if (!compatible || compatible.format !== asset.format || compatible.platform !== asset.platform || compatible.arch !== asset.arch) {
      throw updateError('INVALID_INPUT', '更新安装包与当前平台或架构不匹配')
    }
    const published = await authenticateAsset(release, asset, signal)
    await ensureRoot()
    const filename = containedFile(path.join(root, `${release.id}-${published.id}-${published.name}`))
    const baseRecord = {
      path: filename, releaseId: release.id, assetId: published.id, assetName: published.name, version: release.version,
      format: published.format, platform: published.platform, arch: published.arch, size: published.size, digest: published.digest
    }
    try { return await verify({ file: { ...baseRecord, source: 'cache' } }, { signal }) } catch (error) {
      if (error.code === 'CANCELLED' || error.code === 'INVALID_PATH' || (error.code === 'DISK_ERROR' && error.causeCode !== 'ENOENT')) throw error
      // 仅本服务按资产身份生成的缓存可失效重下；不会读取或覆盖任意用户路径。
    }
    let lastError
    for (const source of ['proxy', 'github']) {
      const temporary = containedFile(`${filename}.${crypto.randomBytes(6).toString('hex')}.part`)
      let response
      let output
      let outputClosed
      try {
        assertNotCancelled(signal)
        response = await transport.open(source === 'proxy' ? PROXY + published.url : published.url, { signal })
        if (/text\/html|application\/json/i.test(response.headers['content-type'] || '') || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) throw updateError('SIZE_MISMATCH', '更新下载未返回安装包')
        const contentLength = response.headers['content-length']
        if (contentLength !== undefined && (!/^\d+$/.test(String(contentLength)) || Number(contentLength) !== published.size)) throw updateError('SIZE_MISMATCH', '更新包响应大小与发布信息不一致')
        const hash = crypto.createHash('sha256')
        let received = 0
        let lastProgress = now()
        onProgress({ received: 0, total: published.size, percent: 0, source })
        assertNotCancelled(signal)
        const counter = new Transform({ transform(chunk, _encoding, callback) {
          received += chunk.length
          if (received > published.size) { callback(updateError('SIZE_MISMATCH', '更新包超过发布大小')); return }
          hash.update(chunk)
          if (now() - lastProgress >= 250) {
            lastProgress = now()
            onProgress({ received, total: published.size, percent: Math.min(100, received / published.size * 100), source })
          }
          callback(null, chunk)
        } })
        output = fsApi.createWriteStream(temporary, { flags: 'wx' })
        outputClosed = new Promise(resolve => output.once('close', resolve))
        // pipeline 会把网络错误转发到写流，不能把所有写流 error 都误判成磁盘故障。
        output.on('error', error => { if (DISK_ERROR_CODES.has(error.code)) error.updateDiskError = true })
        await pipeline(response, counter, output, { signal })
        assertNotCancelled(signal)
        if (received !== published.size) throw updateError('SIZE_MISMATCH', '更新包下载不完整')
        const digest = `sha256:${hash.digest('hex')}`
        if (digest !== published.digest) throw updateError('HASH_MISMATCH', '更新包 SHA256 与 GitHub 官方发布信息不一致')
        try {
          const existing = await fsApi.promises.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error })
          if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw updateError('INVALID_PATH', '更新缓存位置不是普通文件')
          if (existing) await fsApi.promises.unlink(filename)
          await fsApi.promises.rename(temporary, filename)
        } catch (error) { throw error.code === 'INVALID_PATH' ? error : updateError('DISK_ERROR', `无法保存更新包：${error.message}`) }
        assertNotCancelled(signal)
        onProgress({ received, total: published.size, percent: 100, source })
        return { ...baseRecord, source }
      } catch (error) {
        response?.destroy()
        // pipeline may reject on abort before a pending fs.open has completed.
        // Wait for the write stream to close so unlink cannot race its creation.
        output?.destroy()
        await outputClosed
        try { await fsApi.promises.unlink(temporary) } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') throw updateError('DISK_ERROR', `无法清理临时更新包：${cleanupError.message}`)
        }
        assertNotCancelled(signal)
        if (error.code === 'CANCELLED' || error.code === 'INVALID_PATH' || error.code === 'DISK_ERROR') throw error
        if (error.updateDiskError) throw updateError('DISK_ERROR', `无法写入更新包：${error.message}`)
        lastError = ['NETWORK', 'TIMEOUT', 'HTTP_ERROR', 'SIZE_MISMATCH', 'HASH_MISMATCH'].includes(error.code)
          ? error : updateError('NETWORK', `更新包传输失败：${error.message}`)
      }
    }
    throw lastError
  }

  return { check, download, verify }
}

/** 普通命令串行；取消和停止立即中断当前任务，旧任务结果始终携带原请求 ID。 */
function attachWorker(port, engine) {
  let queue = Promise.resolve()
  let active = null
  let stopping = false
  const pending = new Map()
  const sendError = (id, error) => port.postMessage({ id, type: 'error', error: { message: error.message || '更新任务失败', code: error.code || 'NETWORK' } })
  const listener = message => {
    if (!message || (typeof message.id !== 'number' && typeof message.id !== 'string')) return
    const { id, action } = message
    if (action === 'cancel') {
      const targetId = message.targetId ?? active?.id
      const task = pending.get(targetId)
      const cancelled = Boolean(task)
      if (task) task.cancelled = true
      if (active?.id === targetId) active.controller.abort()
      port.postMessage({ id, type: 'result', result: { cancelled } })
      return
    }
    if (action === 'stop') {
      stopping = true
      active?.controller.abort()
      queue.finally(() => { port.postMessage({ id, type: 'result', result: { stopped: true } }); port.off('message', listener); port.close() })
      return
    }
    if (!['check', 'download', 'verify'].includes(action)) { sendError(id, updateError('INVALID_INPUT', '不支持的更新操作')); return }
    if (stopping) { sendError(id, updateError('CANCELLED', '更新服务正在停止')); return }
    const task = { cancelled: false }
    pending.set(id, task)
    queue = queue.then(async () => {
      if (stopping || task.cancelled) {
        pending.delete(id)
        sendError(id, updateError('CANCELLED', '更新任务已取消'))
        return
      }
      const controller = new AbortController()
      active = { id, controller }
      try {
        const result = await engine[action](message, { signal: controller.signal, onProgress: progress => {
          if (active?.id === id && !controller.signal.aborted) port.postMessage({ id, type: 'progress', progress })
        } })
        assertNotCancelled(controller.signal)
        port.postMessage({ id, type: 'result', result })
      } catch (error) { sendError(id, error) } finally {
        if (active?.id === id) active = null
        pending.delete(id)
      }
    })
  }
  port.on('message', listener)
}

if (!isMainThread && parentPort) attachWorker(parentPort, createUpdateEngine({ downloadRoot: workerData?.downloadRoot }))

module.exports = { parseVersion, compareVersions, selectAssets, normalizeRelease, createTransport, createUpdateEngine, attachWorker }
