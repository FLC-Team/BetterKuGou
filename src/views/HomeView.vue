<template>
  <div class="home-view">
    <h1 class="page-title">发现音乐</h1>
    
    <!-- 顶部三个卡片 -->
    <div class="top-cards">
      <!-- 猜你喜欢 -->
      <div class="music-card" @click="handlePersonalFM">
        <div class="card-icon">
          <svg viewBox="0 0 1024 1024" width="48" height="48" fill="currentColor">
            <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
            <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8zm-257.6 134V390.9L628.5 512 461.8 633.1z"/>
          </svg>
        </div>
        <div class="card-content">
          <h3 class="card-title">猜你喜欢</h3>
          <p class="card-description">私人 FM 为你推荐</p>
          <div v-if="fmLoading" class="card-loading">加载中...</div>
          <div v-else-if="fmCount" class="card-count">{{ fmCount }} 首歌曲</div>
        </div>
      </div>

      <!-- 每日推荐 -->
      <div class="music-card" @click="handleDailyRecommend">
        <div class="card-icon card-icon-daily">
          <svg viewBox="0 0 1024 1024" width="48" height="48" fill="currentColor">
            <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
          </svg>
        </div>
        <div class="card-content">
          <h3 class="card-title">每日推荐</h3>
          <p class="card-description">根据你的口味推荐</p>
          <div v-if="dailyLoading" class="card-loading">加载中...</div>
          <div v-else-if="dailyCount" class="card-count">{{ dailyCount }} 首歌曲</div>
        </div>
      </div>

      <!-- 排行榜 -->
      <div class="music-card music-card-rank" @click="toggleRankList">
        <div class="card-icon card-icon-rank">
          <svg viewBox="0 0 1024 1024" width="48" height="48" fill="currentColor">
            <path d="M864 256H736v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80H160c-17.7 0-32 14.3-32 32v32c0 4.4 3.6 8 8 8h60.4l24.7 523c1.6 34.1 29.8 61 63.9 61h454c34.2 0 62.3-26.8 63.9-61l24.7-523H888c4.4 0 8-3.6 8-8v-32c0-17.7-14.3-32-32-32zm-200 0H360v-72h304v72z"/>
          </svg>
        </div>
        <div class="card-content">
          <h3 class="card-title">排行榜</h3>
          <p class="card-description">热门音乐榜单</p>
          <div v-if="rankLoading" class="card-loading">加载中...</div>
          <div v-else-if="rankList.length" class="card-count">{{ rankList.length }} 个榜单</div>
        </div>
        
        <!-- 排行榜下拉列表 -->
        <Transition name="rank-dropdown">
          <div v-if="showRankList" class="rank-dropdown" @click.stop>
            <div 
              v-for="rank in rankList" 
              :key="rank.rankid"
              class="rank-item"
              @click="handleRankClick(rank)"
            >
              <img v-if="rank.imgurl" :src="fixImgUrl(rank.imgurl)" class="rank-icon" />
              <span class="rank-name">{{ rank.rankname }}</span>
            </div>
          </div>
        </Transition>
      </div>
    </div>

    <!-- AI 推荐区域 -->
    <div class="ai-recommend-section">
      <div class="section-header">
        <h2 class="section-title">
          <svg viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
            <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
            <path d="M464 336a48 48 0 1096 0 48 48 0 10-96 0zm72 112h-48c-4.4 0-8 3.6-8 8v272c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V456c0-4.4-3.6-8-8-8z"/>
          </svg>
          AI 为你推荐
        </h2>
        <button v-if="!aiLoading && aiRecommendList.length === 0" class="refresh-btn" @click="loadAIRecommend">
          <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
            <path d="M909.1 209.3l-56.4 44.1C775.8 155.1 656.2 92 521.9 92 290 92 102.3 279.5 102 511.5 101.7 743.7 289.8 932 521.9 932c181.3 0 335.8-115 394.6-276.1 1.5-4.2-.7-8.9-4.9-10.3l-56.7-19.5a8 8 0 00-10.1 4.8c-1.8 5-3.8 10-5.9 14.9-17.3 41-42.1 77.8-73.7 109.4A344.77 344.77 0 01655.9 788a8 8 0 00-4.8 10.1l19.5 56.7c1.5 4.3 6.2 6.5 10.3 4.9C831.6 797.8 946 643.3 946 462c0-232.3-188.3-420-420-420z"/>
          </svg>
          刷新推荐
        </button>
      </div>

      <div v-if="aiLoading" class="ai-loading">
        <span class="loading-spinner" role="status" aria-label="加载中"></span>
        <p>AI 正在为你生成推荐...</p>
      </div>

      <div v-else-if="aiRecommendList.length === 0" class="ai-empty">
        <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
          <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
        </svg>
        <p>收藏一些歌曲，让 AI 为你推荐更多好音乐</p>
      </div>

      <div v-else class="ai-recommend-grid">
        <div 
          v-for="song in aiRecommendList" 
          :key="song.hash"
          class="song-card"
          @click="handleSongClick(song)"
        >
          <div class="song-cover">
            <img v-if="song.imgurl" :src="fixImgUrl(song.imgurl)" :alt="song.songname" />
            <div class="play-overlay">
              <svg viewBox="0 0 1024 1024" width="32" height="32" fill="white">
                <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
                <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8zm-257.6 134V390.9L628.5 512 461.8 633.1z"/>
              </svg>
            </div>
          </div>
          <div class="song-info">
            <h4 class="song-name">{{ song.songname }}</h4>
            <p class="song-artist"><span class="artist-link" @click.stop="goArtistFromAISong(song)">{{ song.singername }}</span></p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
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
      recentSongs: [] // 最近收藏的歌曲
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
    fixImgUrl(url) {
      if (!url) return '';
      return url.replace('{size}', '150');
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
    ,
    goArtistFromAISong(song) {
      const id = song.SingerId || song.singerid || song.AuthorId || song.author_id || null
      const name = song.singername || song.author_name || null
      if (id || name) this.$emit('navigate', 'artist', { id, name })
    }
  }
}
</script>

<style scoped>
.home-view {
  padding: var(--spacing-xl);
  max-width: 1400px;
  margin: 0 auto;
}

.page-title {
  font-size: var(--font-size-2xl);
  font-weight: 600;
  margin-bottom: var(--spacing-xl);
  color: var(--color-text);
}

/* 顶部卡片区域 */
.top-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--spacing-lg);
  margin-bottom: var(--spacing-xl);
  height: 180px;
}

.music-card {
  background: var(--color-background-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  cursor: pointer;
  transition: all var(--transition-base);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.music-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(135deg, var(--color-primary) 0%, transparent 100%);
  opacity: 0;
  transition: opacity var(--transition-base);
}

.music-card:hover::before {
  opacity: 0.1;
}

.music-card:hover {
  border-color: var(--color-primary);
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}

.card-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--color-primary), var(--color-primary-hover));
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--spacing-md);
  color: white;
  position: relative;
  z-index: 1;
}

.card-icon svg {
  width: 36px;
  height: 36px;
}

.card-icon-daily {
  background: var(--gradient-secondary);
}

.card-icon-rank {
  background: var(--gradient-gold);
}

.card-content {
  text-align: center;
  position: relative;
  z-index: 1;
}

.card-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: var(--spacing-xs);
}

.card-description {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-sm);
}

.card-loading,
.card-count {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

/* 排行榜下拉列表 */
.music-card-rank {
  overflow: visible;
}

.rank-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: var(--spacing-sm);
  background: var(--color-background-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  max-height: 400px;
  overflow-y: auto;
  z-index: 10;
}

.rank-dropdown::-webkit-scrollbar {
  width: 6px;
}

.rank-dropdown::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 3px;
}

.rank-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.rank-item:hover {
  background: var(--color-background);
}

.rank-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  object-fit: cover;
}

.rank-name {
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

/* 排行榜下拉动画 */
.rank-dropdown-enter-active,
.rank-dropdown-leave-active {
  transition: all 0.2s ease;
}

.rank-dropdown-enter-from,
.rank-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* AI 推荐区域 */
.ai-recommend-section {
  margin-top: var(--spacing-xl);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-lg);
}

.section-title {
  font-size: var(--font-size-xl);
  font-weight: 600;
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.section-title svg {
  color: var(--color-primary);
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-background-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.refresh-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.ai-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) 0;
  color: var(--color-text-secondary);
}

.loading-gif {
  width: 60px;
  height: 60px;
  margin-bottom: var(--spacing-md);
}

.ai-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) 0;
  color: var(--color-text-secondary);
  text-align: center;
}

.ai-empty svg {
  margin-bottom: var(--spacing-md);
}

/* AI 推荐歌曲网格 */
.ai-recommend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--spacing-lg);
}

.song-card {
  cursor: pointer;
  transition: all var(--transition-base);
}

.song-card:hover {
  transform: translateY(-4px);
}

.song-cover {
  position: relative;
  width: 100%;
  padding-bottom: 100%;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-background-lighter);
  margin-bottom: var(--spacing-sm);
}

.song-cover img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.play-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.song-card:hover .play-overlay {
  opacity: 1;
}

.song-info {
  padding: 0 var(--spacing-xs);
}

.song-name {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  margin-bottom: var(--spacing-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-artist {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-link { cursor: pointer; }
.artist-link:hover { color: var(--color-primary); text-decoration: underline; }
</style>
