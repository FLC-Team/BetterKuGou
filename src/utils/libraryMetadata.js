import { getSongArtists } from './songMetadata.js'

const listKeys = ['items', 'list', 'lists', 'info', 'songs', 'songlist', 'song_list', 'files', 'filelist',
  'albums', 'album_list', 'authors', 'author_list', 'follow_list', 'special_list', 'comments', 'comment_list', 'commentlist']
const readPath = (value, path) => path.split('.').reduce((current, key) => current?.[key], value)
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '')
const enabled = value => value === true || value === 1 || value === '1'

/** A cloud file belongs to its account; identical hashes from another source are distinct queue entries. */
export function librarySongKey(song) {
  const hash = text(first(song?.hash, song?.Hash, song?.FileHash)).trim().toLowerCase()
  if (!hash) return ''
  return song?.source === 'cloud' ? `cloud:${text(song.sourceUserId)}:${hash}` : `catalog:${hash}`
}

/** Extract only known list containers; custom dotted keys take precedence over generic lists. */
export function findLibraryList(response, keys = []) {
  if (Array.isArray(response)) return response
  const roots = [response?.data, response?.data?.data, response?.result, response]
    .filter(value => value && typeof value === 'object')
  for (const key of [...keys, ...listKeys, 'special_recommend.special_list', 'special_recommend.list']) {
    for (const root of roots) {
      const value = readPath(root, key)
      if (Array.isArray(value)) return value
    }
  }
  return roots.find(Array.isArray) || null
}

export function extractLibraryList(response, keys = []) {
  return findLibraryList(response, keys) || []
}

/** Keep source IDs and entry IDs independently; normalization never invents an editable playlist ID. */
export function normalizePlaylistResource(raw, { userId, source } = {}) {
  const item = raw && typeof raw === 'object' ? raw : {}
  const globalCollectionId = first(item.globalCollectionId, item.global_collection_id, item.GlobalCollectionId, item.gid)
  const listId = first(item.listId, item.listid, item.list_id)
  const ownerId = first(item.ownerId, item.userid, item.user_id, item.create_userid, item.list_create_userid, item.suid)
  const name = text(first(item.name, item.list_name, item.specialname, item.special_name, item.SpecialName, item.collection_name))
  return {
    ...item,
    id: first(globalCollectionId, item.id, listId),
    globalCollectionId: globalCollectionId ?? null,
    listId: listId ?? null,
    ownerId: ownerId ?? null,
    source: source || item.source || 'public',
    name,
    count: Number(first(item.count, item.songcount, item.song_count, item.total, 0)) || 0,
    cover: text(first(item.cover, item.imgurl, item.sizable_cover, item.pic, item.ImgUrl, item.img)),
    isFavorite: item.isFavorite === true || enabled(item.is_favorite),
    favoriteCandidate: name === '我喜欢的音乐' || name === '我喜欢',
    isOwned: userId != null ? ownerId != null && String(ownerId) === String(userId) : item.isOwned === true,
  }
}

/** Normalize playable metadata without discarding raw rights, artists, cloud identity or playlist fileid. */
export function normalizeLibrarySong(raw, options = {}) {
  const record = raw && typeof raw === 'object' ? raw : {}
  // History records and privilege metadata wrap the same song fields in song/info.
  const nested = record.song && typeof record.song === 'object' && !Array.isArray(record.song) ? record.song : {}
  const info = record.info && typeof record.info === 'object' && !Array.isArray(record.info) ? record.info : {}
  const item = { ...info, ...nested, ...record }
  const base = item.base && typeof item.base === 'object' ? item.base : {}
  const source = options.source || item.source || 'catalog'
  const rights = item.copyright && typeof item.copyright === 'object' ? item.copyright : {}
  const merged = { ...rights, ...base, ...item }
  const artistInput = { ...merged }
  if (Array.isArray(item.authors)) artistInput.authors = item.authors.map(author =>
    author && typeof author === 'object' ? { ...author.base, ...author } : author)
  const artists = getSongArtists(artistInput)
  const name = text(first(item.name, item.filename, item.FileName, item.songname, item.SongName, item.audio_name, base.audio_name, base.songname, base.name))
  const result = {
    ...merged,
    hash: text(first(item.hash, item.Hash, item.FileHash, item.filehash, item.audio_hash, item.hash_128, base.hash, item.audio_info?.hash, item.audio_info?.hash_128)).trim().toLowerCase(),
    name,
    singername: text(first(item.singername, item.SingerName, item.singer_name, artists.map(artist => artist.name).join('、'))),
    singerinfo: artists,
    album_id: first(item.album_id, item.AlbumID, item.albumid, base.album_id, item.album_info?.album_id, 0),
    album_audio_id: first(item.album_audio_id, item.MixSongID, item.mixsongid, item.mixsong_id, item.mxid, base.album_audio_id, 0),
    audio_id: first(item.audio_id, item.AudioID, base.audio_id, 0),
    fileid: first(item.fileid, item.file_id, item.FileID) ?? null,
    album_name: text(first(item.album_name, item.AlbumName, item.albumname, base.album_name, item.album_info?.album_name)),
    cover: text(first(item.cover, item.sizable_cover, item.imgurl, item.Image, item.image, item.img, item.album_img,
      item.album_cover, item.album_sizable_cover, item.pic, item.album_info?.sizable_cover, item.album_info?.cover)),
    timelen: Number(first(item.timelen, item.timelength, item.duration_ms, item.audio_info?.timelength, item.audio_info?.duration_128,
      Number.isFinite(Number(item.Duration ?? item.duration ?? item.time_length ?? item.TimeLength))
        ? Number(item.Duration ?? item.duration ?? item.time_length ?? item.TimeLength) * 1000 : undefined, 0)) || 0,
    source,
  }
  if (source === 'cloud') {
    result.sourceUserId = text(options.sourceUserId ?? item.sourceUserId)
    result.originalName = text(first(item.originalName, item.filename, item.FileName, name))
  }
  return result
}

/** Follow lists include both people and singers; a user ID never becomes a singer ID. */
export function normalizeLibraryArtist(raw) {
  const item = raw && typeof raw === 'object' ? raw : {}
  let extra = item.ext_params
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra) } catch { extra = null }
  }
  return { ...item,
    singerid: first(item.singerid, item.singer_id, item.author_id, item.SingerId, item.AuthorId, extra?.singerid),
    singername: text(first(item.singername, item.singer_name, item.author_name, item.name, item.nickname)),
    avatar: text(first(item.sizable_avatar, extra?.k_pic, item.k_pic, item.avatar, item.pic, item.image)),
  }
}
