<template>
  <div class="discover-view library-page" :aria-busy="page.loading">
    <header><p class="eyebrow">DISCOVER / 音乐发现</p><h1>下一段喜欢的声音<span>.</span></h1><p>从一张歌单、一首新歌，开始今天的聆听。</p></header>
    <nav class="tabs" aria-label="发现分类"><button v-for="tab in tabs" :key="tab.id" type="button" :aria-current="activeTab === tab.id ? 'page' : undefined" @click="selectTab(tab.id)">{{ tab.label }}</button></nav>
    <div v-if="activeTab === 'playlists'" class="filters"><label for="discover-category">歌单分类</label><select id="discover-category" v-model="category" @change="selectCategory"><option value="0">为你推荐</option><option v-for="tag in categories" :key="tag.id" :value="String(tag.id)">{{ tag.name }}</option></select><span v-if="tagsLoading">正在读取分类…</span><AppNotice :message="tagsError" title="歌单分类" type="error" :actions="[{ label: '重试', run: loadCategories, disabled: tagsLoading }]" /></div>
    <div v-if="activeTab === 'albums'" class="filters"><label for="discover-album-region">新碟地区</label><select id="discover-album-region" v-model="albumRegion" @change="selectCategory"><option value="chn">华语</option><option value="eur">欧美</option><option value="jpn">日本</option><option value="kor">韩国</option></select></div>
    <div class="section-heading"><h2>{{ tabs.find(tab => tab.id === activeTab)?.label }}</h2><button type="button" :disabled="page.loading" @click="loadPage(false, true)">{{ page.loading ? '正在更新…' : '刷新' }}</button></div>
    <AppNotice :message="page.error" title="音乐加载失败" type="error" :actions="[{ label: '重试', run: () => loadPage(page.requestAppend, true), disabled: page.loading }]" />
    <p v-if="page.loading && !page.items.length" class="status" role="status"><span class="loading-spinner"></span>正在寻找音乐…</p>
    <p v-else-if="page.loaded && !page.items.length" class="status">这个分类还没有内容，换一个分类看看。</p>
    <LibrarySongs v-if="activeTab === 'songs'" :songs="page.items" :current-song="currentSong" :total="page.total" v-on="songEvents" />
    <div v-else class="cards"><button v-for="(item, index) in page.items" :key="`${item.globalCollectionId || item.album_id || item.id}-${index}`" type="button" class="music-card" @click="openCard(item)"><ArtworkCover :src="cover(item)" class="card-cover" /><strong>{{ cardName(item) }}</strong><span>{{ item.description || item.intro || item.author_name || item.publish_date || '打开，听听看' }}</span></button></div>
    <button v-if="page.loaded && page.more" type="button" class="load-more" :disabled="page.loading" @click="loadPage(true)">{{ page.loading ? '正在加载…' : '加载更多' }}</button>
  </div>
</template>

<script>
import ArtworkCover from '../components/common/ArtworkCover.vue'
import LibrarySongs from '../components/common/LibrarySongs.vue'
import { getPlaylistTags, getDiscoverPlaylists, getNewSongs, getNewAlbums } from '../api/library.js'
import { findLibraryList, normalizeLibrarySong, normalizePlaylistResource } from '../utils/libraryMetadata.js'
import { createLibraryPageState, appendLibraryPage, flattenLibraryOptions } from './logic/libraryPage.js'
import { logger } from '../utils/logger.js'

export default {
  name: 'DiscoverView', components: { ArtworkCover, LibrarySongs },
  props: { currentSong: { type: Object, default: null } },
  emits: ['play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details'],
  data() { return { activeTab: 'playlists', category: '0', albumRegion: 'chn', categories: [], tagsLoading: false, tagsError: '', pages: {}, generation: 0, controller: null, activeRequestKey: '', tagsController: null, disposed: false,
    tabs: [{ id: 'playlists', label: '歌单广场' }, { id: 'songs', label: '新歌速递' }, { id: 'albums', label: '新碟上架' }] } },
  computed: {
    resourceKey() { return `${this.activeTab}:${this.activeTab === 'albums' ? this.albumRegion : this.category}` },
    page() { return this.pages[this.resourceKey] || createLibraryPageState() },
    songEvents() { return Object.fromEntries(this.$options.emits.map(event => [event, (...args) => this.$emit(event, ...args)])) }
  },
  mounted() { this.loadCategories(); this.loadPage() },
  beforeUnmount() { this.disposed = true; this.generation++; this.controller?.abort(); this.tagsController?.abort() },
  methods: {
    async loadCategories() {
      if (this.tagsLoading || this.disposed) return
      this.tagsLoading = true; this.tagsError = ''; this.tagsController = new AbortController()
      try { const result = await getPlaylistTags({}, { signal: this.tagsController.signal }); if (!this.disposed) this.categories = flattenLibraryOptions(result).filter(item => String(item.id) !== '0') }
      catch (error) { if (!this.disposed) { this.tagsError = '无法读取分类'; logger.error('DiscoverView', '读取歌单分类失败', error) } }
      finally { if (!this.disposed) this.tagsLoading = false }
    },
    cancelPageRequest() { this.controller?.abort(); this.generation++; if (this.pages[this.activeRequestKey]) this.pages[this.activeRequestKey].loading = false },
    selectTab(id) { if (this.activeTab === id) return; this.cancelPageRequest(); this.activeTab = id; this.loadPage() },
    selectCategory() { this.cancelPageRequest(); this.loadPage() },
    /** Each category retains its pages; only the active generation may commit a response. */
    async loadPage(append = false, force = false) {
      const key = this.resourceKey
      if (!this.pages[key]) this.pages[key] = createLibraryPageState()
      const state = this.pages[key]
      if (state.loading || (!append && state.loaded && !force) || this.disposed) return
      const generation = ++this.generation
      this.controller?.abort(); const controller = this.controller = new AbortController()
      this.activeRequestKey = key
      const tab = this.activeTab; state.loading = true; state.error = ''; state.requestAppend = append
      try {
        const fetch = tab === 'playlists' ? getDiscoverPlaylists : tab === 'songs' ? getNewSongs : getNewAlbums
        const response = await fetch({ page: append ? state.page + 1 : 1, pagesize: 30, category_id: this.category }, { signal: controller.signal })
        if (this.disposed || generation !== this.generation) return
        const raw = findLibraryList(response, tab === 'albums' ? [this.albumRegion] : tab === 'playlists' ? ['special_recommend.special_list', 'special_recommend.list'] : [])
        if (!raw) throw new Error('内容格式暂不可读取，请重试。')
        const items = tab === 'songs' ? raw.map(item => normalizeLibrarySong(item)) : tab === 'playlists' ? raw.map(item => normalizePlaylistResource(item)) : raw
        appendLibraryPage(state, items, response, { append })
      } catch (error) { if (!this.disposed && generation === this.generation && !controller.signal.aborted) { state.error = error?.message || '加载失败，请重试。'; logger.error('DiscoverView', '读取发现内容失败', { tab, page: state.page + 1, error }) } }
      finally { if (this.controller === controller) state.loading = false }
    },
    cover(item) { return item.cover || item.sizable_cover || item.imgurl || item.pic || '' },
    cardName(item) { return item.name || item.specialname || item.special_name || item.album_name || item.albumname || '未命名' },
    openCard(item) {
      if (this.activeTab === 'playlists') {
        if (!item.globalCollectionId && !item.id) { this.page.error = '这个歌单尚未提供可用的公开标识，请选择其他歌单。'; return }
        this.$emit('navigate', 'playlist', item)
      }
      else { const id = item.album_id ?? item.albumid ?? item.id; if (id != null) this.$emit('navigate', 'album', { id, name: this.cardName(item) }) }
    }
  }
}
</script>

<style scoped>
.library-page{padding:40px clamp(24px,5vw,76px) 70px;overflow:auto;color:var(--color-text)}header{max-width:760px;margin-bottom:32px}.eyebrow{font-size:11px;letter-spacing:.16em;color:var(--color-text-secondary)}h1{font-size:clamp(27px,3.2vw,46px);letter-spacing:-.04em;margin:12px 0 18px}h1 span{color:var(--color-primary)}header>p:last-child{color:var(--color-text-secondary);line-height:1.8;font-size:14px}.tabs,.filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:20px 0}.tabs{border-bottom:1px solid var(--color-border);padding-bottom:14px}button,select{font:inherit;background:transparent;color:inherit;border:1px solid var(--color-border);border-radius:999px;padding:9px 17px;cursor:pointer}.tabs button[aria-current]{color:var(--color-primary);border-color:var(--color-primary);background:var(--color-background-light)}button:disabled{opacity:.45;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid var(--color-primary);outline-offset:3px}.filters{font-size:13px}.section-heading{display:flex;justify-content:space-between;align-items:center;margin-top:32px}.section-heading h2{font-size:21px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:28px 24px;margin:18px 0}.music-card{display:flex;flex-direction:column;text-align:left;gap:10px;min-width:0;border:0;border-radius:10px;padding:0;background:none}.card-cover{width:100%;aspect-ratio:1;border-radius:10px;transition:transform .25s}.music-card:hover .card-cover{transform:translateY(-4px)}.music-card strong{font-size:14px;line-height:1.6}.music-card>span{font-size:12px;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.status{padding:50px 0;text-align:center;color:var(--color-text-secondary)}.load-more{display:block;margin:30px auto}.loading-spinner{display:inline-block;margin-right:8px}@media(prefers-reduced-motion:reduce){.card-cover{transition:none}}@media(max-width:650px){.library-page{padding:24px 20px 60px}.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 14px}}
</style>
