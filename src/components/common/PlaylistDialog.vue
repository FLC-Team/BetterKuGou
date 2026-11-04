<template>
  <Teleport to="body">
    <Transition name="ui-pop" appear>
      <div class="playlist-dialog-mask" @click.self="close" @keydown.esc.stop="close">
        <section ref="panel" class="playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-dialog-title" tabindex="-1" @keydown.tab="trapFocus">
          <header><div><p class="eyebrow">YOUR COLLECTION</p><h2 id="playlist-dialog-title">{{ heading }}</h2></div><button type="button" :disabled="busy" aria-label="关闭" @click="close">×</button></header>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <form v-if="mode === 'create'" @submit.prevent="create">
            <label>歌单名称<input ref="nameInput" v-model="name" required maxlength="200" :disabled="busy" autocomplete="off" /></label>
            <label class="privacy"><input v-model="isPrivate" type="checkbox" :disabled="busy" />设为私密歌单</label>
            <button type="submit" class="primary" :disabled="busy || !name.trim()">{{ busy ? '正在创建…' : '新建歌单' }}</button>
          </form>
          <template v-else-if="mode === 'add'">
            <p>将 {{ songs.length }} 首歌曲加入歌单</p>
            <div class="destinations"><button v-for="item in editable" :key="item.listId" type="button" :disabled="busy" @click="add(item)"><span>{{ item.name }}</span><span>＋</span></button></div>
            <p v-if="!editable.length">没有可写入的歌单，请先新建歌单或刷新账号目录。</p>
          </template>
          <template v-else>
            <p>{{ resource?.name || '歌单' }}</p>
            <button v-if="!resource?.listId || resource?.source === 'public'" type="button" class="primary" :disabled="busy" @click="collect">{{ busy ? '正在收藏…' : '收藏到我的歌单' }}</button>
            <template v-else-if="!favoriteProtected">
              <p>此操作会从酷狗账号{{ resource?.isOwned ? '删除这张歌单' : '取消收藏这张歌单' }}，不会删除正在播放的队列或已导出的音乐文件。</p>
              <label class="privacy"><input v-model="confirmed" type="checkbox" :disabled="busy" />我确认{{ resource?.isOwned ? '删除' : '取消收藏' }}</label>
              <button type="button" class="danger" :disabled="busy || !confirmed" @click="remove">{{ busy ? '正在处理…' : resource?.isOwned ? '删除歌单' : '取消收藏歌单' }}</button>
            </template>
            <p v-else>收藏歌单及尚未确认归属的收藏候选不可删除，请在“我喜欢”确认歌单并管理收藏曲目。</p>
          </template>
          <p v-if="busy" class="pending" role="status">正在等待酷狗确认，请稍候…</p>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { createPlaylist, collectPlaylist, deletePlaylist, getAllUserPlaylists, getAllPlaylistTracks, addPlaylistSongs, getPlaylistDetail } from '../../api/library.js'
import { extractLibraryList, normalizePlaylistResource } from '../../utils/libraryMetadata.js'

const props = defineProps({ mode: { type: String, default: 'create' }, songs: { type: Array, default: () => [] },
  playlists: { type: Array, default: () => [] }, resource: { type: Object, default: null } })
const emit = defineEmits(['close', 'changed'])
const library = inject('musicLibrary', null)
const name = ref(''), isPrivate = ref(false), confirmed = ref(false), busy = ref(false), error = ref('')
const panel = ref(null), nameInput = ref(null)
const heading = computed(() => props.mode === 'create' ? '新建歌单' : props.mode === 'add' ? '添加到歌单' : '管理歌单')
const favoriteProtected = computed(() => props.resource?.isFavorite || props.resource?.favoriteCandidate ||
  (props.resource?.listId != null && library?.state?.resource?.listId != null && String(props.resource.listId) === String(library.state.resource.listId)))
const editable = computed(() => props.playlists.filter(item => item.listId != null && (item.isOwned || item.isFavorite)))
const controller = new AbortController()
let disposed = false
let previousFocus = null
let collectedTarget = null
let creationAttempt = null
let collectionAttempt = null
const owner = { userId: localStorage.getItem('kugou_userid'), token: localStorage.getItem('kugou_token') }
onMounted(async () => { previousFocus = document.activeElement; await nextTick(); (nameInput.value || panel.value)?.focus() })
onBeforeUnmount(() => { disposed = true; controller.abort(); if (previousFocus?.isConnected) previousFocus.focus() })
function close() { if (!busy.value) emit('close') }
function trapFocus(event) {
  const nodes = [...panel.value.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
  const first = nodes[0], last = nodes.at(-1)
  if (!first) { event.preventDefault(); panel.value.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
/** 不把请求发出当作完成；失败保留表单和明确反馈供用户重试。 */
async function run(action) {
  if (busy.value) return
  error.value = ''
  if (!library?.canWrite) { error.value = '请登录并连接网络后操作'; return }
  const assertCurrent = () => {
    if (disposed || controller.signal.aborted || owner.userId !== localStorage.getItem('kugou_userid') || owner.token !== localStorage.getItem('kugou_token')) {
      throw new Error('账号已变化，请重新打开歌单管理')
    }
  }
  const request = async callback => { assertCurrent(); const value = await callback(); assertCurrent(); return value }
  busy.value = true
  try { assertCurrent(); const change = await action(request); assertCurrent(); emit('changed', change); emit('close') }
  catch (failure) { if (!disposed) error.value = failure.message || '操作失败，请刷新后重试' }
  finally { if (!disposed) busy.value = false }
}
function create() { return run(async request => {
  const before = await request(() => getAllUserPlaylists({ signal: controller.signal }))
  const title = name.value.trim()
  if (creationAttempt && creationAttempt.name === title) {
    const confirmed = before.filter(item => item.name === title && item.isOwned && !creationAttempt.ids.has(String(item.listId)))
    if (confirmed.length === 1) return
    throw new Error('上次创建结果尚未确认。请刷新账号目录检查，暂不重复创建同名歌单。')
  }
  creationAttempt = { name: title, ids: new Set(before.map(item => String(item.listId))) }
  let failure
  try { await request(() => createPlaylist(title, { isPrivate: isPrivate.value, signal: controller.signal })) }
  catch (error) { failure = error; if (error.code === 'LIBRARY_REQUEST_FAILED' || error.code === 'INVALID_LIBRARY_INPUT') creationAttempt = null }
  const after = await request(() => getAllUserPlaylists({ signal: controller.signal }))
  const created = after.filter(item => item.name === title && item.isOwned &&
    !before.some(old => String(old.listId) === String(item.listId)))
  if (created.length !== 1) throw failure || new Error('暂时无法确认创建结果，请先刷新目录检查，避免重复创建。')
}) }
function add(item) { return run(request => request(() => library.addSongs(item, props.songs))) }
function remove() { return run(async request => {
  if (!confirmed.value || favoriteProtected.value) throw new Error('收藏歌单不可删除，请在“我喜欢”管理收藏曲目')
  let failure
  try { await request(() => deletePlaylist(props.resource.listId, { signal: controller.signal })) }
  catch (error) { failure = error }
  const after = await request(() => getAllUserPlaylists({ signal: controller.signal }))
  if (after.some(item => String(item.listId) === String(props.resource.listId))) throw failure || new Error('云端尚未确认移除，歌单仍然存在，请刷新后检查')
  return { removed: props.resource }
}) }
function collect() { return run(async request => {
  const details = extractLibraryList(await request(() => getPlaylistDetail(props.resource.globalCollectionId || props.resource.id, { signal: controller.signal })))[0]
  if (!details) throw new Error('暂时无法读取来源歌单，请刷新后重试')
  const source = normalizePlaylistResource({ ...props.resource, ...details }, { source: 'public' })
  const before = await request(() => getAllUserPlaylists({ signal: controller.signal }))
  const existing = before.find(item => item.list_create_gid && String(item.list_create_gid) === String(source.globalCollectionId))
  if (!collectedTarget && existing) collectedTarget = existing
  if (!collectedTarget && collectionAttempt) {
    const confirmed = before.filter(item => item.listId != null && (collectionAttempt.listId != null
      ? String(item.listId) === String(collectionAttempt.listId)
      : !collectionAttempt.ids.has(String(item.listId)) && item.name === source.name))
    if (confirmed.length !== 1) throw new Error('上次收藏结果尚未确认。请刷新账号目录检查，暂不重复收藏。')
    collectedTarget = confirmed[0]
  }
  let failure, result
  if (!collectedTarget) {
    collectionAttempt = { ids: new Set(before.map(item => String(item.listId))) }
    try { result = await request(() => collectPlaylist(source, { signal: controller.signal })); collectionAttempt.listId = result?.data?.listid ?? result?.data?.list_id ?? result?.listid }
    catch (error) { failure = error; if (error.code === 'LIBRARY_REQUEST_FAILED' || error.code === 'INVALID_LIBRARY_INPUT') collectionAttempt = null }
  }
  const after = await request(() => getAllUserPlaylists({ signal: controller.signal }))
  const returnedId = collectedTarget?.listId ?? result?.data?.listid ?? result?.data?.list_id ?? result?.listid
  const created = after.filter(item => item.listId != null && (returnedId != null
    ? String(item.listId) === String(returnedId)
    : !before.some(old => String(old.listId) === String(item.listId)) && item.name === source.name))
  if (created.length !== 1) throw failure || new Error('收藏请求已提交，但暂时无法确认目标歌单。请刷新目录检查，避免重复收藏。')
  const target = created[0]
  collectedTarget = target
  const [sourceSongs, targetSongs] = await request(() => Promise.all([
    getAllPlaylistTracks(source, { signal: controller.signal }),
    getAllPlaylistTracks(target, { signal: controller.signal })
  ]))
  const known = new Set(targetSongs.map(song => String(song.hash).toLowerCase()))
  const missing = sourceSongs.filter(song => !known.has(String(song.hash).toLowerCase()))
  let copyError
  try { for (let start = 0; start < missing.length; start += 1000) {
    await request(() => addPlaylistSongs(target.listId, missing.slice(start, start + 1000), { signal: controller.signal }))
  } } catch (error) { copyError = error }
  const finalSongs = await request(() => getAllPlaylistTracks(target, { signal: controller.signal }))
  const saved = new Set(finalSongs.map(song => String(song.hash).toLowerCase()))
  if (sourceSongs.some(song => !saved.has(String(song.hash).toLowerCase()))) throw copyError || new Error('歌单已收藏，部分曲目尚未确认。重试只会补齐仍缺少的歌曲。')
}) }
</script>

<style scoped>
.playlist-dialog-mask { position:fixed; inset:0; z-index:15000; background:#0006; display:grid; place-items:center; padding:24px; backdrop-filter:blur(8px); }
.playlist-dialog { width:min(480px,100%); max-height:80vh; overflow:auto; padding:28px; border-radius:24px; background:var(--color-background-light); color:var(--color-text); box-shadow:0 24px 80px #0004; border:1px solid var(--color-border); }
header { display:flex; justify-content:space-between; align-items:center; gap:20px; } h2 { margin:6px 0 24px; } .eyebrow { font-size:10px; letter-spacing:.18em; color:var(--color-text-secondary); }
form,label { display:grid; gap:10px; } form { gap:22px; } input:not([type=checkbox]) { width:100%; padding:12px; border:1px solid var(--color-border); border-radius:10px; background:var(--color-background-lighter); color:inherit; box-sizing:border-box; }
.privacy { display:flex; align-items:center; gap:10px; margin:18px 0; } button { padding:10px 16px; border:1px solid var(--color-border); border-radius:10px; color:inherit; background:var(--color-background-lighter); cursor:pointer; } button:disabled { opacity:.45; cursor:wait; } .primary { background:var(--color-primary); color:white; } .danger,.error { color:var(--color-error,#c44); } .error { line-height:1.6; } .pending { color:var(--color-text-secondary); }
.destinations { display:grid; gap:8px; max-height:45vh; overflow:auto; } .destinations button { display:flex; justify-content:space-between; text-align:left; }
</style>
