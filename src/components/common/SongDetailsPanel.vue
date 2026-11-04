<template>
  <Teleport to="body"><Transition name="song-panel" @before-leave="$event.setAttribute('inert', '')" @after-leave="restoreFocus">
    <div v-if="visible" class="song-panel-backdrop" @click.self="$emit('close')" @keydown.esc.stop.prevent="$emit('close')" @keydown.tab="trapFocus">
      <section ref="panel" class="song-panel-body" role="dialog" aria-modal="true" aria-labelledby="song-details-heading" tabindex="-1">
        <header><div><p class="eyebrow">BEHIND THE MUSIC</p><h2 id="song-details-heading">{{ title || song?.name || song?.songname || song?.filename || '音乐详情' }}</h2></div><button ref="closeButton" class="close-btn" type="button" aria-label="关闭详情" @click="$emit('close')">×</button></header>
        <nav class="panel-tabs" aria-label="详情分类"><button type="button" :aria-current="tab === 'comments' ? 'page' : undefined" @click="selectTab('comments')">评论{{ commentCount != null ? ` · ${commentCount}` : '' }}</button><button v-if="resolvedResource?.type === 'song'" type="button" :aria-current="tab === 'versions' ? 'page' : undefined" @click="selectTab('versions')">其他版本</button></nav>
        <p v-if="resolving" class="panel-status" role="status"><span class="loading-spinner"></span>正在读取歌曲信息…</p>
        <p v-if="resolveError" class="panel-error" role="alert">{{ resolveError }} <button type="button" @click="initialize">重试</button></p>
        <template v-if="resolvedResource && tab === 'comments'">
          <div class="comment-filters" aria-label="评论筛选"><button type="button" :aria-pressed="filter.type_id == null && !filter.hot_word" @click="selectFilter({})">全部评论</button><button v-for="category in categories" :key="category.id" type="button" :aria-pressed="filter.type_id === category.id" @click="selectFilter({ type_id: category.id })">{{ category.name }}</button><button v-for="word in hotWords" :key="word" type="button" :aria-pressed="filter.hot_word === word" @click="selectFilter({ hot_word: word })"># {{ word }}</button></div>
          <p class="panel-hint">看看大家听到了什么 · 评论只读</p>
          <p v-if="comments.error" class="panel-error" role="alert">{{ comments.error }} <button type="button" :disabled="comments.loading" @click="loadComments(comments.page > 0)">重试</button></p>
          <p v-if="comments.loading && !comments.items.length" class="panel-status" role="status">正在加载评论…</p>
          <p v-else-if="comments.loaded && !comments.items.length" class="panel-status">这个分类还没有评论。</p>
          <article v-for="(comment, index) in comments.items" :key="commentKey(comment, index)" class="comment">
            <div class="comment-heading"><strong>{{ author(comment) }}</strong><span>{{ commentDate(comment) }}</span></div><p class="comment-content">{{ content(comment) }}</p>
            <button v-if="canReadReplies(comment)" type="button" class="reply-toggle" :aria-expanded="expandedReply === commentKey(comment, index)" @click="toggleReplies(comment, index)">查看回复{{ replyCount(comment) ? ` · ${replyCount(comment)}` : '' }}</button>
            <div v-if="expandedReply === commentKey(comment, index)" class="replies">
              <p v-if="replyState.error" role="alert">{{ replyState.error }} <button type="button" :disabled="replyState.loading" @click="loadReplies(comment, index, replyState.page > 0)">重试</button></p>
              <p v-if="replyState.loading && !replyState.items.length" role="status">正在读取回复…</p><p v-else-if="replyState.loaded && !replyState.items.length">还没有回复。</p>
              <div v-for="(reply, replyIndex) in replyState.items" :key="commentKey(reply, replyIndex)" class="reply"><strong>{{ author(reply) }}</strong><p class="comment-content">{{ content(reply) }}</p></div>
              <button v-if="replyState.more && replyState.loaded" type="button" :disabled="replyState.loading" @click="loadReplies(comment, index, true)">{{ replyState.loading ? '加载中…' : '更多回复' }}</button>
            </div>
          </article>
          <button v-if="comments.loaded && comments.more" type="button" class="load-more" :disabled="comments.loading" @click="loadComments(true)">{{ comments.loading ? '加载中…' : '更多评论' }}</button>
        </template>
        <template v-else-if="resolvedResource && tab === 'versions'">
          <p class="panel-hint">由音乐服务提供的翻唱、现场及其他发行版本。</p><p v-if="versions.error" class="panel-error" role="alert">{{ versions.error }} <button type="button" :disabled="versions.loading" @click="loadVersions(versions.page > 0)">重试</button></p>
          <p v-if="versions.loading && !versions.items.length" class="panel-status" role="status">正在查找其他版本…</p><p v-else-if="versions.loaded && !versions.items.length" class="panel-status">暂时没有其他版本。</p>
          <LibrarySongs :songs="versions.items" :current-song="currentSong" :show-toolbar="false" v-on="songEvents" />
          <button v-if="versions.loaded && versions.more" type="button" class="load-more" :disabled="versions.loading" @click="loadVersions(true)">{{ versions.loading ? '加载中…' : '更多版本' }}</button>
        </template>
      </section>
    </div>
  </Transition></Teleport>
</template>

<script>
import LibrarySongs from './LibrarySongs.vue'
import { getComments, getCommentReplies, getCommentCount, getAudioRelated } from '../../api/library.js'
import { getSongDetail } from '../../api/music.js'
import { extractLibraryList, findLibraryList, normalizeLibrarySong } from '../../utils/libraryMetadata.js'
import { createLibraryPageState, appendLibraryPage, flattenLibraryOptions } from '../../views/logic/libraryPage.js'
import { logger } from '../../utils/logger.js'

export default {
  name: 'SongDetailsPanel', components: { LibrarySongs },
  props: { song: { type: Object, default: null }, visible: Boolean, currentSong: { type: Object, default: null }, resource: { type: Object, default: null }, title: { type: String, default: '' } },
  emits: ['close', 'play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details'],
  data() { return { tab: 'comments', resolvedResource: null, resolving: false, resolveError: '', commentCount: null, categories: [], hotWords: [], filter: {}, commentPages: {}, versions: createLibraryPageState(), replyPages: {}, expandedReply: '', generation: 0, controller: null, commentController: null, replyController: null, versionController: null, returnFocus: null, disposed: false } },
  computed: {
    resourceKey() { return JSON.stringify(this.resource || [this.song?.hash, this.song?.album_audio_id, this.song?.sourceUserId]) },
    filterKey() { return JSON.stringify(this.filter) },
    comments() { return this.commentPages[this.filterKey] || createLibraryPageState() },
    replyState() { return this.replyPages[this.expandedReply] || createLibraryPageState() },
    songEvents() { return Object.fromEntries(this.$options.emits.filter(event => event !== 'close').map(event => [event, (...args) => this.$emit(event, ...args)])) }
  },
  watch: {
    visible: { immediate: true, handler(value) { if (value) { this.returnFocus = typeof document === 'undefined' ? null : document.activeElement; this.$nextTick(() => this.$refs.closeButton?.focus()); this.initialize() } else { this.cancelRequests(); this.restoreFocus() } } },
    resourceKey() { if (this.visible) this.initialize() }
  },
  beforeUnmount() { this.disposed = true; this.cancelRequests(); this.restoreFocus() },
  methods: {
    cancelRequests() { this.generation++; this.controller?.abort(); this.commentController?.abort(); this.replyController?.abort(); this.versionController?.abort() },
    /** Resolve a catalog song only when its comment identifier is absent; cloud identifiers never imply catalog IDs. */
    async initialize() {
      this.cancelRequests(); const generation = this.generation
      this.resolvedResource = null; this.resolveError = ''; this.resolving = true; this.tab = 'comments'; this.commentCount = null
      this.categories = []; this.hotWords = []; this.filter = {}; this.commentPages = {}; this.versions = createLibraryPageState(); this.replyPages = {}; this.expandedReply = ''
      const controller = this.controller = new AbortController()
      try {
        let resource = this.resource ? { ...this.resource } : { type: 'song', hash: this.song?.hash || this.song?.FileHash, mixsongid: this.song?.album_audio_id || this.song?.mixsongid }
        if (resource.type === 'song' && !resource.mixsongid) {
          if (!resource.hash || this.song?.source === 'cloud') throw new Error('这首歌曲尚无可查询的评论信息。')
          const response = await getSongDetail(resource.hash, { signal: controller.signal })
          if (this.disposed || generation !== this.generation || !this.visible) return
          const detail = extractLibraryList(response)[0] || response?.data
          resource.mixsongid = detail?.album_audio_id || detail?.mixsongid
          if (!resource.mixsongid) throw new Error('未找到这首歌曲的评论信息。')
        }
        if (this.disposed || generation !== this.generation || !this.visible) return
        this.resolvedResource = resource
        this.loadComments()
        getCommentCount(resource, { signal: controller.signal }).then(response => {
          if (generation !== this.generation || this.disposed) return
          const data = response?.data || response
          const value = Number(data?.count ?? data?.total ?? data?.comment_count ?? data?.[0]?.count)
          if (Number.isFinite(value) && value >= 0) this.commentCount = value
        }).catch(error => { if (!controller.signal.aborted) logger.warn('SongDetailsPanel', '读取评论数失败', { name: error?.name }) })
      } catch (error) { if (generation === this.generation && !this.disposed && !controller.signal.aborted) { this.resolveError = error?.message || '读取详情失败，请重试。'; logger.error('SongDetailsPanel', '解析详情资源失败', error) } }
      finally { if (generation === this.generation && !this.disposed) this.resolving = false }
    },
    selectTab(tab) { this.tab = tab; if (tab === 'versions' && !this.versions.loaded) this.loadVersions() },
    selectFilter(filter) { this.commentController?.abort(); this.replyController?.abort(); this.comments.loading = false; this.replyState.loading = false; this.filter = filter; this.expandedReply = ''; if (!this.comments.loaded) this.loadComments() },
    async loadComments(append = false) {
      if (!this.resolvedResource || this.disposed || !this.visible) return
      const key = this.filterKey
      if (!this.commentPages[key]) this.commentPages[key] = createLibraryPageState()
      const state = this.commentPages[key]
      if (state.loading) return
      const generation = this.generation; this.commentController?.abort(); const controller = this.commentController = new AbortController()
      state.loading = true; state.error = ''; state.requestController = controller
      try {
        const response = await getComments(this.resolvedResource, { ...this.filter, page: append ? state.page + 1 : 1, pagesize: 30 }, { signal: controller.signal })
        if (generation !== this.generation || this.disposed || controller.signal.aborted) return
        const items = findLibraryList(response)
        if (!items) throw new Error('评论格式暂不可读取，请重试。')
        appendLibraryPage(state, items, response, { append })
        if (this.filter.type_id == null && !this.filter.hot_word) {
          const data = response?.data || response
          if (data?.special_id || data?.specialid) this.resolvedResource.special_id = data.special_id || data.specialid
          this.categories = flattenLibraryOptions(data?.classify_list || data?.classify || data?.cmt_classify || [])
          this.hotWords = (data?.hotword_list || data?.hot_word_list || data?.hotwords || []).map(item => typeof item === 'string' ? item : item.hot_word || item.word || item.content || item.name).filter(Boolean)
          if (state.total !== null) this.commentCount = state.total
        }
      } catch (error) { if (generation === this.generation && !this.disposed && !controller.signal.aborted) { state.error = error?.message || '评论加载失败，请重试。'; logger.error('SongDetailsPanel', '读取评论失败', error) } }
      finally { if (state.requestController === controller) state.loading = false }
    },
    toggleReplies(comment, index) { const key = this.commentKey(comment, index); this.replyController?.abort(); this.replyState.loading = false; this.expandedReply = this.expandedReply === key ? '' : key; if (this.expandedReply && !this.replyState.loaded) this.loadReplies(comment, index) },
    async loadReplies(comment, index, append = false) {
      const key = this.commentKey(comment, index)
      if (!this.replyPages[key]) this.replyPages[key] = createLibraryPageState()
      const state = this.replyPages[key]
      if (state.loading || !this.visible) return
      const generation = this.generation; this.replyController?.abort(); const controller = this.replyController = new AbortController(); state.loading = true; state.error = ''; state.requestController = controller
      try {
        const response = await getCommentReplies(this.resolvedResource, { ...comment, tid: comment.tid || comment.id || comment.comment_id }, { page: append ? state.page + 1 : 1, pagesize: 30 }, { signal: controller.signal })
        if (generation !== this.generation || this.disposed || controller.signal.aborted) return
        const items = findLibraryList(response)
        if (!items) throw new Error('回复格式暂不可读取，请重试。')
        appendLibraryPage(state, items, response, { append })
      } catch (error) { if (generation === this.generation && !this.disposed && !controller.signal.aborted) { state.error = error?.message || '回复加载失败，请重试。'; logger.error('SongDetailsPanel', '读取评论回复失败', error) } }
      finally { if (state.requestController === controller) state.loading = false }
    },
    async loadVersions(append = false) {
      const state = this.versions; if (state.loading || !this.resolvedResource?.mixsongid || !this.visible) return
      const generation = this.generation; const controller = this.versionController = new AbortController(); state.loading = true; state.error = ''
      try {
        const response = await getAudioRelated(this.resolvedResource.mixsongid, { page: append ? state.page + 1 : 1, pagesize: 30 }, { signal: controller.signal })
        if (generation !== this.generation || this.disposed || controller.signal.aborted) return
        const items = findLibraryList(response)
        if (!items) throw new Error('版本格式暂不可读取，请重试。')
        appendLibraryPage(state, items.map(item => normalizeLibrarySong(item)), response, { append })
      } catch (error) { if (generation === this.generation && !this.disposed && !controller.signal.aborted) { state.error = error?.message || '版本加载失败，请重试。'; logger.error('SongDetailsPanel', '读取其他版本失败', error) } }
      finally { state.loading = false }
    },
    commentKey(comment, index) { return String(comment.tid || comment.id || comment.comment_id || `comment-${index}`) },
    canReadReplies(comment) { return this.resolvedResource?.type === 'song' && !!(comment.tid || comment.id || comment.comment_id) && !!(comment.special_id || comment.special_child_id || comment.childrenid || this.resolvedResource.special_id) },
    author(comment) { return comment.user_name || comment.username || comment.nickname || comment.user?.nickname || comment.userinfo?.nickname || '音乐听众' },
    content(comment) { const value = comment.content ?? comment.comment ?? comment.text ?? ''; return typeof value === 'string' ? value : '' },
    replyCount(comment) { return comment.reply_count || comment.reply_num || comment.children_count || 0 },
    commentDate(comment) { const value = comment.addtime || comment.create_time || comment.time; if (!value) return ''; if (typeof value === 'string' && !/^\d+$/.test(value)) return value; const number = Number(value); const date = new Date(number < 1e12 ? number * 1000 : number); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString() },
    restoreFocus() { if (!this.visible && this.returnFocus?.isConnected) { this.returnFocus.focus(); this.returnFocus = null } },
    trapFocus(event) {
      const elements = [...(this.$refs.panel?.querySelectorAll('button:not(:disabled), [href], input, select, [tabindex="0"]') || [])].filter(element => element.getClientRects().length)
      if (!elements.length) { event.preventDefault(); this.$refs.panel?.focus(); return }
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1).focus() }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus() }
    }
  }
}
</script>

<style scoped>
.song-panel-backdrop{position:fixed;inset:0;z-index:12000;background:#0006;display:flex;justify-content:flex-end}.song-panel-body{width:min(760px,94vw);height:100%;overflow:auto;background:var(--color-background);color:var(--color-text);padding:28px clamp(20px,4vw,42px);box-shadow:-12px 0 48px #0002}.song-panel-body>header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.eyebrow{font-size:10px;letter-spacing:.16em;color:var(--color-text-secondary)}h2{font-size:26px;line-height:1.4;margin:10px 0 26px;overflow-wrap:anywhere}button{font:inherit;border:1px solid var(--color-border);border-radius:999px;padding:7px 13px;color:inherit;background:transparent;cursor:pointer}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:2px solid var(--color-primary);outline-offset:3px}.close-btn{font-size:26px;padding:0;width:36px;height:36px;flex-shrink:0}.panel-tabs,.comment-filters{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.panel-tabs{padding-bottom:16px;border-bottom:1px solid var(--color-border)}.panel-tabs [aria-current],.comment-filters [aria-pressed=true]{border-color:var(--color-primary);color:var(--color-primary)}.comment-filters{font-size:12px}.panel-hint,.panel-status{font-size:13px;color:var(--color-text-secondary);line-height:1.8}.panel-status{padding:40px 0;text-align:center}.panel-error{padding:14px;background:var(--color-background-light);border-radius:12px;font-size:13px}.comment{border-bottom:1px solid var(--color-border);padding:22px 0}.comment-heading{display:flex;gap:10px;justify-content:space-between;font-size:13px}.comment-heading>span{color:var(--color-text-secondary);font-size:11px}.comment-content{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.9}.reply-toggle{font-size:11px;color:var(--color-text-secondary);padding:5px 10px}.replies{padding:12px 16px;margin:12px 0 0;background:var(--color-background-light);border-radius:12px;font-size:12px}.reply{border-bottom:1px solid var(--color-border);padding:12px 0}.reply:last-child{border:0}.reply .comment-content{font-size:13px}.load-more{display:block;margin:26px auto}.song-panel-enter-active,.song-panel-leave-active{transition:opacity .22s}.song-panel-enter-active .song-panel-body,.song-panel-leave-active .song-panel-body{transition:transform .26s ease}.song-panel-enter-from,.song-panel-leave-to{opacity:0}.song-panel-enter-from .song-panel-body,.song-panel-leave-to .song-panel-body{transform:translateX(100%)}@media(prefers-reduced-motion:reduce){.song-panel-enter-active,.song-panel-leave-active,.song-panel-enter-active .song-panel-body,.song-panel-leave-active .song-panel-body{transition:none}}
</style>
