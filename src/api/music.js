// 音乐相关 API
import axios from 'axios'
import { logger } from '../utils/logger.js'

// API 基础地址
const API_BASE_URL = 'http://localhost:6500'
export const KUGOU_AUTH_EXPIRED_EVENT = 'kugou-auth-expired'

const AUTH_EXPIRED_ERROR_CODES = new Set([20017])
const requestIdentities = new WeakMap()

const isAuthExpiredPayload = (payload) => {
  const errorCode = Number(payload?.error_code ?? payload?.data?.error_code)
  return AUTH_EXPIRED_ERROR_CODES.has(errorCode)
}

const notifyAuthExpired = (config) => {
  const identity = config && requestIdentities.get(config)
  if (identity && (identity.token !== localStorage.getItem('kugou_token') ||
      identity.userId !== localStorage.getItem('kugou_userid'))) return
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(KUGOU_AUTH_EXPIRED_EVENT))
  }
}

const createAuthExpiredError = (cause) => {
  const error = new Error('登录状态已失效，请重新登录')
  error.code = 'KUGOU_AUTH_EXPIRED'
  error.cause = cause
  return error
}

// 创建 axios 实例
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  withCredentials: true
})

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => {
    // 只为部分 API 添加 token 和 userid 参数
    // 对于需要完整认证的 API（如 getSongUrl），会在函数内部单独处理
    const token = localStorage.getItem('kugou_token')
    const userid = localStorage.getItem('kugou_userid')
    requestIdentities.set(config, { token, userId: userid })
    
    if (token && !config.params?.cookie) {
      // 只有在没有明确指定 cookie 的情况下才添加这些参数
      if (!config.params) {
        config.params = {}
      }
      config.params.token = token
      if (userid) {
        config.params.userid = userid
      }
    }
    
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => {
    if (isAuthExpiredPayload(response.data)) {
      notifyAuthExpired(response.config)
      return Promise.reject(createAuthExpiredError(response.data))
    }
    return response.data
  },
  (error) => {
    if (isAuthExpiredPayload(error.response?.data)) {
      notifyAuthExpired(error.config)
      return Promise.reject(createAuthExpiredError(error))
    }
    logger.error('music-api', 'API请求失败', error)
    return Promise.reject(error)
  }
)

/**
 * 获取私人 FM（猜你喜欢）
 * @returns {Promise}
 */
export const getPersonalFM = () => {
  return apiClient.post('/personal/fm')
}

/**
 * 获取每日推荐歌曲
 * @returns {Promise}
 */
export const getEverydayRecommend = () => {
  return apiClient.post('/everyday/recommend')
}

/**
 * 获取排行榜列表
 * @returns {Promise}
 */
export const getRankList = () => {
  return apiClient.get('/rank/list')
}

/**
 * 获取排行榜详情
 * @param {number} rankid - 排行榜 ID
 * @param {number} page - 页码
 * @param {number} pagesize - 每页数量
 * @returns {Promise}
 */
export const getRankInfo = (rankid, page = 1, pagesize = 30) => {
  return apiClient.get('/rank/info', {
    params: { rankid, page, pagesize }
  })
}

/**
 * 获取 AI 推荐
 * @param {string} album_audio_id - 歌曲 ID，多个用逗号分隔
 * @returns {Promise}
 */
export const getAIRecommend = (album_audio_id) => {
  return apiClient.post('/ai/recommend', {
    album_audio_id
  })
}

/**
 * 获取歌曲详情
 * @param {string} hash - 歌曲 hash
 * @returns {Promise}
 */
export const getSongDetail = (hash) => {
  return apiClient.get('/audio', {
    params: { hash }
  })
}

/**
 * 获取歌曲播放地址（旧版，返回未加密的播放地址）
 * @param {string} hash - 歌曲 hash
 * @param {number} album_id - 专辑 ID
 * @param {number} album_audio_id - 专辑音频 ID
 * @param {string} quality - 普通音质：128、320、flac 或 high
 * @returns {Promise}
 */
export const getSongUrl = (hash, album_id = 0, album_audio_id = 0, quality = '128') => {
  // 获取认证信息
  const token = localStorage.getItem('kugou_token') || ''
  const userid = localStorage.getItem('kugou_userid') || '0'
  
  // 构建请求 URL，参考 BetterKugou 的实现方式
  let url = '/song/url'
  const params = new URLSearchParams({
    hash,
    album_id: album_id.toString(),
    album_audio_id: album_audio_id.toString(),
    quality: ['128', '320', 'flac', 'high'].includes(quality) ? quality : '128'
  })
  
  // 如果已登录，添加 cookie 参数（参考 BetterKugou 的方式）
  if (token && userid) {
    const cookieParam = `token=${encodeURIComponent(token)};userid=${encodeURIComponent(userid)}`
    params.append('cookie', cookieParam)
  }
  
  url += '?' + params.toString()
  
  // 使用 axios 直接请求
  return apiClient.get(url)
}

/**
 * 搜索歌词信息
 * @param {string} hash - 歌曲 hash
 * @param {number} album_audio_id - 专辑音频 ID (可选)
 * @param {string} keywords - 搜索关键词 (可选)
 * @returns {Promise}
 */
export const searchLyric = (hash, album_audio_id = 0, keywords = '') => {
  return apiClient.get('/search/lyric', {
    params: {
      hash,
      album_audio_id,
      keywords
    }
  })
}

/**
 * 获取歌词详情
 * @param {string} id - 歌词 ID
 * @param {string} accesskey - 访问密钥
 * @returns {Promise}
 */
export const getLyricDetail = (id, accesskey) => {
  return apiClient.get('/lyric', {
    params: {
      id,
      accesskey,
      fmt: 'krc',  // 使用krc格式获取逐字歌词
      charset: 'utf8',
      ver: 1,
      client: 'pc',
      decode: true  // 请求服务器自动解码歌词内容
    }
  })
}

/**
 * 获取歌词（完整流程：先搜索然后获取详情）
 * @param {string} hash - 歌曲 hash
 * @param {number} album_audio_id - 专辑音频 ID (可选)
 * @param {string} keywords - 搜索关键词 (可选，默认为空)
 * @returns {Promise}
 */
export const getLyric = async (hash, album_audio_id = 0, keywords = '') => {
  try {
    // 第一步：搜索歌词信息
    const searchResult = await searchLyric(hash, album_audio_id, keywords)
    
    logger.trace('music-api', '搜索歌词响应', searchResult)
    
    if (!searchResult || !searchResult.candidates || searchResult.candidates.length === 0) {
      throw new Error('未找到歌词信息')
    }
    
    // 取第一个候选歌词
    const lyricInfo = searchResult.candidates[0]
    const lyricId = lyricInfo.id
    const accesskey = lyricInfo.accesskey
    
    if (!lyricId || !accesskey) {
      throw new Error('歌词ID或访问密钥无效')
    }
    
    // 第二步：获取歌词详情
    const lyricDetail = await getLyricDetail(lyricId, accesskey)
    
    return lyricDetail
  } catch (error) {
    logger.error('music-api', '获取歌词失败', error)
    throw error
  }
}

/**
 * 获取用户歌单列表
 * @param {number} page - 页码
 * @param {number} pagesize - 每页数量
 * @returns {Promise}
 */
export const getUserPlaylists = (page = 1, pagesize = 30) => {
  return apiClient.get('/user/playlist', {
    params: { page, pagesize }
  })
}

/**
 * 获取歌单所有歌曲
 * @param {string} id - 歌单 ID
 * @param {number} page - 页码
 * @param {number} pagesize - 每页数量
 * @returns {Promise}
 */
export const getPlaylistTracks = (id, page = 1, pagesize = 100) => {
  return apiClient.get('/playlist/track/all', {
    params: { id, page, pagesize }
  })
}

/**
 * 搜索音乐
 * @param {string} keywords - 搜索关键词
 * @param {number} page - 页码
 * @param {number} pagesize - 每页数量
 * @param {string} type - 搜索类型：song（单曲），album（专辑），author（歌手），special（歌单），lyric（歌词），mv（MV）
 * @returns {Promise}
 */
export const searchMusic = (keywords, page = 1, pagesize = 30, type = 'song') => {
  return apiClient.get('/search', {
    params: { keywords, page, pagesize, type }
  })
}

/**
 * 综合搜索
 * @param {string} keywords - 搜索关键词
 * @param {number} page - 页码
 * @param {number} pagesize - 每页数量
 * @returns {Promise}
 */
export const searchComplex = (keywords, page = 1, pagesize = 30) => {
  return apiClient.get('/search/complex', {
    params: { keywords, page, pagesize }
  })
}

/**
 * 获取歌手详情
 * @param {number|string} id 歌手ID
 */
export const getArtistDetail = (id) => {
  return apiClient.get('/artist/detail', {
    params: { id }
  })
}

/**
 * 获取歌手单曲（支持分页）
 * @param {number|string} id 歌手ID
 * @param {number} page 页码
 * @param {number} pagesize 每页条数（默认30）
 * @param {('hot'|'new')} sort 排序：hot 热门，new 最新
 */
export const getArtistAudios = (id, page = 1, pagesize = 30, sort = 'new') => {
  return apiClient.get('/artist/audios', {
    params: { id, page, pagesize, sort }
  })
}

/**
 * 获取歌手专辑（支持分页）
 * @param {number|string} id 歌手ID
 * @param {number} page 页码
 * @param {number} pagesize 每页条数（默认30）
 * @param {('hot'|'new')} sort 排序：hot 热门，new 最新
 */
export const getArtistAlbums = (id, page = 1, pagesize = 30, sort = 'new') => {
  return apiClient.get('/artist/albums', {
    params: { id, page, pagesize, sort }
  })
}

/**
 * 关注歌手（需要登录）
 */
export const followArtist = (id) => {
  return apiClient.post('/artist/follow', null, {
    params: { id }
  })
}

/**
 * 取消关注歌手（需要登录）
 */
export const unfollowArtist = (id) => {
  return apiClient.post('/artist/unfollow', null, {
    params: { id }
  })
}

/**
 * 根据名称查找歌手（用于从搜索结果或缺少ID时兜底）
 */
export const findArtistByName = async (name) => {
  if (!name) return null
  try {
    const res = await apiClient.get('/search', { params: { keywords: name, type: 'author', pagesize: 5 } })
    const list = res?.data?.lists || []
    return list[0] || null
  } catch (e) {
    logger.error('music-api', 'findArtistByName失败', e)
    return null
  }
}

/**
 * 批量获取歌曲对应的歌手/专辑图片
 * @param {string[]} hashes 歌曲hash数组
 * @param {number} count 每个返回数量，默认1
 */
export const getImagesByHash = (hashes = [], count = 1) => {
  if (!Array.isArray(hashes)) hashes = [hashes].filter(Boolean)
  const hashParam = hashes.filter(Boolean).join(',')
  if (!hashParam) return Promise.resolve({})
  return apiClient.get('/images', {
    params: { hash: hashParam, count }
  })
}

/**
 * 根据专辑ID批量获取专辑信息（含封面）
 * @param {Array<string|number>} albumIds 专辑ID数组
 * @param {string} fields 需要的字段，默认返回常用字段
 */
export const getAlbumInfo = (albumIds = [], fields = 'sizable_cover,cover,album_name,album_id') => {
  if (!Array.isArray(albumIds)) albumIds = [albumIds].filter(Boolean)
  const idParam = albumIds.filter(Boolean).join(',')
  if (!idParam) return Promise.resolve({})
  return apiClient.get('/album', {
    params: {
      album_id: idParam,
      fields
    }
  })
}

/**
 * 获取专辑详情
 * @param {number|string} id 专辑ID
 */
export const getAlbumDetail = (id) => {
  return apiClient.get('/album/detail', {
    params: { id }
  })
}

/**
 * 获取专辑曲目列表
 * @param {number|string} id 专辑ID
 * @param {number} page 页码（部分接口可能不分页，这里预留）
 * @param {number} pagesize 每页数量（预留）
 */
export const getAlbumSongs = (id, page = 1, pagesize = 30) => {
  const token = localStorage.getItem('kugou_token') || ''
  const userid = localStorage.getItem('kugou_userid') || ''
  const params = { id, page, pagesize }
  if (token && userid) {
    params.cookie = `token=${encodeURIComponent(token)};userid=${encodeURIComponent(userid)}`
  }
  return apiClient.get('/album/songs', { params })
}
