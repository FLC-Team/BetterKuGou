<template>
  <section class="app-updates" aria-labelledby="app-updates-heading">
    <header class="updates-heading">
      <div><h3 id="app-updates-heading">应用更新</h3><p class="updates-description">优先通过 git.tangbai.cc 获取更新，失败后尝试 GitHub 原站。</p></div>
      <span class="current-version">当前版本 v{{ state.currentVersion }}</span>
    </header>

    <fieldset class="updates-preferences" :disabled="!available">
      <div class="updates-row">
        <div><label for="update-channel">更新渠道</label><p>正式版只接收稳定更新；测试版同时接收正式版与预发布。</p></div>
        <select id="update-channel" :value="preferences.channel" @change="setPreference('channel', $event.target.value)"><option value="stable">正式版</option><option value="beta">测试版</option></select>
      </div>
      <div class="updates-row">
        <div><label for="update-auto-check">自动检查更新</label><p id="update-auto-check-desc">启动后检查，此后每 24 小时检查一次；不会打断播放。</p></div>
        <label class="updates-switch"><input id="update-auto-check" type="checkbox" :checked="preferences.autoCheck" aria-describedby="update-auto-check-desc" @change="setPreference('autoCheck', $event.target.checked)"><span></span></label>
      </div>
      <div class="updates-row">
        <div><label for="update-auto-download">自动下载更新包</label><p id="update-auto-download-desc">发现新版本后自动下载。下载完成后仍需你手动安装。</p></div>
        <label class="updates-switch"><input id="update-auto-download" type="checkbox" :checked="preferences.autoDownload" aria-describedby="update-auto-download-desc" @change="setPreference('autoDownload', $event.target.checked)"><span></span></label>
      </div>
    </fieldset>

    <p v-if="!available" class="updates-note">检查和下载更新仅在桌面客户端中可用。</p>
    <div v-else class="updates-result" :aria-busy="isBusy">
      <div class="updates-summary"><p class="updates-status" role="status" aria-live="polite">{{ statusText }}</p><span v-if="sourceLabel" class="updates-source">{{ sourceLabel }}</span></div>
      <p v-if="state.checkedAt" class="updates-note">上次检查：{{ checkedAtLabel }}</p>
      <p v-if="actionError || state.error" class="updates-error" role="alert">{{ actionError || errorText(state.error) }}</p>
      <p v-if="actionMessage" class="updates-note" role="status">{{ actionMessage }}</p>

      <article v-if="state.release" class="update-release">
        <div class="release-heading"><h4>{{ state.release.name || '新版本' }}</h4><span>v{{ state.release.version }}</span></div>
        <details v-if="state.release.notes" class="release-notes"><summary>更新说明</summary><p>{{ state.release.notes }}</p></details>
        <div v-if="assets.length > 1" class="updates-row asset-choice"><label for="update-asset">安装包格式</label><select id="update-asset" v-model="chosenAssetId" :disabled="isBusy || !!actionPending"><option v-for="asset in assets" :key="asset.id" :value="String(asset.id)">{{ assetLabel(asset) }}</option></select></div>
        <p v-else-if="assets.length === 1" class="updates-note">{{ assetLabel(assets[0]) }}</p>
        <p v-else class="updates-note">此版本没有适用于当前系统和架构的安装包，可在发布页查看。</p>
        <button type="button" class="updates-link" @click="openReleasePage" :disabled="!!actionPending">查看发布页 ↗</button>
      </article>

      <div v-if="state.status === 'downloading'" class="updates-progress">
        <progress :value="downloadPercent" max="100" aria-label="更新包下载进度"></progress>
        <div><span>{{ downloadPercent.toFixed(1) }}%</span><span>{{ formatBytes(state.progress?.received) }} / {{ formatBytes(state.progress?.total) }}</span></div>
      </div>
      <p v-if="state.downloaded" class="updates-note">已下载：{{ state.downloaded.name }}。{{ canInstall ? '点击手动安装并确认后才会打开安装包。' : '请打开所在文件夹，自行处理安装包。' }}</p>

      <div class="updates-actions">
        <button type="button" @click="checkForUpdates" :disabled="isBusy || !!actionPending">{{ state.status === 'checking' ? '正在检查…' : '检查更新' }}</button>
        <button v-if="canDownload" type="button" @click="downloadUpdate" :disabled="isBusy || !!actionPending || !selectedAsset">下载更新包</button>
        <button v-if="isBusy" type="button" @click="cancelUpdate" :disabled="cancelPending">取消</button>
        <button v-if="state.downloaded" type="button" @click="revealDownload" :disabled="!!actionPending">打开所在文件夹</button>
        <button v-if="canInstall" type="button" @click="installUpdate" :disabled="!!actionPending">{{ actionPending === 'requestInstall' ? '等待确认…' : '手动安装' }}</button>
      </div>
      <p class="updates-note install-boundary">应用只检查和下载更新，安装始终由你手动发起。</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import packageInfo from '../../../package.json'
import { logger } from '../../utils/logger.js'

const props = defineProps({
  modelValue: { type: Object, default: () => ({ autoCheck: true, autoDownload: false, channel: 'stable' }) },
  beforeAction: { type: Function, required: true }
})
const emit = defineEmits(['update:modelValue', 'current-version'])
const updateAPI = window.electronAPI?.updates
const available = Boolean(updateAPI?.getState && updateAPI?.onState)
const state = ref({ revision: -1, status: 'idle', currentVersion: packageInfo.version, channel: 'stable', release: null, downloaded: null, error: null })
const preferences = computed(() => ({ autoCheck: true, autoDownload: false, channel: 'stable', ...props.modelValue }))
const actionPending = ref('')
const cancelPending = ref(false)
const actionError = ref('')
const actionMessage = ref('')
const chosenAssetId = ref('')
let unsubscribe = null
let disposed = false

const isBusy = computed(() => ['checking', 'downloading'].includes(state.value.status))
const assets = computed(() => state.value.release?.assets || [])
const selectedAsset = computed(() => assets.value.find(asset => String(asset.id) === chosenAssetId.value))
const canDownload = computed(() => assets.value.length > 0 && (state.value.status !== 'downloaded'
  || (selectedAsset.value && String(selectedAsset.value.id) !== String(state.value.selectedAssetId))))
const canInstall = computed(() => state.value.status === 'downloaded' && ['exe', 'dmg', 'deb', 'rpm'].includes(String(state.value.downloaded?.format).toLowerCase()))
const downloadPercent = computed(() => Math.max(0, Math.min(100, Number(state.value.progress?.percent) || 0)))
const sourceLabel = computed(() => {
  const source = state.value.status === 'downloading' ? state.value.progress?.source : state.value.source
  return ['proxy', 'mirror'].includes(source) ? '来源：git.tangbai.cc'
    : source === 'github' ? '来源：GitHub 原站' : source === 'cache' ? '来源：已验证缓存' : ''
})
const checkedAtLabel = computed(() => {
  const date = new Date(state.value.checkedAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
})
const statusText = computed(() => ({
  idle: state.value.message || '随时检查是否有新版本。',
  checking: '正在检查新版本…',
  upToDate: '当前渠道暂无更高版本。',
  available: `发现新版本 v${state.value.release?.version || ''}`,
  downloading: '正在下载更新包…',
  downloaded: '更新包已准备好，等待你手动安装。',
  error: state.value.message || '更新操作未完成，请重试。'
})[state.value.status] || '')

function setPreference(key, value) {
  emit('update:modelValue', { ...preferences.value, [key]: value })
}

function errorText(error) {
  return typeof error === 'string' ? error : error?.message || '更新操作失败，请稍后重试。'
}

function formatBytes(value) {
  const size = Number(value)
  if (!Number.isFinite(size) || size < 0) return '—'
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

function assetLabel(asset) {
  return `${asset.format || asset.name} · ${formatBytes(asset.size)}`
}

/** Subscribe before the initial snapshot and reject older IPC responses by revision. */
function acceptState(next) {
  if (disposed || !next || !Number.isInteger(next.revision) || next.revision < state.value.revision) return
  state.value = next
  actionError.value = ''
  if (next.currentVersion) emit('current-version', next.currentVersion)
}

watch(() => [state.value.release?.id, state.value.release?.defaultAssetId, state.value.selectedAssetId], () => {
  const next = state.value.selectedAssetId ?? state.value.release?.defaultAssetId ?? assets.value[0]?.id
  if (next != null) chosenAssetId.value = String(next)
}, { immediate: true })

/** Flush the parent settings transaction before actions consume the saved update channel. */
async function runAction(method, args = [], { save = true, successMessage = '' } = {}) {
  if (!available || (method === 'cancel' ? cancelPending.value : actionPending.value)) return false
  if (method === 'cancel') cancelPending.value = true
  else actionPending.value = method
  actionError.value = ''
  actionMessage.value = ''
  try {
    if (save && !await props.beforeAction()) {
      if (!disposed) actionError.value = '请先重试保存设置，再执行更新操作。'
      return false
    }
    if (disposed) return false
    const result = await updateAPI[method](...args)
    if (disposed) return false
    if (result?.success === false) throw new Error(errorText(result.error || result.message))
    if (result?.canceled) return false
    if (result?.status) acceptState(result)
    else if (result?.state) acceptState(result.state)
    if (successMessage) actionMessage.value = successMessage
    return true
  } catch (error) {
    if (!disposed) {
      actionError.value = errorText(error)
      logger.error('AppUpdates', `更新操作失败：${method}`, error)
    }
    return false
  } finally {
    if (!disposed) {
      if (method === 'cancel') cancelPending.value = false
      else actionPending.value = ''
    }
  }
}

const checkForUpdates = () => runAction('check')
const downloadUpdate = () => selectedAsset.value ? runAction('download', [selectedAsset.value.id]) : false
const cancelUpdate = () => runAction('cancel', [], { save: false })
const revealDownload = () => runAction('revealDownloadedFile', [], { successMessage: '已在文件夹中显示更新包。' })
const installUpdate = () => canInstall.value ? runAction('requestInstall', [], { successMessage: '安装包已打开，请按系统提示继续。' }) : false

async function openReleasePage() {
  // Only the fixed project release path may leave the renderer through this control.
  const fallback = 'https://github.com/FLC-Team/BetterKuGou/releases'
  const candidate = state.value.release?.url
  let url = fallback
  try {
    const parsed = new URL(candidate || fallback)
    if (parsed.origin === 'https://github.com' && /^\/FLC-Team\/BetterKuGou\/releases(?:\/tag\/[^/?#]+)?\/?$/.test(parsed.pathname)) url = parsed.href
    if (window.electronAPI?.openExternal) await window.electronAPI.openExternal(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    actionError.value = '无法打开发布页，请稍后重试。'
    logger.error('AppUpdates', '打开发布页失败', error)
  }
}

onMounted(async () => {
  emit('current-version', state.value.currentVersion)
  if (!available) return
  try {
    unsubscribe = updateAPI.onState(acceptState)
    acceptState(await updateAPI.getState())
  } catch (error) {
    if (!disposed) actionError.value = errorText(error)
    logger.error('AppUpdates', '读取更新状态失败', error)
  }
})

onBeforeUnmount(() => {
  disposed = true
  if (typeof unsubscribe === 'function') unsubscribe()
  unsubscribe = null
})
</script>

<style scoped>
.app-updates { margin-top: 21px; padding-top: 23px; border-top: 1px solid var(--color-border); min-width: 0; }
.updates-heading, .updates-row, .updates-summary, .release-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.updates-heading { align-items: flex-start; flex-wrap: wrap; }
.updates-heading h3 { margin: 0; font-size: var(--font-size-sm); font-weight: 600; }
.updates-description, .updates-row p, .updates-note { margin-top: 5px; color: var(--color-text-secondary); font-size: calc(var(--font-size-xs) - 1px); line-height: 1.8; overflow-wrap: anywhere; }
.current-version, .updates-source { color: var(--color-text-tertiary); font-size: 10px; line-height: 1.8; overflow-wrap: anywhere; }
.updates-preferences { margin: 9px 0 0; padding: 0; border: 0; min-width: 0; }
.updates-preferences:disabled { opacity: .55; }
.updates-row { min-width: 0; padding: 17px 0; }
.updates-row + .updates-row { border-top: 1px solid color-mix(in srgb, var(--color-border) 55%, transparent); }
.updates-row > div { flex: 1; min-width: 0; }
.updates-row label { color: var(--color-text); font-size: var(--font-size-sm); font-weight: 500; line-height: 1.7; }
.updates-row select { max-width: min(60%, 270px); min-width: 120px; min-height: 36px; padding: 8px 11px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); color: var(--color-text); background: var(--color-background-light); font-size: var(--font-size-xs); }
.updates-row label.updates-switch { position: relative; display: block; flex: 0 0 37px; width: 37px; height: 22px; cursor: pointer; }
.updates-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.updates-switch span { display: block; width: 100%; height: 100%; border: 1px solid var(--color-border); border-radius: 20px; background: var(--color-background-lighter); pointer-events: none; transition: background .18s; }
.updates-switch span::before { content: ''; position: absolute; width: 14px; height: 14px; left: 4px; top: 4px; border-radius: 50%; background: var(--color-text-secondary); transition: transform .18s; }
.updates-switch input:checked + span { border-color: transparent; background: var(--color-primary); }
.updates-switch input:checked + span::before { transform: translateX(15px); background: var(--color-on-primary); }
.updates-switch input:focus-visible + span, button:focus-visible, select:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.updates-result { margin-top: 8px; padding: 17px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.updates-summary { flex-wrap: wrap; gap: 6px 15px; }
.updates-status { color: var(--color-text); font-size: var(--font-size-xs); line-height: 1.8; }
.updates-error { margin-top: 10px; color: var(--color-error); font-size: var(--font-size-xs); line-height: 1.8; overflow-wrap: anywhere; }
.update-release { margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--color-border); }
.release-heading { align-items: baseline; flex-wrap: wrap; gap: 5px 15px; color: var(--color-text-secondary); font-size: 11px; }
.release-heading h4 { margin: 0; font-size: var(--font-size-sm); color: var(--color-text); overflow-wrap: anywhere; }
.release-notes { margin: 14px 0; color: var(--color-text-secondary); font-size: var(--font-size-xs); line-height: 1.8; }
.release-notes summary { cursor: pointer; color: var(--color-text); }
.release-notes p { max-height: 240px; overflow-y: auto; margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.asset-choice { gap: 12px; padding-bottom: 5px; }
.updates-link { margin-top: 9px; color: var(--color-primary); font-size: 11px; }
.updates-progress { margin-top: 17px; }
.updates-progress progress { display: block; width: 100%; height: 6px; accent-color: var(--color-primary); }
.updates-progress > div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin-top: 8px; color: var(--color-text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; }
.updates-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.updates-actions button { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 7px 14px; border: 1px solid var(--color-border); border-radius: 40px; color: var(--color-text); font-size: 11px; }
.updates-actions button:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
button:disabled { opacity: .45; cursor: default; }
.install-boundary { margin-top: 13px; }
@container (max-width: 430px) { .updates-row { gap: 15px; } .updates-row label { font-size: 12px; } .updates-result { padding: 13px; } .updates-row select { min-width: 105px; width: 120px; } }
@media (prefers-reduced-motion: reduce) { .updates-switch span, .updates-switch span::before { transition: none; } }
</style>
