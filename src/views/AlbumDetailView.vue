<template>
  <div class="album-detail-view" v-if="album">
    <div class="header">
      <button class="back-btn" @click="$emit('navigate','home')">
        <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
          <path d="M724 218.3V141c0-6.7-7.7-10.4-12.9-6.3L260.3 486.8a31.86 31.86 0 000 50.3l450.8 352.1c5.3 4.1 12.9.4 12.9-6.3v-77.3c0-4.9-2.3-9.6-6.1-12.6l-360-281 360-281.1c3.8-3 6.1-7.7 6.1-12.6z"/>
        </svg>
        返回
      </button>
      <h1 class="page-title">{{ album.album_name || album.name }}</h1>
    </div>

    <div class="album-header">
      <img v-if="album.sizable_cover || album.cover" :src="getCover(album)" class="cover" />
      <div class="meta">
        <h2 class="name">{{ album.album_name || album.name }}</h2>
        <div class="sub">{{ album.author_name || album.singername || '-' }}</div>
        <div class="sub">发行时间：{{ album.publish_date || album.pub_time || '-' }}</div>
      </div>
    </div>

    <div class="song-list" v-if="songs.length">
      <div class="list-header">
        <div class="col-index">#</div>
        <div class="col-title">歌曲</div>
        <div class="col-artist">歌手</div>
        <div class="col-duration">时长</div>
      </div>
      <div v-for="(song, idx) in songs" :key="song.hash || idx" class="song-item" @dblclick="$emit('play', song)">
        <div class="col-index">{{ idx + 1 }}</div>
        <div class="col-title">
          <img v-if="song.cover" :src="song.cover.replace('{size}','400')" class="song-cover" />
          <div class="song-info">
            <div class="song-name">{{ getSongName(song.name) }}</div>
          </div>
        </div>
        <div class="col-artist">{{ getSingerNames(song.singerinfo, song) }}</div>
        <div class="col-duration">{{ formatDuration(song.timelen) }}</div>
      </div>
    </div>

    <div v-else class="loading-container">
      <template v-if="error">
        <p>获取专辑曲目失败：{{ error }}</p>
        <button class="back-btn" @click="load">重试</button>
      </template>
      <template v-else>
        <span class="loading-spinner" role="status" aria-label="加载中"></span>
        <p>加载中...</p>
      </template>
    </div>
  </div>
</template>

<script>
import { logger } from '../utils/logger.js'

import { getAlbumDetail, getAlbumSongs, getImagesByHash } from '../api/music.js'

export default {
  name: 'AlbumDetailView',
  props: {
    albumId: { type: [String, Number], required: false },
    albumName: { type: String, default: '' }
  },
  emits: ['navigate','play'],
  data() {
    return {
      id: this.albumId || null,
      album: null,
      songs: [],
      error: null,
      loading: false
    }
  },
  async mounted() {
    await this.load()
  },
  methods: {
    async load() {
      try {
        this.loading = true
        this.error = null
        if (!this.id && this.albumName) {
          // 简单兜底：通过搜索接口也可实现，这里先跳过
        }
        if (this.id) {
          const detail = await getAlbumDetail(this.id)
          this.album = detail?.data || detail?.album || detail || {}
          const list = await this.fetchSongsWithRetry(this.id)
          this.songs = this.normalizeAudioList(list)
          if (this.songs.length) {
            this.$nextTick(() => this.patchMissingCovers(this.songs))
          }
        }
      } catch (e) {
        logger.error('AlbumDetailView', '加载专辑失败', e)
        this.error = e?.message || '加载专辑失败'
      } finally {
        this.loading = false
      }
    },
    async fetchSongsWithRetry(id) {
      const page = 1
      const sizes = [100, 60, 30, 20, 10]
      let lastError = null
      for (const pagesize of sizes) {
        try {
          const res = await getAlbumSongs(id, page, pagesize)
          const list = res?.data?.songs || res?.data?.list || res?.songs || res?.list || []
          if (Array.isArray(list) && list.length) {
            return list
          }
        } catch (err) {
          lastError = err
          const status = err?.response?.status
          if (status && status >= 500) {
            await new Promise(r => setTimeout(r, 200))
            continue
          }
          throw err
        }
      }
      try {
        const res = await getAlbumSongs(id)
        const list = res?.data?.songs || res?.data?.list || res?.songs || res?.list || []
        if (Array.isArray(list) && list.length) return list
      } catch (err) {
        lastError = err
      }
      if (lastError) throw lastError
      return []
    },
    normalizeAudioList(list) {
      if (!Array.isArray(list)) return []
      return list.map(it => {
        const hash = it.hash || it.Hash || it.filehash || it.FileHash || it.audio_hash
        const cover = it.sizable_cover || it.cover || it.img || it.Image || ''
        const authors = it.authors || it.singerinfo || []
        const singerArray = Array.isArray(authors)
          ? authors.map(a => ({ id: a.id || a.author_id || a.singerid, name: a.name || a.author_name || a.singer_name || a.singername })).filter(a => a.name)
          : []
        const singername = singerArray.map(a => a.name).join('、') || it.singername || it.SingerName || it.author_name
        const rawName = it.audio_name || it.song_name || it.name || it.filename || it.remark
        const name = rawName || (typeof it.filename === 'string' ? it.filename.split(' - ').slice(1).join(' - ') : '未知歌曲')
        const timelen = (it.timelength || it.timelen || it.Duration || it.duration || 0) * (it.Duration || it.duration ? 1000 : 1)
        return { ...it, hash, cover, singerinfo: singerArray, singername, name, filename: name, timelen }
      })
    },
    async patchMissingCovers(list) {
      const need = (list || []).filter(s => !s.cover && s.hash).slice(0, 50)
      if (need.length === 0) return
      try {
        const hashes = need.map(s => s.hash)
        const res = await getImagesByHash(hashes, 1)
        const map = res?.data || res?.images || res || {}
        need.forEach(item => {
          const pics = map[item.hash] || map[item.hash?.toLowerCase()] || []
          const first = Array.isArray(pics) ? pics[0] : null
          const url = first?.sizable_cover || first?.url || first
          if (url) item.cover = String(url).replace('{size}', '400')
        })
      } catch (error) {
        // 封面补全失败仍展示曲目与占位图，保留诊断而不阻断专辑浏览。
        logger.warn('AlbumDetailView', '补全专辑曲目封面失败', error)
      }
    },
    getCover(album) {
      const url = album?.sizable_cover || album?.cover || ''
      return typeof url === 'string' ? url.replace('{size}', '400') : ''
    },
    getSingerNames(singerinfo, song) {
      if (Array.isArray(singerinfo) && singerinfo.length) {
        return singerinfo.map(s => s.name || s.singer_name || s.singername || s.author_name).filter(Boolean).join('、')
      }
      if (typeof singerinfo === 'string' && singerinfo.trim()) return singerinfo
      return song?.singername || song?.author_name || ''
    },
    getSongName(fullName) {
      if (!fullName) return '未知歌曲'
      const parts = fullName.split(' - ')
      return parts.length > 1 ? parts.slice(1).join(' - ') : fullName
    },
    formatDuration(milliseconds) {
      if (!milliseconds) return '-'
      const seconds = Math.floor(milliseconds / 1000)
      const mins = Math.floor(seconds / 60)
      const secs = seconds % 60
      return `${mins}:${secs.toString().padStart(2, '0')}`
    }
  }
}
</script>

<style scoped>
.album-detail-view { padding: var(--spacing-xl); max-width: 1200px; margin: 0 auto; }
.header { display: flex; align-items: center; gap: var(--spacing-lg); margin-bottom: var(--spacing-xl); }
.back-btn { display: flex; align-items: center; gap: var(--spacing-xs); padding: var(--spacing-sm) var(--spacing-md); background: var(--color-background-light); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); font-size: var(--font-size-sm); cursor: pointer; transition: all var(--transition-fast); }
.back-btn:hover { border-color: var(--color-primary); color: var(--color-primary); }
.page-title { flex: 1; font-size: var(--font-size-2xl); font-weight: 600; color: var(--color-text); margin: 0; }
.album-header { display: flex; gap: var(--spacing-xl); align-items: center; margin-bottom: var(--spacing-xl); }
.cover { width: 160px; height: 160px; border-radius: 12px; object-fit: cover; }
.meta .name { font-size: var(--font-size-xl); margin: 0; }
.meta .sub { color: var(--color-text-secondary); margin-top: 6px; }
.song-list { background: var(--color-background-light); border-radius: var(--radius-lg); overflow: hidden; }
.list-header, .song-item { display: grid; grid-template-columns: 60px 1fr 240px 140px; gap: var(--spacing-md); align-items: center; padding: var(--spacing-md) var(--spacing-lg); }
.list-header { font-size: var(--font-size-sm); color: var(--color-text-tertiary); border-bottom: 1px solid var(--color-border); font-weight: 500; }
.song-item { border-bottom: 1px solid var(--color-border); transition: background var(--transition-fast); cursor: pointer; }
.song-item:hover { background: var(--color-background); }
.song-cover { width: 40px; height: 40px; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0; }
.song-info { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; flex: 1; }
.song-name { color: var(--color-text); font-size: var(--font-size-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loading-container { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: var(--spacing-xl) 0; color: var(--color-text-secondary); }
.loading-gif { width: 60px; height: 60px; margin-bottom: var(--spacing-md); }
</style>
