// 酷狗音乐 API 请求封装
import axios from 'axios'
import { logger } from '../utils/logger.js'

// API 基础地址
const API_BASE_URL = 'http://localhost:6500'

// 创建 axios 实例
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  withCredentials: true // 支持跨域 cookie
})

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => {
    // 可以在这里添加 token 等认证信息
    const token = localStorage.getItem('kugou_token')
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`
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
    return response.data
  },
  (error) => {
    logger.error('auth-api', 'API请求失败', error)
    return Promise.reject(error)
  }
)

/**
 * 发送手机验证码
 * @param {string} mobile - 手机号
 * @returns {Promise}
 */
export const sendCaptcha = (mobile) => {
  return apiClient.post('/captcha/sent', { mobile })
}

/**
 * 手机号验证码登录
 * @param {string} mobile - 手机号
 * @param {string} code - 验证码
 * @returns {Promise}
 */
export const loginByPhone = (mobile, code) => {
  return apiClient.post('/login/cellphone', { mobile, code })
}

/**
 * 账号密码登录
 * @param {string} username - 用户名/邮箱
 * @param {string} password - 密码
 * @returns {Promise}
 */
export const loginByAccount = (username, password) => {
  return apiClient.post('/login', { username, password })
}

/**
 * 生成二维码 key
 * @param {string} type - 类型 'web' 或其他
 * @returns {Promise}
 */
export const getQRCodeKey = (type = 'web') => {
  return apiClient.get('/login/qr/key', { params: { type } })
}

/**
 * 生成二维码图片
 * @param {string} key - 二维码 key
 * @param {boolean} qrimg - 是否返回 base64 图片
 * @returns {Promise}
 */
export const createQRCode = (key, qrimg = true) => {
  return apiClient.get('/login/qr/create', { params: { key, qrimg } })
}

/**
 * 检查二维码扫码状态
 * @param {string} key - 二维码 key
 * @returns {Promise}
 * 状态码说明：
 * 0 - 二维码过期
 * 1 - 等待扫码
 * 2 - 待确认
 * 4 - 授权登录成功（返回 token）
 */
export const checkQRCodeStatus = (key) => {
  // 添加时间戳避免缓存
  const timestamp = Date.now()
  return apiClient.get('/login/qr/check', { params: { key, timestamp } })
}

/**
 * 保存登录信息
 * @param {object} data - 登录返回的数据
 */
export const saveLoginInfo = (data) => {
  if (data.token) {
    localStorage.setItem('kugou_token', data.token)
  }
  if (data.userid) {
    localStorage.setItem('kugou_userid', data.userid)
  }
  if (data.vip_type !== undefined) {
    localStorage.setItem('kugou_vip_type', data.vip_type)
  }
  // 保存用户信息
  const userInfo = {
    userid: data.userid,
    username: data.username || data.nickname || '',
    avatar: data.pic || data.avatar || '',
    vip_type: data.vip_type || 0
  }
  localStorage.setItem('kugou_userinfo', JSON.stringify(userInfo))
}

/**
 * 获取登录信息
 * @returns {object|null}
 */
export const getLoginInfo = () => {
  try {
    const token = localStorage.getItem('kugou_token')
    const rawUserInfo = localStorage.getItem('kugou_userinfo')
    if (!token && !rawUserInfo) return null

    const userInfo = rawUserInfo ? JSON.parse(rawUserInfo) : null
    if (token && userInfo && typeof userInfo === 'object' && !Array.isArray(userInfo)) {
      return { token, userInfo }
    }
  } catch (error) {
    // JSON 解析错误可能包含原始用户信息，只记录错误类型。
    logger.warn('auth-api', '读取登录缓存失败', { name: error?.name })
  }

  try {
    clearLoginInfo()
  } catch (error) {
    logger.warn('auth-api', '清理失效登录缓存失败', { name: error?.name })
  }
  return null
}

/**
 * 清除登录信息
 */
export const clearLoginInfo = () => {
  localStorage.removeItem('kugou_token')
  localStorage.removeItem('kugou_userid')
  localStorage.removeItem('kugou_vip_type')
  localStorage.removeItem('kugou_userinfo')
}

/**
 * 检查是否已登录
 * @returns {boolean}
 */
export const isLoggedIn = () => {
  return getLoginInfo() !== null
}

export default apiClient
