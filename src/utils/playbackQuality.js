// 普通音质来自本地 /song/url 协议；魔法音乐和蝰蛇音效不属于此列表。
export const PLAYBACK_QUALITY_OPTIONS = Object.freeze([
  { value: '128', label: '标准 128 kbps', name: '标准', detail: '128 kbps', shortLabel: '128K' },
  { value: '320', label: '高品 320 kbps', name: '高品', detail: '320 kbps', shortLabel: '320K' },
  { value: 'flac', label: '无损 FLAC', name: '无损', detail: 'FLAC', shortLabel: 'FLAC' },
  { value: 'high', label: '无损 HIGH', name: '无损', detail: 'HIGH', shortLabel: 'HIGH' }
])

export function normalizePlaybackQuality(value) {
  return PLAYBACK_QUALITY_OPTIONS.some(option => option.value === value) ? value : '128'
}

/** 读取当前音源的响应元数据；缺少格式时仅检查实际播放地址的文件扩展名，不推断码率或请求档位。 */
export function readPlaybackQuality(response) {
  const formats = ['mp3', 'flac', 'wav', 'ape', 'alac', 'aac', 'm4a', 'ogg', 'opus', 'wma']
  let format = [response?.extname, response?.extName]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().replace(/^\./, '').toLowerCase())
    .find(value => formats.includes(value)) || ''
  if (!format) {
    // 与播放器取址保持一致，只看第一条地址；签名参数及备用地址不能证明正在播放的格式。
    const url = Array.isArray(response?.url) ? response.url[0] : response?.url
    const path = typeof url === 'string' ? url.split(/[?#]/, 1)[0] : ''
    const extension = /^https?:\/\/[^/]+\/.*\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
    if (formats.includes(extension)) format = extension
  }
  const rawBitrate = [response?.bitrate, response?.bitRate]
    .filter(value => typeof value === 'number' || typeof value === 'string')
    .map(Number).find(value => Number.isFinite(value) && value > 0)
  const bitrate = Number.isFinite(rawBitrate) && rawBitrate > 0
    ? Math.round(rawBitrate > 1000 ? rawBitrate / 1000 : rawBitrate) : null
  const lossless = ['flac', 'wav', 'ape', 'alac'].includes(format)
  const label = lossless ? `无损 ${format.toUpperCase()}`
    : bitrate ? `${bitrate} kbps` : format ? format.toUpperCase() : '待确认'
  return { format, bitrate, label, confirmed: Boolean(format || bitrate) }
}
