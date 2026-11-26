import { libraryRequest } from './library.js'

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_PROFILE_INPUT' })
const fields = ['nickname', 'signature', 'sex', 'birthday']

/** Load only the signed-in account through the existing account-scoped request boundary. */
export async function getUserProfile(fallback = {}, options = {}) {
  const response = await libraryRequest('/user/detail', {}, { ...options, authenticated: true })
  const value = response?.data?.userinfo || response?.data || response
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![value.nickname, value.username].some(item => typeof item === 'string')) {
    throw Object.assign(new Error('暂时无法读取账号资料，请重试'), { code: 'INVALID_PROFILE_RESPONSE' })
  }
  if (value.userid != null && fallback.userid != null && String(value.userid) !== String(fallback.userid)) {
    throw Object.assign(new Error('账号状态已变化，请重新打开资料'), { code: 'ERR_CANCELED' })
  }
  return { userid: String(value.userid ?? fallback.userid ?? ''),
    nickname: typeof value.nickname === 'string' ? value.nickname : value.username,
    signature: typeof value.signature === 'string' ? value.signature : '',
    sex: ['0', '1', '2'].includes(String(value.sex)) ? String(value.sex) : '',
    birthday: typeof value.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.birthday) ? value.birthday : '' }
}

/** Submit only changed, supported fields; a successful HTTP response still requires a business acknowledgement. */
export function updateUserProfile(patch, options = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      !Object.keys(patch).length || Object.keys(patch).some(key => !fields.includes(key))) throw invalid('修改资料无效')
  const values = {}
  for (const field of Object.keys(patch)) {
    const value = patch[field]
    if (typeof value !== 'string') throw invalid('资料字段格式无效')
    if (field === 'nickname' && (!value.trim() || value.trim().length > 50)) throw invalid('昵称需为 1–50 个字符')
    if (field === 'signature' && value.length > 200) throw invalid('个性签名不能超过 200 个字符')
    if (field === 'sex' && !['0', '1', '2'].includes(value)) throw invalid('性别选项无效')
    if (field === 'birthday' && value !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw invalid('生日日期无效')
    values[field] = field === 'nickname' ? value.trim() : value
  }
  return libraryRequest('/user/update', values, { ...options, method: 'post', authenticated: true, mutation: true })
}
