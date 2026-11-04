import { getSongArtists, getSongSearchKeyword } from './songMetadata.js'

/** 只使用接口明确提供的公开分享地址，拒绝媒体地址及带认证信息的链接。 */
export function buildSongShareText(song) {
  const title = getSongSearchKeyword(song) || '未知歌曲'
  const artists = getSongArtists(song).map(item => item.name).join('、')
  const album = song?.album_name || song?.albuminfo?.name || song?.album_info?.album_name || ''
  const lines = [artists ? `${title} — ${artists}` : title]
  if (album) lines.push(`专辑：${album}`)
  if (song?.source !== 'cloud') {
    for (const raw of [song?.share_url, song?.shareUrl, song?.shareurl, song?.share?.url]) {
      if (typeof raw !== 'string') continue
      try {
        const url = new URL(raw)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
        if (!(url.hostname === 'kugou.com' || url.hostname.endsWith('.kugou.com'))) continue
        if (/\.(mp3|flac|m4a|ogg|wav|ape|mkv)(?:$|[/?])/i.test(url.pathname) || /(?:^|\/)(?:audio|download|cloud)(?:\/|$)/i.test(url.pathname)) continue
        if ([...url.searchParams.keys()].some(key => /token|cookie|password|auth|key|sign|userid/i.test(key))) continue
        if (/token|cookie|password|auth|key|sign|userid/i.test(url.hash)) continue
        lines.push(url.href)
        break
      } catch { /* 非 URL 的分享字段只忽略，仍可复制歌曲文字。 */ }
    }
  }
  return { text: lines.join('\n'), hasLink: lines.some(line => /^https?:\/\//.test(line)) }
}
