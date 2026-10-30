<template>
  <section class="lyric-library" aria-labelledby="lyric-library-title" :aria-busy="busy">
    <header class="library-header"><div><span class="library-eyebrow">LYRIC LIBRARY</span><h4 id="lyric-library-title">已保存的歌词</h4></div><button type="button" :disabled="busy" aria-label="关闭歌词管理" @click="requestClose">关闭</button></header>
    <div class="library-toolbar"><label class="library-search"><span class="sr-only">搜索已保存的曲目</span><input ref="searchInput" v-model="query" type="search" placeholder="搜索歌名或歌手" :disabled="busy"></label><button type="button" :disabled="busy || dirty" @click="refresh">{{ busy && !record ? '读取中…' : '刷新' }}</button></div>
    <Transition name="ui-fade"><p v-if="refreshNeeded" class="library-note" role="status">歌词库有更新，刷新后可查看最新版本。{{ dirty ? '请先保存或撤销当前编辑。' : '' }}</p></Transition>
    <Transition name="ui-fade" mode="out-in"><p v-if="error" :key="error" class="library-error" role="alert">{{ error }}</p></Transition>
    <Transition name="ui-fade" mode="out-in"><p v-if="message" :key="message" class="library-note" role="status">{{ message }}</p></Transition>
    <p v-if="busy" class="library-working" role="status">{{ busyLabel }}</p>
    <p v-if="!busy && !songs.length && !error" class="library-empty">还没有保存的歌词。播放有可用歌词的歌曲后，符合匹配要求的版本会自动保存。</p>
    <p v-else-if="!busy && songs.length && !filteredSongs.length" class="library-empty">没有找到匹配的曲目。</p>
    <div v-if="songs.length" class="library-layout">
      <ul class="library-songs" aria-label="已保存歌词的曲目">
        <li v-for="song in filteredSongs" :key="song.hash"><button type="button" :class="{ 'is-selected': record?.hash === song.hash }" :aria-pressed="record?.hash === song.hash" :disabled="busy || dirty" @click="loadSong(song.hash)"><span class="library-song-title">{{ song.title || '未命名曲目' }}</span><span class="library-song-meta">{{ song.artist || '未知歌手' }} · {{ song.versionCount }} 个版本</span></button></li>
      </ul>
      <Transition name="library-record" mode="out-in" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false">
        <div v-if="record" :key="record.hash" class="library-editor">
          <div class="library-editor-heading"><h5>{{ record.title || '未命名曲目' }}</h5><p>{{ record.artist || '未知歌手' }}</p></div>
          <label class="library-field"><span>歌词版本</span><AnimatedSelect :model-value="versionId" :options="versionOptions" label="歌词版本" :disabled="busy || dirty" @update:model-value="previewVersion" /></label>
          <div class="library-version-status"><span>{{ activeVersion?.source === 'edited' ? '本地编辑版本' : '在线歌词版本' }}</span><span v-if="versionId === record.selectedVersionId" class="library-selected-label">正在使用</span><button v-else type="button" :disabled="busy || dirty || !activeVersion" @click="useVersion">使用此版本</button></div>
          <label class="library-field"><span>歌词内容 <span v-if="dirty" class="library-draft-label">· 尚未保存</span></span><textarea ref="editorInput" v-model="content" rows="11" spellcheck="false" :disabled="busy || !activeVersion" aria-describedby="lyric-editor-help" /></label>
          <p id="lyric-editor-help" class="library-note">可编辑 LRC / KRC 歌词，保存为新的本地版本，原版本保留。增删歌词行或更改时间标签会移除此副本的旧翻译和读音；可编辑 language 标签提供新翻译。</p>
          <div class="library-editor-actions"><button type="button" class="library-primary" :disabled="busy || !dirty || !content.trim()" @click="saveEdit">{{ busyLabel === '正在保存歌词…' && busy ? '保存中…' : '保存为本地版本' }}</button><button type="button" :disabled="busy || !dirty" @click="discardEdit">撤销编辑</button></div>
        </div>
        <p v-else class="library-empty">选择一首曲目，查看和编辑已保存的版本。</p>
      </Transition>
    </div>
    <Transition name="ui-fade" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false"><div v-if="confirmClose" class="library-confirm" role="group" aria-label="关闭前处理未保存歌词"><p>当前歌词尚未保存。关闭会放弃这次编辑。</p><button ref="continueButton" type="button" @click="confirmClose = false">继续编辑</button><button type="button" @click="discardAndClose">放弃编辑并关闭</button></div></Transition>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AnimatedSelect from './AnimatedSelect.vue'
import { logger } from '../../utils/logger.js'

const props = defineProps({ beforeAction: { type: Function, required: true } })
const emit = defineEmits(['close', 'protected-state'])
const api = typeof window !== 'undefined' ? window.electronAPI?.lyricLibrary : null
const songs = ref([])
const record = ref(null)
const query = ref('')
const versionId = ref('')
const content = ref('')
const busy = ref(false)
const busyLabel = ref('正在读取歌词…')
const error = ref('')
const message = ref('')
const refreshNeeded = ref(false)
const confirmClose = ref(false)
const searchInput = ref(null)
const editorInput = ref(null)
const continueButton = ref(null)
let disposed = false
let requestId = 0
let unsubscribe
let changeRevision = -1
const filteredSongs = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return songs.value.filter(song => `${song.title || ''} ${song.artist || ''}`.toLocaleLowerCase().includes(term))
})
const activeVersion = computed(() => record.value?.versions?.find(version => version.id === versionId.value) || null)
const dirty = computed(() => Boolean(activeVersion.value) && content.value !== (activeVersion.value.data?.decodeContent || ''))
const versionOptions = computed(() => (record.value?.versions || []).map((version, index) => ({ value: version.id, label: `${version.source === 'edited' ? '本地编辑' : '在线歌词'} ${index + 1}${version.id === record.value.selectedVersionId ? ' · 使用中' : ''} · ${formatDate(version.updatedAt || version.createdAt)}` })))

function formatDate(timestamp) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '未知日期' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function previewVersion(id) {
  if (disposed || busy.value || dirty.value) return
  const version = record.value?.versions?.find(item => item.id === id)
  if (!version) return
  versionId.value = id
  content.value = version.data?.decodeContent || ''
  message.value = ''
}
function acceptRecord(next, preferredId) {
  record.value = next
  versionId.value = next?.versions?.some(item => item.id === preferredId) ? preferredId : next?.selectedVersionId || next?.versions?.[0]?.id || ''
  content.value = next?.versions?.find(item => item.id === versionId.value)?.data?.decodeContent || ''
  if (next) {
    const index = songs.value.findIndex(item => item.hash === next.hash)
    const summary = { hash: next.hash, title: next.title, artist: next.artist, selectedVersionId: next.selectedVersionId, updatedAt: next.updatedAt, versionCount: next.versions?.length || 0 }
    if (index >= 0) songs.value.splice(index, 1, summary)
    else songs.value.unshift(summary)
  }
}

/** 在每个读写动作前排空偏好保存，卸载后拒绝迟到结果且不覆盖失败时的编辑草稿。 */
async function runAction(label, action) {
  if (disposed || busy.value) return
  const generation = ++requestId
  busy.value = true
  busyLabel.value = label
  error.value = ''
  message.value = ''
  confirmClose.value = false
  try {
    if (!await props.beforeAction()) throw new Error('请先重试保存设置，再操作歌词。')
    if (disposed || generation !== requestId) return
    await action(() => !disposed && generation === requestId)
  } catch (cause) {
    if (!disposed && generation === requestId) error.value = cause?.message || '歌词操作失败，请重试。'
    logger.warn('LyricLibrary', '歌词管理操作失败', { operation: label, code: cause?.code })
  } finally { if (!disposed && generation === requestId) busy.value = false }
}
async function refresh() {
  if (dirty.value) return
  await runAction('正在读取歌词…', async current => {
    const revision = changeRevision
    const result = await api.list()
    if (!current()) return
    const nextSongs = Array.isArray(result) ? result : []
    const hash = record.value?.hash
    const next = hash && nextSongs.some(item => item.hash === hash) ? await api.read(hash) : null
    if (!current()) return
    songs.value = nextSongs
    acceptRecord(next, versionId.value)
    refreshNeeded.value = revision !== changeRevision
  })
}
async function loadSong(hash) {
  if (dirty.value || hash === record.value?.hash) return
  await runAction('正在读取歌词…', async current => {
    const next = await api.read(hash)
    if (!current()) return
    if (!next) throw new Error('这首曲目的歌词暂时不可用，请刷新后重试。')
    acceptRecord(next)
  })
}
async function useVersion() {
  if (dirty.value || !activeVersion.value || versionId.value === record.value?.selectedVersionId) return
  const payload = { hash: record.value.hash, versionId: versionId.value }
  await runAction('正在切换歌词版本…', async current => {
    const next = await api.select(payload)
    if (!current()) return
    if (!next) throw new Error('歌词版本切换失败，请重试。')
    acceptRecord(next)
    message.value = '已切换歌词版本。'
  })
}
async function saveEdit() {
  if (!dirty.value || !content.value.trim() || !activeVersion.value) return
  const payload = { hash: record.value.hash, versionId: versionId.value, content: content.value }
  await runAction('正在保存歌词…', async current => {
    const next = await api.saveEdit(payload)
    if (!current()) return
    if (!next) throw new Error('歌词未能保存，请重试。')
    acceptRecord(next)
    message.value = activeVersion.value?.languageReset
      ? '已保存本地版本。歌词行结构已变化，此副本已移除原翻译和读音，原版本仍保留。'
      : '已保存并使用本地编辑版本，原版本已保留。'
  })
}
function discardEdit() {
  if (busy.value || disposed) return
  content.value = activeVersion.value?.data?.decodeContent || ''
  confirmClose.value = false
  error.value = ''
  nextTick(() => editorInput.value?.focus?.({ preventScroll: true }))
}
function requestClose() {
  if (busy.value || disposed) return
  if (dirty.value) {
    confirmClose.value = true
    nextTick(() => continueButton.value?.focus?.())
  }
  else emit('close')
}
function discardAndClose() {
  if (busy.value || disposed || !confirmClose.value) return
  confirmClose.value = false
  emit('close')
}
/** 设置页离页先检查正文草稿；不会把用户未确认的编辑当成偏好自动提交。 */
function prepareLeave() {
  if (!dirty.value && !busy.value) return true
  error.value = busy.value ? '歌词操作尚未完成，请稍后再离开。' : '歌词编辑尚未保存，请先保存或撤销编辑。'
  nextTick(() => { editorInput.value?.scrollIntoView?.({ block: 'center' }); editorInput.value?.focus?.({ preventScroll: true }) })
  return false
}
defineExpose({ prepareLeave })
watch([dirty, busy], ([isDirty, isBusy]) => emit('protected-state', isDirty || isBusy), { immediate: true })
onMounted(async () => {
  unsubscribe = api?.onChanged?.(event => {
    if (disposed || !Number.isInteger(event?.revision) || event.revision <= changeRevision) return
    changeRevision = event.revision
    refreshNeeded.value = true
  })
  await refresh()
  if (!disposed) searchInput.value?.focus?.({ preventScroll: true })
})
onBeforeUnmount(() => { disposed = true; requestId++; unsubscribe?.(); emit('protected-state', false) })
</script>

<style scoped>
.lyric-library { margin-top: 20px; padding: 22px; background: var(--color-background-light); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text); }
.library-header, .library-toolbar, .library-version-status, .library-editor-actions { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.library-eyebrow { color: var(--color-text-tertiary); font-size: 9px; letter-spacing: 1.8px; }
.library-header h4 { margin: 8px 0 0; font-size: 17px; font-weight: 600; }
.library-toolbar { margin: 22px 0 16px; }
.library-search { flex: 1; min-width: 0; }
.library-search input { width: 100%; min-width: 0; padding: 10px 12px; background: var(--color-background); border: 1px solid var(--color-border); border-radius: 7px; color: var(--color-text); font-size: 12px; }
.library-layout { display: grid; grid-template-columns: minmax(130px, .7fr) minmax(0, 1.3fr); gap: 20px; align-items: start; }
.library-songs { list-style: none; padding: 0; margin: 0; max-height: 430px; overflow: auto; scrollbar-gutter: stable; }
.library-songs li + li { border-top: 1px solid var(--color-border); }
.library-songs button { display: flex; flex-direction: column; gap: 7px; width: 100%; border: 0; border-radius: 5px; padding: 14px 10px; text-align: left; }
.library-songs button.is-selected { background: color-mix(in srgb, var(--color-primary) 9%, transparent); color: var(--color-primary); }
.library-song-title { line-height: 1.7; overflow-wrap: anywhere; }
.library-song-meta { font-size: 10px; line-height: 1.7; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.library-editor { min-width: 0; }
.library-editor-heading h5 { margin: 0; font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
.library-editor-heading p { margin: 3px 0 17px; color: var(--color-text-secondary); font-size: 11px; }
.library-field { display: flex; flex-direction: column; gap: 9px; margin-top: 16px; min-width: 0; font-size: 11px; }
.library-field :deep(.animated-select-trigger) { width: 100%; max-width: 100%; }
.library-version-status { justify-content: flex-start; flex-wrap: wrap; margin-top: 12px; color: var(--color-text-secondary); font-size: 10px; }
.library-selected-label, .library-draft-label { color: var(--color-primary); }
.library-field textarea { width: 100%; resize: vertical; min-height: 160px; max-height: 520px; padding: 12px; border-radius: 7px; border: 1px solid var(--color-border); background: var(--color-background); color: var(--color-text); font-family: inherit; font-size: 12px; line-height: 1.8; white-space: pre-wrap; }
.library-note, .library-empty, .library-working { color: var(--color-text-secondary); font-size: 11px; line-height: 1.8; margin: 12px 0; overflow-wrap: anywhere; }
.library-empty { padding: 20px 0; }
.library-editor-actions { justify-content: flex-start; flex-wrap: wrap; margin-top: 14px; }
button { flex-shrink: 0; border: 1px solid var(--color-border); border-radius: 7px; padding: 8px 11px; color: var(--color-text); font-size: 11px; line-height: 1.5; transition: background-color .18s ease, border-color .18s ease, color .18s ease, opacity .18s ease, scale .16s ease; }
button:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }
button:active:not(:disabled) { scale: .98; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
input, textarea { transition: border-color .18s ease, opacity .18s ease; }
input:disabled, textarea:disabled { opacity: .6; }
.library-primary { color: var(--color-primary); border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-border)); }
.library-error { color: var(--color-error); font-size: 11px; line-height: 1.8; margin: 12px 0; }
.library-confirm { margin-top: 18px; border-left: 2px solid var(--color-primary); padding-left: 14px; font-size: 11px; line-height: 1.8; }
.library-confirm p { margin-bottom: 12px; }
.library-confirm button + button { margin-left: 10px; }
.library-working::before { content: ''; display: inline-block; height: 10px; width: 10px; margin-right: 7px; border: 1px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: library-spin .7s linear infinite; }
.library-record-enter-active, .library-record-leave-active { transition: opacity .16s ease, transform .16s ease; }
.library-record-enter-from, .library-record-leave-to { opacity: 0; transform: translateY(5px); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@keyframes library-spin { to { rotate: 360deg; } }
@container (max-width: 650px) { .library-layout { grid-template-columns: minmax(0, 1fr); } .library-songs { max-height: 200px; } .lyric-library { padding: 16px; } }
@media (prefers-reduced-motion: reduce) { *, *::before { transition: none !important; animation: none !important; } }
</style>
