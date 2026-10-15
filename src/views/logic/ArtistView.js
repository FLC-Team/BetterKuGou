
import ArtworkCover from '../../components/common/ArtworkCover.vue'
import { logger } from '../../utils/logger.js'
import { getArtistDetail, getArtistAudios, getArtistAlbums, followArtist, unfollowArtist, findArtistByName, getImagesByHash, getAlbumInfo } from '../../api/music.js'

export default {
  components: { ArtworkCover },
  name: 'ArtistView',
  props: {
    artistId: { type: [String, Number], default: null },
    artistName: { type: String, default: '' },
    currentSong: { type: Object, default: null }
  },
  emits: ['play', 'navigate'],
  data() {
    return {
      id: this.artistId || null,
      artist: null,
      followed: false,
      activeTab: 'hot',
      // 热门歌曲直接取单曲接口 sort=hot 前10
      hotSongs: [],
      songs: [],
      page: 1,
      pagesize: 30,
      hasMore: true,
      loadingMore: false,
      albums: [],
      albumsPage: 1,
      albumsLoading: false,
      infiniteScrollObserver: null,
      isPageActive: true,
      isDisposed: false,
      initialLoadComplete: false
    }
  },
  async mounted() {
    logger.trace('ArtistView', '🎨 [ArtistView] 组件挂载，初始参数:', {
      artistId: this.artistId,
      artistName: this.artistName,
      id: this.id
    })
    
    try {
      // 如果没有ID但有名称，尝试搜索获取ID
      if (!this.id && this.artistName) {
        logger.trace('ArtistView', '🔍 [ArtistView] 通过名称搜索歌手ID:', this.artistName)
        const found = await findArtistByName(this.artistName)
        if (this.isDisposed) return
        logger.trace('ArtistView', '🔍 [ArtistView] 搜索结果:', found)
        if (found?.AuthorId || found?.author_id || found?.ID) {
          this.id = found.AuthorId || found.author_id || found.ID
          logger.trace('ArtistView', '🔍 [ArtistView] 找到歌手ID:', this.id)
        }
      }

      await this.loadArtist()
      if (this.isDisposed) return
      await this.loadHot()
    } catch (error) {
      if (!this.isDisposed) logger.error('ArtistView', '初始化歌手页面失败', { artistId: this.id }, error)
    } finally {
      // 初始化结束后允许其他标签独立加载，热门请求失败不能锁死缓存页面。
      if (!this.isDisposed) {
        this.initialLoadComplete = true
        this.$nextTick(() => this.resumeActiveTab())
      }
    }
  },
  activated() {
    if (this.isDisposed) return
    this.isPageActive = true
    this.$nextTick(() => this.resumeActiveTab())
  },
  deactivated() {
    this.isPageActive = false
    this.teardownInfiniteScroll()
  },
  watch: {
    activeTab() {
      this.resumeActiveTab()
    }
  },
  methods: {
    // 缓存隐藏时暂停观察器；挂载完成或重新激活只恢复当前标签需要的资源。
    resumeActiveTab() {
      if (this.isPageActive === false || this.isDisposed || !this.initialLoadComplete) return
      this.teardownInfiniteScroll()
      if (this.activeTab === 'songs') {
        if (this.songs.length === 0) this.loadMore()
        this.$nextTick(() => this.setupInfiniteScroll())
      } else if (this.activeTab === 'albums' && this.albums.length === 0) {
        this.loadAlbums()
      }
    },
    teardownInfiniteScroll() {
      this.infiniteScrollObserver?.disconnect()
      this.infiniteScrollObserver = null
    },
    async loadArtist() {
      if (this.isDisposed) return
      const res = await getArtistDetail(this.id)
      if (this.isDisposed) return
      const raw = res?.data || res?.info || res?.author || res || null
      // 尽量规范化歌手字段
      const avatar = raw?.sizable_avatar || raw?.avatar || raw?.pic || raw?.sizable_cover || ''
      const name = raw?.author_name || raw?.name || raw?.base?.author_name || raw?.base?.name
      const fans = raw?.fans_cnt || raw?.fans_total || raw?.fans || raw?.follow_cnt || raw?.base?.fans_cnt
      const isFollow = raw?.is_follow || raw?.followed || raw?.isFollow
      this.artist = {
        ...raw,
        author_name: name || raw?.author_name,
        avatar: avatar,
        fans_cnt: typeof fans === 'number' ? fans : Number(fans) || undefined,
        is_follow: Boolean(isFollow)
      }
      this.followed = Boolean(this.artist.is_follow)
    },
    async loadHot() {
      if (this.isDisposed) return
      logger.trace('ArtistView', '🎵 [ArtistView] 加载热门歌曲，歌手ID:', this.id)
      const res = await getArtistAudios(this.id, 1, 10, 'hot')
      if (this.isDisposed) return
      logger.trace('ArtistView', '🎵 [ArtistView] 热门歌曲API响应:', res)
      
      const list = res?.data?.lists || res?.data?.info || res?.data || res?.lists || []
      logger.trace('ArtistView', '🎵 [ArtistView] 热门歌曲列表原始数据:', list)
      
      this.hotSongs = this.normalizeAudioList(list).slice(0, 10)
      logger.trace('ArtistView', '🎵 [ArtistView] 标准化后的热门歌曲:', this.hotSongs)
      
      if (this.hotSongs.length > 0) {
        logger.trace('ArtistView', '🎵 [ArtistView] 第一首热门歌曲详细信息:', this.hotSongs[0])
      }
      
      // 回填封面
      this.$nextTick(() => {
        this.patchMissingCovers(this.hotSongs)
        this.patchSongCoversFromAlbum(this.hotSongs)
      })
    },
    async loadMore() {
      if (this.isPageActive === false || this.isDisposed || !this.hasMore || this.loadingMore) return
      this.loadingMore = true
      try {
        const res = await getArtistAudios(this.id, this.page, this.pagesize, 'new')
        if (this.isDisposed) return
        const list = res?.data?.lists || res?.data?.info || res?.data || res?.lists || []
        const normalized = this.normalizeAudioList(list)
        if (Array.isArray(normalized) && normalized.length > 0) {
          this.songs = this.songs.concat(normalized)
          this.page += 1
          if (normalized.length < this.pagesize) this.hasMore = false
        } else {
          this.hasMore = false
        }
      } catch (error) {
        if (this.isDisposed) return
        logger.error('ArtistView', '加载歌手分页曲目失败', error)
      } finally {
        if (!this.isDisposed) this.loadingMore = false
      }
      // 回填封面
      this.$nextTick(() => {
        this.patchMissingCovers(this.songs)
        this.patchSongCoversFromAlbum(this.songs)
      })
    },
    setupInfiniteScroll() {
      this.teardownInfiniteScroll()
      if (this.isPageActive === false || this.isDisposed || this.activeTab !== 'songs') return
      const sentinel = this.$refs.sentinel
      if (!sentinel) return
      const io = new IntersectionObserver((entries) => {
        if (this.isPageActive === false || this.isDisposed || this.infiniteScrollObserver !== io) return
        entries.forEach(e => {
          if (e.isIntersecting) {
            this.loadMore()
          }
        })
      }, { root: this.$refs.scrollArea, threshold: 0.1 })
      io.observe(sentinel)
      this.infiniteScrollObserver = io
    },
    async patchMissingCovers(list) {
      if (this.isDisposed) return
      const need = (list || []).filter(s => !s.cover && s.hash).slice(0, 50)
      logger.trace('ArtistView', '🖼️ [ArtistView] patchMissingCovers: 需要补充封面的歌曲数量:', need.length)
      
      if (need.length === 0) return
      
      try {
        const hashes = need.map(s => s.hash)
        logger.trace('ArtistView', '🖼️ [ArtistView] patchMissingCovers: 请求封面的hashes:', hashes)
        
        const res = await getImagesByHash(hashes, 1)
        if (this.isDisposed) return
        logger.trace('ArtistView', '🖼️ [ArtistView] patchMissingCovers: API响应:', res)
        
        const map = res?.data || res?.images || res || {}
        logger.trace('ArtistView', '🖼️ [ArtistView] patchMissingCovers: 封面数据映射:', map)
        
        need.forEach((item, index) => {
          const pics = map[item.hash] || map[item.hash?.toLowerCase()] || []
          logger.trace('ArtistView', `🖼️ [ArtistView] patchMissingCovers: ${item.name} (${item.hash}) 获取到的图片:`, pics)
          
          const first = Array.isArray(pics) ? pics[0] : null
          const url = first?.sizable_cover || first?.url || first
          
          if (url) {
            const finalUrl = String(url).replace('{size}', '400')
            item.cover = finalUrl
            logger.trace('ArtistView', `🖼️ [ArtistView] patchMissingCovers: ${item.name} 设置封面:`, finalUrl)
          } else {
            logger.trace('ArtistView', `🖼️ [ArtistView] patchMissingCovers: ${item.name} 没有找到有效封面`)
          }
        })
      } catch (e) {
        logger.error('ArtistView', '🖼️ [ArtistView] patchMissingCovers: 补充封面失败:', e)
      }
    },
    
    async patchSongCoversFromAlbum(list) {
      if (this.isDisposed) return
      const needAlbumCovers = (list || []).filter(s => s._needAlbumCover && s.album_id)
      logger.trace('ArtistView', '🎼 [ArtistView] patchSongCoversFromAlbum: 需要通过专辑获取封面的歌曲数量:', needAlbumCovers.length)
      
      if (needAlbumCovers.length === 0) return
      
      try {
        const albumIds = Array.from(new Set(needAlbumCovers.map(s => s.album_id)))
        logger.trace('ArtistView', '🎼 [ArtistView] patchSongCoversFromAlbum: 请求的专辑IDs:', albumIds)
        
        const res = await getAlbumInfo(albumIds, 'album_id,sizable_cover,cover')
        if (this.isDisposed) return
        logger.trace('ArtistView', '🎼 [ArtistView] patchSongCoversFromAlbum: API响应:', res)
        
        const albumData = res?.data?.list || res?.data || res?.albums || res || []
        logger.trace('ArtistView', '🎼 [ArtistView] patchSongCoversFromAlbum: 专辑数据:', albumData)
        
        // 创建专辑封面映射
        let albumCoverMap = {}
        if (Array.isArray(albumData)) {
          albumData.forEach(album => {
            const key = album.album_id || album.albumid || album.id
            const cover = album.sizable_cover || album.cover
            if (key && cover) {
              albumCoverMap[String(key)] = cover
            }
          })
        }
        
        logger.trace('ArtistView', '🎼 [ArtistView] patchSongCoversFromAlbum: 专辑封面映射:', albumCoverMap)
        
        needAlbumCovers.forEach(song => {
          const albumCover = albumCoverMap[String(song.album_id)]
          if (albumCover) {
            const finalUrl = String(albumCover).replace('{size}', '400')
            song.cover = finalUrl
            logger.trace('ArtistView', `🎼 [ArtistView] patchSongCoversFromAlbum: ${song.name} 通过专辑设置封面:`, finalUrl)
          } else {
            logger.trace('ArtistView', `🎼 [ArtistView] patchSongCoversFromAlbum: ${song.name} 的专辑 ${song.album_id} 没有找到封面`)
          }
        })
      } catch (e) {
        logger.error('ArtistView', '🎼 [ArtistView] patchSongCoversFromAlbum: 通过专辑获取封面失败:', e)
      }
    },
    // 回填专辑封面：按 album_id 批量查询专辑信息并写入 sizable_cover/cover
    async patchAlbumCovers(albumsChunk) {
      if (this.isDisposed) return
      const target = (albumsChunk || []).filter(a => !(a.sizable_cover || a.cover) && (a.album_id || a.albumid))
      logger.trace('ArtistView', '🎨 [ArtistView] patchAlbumCovers: 需要补充封面的专辑数量:', target.length)
      
      if (target.length === 0) return
      
      try {
        const ids = Array.from(new Set(target.map(a => a.album_id || a.albumid)))
        logger.trace('ArtistView', '🎨 [ArtistView] patchAlbumCovers: 请求封面的专辑IDs:', ids)
        
        const res = await getAlbumInfo(ids, 'album_id,album_name,sizable_cover,cover')
        if (this.isDisposed) return
        logger.trace('ArtistView', '🎨 [ArtistView] patchAlbumCovers: API响应:', res)
        
        const list = res?.data?.list || res?.data || res?.albums || res || []
        logger.trace('ArtistView', '🎨 [ArtistView] patchAlbumCovers: 专辑信息列表:', list)
        
        // 支持 map 或数组两种返回
        let infoMap = {}
        if (Array.isArray(list)) {
          list.forEach(item => {
            const key = item.album_id || item.albumid || item.id
            if (key) infoMap[String(key)] = item
          })
        } else if (typeof list === 'object' && list) {
          infoMap = list
        }
        
        logger.trace('ArtistView', '🎨 [ArtistView] patchAlbumCovers: 专辑信息映射:', infoMap)
        
        target.forEach(a => {
          const key = String(a.album_id || a.albumid)
          const info = infoMap[key] || infoMap[a.album_id] || infoMap[a.albumid]
          logger.trace('ArtistView', `🎨 [ArtistView] patchAlbumCovers: 专辑 ${a.album_name} (${key}) 获取到的信息:`, info)
          
          const url = info?.sizable_cover || info?.cover
          if (url) {
            const finalUrl = String(url).replace('{size}', '400')
            if (!a.sizable_cover) a.sizable_cover = finalUrl
            else a.sizable_cover = a.sizable_cover.replace('{size}', '400')
            if (!a.cover) a.cover = finalUrl
            logger.trace('ArtistView', `🎨 [ArtistView] patchAlbumCovers: 专辑 ${a.album_name} 设置封面:`, finalUrl)
          } else {
            logger.trace('ArtistView', `🎨 [ArtistView] patchAlbumCovers: 专辑 ${a.album_name} 没有找到有效封面`)
          }
        })
      } catch (e) {
        logger.error('ArtistView', '🎨 [ArtistView] patchAlbumCovers: 补充专辑封面失败:', e)
      }
    },
    // 规整歌曲数据，兼容不同字段
    normalizeAudioList(list) {
      if (!Array.isArray(list)) return []
      return list.map((it, index) => {
        logger.trace('ArtistView', `🎵 [ArtistView] 规整第${index + 1}首歌曲:`, it)
        
        const hash = it.hash || it.Hash || it.filehash || it.FileHash || it.audio_hash
        const albumAudioId = it.album_audio_id || it.MixSongID || it.mixsongid || it.album_audioid
        // 尝试多种可能的封面字段
        let cover = it.sizable_cover || it.cover || it.img || it.Image || it.imgurl || it.image || 
                   it.album_img || it.album_cover || it.album_sizable_cover || it.pic || it.picture || 
                   it.artwork || it.thumbnail || ''
        
        // 如果还是没有封面，尝试从专辑信息中获取
        if (!cover) {
          const albumInfo = it.album_info || it.albuminfo || {}
          cover = albumInfo.sizable_cover || albumInfo.cover || albumInfo.img || albumInfo.imgurl || ''
        }
        const authors = it.authors || it.singerinfo || []
        
        // 检查所有可能的封面字段
        const coverFields = {
          sizable_cover: it.sizable_cover,
          cover: it.cover,
          img: it.img,
          Image: it.Image,
          imgurl: it.imgurl,
          image: it.image,
          album_img: it.album_img,
          album_cover: it.album_cover,
          album_sizable_cover: it.album_sizable_cover,
          pic: it.pic,
          picture: it.picture,
          artwork: it.artwork,
          thumbnail: it.thumbnail
        }
        
        logger.trace('ArtistView', `🎵 [ArtistView] 第${index + 1}首歌曲所有可能的封面字段:`, coverFields)
        
        // 如果没有直接的封面，尝试通过专辑信息获取
        const albumInfo = it.album_info || it.albuminfo || {}
        const albumCoverFields = {
          album_sizable_cover: albumInfo.sizable_cover,
          album_cover: albumInfo.cover,
          album_img: albumInfo.img,
          album_imgurl: albumInfo.imgurl
        }
        logger.trace('ArtistView', `🎵 [ArtistView] 第${index + 1}首歌曲专辑封面字段:`, albumCoverFields)
        
        const singerArray = Array.isArray(authors)
          ? authors.map(a => ({
              id: a.id || a.author_id || a.singerid,
              name: a.name || a.author_name || a.singer_name || a.singername
            })).filter(a => a.name)
          : []
        const singername = singerArray.map(a => a.name).join('、') || it.singername || it.SingerName || it.author_name
        // 名称优先级
        const rawName = it.audio_name || it.song_name || it.name || it.filename || it.remark
        const name = rawName || (typeof it.filename === 'string' ? it.filename.split(' - ').slice(1).join(' - ') : '未知歌曲')
        const albuminfo = it.album_info || it.albuminfo || (it.album_name ? { name: it.album_name } : null)
        const timelen = (it.timelength || it.timelen || it.Duration || it.duration || 0) * (it.Duration || it.duration ? 1000 : 1)
        
        let normalized = {
          ...it,
          hash,
          album_audio_id: albumAudioId || it.album_audio_id,
          cover,
          singerinfo: singerArray,
          singername,
          albuminfo,
          name,
          filename: name,
          timelen
        }
        
        // 保存专辑ID以便后续获取专辑封面
        if (!cover && it.album_id) {
          // 标记这首歌需要通过专辑ID获取封面
          normalized._needAlbumCover = true
        }
        
        logger.trace('ArtistView', `🎵 [ArtistView] 第${index + 1}首歌曲规整后:`, normalized)
        return normalized
      })
    },
    async loadAlbums() {
      if (this.isPageActive === false || this.isDisposed || this.albumsLoading) return
      this.albumsLoading = true
      try {
        logger.trace('ArtistView', '📀 [ArtistView] 加载专辑，歌手ID:', this.id, '页码:', this.albumsPage)
        const res = await getArtistAlbums(this.id, this.albumsPage, 30, 'new')
        if (this.isDisposed) return
        logger.trace('ArtistView', '📀 [ArtistView] 专辑API响应:', res)
        
        const list = res?.data?.lists || res?.data?.albums || res?.data || []
        logger.trace('ArtistView', '📀 [ArtistView] 专辑列表原始数据:', list)
        
        this.albums = this.albums.concat(list)
        logger.trace('ArtistView', '📀 [ArtistView] 当前所有专辑:', this.albums)
        
        if (list.length > 0) {
          logger.trace('ArtistView', '📀 [ArtistView] 第一个专辑详细信息:', list[0])
        }
        
        // 为新增的这批专辑回填封面
        this.$nextTick(() => this.patchAlbumCovers(list))
        this.albumsPage += 1
      } finally {
        if (!this.isDisposed) this.albumsLoading = false
      }
    },
    async toggleFollow() {
      try {
        if (this.followed) {
          await unfollowArtist(this.id)
          this.followed = false
        } else {
          await followArtist(this.id)
          this.followed = true
        }
      } catch (e) {
        logger.error('ArtistView', '切换关注失败:', e)
      }
    },
    formatNumber(n) {
      if (typeof n !== 'number') return n
      if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
      if (n >= 10000) return (n / 10000).toFixed(1) + '万'
      return n
    },
    getAvatar(artist) {
      const url = artist?.avatar || artist?.pic || artist?.sizable_avatar || artist?.sizable_cover || ''
      return typeof url === 'string' ? url.replace('{size}', '400') : ''
    },
    getAlbumCover(al) {
      if (!al) {
        logger.trace('ArtistView', '📷 [ArtistView] getAlbumCover: 专辑对象为空')
        return ''
      }
      
      logger.trace('ArtistView', '📷 [ArtistView] getAlbumCover: 专辑对象:', al)
      
      // 尝试多种可能的封面字段
      const url = al.sizable_cover || al.cover || al.img || al.imgurl || al.image || ''
      logger.trace('ArtistView', '📷 [ArtistView] getAlbumCover: 找到的URL字段:', {
        sizable_cover: al.sizable_cover,
        cover: al.cover,
        img: al.img,
        imgurl: al.imgurl,
        image: al.image,
        selected: url
      })
      
      if (!url) {
        logger.trace('ArtistView', '📷 [ArtistView] getAlbumCover: 没有找到有效的封面URL')
        return ''
      }
      
      // 确保是字符串并处理模板
      const finalUrl = typeof url === 'string' ? url.replace('{size}', '400') : String(url)
      logger.trace('ArtistView', '📷 [ArtistView] getAlbumCover: 处理后的URL:', finalUrl)
      
      // 验证URL格式
      if (finalUrl && (finalUrl.startsWith('http://') || finalUrl.startsWith('https://'))) {
        logger.trace('ArtistView', '📷 [ArtistView] getAlbumCover: URL有效，返回:', finalUrl)
        return finalUrl
      }
      
      logger.trace('ArtistView', '📷 [ArtistView] getAlbumCover: URL格式无效')
      return ''
    },
    onAlbumCoverError(event) {
      // 如果图片加载失败，隐藏图片元素
      logger.trace('ArtistView', '📷 [ArtistView] 专辑封面加载失败:', event.target.src)
      event.target.style.display = 'none'
    },
    onSongCoverLoad(song, event) {
      logger.trace('ArtistView', '📷 [ArtistView] 歌曲封面加载成功:', song.name, event.target.src)
    },
    onSongCoverError(song, event) {
      logger.trace('ArtistView', '📷 [ArtistView] 歌曲封面加载失败:', song.name, event.target.src)
      event.target.style.display = 'none'
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
    },
    play(song) {
      this.$emit('play', song)
    },
    goArtist(song) {
      const id = this.getPrimaryArtistId(song)
      const name = this.getPrimaryArtistName(song)
      this.$emit('navigate', 'artist', { id, name })
    },
    goAlbum(song) {
      const s = song || {}
      const id =
        s.album_id ||
        s.albumid ||
        s.AlbumID ||
        s.base?.album_id ||
        s.album?.id ||
        s.album_info?.album_id ||
        s.album_info?.id ||
        s.albuminfo?.album_id ||
        s.albuminfo?.id ||
        null
      const name = (s.albuminfo && s.albuminfo.name) || s.album_name || s.remark || s.album_info?.album_name || s.album || ''
      if (id) {
        this.$emit('navigate', 'album', { id, name })
      }
    },
    openAlbum(al) {
      const a = al || {}
      const id = a.album_id || a.albumid || a.id || a.base?.album_id
      const name = a.album_name || a.name || a.album_info?.album_name || ''
      if (id) {
        this.$emit('navigate', 'album', { id, name })
      }
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
    pretty(val) {
      try { return JSON.stringify(val, null, 2) } catch { return String(val) }
    }
  },
  beforeUnmount() {
    this.isDisposed = true
    this.isPageActive = false
    this.teardownInfiniteScroll()
  }
}
