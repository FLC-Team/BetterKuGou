import { apiClient } from './music.js'
import { findLibraryList, normalizeLibrarySong, normalizePlaylistResource } from '../utils/libraryMetadata.js'
import { logger } from '../utils/logger.js'

const identity = () => ({ token: localStorage.getItem('kugou_token'), userId: localStorage.getItem('kugou_userid') })
const sameIdentity = value => {
  const current = identity()
  return value.token === current.token && value.userId === current.userId
}
const cancelled = () => Object.assign(new Error('请求已取消或账号已变化，请重试'), { code: 'ERR_CANCELED' })
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_LIBRARY_INPUT' })
const id = (value, label = '资源') => {
  if (!['string', 'number'].includes(typeof value) || !String(value).trim() || String(value).length > 256) throw invalid(`${label}缺少有效 ID`)
  return String(value).trim()
}
const numericId = (value, label = '歌单') => {
  const result = id(value, label)
  if (!/^\d+$/.test(result) || !Number.isSafeInteger(Number(result)) || Number(result) <= 0) throw invalid(`${label} ID 无效，请刷新后重试`)
  return result
}

/** Use the existing authenticated client, reject business failures and isolate late responses across accounts. */
export async function libraryRequest(route, params = {}, options = {}) {
  if (!/^\/[a-z]+(?:\/[a-z]+)*$/.test(route)) throw invalid('接口路径无效')
  const account = identity()
  if (options.authenticated && (!account.token || !account.userId)) {
    throw Object.assign(new Error('请先登录'), { code: 'LOGIN_REQUIRED' })
  }
  if (options.signal?.aborted) throw cancelled()
  const cookie = account.token && account.userId
    ? `token=${encodeURIComponent(account.token)};userid=${encodeURIComponent(account.userId)}` : null
  // Credentials belong to the captured account, never to data supplied by a page.
  const values = { ...params }
  delete values.token
  delete values.userid
  delete values.cookie
  if (cookie) values.cookie = cookie
  const config = { signal: options.signal, libraryIdentity: account }
  const response = options.method === 'post'
    ? await apiClient.post(route, values, { ...config, params: cookie ? { cookie } : {} })
    : await apiClient.get(route, { ...config, params: values })
  if (!sameIdentity(account) || options.signal?.aborted) throw cancelled()
  if (!response || typeof response !== 'object') throw Object.assign(new Error('服务返回格式无效，请重试'), { code: 'INVALID_RESPONSE' })
  const status = response.status
  const errorCode = response.error_code ?? response.errcode ?? response.err_code ??
    response.data?.error_code ?? response.data?.errcode ?? response.data?.err_code
  const code = response.code
  const failed = (status != null && ![1, 200].includes(Number(status))) || response.success === false ||
    (errorCode != null && Number(errorCode) !== 0) || (code != null && ![0, 1, 200].includes(Number(code)))
  const acknowledged = [1, 200].includes(Number(status)) || response.success === true ||
    (code != null && [0, 1, 200].includes(Number(code))) || (errorCode != null && Number(errorCode) === 0)
  if (failed || (options.mutation && !acknowledged)) {
    const error = new Error(failed ? '操作未成功，请刷新后重试' : '服务未确认操作结果，请刷新确认')
    error.code = failed ? 'LIBRARY_REQUEST_FAILED' : 'LIBRARY_RESULT_UNKNOWN'
    error.businessCode = errorCode ?? code ?? status
    throw error
  }
  return response
}

const read = (route, authenticated = false) => (params = {}, options = {}) =>
  libraryRequest(route, params, { ...options, authenticated })
const write = (route, params, options) => libraryRequest(route, params, { ...options, method: 'post', authenticated: true, mutation: true })

export const getPlaylistTags = read('/playlist/tags')
export const getDiscoverPlaylists = read('/top/playlist')
export const getNewSongs = read('/top/song')
export const getNewAlbums = read('/top/album')
export const getSearchHot = read('/search/hot')
export const getSearchDefault = read('/search/default')
export const getUserHistory = read('/user/history', true)
export const getUserListen = read('/user/listen', true)
export const getFollowedArtists = read('/user/follow', true)
export const getCloudSongs = read('/user/cloud', true)
export const getEverydayHistory = read('/everyday/history', true)
export const getRankPeriods = read('/rank/vol')
export const getFollowedNewSongs = (params = {}, options = {}) =>
  libraryRequest('/artist/follow/newsongs', params, { ...options, method: 'post', authenticated: true })
export const getSearchSuggestions = (keywords, options = {}) => libraryRequest('/search/suggest', { keywords }, options)
export const getPlaylistDetail = (globalCollectionId, options = {}) => libraryRequest('/playlist/detail', { ids: id(globalCollectionId) }, options)
export const getSimilarPlaylists = (globalCollectionId, options = {}) => libraryRequest('/playlist/similar', { ids: id(globalCollectionId) }, options)
export const getAudioRelated = (albumAudioId, params = {}, options = {}) =>
  libraryRequest('/audio/related', { ...params, album_audio_id: numericId(albumAudioId, '歌曲') }, options)

/** Fill missing display/play identities through metadata endpoints only, preserving each original record. */
export async function completeLibrarySongs(input, options = {}) {
  const account = identity()
  const assertCurrent = () => { if (!sameIdentity(account) || options.signal?.aborted) throw cancelled() }
  assertCurrent()
  const songs = input.map(song => normalizeLibrarySong(song))
  const mergeMissing = (song, detail) => {
    if (!detail) return
    for (const field of ['hash', 'name', 'singername', 'album_id', 'album_audio_id', 'audio_id', 'album_name', 'cover', 'timelen']) {
      if (!song[field] || song[field] === '0') song[field] = detail[field]
    }
    if (!song.singerinfo.length) song.singerinfo = detail.singerinfo
  }
  // List hydration only merges metadata; it never starts the player's URL lookup or audio download.
  const requestMetadata = async (route, params, required) => {
    assertCurrent()
    try {
      const response = await libraryRequest(route, params, options)
      assertCurrent()
      const entries = findLibraryList(response)
      if (!entries) throw Object.assign(new Error('歌曲资料格式暂不可读取，请重试。'), { code: 'INVALID_LIBRARY_METADATA' })
      return entries
    } catch (error) {
      assertCurrent()
      if (required || error?.code === 'ERR_CANCELED') throw error
      // Optional artwork outages must not hide songs that already have playable identities.
      logger.warn('library-api', '补全歌曲展示资料失败', { endpoint: route, error })
      return []
    }
  }
  const ids = [...new Set(songs.filter(song => (!song.hash || !song.name || !song.cover) &&
    Number.isSafeInteger(Number(song.album_audio_id)) && Number(song.album_audio_id) > 0).map(song => String(song.album_audio_id)))]
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50)
    const required = songs.some(song => !song.hash && batch.includes(String(song.album_audio_id)))
    const entries = await requestMetadata('/krm/audio', { album_audio_id: batch.join(','),
      fields: 'base,audio_info,album_info,authors.base' }, required)
    const details = new Map(entries.map(entry => { const song = normalizeLibrarySong(entry); return [String(song.album_audio_id), song] }))
    songs.forEach(song => mergeMissing(song, details.get(String(song.album_audio_id))))
  }
  const missingCovers = [...new Map(songs.filter(song => song.hash && !song.cover).map(song => [song.hash, song])).values()]
  for (let offset = 0; offset < missingCovers.length; offset += 50) {
    const batch = missingCovers.slice(offset, offset + 50)
    const entries = await requestMetadata('/privilege/lite', { hash: batch.map(song => song.hash).join(','),
      album_id: batch.map(song => song.album_id || 0).join(',') }, false)
    const details = new Map(entries.map(entry => { const song = normalizeLibrarySong(entry); return [song.hash, song] }))
    songs.forEach(song => mergeMissing(song, details.get(song.hash)))
  }
  assertCurrent()
  return songs
}

export const getOwnPlaylistTracks = (listId, page = 1, pagesize = 100, options = {}) =>
  libraryRequest('/playlist/track/all/new', { listid: numericId(listId), page, pagesize }, { ...options, authenticated: true })

/** Read every page atomically; directory short pages may end the read without changing track pagination. */
async function collectPages(request, options = {}, { endpoint, shortPageEnds = false } = {}) {
  const account = identity()
  let pageSize = Math.min(300, Math.max(1, Number(options.pagesize) || 100))
  let expectedTotal = null
  const items = []
  const pages = new Set()
  for (let page = 1; page <= 1000; page += 1) {
    if (!sameIdentity(account) || options.signal?.aborted) throw cancelled()
    const response = await request(page, pageSize)
    const batch = findLibraryList(response)
    if (!batch) {
      const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      throw Object.assign(new Error('列表响应格式无效，请刷新重试'), {
        code: 'INVALID_LIBRARY_PAGE',
        // The logger preserves cause; record structural context only, never account or playlist contents.
        cause: { endpoint, page, pagesize: pageSize, received: items.length, expectedTotal,
          dataType: typeOf(response.data),
          listTypes: Object.fromEntries(['info', 'list', 'lists', 'songs'].map(key => [key, typeOf(response.data?.[key])])) }
      })
    }
    const rawTotal = response.data?.total ?? response.data?.count ?? response.total ?? response.count
    const reportedTotal = rawTotal != null && Number.isFinite(Number(rawTotal)) && Number(rawTotal) >= 0 ? Number(rawTotal) : null
    if (expectedTotal == null) expectedTotal = reportedTotal
    else if (reportedTotal != null && reportedTotal !== expectedTotal) throw new Error('列表内容已改变，请刷新后重试')
    const total = expectedTotal
    if (batch.length) {
      const signature = JSON.stringify(batch)
      if (pages.has(signature)) throw new Error('列表分页未前进，请刷新重试')
      pages.add(signature)
    }
    items.push(...batch)
    if (items.length > 100000) throw new Error('列表超过可处理的范围')
    if (total != null && items.length >= total) return items
    if (!batch.length) {
      if (total != null && items.length < total) throw new Error('列表未加载完整，请刷新重试')
      return items
    }
    if (shortPageEnds && total == null && batch.length < pageSize) return items
    if (page === 1 && batch.length < pageSize) pageSize = batch.length
    else if (total == null && batch.length < pageSize) return items
    if (total != null && batch.length < pageSize && items.length < total) throw new Error('列表未加载完整，请刷新重试')
  }
  throw new Error('列表分页超过限制，请重试')
}

/** Use the directory endpoint's documented default size; its first short page is not a track-page size cap. */
export async function getAllUserPlaylists(options = {}) {
  const account = identity()
  const pagesize = Math.min(30, Math.max(1, Math.floor(Number(options.pagesize)) || 30))
  const items = await collectPages((page, pagesize) => libraryRequest('/user/playlist', { page, pagesize },
    { ...options, authenticated: true }), { ...options, pagesize }, { endpoint: '/user/playlist', shortPageEnds: true })
  return items.map(item => normalizePlaylistResource(item, { userId: account.userId, source: 'owned' }))
}

export async function getAllPlaylistTracks(resource, options = {}) {
  const playlist = normalizePlaylistResource(resource)
  const ownEntries = playlist.source === 'owned' || playlist.isOwned || playlist.isFavorite
  const endpoint = ownEntries && playlist.listId != null ? '/playlist/track/all/new' : '/playlist/track/all'
  const items = await collectPages((page, pagesize) => ownEntries && playlist.listId != null
    ? getOwnPlaylistTracks(playlist.listId, page, pagesize, options)
    : libraryRequest('/playlist/track/all', { id: id(playlist.globalCollectionId ?? playlist.id), page, pagesize }, options), options, { endpoint })
  return items.map(item => normalizeLibrarySong(item))
}

export function createPlaylist(name, options = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw invalid('请输入 1–200 字的歌单名称')
  return write('/playlist/add', { name: name.trim(), type: 0, source: 0, is_pri: options.isPrivate ? 1 : 0 }, options)
}

export function collectPlaylist(resource, options = {}) {
  const playlist = normalizePlaylistResource(resource)
  return write('/playlist/add', {
    name: playlist.name, type: 1, source: 1,
    list_create_userid: numericId(resource.list_create_userid ?? playlist.ownerId, '创建者'),
    list_create_listid: numericId(resource.list_create_listid ?? playlist.listId, '来源歌单'),
    list_create_gid: id(resource.list_create_gid ?? playlist.globalCollectionId),
  }, options)
}

export const deletePlaylist = (listId, options = {}) => write('/playlist/del', { listid: numericId(listId) }, options)

export function addPlaylistSongs(listId, songs, options = {}) {
  if (!Array.isArray(songs) || !songs.length || songs.length > 1000) throw invalid('每次请选择 1–1000 首歌曲')
  const entries = songs.map(song => {
    const item = normalizeLibrarySong(song)
    if (!item.hash || !item.name) throw invalid('歌曲缺少名称或音频标识')
    return { name: item.name, hash: item.hash, album_id: item.album_id, mixsongid: item.album_audio_id }
  })
  return write('/playlist/tracks/add', { listid: numericId(listId), songs: entries }, options)
}

export function removePlaylistSongs(listId, fileIds, options = {}) {
  if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 1000) throw invalid('请选择要移除的歌曲')
  return write('/playlist/tracks/del', { listid: numericId(listId),
    fileids: fileIds.map(fileId => numericId(fileId, '歌单歌曲记录')).join(',') }, options)
}

/** Upload one confirmed listen using the module's actual `time` input, never a hash or millisecond time. */
export function uploadPlayHistory(song, options = {}) {
  const item = normalizeLibrarySong(song)
  const time = options.time ?? Math.floor(Date.now() / 1000)
  const pc = options.pc ?? 1
  if (!Number.isSafeInteger(time) || time <= 0 || time >= 100000000000 || !Number.isSafeInteger(pc) || pc < 1) throw invalid('听歌历史参数无效')
  return write('/playhistory/upload', { mxid: numericId(item.album_audio_id, '歌曲'), time, pc }, options)
}

export function getComments(resource, params = {}, options = {}) {
  if (resource?.type === 'playlist' || resource?.type === 'album') {
    return libraryRequest(`/comment/${resource.type}`, { ...params, id: id(resource.id) }, options)
  }
  const mixsongid = numericId(resource?.mixsongid ?? resource?.album_audio_id ?? resource?.id, '歌曲')
  const suffix = params.type_id != null ? '/classify' : params.hot_word ? '/hotword' : ''
  return libraryRequest(`/comment/music${suffix}`, { ...params, mixsongid }, options)
}

export function getCommentReplies(resource, comment, params = {}, options = {}) {
  if (resource?.type && resource.type !== 'song') throw invalid('该资源的楼层回复暂不受支持')
  return libraryRequest('/comment/floor', { ...params,
    mixsongid: numericId(resource?.mixsongid ?? resource?.album_audio_id ?? resource?.id, '歌曲'),
    tid: id(comment?.tid ?? comment?.id, '评论'),
    special_id: id(comment?.special_child_id ?? comment?.special_id ?? comment?.childrenid ?? resource?.special_id, '评论分区'),
  }, options)
}

export function getCommentCount(resource, options = {}) {
  const params = resource?.hash ? { hash: id(resource.hash, '歌曲') } : { special_id: id(resource?.special_id ?? resource?.id) }
  return libraryRequest('/comment/count', params, options)
}

/** Resolve the signed-in owner's cloud file and adapt its URL to the existing playback contract. */
export async function getCloudSongUrl(song, options = {}) {
  const account = identity()
  if (!song?.sourceUserId || String(song.sourceUserId) !== String(account.userId)) throw invalid('云盘歌曲不属于当前账号，请重新打开云盘')
  const item = normalizeLibrarySong(song, { source: 'cloud', sourceUserId: account.userId })
  const response = await libraryRequest('/user/cloud/url', {
    hash: id(item.hash, '歌曲'), audio_id: item.audio_id, album_audio_id: item.album_audio_id, name: item.originalName,
  }, { ...options, authenticated: true })
  const data = response.data && !Array.isArray(response.data) ? response.data : {}
  const value = response.url ?? response.play_url ?? data.url ?? data.play_url
  const urls = (Array.isArray(value) ? value : [value]).filter(value => typeof value === 'string' && /^https?:\/\//i.test(value))
  if (!urls.length) throw new Error('云盘歌曲暂时无法取得播放地址')
  return { ...response, ...data, status: 1, url: urls, detail: item }
}
