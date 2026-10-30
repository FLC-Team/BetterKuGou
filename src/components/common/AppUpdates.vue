<template>
  <section ref="updatesRoot" class="app-updates" aria-labelledby="app-updates-heading">
    <header class="updates-heading">
      <div><p class="updates-eyebrow">KEEP THE MUSIC GOING</p><h3 id="app-updates-heading">应用更新</h3><p class="updates-description">检查新版本，按你的节奏更新。</p></div>
      <img class="updates-brand" src="/logo.png" alt="" width="40" height="40">
    </header>

    <div class="updates-result" :class="{ 'is-error': state.status === 'error' || actionError, 'is-ready': state.status === 'downloaded' }" :aria-busy="isBusy">
      <div class="updates-overview">
        <div class="current-version"><span class="version-label">当前版本</span><strong>v{{ state.currentVersion }}</strong><span class="version-product">BetterKuGou</span></div>
        <div class="updates-summary">
          <div class="updates-state-line"><span class="version-label">{{ state.release ? '可用版本' : '更新状态' }}</span><span class="updates-channel">{{ channelLabel }}</span></div>
          <Transition name="ui-fade" mode="out-in"><h4 :key="available ? statusTitle : 'browser'" class="updates-version">{{ available ? statusTitle : '桌面客户端专属' }}</h4></Transition>
          <p v-if="available" class="updates-status" role="status" aria-live="polite"><span class="status-dot" :class="{ 'is-active': isBusy }" aria-hidden="true"></span>{{ statusText }}</p>
          <p v-else class="updates-note">检查和下载更新仅在桌面客户端中可用。</p>
        </div>
      </div>

      <template v-if="available">
        <Transition name="ui-fade" mode="out-in"><p v-if="actionError || state.error" :key="actionError || errorText(state.error)" class="updates-error" role="alert">{{ actionError || errorText(state.error) }}</p></Transition>
        <Transition name="ui-fade" mode="out-in"><p v-if="actionMessage" :key="actionMessage" class="updates-feedback" role="status">{{ actionMessage }}</p></Transition>

        <Transition name="updates-expand"><div v-if="state.status === 'downloading'" class="updates-stage"><div class="updates-stage-inner"><div class="updates-progress">
          <div class="progress-heading"><span>下载进度</span><strong>{{ hasDownloadProgress ? downloadPercent.toFixed(1) + '%' : '准备下载…' }}</strong></div>
          <progress :value="hasDownloadProgress ? downloadPercent : undefined" max="100" aria-label="更新包下载进度"></progress>
          <div class="progress-details"><span>{{ formatBytes(state.progress?.received) }} / {{ formatBytes(state.progress?.total) }}</span><span>可以离开此页，下载会在后台继续。</span></div>
        </div></div></div></Transition>

        <div v-if="assets.length > 1" class="asset-choice"><label for="update-asset">安装包格式</label><AnimatedSelect id="update-asset" class="updates-select" v-model="chosenAssetId" label="安装包格式" :options="assetOptions" :disabled="isBusy || !!actionPending" /></div>
        <p v-else-if="assets.length === 1 && !state.downloaded" class="asset-detail">{{ assetLabel(assets[0]) }}</p>
        <p v-else-if="state.release && !assets.length" class="updates-note asset-empty">此版本没有适用于当前系统和架构的安装包，可在发布页查看。</p>

        <Transition name="updates-expand"><div v-if="state.downloaded" class="updates-stage"><div class="updates-stage-inner"><div class="downloaded-file"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h4" /></svg><div><span class="downloaded-label">更新包已下载</span><strong>{{ state.downloaded.name }}</strong><p>{{ canInstall ? '点击手动安装并确认后才会打开安装包。' : '请打开所在文件夹，自行处理安装包。' }}</p></div></div></div></div></Transition>

        <TransitionGroup name="ui-list" tag="div" class="updates-actions" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false">
          <button key="check" type="button" :class="['update-button', { 'is-primary': !canDownload && !canInstall && !isBusy }]" @click="checkForUpdates" :disabled="isBusy || !!actionPending">{{ state.status === 'checking' ? '正在检查…' : '检查更新' }}</button>
          <button v-if="canDownload" key="download" type="button" class="update-button is-primary" @click="downloadUpdate" :disabled="isBusy || !!actionPending || !selectedAsset">下载更新包</button>
          <button v-if="isBusy" key="cancel" type="button" class="update-button" @click="cancelUpdate" :disabled="cancelPending">取消</button>
          <button v-if="state.downloaded" key="reveal" type="button" class="update-button" @click="revealDownload" :disabled="!!actionPending">打开所在文件夹</button>
          <button v-if="canInstall" key="install" type="button" class="update-button is-primary" @click="installUpdate" :disabled="!!actionPending">{{ actionPending === 'requestInstall' ? '等待确认…' : '手动安装' }}</button>
        </TransitionGroup>
        <div class="updates-metadata"><span v-if="state.checkedAt">上次检查：{{ checkedAtLabel }}</span><span v-if="sourceLabel">{{ sourceLabel }}</span></div>
      </template>
    </div>

    <Transition name="ui-fade" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false"><article v-if="available && state.release" :key="state.release.id" class="update-release" aria-labelledby="release-notes-heading">
      <header class="release-heading"><div><p class="updates-eyebrow">WHAT’S NEW</p><h4 id="release-notes-heading">{{ state.release.name || '新版本' }}</h4><span v-if="publishedAtLabel" class="release-date">{{ publishedAtLabel }} 发布</span></div><button type="button" class="updates-link" @click="openReleasePage" :disabled="!!actionPending">查看发布页 ↗</button></header>
      <details v-if="state.release.notes" :key="state.release.id" class="release-notes" open><summary>更新说明<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></summary><div class="release-notes-body" tabindex="0" aria-label="版本更新说明"><p>{{ state.release.notes }}</p></div></details>
      <p v-else class="updates-note">此版本暂未提供更新说明。</p>
    </article></Transition>

    <fieldset class="updates-preferences" :disabled="!available">
      <legend>更新偏好</legend>
      <div class="updates-row">
        <div><label for="update-channel">更新渠道</label><p id="update-channel-desc">正式版更稳定；测试版可提前体验新功能。</p></div>
        <AnimatedSelect id="update-channel" class="updates-select" :model-value="preferences.channel" label="更新渠道" :options="channelOptions" :disabled="!available" aria-describedby="update-channel-desc" @update:model-value="setPreference('channel', $event)" />
      </div>
      <div class="updates-row">
        <div><label for="update-auto-check">自动检查更新</label><p id="update-auto-check-desc">启动后 10 秒检查，此后每 24 小时一次。</p></div>
        <label class="updates-switch"><input id="update-auto-check" type="checkbox" :checked="preferences.autoCheck" aria-describedby="update-auto-check-desc" @change="setPreference('autoCheck', $event.target.checked)"><span></span></label>
      </div>
      <div class="updates-row">
        <div><label for="update-auto-download">自动下载更新包</label><p id="update-auto-download-desc">新版本在后台下载，安装时由你确认。</p></div>
        <label class="updates-switch"><input id="update-auto-download" type="checkbox" :checked="preferences.autoDownload" aria-describedby="update-auto-download-desc" @change="setPreference('autoDownload', $event.target.checked)"><span></span></label>
      </div>
    </fieldset>
    <p class="updates-footnote">安装由你手动发起，不会自动退出应用。</p>
    <details class="updates-routing"><summary>更新来源</summary><p>优先通过 git.tangbai.cc 获取更新，失败后尝试 GitHub 原站。</p></details>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import packageInfo from '../../../package.json'
import { logger } from '../../utils/logger.js'
import { createDetailsMotion } from './detailsMotion.js'
import AnimatedSelect from './AnimatedSelect.vue'

const props = defineProps({
  modelValue: { type: Object, default: () => ({ autoCheck: true, autoDownload: false, channel: 'stable' }) },
  beforeAction: { type: Function, required: true }
})
const emit = defineEmits(['update:modelValue', 'current-version'])
const updateAPI = window.electronAPI?.updates
const available = Boolean(updateAPI?.getState && updateAPI?.onState)
const state = ref({ revision: -1, status: 'idle', currentVersion: packageInfo.version, channel: 'stable', release: null, downloaded: null, error: null })
const preferences = computed(() => ({ autoCheck: true, autoDownload: false, channel: 'stable', ...props.modelValue }))
const channelOptions = [{ value: 'stable', label: '正式版' }, { value: 'beta', label: '测试版' }]
const actionPending = ref('')
const cancelPending = ref(false)
const actionError = ref('')
const actionMessage = ref('')
const chosenAssetId = ref('')
let unsubscribe = null
let disposed = false
const updatesRoot = ref(null)
let disclosureMotions = []
function bindDisclosures() {
  if (disposed || !updatesRoot.value?.querySelectorAll) return
  disclosureMotions.forEach(motion => motion.dispose())
  disclosureMotions = Array.from(updatesRoot.value.querySelectorAll('details'), element => createDetailsMotion(element))
}
watch(() => state.value.release?.id, () => nextTick(bindDisclosures))
onMounted(bindDisclosures)
onBeforeUnmount(() => disclosureMotions.forEach(motion => motion.dispose()))

const isBusy = computed(() => ['checking', 'downloading'].includes(state.value.status))
const assets = computed(() => state.value.release?.assets || [])
const assetOptions = computed(() => assets.value.map(asset => ({ value: String(asset.id), label: assetLabel(asset) })))
const selectedAsset = computed(() => assets.value.find(asset => String(asset.id) === chosenAssetId.value))
const canDownload = computed(() => assets.value.length > 0 && (state.value.status !== 'downloaded'
  || (selectedAsset.value && String(selectedAsset.value.id) !== String(state.value.selectedAssetId))))
const canInstall = computed(() => state.value.status === 'downloaded' && ['exe', 'dmg', 'deb', 'rpm'].includes(String(state.value.downloaded?.format).toLowerCase()))
const downloadPercent = computed(() => Math.max(0, Math.min(100, Number(state.value.progress?.percent) || 0)))
const hasDownloadProgress = computed(() => state.value.progress?.percent != null && Number.isFinite(Number(state.value.progress.percent)))
const channelLabel = computed(() => state.value.channel === 'beta' ? '测试版' : '正式版')
const statusTitle = computed(() => state.value.release ? `v${state.value.release.version}` : ({
  idle: '发现更好的版本', checking: '正在检查新版本', upToDate: '已是当前最新版本', error: '更新暂未完成'
})[state.value.status] || '应用更新')
const sourceLabel = computed(() => {
  const source = state.value.status === 'downloading' ? state.value.progress?.source : state.value.source
  return ['proxy', 'mirror'].includes(source) ? '来源：git.tangbai.cc'
    : source === 'github' ? '来源：GitHub 原站' : source === 'cache' ? '来源：已验证缓存' : ''
})
const checkedAtLabel = computed(() => {
  const date = new Date(state.value.checkedAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
})
const publishedAtLabel = computed(() => {
  if (!state.value.release?.publishedAt) return ''
  const date = new Date(state.value.release.publishedAt)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
})
const statusText = computed(() => ({
  idle: state.value.message || '随时检查是否有新版本。',
  checking: '正在检查新版本…',
  upToDate: '当前渠道暂无更高版本。',
  available: '新版本已发布，可以下载更新包。',
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

<style scoped src="./AppUpdates.css"></style>
