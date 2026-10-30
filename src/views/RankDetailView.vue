<template>
  <div class="rank-detail-view list-page" :aria-busy="loading">
    <div class="list-content">
      <button type="button" class="back-btn" @click="handleBack">← 返回发现</button>
      <header class="collection-hero">
        <ArtworkCover :src="rankInfo?.imgurl || rankInfo?.banner7url || songs.find(song => song.imgurl)?.imgurl || ''" class="collection-art" mark="#" />
        <div class="collection-copy">
          <p class="eyebrow">THE CHART / 排行榜</p>
          <h1 class="page-title">{{ rankInfo?.rankname || '排行榜' }}</h1>
          <p class="collection-description">{{ rankInfo?.intro || '从热爱里听见潮流，发现此刻值得聆听的声音。' }}</p>
          <div class="collection-meta"><span>{{ songs.length }} 首歌曲</span><span v-if="rankInfo?.update_frequency">{{ rankInfo.update_frequency }}</span></div>
          <div class="collection-actions"><button type="button" class="play-all-btn" :disabled="songs.length === 0" @click="handlePlayAll"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>播放全部</button></div>
        </div>
      </header>
      <div class="section-heading"><h2>曲目</h2><span>跟随音乐的热度</span></div>

      <Transition name="ui-fade" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">      <div v-if="error && songs.length > 0" class="refresh-error" role="alert"><span>{{ error }}</span><button type="button" class="retry-btn" @click="loadData">重试</button></div></Transition>
      <Transition name="ui-fade" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
      <div v-if="loading && songs.length === 0" class="loading-container">
        <span class="loading-spinner" role="status" aria-label="加载中"></span>
        <p>加载中...</p>
      </div>

      <div v-else-if="error && songs.length === 0" class="error" role="alert">
        <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
          <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
          <path d="M464 688a48 48 0 1096 0 48 48 0 10-96 0zm8-336h48c4.4 0 8 3.6 8 8v272c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V360c0-4.4 3.6-8 8-8z"/>
        </svg>
        <p>{{ error }}</p>
        <button type="button" class="retry-btn" @click="loadData">重试</button>
      </div>

      <div v-else-if="songs.length === 0" class="empty">
        <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
          <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
        </svg>
        <p>暂无榜单内容</p>
      </div>

      <div v-else class="song-list">
        <div class="list-header">
          <div class="col-index">#</div>
          <div class="col-title">歌曲</div>
          <div class="col-artist">歌手</div>
          <div class="col-album">专辑</div>
          <div class="col-duration">时长</div>
          <div class="col-actions-label"><span class="visually-hidden">操作</span></div>
        </div>

        <div
          v-for="(song, index) in songs"
          :key="song.hash"
          class="song-item"
          :class="{ 'top-three': index < 3, playing: !!song.hash && currentSong?.hash === song.hash }"
          :aria-current="song.hash && currentSong?.hash === song.hash ? 'true' : undefined"
          @dblclick="handlePlay(song)"
        >
          <div class="col-index">
            <span class="index-number" :class="{ 'gold': index === 0, 'silver': index === 1, 'bronze': index === 2 }">
              {{ String(index + 1).padStart(2, '0') }}
            </span>
          </div>

          <div class="col-title">
            <ArtworkCover :src="song.imgurl || song.album_img || ''" class="song-cover" />
            <div class="song-info">
              <div class="song-title-line">
                <button type="button" class="song-name" @click.stop="$emit('search', song)" @dblclick.stop :title="song.songname || song.filename || '未知歌曲'">{{ song.songname || song.filename }}</button>
                <SongBadges :song="song" />
              </div>
              <ArtistLinks class="artist-link mobile-artist" :song="song" @select="$emit('navigate', 'artist', $event)" />
            </div>
          </div>

          <div class="col-artist">
            <ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" />
          </div>
          <div class="col-album">
            <button type="button" class="album-link" @click.stop="goAlbum(song)" @dblclick.stop>{{ song.album_name || song.remark || '-' }}</button>
          </div>
          <div class="col-duration">{{ formatDuration(song.duration) }}</div>
            <div class="action-buttons">
              <button type="button" class="icon-btn play-btn-inline" @click.stop="handlePlay(song)" title="播放" @dblclick.stop>
                <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                  <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
                </svg>
              </button>
            </div>
        </div>
      </div>
      </Transition>
    </div>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import SongBadges from '../components/common/SongBadges.vue'
import ArtistLinks from '../components/common/ArtistLinks.vue'
import { logger } from '../utils/logger.js'

import { getRankSongs } from '../api/music.js'
import { getSongArtists } from '../utils/songMetadata.js'
import { useSettingsStore } from '../stores/settingsStore.js'

export default {
  components: { ArtworkCover, SongBadges, ArtistLinks },
  name: 'RankDetailView',
  props: {
    rankData: {
      type: Object,
      required: true
    },
    currentSong: {
      type: Object,
      default: null
    }
  },
  emits: ['navigate', 'play', 'play-all', 'search'],
  setup() {
    const { settings } = useSettingsStore()
    return { settings }
  },
  data() {
    return {
      loading: false,
      error: null,
      songs: [],
      rankInfo: null,
      isDisposed: false
    }
  },
  mounted() {
    this.rankInfo = this.rankData
    this.loadData()
  },
  beforeUnmount() {
    this.isDisposed = true
  },
  methods: {
    /** 按接口总数读取完整榜单，成功后一次替换，失败保留上次可用曲目。 */
    async loadData() {
      if (this.loading || this.isDisposed) return
      const rankid = this.rankData.rankid
      let page = 1
      try {
        this.loading = true
        this.error = null
        const songs = []
        const seenPages = new Set()
        while (!this.isDisposed) {
          const response = await getRankSongs(rankid, page, 100)
          if (this.isDisposed) return
          const list = response?.data?.songlist
          if (Number(response?.status) !== 1 || !Array.isArray(list)) {
            throw new Error('排行榜曲目响应无效')
          }
          const rawTotal = response.data.total ?? response.total
          const total = rawTotal == null || rawTotal === '' ? null : Number(rawTotal)
          const hasTotal = Number.isInteger(total) && total >= 0
          if (list.length === 0) {
            if (hasTotal && songs.length < total) throw new Error('排行榜曲目分页不完整')
            break
          }
          const normalized = list.map(song => this.normalizeRankSong(song))
          const fingerprint = JSON.stringify(normalized.map(song => [song.hash, song.album_audio_id]))
          if (seenPages.has(fingerprint)) throw new Error('排行榜返回重复分页')
          seenPages.add(fingerprint)
          songs.push(...normalized)
          if (hasTotal && songs.length >= total) break
          page += 1
        }
        if (!this.isDisposed) this.songs = songs
      } catch (error) {
        if (this.isDisposed) return
        logger.error('RankDetailView', '加载排行榜曲目失败:', { rankid, page }, error)
        this.error = '加载失败，请重试'
      } finally {
        if (!this.isDisposed) this.loading = false
      }
    },
    /** 将排行曲目的嵌套音频/专辑字段转为列表和播放器约定，保留权限与歌手身份。 */
    normalizeRankSong(song) {
      const audio = song.audio_info || {}
      const legacy = song.deprecated || {}
      const album = song.album_info || {}
      const singerinfo = getSongArtists(song)
      const singername = singerinfo.map(artist => artist.name).join('、') || song.author_name || song.singername
      const timelen = Number(audio.duration_128 || song.timelen || legacy.duration || (song.duration || song.time_length || 0) * 1000)
      const name = song.songname || song.filename || song.name || song.business?.filename
      const cover = song.imgurl || song.album_img || song.cover || album.sizable_cover || ''
      return {
        ...legacy,
        ...song,
        hash: song.hash || audio.hash_128 || legacy.hash,
        name,
        songname: song.songname || name,
        filename: song.filename || song.business?.filename || name,
        singerinfo,
        singername,
        author_name: singername,
        cover,
        imgurl: cover,
        album_name: song.album_name || album.album_name || song.remark,
        privilege: song.privilege ?? song.privilege_download?.privilege,
        timelen,
        duration: timelen / 1000
      }
    },
    goAlbum(song) {
      const id =
        song.album_id ||
        song.albumid ||
        song.AlbumID ||
        song.base?.album_id ||
        song.album?.id ||
        song.album_info?.album_id ||
        song.album_info?.id ||
        null
      const name = song.album_name || song.remark || song.album_info?.album_name || null
      if (id || name) this.$emit('navigate', 'album', { id, name })
    },
    
    handleBack() {
      this.$emit('navigate', 'home')
    },
    
    handlePlay(song) {
      logger.trace('RankDetailView', '[RankDetail] handlePlay调用:', song)
      logger.trace('RankDetailView', '[RankDetail] 设置 - enqueueFullPlaylist:', this.settings?.playback?.enqueueFullPlaylist)
      
      // 规范化歌曲数据字段
      const normalizedSong = this.normalizeRankSong(song)
      
      // 检查是否开启了"自动将全部歌单歌曲加入播放列表"功能
      if (this.settings?.playback?.enqueueFullPlaylist && this.songs.length > 0) {
        logger.trace('RankDetailView', '[RankDetail] 自动加入全部歌曲到播放列表')
        const songIndex = this.songs.findIndex(s => s.hash === song.hash)
        
        if (songIndex !== -1) {
          const normalizedSongs = this.songs.map(s => this.normalizeRankSong(s))
          
          const reorderedList = [
            normalizedSongs[songIndex],
            ...normalizedSongs.slice(0, songIndex),
            ...normalizedSongs.slice(songIndex + 1)
          ]
          this.$emit('play-all', reorderedList)
        } else {
          const normalizedSongs = this.songs.map(s => this.normalizeRankSong(s))
          this.$emit('play-all', normalizedSongs)
        }
      } else {
        this.$emit('play', normalizedSong)
      }
    },
    
    handlePlayAll() {
      logger.trace('RankDetailView', '[RankDetail] 播放全部')
      const normalizedSongs = this.songs.map(song => this.normalizeRankSong(song))
      this.$emit('play-all', normalizedSongs)
    },
    
    formatDuration(seconds) {
      if (!seconds) return '--:--'
      const minutes = Math.floor(seconds / 60)
      const secs = Math.floor(seconds % 60)
      return `${minutes}:${secs.toString().padStart(2, '0')}`
    },
    
    fixImgUrl(url) {
      if (!url) return ''
      return url.replace('{size}', '150')
    }
  }
}
</script>

<style src="./styles/ListPage.css" scoped></style>
