<template>
  <div class="my-music-view library-page">
    <header><p class="eyebrow">MY LIBRARY / 我的音乐</p><h1>每一次聆听，都有回响<span>.</span></h1><p>回到熟悉的旋律，也追随喜欢的歌手继续发现。</p></header>
    <nav class="tabs" aria-label="我的音乐分类"><button v-for="tab in tabs" :key="tab.id" type="button" :aria-current="activeTab === tab.id ? 'page' : undefined" @click="selectTab(tab.id)">{{ tab.label }}</button></nav>
    <DownloadsView v-if="activeTab === 'downloads'" />
    <div v-else-if="!userLoggedIn" class="status"><p>登录后查看你的听歌记录、关注和云盘。</p><button type="button" @click="$emit('show-login')">登录账号</button></div>
    <template v-else>
      <div class="section-heading"><h2>{{ tabs.find(tab => tab.id === activeTab)?.label }}</h2><button type="button" :disabled="page.loading" @click="loadPage(false, true)">{{ page.loading ? '正在更新…' : '刷新' }}</button></div>
      <div v-if="activeTab === 'listen'" class="filters"><label for="listen-period">统计范围</label><select id="listen-period" v-model="listenType" @change="changeScope"><option value="0">最近一周</option><option value="1">全部时间</option></select></div>
      <p v-if="activeTab === 'cloud'" class="hint">只读取和播放你上传的歌曲，文件保留在原云盘中。</p>
      <Transition name="ui-fade"><p v-if="page.error" class="error" role="alert">{{ page.error }} <button type="button" :disabled="page.loading" @click="loadPage(page.requestAppend, true)">重试</button></p></Transition>
      <p v-if="page.loading && !page.items.length" class="status" role="status"><span class="loading-spinner"></span>正在读取你的音乐…</p>
      <p v-else-if="page.loaded && !page.items.length" class="status">这里还没有内容，先去发现一些喜欢的音乐。</p>
      <div v-if="activeTab === 'follow'" class="cards"><button v-for="(artist, index) in page.items" :key="`${artistId(artist)}-${index}`" type="button" class="music-card artist-card" @click="openArtist(artist)"><ArtworkCover :src="artist.sizable_avatar || artist.avatar || artist.pic || artist.image || ''" class="card-cover" /><strong>{{ artistName(artist) }}</strong><span>查看歌手</span></button></div>
      <div v-else-if="activeTab === 'news'" class="cards"><button v-for="(album, index) in page.items" :key="`${album.album_id || album.id}-${index}`" type="button" class="music-card" @click="openAlbum(album)"><ArtworkCover :src="album.sizable_cover || album.cover || album.imgurl || ''" class="card-cover" /><strong>{{ album.album_name || album.name || '新作品' }}</strong><span>{{ album.author_name || album.publish_date || '查看作品' }}</span></button></div>
      <LibrarySongs v-else :songs="page.items" :current-song="currentSong" :total="page.total" v-on="songEvents" />
      <button v-if="page.loaded && page.more" type="button" class="load-more" :disabled="page.loading" @click="loadPage(true)">{{ page.loading ? '正在加载…' : '加载更多' }}</button>
    </template>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import LibrarySongs from '../components/common/LibrarySongs.vue'
import DownloadsView from '../components/common/DownloadsView.vue'
import { getUserHistory, getUserListen, getFollowedArtists, getFollowedNewSongs, getCloudSongs } from '../api/library.js'
import { findLibraryList, normalizeLibrarySong } from '../utils/libraryMetadata.js'
import { createLibraryPageState, appendLibraryPage } from './logic/libraryPage.js'
import { logger } from '../utils/logger.js'

export default {
  name: 'MyMusicView', components: { ArtworkCover, LibrarySongs, DownloadsView },
  props: { currentSong: { type: Object, default: null }, userLoggedIn: Boolean, userId: { type: [String, Number], default: '' } },
  emits: ['play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details', 'show-login'],
  data() { return { activeTab: 'history', listenType: '0', pages: {}, generation: 0, controller: null, activeRequestKey: '', disposed: false,
    tabs: [{ id: 'history', label: '最近播放' }, { id: 'listen', label: '听歌排行' }, { id: 'follow', label: '关注歌手' }, { id: 'news', label: '关注的新作品' }, { id: 'cloud', label: '音乐云盘' }, { id: 'downloads', label: '下载' }] } },
  computed: {
    resourceKey() { return `${this.activeTab}:${this.listenType}:${this.userId}` },
    page() { return this.pages[this.resourceKey] || createLibraryPageState() },
    songEvents() { return Object.fromEntries(this.$options.emits.map(event => [event, (...args) => this.$emit(event, ...args)])) }
  },
  watch: { userId() { this.controller?.abort(); this.generation++; this.pages = {}; this.loadPage() }, userLoggedIn() { this.controller?.abort(); this.generation++; this.pages = {}; this.loadPage() } },
  mounted() { this.loadPage() },
  beforeUnmount() { this.disposed = true; this.generation++; this.controller?.abort() },
  methods: {
    cancelPageRequest() { this.controller?.abort(); this.generation++; if (this.pages[this.activeRequestKey]) this.pages[this.activeRequestKey].loading = false },
    selectTab(id) { if (id === this.activeTab) return; this.cancelPageRequest(); this.activeTab = id; this.loadPage() },
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
        const items = ['follow', 'news'].includes(tab) ? raw : raw.map(song => normalizeLibrarySong(song, tab === 'cloud' ? { source: 'cloud', sourceUserId: this.userId } : {}))
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

<style scoped>
.library-page{padding:40px clamp(24px,5vw,76px) 70px;overflow:auto;color:var(--color-text)}header{max-width:760px;margin-bottom:32px}.eyebrow{font-size:11px;letter-spacing:.16em;color:var(--color-text-secondary)}h1{font-size:clamp(27px,3.2vw,46px);letter-spacing:-.04em;margin:12px 0 18px}h1 span{color:var(--color-primary)}header>p:last-child,.hint{color:var(--color-text-secondary);line-height:1.8;font-size:14px}.tabs,.filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:20px 0}.tabs{border-bottom:1px solid var(--color-border);padding-bottom:14px}button,select{font:inherit;background:transparent;color:inherit;border:1px solid var(--color-border);border-radius:999px;padding:9px 17px;cursor:pointer}.tabs button[aria-current]{color:var(--color-primary);border-color:var(--color-primary);background:var(--color-background-light)}button:disabled{opacity:.45;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid var(--color-primary);outline-offset:3px}.filters{font-size:13px}.section-heading{display:flex;justify-content:space-between;align-items:center;margin-top:32px}.section-heading h2{font-size:21px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:28px 24px;margin:18px 0}.music-card{display:flex;flex-direction:column;text-align:left;gap:10px;min-width:0;border:0;border-radius:10px;padding:0;background:none}.card-cover{width:100%;aspect-ratio:1;border-radius:10px;transition:transform .25s}.artist-card .card-cover{border-radius:50%}.music-card:hover .card-cover{transform:translateY(-4px)}.music-card strong{font-size:14px;line-height:1.6}.music-card>span{font-size:12px;color:var(--color-text-secondary)}.status{padding:50px 0;text-align:center;color:var(--color-text-secondary)}.error{padding:14px;border:1px solid var(--color-border);border-radius:12px}.load-more{display:block;margin:30px auto}.loading-spinner{display:inline-block;margin-right:8px}@media(prefers-reduced-motion:reduce){.card-cover{transition:none}}@media(max-width:650px){.library-page{padding:24px 20px 60px}.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 14px}}
</style>
