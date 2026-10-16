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

/** Build a title-only query while preserving version suffixes and hyphens inside the title. */
export function getSongSearchKeyword(song) {
  if (!song || typeof song !== 'object') return ''
  const titleFields = ['OriSongName', 'songname', 'song_name', 'audio_name', 'title']
  const fileFields = ['name', 'filename', 'FileName']
  const field = [...titleFields, ...fileFields].find(key => typeof song[key] === 'string' && song[key].trim())
  if (!field) return ''
  let title = song[field].trim()
  const separator = /\s+[-—–](?:\s+|$)/
  const match = separator.exec(title)
  if (match) {
    const artistFields = [song.singername, song.SingerName, song.singer_name, song.author_name, song.author,
      song.singerinfo, song.singers, song.authors]
    const artistNames = artistFields.flat(Infinity).flatMap(value => value && typeof value === 'object'
      ? [value.name, value.singer_name, value.singername, value.author_name] : [value])
      .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().toLocaleLowerCase())
    const prefix = title.slice(0, match.index).trim().toLocaleLowerCase()
    const collaborationSeparator = /\s*(?:、|&|＆|,|，|;|；|\/|／|\b(?:feat\.?|ft\.?|and)\b)\s*/i
    const prefixArtists = prefix.split(collaborationSeparator).filter(Boolean)
    const individualArtists = artistNames.flatMap(value => value.split(collaborationSeparator)).filter(Boolean)
    const knownPrefix = artistNames.includes(prefix) ||
      (prefixArtists.length > 1 && prefixArtists.every(value => individualArtists.includes(value)))
    // Historical file/name strings omit separate artist metadata; known artists prevent
    // treating a genuine title suffix such as "Hello - Live" as an artist separator.
    if (prefix && (knownPrefix || (fileFields.includes(field) && artistNames.length === 0))) {
      title = title.slice(match.index + match[0].length).trim()
    }
  }
  if (fileFields.includes(field)) title = title.replace(/\.(mp3|flac|wav|aac|m4a|ogg|wma|ape|opus)$/i, '').trim()
  return title
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
