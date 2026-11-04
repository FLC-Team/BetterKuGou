<template>
  <Teleport to="body"><Transition name="song-panel" appear @before-enter="$event.removeAttribute('inert')" @before-leave="$event.setAttribute('inert', '')" @leave-cancelled="$event.removeAttribute('inert')" @after-leave="finishClose">
    <div v-if="visible" class="song-panel-backdrop" @click.self="$emit('close')" @keydown.esc.stop.prevent="$emit('close')" @keydown.tab="trapFocus">
      <section ref="panel" class="song-panel-body" role="dialog" aria-modal="true" aria-labelledby="song-details-heading" tabindex="-1">
        <header class="panel-header"><div class="panel-resource"><ArtworkCover :src="song?.cover || song?.sizable_cover || song?.imgurl || resource?.cover || ''" class="panel-cover" /><div class="panel-resource-copy"><p class="eyebrow">BEHIND THE MUSIC</p><h2 id="song-details-heading">{{ heading }}</h2><p class="resource-caption">{{ subtitle }}</p></div></div><button ref="closeButton" class="close-btn" type="button" aria-label="关闭详情" @click="$emit('close')"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></header>
        <nav class="panel-tabs" aria-label="详情分类"><button type="button" :aria-current="tab === 'comments' ? 'page' : undefined" @click="selectTab('comments')">评论{{ commentCount != null ? ` · ${commentCount}` : '' }}</button><button v-if="resolvedResource?.type === 'song'" type="button" :aria-current="tab === 'versions' ? 'page' : undefined" @click="selectTab('versions')">其他版本</button></nav>
        <p v-if="resolving" class="panel-status" role="status"><span class="loading-spinner"></span>正在读取歌曲信息…</p>
        <AppNotice :message="resolveError" type="error" title="歌曲详情" :actions="[{ label: '重试', run: initialize }]" />
        <Transition name="panel-content" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
        <section v-if="resolvedResource && tab === 'comments'" key="comments" class="panel-section" aria-label="音乐评论" :aria-busy="comments.loading">
          <div class="comment-section-heading"><div><p class="eyebrow">LISTENERS' NOTES</p><h3>在音乐里相遇</h3></div><span class="read-only-label">评论只读</span></div>
          <div class="comment-filters" aria-label="评论筛选"><button type="button" :aria-pressed="filter.type_id == null && !filter.hot_word" @click="selectFilter({})">全部评论</button><button v-for="category in categories" :key="category.id" type="button" :aria-pressed="filter.type_id === category.id" @click="selectFilter({ type_id: category.id })">{{ category.name }}</button></div>
          <div v-if="hotWords.length" class="comment-hotwords" aria-label="评论热词"><span>大家在聊</span><button v-for="word in hotWords" :key="word" type="button" :aria-pressed="filter.hot_word === word" @click="selectFilter({ hot_word: word })"># {{ word }}</button></div>
          <AppNotice :message="comments.error" type="error" title="评论" :actions="[{ label: '重试', run: () => loadComments(comments.page > 0), disabled: comments.loading }]" />
          <div v-if="comments.loading && !comments.items.length" class="comment-loading" role="status" aria-label="正在加载评论"><div v-for="index in 3" :key="index" class="comment-skeleton" aria-hidden="true"><span></span><div><i></i><i></i><i></i></div></div><span class="visually-hidden">正在加载评论…</span></div>
          <div v-else-if="comments.loaded && !comments.items.length" class="panel-empty"><span class="empty-note" aria-hidden="true">“</span><h4>这里，还在等待共鸣</h4><p>这个分类还没有评论，试试其他分类或热词。</p></div>
          <TransitionGroup name="comment-list" tag="div" class="comments-list" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
          <article v-for="(comment, index) in comments.items" :key="commentKey(comment, index)" class="comment">
            <div class="comment-heading"><span class="comment-avatar" aria-hidden="true">{{ authorInitial(comment) }}</span><div class="comment-byline"><strong>{{ author(comment) }}</strong><time v-if="commentDate(comment)">{{ commentDate(comment) }}</time></div></div><div class="comment-copy"><p class="comment-content">{{ content(comment) }}</p>
            <button v-if="canReadReplies(comment)" type="button" class="reply-toggle" :aria-expanded="expandedReply === commentKey(comment, index)" @click="toggleReplies(comment, index)">{{ expandedReply === commentKey(comment, index) ? '收起回复' : '查看回复' }}{{ replyCount(comment) ? ` · ${replyCount(comment)}` : '' }}<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
            <Transition name="reply-stack" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><div v-if="expandedReply === commentKey(comment, index)" class="replies">
              <AppNotice :message="replyState.error" type="error" title="评论回复" :actions="[{ label: '重试', run: () => loadReplies(comment, index, replyState.page > 0), disabled: replyState.loading }]" />
              <p v-if="replyState.loading && !replyState.items.length" class="reply-status" role="status"><span class="loading-spinner inline-spinner"></span>正在读取回复…</p><p v-else-if="replyState.loaded && !replyState.items.length" class="reply-status">还没有回复。</p>
              <div v-for="(reply, replyIndex) in replyState.items" :key="commentKey(reply, replyIndex)" class="reply"><div class="reply-heading"><strong>{{ author(reply) }}</strong><time v-if="commentDate(reply)">{{ commentDate(reply) }}</time></div><p class="comment-content">{{ content(reply) }}</p></div>
              <button v-if="replyState.more && replyState.loaded" type="button" :disabled="replyState.loading" @click="loadReplies(comment, index, true)">{{ replyState.loading ? '加载中…' : '更多回复' }}</button>
            </div></Transition></div>
          </article>
          </TransitionGroup>
          <button v-if="comments.loaded && comments.more" type="button" class="load-more" :disabled="comments.loading" @click="loadComments(true)">{{ comments.loading ? '加载中…' : '更多评论' }}</button>
          <p v-else-if="comments.loaded && comments.items.length" class="list-end">已读完这个分类的评论</p>
        </section>
        <section v-else-if="resolvedResource && tab === 'versions'" key="versions" class="panel-section" aria-label="其他歌曲版本" :aria-busy="versions.loading">
          <p class="panel-hint">由音乐服务提供的翻唱、现场及其他发行版本。</p><AppNotice :message="versions.error" type="error" title="其他版本" :actions="[{ label: '重试', run: () => loadVersions(versions.page > 0), disabled: versions.loading }]" />
          <p v-if="versions.loading && !versions.items.length" class="panel-status" role="status">正在查找其他版本…</p><p v-else-if="versions.loaded && !versions.items.length" class="panel-status">暂时没有其他版本。</p>
          <LibrarySongs :songs="versions.items" :current-song="currentSong" :show-toolbar="false" v-on="songEvents" />
          <button v-if="versions.loaded && versions.more" type="button" class="load-more" :disabled="versions.loading" @click="loadVersions(true)">{{ versions.loading ? '加载中…' : '更多版本' }}</button>
        </section>
        </Transition>
      </section>
    </div>
  </Transition></Teleport>
</template>

<script>
import LibrarySongs from './LibrarySongs.vue'
import ArtworkCover from './ArtworkCover.vue'
import { getSongSearchKeyword, getSongArtists } from '../../utils/songMetadata.js'
import { getComments, getCommentReplies, getCommentCount, getAudioRelated } from '../../api/library.js'
import { getSongDetail } from '../../api/music.js'
import { extractLibraryList, findLibraryList, normalizeLibrarySong } from '../../utils/libraryMetadata.js'
import { createLibraryPageState, appendLibraryPage, flattenLibraryOptions } from '../../views/logic/libraryPage.js'
import { logger } from '../../utils/logger.js'

export default {
  name: 'SongDetailsPanel', components: { LibrarySongs, ArtworkCover },
  props: { song: { type: Object, default: null }, visible: Boolean, currentSong: { type: Object, default: null }, resource: { type: Object, default: null }, title: { type: String, default: '' } },
  emits: ['close', 'closed', 'play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details'],
  data() { return { tab: 'comments', resolvedResource: null, resolving: false, resolveError: '', commentCount: null, categories: [], hotWords: [], filter: {}, commentPages: {}, versions: createLibraryPageState(), replyPages: {}, expandedReply: '', generation: 0, controller: null, commentController: null, replyController: null, versionController: null, returnFocus: null, disposed: false } },
  computed: {
    heading() { return this.title || getSongSearchKeyword(this.song) || this.resource?.name || '音乐详情' },
    subtitle() { return getSongArtists(this.song).map(artist => artist.name).join('、') || (this.resource?.type === 'album' ? '专辑里的声音与故事' : this.resource?.type === 'playlist' ? '一张歌单，不同的共鸣' : '看看大家听到了什么') },
    resourceKey() { return JSON.stringify(this.resource || [this.song?.hash, this.song?.album_audio_id, this.song?.sourceUserId]) },
    filterKey() { return JSON.stringify(this.filter) },
    comments() { return this.commentPages[this.filterKey] || createLibraryPageState() },
    replyState() { return this.replyPages[this.expandedReply] || createLibraryPageState() },
    songEvents() { return Object.fromEntries(this.$options.emits.filter(event => !['close', 'closed'].includes(event)).map(event => [event, (...args) => this.$emit(event, ...args)])) }
  },
  watch: {
    visible: { immediate: true, handler(value) {
      if (value) {
        const active = typeof document === 'undefined' ? null : document.activeElement
        if (!this.returnFocus?.isConnected || (active && active !== document.body && !this.$refs.panel?.contains(active))) this.returnFocus = active
        this.$nextTick(() => { if (this.visible && !this.disposed) this.$refs.closeButton?.focus({ preventScroll: true }) })
        this.initialize()
      } else this.cancelRequests()
    } },
    resourceKey() { if (this.visible) this.initialize() }
  },
  beforeUnmount() { this.disposed = true; this.cancelRequests(); this.restoreFocus(true) },
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
    authorInitial(comment) { return Array.from(String(this.author(comment)).trim())[0] || '♪' },
    content(comment) { const value = comment.content ?? comment.comment ?? comment.text ?? ''; return typeof value === 'string' ? value : '' },
    replyCount(comment) { return comment.reply_count || comment.reply_num || comment.children_count || 0 },
    commentDate(comment) { const value = comment.addtime || comment.create_time || comment.time; if (!value) return ''; if (typeof value === 'string' && !/^\d+$/.test(value)) return value; const number = Number(value); const date = new Date(number < 1e12 ? number * 1000 : number); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString() },
    /** Restore only while this surface owns focus; a newly opened dialog or navigation must keep its focus. */
    restoreFocus(force = false) {
      if (this.visible && !force) return
      const target = this.returnFocus
      this.returnFocus = null
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (target?.isConnected && !target.closest?.('[inert], [hidden]') && (!active || active === document.body || this.$refs.panel?.contains(active))) target.focus({ preventScroll: true })
    },
    finishClose() { if (!this.visible) { this.restoreFocus(); this.$emit('closed') } },
    trapFocus(event) {
      const elements = [...(this.$refs.panel?.querySelectorAll('button:not(:disabled), [href], input, select, [tabindex="0"]') || [])].filter(element => element.getClientRects().length)
      if (!elements.length) { event.preventDefault(); this.$refs.panel?.focus(); return }
      if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === this.$refs.panel)) { event.preventDefault(); elements.at(-1).focus() }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus() }
    }
  }
}
</script>

<style src="./SongDetailsPanel.css" scoped></style>
