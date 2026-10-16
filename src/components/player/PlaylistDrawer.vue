<template>
  <div class="playlist-drawer" :class="{ 'show': visible }" @click.self="closeDrawer">
    <!-- 抽屉内容 -->
    <div ref="drawerContent" class="drawer-content" :inert="!visible" :aria-hidden="!visible" @click.stop @keydown.esc.stop="closeDrawer">
      <!-- 头部 -->
      <div class="drawer-header">
        <h3>播放列表</h3>
        <span class="song-count">共 {{ validPlaylist.length }} 首</span>
        <button ref="closeButton" class="close-btn" aria-label="收起播放列表" title="收起播放列表" @click="closeDrawer">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
      </div>

      <!-- 播放列表 -->
      <div v-if="visible" class="playlist-content">
        <TransitionGroup 
          name="playlist-item" 
          tag="div" 
          class="playlist-list"
          appear
        >
          <div 
            v-for="(song, index) in validPlaylist" 
            :key="song.hash || song.name || `song-${index}`"
            class="playlist-item"
            :class="{ 'active': isCurrentSong(song) }"
            @dblclick="playSong(song)"
            @contextmenu.prevent.stop="showContextMenu($event, song, index)"
          >
          <!-- 播放状态指示器 -->
          <button type="button" class="play-indicator" :aria-label="'播放 ' + getSongName(song)" @click.stop="playSong(song)" @dblclick.stop>
            <svg v-if="isCurrentSong(song) && isPlaying" 
                 viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor">
              <path d="M304 176h80v672h-80zm336 0h80v672h-80z"/>
            </svg>
            <span v-else class="song-index">{{ index + 1 }}</span>
          </button>

          <!-- 歌曲信息 -->
          <div class="song-info">
            <div class="song-title-line">
              <button type="button" class="song-name" :title="getSongName(song)" @click.stop="$emit('search', song)" @dblclick.stop>{{ getSongName(song) }}</button>
              <SongBadges :song="song" />
            </div>
            <div class="song-artist">{{ getSingerNames(song) }}</div>
          </div>

          <!-- 歌曲时长 -->
          <div class="song-duration">
            {{ formatDuration(song) }}
          </div>

          <!-- 操作按钮 -->
          <div class="song-actions">
            <button class="action-btn" @click.stop="removeSong(index)" title="移除">
              <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                <path d="M563.8 512l262.5-312.9c4.4-5.2.7-13.1-6.1-13.1h-79.8c-4.7 0-9.2 2.1-12.3 5.7L511.6 449.8 295.1 191.7c-3-3.6-7.5-5.7-12.3-5.7H203c-6.8 0-10.5 7.9-6.1 13.1L459.4 512 196.9 824.9A7.95 7.95 0 00203 838h79.8c4.7 0 9.2-2.1 12.3-5.7l216.5-258.1 216.5 258.1c3 3.6 7.5 5.7 12.3 5.7h79.8c6.8 0 10.5-7.9 6.1-13.1L563.8 512z"/>
              </svg>
            </button>
          </div>
          </div>
        </TransitionGroup>

        <!-- 空状态 -->
        <div v-if="validPlaylist.length === 0" class="empty-state">
          <svg viewBox="0 0 1024 1024" width="64" height="64" fill="currentColor" opacity="0.3">
            <path d="M880 112H144c-17.7 0-32 14.3-32 32v736c0 17.7 14.3 32 32 32h736c17.7 0 32-14.3 32-32V144c0-17.7-14.3-32-32-32zm-40 728H184V184h656v656z"/>
            <path d="M304 368c0 4.4 3.6 8 8 8h384c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8H312c-4.4 0-8 3.6-8 8v48zm0 192c0 4.4 3.6 8 8 8h384c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8H312c-4.4 0-8 3.6-8 8v48zm0 192c0 4.4 3.6 8 8 8h384c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8H312c-4.4 0-8 3.6-8 8v48z"/>
          </svg>
          <p>播放列表为空</p>
          <p class="hint">双击歌曲添加到播放列表</p>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="drawer-footer">
        <button 
          class="footer-btn" 
          :class="{ 'confirm-delete': showClearConfirm }"
          @click="handleClearClick" 
          @mouseleave="cancelClear"
          :disabled="validPlaylist.length === 0"
        >
          <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
            <path d="M360 184h-8c4.4 0 8-3.6 8-8v8h304v-8c0-4.4-3.6-8-8-8h-8v72h72v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80h72v-72zm504 72H160c-17.7 0-32 14.3-32 32v32c0 4.4 3.6 8 8 8h60.4l24.7 523c1.6 34.1 29.8 61 63.9 61h454c34.2 0 62.3-26.8 63.9-61l24.7-523H888c4.4 0 8-3.6 8-8v-32c0-17.7-14.3-32-32-32zM731.3 840H292.7l-24.2-512h487l-24.2 512z"/>
          </svg>
          {{ showClearConfirm ? '确认清除' : '清空列表' }}
        </button>
      </div>
    </div>

    <button v-if="!visible" ref="restoreButton" type="button" class="drawer-restore-button" aria-label="展开播放列表" title="展开播放列表" aria-expanded="false" @click="$emit('open')">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 5-7 7 7 7" /></svg>
    </button>

    <!-- 右键菜单 -->
    <ContextMenu
      :visible="contextMenuVisible"
      :position="contextMenuPosition"
      :items="contextMenuItems"
      @close="contextMenuVisible = false"
    />
  </div>
</template>

<script>
import { logger } from '../../utils/logger.js'

import { TransitionGroup } from 'vue'
import ContextMenu from '../common/ContextMenu.vue'
import SongBadges from '../common/SongBadges.vue'
import contextMenuManager from '../../utils/contextMenuManager.js'

export default {
  name: 'PlaylistDrawer',
  emits: ['open', 'close', 'play', 'remove', 'clear', 'search'],
  components: {
    ContextMenu,
    SongBadges,
    TransitionGroup
  },
  props: {
    visible: {
      type: Boolean,
      default: false
    },
    playlist: {
      type: Array,
      default: () => []
    },
    currentSong: {
      type: Object,
      default: null
    },
    isPlaying: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      contextMenuVisible: false,
      contextMenuPosition: { x: 0, y: 0 },
      currentContextSong: null,
      currentContextIndex: -1,
      isDisposed: false,
      showClearConfirm: false // 是否显示清空确认状态
    }
  },
  computed: {
    // 过滤有效的播放列表项目
    validPlaylist() {
      if (!Array.isArray(this.playlist)) {
        return []
      }
      
      return this.playlist.filter(song => {
        // 确保歌曲对象不为 null/undefined 且有基本字段
        const isValid = song && 
                       typeof song === 'object' && 
                       (song.hash || song.name || song.filename)
        
        if (!isValid && song) {
          logger.trace('PlaylistDrawer', '🎵 [PlaylistDrawer] 过滤无效歌曲对象:', song)
        }
        return isValid
      })
    },
    
    contextMenuItems() {
      if (!this.currentContextSong) return []
      
      return [
        {
          label: '播放',
          icon: 'M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z',
          action: () => this.playSong(this.currentContextSong)
        },
        { divider: true },
        {
          label: '从播放列表移除',
          icon: '63.8 512l262.5-312.9c4.4-5.2.7-13.1-6.1-13.1h-79.8c-4.7 0-9.2 2.1-12.3 5.7L511.6 449.8 295.1 191.7c-3-3.6-7.5-5.7-12.3-5.7H203c-6.8 0-10.5 7.9-6.1 13.1L459.4 512 196.9 824.9A7.95 7.95 0 00203 838h79.8c4.7 0 9.2-2.1 12.3-5.7l216.5-258.1 216.5 258.1c3 3.6 7.5 5.7 12.3 5.7h79.8c6.8 0 10.5-7.9 6.1-13.1L563.8 512z',
          action: () => this.removePlaylistSong(this.currentContextSong)
        }
      ]
    }
  },
  watch: {
    playlist: {
      handler(newPlaylist) {
        if (newPlaylist && !Array.isArray(newPlaylist)) {
          logger.error('PlaylistDrawer', '🎵 [PlaylistDrawer] 播放列表不是数组:', newPlaylist)
        }
      },
      immediate: true
    },
    // 监听抽屉显示状态，打开时滚动到当前播放的歌曲
    visible: {
      handler(isVisible) {
        if (isVisible) {
          this.$nextTick(() => {
            if (this.isDisposed || !this.visible) return
            if (this.currentSong) this.scrollToCurrentSong()
            this.$refs?.closeButton?.focus({ preventScroll: true })
          })
        }
      },
      immediate: false
    },
    // 监听当前歌曲变化，如果播放列表开启则自动滚动定位
    currentSong: {
      handler(newSong) {
        if (newSong && typeof newSong !== 'object') {
          logger.error('PlaylistDrawer', '🎵 [PlaylistDrawer] 当前歌曲不是对象:', newSong)
          return
        }
        if (this.visible && newSong) {
          this.$nextTick(() => {
            this.scrollToCurrentSong()
          })
        }
      },
      immediate: false
    }
  },
  beforeUnmount() {
    this.isDisposed = true
    contextMenuManager.unregisterMenu(this.closeContextMenu)
  },
  methods: {
    closeDrawer() {
      this.closeContextMenu()
      this.showClearConfirm = false
      this.$emit('close')
      this.$nextTick(() => {
        if (!this.isDisposed && !this.visible) this.$refs.restoreButton?.focus({ preventScroll: true })
      })
    },
    
    playSong(song) {
      logger.trace('PlaylistDrawer', '🎵 [PlaylistDrawer] 用户双击播放歌曲:', {
        songName: song.name || song.filename,
        songHash: song.hash,
        currentSongName: this.currentSong?.name || this.currentSong?.filename,
        currentSongHash: this.currentSong?.hash
      })
      this.$emit('play', song)
    },
    
    removeSong(index) {
      const song = this.validPlaylist[index]
      this.removePlaylistSong(song)
    },

    /** 按实际歌曲对象定位原队列，避免无效项和同名歌曲造成误删。 */
    removePlaylistSong(song) {
      if (!song || !Array.isArray(this.playlist)) return
      const realIndex = this.playlist.indexOf(song)
      if (realIndex !== -1) this.$emit('remove', realIndex)
    },
    
    // 处理清空按钮点击
    handleClearClick() {
      if (this.validPlaylist.length === 0) return
      
      if (!this.showClearConfirm) {
        // 第一次点击：显示确认状态
        this.showClearConfirm = true
        logger.trace('PlaylistDrawer', '显示清空确认状态')
      } else {
        // 第二次点击：执行清空
        logger.trace('PlaylistDrawer', '确认清空播放列表')
        this.$emit('clear')
        this.showClearConfirm = false
      }
    },
    
    // 取消清空（鼠标移开）
    cancelClear() {
      if (this.showClearConfirm) {
        logger.trace('PlaylistDrawer', '取消清空操作')
        this.showClearConfirm = false
      }
    },
    
    // 显示右键菜单
    showContextMenu(event, song, index) {
      // 先关闭所有其他菜单
      contextMenuManager.closeActiveMenu()
      
      // 然后关闭自己的旧菜单，防止瞬移
      this.contextMenuVisible = false
      
      // 使用 nextTick 确保旧菜单完全关闭后再打开新菜单
      this.$nextTick(() => {
        if (this.isDisposed) return
        this.currentContextSong = song
        this.currentContextIndex = index
        this.contextMenuPosition = {
          x: event.clientX,
          y: event.clientY
        }
        this.contextMenuVisible = true
        
        // 注册到全局管理器
        contextMenuManager.registerMenu(this.closeContextMenu)
      })
    },

    closeContextMenu() {
      this.contextMenuVisible = false
    },
    
    // 滚动到当前播放的歌曲
    scrollToCurrentSong() {
      if (this.isDisposed || !this.$el || !this.currentSong || !this.validPlaylist.length) return
      
      const currentIndex = this.validPlaylist.findIndex(song => 
        this.isCurrentSong(song)
      )
      
      if (currentIndex === -1) return
      
      // 获取播放列表容器和当前歌曲元素
      const container = this.$el.querySelector('.playlist-content')
      const items = this.$el.querySelectorAll('.playlist-item')
      const currentItem = items[currentIndex]
      
      if (container && currentItem) {
        // 计算滚动位置（将当前歌曲滚动到中间位置）
        const containerHeight = container.clientHeight
        const itemTop = currentItem.offsetTop
        const itemHeight = currentItem.clientHeight
        const scrollTop = itemTop - (containerHeight / 2) + (itemHeight / 2)
        
        container.scrollTo({
          top: Math.max(0, scrollTop),
          behavior: 'smooth'
        })
        
        logger.trace('PlaylistDrawer', '🎵 滚动到当前播放歌曲:', currentIndex)
      }
    },
    
    // 判断是否为当前播放的歌曲
    isCurrentSong(song) {
      try {
        if (!this.currentSong || !song || typeof song !== 'object') {
          return false
        }
        
        // 如果两个对象都有 hash，优先用 hash 比较
        if (this.currentSong.hash && song.hash) {
          const result = this.currentSong.hash === song.hash
          if (result) {
            logger.trace('PlaylistDrawer', '🎵 [PlaylistDrawer] Hash匹配成功:', {
              currentHash: this.currentSong.hash,
              songHash: song.hash,
              currentName: this.currentSong.name || this.currentSong.filename,
              songName: song.name || song.filename
            })
          }
          return result
        }
        
        // 如果 song 没有 hash（不完整的歌曲对象），跳过高亮
        if (!song.hash) {
          return false
        }
        
        // 备用比较方式：通过名称比较（不推荐，但作为fallback）
        if (this.currentSong.name && song.name) {
          return this.currentSong.name === song.name
        }
        
        return false
      } catch (error) {
        logger.error('PlaylistDrawer', '🎵 [PlaylistDrawer] isCurrentSong 错误:', error, { currentSong: this.currentSong, song })
        return false
      }
    },
    
    // 提取歌曲名称
    getSongName(song) {
      if (!song || typeof song !== 'object') {
        return '未知歌曲'
      }
      
      // 优先使用 name 字段
      if (song.name && typeof song.name === 'string') {
        return song.name
      }
      
      // 备用字段
      if (song.filename && typeof song.filename === 'string') {
        return song.filename
      }
      
      // 如果都没有，显示调试信息但不频繁打印
      if (Math.random() < 0.1) { // 只有10%的概率打印，减少日志噪音
        logger.warn('PlaylistDrawer', '🎵 [PlaylistDrawer] 歌曲名称字段为空，歌曲对象:', song)
      }
      
      return '未知歌曲'
    },
    
    // 获取歌手名称
    getSingerNames(song) {
      if (!song) return '未知歌手'
      
      // 尝试从 singerinfo 数组获取
      if (song.singerinfo && Array.isArray(song.singerinfo) && song.singerinfo.length > 0) {
        const names = song.singerinfo.map(s => {
          if (typeof s === 'object' && s !== null) {
            return s.name || s.singer_name || s.singername || s.author_name
          }
          return String(s)
        }).filter(name => name && name.trim() && name !== '[object Object]')
        
        if (names.length > 0) {
          return names.join('、')
        }
      }
      
      // 备用字段
      if (song.singername) {
        return song.singername
      }
      
      if (song.author) {
        return song.author
      }
      
      // 从 name 字段提取(格式: "歌手 - 歌名")
      if (song.name && song.name.includes(' - ')) {
        return song.name.split(' - ')[0]
      }
      
      return '未知歌手'
    },
    
    // 格式化时长
    formatDuration(duration) {
      if (!duration || duration <= 0) {
        logger.warn('PlaylistDrawer', '🎵 [PlaylistDrawer] 时长字段为空或无效，歌曲对象:', this.song)
        return '0:00'
      }
      const minutes = Math.floor(duration / 60)
      const seconds = duration % 60
      return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`
    }
  }
}
</script>

<style scoped>
.playlist-drawer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 90px; /* 不覆盖播放器区域（播放器高度约80px + 间距） */
  z-index: 1000;
  pointer-events: none;
  background: transparent;
}

.playlist-drawer.show {
  pointer-events: auto;
  background: var(--playlist-overlay); /* 半透明遮罩背景 */
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* 抽屉内容 */
.drawer-content {
  position: absolute;
  top: 92px; /* TitleBar(32px) + Navigation(60px) */
  right: 0;
  bottom: 10px; /* 距离底部间距 */
  width: min(400px, calc(100vw - 24px));
  background: var(--color-background);
  border-radius: var(--radius-lg) 0 0 var(--radius-lg); /* 左侧圆角 */
  box-shadow: var(--shadow-playlist);
  border: 1px solid var(--color-border);
  border-right: none;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.3s ease;
}

.playlist-drawer.show .drawer-content {
  transform: translateX(0);
}

.drawer-restore-button {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 50px;
  border: 1px solid var(--color-border);
  border-right: 0;
  border-radius: 12px 0 0 12px;
  background: var(--color-background-light);
  color: var(--color-text-secondary);
  box-shadow: var(--shadow-sidebar);
  pointer-events: auto;
  cursor: pointer;
}
.drawer-restore-button:hover { color: var(--color-primary); }
.drawer-restore-button:focus-visible, .close-btn:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -3px; }

@media (prefers-reduced-motion: reduce) {
  .drawer-content { transition: none; }
  .playlist-drawer.show { animation: none; }
}

/* 头部 */
.drawer-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.drawer-header h3 {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 500;
  color: var(--color-text);
}

.song-count {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.close-btn {
  margin-left: auto;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
}

.close-btn:hover {
  background: var(--color-background);
  color: var(--color-text);
}

/* 播放列表内容 */
.playlist-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-sm);
}

.playlist-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.playlist-item:hover {
  background: var(--color-background);
}

.playlist-item.active {
  background: var(--color-primary-light);
}

.playlist-item.active .song-name {
  color: var(--color-primary);
}

.play-indicator {
  width: 20px;
  min-height: 28px;
  color: inherit;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.song-index {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.playlist-item.active .play-indicator svg {
  color: var(--color-primary);
}

.song-info {
  flex: 1;
  min-width: 0;
}

.song-name {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
  text-align: left;
  border-radius: 3px;
}

.song-name:hover, .play-indicator:hover { color: var(--color-primary); }
.song-name:focus-visible, .play-indicator:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }

.song-title-line { display: flex; align-items: center; gap: 7px; min-width: 0; margin-bottom: 4px; }
.song-title-line > .song-name { min-width: 0; margin-bottom: 0; }

.song-artist {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-duration {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.song-actions {
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.playlist-item:hover .song-actions {
  opacity: 1;
}

.action-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
}

.action-btn:hover {
  background: var(--color-background-light);
  color: var(--color-error);
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary);
  gap: var(--spacing-md);
}

.empty-state p {
  margin: 0;
}

.hint {
  font-size: var(--font-size-xs);
  opacity: 0.6;
}

/* 底部操作 */
.drawer-footer {
  padding: var(--spacing-lg);
  border-top: 1px solid var(--color-border);
}

.footer-btn {
  width: 100%;
  height: 36px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-sm);
  transition: all var(--transition-fast);
}

.footer-btn:hover:not(:disabled) {
  background: var(--color-background);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.footer-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 确认删除状态 */
.footer-btn.confirm-delete {
  background: var(--gradient-danger);
  border-color: var(--color-danger);
  color: var(--color-on-primary);
  font-weight: 500;
  animation: deleteWarning 0.3s ease-out;
}

.footer-btn.confirm-delete:hover {
  background: var(--gradient-danger-hover);
  border-color: var(--color-danger-hover);
  color: var(--color-on-primary);
  transform: scale(1.02);
}

@keyframes deleteWarning {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
  100% {
    transform: scale(1);
  }
}

/* 滚动条样式 */
.playlist-content::-webkit-scrollbar {
  width: 6px;
}

.playlist-content::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 3px;
}

.playlist-content::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-secondary);
}

/* 播放列表项过渡动画 */
.playlist-item-enter-active,
.playlist-item-leave-active {
  transition: all 0.3s ease;
}

.playlist-item-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.playlist-item-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}

.playlist-item-move {
  transition: transform 0.3s ease;
}

.playlist-list {
  position: relative;
}
</style>
