const VIP_PRIVILEGES = new Set([8, 10])

function readNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function isEnabled(value) {
  return value === true || value === 1 || value === '1'
}

/**
 * Read song-level membership metadata without inferring playback permission.
 * Privilege 8/10 follow the existing BetterKuGou playlist model; unknown codes
 * remain unknown. Quality, file size and the signed-in user's VIP are unrelated.
 */
export function getSongBadges(song) {
  if (!song || typeof song !== 'object') return []
  const sources = [song, song.base, song.trans_param].filter(value => value && typeof value === 'object')
  const vip = sources.some(source => VIP_PRIVILEGES.has(readNumber(source.privilege ?? source.Privilege)) ||
    [source.vip, source.is_vip, source.isVip, source.IsVip].some(isEnabled))
  return vip ? [{ key: 'vip', label: 'VIP', title: 'VIP 歌曲' }] : []
}

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function names(value) {
  if (Array.isArray(value)) return value.map(names).join(' ')
  if (value && typeof value === 'object') {
    return [value.name, value.singer_name, value.singername, value.author_name, value.album_name, value.albumname].map(text).join(' ')
  }
  return text(value)
}

/** Match all loaded song, artist and album aliases, keeping the original rows and queue untouched. */
export function filterSongs(songs, query) {
  const keyword = text(query).trim().toLocaleLowerCase()
  if (!keyword) return songs
  return songs.filter(song => {
    if (!song || typeof song !== 'object') return false
    const fields = [
      song.name, song.filename, song.FileName, song.songname, song.song_name, song.audio_name, song.OriSongName, song.title,
      song.singername, song.SingerName, song.singer_name, song.author_name, song.author,
      song.singerinfo, song.singers, song.authors,
      song.album_name, song.AlbumName, song.remark, song.albuminfo, song.album_info, song.album
    ]
    return fields.map(names).join(' ').toLocaleLowerCase().includes(keyword)
  })
}
