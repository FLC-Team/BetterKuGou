<template>
  <div class="my-music-view library-page list-page">
    <div class="list-content">
    <header class="collection-hero library-hero">
      <div class="collection-art library-art" aria-hidden="true">
        <span class="library-art-label">THE PERSONAL COLLECTION</span>
        <svg class="library-record" viewBox="0 0 120 120" fill="none"><path d="M13 29v65M23 24v75" stroke="currentColor" stroke-width="3" stroke-linecap="round" /><rect x="34" y="18" width="72" height="86" rx="6" fill="currentColor" opacity=".07" /><rect x="34" y="18" width="72" height="86" rx="6" stroke="currentColor" stroke-width="2.5" /><circle cx="70" cy="57" r="25" stroke="currentColor" stroke-width="2.5" /><circle cx="70" cy="57" r="19" stroke="currentColor" opacity=".2" /><circle cx="70" cy="57" r="8" fill="currentColor" /><circle cx="70" cy="57" r="2" class="record-hole" /><path d="M60 92h20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg>
        <span class="library-art-footer">SIDE A <span>YOUR SOUNDTRACK</span></span>
      </div>
      <div class="collection-copy">
        <p class="eyebrow">MY LIBRARY / 私人音乐档案</p>
        <h1 class="page-title">我的音乐<span class="title-dot">.</span></h1>
        <p class="collection-description">每一次聆听，都有回响。<br />回到熟悉的旋律，追随喜欢的歌手继续发现。</p>
        <div class="collection-meta"><span>听过的，喜欢的，值得留下的</span></div>
      </div>
    </header>
    <div ref="libraryTabs" class="library-tabs" role="tablist" aria-label="我的音乐分类">
      <button v-for="(tab, index) in tabs" :id="`my-music-tab-${tab.id}`" :key="tab.id" type="button" class="library-tab" role="tab" :aria-selected="activeTab === tab.id" aria-controls="my-music-panel" :tabindex="activeTab === tab.id ? 0 : -1" @click="selectTab(tab.id)" @keydown="handleTabKey($event, index)">
        <span class="tab-heading"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="tab.icon" /></svg><span class="tab-number">{{ String(index + 1).padStart(2, '0') }}</span></span>
        <span class="tab-label">{{ tab.label }}</span><span class="tab-caption">{{ tab.caption }}</span>
      </button>
    </div>
    <section id="my-music-panel" class="library-panel" role="tabpanel" :aria-labelledby="`my-music-tab-${activeTab}`" :aria-busy="activeTab !== 'downloads' && page.loading" tabindex="0">
    <AppNotice :message="playbackNotice" :revision="playbackNoticeRevision" title="播放提示" type="warning" :actions="[{ label: '刷新列表', run: () => loadPage(false, true), disabled: page.loading }]" />
    <DownloadsView v-if="activeTab === 'downloads'" />
    <div v-else-if="!userLoggedIn" class="empty-state"><p class="empty-text">让音乐，回到你的身边</p><p class="empty-hint">登录后查看你的听歌记录、关注和云盘。</p><button type="button" class="primary-btn" @click="$emit('show-login')">登录账号</button></div>
    <template v-else>
      <div class="section-heading library-section-heading"><div class="section-title"><span class="section-index" aria-hidden="true">{{ String(activeTabIndex + 1).padStart(2, '0') }}</span><h2>{{ selectedTab.label }}</h2><span v-if="page.loaded" class="collection-count">{{ page.total ?? page.items.length }} {{ activeTab === 'follow' ? '位歌手' : activeTab === 'news' ? '张作品' : '首歌曲' }}</span></div><button type="button" class="action-btn refresh-library" :disabled="page.loading" @click="loadPage(false, true)"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6" /></svg>{{ page.loading ? '正在更新…' : '刷新' }}</button></div>
      <div v-if="activeTab === 'listen'" class="listen-filters" role="group" aria-label="统计范围"><button v-for="period in [{ id: '0', label: '最近一周' }, { id: '1', label: '全部时间' }]" :key="period.id" type="button" :aria-pressed="listenType === period.id" @click="selectListenType(period.id)">{{ period.label }}</button></div>
      <p v-if="activeTab === 'cloud'" class="library-hint">只读取和播放你上传的歌曲，文件保留在原云盘中。</p>
      <AppNotice :message="page.error" title="音乐加载失败" type="error" :actions="[{ label: '重试', run: () => loadPage(page.requestAppend, true), disabled: page.loading }]" />
      <div v-if="page.loading && !page.items.length" class="loading-container" role="status"><span class="loading-spinner" aria-hidden="true"></span><p>正在读取你的音乐…</p></div>
      <div v-else-if="page.loaded && !page.items.length" class="empty-state"><p class="empty-text">这里还没有内容</p><p class="empty-hint">先去发现一些喜欢的音乐，让这里慢慢丰富起来。</p></div>
      <div v-if="activeTab === 'follow' && page.items.length" class="library-cards"><button v-for="(artist, index) in page.items" :key="`${artistId(artist)}-${index}`" type="button" class="music-card artist-card" @click="openArtist(artist)"><span class="card-art"><ArtworkCover :src="artist.avatar || ''" class="card-cover" /><span class="card-arrow" aria-hidden="true">↗</span></span><strong>{{ artistName(artist) }}</strong><span class="card-description">关注的歌手</span></button></div>
      <div v-else-if="activeTab === 'news' && page.items.length" class="library-cards"><button v-for="(album, index) in page.items" :key="`${album.album_id || album.id}-${index}`" type="button" class="music-card" @click="openAlbum(album)"><span class="card-art"><ArtworkCover :src="album.sizable_cover || album.cover || album.imgurl || ''" class="card-cover" /><span class="card-arrow" aria-hidden="true">↗</span></span><strong>{{ album.album_name || album.name || '新作品' }}</strong><span class="card-description">{{ album.author_name || album.publish_date || '查看作品' }}</span></button></div>
      <LibrarySongs v-else-if="!['follow', 'news'].includes(activeTab) && page.items.length" :songs="page.items" :current-song="currentSong" :total="page.total" :selection-scope="resourceKey" v-on="songEvents" />
      <button v-if="page.loaded && page.more" type="button" class="action-btn load-more" :disabled="page.loading" @click="loadPage(true)">{{ page.loading ? '正在加载…' : '加载更多' }}</button>
    </template>
    </section>
    </div>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import LibrarySongs from '../components/common/LibrarySongs.vue'
import DownloadsView from '../components/common/DownloadsView.vue'
import { getUserHistory, getUserListen, getFollowedArtists, getFollowedNewSongs, getCloudSongs, completeLibrarySongs } from '../api/library.js'
import { findLibraryList, normalizeLibrarySong, normalizeLibraryArtist } from '../utils/libraryMetadata.js'
import { createLibraryPageState, appendLibraryPage } from './logic/libraryPage.js'
import { logger } from '../utils/logger.js'

export default {
  name: 'MyMusicView', components: { ArtworkCover, LibrarySongs, DownloadsView },
  props: { currentSong: { type: Object, default: null }, userLoggedIn: Boolean, userId: { type: [String, Number], default: '' } },
  emits: ['play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details', 'show-login'],
  data() { return { activeTab: 'history', listenType: '0', pages: {}, generation: 0, controller: null, activeRequestKey: '', disposed: false, playbackNotice: '', playbackNoticeRevision: 0,
    tabs: [
      { id: 'history', label: '最近播放', caption: 'RECENTLY PLAYED', icon: 'M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2' },
      { id: 'listen', label: '听歌排行', caption: 'ON REPEAT', icon: 'M4 20V12h4v8M10 20V5h4v15M16 20V9h4v11M2 20h20' },
      { id: 'follow', label: '关注歌手', caption: 'MY ARTISTS', icon: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a6 6 0 0 1 10-4.5M19 13v8M15 17h8' },
      { id: 'news', label: '关注的新作品', caption: 'NEW RELEASES', icon: 'M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6M11 8a4 4 0 1 0 5 5M17 2v6M14 5h6M7 17h6' },
      { id: 'cloud', label: '音乐云盘', caption: 'IN THE CLOUD', icon: 'M7 18H6a4 4 0 0 1-1-7.9 7 7 0 0 1 13.6-1.6A4.8 4.8 0 0 1 20 18M11 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM13 19v-7l4 1' },
      { id: 'downloads', label: '下载', caption: 'KEEP IT CLOSE', icon: 'M12 3v12M7 10l5 5 5-5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5' }
    ] } },
  computed: {
    resourceKey() { return `${this.activeTab}:${this.activeTab === 'listen' ? this.listenType : ''}:${this.userId}` },
    activeTabIndex() { return this.tabs.findIndex(tab => tab.id === this.activeTab) },
    selectedTab() { return this.tabs[this.activeTabIndex] },
    page() { return this.pages[this.resourceKey] || createLibraryPageState() },
    songEvents() { return Object.fromEntries(this.$options.emits.map(event => [event, (...args) => this.forwardSongEvent(event, ...args)])) }
  },
  watch: { userId() { this.controller?.abort(); this.generation++; this.pages = {}; this.loadPage() }, userLoggedIn() { this.controller?.abort(); this.generation++; this.pages = {}; this.loadPage() } },
  mounted() { this.loadPage() },
  beforeUnmount() { this.disposed = true; this.generation++; this.controller?.abort() },
  methods: {
    /** Keep unavailable history entries visible without replacing playback with an unusable song. */
    forwardSongEvent(event, ...args) {
      if (['play', 'play-next', 'play-all'].includes(event)) {
        const songs = event === 'play-all' ? args[0] : [args[0]]
        const playable = songs.filter(song => typeof song?.hash === 'string' && song.hash.trim())
        if (playable.length !== songs.length) {
          this.playbackNotice = event === 'play-all' && playable.length
            ? `${songs.length - playable.length} 首歌曲暂时无法取得播放信息，已跳过；可刷新列表后重试。`
            : '这首歌曲暂时无法取得播放信息，请刷新后重试。'
          this.playbackNoticeRevision++
          if (!playable.length) return
          args[0] = playable
        } else this.playbackNotice = ''
      }
      this.$emit(event, ...args)
    },
    cancelPageRequest() { this.controller?.abort(); this.generation++; if (this.pages[this.activeRequestKey]) this.pages[this.activeRequestKey].loading = false },
    selectTab(id) { if (id === this.activeTab || !this.tabs.some(tab => tab.id === id)) return; this.cancelPageRequest(); this.activeTab = id; this.loadPage() },
    /** The tab strip keeps one keyboard stop and activates the focused resource. */
    handleTabKey(event, index) {
      const offsets = { ArrowRight: 1, ArrowLeft: -1 }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.tabs.length - 1 : event.key in offsets ? (index + offsets[event.key] + this.tabs.length) % this.tabs.length : null
      if (next === null) return
      event.preventDefault()
      this.selectTab(this.tabs[next].id)
      this.$nextTick(() => this.$refs.libraryTabs?.querySelectorAll('[role="tab"]')[next]?.focus())
    },
    selectListenType(type) { if (type === this.listenType) return; this.listenType = type; this.changeScope() },
    changeScope() { this.cancelPageRequest(); this.loadPage() },
    /** Cursor history, numbered cloud pages and nonpaged collections retain separate resource state. */
    async loadPage(append = false, force = false) {
      if (!this.userLoggedIn || this.activeTab === 'downloads' || this.disposed) return
      const key = this.resourceKey
      if (!this.pages[key]) this.pages[key] = createLibraryPageState()
      const state = this.pages[key]
      if (state.loading || (!append && state.loaded && !force)) return
      const generation = ++this.generation; this.controller?.abort(); const controller = this.controller = new AbortController()
      this.activeRequestKey = key
      const tab = this.activeTab; state.loading = true; state.error = ''; state.requestAppend = append
      try {
        const fetch = { history: getUserHistory, listen: getUserListen, follow: getFollowedArtists, news: getFollowedNewSongs, cloud: getCloudSongs }[tab]
        const params = { page: append ? state.page + 1 : 1, pagesize: 30, type: Number(this.listenType) }
        if (append && tab === 'history' && state.cursor) params.bp = state.cursor
        if (append && tab === 'news') params.last_album_id = state.items.at(-1)?.album_id || state.items.at(-1)?.id
        const response = await fetch(params, { signal: controller.signal })
        if (this.disposed || generation !== this.generation) return
        const raw = findLibraryList(response)
        if (!raw) throw new Error('内容格式暂不可读取，请重试。')
        const items = tab === 'follow' ? raw.map(normalizeLibraryArtist) : tab === 'news' ? raw : await completeLibrarySongs(raw.map(song => normalizeLibrarySong(song, tab === 'cloud' ? { source: 'cloud', sourceUserId: this.userId } : {})), { signal: controller.signal })
        if (this.disposed || generation !== this.generation || controller.signal.aborted) return
        const previousCursor = state.cursor
        appendLibraryPage(state, items, response, { append })
        if (['follow', 'listen'].includes(tab)) state.more = false
        if (tab === 'history') state.more = !!state.cursor && state.cursor !== previousCursor && items.length > 0
      } catch (error) { if (!this.disposed && generation === this.generation && !controller.signal.aborted) { state.error = error?.message || '加载失败，请重试。'; logger.error('MyMusicView', '读取我的音乐失败', { tab, error }) } }
      finally { if (this.controller === controller) state.loading = false }
    },
    artistId(artist) { return artist.singerid ?? artist.singer_id ?? artist.author_id ?? artist.SingerId ?? artist.AuthorId ?? artist.ext_params?.singerid },
    artistName(artist) { return artist.singername || artist.singer_name || artist.author_name || artist.name || artist.nickname || '未知歌手' },
    openArtist(artist) { this.$emit('navigate', 'artist', { id: this.artistId(artist), name: this.artistName(artist) }) },
    openAlbum(album) { const id = album.album_id ?? album.id; if (id != null) this.$emit('navigate', 'album', { id, name: album.album_name || album.name || '' }) }
  }
}
</script>

<style src="./styles/ListPage.css" scoped></style>
<style src="./styles/MyMusicView.css" scoped></style>
