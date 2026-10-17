<template>
  <div class="home-view">
    <div class="home-content">
      <header class="home-header">
        <div>
          <p class="eyebrow">YOUR DAILY SOUNDTRACK</p>
          <h1 class="page-title">发现音乐<span class="title-dot">.</span></h1>
        </div>
        <p class="header-note">让喜欢的音乐，填满今天。</p>
      </header>

      <section class="featured-grid" aria-label="为你发现">
        <button class="daily-feature" type="button" @click="handleDailyRecommend">
          <span class="feature-copy">
            <span class="feature-kicker"><span class="status-dot"></span> 每日推荐 / DAILY MIX</span>
            <span class="feature-title">今天，<br />听点喜欢的。</span>
            <span class="feature-description">熟悉的心动，也有意外的新发现。</span>
            <span class="feature-action">
              <span class="round-play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7z" /></svg></span>
              <span>开启今日歌单</span>
              <span v-if="dailyLoading" class="feature-count">准备中</span>
              <span v-else-if="dailyCount" class="feature-count">{{ dailyCount }} 首精选</span>
            </span>
          </span>
          <span class="daily-art" aria-hidden="true">
            <span class="record-disc"><span class="record-label">BK<br /><small>DAILY SOUNDS</small></span></span>
            <span class="record-sleeve">
              <span class="sleeve-pattern"></span>
              <img v-if="dailyCover && !failedImages[fixImgUrl(dailyCover, 400)]" :src="fixImgUrl(dailyCover, 400)" alt="" @error="markImageFailed(dailyCover, 400)" />
              <span v-else class="sleeve-lettering"><small>THE DAILY</small><strong>好音乐<br />日常听。</strong><span>SELECTED FOR YOU</span></span>
              <span class="sleeve-caption">DAILY MIX <span>↗</span></span>
            </span>
          </span>
        </button>

        <button class="fm-feature" type="button" @click="handlePersonalFM">
          <span class="feature-kicker">PERSONAL RADIO <span class="radio-live" aria-hidden="true"></span></span>
          <span class="fm-art" aria-hidden="true">
            <span v-for="bar in 19" :key="bar" :style="{ '--bar-height': `${[20, 34, 48, 30, 60, 42, 76, 54, 88, 100, 72, 50, 80, 40, 60, 28, 44, 32, 18][bar - 1]}%` }"></span>
          </span>
          <span class="fm-bottom">
            <span><span class="fm-title">猜你喜欢</span><span class="fm-description">私人 FM · 随心听下去</span></span>
            <span class="fm-arrow" aria-hidden="true">↗</span>
          </span>
          <span class="fm-status">{{ fmLoading ? '正在寻找好音乐…' : fmCount ? `${fmCount} 首音乐，等你遇见` : '下一首，也许就是心头好' }}</span>
        </button>
      </section>

      <section class="recommend-section" aria-labelledby="recommend-title" :aria-busy="aiLoading">
        <header class="section-header">
          <div><p class="eyebrow">MADE FOR YOU</p><h2 id="recommend-title" class="section-title">为你精选<span class="section-caption">从你的喜欢，听见更多</span></h2></div>
          <div class="section-actions">
            <button class="refresh-btn text-action" type="button" :disabled="aiLoading" @click="loadAIRecommend">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.4-1L20 9M4 15l2.5 3A7 7 0 0 0 18 17" /></svg>
              {{ aiLoading ? '更新中' : '换一批' }}
            </button>
            <button v-if="aiRecommendList.length > 6" class="recommend-toggle text-action" type="button" :aria-expanded="showAllRecommendations" aria-controls="recommend-grid" @click="showAllRecommendations = !showAllRecommendations">{{ showAllRecommendations ? '收起' : '查看全部' }} <span aria-hidden="true">{{ showAllRecommendations ? '−' : '↗' }}</span></button>
          </div>
        </header>

        <div v-if="aiLoading && !aiRecommendList.length" class="recommend-grid skeleton-grid" role="status" aria-label="正在加载推荐歌曲">
          <div v-for="item in 6" :key="item" class="skeleton-card" aria-hidden="true"><div class="skeleton-cover"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>
        </div>
        <div v-else-if="!aiRecommendList.length" class="recommend-empty">
          <span class="empty-record" aria-hidden="true">♪</span>
          <div><h3>好音乐，从你的喜欢开始</h3><p>收藏喜欢的歌曲，让 AI 为你发现更多心动旋律。</p></div>
          <button class="text-action empty-action" type="button" @click="handleDailyRecommend">先听每日推荐 <span aria-hidden="true">↗</span></button>
        </div>
        <div v-else id="recommend-grid" class="recommend-grid">
          <article v-for="song in visibleRecommendations" :key="song.hash" class="song-card">
            <button class="song-play" type="button" :aria-label="`播放 ${song.songname || song.filename || song.name || '歌曲'}`" @click="handleSongClick(song)">
              <span class="song-cover">
                <span class="cover-placeholder" aria-hidden="true"><span>♪</span></span>
                <img v-if="song.imgurl && !failedImages[fixImgUrl(song.imgurl, 400)]" :src="fixImgUrl(song.imgurl, 400)" alt="" loading="lazy" @error="markImageFailed(song.imgurl, 400)" />
                <span class="play-overlay" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 5 11 7-11 7z" /></svg></span>
              </span>
            </button>
            <button class="song-name" type="button" :title="song.songname || song.filename || song.name" @click.stop="$emit('search', song)" @dblclick.stop>{{ song.songname || song.filename || song.name || '未知歌曲' }}</button>
            <SongBadges :song="song" />
            <ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" />
          </article>
        </div>
      </section>

      <section class="rank-section" aria-labelledby="rank-title" :aria-busy="rankLoading">
        <header class="section-header">
          <div><p class="eyebrow">ON THE CHARTS</p><h2 id="rank-title" class="section-title">此刻流行<span class="section-caption">好音乐，正在被听见</span></h2></div>
          <button v-if="rankList.length > 4" class="rank-toggle text-action" type="button" :aria-expanded="showRankList" aria-controls="rank-grid" @click="toggleRankList">{{ showRankList ? '收起榜单' : '全部榜单' }} <span aria-hidden="true">{{ showRankList ? '−' : '↗' }}</span></button>
        </header>
        <div v-if="rankLoading && !rankList.length" class="rank-empty" role="status"><span class="loading-spinner" aria-hidden="true"></span> 正在加载榜单…</div>
        <div v-else-if="!rankList.length" class="rank-empty"><span>暂时没有榜单，稍后再来听听。</span><button class="text-action" type="button" @click="loadRankList">重新加载 <span aria-hidden="true">↗</span></button></div>
        <div v-else id="rank-grid" class="rank-grid">
          <button v-for="(rank, index) in visibleRanks" :key="rank.rankid" class="rank-item" type="button" @click="handleRankClick(rank)">
            <span class="rank-cover"><span aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span><img v-if="rank.imgurl && !failedImages[fixImgUrl(rank.imgurl)]" :src="fixImgUrl(rank.imgurl)" alt="" loading="lazy" @error="markImageFailed(rank.imgurl)" /></span>
            <span class="rank-info"><span class="rank-name">{{ rank.rankname }}</span><span class="rank-description">{{ rank.intro || '发现榜单里的热门旋律' }}</span></span>
            <svg class="rank-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          </button>
        </div>
      </section>
      <footer class="home-footer"><span></span>音乐，让日常多一点喜欢<span></span></footer>
    </div>
  </div>
</template>
<script>
import SongBadges from '../components/common/SongBadges.vue'
import ArtistLinks from '../components/common/ArtistLinks.vue'
import { logger } from '../utils/logger.js'

import { 
  getPersonalFM, 
  getEverydayRecommend, 
  getRankList,
  getAIRecommend 
} from '../api/music.js'

function getAccountIdentity() {
  return JSON.stringify([
    localStorage.getItem('kugou_userid'),
    localStorage.getItem('kugou_token')
  ])
}

export default {
  name: 'HomeView',
  emits: ['navigate', 'play', 'search'],
  components: { SongBadges, ArtistLinks },
  props: {
    favoritesRevision: { type: Number, default: 0 }
  },
  data() {
    return {
      isDisposed: false,
      requestIdentity: getAccountIdentity(),
      // 私人 FM
      fmLoading: false,
      fmLoaded: false,
      fmCount: 0,
      
      // 每日推荐
      dailyLoading: false,
      dailyCount: 0,
      dailyCover: '',
      dailyLoadedDate: '',
      dailyRequestedDate: '',
      dailyRefreshPending: false,
      
      // 排行榜
      rankLoading: false,
      rankLoaded: false,
      rankList: [],
      showRankList: false,
      
      // AI 推荐
      aiLoading: false,
      aiRefreshPending: false,
      aiRequestedSeed: null,
      aiCommittedSeed: null,
      aiRecommendList: [],
      showAllRecommendations: false,
      failedImages: Object.create(null),
      recentSongs: [] // 最近收藏的歌曲
    }
  },
  computed: {
    visibleRecommendations() {
      return this.showAllRecommendations ? this.aiRecommendList : this.aiRecommendList.slice(0, 6)
    },
    visibleRanks() {
      return this.showRankList ? this.rankList : this.rankList.slice(0, 4)
    }
  },
  mounted() {
    this.loadData()
  },
  activated() {
    if (!this.fmLoaded) this.loadPersonalFM()
    if (!this.rankLoaded) this.loadRankList()
    if (this.dailyLoadedDate !== new Date().toDateString()) {
      this.loadDailyRecommend()
    }
  },
  beforeUnmount() {
    this.isDisposed = true
  },
  watch: {
    favoritesRevision() {
      const seed = this.getRecentFavoriteSongs()
      const currentSeed = this.aiLoading ? this.aiRequestedSeed : this.aiCommittedSeed
      if (seed !== currentSeed) this.loadAIRecommend()
    }
  },
  methods: {
    // 缓存页可接收在途响应；账号变化或真正卸载后不再写回旧数据。
    isCurrentHomeRequest() {
      return !this.isDisposed && this.requestIdentity === getAccountIdentity()
    },
    // 修正图片URL中的{size}
    fixImgUrl(url, size = 150) {
      if (typeof url !== 'string') return ''
      return url.replace('{size}', String(size))
    },
    // 按实际尺寸隔离失败封面，资源刷新后重试，不影响其他尺寸的图片。
    markImageFailed(url, size = 150) {
      this.failedImages[this.fixImgUrl(url, size)] = true
    },
    async loadData() {
      await Promise.all([
        this.loadPersonalFM(),
        this.loadDailyRecommend(),
        this.loadRankList(),
        this.loadAIRecommend()
      ])
    },
    
    // 加载私人 FM
    async loadPersonalFM() {
      if (this.fmLoading || !this.isCurrentHomeRequest()) return
      try {
        this.fmLoading = true
        const response = await getPersonalFM()
        if (!this.isCurrentHomeRequest()) return
        logger.trace('HomeView', 'Personal FM:', response)
        logger.trace('HomeView', 'Personal FM data:', response.data)
        
        if (response.status === 1 && response.data) {
          // 私人FM返回的数据结构：data.hotsong_num 是数量
          this.fmCount = response.data.hotsong_num || 0
          this.fmLoaded = true
        }
      } catch (error) {
        if (!this.isCurrentHomeRequest()) return
        logger.error('HomeView', '加载私人 FM 失败:', error)
      } finally {
        if (this.isCurrentHomeRequest()) this.fmLoading = false
      }
    },
    
    // 加载每日推荐
    async loadDailyRecommend() {
      if (!this.isCurrentHomeRequest()) return
      const today = new Date().toDateString()
      if (this.dailyLoading) {
        if (this.dailyRequestedDate !== today) this.dailyRefreshPending = true
        return
      }
      try {
        this.dailyLoading = true
        this.dailyRequestedDate = today
        const response = await getEverydayRecommend()
        if (!this.isCurrentHomeRequest()) return
        logger.trace('HomeView', 'Daily Recommend:', response)
        logger.trace('HomeView', 'Daily Recommend data:', response.data)
        
        if (response.status === 1 && response.data) {
          // 每日推荐 song_list 是数组，song_list_size 是数量
          this.dailyCount = Array.isArray(response.data.song_list) ? response.data.song_list.length : (response.data.song_list_size || 0)
          const coverSong = response.data.song_list?.[0]
          this.dailyCover = coverSong?.sizable_cover || coverSong?.imgurl || coverSong?.trans_param?.union_cover || coverSong?.album_img || coverSong?.relate_goods?.[0]?.info?.image || ''
          delete this.failedImages[this.fixImgUrl(this.dailyCover, 400)]
          this.dailyLoadedDate = today
        }
      } catch (error) {
        if (!this.isCurrentHomeRequest()) return
        logger.error('HomeView', '加载每日推荐失败:', error)
      } finally {
        if (this.isCurrentHomeRequest()) {
          this.dailyLoading = false
          this.dailyRequestedDate = ''
          if (this.dailyRefreshPending) {
            this.dailyRefreshPending = false
            if (this.dailyLoadedDate !== new Date().toDateString()) this.loadDailyRecommend()
          }
        }
      }
    },
    
    // 加载排行榜列表
    async loadRankList() {
      if (this.rankLoading || !this.isCurrentHomeRequest()) return
      try {
        this.rankLoading = true
        const response = await getRankList()
        if (!this.isCurrentHomeRequest()) return
        logger.trace('HomeView', 'Rank List:', response)
        logger.trace('HomeView', 'Rank List data:', response.data)
        
        if (response.status === 1 && response.data) {
          // 排行榜 info 是榜单数组
          const rankData = response.data.info || [];
          this.rankList = rankData.map(rank => ({
            ...rank,
            imgurl: rank.imgurl || rank.banner7url || rank.banner6url || ''
          }));
          for (const rank of this.rankList) delete this.failedImages[this.fixImgUrl(rank.imgurl)]
          this.rankLoaded = true
        }
      } catch (error) {
        if (!this.isCurrentHomeRequest()) return
        logger.error('HomeView', '加载排行榜失败:', error)
      } finally {
        if (this.isCurrentHomeRequest()) this.rankLoading = false
      }
    },
    
    // 收藏通知按实际种子去重，显式调用仍允许手动刷新相同种子。
    async loadAIRecommend() {
      if (!this.isCurrentHomeRequest()) return
      if (this.aiLoading) {
        this.aiRefreshPending = true
        return
      }
      const recentSongIds = this.getRecentFavoriteSongs()
      this.aiRequestedSeed = recentSongIds
      try {
        // 使用当前账号最近的收藏作为推荐种子。
        if (!recentSongIds || recentSongIds.length === 0) {
          this.aiRecommendList = []
          this.aiCommittedSeed = recentSongIds
          logger.trace('HomeView', '没有收藏歌曲，跳过 AI 推荐')
          return
        }
        
        this.aiLoading = true
        const response = await getAIRecommend(recentSongIds)
        if (!this.isCurrentHomeRequest() || recentSongIds !== this.getRecentFavoriteSongs()) return
        logger.trace('HomeView', 'AI Recommend:', response)
        logger.trace('HomeView', 'AI Recommend data:', response.data)
        
        if (response.status === 1 && response.data) {
          // AI推荐 song_list 是推荐歌曲数组
          const songs = response.data.song_list || [];
          // 处理封面字段，优先使用 trans_param.union_cover，其次尝试 relate_goods[0].info.image
          this.aiRecommendList = songs.map(song => ({
            ...song,
            imgurl: song.imgurl || song.trans_param?.union_cover || 
                   (song.relate_goods && song.relate_goods.length > 0 && song.relate_goods[0].info ? 
                   song.relate_goods[0].info.image : '')
          }));
          for (const song of this.aiRecommendList) delete this.failedImages[this.fixImgUrl(song.imgurl, 400)]
          this.aiCommittedSeed = recentSongIds
        }
      } catch (error) {
        if (!this.isCurrentHomeRequest() || recentSongIds !== this.getRecentFavoriteSongs()) return
        logger.error('HomeView', '加载 AI 推荐失败:', error)
      } finally {
        if (this.isCurrentHomeRequest()) {
          this.aiLoading = false
          this.aiRequestedSeed = null
          if (this.aiRefreshPending) {
            this.aiRefreshPending = false
            if (this.getRecentFavoriteSongs() !== this.aiCommittedSeed) this.loadAIRecommend()
          }
        }
      }
    },
    
    // 获取最近收藏的歌曲 ID
    getRecentFavoriteSongs() {
      // 旧版收藏缓存必须明确归属当前账号，缺少归属时不参与推荐。
      const userId = localStorage.getItem('kugou_userid')
      if (!userId || localStorage.getItem('favorite_songs_userid') !== userId) return null
      const favorites = localStorage.getItem('favorite_songs')
      if (favorites) {
        try {
          const songs = JSON.parse(favorites)
          return Array.isArray(songs) ? songs.slice(0, 10).map(s => s?.hash).filter(Boolean).join(',') || null : null
        } catch (e) {
          return null
        }
      }
      return null
    },
    
    // 点击私人 FM
    handlePersonalFM() {
      logger.trace('HomeView', 'Navigate to Personal FM')
      this.$emit('navigate', 'personal-fm')
    },
    
    // 点击每日推荐
    handleDailyRecommend() {
      logger.trace('HomeView', 'Navigate to Daily Recommend')
      this.$emit('navigate', 'daily-recommend')
    },
    
    // 切换排行榜列表
    toggleRankList() {
      this.showRankList = !this.showRankList
    },
    
    // 点击排行榜
    handleRankClick(rank) {
      logger.trace('HomeView', 'Navigate to Rank:', rank)
      this.$emit('navigate', 'rank', rank)
      this.showRankList = false
    },
    
    // 点击歌曲
    handleSongClick(song) {
      logger.trace('HomeView', '[HomeView] Play song:', song)
      // 规范化歌曲数据字段
      const normalizedSong = {
        ...song,
        name: song.songname || song.filename || song.name,
        singername: song.author_name || song.singername,
        author_name: song.author_name || song.singername,
        cover: song.trans_param?.union_cover || song.imgurl || song.album_img,
        album_name: song.album_name || song.remark,
        timelen: song.duration || song.time_length || song.timelen
      }
      this.$emit('play', normalizedSong)
    }
  }
}
</script>

<style scoped src="./styles/HomeView.css"></style>
