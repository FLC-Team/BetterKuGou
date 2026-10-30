const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns')
const net = require('node:net')
const { parentPort, workerData, isMainThread } = require('node:worker_threads')

const API_BASE = 'http://localhost:6500'
const CACHE_LIMITS = [2048, 4096, 6144, 8192, 10240, -1]
const QUALITY = new Set(['128', '320', 'flac', 'high'])
const SECRET_FIELD = /(?:token|cookie|accesskey|password|authorization|secret|signature)|^(?:url|play_url|playurl|audio_url|sign)$/i
const LYRIC_FIELDS = new Set(['status', 'content', 'decodeContent', 'language', 'trans', 'translation', 'lang', 'multilang', 'lyric_translation', 'lyricTranslation', 'translationData', 'contenttype', 'charset', 'fmt', 'data'])
const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', ape: 'audio/ape', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)) }
function cacheError(code, message) { return Object.assign(new Error(message), { code }) }
function normalizeHash(value) { return typeof value === 'string' && /^[a-z\d_-]{1,128}$/i.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value.toLowerCase()) ? value.toLowerCase() : null }
function normalizeQuality(value) { return QUALITY.has(value) ? value : '128' }
function songHash(song) { return normalizeHash(song?.hash ?? song?.Hash ?? song?.FileHash ?? song?.filehash) }

/** Retain public song metadata without persisting transient playback URLs or credentials. */
function publicData(value, depth = 0, maxString = 100_000) {
  if (depth > 10) return null
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        if (url.username || url.password || [...url.searchParams.keys()].some(key => SECRET_FIELD.test(key))) return ''
      } catch { return '' }
    }
    return value.slice(0, maxString)
  }
  if (Array.isArray(value)) return value.slice(0, 20_000).map(item => publicData(item, depth + 1, maxString))
  if (typeof value !== 'object') return null
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || SECRET_FIELD.test(key)) continue
    result[key] = publicData(item, depth + 1, maxString)
  }
  return result
}

function privateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase()
    if (normalized.startsWith('::ffff:')) return privateAddress(normalized.slice(7))
    return normalized === '::' || normalized === '::1' || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)
  }
  return true
}

/** Cover downloads are limited to the public image hosts already supplied by KuGou. */
function allowedArtworkUrl(raw) {
  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ![...url.searchParams.keys()].some(key => SECRET_FIELD.test(key)) && (!url.port || ['80', '443'].includes(url.port)) &&
      (url.hostname === 'kgimg.com' || url.hostname.endsWith('.kgimg.com') || ['imge.kugou.com', 'imgessl.kugou.com', 'img.kugou.com', 'singerimg.kugou.com'].includes(url.hostname))
  } catch { return false }
}

/** Sniff actual file bytes rather than accepting a JSON/HTML error or trusting an extension. */
function detectFormat(buffer, artwork = false) {
  if (artwork) {
    if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg'
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
    if (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a') return 'gif'
    if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp'
    return null
  }
  if (buffer.subarray(0, 4).toString() === 'fLaC') return 'flac'
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'ogg'
  if (buffer.subarray(0, 4).toString() === 'MAC ') return 'ape'
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return 'wav'
  if (buffer.subarray(4, 8).toString() === 'ftyp') return 'm4a'
  if (buffer.subarray(0, 3).toString() === 'ID3') return 'mp3'
  for (let i = 0; i < Math.min(buffer.length - 3, 4096); i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0 && (buffer[i + 1] & 6) !== 0 && (buffer[i + 2] & 0xf0) !== 0xf0 && (buffer[i + 2] & 0x0c) !== 0x0c) return 'mp3'
  }
  return null
}

function isPreview(response) {
  return [response, response?.data].some(value => value && (
    ['is_free_part', 'isFreePart', 'IsFreePart', 'is_try', 'isTry', 'is_trial', 'isTrial', 'trial', 'preview', 'is_preview'].some(key => value[key] === true || Number(value[key]) === 1) ||
    (Number(value.try_end) > Number(value.try_begin) && Number(value.try_end) > 0) ||
    (typeof value.free_part === 'object' && value.free_part !== null
      ? Number(value.free_part.end) > 0
      : value.free_part === true || Number(value.free_part) === 1)
  ))
}

/** Fixed local API requests may use credentials; media and image requests never receive them. */
function requestStream(rawUrl, { signal, localApi = false, artwork = false, allowLocalTestUrls = false, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try { url = new URL(rawUrl) } catch { reject(cacheError('INVALID_URL', '缓存来源无效')); return }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || redirects > 5) { reject(cacheError('INVALID_URL', '缓存来源无效')); return }
    const loopbackTest = allowLocalTestUrls && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (artwork && !loopbackTest && !allowedArtworkUrl(rawUrl)) { reject(cacheError('INVALID_URL', '封面来源不受支持')); return }
    if (!localApi && !loopbackTest && (net.isIP(url.hostname) || (url.port && !['80', '443'].includes(url.port)))) { reject(cacheError('INVALID_URL', '缓存来源无效')); return }
    const options = { signal, headers: { 'User-Agent': 'BetterKuGou/OfflineCache', 'Accept-Encoding': 'identity' } }
    if (!localApi && !loopbackTest) {
      options.lookup = (hostname, lookupOptions, callback) => {
        dns.lookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
          if (error) { callback(error); return }
          const valid = addresses.filter(item => !privateAddress(item.address))
          if (!valid.length || valid.length !== addresses.length) { callback(cacheError('INVALID_URL', '缓存来源地址无效')); return }
          if (lookupOptions?.all) callback(null, valid)
          else callback(null, valid[0].address, valid[0].family)
        })
      }
    }
    const req = (url.protocol === 'https:' ? https : http).get(url, options, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        if (localApi || !response.headers.location) { reject(cacheError('INVALID_REDIRECT', '缓存来源重定向无效')); return }
        let target
        try { target = new URL(response.headers.location, url) } catch { reject(cacheError('INVALID_REDIRECT', '缓存来源重定向无效')); return }
        requestStream(target.href, { signal, artwork, allowLocalTestUrls, redirects: redirects + 1 }).then(resolve, reject)
        return
      }
      // The local API intentionally returns business errors (including 20017) as HTTP 502.
      if (response.statusCode !== 200 && !localApi) {
        response.resume()
        reject(cacheError(response.statusCode === 401 || response.statusCode === 403 ? 'PERMISSION' : 'NETWORK', '暂时无法下载缓存'))
        return
      }
      response.on('error', () => {})
      resolve(response)
    })
    req.setTimeout(15_000, () => req.destroy(cacheError('NETWORK', '缓存请求超时')))
    req.on('error', error => reject(error.name === 'AbortError' ? cacheError('CANCELLED', '缓存任务已停止') : cacheError(error.code === 'INVALID_URL' ? 'INVALID_URL' : 'NETWORK', '缓存网络请求失败')))
  })
}

/** All disk state and downloads live in one Worker; the main process only holds opaque leases. */
function createCacheEngine({ cacheRoot, apiBase = API_BASE, allowLocalTestUrls = false, limitBytesOverride, protectedFiles = [], retryBaseDelayMs = 1000, onState = () => {}, onAuthExpired = () => {} }) {
  let root = path.resolve(cacheRoot)
  const accounts = new Map()
  const active = new Map()
  const leases = new Map()
  const deferredDeletes = new Map()
  let session = null
  let current = null
  let generation = 0
  let revision = 0
  let enabled = true
  let concurrency = 3
  let qualityPreference = '128'
  let limitBytes = limitBytesOverride ?? 2 * 1024 ** 3
  let usedBytes = 0
  let stopped = false
  let schedulerTimer = null
  let lastUsageReport = 0
  let capacityChain = Promise.resolve()
  let diskChain = Promise.resolve()
  let migration = null
  let migrationWarning = null
  const retiredDirectories = []

  function filePath(account, name) {
    if (!/^[a-f\d]{64}$/.test(account) || !/^[a-f\d]{64}(?:\.[a-z\d]{1,16}){1,2}$/.test(name)) throw cacheError('INVALID_PATH', '缓存文件索引无效')
    return path.join(root, account, name)
  }
  function emptyIndex(account) { return { version: 1, account, playlists: [], songs: {}, lyrics: {}, artworks: {}, paused: false, suppressed: false } }
  function indexPath(index) { return path.join(root, index.account, 'index.json') }
  function withDisk(operation) { const result = diskChain.then(operation); diskChain = result.catch(() => {}); return result }
  function withCapacity(operation) { const result = capacityChain.then(operation); capacityChain = result.catch(() => {}); return result }

  async function diskUsage(directory = root) {
    let total = 0
    let entries
    try { entries = await fsp.readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return 0; throw error }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) total += await diskUsage(target)
      else if (entry.isFile()) {
        try { total += (await fsp.stat(target)).size } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
    return total
  }

  async function writeIndex(index) {
    const serialized = JSON.stringify(index)
    if (Buffer.byteLength(serialized) > 16 * 1024 ** 2) throw cacheError('INVALID_PLAYLIST', '歌单缓存内容过大')
    const target = indexPath(index)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`
    try {
      await fsp.writeFile(temp, serialized, { mode: 0o600 })
      // Windows scanners may briefly hold the old index; retry without unlinking the valid copy.
      for (let attempt = 0; ; attempt++) {
        try { await fsp.rename(temp, target); break } catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 3) throw error
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
        }
      }
    } finally { await fsp.rm(temp, { force: true }).catch(() => {}) }
  }

  function reservedBytes() { return [...active.values()].reduce((sum, item) => sum + Math.max(0, (item.reserved || 0) - (item.written || 0)), 0) }
  function largestIndexSize() { return Math.max(0, ...[...accounts.values()].map(index => Buffer.byteLength(JSON.stringify(index)))) }

  // Called only under capacityChain. Metadata's temporary atomic-write copy counts too.
  async function ensureSpace(extra) {
    usedBytes = await diskUsage()
    const changed = new Set()
    if (limitBytes < 0) return changed
    const candidates = []
    for (const index of accounts.values()) {
      for (const record of Object.values(index.songs)) {
        if (record.file && !isLeased(index.account, record.file) && ![...active.values()].some(item => item.record === record)) candidates.push({ index, record, kind: 'song' })
      }
      for (const record of Object.values(index.artworks)) if (record.file && !isLeased(index.account, record.file) && ![...active.values()].some(item => item.record === record)) candidates.push({ index, record, kind: 'artwork' })
    }
    candidates.sort((a, b) => (a.record.lastUsed || 0) - (b.record.lastUsed || 0))
    while (usedBytes + reservedBytes() + extra > limitBytes && candidates.length) {
      const candidate = candidates.shift()
      await removeRecord(candidate.index, candidate.record, candidate.kind)
      changed.add(candidate.index)
      usedBytes = await diskUsage()
    }
    if (usedBytes + reservedBytes() + extra > limitBytes) throw Object.assign(cacheError('SPACE', '缓存空间不足'), { changed })
    return changed
  }

  async function persist(index) {
    return withCapacity(async () => {
      // Account for the full new index before it is written, including large playlist snapshots.
      let changed
      try { changed = await ensureSpace(largestIndexSize()) } catch (error) {
        if (error.changed?.size) await withDisk(async () => { for (const item of error.changed) if (item !== index) await writeIndex(item) })
        throw error
      }
      changed.add(index)
      return withDisk(async () => {
        for (const item of changed) await writeIndex(item)
        usedBytes = await diskUsage()
      })
    })
  }

  const ready = (async () => {
    await fsp.mkdir(root, { recursive: true })
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f\d]{64}$/.test(entry.name)) continue
      let index
      try { index = JSON.parse(await fsp.readFile(path.join(root, entry.name, 'index.json'), 'utf8')) } catch { index = emptyIndex(entry.name) }
      if (!index || index.version !== 1 || index.account !== entry.name || !Array.isArray(index.playlists) || !index.songs || typeof index.songs !== 'object' || Array.isArray(index.songs) || !index.lyrics || typeof index.lyrics !== 'object' || Array.isArray(index.lyrics) || !index.artworks || typeof index.artworks !== 'object' || Array.isArray(index.artworks)) index = emptyIndex(entry.name)
      index.playlists = index.playlists.filter(item => item && typeof item === 'object' && item.id != null && Array.isArray(item.songs))
        .map(item => ({ ...publicData(item), id: String(item.id), songs: publicData(item.songs.filter(song => song && typeof song === 'object')), name: String(item.name || '歌单'), isFavorite: item.isFavorite === true }))
      for (const [key, record] of Object.entries(index.songs)) {
        if (!record || typeof record !== 'object' || !normalizeHash(record.hash) || !QUALITY.has(record.quality) || key !== `${record.hash}:${record.quality}` || !record.song || typeof record.song !== 'object') { delete index.songs[key]; continue }
        record.kind = 'song'
        record.key = key
        record.song = publicData(record.song)
        if (record.detail) record.detail = publicData(record.detail)
        if (record.file) {
          try { filePath(entry.name, record.file) } catch { delete index.songs[key] }
        }
      }
      for (const [key, record] of Object.entries(index.artworks)) {
        if (!record || typeof record !== 'object' || !/^[a-f\d]{64}$/.test(key) || typeof record.url !== 'string' || digest(record.url) !== key) { delete index.artworks[key]; continue }
        record.kind = 'artwork'
        record.key = key
        if (record.file) { try { filePath(entry.name, record.file) } catch { delete index.artworks[key] } }
      }
      for (const hash of Object.keys(index.lyrics)) if (!normalizeHash(hash) || !index.lyrics[hash] || typeof index.lyrics[hash] !== 'object') delete index.lyrics[hash]
      accounts.set(entry.name, index)
      for (const record of Object.values(index.songs)) {
        if (['downloading', 'queued', 'waiting-network'].includes(record.status)) { record.status = 'queued'; record.attempts = 0; record.nextAttempt = 0 }
        if (record.status === 'complete') {
          let valid = false
          try { valid = record.file && (await fsp.stat(filePath(entry.name, record.file))).size === record.size } catch { /* A missing cache file is recoverable on the next real playback. */ }
          if (!valid) { delete record.file; record.status = 'evicted' }
        }
      }
      for (const [key, record] of Object.entries(index.artworks)) {
        if (['downloading', 'queued', 'waiting-network'].includes(record.status)) { record.status = 'queued'; record.attempts = 0; record.nextAttempt = 0 }
        if (record.status === 'complete') {
          let valid = false
          try { valid = record.file && (await fsp.stat(filePath(entry.name, record.file))).size === record.size } catch { /* Loaded artwork can be fetched again. */ }
          if (!valid) delete index.artworks[key]
        }
      }
      // Interrupted files are never published and are removed before resuming the original request.
      const referenced = new Set([...Object.values(index.songs), ...Object.values(index.artworks)].map(record => record.file).filter(Boolean))
      for (const lease of protectedFiles) if (lease.account === entry.name && typeof lease.file === 'string') referenced.add(lease.file)
      for (const child of await fsp.readdir(path.join(root, entry.name), { withFileTypes: true })) {
        if (child.isFile() && child.name !== 'index.json' && (!referenced.has(child.name) || /\.(?:part|tmp)$/.test(child.name))) await fsp.rm(path.join(root, entry.name, child.name), { force: true })
      }
    }
    usedBytes = await diskUsage()
  })()

  function snapshot() {
    return {
      revision: ++revision, generation, userId: session?.userId ?? null, enabled, usedBytes, limitBytes,
      cacheDirectory: root,
      migration: migration ? { phase: migration.phase, copiedBytes: migration.copiedBytes, verifiedBytes: migration.verifiedBytes, totalBytes: migration.totalBytes, targetDirectory: migration.targetRoot } : null,
      migrationWarning,
      cachedSongCount: new Set(Object.values(current?.songs || {}).filter(record => record.status === 'complete' && record.file).map(record => record.hash)).size,
      playlists: (current?.playlists || []).map(playlist => {
        const allHashes = playlist.songs.map(songHash)
        const matching = Object.values(current.songs).filter(record => allHashes.includes(record.hash))
        const hashes = [...new Set(matching.filter(record => record.status === 'complete' && record.file).map(record => record.hash))]
        const statuses = matching.map(record => record.status)
        const status = !enabled || current.paused || playlist.paused ? 'paused'
          : statuses.includes('downloading') || statuses.includes('queued') ? 'caching'
            : statuses.includes('space') ? 'space'
              : statuses.includes('waiting-network') ? 'waiting-network'
                : statuses.includes('failed') ? 'failed' : 'idle'
        return { id: playlist.id, name: playlist.name, isFavorite: playlist.isFavorite, total: allHashes.length, cached: allHashes.filter(hash => hashes.includes(hash)).length, hashes, status, error: matching.find(record => record.error)?.error || null }
      })
    }
  }
  function publish() { if (!stopped) onState(snapshot()) }
  function isCurrent(task) { return !stopped && task.generation === generation && task.account === current?.account && active.get(task.id) === task }
  function isLeased(account, file) { return [...leases.values()].some(lease => lease.account === account && lease.file === file) }
  function selectedPlaylist(id) { return id == null ? current?.playlists.find(item => item.isFavorite) : current?.playlists.find(item => String(item.id) === String(id)) }
  function recordsFor(id) {
    if (!current) return []
    if (id == null) return Object.values(current.songs)
    const hashes = new Set(selectedPlaylist(id)?.songs.map(songHash) || [])
    return Object.values(current.songs).filter(record => hashes.has(record.hash))
  }
  function recordAllowed(record) {
    if (!current || current.paused || current.suppressed) return false
    const playlists = current.playlists.filter(item => item.songs.some(song => songHash(song) === record.hash))
    return !playlists.length || playlists.some(item => !item.paused)
  }

  async function removeRecord(index, record, kind) {
    if (record.file) {
      const file = filePath(index.account, record.file)
      if (isLeased(index.account, record.file)) deferredDeletes.set(file, { account: index.account, file: record.file })
      else await fsp.rm(file, { force: true })
    }
    if (kind === 'song') { delete record.file; delete record.sha256; delete record.size; record.status = 'evicted'; record.error = null }
    else delete index.artworks[record.key]
  }

  /** Reserve all in-flight bytes before writing; active downloads and granted leases are protected. */
  async function reserve(task, bytes) {
    return withCapacity(async () => {
      if (!isCurrent(task) || task.controller.signal.aborted) throw cacheError('CANCELLED', '缓存任务已停止')
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw cacheError('INVALID_AUDIO', '缓存文件长度无效')
      task.reserved = bytes
      try {
        // Reserve metadata growth for completion as well as its full temporary atomic copy.
        const changed = await ensureSpace(largestIndexSize() + 4096)
        await withDisk(async () => { for (const index of changed) await writeIndex(index) })
      } catch (error) {
        task.reserved = 0
        if (error.changed?.size) await withDisk(async () => { for (const index of error.changed) await writeIndex(index) })
        throw error
      }
    })
  }

  async function api(route, params, task) {
    const url = new URL(route, apiBase)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    if (session?.token) url.searchParams.set('cookie', `token=${encodeURIComponent(session.token)};userid=${encodeURIComponent(session.userId)}`)
    const response = await requestStream(url.href, { signal: task.controller.signal, localApi: true, allowLocalTestUrls })
    const chunks = []
    let length = 0
    for await (const chunk of response) {
      length += chunk.length
      if (length > 4 * 1024 ** 2) throw cacheError('INVALID_RESPONSE', '缓存接口响应过大')
      chunks.push(chunk)
    }
    let result
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw cacheError(response.statusCode >= 400 ? 'NETWORK' : 'INVALID_RESPONSE', '缓存接口响应无效') }
    if (Number(result?.error_code ?? result?.data?.error_code) === 20017) throw cacheError('AUTH_EXPIRED', '登录状态已失效')
    if (response.statusCode >= 400 || Number(result?.status) === 0) throw cacheError(Number(result?.status) === 0 ? 'PERMISSION' : 'NETWORK', '暂时无法获取完整歌曲')
    return result
  }

  async function download(task, url, artwork, responseMeta = {}) {
    const response = await requestStream(url, { signal: task.controller.signal, artwork, allowLocalTestUrls })
    const declared = response.headers['content-length'] == null ? null : Number(response.headers['content-length'])
    const expected = declared ?? (Number(responseMeta.filesize) || (artwork ? 8 * 1024 ** 2 : 64 * 1024 ** 2))
    if (artwork && expected > 16 * 1024 ** 2) { response.destroy(); throw cacheError('INVALID_IMAGE', '封面文件过大') }
    try { await reserve(task, expected) } catch (error) { response.destroy(); throw error }
    const base = digest(`${artwork ? 'artwork' : 'audio'}:${task.record.key}`)
    const temporary = filePath(task.account, `${base}.${crypto.randomBytes(8).toString('hex')}.part`)
    let handle
    const sha = crypto.createHash('sha256')
    let head = Buffer.alloc(0)
    try {
      handle = await fsp.open(temporary, 'wx', 0o600)
      for await (const chunk of response) {
        if (!isCurrent(task) || task.controller.signal.aborted) throw cacheError('CANCELLED', '缓存任务已停止')
        if (task.written + chunk.length > task.reserved) throw cacheError('INVALID_AUDIO', '缓存实际长度超过声明长度')
        if (head.length < 8192) head = Buffer.concat([head, chunk.subarray(0, 8192 - head.length)])
        sha.update(chunk)
        await handle.writeFile(chunk)
        task.written += chunk.length
        if (Date.now() - lastUsageReport >= 500) {
          lastUsageReport = Date.now()
          usedBytes = await diskUsage()
          publish()
        }
      }
      const minimum = artwork ? 12 : 128
      if (task.written < minimum || (declared != null && task.written !== declared) || (Number(responseMeta.filesize) > 0 && task.written !== Number(responseMeta.filesize))) throw cacheError('INVALID_AUDIO', '缓存文件传输不完整')
      const format = detectFormat(head, artwork)
      if (!format) throw cacheError(artwork ? 'INVALID_IMAGE' : 'INVALID_AUDIO', '缓存文件格式无效')
      await handle.sync()
      await handle.close()
      handle = null
      if (!isCurrent(task) || task.controller.signal.aborted) throw cacheError('CANCELLED', '缓存任务已停止')
      // A cleared resource can still have an active playback lease; never overwrite it.
      const file = `${base}.${crypto.randomBytes(8).toString('hex')}.${format}`
      await fsp.rename(temporary, filePath(task.account, file))
      if (!isCurrent(task) || task.controller.signal.aborted) {
        await fsp.rm(filePath(task.account, file), { force: true })
        throw cacheError('CANCELLED', '缓存任务已停止')
      }
      return { file, size: task.written, sha256: sha.digest('hex'), extname: format, mime: MIME[format], bitrate: Number(responseMeta.bitrate) || null }
    } finally {
      response.destroy()
      if (handle) await handle.close().catch(() => {})
      await fsp.rm(temporary, { force: true }).catch(() => {})
    }
  }

  async function run(task) {
    const { record, index } = task
    record.status = 'downloading'
    record.error = null
    publish()
    try {
      let result
      if (task.artwork) result = await download(task, record.url, true)
      else {
        let detail = record.song
        if (!detail.album_audio_id) {
          const response = await api('/audio', { hash: record.hash }, task)
          if (Number(response.status) === 1 && response.data?.length) detail = { ...detail, ...publicData(response.data[0]), hash: record.hash }
        }
        const response = await api('/song/url', { hash: record.hash, album_id: detail.album_id || 0, album_audio_id: detail.album_audio_id || 0, quality: record.quality }, task)
        if (Number(response.status) !== 1 || isPreview(response)) throw cacheError('PERMISSION', '没有完整歌曲的缓存权限')
        const url = Array.isArray(response.url) ? response.url[0] : response.url
        if (typeof url !== 'string' || !url) throw cacheError('PERMISSION', '没有完整歌曲的缓存权限')
        result = await download(task, url, false, response)
        result.detail = publicData(detail)
      }
      if (!isCurrent(task)) return
      Object.assign(record, result, { status: 'complete', error: null, attempts: 0, lastUsed: Date.now() })
      await persist(index)
    } catch (error) {
      if (!isCurrent(task) || task.controller.signal.aborted) return
      // Publication can succeed before an index write fails; do not leave unusable quota behind.
      if (record.file) {
        await fsp.rm(filePath(index.account, record.file), { force: true }).catch(() => {})
        delete record.file
        delete record.size
        delete record.sha256
      }
      const permission = ['PERMISSION', 'AUTH_EXPIRED', 'INVALID_AUDIO', 'INVALID_IMAGE', 'INVALID_URL', 'INVALID_RESPONSE'].includes(error.code)
      record.attempts = (record.attempts || 0) + 1
      record.status = error.code === 'SPACE' ? 'space' : !permission && record.attempts < 3 ? 'waiting-network' : 'failed'
      record.error = { code: error.code || 'CACHE_FAILED', message: error.code === 'SPACE' ? '缓存空间不足' : permission ? '歌曲或封面无法完整缓存' : '缓存下载失败，请联网后重试' }
      record.nextAttempt = Date.now() + Math.min(30_000, Math.max(10, retryBaseDelayMs) * 2 ** record.attempts)
      if (error.code === 'AUTH_EXPIRED' && isCurrent(task)) {
        index.paused = true
        onAuthExpired({ generation, userId: session.userId })
        for (const other of active.values()) if (other !== task) { other.record.status = 'queued'; other.controller.abort() }
      }
      await persist(index)
    } finally {
      if (active.get(task.id) === task) active.delete(task.id)
      usedBytes = await diskUsage()
      publish()
      schedule()
    }
  }

  function schedule() {
    if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null }
    if (stopped || migration || !enabled || !session || !current || current.paused || current.suppressed) return
    const queue = [...Object.values(current.songs), ...Object.values(current.artworks)].filter(record => recordAllowed(record) && (record.status === 'queued' || record.status === 'waiting-network' && record.nextAttempt <= Date.now()))
    queue.sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0))
    for (const record of queue) {
      if (active.size >= concurrency) break
      const id = `${current.account}:${record.key}`
      if (active.has(id)) continue
      const task = { id, account: current.account, index: current, record, generation, artwork: record.kind === 'artwork', controller: new AbortController(), reserved: 0, written: 0 }
      active.set(id, task)
      task.promise = run(task).catch(() => { record.status = 'failed'; record.error = { code: 'DISK', message: '缓存文件写入失败，请检查磁盘' }; publish() })
    }
    const waiting = Object.values(current.songs).concat(Object.values(current.artworks)).filter(record => record.status === 'waiting-network' && recordAllowed(record))
    if (waiting.length) {
      const delay = Math.max(100, Math.min(...waiting.map(record => record.nextAttempt)) - Date.now())
      schedulerTimer = setTimeout(() => { schedulerTimer = null; schedule() }, delay)
      schedulerTimer.unref?.()
    }
  }

  async function cancelActive(status = 'queued', predicate = () => true) {
    const tasks = [...active.values()].filter(predicate)
    for (const task of tasks) { if (task.record.status === 'downloading') task.record.status = status; task.controller.abort() }
    await Promise.allSettled(tasks.map(task => task.promise))
    for (const index of new Set(tasks.map(task => task.index))) await persist(index)
  }

  /** Resolve every existing directory component without following user-supplied links. */
  async function migrationDirectory(directory, allowMissingLeaf = false) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw cacheError('CACHE_MIGRATION_PATH', '请选择有效的绝对目录。')
    const resolved = path.resolve(directory)
    const parts = []
    for (let currentPath = resolved; ; currentPath = path.dirname(currentPath)) {
      parts.unshift(currentPath)
      if (path.dirname(currentPath) === currentPath) break
    }
    for (const currentPath of parts) {
      let stat
      try { stat = await fsp.lstat(currentPath) } catch (error) {
        if (allowMissingLeaf && currentPath === resolved && error.code === 'ENOENT') return path.join(await fsp.realpath(path.dirname(resolved)), path.basename(resolved))
        throw error
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw cacheError('CACHE_MIGRATION_PATH', '缓存目录不能是文件、符号链接或目录链接。')
    }
    return fsp.realpath(resolved)
  }

  function migrationPathsOverlap(first, second) {
    const relative = path.relative(first, second)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }

  function sameFile(first, second) { return first.dev === second.dev && first.ino === second.ino }

  async function migrationHash(filename, transaction, report = false) {
    const hash = crypto.createHash('sha256')
    const handle = await fsp.open(filename, 'r')
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024)
      let position = 0
      while (true) {
        if (stopped) throw cacheError('CACHE_MIGRATION_CANCELLED', '应用正在退出，缓存迁移已停止。')
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
        if (!bytesRead) break
        position += bytesRead
        hash.update(buffer.subarray(0, bytesRead))
        if (report) { transaction.verifiedBytes += bytesRead; migrationProgress(transaction) }
      }
      return hash.digest('hex')
    } finally { await handle.close() }
  }

  function migrationProgress(transaction, force = false) {
    if (!force && Date.now() - transaction.lastReport < 100) return
    transaction.lastReport = Date.now()
    publish()
  }

  /** Delete only files created/copied by this transaction; unrelated or replaced files survive. */
  async function removeMigrationFiles(transaction, directory, source = false) {
    let complete = true
    try { await migrationDirectory(directory) } catch (error) { return error.code === 'ENOENT' }
    for (const entry of transaction.entries) {
      const filename = path.join(directory, entry.relative)
      try {
        await migrationDirectory(path.dirname(filename))
        const stat = await fsp.lstat(filename)
        const expected = source ? entry.sourceStat : entry.targetStat
        if (!expected || !stat.isFile() || stat.isSymbolicLink() || !sameFile(stat, expected)) { complete = false; continue }
        // A second client or external process might have updated the old cache after the snapshot.
        if ((source || transaction.published && directory === transaction.targetRoot) && (stat.size !== entry.size || await migrationHash(filename, transaction) !== entry.sha256)) { complete = false; continue }
        if (source) {
          const account = path.dirname(entry.relative)
          const name = path.basename(entry.relative)
          const index = accounts.get(account)
          const referenced = name === 'index.json' || isLeased(account, name) || index && [...Object.values(index.songs), ...Object.values(index.artworks)].some(record => record.file === name)
          if (referenced) {
            const destination = path.join(root, entry.relative)
            await migrationDirectory(path.dirname(destination))
            const targetStat = await fsp.lstat(destination)
            if (!targetStat.isFile() || targetStat.isSymbolicLink()) { complete = false; continue }
            const exact = targetStat.size === entry.size && await migrationHash(destination, transaction) === entry.sha256
            // Normal LRU/queue changes atomically rewrite index.json after commit.
            if (!exact && !(name === 'index.json' && index && await fsp.readFile(destination, 'utf8') === JSON.stringify(index))) { complete = false; continue }
          }
        }
        await fsp.unlink(filename)
      } catch (error) { if (error.code !== 'ENOENT') complete = false }
    }
    for (const name of transaction.directories.slice().reverse()) {
      try { await migrationDirectory(path.join(directory, name)); await fsp.rmdir(path.join(directory, name)) } catch (error) { if (error.code !== 'ENOENT') complete = false }
    }
    if (source || !transaction.targetExisted || directory !== transaction.targetRoot) {
      try { await fsp.rmdir(directory) } catch (error) { if (error.code !== 'ENOENT') complete = false }
    }
    return complete
  }

  /** Freeze writes, copy all account data to a private staging folder, then publish a verified target. */
  async function prepareMigration(payload) {
    if (migration) throw cacheError('CACHE_MIGRATION_BUSY', '缓存正在迁移，请等待完成。')
    const sourceRoot = await migrationDirectory(root)
    const targetRoot = await migrationDirectory(payload?.targetRoot, true)
    if (migrationPathsOverlap(sourceRoot, targetRoot) || migrationPathsOverlap(targetRoot, sourceRoot)) throw cacheError('CACHE_MIGRATION_PATH', '新目录不能与当前缓存目录相同，也不能互相包含。')
    let targetExisted = false
    try {
      if ((await fsp.readdir(targetRoot)).length) throw cacheError('CACHE_MIGRATION_NOT_EMPTY', '目标缓存目录已有文件，请选择其他位置，原有文件不会被覆盖。')
      targetExisted = true
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const transaction = { sourceRoot: root, targetRoot, targetExisted, stagingRoot: null, publishing: false, published: false, phase: 'copying', copiedBytes: 0, verifiedBytes: 0, totalBytes: 0, lastReport: 0, entries: [], directories: [] }
    migration = transaction
    migrationWarning = null
    migrationProgress(transaction, true)
    try {
      if (schedulerTimer) clearTimeout(schedulerTimer)
      schedulerTimer = null
      await cancelActive()
      await capacityChain
      await diskChain
      // Flush normalized indices and the cancelled queue before any file is copied.
      await withDisk(async () => { for (const index of accounts.values()) await writeIndex(index) })
      for (const directory of await fsp.readdir(sourceRoot, { withFileTypes: true })) {
        if (directory.isSymbolicLink()) throw cacheError('CACHE_MIGRATION_PATH', '原缓存中存在链接，请先检查缓存目录。')
        if (!directory.isDirectory() || !/^[a-f\d]{64}$/.test(directory.name)) continue
        await migrationDirectory(path.join(sourceRoot, directory.name))
        transaction.directories.push(directory.name)
        for (const entry of await fsp.readdir(path.join(sourceRoot, directory.name), { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw cacheError('CACHE_MIGRATION_PATH', '原缓存中存在链接，请先检查缓存目录。')
          if (!entry.isFile() || (entry.name !== 'index.json' && !/^[a-f\d]{64}(?:\.[a-z\d]{1,16}){1,2}$/.test(entry.name))) continue
          const relative = path.join(directory.name, entry.name)
          const sourceStat = await fsp.lstat(path.join(sourceRoot, relative))
          if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw cacheError('CACHE_MIGRATION_PATH', '原缓存文件发生变化，请重试。')
          transaction.entries.push({ relative, size: sourceStat.size, sourceStat })
          transaction.totalBytes += sourceStat.size
        }
      }
      if (typeof fsp.statfs === 'function') {
        const disk = await fsp.statfs(path.dirname(targetRoot))
        if (disk.bavail * disk.bsize < transaction.totalBytes) throw cacheError('CACHE_MIGRATION_SPACE', '目标磁盘空间不足，请更换目录或释放空间后重试。')
      }
      transaction.stagingRoot = await fsp.mkdtemp(path.join(path.dirname(targetRoot), `.${path.basename(targetRoot)}.migration-`))
      for (const name of transaction.directories) await fsp.mkdir(path.join(transaction.stagingRoot, name))
      migrationProgress(transaction, true)
      const buffer = Buffer.allocUnsafe(256 * 1024)
      for (const entry of transaction.entries) {
        if (stopped) throw cacheError('CACHE_MIGRATION_CANCELLED', '应用正在退出，缓存迁移已停止。')
        const source = path.join(sourceRoot, entry.relative)
        const destination = path.join(transaction.stagingRoot, entry.relative)
        let input, output
        try {
          input = await fsp.open(source, 'r')
          if (!sameFile(await input.stat(), entry.sourceStat)) throw cacheError('CACHE_MIGRATION_CHANGED', '缓存文件在迁移期间发生变化，请重试。')
          output = await fsp.open(destination, 'wx', 0o600)
          entry.targetStat = await output.stat()
          const hash = crypto.createHash('sha256')
          let position = 0
          while (true) {
            if (stopped) throw cacheError('CACHE_MIGRATION_CANCELLED', '应用正在退出，缓存迁移已停止。')
            const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
            if (!bytesRead) break
            hash.update(buffer.subarray(0, bytesRead))
            for (let written = 0; written < bytesRead;) {
              const result = await output.write(buffer, written, bytesRead - written, position + written)
              if (!result.bytesWritten) throw cacheError('CACHE_MIGRATION_WRITE', '无法完整写入目标缓存，请检查磁盘。')
              written += result.bytesWritten
            }
            position += bytesRead
            transaction.copiedBytes += bytesRead
            migrationProgress(transaction)
          }
          const after = await input.stat()
          if (position !== entry.size || after.size !== entry.size || after.mtimeMs !== entry.sourceStat.mtimeMs) throw cacheError('CACHE_MIGRATION_CHANGED', '缓存文件在迁移期间发生变化，请重试。')
          entry.sha256 = hash.digest('hex')
          await output.sync()
        } finally {
          await Promise.all([input?.close(), output?.close()])
        }
      }
      transaction.phase = 'verifying'
      migrationProgress(transaction, true)
      for (const entry of transaction.entries) {
        const filename = path.join(transaction.stagingRoot, entry.relative)
        if ((await fsp.stat(filename)).size !== entry.size || await migrationHash(filename, transaction, true) !== entry.sha256) throw cacheError('CACHE_MIGRATION_VERIFY', '迁移后的缓存校验失败，仍使用原目录，请重试。')
      }
      // Publish only complete data. A crash during copying leaves the chosen target reusable.
      await migrationDirectory(targetRoot, true)
      try {
        if ((await fsp.readdir(targetRoot)).length) throw cacheError('CACHE_MIGRATION_NOT_EMPTY', '目标缓存目录已有文件，请选择其他位置，原有文件不会被覆盖。')
        await fsp.rmdir(targetRoot)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      // Some Windows filesystem filters refuse renaming a nonempty directory even after all
      // handles close. Fall back to moving verified files into an exclusively created target.
      for (let attempt = 0; ; attempt++) {
        try { await fsp.rename(transaction.stagingRoot, targetRoot); break } catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
          if (attempt >= 2) {
            await fsp.mkdir(targetRoot)
            transaction.publishing = true
            for (const name of transaction.directories) await fsp.mkdir(path.join(targetRoot, name))
            for (const entry of transaction.entries) {
              const destination = path.join(targetRoot, entry.relative)
              let occupied = false
              try { await fsp.lstat(destination); occupied = true } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
              if (occupied) throw cacheError('CACHE_MIGRATION_NOT_EMPTY', '目标缓存目录出现其他文件，迁移已停止，原有文件不会被覆盖。')
              await fsp.rename(path.join(transaction.stagingRoot, entry.relative), destination)
            }
            for (const name of transaction.directories) await fsp.rmdir(path.join(transaction.stagingRoot, name))
            await fsp.rmdir(transaction.stagingRoot)
            break
          }
          await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
        }
      }
      transaction.published = true
      transaction.phase = 'committing'
      migrationProgress(transaction, true)
      return { ...snapshot(), targetRoot }
    } catch (error) {
      const cleanupRoots = new Set([transaction.stagingRoot, transaction.published || transaction.publishing ? targetRoot : null].filter(Boolean))
      for (const directory of cleanupRoots) if (!await removeMigrationFiles(transaction, directory)) migrationWarning = { code: 'CACHE_MIGRATION_CLEANUP', message: '迁移未生效，部分临时副本未能清理；原缓存保持可用。' }
      migration = null
      publish()
      schedule()
      if (String(error.code).startsWith('CACHE_MIGRATION_')) throw error
      const reason = error.code === 'ENOSPC' ? '目标磁盘空间不足，请释放空间后重试。' : ['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? '无法写入所选目录，请选择有写入权限的位置。' : '缓存迁移失败，仍使用原目录，请检查磁盘后重试。'
      throw Object.assign(cacheError('CACHE_MIGRATION_FAILED', reason), { cause: error })
    }
  }

  /** Called only after the main process durably saves targetRoot; this phase changes memory only. */
  function commitMigration() {
    if (!migration?.published || migration.phase !== 'committing') throw cacheError('CACHE_MIGRATION_STATE', '缓存迁移尚未完成复制校验。')
    const transaction = migration
    root = transaction.targetRoot
    for (const lease of leases.values()) lease.path = filePath(lease.account, lease.file)
    const deferred = [...deferredDeletes.values()]
    deferredDeletes.clear()
    for (const entry of deferred) deferredDeletes.set(filePath(entry.account, entry.file), entry)
    retiredDirectories.push(transaction)
    migration = null
    publish()
    schedule()
    return snapshot()
  }

  /** A failed settings save discards only this transaction's copy and resumes the original queue. */
  async function rollbackMigration() {
    if (!migration) return snapshot()
    const transaction = migration
    if (transaction.stagingRoot && !await removeMigrationFiles(transaction, transaction.published ? transaction.targetRoot : transaction.stagingRoot)) migrationWarning = { code: 'CACHE_MIGRATION_CLEANUP', message: '迁移未生效，部分临时副本未能清理；原缓存保持可用。' }
    migration = null
    publish()
    schedule()
    return snapshot()
  }

  /** The main process waits for reads opened against old paths before requesting source cleanup. */
  async function finalizeMigration() {
    for (let index = retiredDirectories.length - 1; index >= 0; index--) {
      const transaction = retiredDirectories[index]
      if (await removeMigrationFiles(transaction, transaction.sourceRoot, true)) retiredDirectories.splice(index, 1)
    }
    migrationWarning = retiredDirectories.length ? { code: 'CACHE_MIGRATION_CLEANUP', message: '新缓存目录已生效，部分原目录文件被占用或已更改，暂时保留。' } : null
    publish()
    return snapshot()
  }

  async function configure(settings = {}) {
    await ready
    const download = settings.download || settings
    enabled = download.offlinePlaylistCacheEnabled !== false
    concurrency = Number.isInteger(download.concurrentDownloads) ? Math.max(1, Math.min(10, download.concurrentDownloads)) : 3
    const size = CACHE_LIMITS[download.cacheSizeIndex] ?? CACHE_LIMITS[0]
    const previousLimit = limitBytes
    limitBytes = limitBytesOverride ?? (size < 0 ? -1 : size * 1024 ** 2)
    qualityPreference = normalizeQuality(settings.playback?.quality)
    if (!enabled || limitBytes >= 0 && (previousLimit < 0 || limitBytes < previousLimit)) await cancelActive()
    await trim()
    publish()
    schedule()
    return snapshot()
  }

  async function setSession(value, nextGeneration) {
    await ready
    generation = nextGeneration
    session = null
    await cancelActive()
    current = null
    if (value?.userId && value?.token) {
      session = { userId: String(value.userId), token: String(value.token) }
      const account = digest(session.userId)
      current = accounts.get(account) || emptyIndex(account)
      accounts.set(account, current)
      await fsp.mkdir(path.join(root, account), { recursive: true })
    }
    publish()
    schedule()
    return snapshot()
  }

  async function putPlaylist(payload) {
    if (!current) return null
    if (!payload || !Array.isArray(payload.songs) || payload.songs.length > 20_000 || payload.id == null || String(payload.id).length > 128 || Buffer.byteLength(JSON.stringify(payload)) > 16 * 1024 ** 2) throw cacheError('INVALID_PLAYLIST', '歌单缓存参数无效')
    const index = current
    const favorite = payload.isFavorite === true
    const previous = selectedPlaylist(payload.id)
    const item = { id: String(payload.id), name: String(payload.name || (favorite ? '我喜欢' : '歌单')).slice(0, 500), isFavorite: favorite || previous?.isFavorite === true, songs: publicData(payload.songs), openedAt: Date.now(), paused: previous?.paused === true }
    const previousPlaylists = index.playlists
    index.playlists = index.playlists.filter(previous => previous.id !== item.id && !(favorite && previous.isFavorite))
    index.playlists.unshift(item)
    let count = 0
    index.playlists = index.playlists.filter(playlist => playlist.isFavorite || ++count <= 10)
    try { await persist(index) } catch (error) { index.playlists = previousPlaylists; throw error }
    usedBytes = await diskUsage()
    publish()
    schedule()
    return copy(item)
  }

  async function cacheSong(payload) {
    if (!current || !enabled) return snapshot()
    const hash = songHash(payload?.song)
    if (!hash) throw cacheError('INVALID_SONG', '歌曲缓存参数无效')
    if (Buffer.byteLength(JSON.stringify(payload.song)) > 2 * 1024 ** 2) throw cacheError('INVALID_SONG', '歌曲缓存参数过大')
    const quality = normalizeQuality(payload.quality ?? qualityPreference)
    const key = `${hash}:${quality}`
    const existing = current.songs[key]
    if (existing?.status === 'complete' || active.has(`${current.account}:${key}`)) return snapshot()
    current.suppressed = false
    const record = { key, hash, quality, kind: 'song', song: { ...publicData(payload.song), hash }, status: 'queued', attempts: 0, nextAttempt: 0, requestedAt: Date.now(), error: null }
    current.songs[key] = record
    await persist(current)
    schedule()
    publish()
    return snapshot()
  }

  async function verify(index, record) {
    if (!record?.file || record.status !== 'complete') return false
    let target
    try {
      target = filePath(index.account, record.file)
      const stat = await fsp.stat(target)
      if (!stat.isFile() || stat.size !== record.size) return false
      const hash = crypto.createHash('sha256')
      for await (const chunk of fs.createReadStream(target)) hash.update(chunk)
      return hash.digest('hex') === record.sha256
    } catch { return false }
  }

  async function acquire(record) {
    const index = current
    if (!index || !record?.file || record.status !== 'complete') return null
    const leaseId = crypto.randomBytes(24).toString('hex')
    const resource = { leaseId, account: index.account, file: record.file, path: filePath(index.account, record.file), size: record.size, mime: record.mime, extname: record.extname, bitrate: record.bitrate, requestedQuality: record.quality, detail: record.detail || record.song || null, status: 1 }
    leases.set(leaseId, resource)
    if (!(await verify(index, record))) {
      leases.delete(leaseId)
      await removeRecord(index, record, record.kind)
      await persist(index)
      publish()
      return null
    }
    record.lastUsed = Date.now()
    // A full disk must not prevent playback of a valid leased file just to update its LRU time.
    await persist(index).catch(() => {})
    return copy(resource)
  }

  async function trim() {
    return withCapacity(async () => {
      let changed
      try { changed = await ensureSpace(largestIndexSize()) } catch (error) { changed = error.changed || new Set() }
      if (changed.size) await withDisk(async () => { for (const index of changed) await writeIndex(index) })
      usedBytes = await diskUsage()
    })
  }

  async function getSource(payload) {
    const hash = normalizeHash(payload?.hash)
    if (!hash || !current) return null
    const quality = normalizeQuality(payload.quality)
    const preferred = current.songs[`${hash}:${quality}`]
    const exact = await acquire(preferred)
    if (exact || !payload.allowFallback) return exact
    for (const record of Object.values(current.songs)) if (record.hash === hash && record !== preferred) { const source = await acquire(record); if (source) return source }
    return null
  }

  async function releaseSource(leaseId) {
    const lease = leases.get(leaseId)
    if (!lease) return false
    leases.delete(leaseId)
    const target = filePath(lease.account, lease.file)
    const index = accounts.get(lease.account)
    const referenced = index && [...Object.values(index.songs), ...Object.values(index.artworks)].some(record => record.file === lease.file)
    if ((deferredDeletes.has(target) || !referenced) && !isLeased(lease.account, lease.file)) {
      await fsp.rm(target, { force: true })
      deferredDeletes.delete(target)
      usedBytes = await diskUsage()
      publish()
    }
    await trim()
    return true
  }

  async function cacheArtwork(raw) {
    if (!current || !enabled || typeof raw !== 'string' || raw.length > 4096 || (!allowedArtworkUrl(raw) && !(allowLocalTestUrls && /^http:\/\/127\.0\.0\.1:\d+\//.test(raw)))) return null
    const key = digest(raw)
    const existing = current.artworks[key]
    if (existing?.status === 'complete' || active.has(`${current.account}:${key}`)) return snapshot()
    current.artworks[key] = { key, kind: 'artwork', url: raw, status: 'queued', attempts: 0, requestedAt: Date.now() }
    await persist(current)
    schedule()
    return snapshot()
  }

  async function putLyrics(payload) {
    if (!current || !enabled || current.suppressed || !normalizeHash(payload?.hash) || !payload.data || typeof payload.data !== 'object') return null
    const data = {}
    for (const [key, value] of Object.entries(payload.data)) if (LYRIC_FIELDS.has(key)) data[key] = publicData(value, 0, 2 * 1024 ** 2)
    if (Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 ** 2) throw cacheError('INVALID_LYRICS', '歌词缓存过大')
    const delta = Buffer.byteLength(JSON.stringify(data))
    usedBytes = await diskUsage()
    if (limitBytes >= 0 && usedBytes + delta + 4096 > limitBytes) return null
    current.lyrics[normalizeHash(payload.hash)] = data
    await persist(current)
    usedBytes = await diskUsage()
    publish()
    return copy(data)
  }

  async function control(action, id) {
    if (!current) return snapshot()
    const playlist = id == null ? null : selectedPlaylist(id)
    if (id != null && !playlist) return snapshot()
    if (action === 'pause') {
      if (playlist) playlist.paused = true
      else current.paused = true
      await cancelActive('queued', task => !recordAllowed(task.record))
    } else {
      if (playlist) playlist.paused = false
      else { current.paused = false; for (const item of current.playlists) item.paused = false }
      current.suppressed = false
      const records = id == null ? [...Object.values(current.songs), ...Object.values(current.artworks)] : recordsFor(id)
      if (action === 'retry') for (const record of records) if (['waiting-network', 'failed', 'space'].includes(record.status)) { record.status = 'queued'; record.attempts = 0; record.nextAttempt = 0; record.error = null }
    }
    await persist(current)
    publish()
    schedule()
    return snapshot()
  }

  async function clear() {
    if (!current) return snapshot()
    const index = current
    index.suppressed = true
    await cancelActive()
    for (const record of Object.values(index.songs)) await removeRecord(index, record, 'song')
    for (const record of [...Object.values(index.artworks)]) await removeRecord(index, record, 'artwork')
    index.songs = {}
    index.artworks = {}
    index.lyrics = {}
    await persist(index)
    usedBytes = await diskUsage()
    publish()
    return snapshot()
  }

  async function stop() {
    stopped = true
    if (schedulerTimer) clearTimeout(schedulerTimer)
    schedulerTimer = null
    await cancelActive()
    await diskChain
  }

  async function readPlaylist(id) {
    const playlist = selectedPlaylist(id)
    if (!playlist) return null
    playlist.openedAt = Date.now()
    current.playlists = [playlist, ...current.playlists.filter(item => item !== playlist)]
    await persist(current)
    publish()
    return copy(playlist)
  }

  async function retryNetwork() {
    if (!current || current.suppressed) return snapshot()
    for (const record of [...Object.values(current.songs), ...Object.values(current.artworks)]) {
      if (['waiting-network', 'failed'].includes(record.status) && record.error?.code === 'NETWORK') {
        record.status = 'queued'
        record.attempts = 0
        record.nextAttempt = 0
        record.error = null
      }
    }
    await persist(current)
    publish()
    schedule()
    return snapshot()
  }

  async function dispatch(action, payload, requestGeneration) {
    await ready
    if (action === 'prepareMigration') return prepareMigration(payload)
    if (action === 'commitMigration') return commitMigration()
    if (action === 'rollbackMigration') return rollbackMigration()
    if (action === 'finalizeMigration') return finalizeMigration()
    if (migration && !['getState', 'stop'].includes(action)) throw cacheError('CACHE_MIGRATION_BUSY', '缓存正在迁移，请等待完成。')
    if (action === 'bootstrap') {
      for (const lease of payload?.leases || []) {
        try { if (filePath(lease.account, lease.file) === lease.path) leases.set(lease.leaseId, lease) } catch { /* Invalid private descriptors are not restored. */ }
      }
      await configure(payload.settings)
      return setSession(payload.session, requestGeneration)
    }
    if (action === 'configure') return configure(payload)
    if (action === 'setSession') return setSession(payload, requestGeneration)
    if (action === 'stop') return stop()
    if (action === 'releaseSource') return releaseSource(payload?.leaseId)
    if (requestGeneration !== generation || stopped) return null
    switch (action) {
      case 'getState': return snapshot()
      case 'readPlaylist': return readPlaylist(payload?.id)
      case 'putPlaylist': return putPlaylist(payload)
      case 'cacheSong': return cacheSong(payload)
      case 'getSource': return getSource(payload)
      case 'readLyrics': return copy(current?.lyrics[normalizeHash(payload?.hash)] || null)
      case 'putLyrics': return putLyrics(payload)
      case 'getArtwork': return acquire(current?.artworks[digest(String(payload?.url || ''))])
      case 'cacheArtwork': return cacheArtwork(payload?.url)
      case 'pause': case 'resume': case 'retry': return control(action, payload?.id)
      case 'retryNetwork': return retryNetwork()
      case 'clear': return clear()
      default: throw cacheError('INVALID_ACTION', '缓存操作无效')
    }
  }

  return { dispatch, ready, stop, snapshot }
}

if (!isMainThread && parentPort) {
  const engine = createCacheEngine({ ...workerData, onState: state => parentPort.postMessage({ type: 'state', state }), onAuthExpired: identity => parentPort.postMessage({ type: 'authExpired', ...identity }) })
  let commands = Promise.resolve()
  parentPort.on('message', message => {
    commands = commands.then(async () => {
      try {
        const result = await engine.dispatch(message.action, message.payload, message.generation)
        parentPort.postMessage({ id: message.id, type: 'result', result })
        if (message.action === 'stop') parentPort.close()
      } catch (error) {
        parentPort.postMessage({ id: message.id, type: 'error', error: { code: error.code || 'CACHE_FAILED', message: ['INVALID_SONG', 'INVALID_PLAYLIST', 'INVALID_LYRICS'].includes(error.code) || String(error.code).startsWith('CACHE_MIGRATION_') ? error.message : '缓存操作失败，请重试' } })
      }
    })
  })
}

module.exports = { createCacheEngine, allowedArtworkUrl, privateAddress, detectFormat, isPreview, normalizeHash }
