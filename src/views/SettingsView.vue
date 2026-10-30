<template>
  <div class="settings-view" @focusout="flushPendingOnBlur">
    <div class="settings-body">
      <aside class="settings-sidebar">
        <div class="settings-wordmark">YOUR MUSIC<br><span>YOUR WAY.</span></div>
        <nav class="sidebar-nav" aria-label="设置分组">
          <button v-for="(section, index) in sections" :key="section.id" type="button" :class="['sidebar-item', { active: activeSection === section.id }]" :aria-current="activeSection === section.id ? 'location' : undefined" :aria-controls="section.id + '-section'" @click="scrollToSection(section.id)">
            <span class="nav-number">0{{ index + 1 }}</span>{{ section.label }}
          </button>
        </nav>
        <div class="sidebar-logo"><img src="/logo.png" alt=""><div>BetterKuGou<span>v{{ appVersion }}</span></div></div>
      </aside>
      <main class="settings-main" ref="settingsMain" aria-label="应用设置">
        <header class="settings-intro">
          <div><p class="eyebrow">PREFERENCES / 偏好设置</p><h1>让音乐，更合你意。</h1><p class="intro-description">从聆听习惯到界面细节，找到舒服的节奏。</p></div>
          <span class="save-status" :class="'is-' + saveState" role="status" aria-live="polite"><Transition name="ui-fade" mode="out-in"><span :key="saveState">{{ saveStatusText }}</span></Transition></span>
        </header>
        <Transition name="ui-fade" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false"><div v-if="settingsSaveError" class="settings-notice is-error" role="alert"><span>{{ settingsSaveError }}</span><button type="button" class="outline-btn" @click="flushEditableSettings">重试保存</button></div></Transition>
        <Transition name="ui-fade" mode="out-in"><p v-if="actionMessage" :key="actionMessage" class="settings-notice" role="status">{{ actionMessage }}</p></Transition>

        <section class="settings-section" id="playback-section" :ref="sectionRefs.playback" data-section="playback" aria-labelledby="playback-heading">
          <header class="section-header"><span class="section-number">01</span><div><h2 id="playback-heading">播放与歌词</h2><p>留住每次聆听时，你熟悉的习惯。</p></div></header>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="preferred-quality">优先音质</label><p class="setting-desc">后续歌曲优先使用所选音质；当前歌曲可在播放栏快速切换。可用音质取决于歌曲与账号权限。</p></div><AnimatedSelect id="preferred-quality" class="setting-select" v-model="localSettings.playback.quality" label="优先音质" :options="qualityOptions" /></div>
          <div v-for="option in playbackOptions" :key="option.id" class="setting-item">
            <div class="setting-info"><label class="setting-label" :for="'playback-' + option.id">{{ option.label }}</label><p class="setting-desc" :id="'playback-' + option.id + '-desc'">{{ option.description }}</p></div>
            <label class="setting-switch"><input :id="'playback-' + option.id" type="checkbox" v-model="localSettings.playback[option.id]" :aria-describedby="'playback-' + option.id + '-desc'"><span class="slider"></span></label>
          </div>
          <LyricSettings ref="lyricSettingsRef" v-model="localSettings.playback" :before-action="flushEditableSettings" :inert="isImporting" />
          <DesktopLyricSettings v-model="localSettings.desktopLyrics" :before-action="flushEditableSettings" />
          <div class="setting-group"><IslandLyricSettings v-model="localSettings.islandLyrics" :before-action="flushEditableSettings" :available="islandLyricsAvailable" /></div>
        </section>

        <section class="settings-section" id="custom-section" :ref="sectionRefs.custom" data-section="custom" aria-labelledby="custom-heading">
          <header class="section-header"><span class="section-number">02</span><div><h2 id="custom-heading">外观与主题</h2><p>熟悉的布局，加一点属于你的个性。</p></div></header>
          <fieldset class="setting-item setting-item--column"><legend class="setting-label">播放器样式</legend><p class="setting-desc">在底部显示经典播放栏，或轻盈的悬浮胶囊。</p><div class="radio-group"><label class="radio-option"><input type="radio" value="default" v-model="localSettings.custom.playerStyle"><span class="radio-option__display">经典播放栏<span>BetterKuGou 默认</span></span></label><label class="radio-option"><input type="radio" value="netease" v-model="localSettings.custom.playerStyle"><span class="radio-option__display">悬浮胶囊<span>网易云样式</span></span></label></div></fieldset>
          <div class="setting-group"><h3>主题与配色</h3><ThemePackages v-model="localSettings.custom" /></div>
          <Transition name="ui-fade" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false"><div v-if="localSettings.custom.theme === 'custom'" class="custom-color-panel"><label v-for="color in customColors" :key="color.id" class="color-setting"><span>{{ color.label }}</span><input type="color" v-model="localSettings.custom.customTheme[color.id]"></label></div></Transition>
          <ThemeAdjustments v-model="localSettings.custom" @open-studio="openThemeStudio" />
        </section>

        <section class="settings-section" id="shortcuts-section" :ref="sectionRefs.shortcuts" data-section="shortcuts" aria-labelledby="shortcuts-heading">
          <header class="section-header"><span class="section-number">03</span><div><h2 id="shortcuts-heading">快捷键</h2><p>让常用操作，离你再近一点。</p></div></header>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="enable-global">启用全局快捷键</label><p class="setting-desc" id="enable-global-desc">切换到其他应用后，也能控制音乐播放。</p></div><label class="setting-switch"><input id="enable-global" type="checkbox" v-model="localSettings.shortcuts.enableGlobal" aria-describedby="enable-global-desc"><span class="slider"></span></label></div>
          <div class="shortcut-grid"><div v-for="shortcut in shortcutList" :key="shortcut.id" class="shortcut-card" :class="{ 'is-editing': editingShortcut === shortcut.id, 'has-error': shortcutErrors[shortcut.id] }"><div class="shortcut-info"><div class="shortcut-label">{{ shortcut.label }}</div><div class="shortcut-desc">{{ shortcut.description }}</div></div><div class="shortcut-key-wrapper"><button type="button" class="shortcut-key" :aria-label="shortcut.label + '快捷键：' + formatShortcutKey(localSettings.shortcuts.keys[shortcut.id])" :aria-pressed="editingShortcut === shortcut.id" @click="startEditingShortcut(shortcut.id)"><Transition name="ui-fade" mode="out-in"><span v-if="editingShortcut === shortcut.id" key="recording" class="recording">按下按键…</span><span v-else :key="localSettings.shortcuts.keys[shortcut.id]">{{ formatShortcutKey(localSettings.shortcuts.keys[shortcut.id]) }}</span></Transition></button><Transition name="ui-pop"><button v-if="localSettings.shortcuts.keys[shortcut.id] && localSettings.shortcuts.keys[shortcut.id] !== 'Escape'" type="button" class="clear-shortcut-btn" :aria-label="'清除' + shortcut.label + '快捷键'" @click="clearShortcut(shortcut.id)">×</button></Transition></div><Transition name="ui-fade"><p v-if="shortcutErrors[shortcut.id]" class="shortcut-error" role="alert">{{ shortcutErrors[shortcut.id] }}</p></Transition></div></div>
          <p class="note-text">点击按键后输入新组合；按 Esc 清除绑定。相同组合不能重复绑定。</p>
        </section>

        <section class="settings-section" id="software-section" :ref="sectionRefs.software" data-section="software" aria-labelledby="software-heading">
          <header class="section-header"><span class="section-number">04</span><div><h2 id="software-heading">启动与应用</h2><p>下一次打开，接着上一次的心情。</p></div></header>
          <div v-for="option in softwareOptions" :key="option.id" class="setting-item"><div class="setting-info"><label class="setting-label" :for="'software-' + option.id">{{ option.label }}</label><p class="setting-desc" :id="'software-' + option.id + '-desc'">{{ option.description }}</p></div><label class="setting-switch"><input :id="'software-' + option.id" type="checkbox" v-model="localSettings.software[option.id]" :aria-describedby="'software-' + option.id + '-desc'"><span class="slider"></span></label></div>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="default-page">启动页面</label><p class="setting-desc">默认打开推荐；收藏页需要登录账号。</p></div><AnimatedSelect id="default-page" class="setting-select" v-model="localSettings.software.defaultPage" label="启动页面" :options="defaultPageOptions" /></div>
          <AppUpdates v-model="localSettings.software.updates" :before-action="flushEditableSettings" @current-version="appVersion = $event" />
          <div class="setting-group"><div class="group-heading"><div><h3>备份与迁移</h3><p class="setting-desc">导入或导出完整设置。分享配色请使用上方的主题包。</p></div></div><div class="setting-actions"><button class="outline-btn" :class="{ 'is-busy': isExporting }" :aria-busy="isExporting" type="button" @click="handleExportSettings" :disabled="isExporting || isImporting">{{ isExporting ? '导出中…' : '导出设置' }}</button><button class="outline-btn" :class="{ 'is-busy': isImporting }" :aria-busy="isImporting" type="button" @click="handleImportSettings" :disabled="isImporting || isExporting">{{ isImporting ? '导入中…' : '导入设置' }}</button></div></div>
          <div class="about-links"><button type="button" @click="openFeedbackUrl">反馈与建议 ↗</button><button type="button" @click="openLicenseUrl">使用协议 ↗</button><button type="button" @click="openProjectUrl">项目主页 ↗</button></div>
        </section>

        <section class="settings-section" id="download-section" :ref="sectionRefs.download" data-section="download" aria-labelledby="download-heading">
          <header class="section-header"><span class="section-number">05</span><div><h2 id="download-heading">下载与缓存</h2><p>听过的音乐，下次也能离线聆听。</p></div></header>
          <PlaylistCacheSettings v-model="localSettings.download" :before-action="flushEditableSettings" />
          <div class="setting-group"><h3>歌曲下载</h3><p class="setting-desc">导出音乐文件的下载服务尚未开放。</p><fieldset disabled class="unavailable-settings" aria-label="尚未开放的下载设置"><div class="setting-item"><div class="setting-info"><label class="setting-label" for="download-path">下载目录</label><p class="setting-desc">保留已保存的目录偏好。</p></div><input id="download-path" class="path-input" type="text" :value="localSettings.download.downloadPath || '尚未设置'" readonly></div></fieldset></div>
        </section>
        <footer class="settings-footer">BetterKuGou · 给每一首喜欢的音乐，一个舒服的位置。</footer>
      </main>
    </div>
  </div>
</template>

<script setup>
import { logger } from '../utils/logger.js'

import { reactive, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useSettingsStore } from '../stores/settingsStore.js'
import { cloneDeep, mergeDeep, replaceReactive } from '../utils/objectUtils.js'
import ThemePackages from '../components/common/ThemePackages.vue'
import ThemeAdjustments from '../components/common/ThemeAdjustments.vue'
import AppUpdates from '../components/common/AppUpdates.vue'
import PlaylistCacheSettings from '../components/common/PlaylistCacheSettings.vue'
import LyricSettings from '../components/common/LyricSettings.vue'
import DesktopLyricSettings from '../components/common/DesktopLyricSettings.vue'
import IslandLyricSettings from '../components/common/IslandLyricSettings.vue'
import AnimatedSelect from '../components/common/AnimatedSelect.vue'
import packageInfo from '../../package.json'
import { applyTheme } from '../utils/themeManager.js'

const emit = defineEmits(['close', 'settings-changed', 'open-theme-studio'])

async function openThemeStudio() {
  if (await flushEditableSettings()) emit('open-theme-studio')
}

// 桌面端由更新服务提供实际安装版本；浏览器预览使用构建版本。
const appVersion = ref(typeof packageInfo === 'object' ? packageInfo.version : '')

const sections = [
  { id: 'playback', label: '播放与歌词' },
  { id: 'custom', label: '外观与主题' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'software', label: '启动与应用' },
  { id: 'download', label: '下载与缓存' }
]
const editableGroups = ['playback', 'download', 'custom', 'shortcuts', 'software', 'desktopLyrics', 'islandLyrics']
const islandLyricsAvailable = Boolean(window.electronAPI?.islandLyric?.show)
const qualityOptions = [
  { value: '128', label: '标准 128 kbps' },
  { value: '320', label: '高品 320 kbps' },
  { value: 'flac', label: '无损 FLAC' },
  { value: 'high', label: '无损 HIGH' }
]
const defaultPageOptions = [{ value: 'home', label: '推荐首页' }, { value: 'favorites', label: '我的收藏' }]
const playbackOptions = [
  { id: 'fullscreenLyrics', label: '播放时自动打开全屏歌词', description: '每次开始播放，自动进入全屏歌词界面。' },
  { id: 'enqueueFullPlaylist', label: '播放时加入整个歌单', description: '点播歌单中的歌曲时，将同歌单的全部曲目加入播放列表。' },
  { id: 'restartOnPreviousNearEnd', label: '歌曲即将结束时，上一首从头播放', description: '开启后，歌曲剩余不超过 10 秒时点击上一首，将从头播放当前歌曲；关闭时正常切换到上一首。' }
]
const softwareOptions = [
  { id: 'autoLaunch', label: '开机自启动', description: '登录系统时自动运行 BetterKuGou。' },
  { id: 'minimizeToTray', label: '关闭窗口时保留在托盘', description: '继续在后台播放；可从托盘菜单退出应用。' },
  { id: 'restorePlaylist', label: '恢复上次的播放列表与位置', description: '再次打开时，找回上一次的队列和歌曲进度。' },
  { id: 'restorePlaybackState', label: '恢复上次的播放状态', description: '记住播放或暂停、音量和循环模式。' }
]
const customColors = [{ id: 'primary', label: '主题色' }, { id: 'hover', label: '悬浮强调色' }, { id: 'background', label: '背景色' }]

const activeSection = ref('playback')
const lyricSettingsRef = ref(null)
const settingsMain = ref(null)
const sectionRefs = {
  playback: ref(null),
  download: ref(null),
  custom: ref(null),
  shortcuts: ref(null),
  software: ref(null)
}

const shortcutList = ref([
  { id: 'playPause', label: '播放 / 暂停', description: '切换播放和暂停状态' },
  { id: 'nextTrack', label: '下一首', description: '播放下一首歌曲' },
  { id: 'prevTrack', label: '上一首', description: '播放上一首歌曲' },
  { id: 'volumeUp', label: '音量增加', description: '增加音量' },
  { id: 'volumeDown', label: '音量减少', description: '减少音量' },
  { id: 'toggleLyrics', label: '显示/隐藏歌词', description: '切换歌词显示' },
  { id: 'toggleFullscreen', label: '全屏模式', description: '切换全屏显示' },
  { id: 'bossKey', label: '老板键', description: '快速隐藏窗口' }
])

const editingShortcut = ref(null)
const shortcutErrors = ref({})
const shortcutErrorTimers = new Map()
function showShortcutError(id, message) {
  clearTimeout(shortcutErrorTimers.get(id))
  shortcutErrors.value[id] = message
  shortcutErrorTimers.set(id, setTimeout(() => { delete shortcutErrors.value[id]; shortcutErrorTimers.delete(id) }, 3000))
}

const {
  settings,
  ready,
  updateSettings,
  revision,
  exportSettings,
  importSettings,
  chooseDirectory,
  defaults
} = useSettingsStore()

// 设置页只持有可编辑分区，会话由 store 和播放器负责。
const ensureDefaults = (source) => {
  const defaultSettings = defaults()
  const merged = {}
  for (const id of editableGroups) {
    merged[id] = cloneDeep(defaultSettings[id])
    if (source?.[id] && typeof source[id] === 'object') {
      mergeDeep(merged[id], cloneDeep(source[id]))
    }
  }
  return merged
}

const localSettings = reactive(ensureDefaults(settings))
let syncedSettings = cloneDeep(localSettings)
const isSyncingFromStore = ref(false)
const containerPaddingTop = ref(0)
let scrollListener = null
let resizeListener = null
let scrollRafId = null
let scrollContainer = null
let saveTimer = null
const isExporting = ref(false)
const isImporting = ref(false)
const isChoosingPath = ref(false)
const settingsSaveError = ref('')
const actionMessage = ref('')
const saveState = ref('saved')
let saveTask = null
let recoveringAppearance = false
const saveStatusText = computed(() => ({ saved: '所有更改已保存', pending: '等待保存…', saving: '正在保存…', error: '更改尚未保存' })[saveState.value])

// 只提交用户实际编辑的字段，保留同一分区中的外部更新。
function collectSettingsPatch(current, baseline) {
  const patch = {}
  for (const [key, value] of Object.entries(current)) {
    const previous = baseline?.[key]
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        previous && typeof previous === 'object' && !Array.isArray(previous)) {
      const nested = collectSettingsPatch(value, previous)
      if (Object.keys(nested).length) patch[key] = nested
    } else if (JSON.stringify(value) !== JSON.stringify(previous)) {
      patch[key] = cloneDeep(value)
    }
  }
  return patch
}

function syncFromStore() {
  if (!ready.value || saveTask || recoveringAppearance) return
  const incoming = ensureDefaults(settings)
  if (JSON.stringify(incoming) === JSON.stringify(syncedSettings)) return
  const pending = collectSettingsPatch(localSettings, syncedSettings)
  syncedSettings = cloneDeep(incoming)
  mergeDeep(incoming, pending)
  isSyncingFromStore.value = true
  try {
    replaceReactive(localSettings, incoming)
  } finally {
    // 使用 nextTick 确保所有响应式更新完成后再恢复标志
    nextTick(() => {
      isSyncingFromStore.value = false
    })
  }
}

watch(ready, (value) => {
  if (value) syncFromStore()
}, { immediate: true })

watch(revision, () => {
  syncFromStore()
  // 会话广播应用的是已提交主题；恢复本页未保存的主题预览，防止播放中闪回。
  if (ready.value) applyTheme({ custom: localSettings.custom })
})

// 主题编辑立即预览，持久化仍走设置页已有的串行保存流程。
watch(() => localSettings.custom, (custom) => {
  if (ready.value) applyTheme({ custom })
}, { deep: true })

async function persistEditableSettings() {
  if (saveTask) return saveTask
  if (!ready.value || recoveringAppearance) return false
  const patch = collectSettingsPatch(localSettings, syncedSettings)
  if (!Object.keys(patch).length) {
    saveState.value = 'saved'
    settingsSaveError.value = ''
    return true
  }
  const submitted = cloneDeep(localSettings)
  saveState.value = 'saving'
  // 保存期间忽略 store 的乐观广播；落盘后再合并外部更新和本页的后续编辑。
  saveTask = Promise.resolve().then(async () => {
    try {
      await updateSettings(patch)
      const laterEdits = collectSettingsPatch(localSettings, submitted)
      syncedSettings = ensureDefaults(settings)
      const next = mergeDeep(cloneDeep(syncedSettings), laterEdits)
      isSyncingFromStore.value = true
      replaceReactive(localSettings, next)
      await nextTick()
      isSyncingFromStore.value = false
      settingsSaveError.value = ''
      saveState.value = Object.keys(laterEdits).length ? 'pending' : 'saved'
      emit('settings-changed', cloneDeep(localSettings))
      return true
    } catch (err) {
      settingsSaveError.value = '保存失败，你的修改仍保留在此页。请重试保存。'
      saveState.value = 'error'
      logger.error('SettingsView', '[SettingsView] 更新设置失败:', err)
      return false
    } finally {
      saveTask = null
    }
  })
  return saveTask
}

/** 离焦、离页及导出前排空防抖与正在执行的保存，不把旧配置导出。 */
async function flushEditableSettings() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  do {
    if (!await persistEditableSettings()) return false
  } while (Object.keys(collectSettingsPatch(localSettings, syncedSettings)).length)
  return true
}

/** 离页及整份设置替换共用正文保护，不能将未保存歌词当作偏好自动覆盖。 */
function prepareLyricLibraryLeave() {
  return lyricSettingsRef.value?.prepareLeave?.() !== false
}

/** Recovery supersedes unsaved appearance edits, including edits made during an earlier in-flight save. */
async function prepareThemeRecovery(base) {
  recoveringAppearance = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  // An existing transaction may still commit its captured theme; recovery is queued after it.
  if (saveTask) await saveTask
  const committed = ensureDefaults(settings).custom
  const themeFields = ['theme', 'themePackages', 'themeAdjustmentId', 'customTheme']
  isSyncingFromStore.value = true
  for (const field of themeFields) {
    localSettings.custom[field] = cloneDeep(committed[field])
    syncedSettings.custom[field] = cloneDeep(committed[field])
  }
  localSettings.custom.theme = base
  syncedSettings.custom.theme = base
  await nextTick()
  isSyncingFromStore.value = false
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  return async () => {
    // Read the actual committed result on success or rollback; no old theme draft remains to replay.
    const current = ensureDefaults(settings).custom
    isSyncingFromStore.value = true
    for (const field of themeFields) {
      localSettings.custom[field] = cloneDeep(current[field])
      syncedSettings.custom[field] = cloneDeep(current[field])
    }
    await nextTick()
    isSyncingFromStore.value = false
    recoveringAppearance = false
    syncFromStore()
    await nextTick()
    if (Object.keys(collectSettingsPatch(localSettings, syncedSettings)).length) {
      saveState.value = 'pending'
      saveTimer = setTimeout(() => { saveTimer = null; void flushEditableSettings() }, 500)
    }
  }
}

function flushPendingOnBlur(event) {
  if (event.target?.matches('input, [role="combobox"], [aria-haspopup="listbox"]')) void flushEditableSettings()
}

watch(localSettings, () => {
  if (isSyncingFromStore.value || !ready.value || recoveringAppearance) return
  saveState.value = 'pending'
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushEditableSettings()
  }, 500)
}, { deep: true })

function scrollToSection(sectionId) {
  activeSection.value = sectionId
  nextTick(() => {
    const target = sectionRefs[sectionId]?.value
    const container = settingsMain.value

    if (!target || !container) {
      logger.warn('SettingsView', 'Target or container not found:', { target, container, sectionId })
      return
    }

    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const scrollTop = container.scrollTop
    const offset = targetRect.top - containerRect.top + scrollTop

    container.scrollTo({
      top: offset - 20,
      behavior: 'smooth'
    })
  })
}

async function handleExportSettings() {
  if (isExporting.value) return
  isExporting.value = true
  try {
    if (!await flushEditableSettings()) return
    const result = await exportSettings()
    if (result?.error) throw result.error
    if (result?.reason === 'unsupported') throw new Error('Export is unavailable')
    if (result?.canceled) return
    actionMessage.value = '设置已导出。'
  } catch (err) {
    actionMessage.value = '导出失败，请稍后重试。'
    logger.error('SettingsView', '[SettingsView] 导出设置失败:', err)
  } finally {
    isExporting.value = false
  }
}

async function handleImportSettings() {
  if (isImporting.value || !prepareLyricLibraryLeave()) return
  isImporting.value = true
  try {
    if (!await flushEditableSettings()) return
    if (!prepareLyricLibraryLeave()) return
    const result = await importSettings()
    if (result?.error) throw result.error
    if (result?.reason === 'unsupported') throw new Error('Import is unavailable')
    if (result?.canceled) return
    syncedSettings = ensureDefaults(settings)
    isSyncingFromStore.value = true
    replaceReactive(localSettings, syncedSettings)
    await nextTick()
    isSyncingFromStore.value = false
    settingsSaveError.value = ''
    saveState.value = 'saved'
    actionMessage.value = '设置已导入并应用。'
    logger.info('SettingsView', '[SettingsView] 设置导入成功')
  } catch (err) {
    actionMessage.value = '导入失败，原设置已保留。请检查文件格式。'
    logger.error('SettingsView', '[SettingsView] 导入设置失败:', err)
  } finally {
    isImporting.value = false
  }
}

async function handleSelectPath(type) {
  if (isChoosingPath.value) return
  isChoosingPath.value = true
  try {
    const currentValue = type === 'download'
      ? localSettings.download.downloadPath
      : localSettings.download.cachePath

    const result = await chooseDirectory({
      title: type === 'download' ? '选择下载目录' : '选择缓存目录',
      defaultPath: currentValue || undefined,
      buttonLabel: '选择'
    })
    if (result?.canceled || !result?.path) return

    if (type === 'download') {
      localSettings.download.downloadPath = result.path
    } else {
      localSettings.download.cachePath = result.path
    }
  } catch (err) {
    logger.error('SettingsView', '[SettingsView] 选择目录失败:', err)
  } finally {
    isChoosingPath.value = false
  }
}

function handleSelectDownloadPath() {
  return handleSelectPath('download')
}

function handleSelectCachePath() {
  return handleSelectPath('cache')
}

// 快捷键相关函数
function formatShortcutKey(key) {
  if (!key || key === 'Escape') return '未设置'
  return key
    .replace(/Control/g, 'Ctrl')
    .replace(/\+/g, ' + ')
}

function startEditingShortcut(shortcutId) {
  editingShortcut.value = shortcutId
  delete shortcutErrors.value[shortcutId]
  
  // 设置全局标志,阻止触发其他快捷键
  window.__editingShortcut = true
  
  // 添加键盘监听
  document.addEventListener('keydown', handleShortcutKeyDown, { capture: true })
}

function stopEditingShortcut() {
  editingShortcut.value = null
  
  // 清除全局标志
  window.__editingShortcut = false
  
  document.removeEventListener('keydown', handleShortcutKeyDown, { capture: true })
}

async function handleShortcutKeyDown(event) {
  if (!editingShortcut.value) return
  
  event.preventDefault()
  event.stopPropagation()
  
  // 按 ESC 清除快捷键
  if (event.key === 'Escape') {
    localSettings.shortcuts.keys[editingShortcut.value] = 'Escape'
    stopEditingShortcut()
    return
  }
  
  // 构建快捷键字符串
  const keys = []
  if (event.ctrlKey || event.metaKey) keys.push('Control')
  if (event.altKey) keys.push('Alt')
  if (event.shiftKey) keys.push('Shift')
  
  // 获取主键
  let mainKey = event.key
  
  // 特殊键映射
  const keyMap = {
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    ' ': 'Space'
  }
  
  mainKey = keyMap[mainKey] || mainKey
  
  // 忽略单独的修饰键
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(mainKey)) {
    return
  }
  
  keys.push(mainKey)
  const shortcutKey = keys.join('+')
  
  // 检查是否与其他快捷键冲突
  const shortcutId = editingShortcut.value
  const conflict = shortcutList.value.find(s =>
    s.id !== editingShortcut.value && 
    localSettings.shortcuts.keys[s.id] === shortcutKey
  )
  
  if (conflict) {
    showShortcutError(shortcutId, `与"${conflict.label}"冲突`)
    stopEditingShortcut()
    return
  }
  
  // 尝试注册全局快捷键（如果启用）
  if (localSettings.shortcuts.enableGlobal) {
    const registered = await tryRegisterGlobalShortcut(shortcutKey)
    if (editingShortcut.value !== shortcutId) return
    if (!registered) {
      showShortcutError(shortcutId, '无法注册此快捷键')
      stopEditingShortcut()
      return
    }
  }
  
  // 设置快捷键
  localSettings.shortcuts.keys[editingShortcut.value] = shortcutKey
  delete shortcutErrors.value[editingShortcut.value]
  stopEditingShortcut()
}

function clearShortcut(shortcutId) {
  localSettings.shortcuts.keys[shortcutId] = 'Escape'
  delete shortcutErrors.value[shortcutId]
}

async function tryRegisterGlobalShortcut(key) {
  // 如果未启用全局快捷键,直接返回成功
  if (!localSettings.shortcuts.enableGlobal) {
    return true
  }
  
  // 测试是否能注册全局快捷键
  if (window.electronAPI?.testGlobalShortcut) {
    try {
      const result = await window.electronAPI.testGlobalShortcut(key)
      if (!result?.canRegister) {
        logger.warn('SettingsView', '⚠️ 快捷键无法注册:', key)
      }
      return Boolean(result?.canRegister)
    } catch (err) {
      logger.error('SettingsView', '测试快捷键注册失败:', err)
      return false
    }
  }
  
  // 开发模式或 Electron API 不可用时默认返回成功
  return true
}

function updateActiveSection() {
  const container = scrollContainer || settingsMain.value
  if (!container) return

  let closestId = null
  let closestDistance = Infinity
  const containerRect = container.getBoundingClientRect()

  sections.forEach((section) => {
    const el = sectionRefs[section.id]?.value
    if (!el) return

    const targetRect = el.getBoundingClientRect()
    const relativeTop = targetRect.top - containerRect.top + container.scrollTop - containerPaddingTop.value
    const distance = Math.abs(relativeTop - container.scrollTop)

    if (distance < closestDistance) {
      closestDistance = distance
      closestId = section.id
    }
  })

  if (closestId) {
    activeSection.value = closestId
  }
}

function setupScrollTracking() {
  const container = settingsMain.value
  if (!container) return

  scrollContainer = container

  const computedStyle = window.getComputedStyle(container)
  containerPaddingTop.value = parseFloat(computedStyle.paddingTop) || 0

  scrollListener = () => {
    if (scrollRafId) {
      window.cancelAnimationFrame(scrollRafId)
    }
    scrollRafId = window.requestAnimationFrame(() => {
      updateActiveSection()
    })
  }

  container.addEventListener('scroll', scrollListener, { passive: true })

  resizeListener = () => {
    updateActiveSection()
  }
  window.addEventListener('resize', resizeListener, { passive: true })

  updateActiveSection()
}

function teardownScrollTracking() {
  if (scrollContainer && scrollListener) {
    scrollContainer.removeEventListener('scroll', scrollListener)
  }
  if (resizeListener) {
    window.removeEventListener('resize', resizeListener)
  }
  if (scrollRafId) {
    window.cancelAnimationFrame(scrollRafId)
    scrollRafId = null
  }
  scrollContainer = null
}

// URL 跳转处理函数
function openFeedbackUrl() {
  const url = 'https://github.com/YuanXiaCN/BetterKuGou/issues'
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

function openProjectUrl() {
  const url = 'https://github.com/YuanXiaCN/BetterKuGou'
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

function openLicenseUrl() {
  const url = 'https://github.com/YuanXiaCN/BetterKuGou?tab=License-1-ov-file'
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

onMounted(() => {
  nextTick(() => {
    setupScrollTracking()
  })
})

onBeforeUnmount(() => {
  teardownScrollTracking()
  stopEditingShortcut() // 清理快捷键编辑监听器
  for (const timer of shortcutErrorTimers.values()) clearTimeout(timer)
  shortcutErrorTimers.clear()
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void flushEditableSettings()
})

defineExpose({
  scrollToSection,
  async flushEditableSettings() {
    if (!prepareLyricLibraryLeave()) return false
    return flushEditableSettings()
  },
  prepareThemeRecovery
})
</script>

<style src="./styles/SettingsView.css" scoped></style>
