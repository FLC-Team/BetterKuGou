<template>
  <div class="album-detail-view list-page" :aria-busy="loading">
    <div class="list-content">
      <button type="button" class="back-btn" @click="$emit('navigate', 'home')">← 返回发现</button>
      <header class="collection-hero">
        <ArtworkCover :src="getCover(album)" class="collection-art" mark="♪" />
        <div class="collection-copy">
          <p class="eyebrow">THE ALBUM / 专辑</p>
          <h1 class="page-title">{{ album?.album_name || album?.name || albumName || '专辑' }}</h1>
          <p class="collection-description">一张专辑，一段完整的音乐叙事。</p>
          <div class="collection-meta"><span>{{ album?.author_name || album?.singername || '未知歌手' }}</span><span v-if="album?.publish_date || album?.pub_time">{{ album.publish_date || album.pub_time }}</span><span>{{ songs.length }} 首歌曲</span></div>

        </div>
      </header>
      <div class="section-heading"><h2>专辑曲目</h2></div>

      <div class="song-list" v-if="songs.length">
        <div class="list-header">
          <div class="col-index">#</div>
          <div class="col-title">歌曲</div>
          <div class="col-artist">歌手</div>
          <div class="col-duration">时长</div>
        </div>
        <div v-for="(song, idx) in songs" :key="song.hash || idx" class="song-item" :class="{ playing: !!song.hash && currentSong?.hash === song.hash }" :aria-current="song.hash && currentSong?.hash === song.hash ? 'true' : undefined" @dblclick="$emit('play', song)">
          <div class="col-index">{{ String(idx + 1).padStart(2, '0') }}</div>
          <div class="col-title">
            <ArtworkCover :src="song.cover || ''" class="song-cover" />
            <div class="song-info">
              <button type="button" class="song-name" @click.stop="$emit('play', song)" @dblclick.stop :title="getSongName(song.name)">{{ getSongName(song.name) }}</button>
              <span class="mobile-artist">{{ getSingerNames(song.singerinfo, song) || '未知歌手' }}</span>
            </div>
          </div>
          <div class="col-artist">{{ getSingerNames(song.singerinfo, song) }}</div>
          <div class="col-duration">{{ formatDuration(song.timelen) }}</div>
        </div>
      </div>

      <div v-else-if="loading" class="loading-container"><span class="loading-spinner" role="status" aria-label="加载中"></span><p>正在打开专辑…</p></div>
      <div v-else-if="error" class="error" role="alert">
  <p class="empty-text">无法打开专辑</p><p>{{ error }}</p><button type="button" class="retry-btn" @click="load">重试</button>
      </div>
      <div v-else class="empty"><p class="empty-text">暂无专辑曲目</p><p>稍后再来听听，或返回发现更多音乐。</p></div>
    </div>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import { logger } from '../utils/logger.js'

import { getAlbumDetail, getAlbumSongs, getImagesByHash } from '../api/music.js'

export default {
  components: { ArtworkCover },
  name: 'AlbumDetailView',
  props: {
    albumId: { type: [String, Number], required: false },
    albumName: { type: String, default: '' },
    currentSong: { type: Object, default: null }
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

<style src="./styles/ListPage.css" scoped></style>
