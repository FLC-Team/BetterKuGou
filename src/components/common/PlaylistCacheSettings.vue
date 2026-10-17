<template>
  <div class="cache-settings">
    <p class="cache-note">打开歌单时保存列表；首次播放时缓存音频、歌词和翻译，封面随加载保存。</p>
    <p v-if="!available" class="cache-note">离线缓存仅在桌面客户端中可用。</p>
    <fieldset :disabled="!available" class="cache-controls">
      <div class="cache-row">
        <div><label for="offline-cache-enabled">自动缓存已播放歌曲</label><p>关闭后保留已有缓存，仍可离线播放。</p></div>
        <label class="cache-switch"><input id="offline-cache-enabled" type="checkbox" :checked="preferences.offlinePlaylistCacheEnabled !== false" @change="setPreference('offlinePlaylistCacheEnabled', $event.target.checked)"><span></span></label>
      </div>
      <div class="cache-row">
        <div><label for="offline-cache-size">缓存上限</label><p>空间不足时清理较久未使用的内容，正在播放的音源会保留。</p></div>
        <select id="offline-cache-size" :value="preferences.cacheSizeIndex ?? 0" @change="setPreference('cacheSizeIndex', Number($event.target.value))"><option v-for="(size, index) in sizes" :key="size" :value="index">{{ size < 0 ? '无限制' : `${size} MB` }}</option></select>
      </div>
      <div class="cache-row">
        <div><label for="offline-cache-concurrency">同时缓存数量</label><p>只处理已经播放过的歌曲，不提前下载整张歌单。</p></div>
        <input id="offline-cache-concurrency" type="number" min="1" max="10" :value="preferences.concurrentDownloads ?? 3" @change="setPreference('concurrentDownloads', Math.max(1, Math.min(10, Number($event.target.value) || 3)))">
      </div>
    </fieldset>
    <div v-if="available" class="cache-summary" aria-live="polite">
      <p>全部账号占用 {{ formatBytes(state.usedBytes) }} / {{ state.limitBytes > 0 ? formatBytes(state.limitBytes) : '无限制' }}</p>
      <p class="cache-note">本账号 {{ state.playlists?.length || 0 }} 张歌单 · {{ cachedCount }} 首离线可用</p>
      <p class="cache-note">缓存目录：{{ state.cacheDirectory || '应用数据目录 / offline-playlists' }}（只读）</p>
      <div class="cache-actions"><button type="button" :disabled="busy || !state.userId" @click="runAction('retry')">重试未完成缓存</button><button type="button" :disabled="busy || !state.userId" @click="confirmClear = true">清理本账号缓存</button></div>
      <div v-if="confirmClear" class="cache-confirm" role="group" aria-label="确认清理缓存"><p>清理本账号的音频、歌词和封面缓存，保留歌单列表；正在播放的文件会在释放后清理。</p><button type="button" :disabled="busy" @click="runAction('clear')">确认清理</button><button type="button" :disabled="busy" @click="confirmClear = false">取消</button></div>
    </div>
    <p v-if="error || state.error?.message" class="cache-error" role="alert">{{ error || state.error?.message }}</p>
    <p v-if="message" class="cache-note" role="status">{{ message }}</p>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { logger } from '../../utils/logger.js'

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, beforeAction: { type: Function, required: true } })
const emit = defineEmits(['update:modelValue'])
const api = typeof window !== 'undefined' ? window.electronAPI?.playlistCache : null
const available = Boolean(api?.getState && api?.onState)
const sizes = [2048, 4096, 6144, 8192, 10240, -1]
const preferences = computed(() => props.modelValue || {})
const state = ref({ revision: -1, userId: null, usedBytes: 0, limitBytes: 2 * 1024 ** 3, playlists: [] })
const cachedCount = computed(() => Number.isInteger(state.value.cachedSongCount) ? state.value.cachedSongCount
  : new Set((state.value.playlists || []).flatMap(item => item.hashes || [])).size)
const busy = ref(false)
const confirmClear = ref(false)
const error = ref('')
const message = ref('')
let disposed = false
let unsubscribe = null

function setPreference(key, value) { emit('update:modelValue', { ...preferences.value, [key]: value }) }
function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
function acceptState(next) {
  if (disposed || !next || !Number.isInteger(next.revision) || next.revision < state.value.revision) return
  if (state.value.userId !== next.userId || state.value.generation !== next.generation) {
    confirmClear.value = false
    error.value = ''
    message.value = ''
  }
  state.value = next
}

/** 所有缓存管理动作先排空设置草稿，避免使用尚未保存的容量或开关。 */
async function runAction(method) {
  if (!available || busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  const owner = state.value.userId
  const generation = state.value.generation
  try {
    if (!await props.beforeAction()) throw new Error('请先重试保存设置。')
    if (disposed || owner !== state.value.userId || generation !== state.value.generation) return
    const result = await api[method]()
    if (disposed || owner !== state.value.userId || generation !== state.value.generation) return
    acceptState(result)
    if (result?.error) throw new Error(result.error.message || '缓存操作未完成，请重试。')
    confirmClear.value = false
    message.value = method === 'clear' ? '本账号缓存已清理；再次播放时重新积累缓存。' : '已重试已播放歌曲的未完成缓存。'
  } catch (cause) {
    if (!disposed) error.value = cause?.message || '缓存操作失败，请重试。'
    logger.warn('PlaylistCacheSettings', '缓存管理操作失败', { method, code: cause?.code })
  } finally {
    if (!disposed) busy.value = false
  }
}

onMounted(async () => {
  if (!available) return
  unsubscribe = api.onState(acceptState)
  try { acceptState(await api.getState()) } catch (cause) {
    if (!disposed) error.value = '无法读取缓存状态，请重新打开设置重试。'
    logger.warn('PlaylistCacheSettings', '读取缓存状态失败', { code: cause?.code })
  }
})
onBeforeUnmount(() => { disposed = true; unsubscribe?.() })
</script>

<style scoped>
.cache-settings { font-size: var(--font-size-xs); }
.cache-controls { border: 0; padding: 0; min-width: 0; }
.cache-note, .cache-row p { color: var(--color-text-secondary); line-height: 1.8; margin: 6px 0; overflow-wrap: anywhere; }
.cache-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px 0; border-bottom: 1px solid var(--color-border); }
.cache-row > div { flex: 1; min-width: 0; }
.cache-row label { color: var(--color-text); font-size: var(--font-size-sm); }
.cache-row select, .cache-row input[type="number"] { flex: 0 0 auto; max-width: 130px; border: 1px solid var(--color-border); border-radius: 7px; padding: 8px; background: var(--color-background-light); color: var(--color-text); }
.cache-row input[type="number"] { width: 70px; }
.cache-switch { position: relative; display: block; width: 37px; height: 22px; flex: 0 0 37px; }
.cache-switch input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; }
.cache-switch span { display: block; width: 100%; height: 100%; border-radius: 22px; background: var(--color-border); pointer-events: none; }
.cache-switch span::after { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; border-radius: 50%; background: var(--color-text); transition: transform .15s; }
.cache-switch input:checked + span { background: var(--color-primary); }
.cache-switch input:checked + span::after { transform: translateX(15px); }
.cache-switch input:focus-visible + span { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.cache-controls:disabled { opacity: .55; }
.cache-summary { padding-top: 18px; }
.cache-actions, .cache-confirm { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
.cache-confirm p { flex-basis: 100%; line-height: 1.8; }
button { border: 1px solid var(--color-border); border-radius: 7px; padding: 9px 13px; color: var(--color-text); }
button:hover { border-color: var(--color-primary); color: var(--color-primary); }
button:disabled { opacity: .5; cursor: default; }
.cache-error { margin-top: 12px; color: var(--color-error); line-height: 1.8; }
@container (max-width: 500px) { .cache-row { gap: 12px; } }
</style>
