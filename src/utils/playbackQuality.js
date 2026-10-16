// 普通音质来自本地 /song/url 协议；魔法音乐和蝰蛇音效不属于此列表。
export const PLAYBACK_QUALITY_OPTIONS = Object.freeze([
  { value: '128', label: '标准 128 kbps' },
  { value: '320', label: '高品 320 kbps' },
  { value: 'flac', label: '无损 FLAC' },
  { value: 'high', label: '无损 HIGH' }
])

export function normalizePlaybackQuality(value) {
  return PLAYBACK_QUALITY_OPTIONS.some(option => option.value === value) ? value : '128'
}

/** 仅使用服务端返回的格式和码率确认当前音源，不以请求偏好推断实际音质。 */
export function readPlaybackQuality(response) {
  const format = typeof response?.extname === 'string' ? response.extname.toLowerCase() : ''
  const rawBitrate = Number(response?.bitrate)
  const bitrate = Number.isFinite(rawBitrate) && rawBitrate > 0
    ? Math.round(rawBitrate > 1000 ? rawBitrate / 1000 : rawBitrate) : null
  const lossless = ['flac', 'wav', 'ape', 'alac'].includes(format)
  const label = lossless ? `无损 ${format.toUpperCase()}`
    : bitrate ? `${bitrate} kbps` : format ? format.toUpperCase() : '待确认'
  return { format, bitrate, label, confirmed: Boolean(format || bitrate) }
}
