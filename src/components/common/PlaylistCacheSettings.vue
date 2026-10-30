<template>
  <div class="cache-settings" :aria-busy="working">
    <p class="cache-note">打开歌单时保存列表；首次播放时缓存音频、歌词和翻译，封面随加载保存。</p>
    <p v-if="!available" class="cache-note">离线缓存仅在桌面客户端中可用。</p>
    <fieldset :disabled="!available" class="cache-controls">
      <div class="cache-row">
        <div><label for="offline-cache-enabled">自动缓存已播放歌曲</label><p>关闭后保留已有缓存，仍可离线播放。</p></div>
        <label class="cache-switch"><input id="offline-cache-enabled" type="checkbox" :checked="preferences.offlinePlaylistCacheEnabled !== false" @change="setPreference('offlinePlaylistCacheEnabled', $event.target.checked)"><span></span></label>
      </div>
      <div class="cache-row">
        <div><label for="offline-cache-size">缓存上限</label><p>空间不足时清理较久未使用的内容，正在播放的音源会保留。</p></div>
        <AnimatedSelect id="offline-cache-size" class="cache-select" :model-value="preferences.cacheSizeIndex ?? 0" label="缓存上限" :options="sizeOptions" :disabled="!available" @update:model-value="setPreference('cacheSizeIndex', $event)" />
      </div>
      <div class="cache-row">
        <div><label for="offline-cache-concurrency">同时缓存数量</label><p>只处理已经播放过的歌曲，不提前下载整张歌单。</p></div>
        <input id="offline-cache-concurrency" type="number" min="1" max="10" :value="preferences.concurrentDownloads ?? 3" @change="setPreference('concurrentDownloads', Math.max(1, Math.min(10, Number($event.target.value) || 3)))">
      </div>
    </fieldset>
    <div class="cache-row cache-directory">
      <div><span class="cache-label">缓存位置</span><p>{{ state.cacheDirectory || (available ? '应用数据目录 / offline-playlists' : '仅桌面客户端可用') }}</p><p id="cache-directory-help">更改位置会迁移全部账号的缓存，存入所选文件夹下的 offline-playlists 子文件夹。</p></div>
      <button type="button" :disabled="!canChooseDirectory || working" aria-describedby="cache-directory-help" @click="changeDirectory">更改位置</button>
    </div>
    <div v-if="available" class="cache-summary" aria-live="polite">
      <p>全部账号占用 {{ formatBytes(state.usedBytes) }} / {{ state.limitBytes > 0 ? formatBytes(state.limitBytes) : '无限制' }}</p>
      <p class="cache-note">本账号 {{ state.playlists?.length || 0 }} 张歌单 · {{ cachedCount }} 首离线可用</p>
      <div class="cache-actions"><button type="button" :disabled="working || !state.userId" @click="runAction('retry')">重试未完成缓存</button><button type="button" :disabled="working || !state.userId" @click="requestClear">清理本账号缓存</button></div>
      <Transition name="ui-fade" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false"><div v-if="confirmClear" class="cache-confirm" role="group" aria-label="确认清理缓存"><p>清理本账号的音频、歌词和封面缓存，保留歌单列表；正在播放的文件会在释放后清理。</p><button type="button" :disabled="working" @click="runAction('clear')">确认清理</button><button type="button" :disabled="working" @click="confirmClear = false">取消</button></div></Transition>
    </div>
    <Transition name="ui-fade"><div v-if="migrating" class="cache-migration" role="status"><p class="cache-note cache-working">{{ migrationStage }}</p><progress :value="migrationTotal > 0 ? migrationCompletedBytes : undefined" :max="migrationTotal || 1" aria-label="缓存迁移进度"></progress><p v-if="migrationTotal > 0" class="cache-note">{{ formatBytes(migrationCompletedBytes) }} / {{ formatBytes(migrationTotal) }}</p><p class="cache-note">离开设置页后，迁移仍会继续。</p></div><p v-else-if="busy" class="cache-note cache-working" role="status">正在处理缓存…</p></Transition>
    <Transition name="ui-fade" mode="out-in"><p v-if="visibleError" :key="visibleError" class="cache-error" role="alert">{{ visibleError }}</p></Transition>
    <Transition name="ui-fade" mode="out-in"><p v-if="state.migrationWarning?.message" :key="state.migrationWarning.message" class="cache-note" role="status">{{ state.migrationWarning.message }}</p></Transition>
    <Transition name="ui-fade" mode="out-in"><p v-if="message" :key="message" class="cache-note" role="status">{{ message }}</p></Transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { logger } from '../../utils/logger.js'
import AnimatedSelect from './AnimatedSelect.vue'

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, beforeAction: { type: Function, required: true } })
const emit = defineEmits(['update:modelValue'])
const api = typeof window !== 'undefined' ? window.electronAPI?.playlistCache : null
const available = Boolean(api?.getState && api?.onState)
const canChooseDirectory = available && typeof api.chooseDirectory === 'function'
const sizes = [2048, 4096, 6144, 8192, 10240, -1]
const sizeOptions = sizes.map((size, index) => ({ value: index, label: size < 0 ? '无限制' : `${size} MB` }))
const preferences = computed(() => props.modelValue || {})
const state = ref({ revision: -1, userId: null, usedBytes: 0, limitBytes: 2 * 1024 ** 3, playlists: [] })
const cachedCount = computed(() => Number.isInteger(state.value.cachedSongCount) ? state.value.cachedSongCount
  : new Set((state.value.playlists || []).flatMap(item => item.hashes || [])).size)
const busy = ref(false)
const migrating = computed(() => Boolean(state.value.migration))
const working = computed(() => busy.value || migrating.value)
const migrationStage = computed(() => ({ copying: '正在迁移缓存…', verifying: '正在校验缓存…', committing: '正在切换缓存位置…', cleanup: '正在清理旧位置…' }[state.value.migration?.phase] || '正在迁移缓存…'))
const migrationTotal = computed(() => Math.max(0, Number(state.value.migration?.totalBytes) || 0))
const migrationCompletedBytes = computed(() => {
  const migration = state.value.migration
  const bytes = migration?.phase === 'verifying' ? migration.verifiedBytes : migration?.copiedBytes
  return Math.min(migrationTotal.value, Math.max(0, Number(bytes) || 0))
})
const confirmClear = ref(false)
const error = ref('')
const visibleError = computed(() => error.value || state.value.migrationError?.message || state.value.error?.message)
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
  const wasMigrating = migrating.value
  if (state.value.userId !== next.userId || state.value.generation !== next.generation) {
    confirmClear.value = false
    error.value = ''
    message.value = ''
  }
  if (next.migration && !wasMigrating) {
    confirmClear.value = false
    error.value = ''
    message.value = ''
  }
  state.value = next
  if (wasMigrating && !next.migration && !next.migrationError) message.value = '缓存位置已更改。'
}

function requestClear() {
  if (!disposed && !working.value && state.value.userId) confirmClear.value = true
}

/** 目录变更由主进程迁移并保存全部账号缓存；这里只排空草稿和展示服务状态。 */
async function changeDirectory() {
  if (disposed || !canChooseDirectory || working.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  confirmClear.value = false
  try {
    if (!await props.beforeAction()) throw new Error('请先重试保存设置。')
    if (disposed || migrating.value) return
    const result = await api.chooseDirectory()
    if (disposed) return
    if (result?.state) acceptState(result.state)
    if (result?.canceled) return
    const failure = result?.error || result?.state?.migrationError
    if (failure) throw Object.assign(new Error(failure.message || '缓存位置更改失败，请重试。'), { code: failure.code })
    if (result?.state && !result.state.migration) message.value = '缓存位置已更改。'
  } catch (cause) {
    if (!disposed) error.value = cause?.message || '缓存位置更改失败，请重试。'
    logger.warn('PlaylistCacheSettings', '更改缓存位置失败', { code: cause?.code })
  } finally {
    if (!disposed) busy.value = false
  }
}

/** 所有缓存管理动作先排空设置草稿，避免使用尚未保存的容量或开关。 */
async function runAction(method) {
  if (disposed || !available || working.value || !state.value.userId || (method === 'clear' && !confirmClear.value)) return
  busy.value = true
  error.value = ''
  message.value = ''
  const owner = state.value.userId
  const generation = state.value.generation
  try {
    if (!await props.beforeAction()) throw new Error('请先重试保存设置。')
    if (disposed || migrating.value || owner !== state.value.userId || generation !== state.value.generation) return
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
.cache-row label, .cache-label { color: var(--color-text); font-size: var(--font-size-sm); }
.cache-directory button { flex: 0 0 auto; }
.cache-migration { margin-top: 18px; }
.cache-migration progress { width: 100%; height: 6px; accent-color: var(--color-primary); }
.cache-row :deep(.cache-select), .cache-row input[type="number"] { flex: 0 0 auto; max-width: 130px; border: 1px solid var(--color-border); border-radius: 7px; padding: 8px; background: var(--color-background-light); color: var(--color-text); }
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
button:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
button:active:not(:disabled) { scale: .98; }
button:disabled { opacity: .5; cursor: default; }
.cache-error { margin-top: 12px; color: var(--color-error); line-height: 1.8; }
.cache-switch span { transition: background-color .18s ease; }
.cache-working::before { content: ''; display: inline-block; width: 10px; height: 10px; margin-right: 7px; border: 1px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: cache-working .7s linear infinite; }
.cache-confirm { border-left: 2px solid var(--color-primary); padding-left: 14px; }
.cache-actions button, .cache-confirm button, .cache-directory button { transition: border-color .16s ease, color .16s ease, scale .16s ease, opacity .16s ease; }
@keyframes cache-working { to { rotate: 360deg; } }
@media (prefers-reduced-motion: reduce) { .cache-working::before { animation: none; } .cache-switch span, .cache-switch span::after, button { transition: none; } }
@container (max-width: 500px) { .cache-row { gap: 12px; } .cache-directory { align-items: flex-start; flex-direction: column; } }
</style>
