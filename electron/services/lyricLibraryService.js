const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * MAX_CONTENT_BYTES
const MAX_RECORD_BYTES = 16 * MAX_CONTENT_BYTES
const MATCH_RANK = { any: 0, medium: 1, high: 2, exact: 3 }
const PRIVATE_KEY = /access.?key|token|cookie|password|authorization|credential|secret|private.?key/i
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const LANGUAGE_KEYS = new Set(['language', 'trans', 'translation', 'lang', 'multilang', 'lyric_translation', 'lyricTranslation', 'translationData', 'romanization', 'romaji'])

function libraryError(code, message) {
  return Object.assign(new Error(message), { code })
}

function hashKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw libraryError('LYRIC_INVALID_HASH', '歌曲标识无效。')
  }
  return value.toLowerCase()
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function shortText(value) { return typeof value === 'string' ? value.slice(0, 300) : '' }

/** 编辑器统一消费 UTF-8 正文；只解码规范 Base64 的时间轴歌词，拒绝未解压的 KRC。 */
function decodedContent(data) {
  if (typeof data.decodeContent === 'string' && data.decodeContent.trim()) return data.decodeContent
  const content = [data.content, data.data?.content].find(value => typeof value === 'string' && value.trim())
  if (!content) throw libraryError('LYRIC_EMPTY', '歌词内容不能为空。')
  if (content.startsWith('krc1')) throw libraryError('LYRIC_COMPRESSED', '歌词尚未解压，请重新获取在线歌词后再保存。')
  const compact = content.replace(/\s/g, '')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 !== 1) {
    const bytes = Buffer.from(compact, 'base64')
    if (bytes.toString('base64').replace(/=+$/, '') === compact.replace(/=+$/, '')) {
      if (bytes.subarray(0, 4).toString('ascii') === 'krc1') throw libraryError('LYRIC_COMPRESSED', '歌词尚未解压，请重新获取在线歌词后再保存。')
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (/^\s*\[(?:\d+,\d+|\d{1,3}:\d{2}(?:\.\d{1,3})?)\]/m.test(decoded)) return decoded
      } catch {
        // 非 UTF-8 Base64 不被猜测为歌词；无压缩标记的输入仍按原始文本处理。
      }
    }
  }
  return content
}

/** 翻译按源行排列；行时间结构改变时不能继续继承旧行索引。 */
function prepareEditedData(baseData, content) {
  const data = clone(baseData)
  const signature = value => JSON.stringify(value.split(/\r\n|\n|\r/).flatMap(line => {
    const tag = line.trimStart().match(/^(?:\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+|^\[\d+,\d+\]/)?.[0]
    return tag ? [tag] : []
  }))
  const languageTag = value => value.match(/^\s*\[language:(.*)\]\s*$/m)?.[1] || ''
  const oldLanguage = languageTag(data.decodeContent)
  const newLanguage = languageTag(content)
  const structureChanged = signature(data.decodeContent) !== signature(content)
  const languageEdited = oldLanguage !== newLanguage
  let removedLanguage = false
  function clearLanguage(value) {
    if (!value || typeof value !== 'object') return
    for (const key of Object.keys(value)) {
      if (LANGUAGE_KEYS.has(key)) {
        removedLanguage = removedLanguage || Boolean(value[key])
        delete value[key]
      } else clearLanguage(value[key])
    }
  }
  if (structureChanged || languageEdited) {
    clearLanguage(data)
    if (structureChanged && !languageEdited) {
      content = content.replace(/^[ \t]*\[language:.*\][ \t]*(?:\r?\n|$)/gm, '')
      removedLanguage = removedLanguage || Boolean(oldLanguage)
    }
  }
  // 编辑副本只保留一个正文入口；在线原始编码仍完整留在原版本。
  delete data.content
  if (data.data && typeof data.data === 'object') delete data.data.content
  data.decodeContent = content
  const replacementLanguage = languageEdited && Boolean(newLanguage)
  const removedEmbeddedLanguage = Boolean(oldLanguage && (languageEdited || structureChanged))
  return { data, languageReset: !replacementLanguage && Boolean(removedLanguage || removedEmbeddedLanguage) }
}

/** 保留歌词响应的 JSON 结构，递归剔除凭证和危险键，不保存搜索访问密钥。 */
function normalizeData(input) {
  const seen = new WeakSet()
  function visit(value, depth = 0) {
    if (depth > 20) throw libraryError('LYRIC_INVALID_DATA', '歌词数据层级过深。')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || seen.has(value)) {
      throw libraryError('LYRIC_INVALID_DATA', '歌词数据格式无效。')
    }
    seen.add(value)
    const result = Array.isArray(value) ? value.map(item => visit(item, depth + 1)) : {}
    if (!Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (!UNSAFE_KEYS.has(key) && !PRIVATE_KEY.test(key) && item !== undefined) result[key] = visit(item, depth + 1)
      }
    }
    seen.delete(value)
    return result
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw libraryError('LYRIC_INVALID_DATA', '歌词数据格式无效。')
  const data = visit(input)
  data.decodeContent = decodedContent(data)
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_RESPONSE_BYTES) throw libraryError('LYRIC_TOO_LARGE', '歌词数据超过 2 MB。')
  if (data.status !== 1 && data.status !== 200) throw libraryError('LYRIC_INVALID_DATA', '不能保存未成功取得的歌词。')
  return data
}

/** 独立保存原始歌词版本；串行读写和原子替换保护用户编辑，关闭功能不删除数据。 */
function createLyricLibraryService(options) {
  const root = path.resolve(options.root)
  const disk = options.fs || fs
  const logger = options.logger || { warn() {}, error() {} }
  let policy = { enabled: true, autoSave: true, minMatch: 'high', autoUpdate: true }
  let generation = 0
  let revision = 0
  let stopped = false
  let queue = Promise.resolve()
  let stopPromise

  const fileFor = hash => path.join(root, `${digest(hash)}.json`)
  const active = epoch => !stopped && policy.enabled && generation === epoch

  function configure(settings) {
    const next = settings?.playback?.lyricLibrary || {}
    const normalized = {
      enabled: typeof next.enabled === 'boolean' ? next.enabled : true,
      autoSave: typeof next.autoSave === 'boolean' ? next.autoSave : true,
      minMatch: Object.hasOwn(MATCH_RANK, next.minMatch) ? next.minMatch : 'high',
      autoUpdate: typeof next.autoUpdate === 'boolean' ? next.autoUpdate : true
    }
    if (JSON.stringify(normalized) !== JSON.stringify(policy)) generation += 1
    policy = normalized
  }

  function requireActive(epoch) {
    if (!active(epoch)) throw libraryError('LYRIC_LIBRARY_DISABLED', '歌词管理设置已变更，请重试。')
  }

  function enqueue(callback) {
    const operation = queue.then(callback)
    queue = operation.catch(() => {}) // 单笔失败由调用方处理，后继保存仍可继续。
    return operation
  }

  /** 只读取本服务创建的摘要文件；损坏数据保留原件并向管理界面报告。 */
  async function readRecord(hash) {
    const filename = fileFor(hash)
    let text
    try {
      const info = await disk.stat(filename)
      if (info.size > MAX_RECORD_BYTES) throw libraryError('LYRIC_CORRUPT', '保存的歌词文件过大，无法读取。')
      text = await disk.readFile(filename, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    let record
    try {
      record = JSON.parse(text)
      if (!record || record.hash !== hash || !Array.isArray(record.versions) || !record.versions.length || record.versions.length > 100) throw new Error('Invalid record')
      const ids = new Set()
      record.versions = record.versions.map(version => {
        if (!version || typeof version.id !== 'string' || !/^(online-[a-f0-9]{64}|edited-[a-f0-9-]{36})$/.test(version.id) || ids.has(version.id) || !['online', 'edited'].includes(version.source)) throw new Error('Invalid version')
        ids.add(version.id)
        return {
          id: version.id, source: version.source, sourceId: shortText(version.sourceId),
          createdAt: Number.isFinite(version.createdAt) ? version.createdAt : 0,
          updatedAt: Number.isFinite(version.updatedAt) ? version.updatedAt : 0,
          matchLevel: Object.hasOwn(MATCH_RANK, version.matchLevel) ? version.matchLevel : 'any',
          languageReset: version.languageReset === true,
          data: normalizeData(version.data)
        }
      })
      if (!ids.has(record.selectedVersionId)) throw new Error('Invalid selection')
      return {
        hash, title: shortText(record.title), artist: shortText(record.artist),
        selectedVersionId: record.selectedVersionId, selectionMode: record.selectionMode === 'manual' ? 'manual' : 'auto',
        updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0, versions: record.versions
      }
    } catch (error) {
      logger.warn('lyric-library', '读取歌词版本失败，保留原文件', { code: error.code, name: error.name })
      throw libraryError('LYRIC_CORRUPT', '保存的歌词数据损坏，原文件已保留。')
    }
  }

  async function persist(record, epoch, reason) {
    requireActive(epoch)
    const serialized = JSON.stringify(record)
    if (record.versions.length > 100 || Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
      throw libraryError('LYRIC_LIBRARY_FULL', '这首歌保存的版本过多，现有版本已保留。')
    }
    await disk.mkdir(root, { recursive: true })
    const temporary = path.join(root, `${digest(record.hash)}.${randomUUID()}.tmp`)
    try {
      await disk.writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      requireActive(epoch)
      await disk.rename(temporary, fileFor(record.hash))
    } catch (error) {
      try { await disk.unlink(temporary) } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') logger.warn('lyric-library', '清理歌词临时文件失败', { code: cleanupError.code, name: cleanupError.name })
      }
      throw error
    }
    revision += 1
    if (active(epoch)) {
      try { options.onChanged?.({ hash: record.hash, revision, reason }) } catch (error) {
        logger.warn('lyric-library', '歌词更新通知失败', { code: error.code, name: error.name })
      }
    }
    return clone(record)
  }

  function read(value) {
    const epoch = generation
    if (!active(epoch)) return Promise.resolve(null)
    const hash = hashKey(value)
    return enqueue(async () => {
      if (!active(epoch)) return null
      const record = await readRecord(hash)
      return active(epoch) ? record : null
    })
  }

  function list() {
    const epoch = generation
    if (!active(epoch)) return Promise.resolve([])
    return enqueue(async () => {
      if (!active(epoch)) return []
      let entries
      try { entries = await disk.readdir(root, { withFileTypes: true }) } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      const records = []
      for (const entry of entries) {
        if (!active(epoch)) return []
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
        const filename = path.join(root, entry.name)
        const info = await disk.stat(filename)
        if (info.size > MAX_RECORD_BYTES) throw libraryError('LYRIC_CORRUPT', '保存的歌词文件过大，无法读取。')
        let hash
        try { hash = hashKey(JSON.parse(await disk.readFile(filename, 'utf8')).hash) } catch {
          throw libraryError('LYRIC_CORRUPT', '保存的歌词数据损坏，原文件已保留。')
        }
        if (`${digest(hash)}.json` !== entry.name) throw libraryError('LYRIC_CORRUPT', '保存的歌词索引无效，原文件已保留。')
        const record = await readRecord(hash)
        if (record) records.push({ hash, title: record.title, artist: record.artist, selectedVersionId: record.selectedVersionId, updatedAt: record.updatedAt, versionCount: record.versions.length })
      }
      return active(epoch) ? records.sort((a, b) => b.updatedAt - a.updatedAt) : []
    })
  }

  /** 自动保存受匹配阈值控制；后台更新只新增在线版本，不覆盖编辑版或手动选择。 */
  function saveOnline(request = {}) {
    const epoch = generation
    if (!active(epoch)) return Promise.resolve(null)
    const hash = hashKey(request.hash)
    const mode = request.mode || 'autoSave'
    if (!['autoSave', 'autoUpdate'].includes(mode)) throw libraryError('LYRIC_INVALID_MODE', '歌词保存方式无效。')
    const matchLevel = Object.hasOwn(MATCH_RANK, request.matchLevel) ? request.matchLevel : 'any'
    const data = normalizeData(request.data)
    const sourceId = shortText(request.sourceId == null ? '' : String(request.sourceId))
    return enqueue(async () => {
      if (!active(epoch)) return null
      if (mode === 'autoSave' && (!policy.autoSave || MATCH_RANK[matchLevel] < MATCH_RANK[policy.minMatch])) return null
      if (mode === 'autoUpdate' && !policy.autoUpdate) return null
      const existing = await readRecord(hash)
      if (!active(epoch)) return null
      if (mode === 'autoUpdate' && !existing?.versions.some(version => version.source === 'online' && (!sourceId || version.sourceId === sourceId))) return null
      const id = `online-${digest(JSON.stringify([sourceId, data]))}`
      if (existing?.versions.some(version => version.id === id)) return clone(existing)
      const timestamp = Date.now()
      const record = existing || { hash, title: shortText(request.title), artist: shortText(request.artist), selectedVersionId: id, selectionMode: 'auto', versions: [] }
      record.title = shortText(request.title) || record.title
      record.artist = shortText(request.artist) || record.artist
      record.versions.push({ id, source: 'online', sourceId, createdAt: timestamp, updatedAt: timestamp, matchLevel, languageReset: false, data })
      if (record.selectionMode === 'auto') record.selectedVersionId = id
      record.updatedAt = timestamp
      return persist(record, epoch, 'online')
    })
  }

  /** 编辑永远创建副本并选中，不改写在线原文；保存失败时所有旧版本仍可读取。 */
  function saveEdit(request = {}) {
    const epoch = generation
    requireActive(epoch)
    const hash = hashKey(request.hash)
    if (typeof request.content !== 'string' || !request.content.trim()) throw libraryError('LYRIC_EMPTY', '歌词内容不能为空。')
    if (Buffer.byteLength(request.content, 'utf8') > MAX_CONTENT_BYTES) throw libraryError('LYRIC_TOO_LARGE', '编辑内容不能超过 1 MB。')
    return enqueue(async () => {
      requireActive(epoch)
      const record = await readRecord(hash)
      const base = record?.versions.find(version => version.id === request.versionId)
      if (!base) throw libraryError('LYRIC_VERSION_MISSING', '歌词版本不存在，请刷新后重试。')
      const { data, languageReset } = prepareEditedData(base.data, request.content)
      const timestamp = Date.now()
      const id = `edited-${randomUUID()}`
      record.versions.push({ id, source: 'edited', sourceId: base.sourceId, createdAt: timestamp, updatedAt: timestamp, matchLevel: base.matchLevel, languageReset, data: normalizeData(data) })
      record.selectedVersionId = id
      record.selectionMode = 'manual'
      record.updatedAt = timestamp
      return persist(record, epoch, 'edit')
    })
  }

  function select(request = {}) {
    const epoch = generation
    requireActive(epoch)
    const hash = hashKey(request.hash)
    return enqueue(async () => {
      requireActive(epoch)
      const record = await readRecord(hash)
      if (!record?.versions.some(version => version.id === request.versionId)) throw libraryError('LYRIC_VERSION_MISSING', '歌词版本不存在，请刷新后重试。')
      if (record.selectedVersionId === request.versionId && record.selectionMode === 'manual') return clone(record)
      record.selectedVersionId = request.versionId
      record.selectionMode = 'manual'
      record.updatedAt = Date.now()
      return persist(record, epoch, 'select')
    })
  }

  function stop() {
    if (!stopPromise) {
      stopped = true
      generation += 1
      stopPromise = queue.then(() => undefined)
    }
    return stopPromise
  }

  return { configure, list, read, saveOnline, saveEdit, select, stop }
}

module.exports = { createLyricLibraryService }
