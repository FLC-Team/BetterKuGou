
import { logger } from '../../utils/logger.js'
import { getUserPlaylists, getPlaylistTracks } from '../../api/music.js'
import ContextMenu from '../../components/common/ContextMenu.vue'
import contextMenuManager from '../../utils/contextMenuManager.js'
import { useSettingsStore } from '../../stores/settingsStore.js'

// 引入图标
import nextplayIcon from '../../assets/icons/nextplay.svg'

export default {
  name: 'FavoriteView',
  emits: ['play', 'play-all', 'play-next', 'remove-from-playlist', 'search', 'navigate', 'favorites-changed'],
  components: {
    ContextMenu
  },
  props: {
    currentSong: {
      type: Object,
      default: null
    },
    playlistId: { type: [String, Number], default: null },
    playlistName: { type: String, default: '' },
    userPlaylists: { type: Array, default: null },
    playlistsLoaded: { type: Boolean, default: true }
  },
  setup() {
    const { settings } = useSettingsStore()
    return { settings }
  },
  data() {
    return {
      loading: false,
      loaded: false,
      isDisposed: false,
      isActive: true,
      requestGeneration: 0,
      requestScope: null,
      loadPromise: null,
      playSongTimer: null,
      menuGeneration: 0,
      errorMessage: '',
      favoriteList: [],
      favoritePlaylistId: null, // 收藏歌单的 ID
      contextMenuVisible: false,
      contextMenuPosition: { x: 0, y: 0 },
      currentContextSong: null,
      sortOrder: 'none', // 排序状态: 'none', 'asc', 'desc'
      isPlayingSong: false, // 防止重复播放请求
      nextplayIcon: nextplayIcon
    }
  },
  computed: {
    isPlaylistView() { return this.playlistId != null },
    pageTitle() { return this.isPlaylistView ? this.playlistName || '歌单' : '我喜欢的音乐' },
    currentPlayingHash() {
      return this.currentSong?.hash || null
    },
    // 计算排序后的歌曲列表
    sortedFavoriteList() {
      if (this.sortOrder === 'none') {
        return this.favoriteList
      }
      
      // 创建副本以避免修改原始数组
      const sortedList = [...this.favoriteList]
      
      if (this.sortOrder === 'asc') {
        // 升序排列
        return sortedList.sort((a, b) => a.index - b.index)
      } else {
        // 降序排列
        return sortedList.sort((a, b) => b.index - a.index)
      }
    },
    contextMenuItems() {
      if (!this.currentContextSong) return []
      
      const isFavorite = this.favoriteList.some(s => s.hash === this.currentContextSong.hash)
      
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
          label: isFavorite ? '取消收藏' : '收藏',
          favoriteAction: true,
          icon: 'M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z',
          action: () => this.toggleFavorite(this.currentContextSong)
        },
        {
          label: '下载',
          icon: 'M505.7 661a8 8 0 0012.6 0l112-141.7c4.1-5.2.4-12.9-6.3-12.9h-74.1V168c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v338.3H400c-6.7 0-10.4 7.7-6.3 12.9l112 141.8zM878 626h-60c-4.4 0-8 3.6-8 8v154H214V634c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v198c0 17.7 14.3 32 32 32h684c17.7 0 32-14.3 32-32V634c0-4.4-3.6-8-8-8z',
          action: () => this.downloadSong(this.currentContextSong)
        },
        {
          label: '分享',
          icon: 'M752 664c-28.5 0-54.8 10-75.4 26.7L469.4 540.8a160.68 160.68 0 000-57.6l207.2-149.9C697.2 350 723.5 360 752 360c66.2 0 120-53.8 120-120s-53.8-120-120-120-120 53.8-120 120c0 11.6 1.6 22.7 4.7 33.3L439.9 415.8C410.7 377.1 364.3 352 312 352c-88.4 0-160 71.6-160 160s71.6 160 160 160c52.3 0 98.7-25.1 127.9-63.8l196.8 142.5c-3.1 10.6-4.7 21.8-4.7 33.3 0 66.2 53.8 120 120 120s120-53.8 120-120-53.8-120-120-120zm0-476c28.7 0 52 23.3 52 52s-23.3 52-52 52-52-23.3-52-52 23.3-52 52-52zM312 600c-48.5 0-88-39.5-88-88s39.5-88 88-88 88 39.5 88 88-39.5 88-88 88zm440 236c-28.7 0-52-23.3-52-52s23.3-52 52-52 52 23.3 52 52-23.3 52-52 52z',
          action: () => this.shareSong(this.currentContextSong)
        },
        { divider: true },
        {
          label: '从播放列表中移除',
          icon: 'M360 184h-8c4.4 0 8-3.6 8-8v8h304v-8c0 4.4 3.6 8 8 8h-8v72h72v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80h72v-72zm504 72H160c-17.7 0-32 14.3-32 32v32c0 4.4 3.6 8 8 8h60.4l24.7 523c1.6 34.1 29.8 61 63.9 61h454c34.2 0 62.3-26.8 63.9-61l24.7-523H888c4.4 0 8-3.6 8-8v-32c0-17.7-14.3-32-32-32zM731.3 840H292.7l-24.2-512h487l-24.2 512z',
          action: () => this.removeFromPlaylist(this.currentContextSong)
        },
        {
          label: '搜索',
          icon: 'M909.6 854.5L649.9 594.8C690.2 542.7 712 479 712 412c0-80.2-31.3-155.4-87.9-212.1-56.6-56.7-132-87.9-212.1-87.9s-155.5 31.3-212.1 87.9C143.2 256.5 112 331.8 112 412c0 80.1 31.3 155.5 87.9 212.1C256.5 680.8 331.8 712 412 712c67 0 130.6-21.8 182.7-62l259.7 259.6a8.2 8.2 0 0011.6 0l43.6-43.5a8.2 8.2 0 000-11.6zM570.4 570.4C528 612.7 471.8 636 412 636s-116-23.3-158.4-65.6C211.3 528 188 471.8 188 412s23.3-116.1 65.6-158.4C296 211.3 352.2 188 412 188s116.1 23.2 158.4 65.6S636 352.2 636 412s-23.3 116.1-65.6 158.4z',
          action: () => this.searchSong(this.currentContextSong)
        }
      ].filter(item => !this.isPlaylistView || !item.favoriteAction)
    }
  },
  watch: {
    playlistId() { this.loadFavorites() },
    playlistsLoaded(ready) {
      if (ready && !this.loaded) this.loadFavorites()
    },
    userPlaylists() {
      if (!this.loaded) this.loadFavorites()
    }
  },
  mounted() {
    this.loadFavorites()
  },
  activated() {
    this.isActive = true
    this.loadFavorites()
  },
  deactivated() {
    this.isActive = false
    this.closeContextMenu()
  },
  beforeUnmount() {
    this.isDisposed = true
    this.requestGeneration += 1
    this.loadPromise = null
    clearTimeout(this.playSongTimer)
    this.playSongTimer = null
    this.closeContextMenu()
  },
  methods: {
    isCurrentlyPlaying(song) {
      return !!song?.hash && this.currentPlayingHash === song.hash
    },

    readIdentity() {
      return {
        userid: localStorage.getItem('kugou_userid'),
        token: localStorage.getItem('kugou_token')
      }
    },
    playlistKey() { return this.playlistId == null ? 'favorites' : `playlist:${this.playlistId}` },
    hasCurrentScope(scope) {
      const identity = this.readIdentity()
      return !!scope.userid && !!scope.token && scope.userid === identity.userid &&
        scope.token === identity.token && scope.playlistKey === this.playlistKey()
    },
    isCurrentRequest(generation, scope) {
      return !this.isDisposed && generation === this.requestGeneration && this.hasCurrentScope(scope)
    },

    /** 按账号和歌单复用进行中的请求；已加载页面只在手动刷新时重新取曲目。 */
    loadFavorites(force = false) {
      if (this.isDisposed) return Promise.resolve()
      const identity = this.readIdentity()
      const playlistKey = this.playlistKey()
      const previous = this.requestScope
      if (!previous || previous.userid !== identity.userid || previous.token !== identity.token || previous.playlistKey !== playlistKey) {
        this.requestGeneration += 1
        this.requestScope = { ...identity, playlistKey }
        this.loadPromise = null
        this.loading = false
        this.loaded = false
        this.favoriteList = []
        this.favoritePlaylistId = null
        this.errorMessage = ''
        this.closeContextMenu()
      }
      if (!identity.userid || !identity.token) return Promise.resolve()
      if (this.loadPromise) return this.loadPromise
      if (this.loaded && force !== true) return Promise.resolve()
      if (!this.isPlaylistView && this.userPlaylists !== null && !this.playlistsLoaded) {
        this.loading = true
        return Promise.resolve()
      }

      this.loading = true
      this.errorMessage = ''
      const generation = ++this.requestGeneration
      const scope = this.requestScope
      const promise = this.fetchFavorites(generation, scope, force === true).finally(() => {
        if (this.isCurrentRequest(generation, scope) && this.loadPromise === promise) {
          this.loading = false
          this.loadPromise = null
        }
      })
      this.loadPromise = promise
      return promise
    },

    /** 曲目先汇总到临时数组，全部分页成功且身份仍有效时才替换可见列表。 */
    async fetchFavorites(generation, scope, force) {
      try {
        let playlistId = this.isPlaylistView ? this.playlistId : this.favoritePlaylistId
        if (playlistId == null) {
          let playlists = this.userPlaylists
          if (playlists === null || (force && Array.isArray(playlists) && playlists.length === 0)) {
            const response = await getUserPlaylists(1, 100)
            if (!this.isCurrentRequest(generation, scope)) return
            if (response?.status !== 1 || !response.data) throw new Error(response?.error || '获取用户歌单失败')
            playlists = response.data.info || response.data.lists || response.data.list || []
          }
          if (!Array.isArray(playlists)) throw new Error('用户歌单目录格式无效')
          const favorite = playlists.find(item => {
            const name = String(item?.name || item?.list_name || '')
            return name === '我喜欢的音乐' || name.includes('喜欢') || String(item?.list_id) === '3'
          }) || playlists[0]
          if (favorite) {
            playlistId = favorite.global_collection_id ?? favorite.globalCollectionId ?? favorite.id ?? favorite.listid ?? favorite.list_id
            if (playlistId == null || playlistId === '') throw new Error('收藏歌单缺少可用的 ID')
          } else {
            throw new Error('未找到可用的收藏歌单，请刷新重试')
          }
        }
        if (!this.isCurrentRequest(generation, scope)) return
        this.favoritePlaylistId = playlistId
        const pageSize = 300
        const firstResponse = await getPlaylistTracks(playlistId, 1, pageSize)
        if (!this.isCurrentRequest(generation, scope)) return
        let songs = this.readPlaylistPage(firstResponse, 1)
        const rawTotal = Number(firstResponse.data.count ?? firstResponse.data.total ?? songs.length)
        const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : songs.length
        const pages = Math.ceil(total / pageSize)
        for (let page = 2; page <= pages; page += 1) {
          const response = await getPlaylistTracks(playlistId, page, pageSize)
          if (!this.isCurrentRequest(generation, scope)) return
          songs = songs.concat(this.readPlaylistPage(response, page))
        }
        if (!this.isCurrentRequest(generation, scope)) return
        const previousSeeds = this.isPlaylistView ? null : this.readFavoriteSeedSignature(scope)
        this.favoriteList = songs.map((song, index) => ({ ...song, index: index + 1 }))
        this.loaded = true
        if (!this.isPlaylistView) {
          const saved = this.persistFavorites(scope)
          if (saved && previousSeeds !== this.favoriteSeedSignature(this.favoriteList)) {
            this.$emit('favorites-changed', this.favoriteList)
          }
        }
      } catch (error) {
        if (!this.isCurrentRequest(generation, scope)) return
        logger.error('FavoriteView', '加载歌单曲目失败', { playlistId: this.favoritePlaylistId, error })
        this.errorMessage = error?.message || '加载歌单曲目失败'
        if (error?.code === 'KUGOU_AUTH_EXPIRED') {
          this.favoriteList = []
          this.loaded = false
          return
        }
        if (!this.isPlaylistView && !this.loaded && this.favoriteList.length === 0) this.restoreFavoritesCache(scope)
      }
    },

    readPlaylistPage(response, page) {
      if (response?.status !== 1 || !response.data) throw new Error(response?.error || `加载歌单第 ${page} 页失败`)
      const songs = response.data.songs || response.data.info || response.data.list
      if (!Array.isArray(songs)) throw new Error(`歌单第 ${page} 页歌曲格式无效`)
      return songs
    },

    favoriteSeedSignature(songs) {
      return JSON.stringify(songs.map(song => song?.hash || song?.album_audio_id).filter(Boolean).map(String))
    },

    /** 云端刷新只在当前账号已有的歌曲种子发生变化时通知关联页面。 */
    readFavoriteSeedSignature(scope) {
      try {
        if (localStorage.getItem('favorite_songs_userid') === scope.userid) {
          const songs = JSON.parse(localStorage.getItem('favorite_songs') || 'null')
          if (Array.isArray(songs)) return this.favoriteSeedSignature(songs)
        }
      } catch (error) {
        logger.warn('FavoriteView', '读取本地收藏种子失败', { name: error?.name })
      }
      return this.favoriteSeedSignature([])
    },

    /** 兼容旧收藏键，但仅允许当前账号读取已标明归属的完整缓存。 */
    restoreFavoritesCache(scope) {
      if (!this.hasCurrentScope(scope) || this.isDisposed) return
      try {
        if (localStorage.getItem('favorite_songs_userid') !== scope.userid) return
        const songs = JSON.parse(localStorage.getItem('favorite_songs') || 'null')
        if (Array.isArray(songs) && this.hasCurrentScope(scope) && !this.isDisposed) {
          this.favoriteList = songs.map((song, index) => ({ ...song, index: index + 1 }))
        }
      } catch (error) {
        logger.warn('FavoriteView', '读取本地收藏缓存失败', { name: error?.name })
      }
    },

    /** 先撤销旧 owner，再写歌曲和新 owner；写入失败时缓存不会冒充其他账号。 */
    persistFavorites(scope = this.requestScope) {
      if (this.isPlaylistView || this.isDisposed || !scope || !this.hasCurrentScope(scope)) return false
      try {
        localStorage.removeItem('favorite_songs_userid')
        localStorage.setItem('favorite_songs', JSON.stringify(this.favoriteList))
        localStorage.setItem('favorite_songs_userid', scope.userid)
        return true
      } catch (error) {
        logger.error('FavoriteView', '保存本地收藏缓存失败', error)
        this.errorMessage = '无法保存本地收藏缓存'
        return false
      }
    },

    /** 本地编辑只修改相关行，并使尚未返回的刷新失效，避免覆盖用户刚作的选择。 */
    commitLocalFavorites() {
      this.requestGeneration += 1
      this.loadPromise = null
      this.loading = false
      this.loaded = true
      this.persistFavorites()
      this.$emit('favorites-changed', this.favoriteList)
    },
    canEditFavorites() {
      return !this.isPlaylistView && !this.isDisposed && !!this.requestScope && this.hasCurrentScope(this.requestScope)
    },
    // 格式化时长
    formatDuration(milliseconds) {
      if (!milliseconds) return '-'
      const seconds = Math.floor(milliseconds / 1000)
      const mins = Math.floor(seconds / 60)
      const secs = seconds % 60
      return `${mins}:${secs.toString().padStart(2, '0')}`
    },
    
    // 获取歌手名称
    getSingerNames(singerinfo) {
      // 如果是数组格式 (标准的 singerinfo)
      if (Array.isArray(singerinfo) && singerinfo.length > 0) {
        const names = singerinfo.map(s => {
          // 处理对象格式的歌手信息
          if (typeof s === 'object' && s !== null) {
            return s.name || s.singer_name || s.singername || s.author_name
          }
          // 处理字符串格式
          return String(s)
        }).filter(name => name && name.trim() && name !== '[object Object]')
        
        // 如果过滤后有有效的名字,返回拼接结果
        if (names.length > 0) {
          return names.join('、')
        }
      }
      // 如果是字符串格式
      if (typeof singerinfo === 'string' && singerinfo.trim()) {
        return singerinfo
      }
      return null // 返回 null 让模板使用备选方案
    },
    
    // 提取歌曲名称（去掉"歌手 - "前缀）
    getSongName(fullName) {
      if (!fullName) return '未知歌曲'
      // 如果包含 " - "，取后面的部分作为歌名
      const parts = fullName.split(' - ')
      if (parts.length > 1) {
        return parts.slice(1).join(' - ') // 处理歌名中也可能包含 " - " 的情况
      }
      return fullName
    },
    
    // 播放歌曲
    playSong(song) {
      // 防止重复快速点击
      if (this.isDisposed || this.isPlayingSong || !song) return
      
      this.isPlayingSong = true
      
      try {
        // 检查是否开启了"自动将全部歌单歌曲加入播放列表"功能
        if (this.settings?.playback?.enqueueFullPlaylist && this.favoriteList.length > 0) {
          logger.trace('FavoriteView', '自动加入全部歌曲到播放列表')
          // 找到当前歌曲在列表中的索引
          const songIndex = this.favoriteList.findIndex(s => s.hash === song.hash)
          
          if (songIndex !== -1) {
            // 重新排列歌单,让当前歌曲排在第一位
            const reorderedList = [
              song,
              ...this.favoriteList.slice(0, songIndex),
              ...this.favoriteList.slice(songIndex + 1)
            ]
            this.$emit('play-all', reorderedList)
          } else {
            // 如果找不到,就正常播放全部
            this.$emit('play-all', this.favoriteList)
          }
        } else {
          // 只播放单曲
          this.$emit('play', song)
        }
      } catch (error) {
        logger.error('FavoriteView', '[FavoriteView] playSong 错误:', error)
      } finally {
        // 延迟重置标志，防止快速点击
        clearTimeout(this.playSongTimer)
        if (!this.isDisposed) {
          this.playSongTimer = setTimeout(() => {
            this.playSongTimer = null
            if (!this.isDisposed) this.isPlayingSong = false
          }, 500)
        }
      }
    },
    
    // 下一首播放
    playNext(song) {
      logger.trace('FavoriteView', '下一首播放:', song)
      this.$emit('play-next', song)
    },
    
    // 显示右键菜单
    showContextMenu(event, song) {
      if (this.isDisposed || !this.isActive) return
      // 先关闭所有其他菜单
      contextMenuManager.closeActiveMenu()
      
      // 然后关闭自己的旧菜单，防止瞬移
      this.closeContextMenu()
      const generation = this.menuGeneration
      
      // 使用 nextTick 确保旧菜单完全关闭后再打开新菜单
      this.$nextTick(() => {
        if (this.isDisposed || !this.isActive || generation !== this.menuGeneration) return
        this.currentContextSong = song
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
      this.menuGeneration += 1
      this.contextMenuVisible = false
      this.currentContextSong = null
      contextMenuManager.unregisterMenu(this.closeContextMenu)
    },
    
    // 切换收藏状态
    toggleFavorite(song) {
      if (!this.canEditFavorites() || !song?.hash) return
      const isFavorite = this.favoriteList.some(s => s.hash === song.hash)
      if (isFavorite) {
        this.removeFavorite(song)
      } else {
        this.addFavorite(song)
      }
    },
    
    // 添加收藏
    addFavorite(song) {
      if (!this.canEditFavorites() || !song?.hash) return
      if (!this.favoriteList.some(s => s.hash === song.hash)) {
        const index = this.favoriteList.reduce((largest, item) => Math.max(largest, item.index || 0), 0) + 1
        this.favoriteList.push({ ...song, index })
        this.commitLocalFavorites()
      }
    },
    
    // 从播放列表移除
    removeFromPlaylist(song) {
      this.$emit('remove-from-playlist', song)
    },
    
    // 分享歌曲
    shareSong(song) {
      logger.trace('FavoriteView', '分享歌曲:', song)
      // TODO: 实现分享功能
      alert('分享功能开发中...')
    },
    
    // 搜索歌曲
    searchSong(song) {
      logger.trace('FavoriteView', '搜索歌曲:', song)
      this.$emit('search', song)
    },
    
    // 播放全部
    playAll() {
      if (this.favoriteList.length > 0) {
        logger.trace('FavoriteView', '播放全部')
        this.$emit('play-all', this.favoriteList)
      }
    },
    
    // 清空列表
    clearAll() {
      if (this.canEditFavorites() && confirm('确定要清空所有收藏吗？') && this.canEditFavorites()) {
        this.favoriteList.splice(0)
        this.commitLocalFavorites()
      }
    },
    
    // 移除收藏
    removeFavorite(song) {
      if (!this.canEditFavorites() || !song?.hash) return
      const index = this.favoriteList.findIndex(s => s.hash === song.hash)
      if (index > -1) {
        this.favoriteList.splice(index, 1)
        this.commitLocalFavorites()
      }
    },
    
    // 添加到歌单
    addToPlaylist(song) {
      logger.trace('FavoriteView', '添加到歌单:', song)
      // TODO: 实现添加到歌单功能
    },
    
    // 下载歌曲
    downloadSong(song) {
      logger.trace('FavoriteView', '下载歌曲:', song)
      // TODO: 实现下载功能
    },
    
    // 去发现页面
    goToDiscover() {
      this.$emit('navigate', 'home')
    },

    // 进入歌手页面
    goArtist(song) {
      const id = this.getPrimaryArtistId(song)
      const name = this.getPrimaryArtistName(song)
      this.$emit('navigate', 'artist', { id, name })
    },
    // 进入专辑页面
    goAlbum(song) {
      const id =
        song.album_id ||
        song.albumid ||
        song.AlbumID ||
        song.base?.album_id ||
        song.album_info?.album_id ||
        song.album_info?.id ||
        null
      const name = song.albuminfo?.name || song.album_name || song.remark || song.album_info?.album_name || null
      if (id || name) this.$emit('navigate', 'album', { id, name })
    },

    // 提取首个歌手ID
    getPrimaryArtistId(song) {
      const s = song || {}
      if (s.SingerId || s.singerid || s.AuthorId || s.author_id) return s.SingerId || s.singerid || s.AuthorId || s.author_id
      if (Array.isArray(s.singerinfo) && s.singerinfo.length) {
        const first = s.singerinfo[0]
        return first?.id || first?.singerid || first?.author_id || null
      }
      return null
    },

    // 提取首个歌手名
    getPrimaryArtistName(song) {
      const s = song || {}
      if (s.SingerName || s.singername || s.author_name) return s.SingerName || s.singername || s.author_name
      if (Array.isArray(s.singerinfo) && s.singerinfo.length) {
        const first = s.singerinfo[0]
        return first?.name || first?.singer_name || first?.singername || first?.author_name || null
      }
      // 从 "歌手 - 歌名" 中分离
      if (typeof s.name === 'string' && s.name.includes(' - ')) {
        return s.name.split(' - ')[0]
      }
      return null
    },
    
    // 切换排序顺序
    toggleSortOrder() {
      if (this.sortOrder === 'none') {
        this.sortOrder = 'asc'
      } else if (this.sortOrder === 'asc') {
        this.sortOrder = 'desc'
      } else {
        this.sortOrder = 'none'
      }
    }
  }
}
