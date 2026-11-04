<template>
  <div class="search-view list-page" :aria-busy="loading">
    <div class="list-content">
      <header class="search-header">
        <p class="eyebrow">SEARCH / 发现音乐</p>
        <h1 class="page-title">{{ searchKeyword || '搜索音乐' }}<span class="search-keyword">.</span></h1>
        <p class="search-info" v-if="searchResults?.lists?.length">共找到 {{ searchResults.total || searchResults.lists.length }} 个结果，当前展示 {{ searchResults.lists.length }} 个</p>
        <p class="search-info" v-else>{{ loading ? '正在寻找与你的关键词有关的声音' : '从歌名、歌手或专辑开始，找到下一首喜欢。' }}</p>
      </header>
      <nav class="search-tabs" aria-label="搜索类型"><button v-for="tab in searchTabs" :key="tab.id" type="button" :aria-current="searchType === tab.id ? 'page' : undefined" @click="selectSearchType(tab.id)">{{ tab.label }}</button></nav>
      <p v-if="errorMessage && searchResults?.lists?.length" class="refresh-error" role="alert">{{ errorMessage }} <button type="button" class="retry-btn" :disabled="loading" @click="performSearch(searchKeyword, searchRequestAppend)">重试</button></p>
      <Transition name="ui-fade" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
      <div v-if="errorMessage && !searchResults?.lists?.length" class="empty-state" role="alert">
        <p class="empty-text">暂时无法搜索</p><p class="empty-hint">{{ errorMessage }}</p>
        <button type="button" class="retry-btn" @click="performSearch()">重新搜索</button>
      </div>

      <!-- 加载状态 -->
      <div v-else-if="loading && !searchResults?.lists?.length" class="loading-container">
        <span class="loading-spinner" role="status" aria-label="加载中"></span>
        <p>搜索中...</p>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!searchResults || !searchResults.lists || searchResults.lists.length === 0" class="empty-state">
        <svg viewBox="0 0 1024 1024" width="80" height="80" fill="currentColor" opacity="0.3">
          <path d="M909.6 854.5L649.9 594.8C690.2 542.7 712 479 712 412c0-80.2-31.3-155.4-87.9-212.1-56.6-56.7-132-87.9-212.1-87.9s-155.5 31.3-212.1 87.9C143.2 256.5 112 331.8 112 412c0 80.1 31.3 155.5 87.9 212.1C256.5 680.8 331.8 712 412 712c67 0 130.6-21.8 182.7-62l259.7 259.6a8.2 8.2 0 0011.6 0l43.6-43.5a8.2 8.2 0 000-11.6zM570.4 570.4C528 612.7 471.8 636 412 636s-116-23.3-158.4-65.6C211.3 528 188 471.8 188 412s23.3-116.1 65.6-158.4C296 211.3 352.2 188 412 188s116.1 23.3 158.4 65.6S636 352.2 636 412s-23.3 116.1-65.6 158.4z"/>
        </svg>
        <p class="empty-text" v-if="!searchKeyword">请输入搜索关键词</p>
        <p class="empty-text" v-else>没有找到相关内容</p>
        <p class="empty-hint" v-if="searchKeyword">尝试使用其他关键词搜索</p>
      </div>

      <div v-else-if="['album', 'author', 'special'].includes(searchType)" class="search-cards"><button v-for="(item, index) in searchResults.lists" :key="`${resultId(item)}-${index}`" type="button" class="search-card" @click="openResult(item)"><ArtworkCover :src="resultCover(item)" class="result-cover" :class="{ 'artist-cover': searchType === 'author' }" /><strong>{{ resultName(item) }}</strong><span>{{ item.SingerName || item.author_name || item.intro || item.Intro || '查看详情' }}</span></button></div>
      <!-- 歌曲与歌词搜索共用曲目操作。 -->
      <div v-else class="song-list">
        <div class="list-header">
          <div class="col-index">
            <span>#</span>
          </div>
          <div class="col-title">歌曲</div>
          <div class="col-artist">歌手</div>
          <div class="col-album">专辑</div>
          <div class="col-duration">时长</div>
          <div class="col-actions-label"><span class="visually-hidden">操作</span></div>
        </div>

        <div
          v-for="(song, index) in searchResults.lists"
          :key="song.FileHash || song.hash || song.Audioid || index"
          class="song-item"
          :class="{ playing: isCurrentlyPlaying(song) }"
          :aria-current="isCurrentlyPlaying(song) ? 'true' : undefined"
          @dblclick="playSong(song)"
          @contextmenu.prevent.stop="showContextMenu($event, song)"
        >
          <div class="col-index">
            <span class="index-number">{{ String(index + 1).padStart(2, '0') }}</span>
          </div>

          <div class="col-title">
            <ArtworkCover :src="getCoverUrl(song.Image || song.img) || ''" class="song-cover" />
            <div class="song-info">
              <div class="song-title-line">
                <button type="button" class="song-name" @click.stop="$emit('search', song)" @dblclick.stop :title="getSongName(song)">
                  {{ getSongName(song) }}
                  <span v-if="(song.FileSize && song.FileSize >= 5000000) || (song.filesize && song.filesize >= 5000000)" class="quality-badge">SQ</span>
                </button>
                <SongBadges :song="song" />
              </div>
              <ArtistLinks class="artist-link mobile-artist" :song="song" @select="$emit('navigate', 'artist', $event)" />
              <p v-if="searchType === 'lyric' && song.Lyric" class="lyric-match">{{ song.Lyric }}</p>
            </div>
          </div>

          <div class="col-artist">
            <ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" />
          </div>
    <div class="col-album"><button type="button" class="album-link" @click.stop="goAlbum(song)" @dblclick.stop>{{ song.AlbumName || song.album_name || '-' }}</button></div>
          <div class="col-duration">{{ formatDuration(song.Duration || song.duration || song.TimeLength) }}</div>
            <div class="action-buttons">
              <button type="button" class="icon-btn play-btn-inline" @click.stop="playSong(song)" title="播放歌曲" @dblclick.stop>
                <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                  <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
                </svg>
              </button>
              <LibraryActions :song="song" />
            </div>
        </div>
      </div>

      </Transition>
      <button v-if="searchResults?.lists?.length && hasMore" type="button" class="search-more action-btn" :disabled="loading" @click="performSearch(searchKeyword, true)">{{ loading ? '正在加载…' : '加载更多结果' }}</button>
      <!-- 右键菜单 -->
      <ContextMenu
        :visible="contextMenuVisible"
        :position="contextMenuPosition"
        :items="contextMenuItems"
        @close="contextMenuVisible = false"
      />
    </div>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import SongBadges from '../components/common/SongBadges.vue'
import ArtistLinks from '../components/common/ArtistLinks.vue'
import LibraryActions from '../components/common/LibraryActions.vue'
import { getSongArtists } from '../utils/songMetadata.js'
import { logger } from '../utils/logger.js'

import { searchMusic } from '../api/music.js'
import { normalizePlaylistResource } from '../utils/libraryMetadata.js'
import ContextMenu from '../components/common/ContextMenu.vue'
import nextplayIcon from '../assets/icons/nextplay.svg'

export default {
  name: 'SearchView',
  inject: { library: { from: 'musicLibrary', default: null } },
  components: {
    ArtworkCover,
    SongBadges,
    ArtistLinks,
    LibraryActions,
    ContextMenu
  },
  emits: ['play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details'],
  props: {
    searchKeyword: {
      type: String,
      default: ''
    },
    currentSong: {
      type: Object,
      default: null
    }
  },
  data() {
    return {
      loading: false,
      errorMessage: '',
      searchRequestId: 0,
      searchRequestAppend: false,
      searchResults: null,
      searchType: 'song',
      searchTabs: [{ id: 'song', label: '单曲' }, { id: 'album', label: '专辑' }, { id: 'author', label: '歌手' }, { id: 'special', label: '歌单' }, { id: 'lyric', label: '歌词' }],
      currentPage: 0,
      hasMore: false,
      searchPages: {},
      searchController: null,
      lastSearchKeyword: '',
      pageFingerprints: [],
      contextMenuVisible: false,
      contextMenuPosition: { x: 0, y: 0 },
      currentContextSong: null,
      nextplayIcon: nextplayIcon
    }
  },
  computed: {
    currentPlayingHash() {
      const hash = this.currentSong?.hash || null
      logger.trace('SearchView', '🎵 [SearchView] currentPlayingHash 计算:', {
        currentSong: this.currentSong,
        hash: hash,
        name: this.currentSong?.name || this.currentSong?.filename,
        timestamp: new Date().toLocaleTimeString()
      })
      return hash
    },
    contextMenuItems() {
      if (!this.currentContextSong) return []
      
      return [
        {
          label: '播放',
          icon: 'M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z',
          action: () => this.playSong(this.currentContextSong)
        },
        {
          label: '下一首播放',
          icon: this.nextplayIcon,
          action: () => this.playNext(this.currentContextSong)
        },
        { divider: true },
        {
          label: '收藏',
          icon: 'M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z',
          action: () => this.toggleFavorite(this.currentContextSong)
        },
        ...[['添加到歌单', 'add-to-playlist'], ['下载', 'download'], ['分享', 'share'], ['评论与其他版本', 'show-details']].map(([label, event]) => ({ label, action: () => this.$emit(event, this.currentContextSong) }))
      ]
    }
  },
  watch: {
    searchKeyword: {
      immediate: true,
      handler(newKeyword) {
        logger.trace('SearchView', '🔍 [SearchView] searchKeyword 变化:', newKeyword)
        if (newKeyword) {
          this.performSearch(newKeyword)
        } else {
          this.searchRequestId += 1
          this.loading = false
          this.searchResults = null
          this.searchController?.abort()
        }
      }
    }
  },
  deactivated() {
    this.contextMenuVisible = false
  },
  beforeUnmount() {
    this.contextMenuVisible = false
    this.searchRequestId += 1
    this.searchController?.abort()
  },
  methods: {
    // 仅接受最新关键词的响应，避免旧请求覆盖结果或提前结束加载状态。
    async performSearch(keyword = this.searchKeyword, append = false) {
      if (!keyword || (append && this.loading)) return
      const requestId = ++this.searchRequestId
      this.searchController?.abort()
      const controller = typeof AbortController === 'undefined' ? null : new AbortController()
      this.searchController = controller
      const type = this.searchType || 'song'
      const nextPage = append ? this.currentPage + 1 : 1
      this.loading = true
      this.errorMessage = ''
      this.searchRequestAppend = append
      try {
        logger.trace('SearchView', '搜索关键词:', keyword)
        const response = await searchMusic(keyword, nextPage, 50, type, { signal: controller?.signal })
        if (requestId !== this.searchRequestId) return
        logger.trace('SearchView', '搜索结果:', response)
        logger.trace('SearchView', '搜索结果详情:', {
          status: response.status,
          data: response.data,
          lists: response.data?.lists,
          firstSong: response.data?.lists?.[0]
        })
        
        if (response.status === 1) {
          const list = response.data?.lists || response.data?.list || response.data?.info
          if (!Array.isArray(list)) throw new Error('搜索结果格式无效，请重试。')
          const fingerprint = JSON.stringify(list)
          if (append && list.length && this.pageFingerprints.includes(fingerprint)) throw new Error('搜索结果没有继续，请稍后重试。')
          const items = append ? [...(this.searchResults?.lists || []), ...list] : list
          const rawTotal = response.data.total ?? response.data.count
          const total = rawTotal == null || rawTotal === '' ? null : Number(rawTotal)
          if (!list.length && Number.isFinite(total) && items.length < total) throw new Error('搜索结果未加载完整，请重试。')
          this.searchResults = { ...response.data, lists: items }
          this.currentPage = nextPage
          this.hasMore = list.length > 0 && (Number.isFinite(total) ? items.length < total : list.length >= 50)
          this.pageFingerprints = append ? [...this.pageFingerprints, fingerprint] : [fingerprint]
          this.lastSearchKeyword = keyword
          this.searchPages[`${type}:${keyword}`] = { results: this.searchResults, page: nextPage, more: this.hasMore, fingerprints: [...this.pageFingerprints] }
        } else {
          this.errorMessage = response.error || '搜索服务暂时不可用，请稍后重试'
          if (!this.searchResults) this.searchResults = { lists: [] }
        }
      } catch (error) {
        if (requestId !== this.searchRequestId) return
        logger.error('SearchView', '搜索失败:', error)
        this.errorMessage = error?.message || '搜索失败，请检查连接后重试'
        if (!this.searchResults) this.searchResults = { lists: [] }
      } finally {
        if (requestId === this.searchRequestId) this.loading = false
      }
    },
    selectSearchType(type) {
      if (type === this.searchType) return
      this.searchController?.abort(); this.searchRequestId++; this.loading = false; this.contextMenuVisible = false; this.errorMessage = ''; this.searchType = type
      const cached = this.searchPages[`${type}:${this.searchKeyword}`]
      this.searchResults = cached?.results || null; this.currentPage = cached?.page || 0; this.hasMore = cached?.more || false; this.pageFingerprints = cached?.fingerprints || []
      if (!cached) this.performSearch()
    },
    resultId(item) { return item.AlbumID ?? item.album_id ?? item.albumid ?? item.AuthorId ?? item.author_id ?? item.SingerId ?? item.specialid ?? item.special_id ?? item.id },
    resultName(item) { return item.AlbumName || item.album_name || item.albumname || item.AuthorName || item.author_name || item.SingerName || item.singername || item.specialname || item.special_name || item.name || '未命名' },
    resultCover(item) { return this.getCoverUrl(item.Image || item.Img || item.img || item.Avatar || item.Cover || item.cover || item.sizable_cover || item.sizable_avatar || item.imgurl || item.avatar || '') },
    openResult(item) {
      if (this.searchType === 'special') {
        const resource = normalizePlaylistResource(item)
        if (!resource.globalCollectionId && !resource.id) { this.errorMessage = '这个歌单尚未提供可用的公开标识，请选择其他歌单。'; return }
        this.$emit('navigate', 'playlist', resource)
      }
      else this.$emit('navigate', this.searchType === 'author' ? 'artist' : 'album', { id: this.resultId(item), name: this.resultName(item) })
    },
    goAlbum(song) {
      const id =
        song.AlbumID ||
        song.album_id ||
        song.albumid ||
        song.base?.album_id ||
        song.album_info?.album_id ||
        song.album_info?.id ||
        null
      const name = song.AlbumName || song.album_name || song.album_info?.album_name || null
      if (id || name) this.$emit('navigate', 'album', { id, name })
    },

    isCurrentlyPlaying(song) {
      const songHash = song.FileHash || song.hash || song.Audioid
      const isPlaying = this.currentPlayingHash == songHash
      if (isPlaying) {
        logger.trace('SearchView', '🎵 [SearchView] 当前播放匹配:', {
          songName: this.getSongName(song),
          songHash: songHash,
          currentHash: this.currentPlayingHash
        })
      }
      return isPlaying
    },

    playSong(song) {
      const songName = this.getSongName(song)
      logger.trace('SearchView', '🎵 [SearchView] 播放歌曲:', songName)
      
      // 标准化歌曲对象以匹配播放器期望的格式，保留更多原始字段
      const standardizedSong = {
        // 保留原始的所有字段
        ...song,
        // 覆盖或添加标准化字段
        hash: song.FileHash || song.hash,
        name: songName,
        filename: songName,
        singername: song.SingerName || song.singername,
        singerinfo: getSongArtists(song),
        albuminfo: song.AlbumName ? { name: song.AlbumName } : null,
        timelen: Number(song.timelen) || Number(song.Duration || song.duration || song.TimeLength || 0) * 1000,
        cover: this.getCoverUrl(song.Image || song.img),
        audio_id: song.Audioid, // 正确的映射：Audioid -> audio_id
        album_audio_id: song.album_audio_id || song.MixSongID || song.mixsongid || 0,
        relate_goods: song.relate_goods || []
      }
      
      this.$emit('play', standardizedSong)
    },

    playNext(song) {
      const songName = this.getSongName(song)
      logger.trace('SearchView', '下一首播放:', songName)
      const standardizedSong = {
        // 保留原始的所有字段
        ...song,
        // 覆盖或添加标准化字段
        hash: song.FileHash || song.hash,
        name: songName,
        filename: songName,
        singername: song.SingerName || song.singername,
        singerinfo: getSongArtists(song),
        albuminfo: song.AlbumName ? { name: song.AlbumName } : null,
        timelen: Number(song.timelen) || Number(song.Duration || song.duration || song.TimeLength || 0) * 1000,
        cover: this.getCoverUrl(song.Image || song.img),
        audio_id: song.Audioid, // 正确的映射：Audioid -> audio_id
        album_audio_id: song.album_audio_id || song.MixSongID || song.mixsongid || 0,
        relate_goods: song.relate_goods || []
      }
      this.$emit('play-next', standardizedSong)
    },

    toggleFavorite(song) {
      const songName = this.getSongName(song)
      logger.trace('SearchView', '切换收藏状态:', songName)
      this.$emit('toggle-favorite', song)
    },

    showContextMenu(event, song) {
      this.currentContextSong = song
      const rect = event.currentTarget?.getBoundingClientRect?.()
      this.contextMenuPosition = { x: event.clientX || rect?.right || 0, y: event.clientY || rect?.bottom || 0 }
      this.contextMenuVisible = true
    },

    getCoverUrl(imgUrl) {
      if (!imgUrl) return null
      // 酷狗API的图片URL格式处理
      if (imgUrl.includes('{size}')) {
        return imgUrl.replace('{size}', '400')
      }
      return imgUrl
    },

    getSongName(song) {
      // 优先使用 OriSongName（原始歌曲名），然后是 FileName
      let name = song.OriSongName || song.FileName || song.filename || song.songname || song.audio_name || song.song_name || song.name || song.title
      

      
      if (!name) return '未知歌曲'
      
      // 移除文件扩展名
      name = name.replace(/\.(mp3|flac|wav|aac|m4a)$/i, '')
      
      // 如果使用的是 FileName 且包含歌手信息，提取歌曲名部分
      if (name.includes(' - ') && name === song.FileName) {
        const parts = name.split(' - ')
        return parts.length > 1 ? parts[1] : parts[0]
      }
      
      return name
    },

    formatDuration(duration) {
      if (!duration) return '-'
      
      // 如果是秒为单位，转换为毫秒
      const ms = duration < 10000 ? duration * 1000 : duration
      
      const totalSeconds = Math.floor(ms / 1000)
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = totalSeconds % 60
      
      return `${minutes}:${seconds.toString().padStart(2, '0')}`
    }
  }
}
</script>

<style src="./styles/ListPage.css" scoped></style>
<style scoped>
.lyric-match{font-size:12px;color:var(--color-text-secondary);margin:6px 0 0;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.search-tabs{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 30px;border-bottom:1px solid var(--color-border);padding-bottom:16px}.search-tabs button{border:1px solid var(--color-border);border-radius:999px;background:transparent;color:inherit;padding:9px 20px;font:inherit;cursor:pointer}.search-tabs [aria-current]{border-color:var(--color-primary);color:var(--color-primary);background:var(--color-background-light)}.search-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:24px}.search-card{display:flex;flex-direction:column;min-width:0;gap:10px;text-align:left;background:transparent;border:0;padding:0;color:inherit;cursor:pointer}.result-cover{width:100%;aspect-ratio:1;border-radius:12px;transition:transform .2s}.artist-cover{border-radius:50%}.search-card:hover .result-cover{transform:translateY(-4px)}.search-card strong{font-size:14px;line-height:1.5}.search-card>span{font-size:12px;color:var(--color-text-secondary);overflow:hidden;max-width:100%;white-space:nowrap;text-overflow:ellipsis}.search-more{display:block;margin:30px auto}.favorite-btn.active{color:var(--color-primary)}.search-tabs button:focus-visible,.search-card:focus-visible{outline:2px solid var(--color-primary);outline-offset:4px}@media(prefers-reduced-motion:reduce){.result-cover{transition:none}}
</style>
