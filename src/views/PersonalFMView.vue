<template>
  <div class="personal-fm-view list-page" :aria-busy="loading">
    <div class="list-content">
      <button type="button" class="back-btn" @click="handleBack">← 返回发现</button>
      <header class="fm-header">
        <p class="eyebrow">PERSONAL RADIO / 私人电台</p>
        <h1 class="page-title">私人 FM<span class="fm-dot">.</span></h1>
        <p class="collection-description">让熟悉与惊喜交替发生，听见属于你的频率。</p>
        <div class="collection-meta"><span>{{ songs.length }} 首待听歌曲</span><span>为你而选</span></div>
      </header>

      <Transition name="ui-fade" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
      <div v-if="loading" class="loading-container">
        <span class="loading-spinner" role="status" aria-label="加载中"></span>
        <p>加载中...</p>
      </div>

      <div v-else-if="error" class="error">
        <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
          <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
          <path d="M464 688a48 48 0 1096 0 48 48 0 10-96 0zm8-336h48c4.4 0 8 3.6 8 8v272c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V360c0-4.4 3.6-8 8-8z"/>
        </svg>
        <p>{{ error }}</p>
        <button class="retry-btn" @click="loadData">重试</button>
      </div>

      <div v-else-if="songs.length === 0" class="empty">
        <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
          <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
        </svg>
        <p>暂无推荐内容</p>
      </div>

      <div v-else class="fm-grid">
        <article v-for="song in songs" :key="song.hash" class="fm-card" :class="{ playing: !!song.hash && currentSong?.hash === song.hash }">
          <button type="button" class="fm-play" @click="handlePlay(song)" :aria-label="'播放 ' + (song.songname || song.filename)">
            <ArtworkCover :src="song.imgurl || song.album_img || ''" class="fm-cover" />
            <span class="fm-play-icon" aria-hidden="true">▶</span>
          </button>
          <button type="button" class="fm-song-title" :title="song.songname || song.filename" @click.stop="$emit('search', song)" @dblclick.stop>{{ song.songname || song.filename }}</button>
          <SongBadges :song="song" />
          <ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" />
        </article>
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

import { getPersonalFM } from '../api/music.js'
import { useSettingsStore } from '../stores/settingsStore.js'

export default {
  components: { ArtworkCover, SongBadges, ArtistLinks },
  name: 'PersonalFMView',
  emits: ['navigate', 'play', 'search'],
  props: {
    currentSong: {
      type: Object,
      default: null
    }
  },
  setup() {
    const { settings } = useSettingsStore()
    return { settings }
  },
  data() {
    return {
      loading: false,
      error: null,
      songs: []
    }
  },
  mounted() {
    this.loadData()
  },
  methods: {
    async loadData() {
      try {
        this.loading = true
        this.error = null
        const response = await getPersonalFM()
        logger.trace('PersonalFMView', '私人FM响应:', response)
        
        if (response.status === 1 && response.data) {
          this.songs = response.data.list || []
        } else {
          this.error = '加载失败'
        }
      } catch (error) {
        logger.error('PersonalFMView', '加载私人FM失败:', error)
        this.error = '加载失败，请重试'
      } finally {
        this.loading = false
      }
    },
    handleBack() {
      this.$emit('navigate', 'home')
    },
    
    handlePlay(song) {
      logger.trace('PersonalFMView', '[PersonalFM] handlePlay调用:', song)
      // 规范化歌曲数据字段
      const normalizedSong = {
        ...song,
        name: song.songname || song.filename || song.name,
        singername: song.author_name || song.singername,
        author_name: song.author_name || song.singername,
        cover: song.imgurl || song.album_img,
        album_name: song.album_name || song.remark,
        timelen: song.duration || song.time_length || song.timelen
      }
      this.$emit('play', normalizedSong)
    },
    
    fixImgUrl(url) {
      if (!url) return ''
      return url.replace('{size}', '150')
    }
  }
}
</script>

<style src="./styles/ListPage.css" scoped></style>

<style src="./styles/PersonalFMView.css" scoped></style>
