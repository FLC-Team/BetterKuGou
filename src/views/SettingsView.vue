<template>
  <div class="settings-view">

    <div class="settings-body">
      <aside class="settings-sidebar">
        <nav class="sidebar-nav">
          <button
            v-for="section in sections"
            :key="section.id"
            :class="['sidebar-item', { active: activeSection === section.id }]"
            type="button"
            @click="scrollToSection(section.id)"
          >
            {{ section.label }}
          </button>
        </nav>
        <div class="sidebar-logo">
          <img src="/logo.png" alt="BetterKugou Logo">
          <span>BetterKugou</span>
          <div class="version-info">v{{ appVersion }}</div>
        </div>
      </aside>

      <main class="settings-main" ref="settingsMain">
        <section class="settings-section" id="playback-section" :ref="sectionRefs.playback" data-section="playback">
          <header class="section-header">
            <h2 class="section-title">播放设置</h2>
          </header>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">播放音乐时，自动拉起全屏歌词</div>
              <div class="setting-desc">启用后，每次播放都会进入全屏歌词界面</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" v-model="localSettings.playback.fullscreenLyrics">
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">在歌单中播放歌曲，自动将全部歌单歌曲加入播放列表</div>
              <div class="setting-desc">开启后，播放歌单内任意歌曲时，将歌单全部歌曲加入播放列表</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" v-model="localSettings.playback.enqueueFullPlaylist">
              <span class="slider"></span>
            </label>
          </div>
        </section>

  <section class="settings-section" id="download-section" :ref="sectionRefs.download" data-section="download">
          <header class="section-header">
            <h2 class="section-title">下载与缓存</h2>
          </header>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">默认下载目录</div>
              <div class="setting-desc">下载的音乐文件将保存到此目录</div>
            </div>
            <div class="setting-path">
              <input type="text" class="path-input" :value="localSettings.download.downloadPath" readonly>
              <button class="path-btn" type="button" @click="handleSelectDownloadPath" :disabled="isChoosingPath">
                {{ isChoosingPath ? '选择中…' : '更改目录' }}
              </button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">默认缓存目录</div>
              <div class="setting-desc">临时缓存文件将存放在此目录</div>
            </div>
            <div class="setting-path">
              <input type="text" class="path-input" :value="localSettings.download.cachePath" readonly>
              <button class="path-btn" type="button" @click="handleSelectCachePath" :disabled="isChoosingPath">
                {{ isChoosingPath ? '选择中…' : '更改目录' }}
              </button>
            </div>
          </div>
          <div class="setting-item setting-item--stack">
            <div class="setting-info">
              <div class="setting-label">缓存大小设置</div>
              <div class="setting-desc">当前选择：{{ currentCacheSizeLabel }}</div>
            </div>
            <div class="setting-slider">
              <input
                type="range"
                :min="0"
                :max="cacheSizeOptions.length - 1"
                v-model.number="localSettings.download.cacheSizeIndex"
              >
              <div class="slider-scale">
                <span>2048M</span>
                <span>无限制</span>
              </div>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">同时下载文件数量</div>
              <div class="setting-desc">可同时下载的任务数，范围 1-10</div>
            </div>
            <input
              class="number-input"
              type="number"
              min="1"
              max="10"
              v-model.number="localSettings.download.concurrentDownloads"
            >
          </div>
        </section>

  <section class="settings-section" id="custom-section" :ref="sectionRefs.custom" data-section="custom">
          <header class="section-header">
            <h2 class="section-title">自定义功能</h2>
          </header>
          <div class="setting-actions">
            <button class="outline-btn" type="button" @click="handleExportSettings" :disabled="isExporting">
              {{ isExporting ? '导出中…' : '导出设置' }}
            </button>
            <button class="outline-btn" type="button" @click="handleImportSettings" :disabled="isImporting">
              {{ isImporting ? '导入中…' : '导入设置' }}
            </button>
          </div>

          <div class="setting-group">
            <h3 class="setting-subtitle">样式设置</h3>
            <div class="setting-item setting-item--column">
              <div class="setting-info">
                <div class="setting-label">默认播放器样式</div>
                <div class="setting-desc">选择最适合你的播放器界面</div>
              </div>
              <div class="radio-group">
                <label class="radio-option">
                  <input type="radio" value="default" v-model="localSettings.custom.playerStyle">
                  <span class="radio-option__display">
                    <span class="radio-option__dot"></span>
                    <span class="radio-option__label">BetterKuGou 默认样式</span>
                  </span>
                </label>
                <label class="radio-option">
                  <input type="radio" value="netease" v-model="localSettings.custom.playerStyle">
                  <span class="radio-option__display">
                    <span class="radio-option__dot"></span>
                    <span class="radio-option__label">网易云样式 · 悬浮胶囊</span>
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div class="setting-group">
            <h3 class="setting-subtitle">主题与配色</h3>
            <div class="setting-item setting-item--column">
              <ThemePackages v-model="localSettings.custom" />
              <p v-if="settingsSaveError" class="note-text" role="alert">{{ settingsSaveError }}</p>
            </div>

            <transition name="fade">
              <div v-if="localSettings.custom.theme === 'custom'" class="custom-color-panel">
                <div class="setting-item setting-item--column">
                  <div class="setting-info setting-info--inline">
                    <div class="setting-label">
                      默认主题色
                      <span class="tooltip-icon" title="影响字体选中颜色、按钮背景色、标签颜色">?</span>
                    </div>
                  </div>
                  <input type="color" v-model="localSettings.custom.customTheme.primary" class="color-input">
                </div>
                <div class="setting-item setting-item--column">
                  <div class="setting-info setting-info--inline">
                    <div class="setting-label">
                      默认悬浮颜色
                      <span class="tooltip-icon" title="影响鼠标悬浮时的字体颜色与按钮背景色">?</span>
                    </div>
                  </div>
                  <input type="color" v-model="localSettings.custom.customTheme.hover" class="color-input">
                </div>
                <div class="setting-item setting-item--column">
                  <div class="setting-info setting-info--inline">
                    <div class="setting-label">
                      背景颜色
                      <span class="tooltip-icon" title="影响主页、收藏页与歌单页面的背景">?</span>
                    </div>
                  </div>
                  <input type="color" v-model="localSettings.custom.customTheme.background" class="color-input">
                </div>
                <p class="note-text">调整完成后可导出为主题包；更多字体、圆角和歌词样式可在主题包中配置。</p>
              </div>
            </transition>
          </div>
        </section>

  <section class="settings-section" id="shortcut-section" :ref="sectionRefs.shortcuts" data-section="shortcuts">
          <header class="section-header">
            <h2 class="section-title">快捷键</h2>
          </header>
          
          <div v-if="!localSettings.shortcuts" class="setting-item">
            <div class="setting-info">
              <div class="setting-label">加载中...</div>
              <div class="setting-desc">正在加载快捷键设置</div>
            </div>
          </div>
          
          <div v-else>
            <!-- 全局快捷键开关 -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-label">启用全局快捷键</div>
                <div class="setting-desc">允许在应用程序失去焦点时也能响应快捷键</div>
              </div>
              <label class="setting-switch">
                <input type="checkbox" v-model="localSettings.shortcuts.enableGlobal">
                <span class="slider"></span>
              </label>
            </div>

            <!-- 快捷键列表 -->
            <div class="shortcut-grid">
            <div 
              v-for="shortcut in shortcutList" 
              :key="shortcut.id"
              class="shortcut-card"
              :class="{ 
                'is-editing': editingShortcut === shortcut.id,
                'has-error': shortcutErrors[shortcut.id]
              }"
            >
              <div class="shortcut-info">
                <div class="shortcut-label">{{ shortcut.label }}</div>
                <div class="shortcut-desc">{{ shortcut.description }}</div>
              </div>
              <div class="shortcut-key-wrapper">
                <button 
                  class="shortcut-key"
                  :class="{ 'is-error': shortcutErrors[shortcut.id] }"
                  @click="startEditingShortcut(shortcut.id)"
                  type="button"
                >
                  <span v-if="editingShortcut === shortcut.id" class="recording">
                    按下按键...
                  </span>
                  <span v-else class="key-display">
                    {{ formatShortcutKey(localSettings.shortcuts.keys[shortcut.id]) }}
                  </span>
                </button>
                <button 
                  v-if="localSettings.shortcuts.keys[shortcut.id] && localSettings.shortcuts.keys[shortcut.id] !== 'Escape'"
                  class="clear-shortcut-btn"
                  @click="clearShortcut(shortcut.id)"
                  type="button"
                  title="清除快捷键"
                >
                  ×
                </button>
              </div>
              <div v-if="shortcutErrors[shortcut.id]" class="shortcut-error">
                {{ shortcutErrors[shortcut.id] }}
              </div>
            </div>
          </div>
          
          <p class="note-text">按 ESC 键可清除快捷键绑定</p>
          </div>
        </section>

  <section class="settings-section" id="software-section" :ref="sectionRefs.software" data-section="software">
          <header class="section-header">
            <h2 class="section-title">软件设置</h2>
          </header>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">开机自启动</div>
              <div class="setting-desc">启动系统时自动运行 BetterKugou</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" v-model="localSettings.software.autoLaunch">
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">点击关闭按钮时，将应用驻留至托盘</div>
              <div class="setting-desc">启用后，点击关闭按钮不会退出程序，而是将应用最小化到系统托盘</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" v-model="localSettings.software.minimizeToTray">
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">打开软件时恢复上一次的播放列表和播放位置</div>
              <div class="setting-desc">保存并还原上一次的播放队列和播放进度</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" v-model="localSettings.software.restorePlaylist">
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">打开软件时恢复上一次的播放状态</div>
              <div class="setting-desc">记住播放/暂停状态以及循环模式等播放设置</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" v-model="localSettings.software.restorePlaybackState">
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-item setting-item--column">
            <div class="setting-info">
              <div class="setting-label">默认页面</div>
              <div class="setting-desc">选择启动软件时打开的页面</div>
            </div>
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" value="home" v-model="localSettings.software.defaultPage">
                <span class="radio-option__display">
                  <span class="radio-option__dot"></span>
                  <span class="radio-option__label">推荐（主页）</span>
                </span>
              </label>
              <label class="radio-option">
                <input type="radio" value="favorites" v-model="localSettings.software.defaultPage">
                <span class="radio-option__display">
                  <span class="radio-option__dot"></span>
                  <span class="radio-option__label">我的收藏</span>
                </span>
              </label>
            </div>
          </div>
          <div class="setting-item setting-item--actions">
            <button class="outline-btn" type="button">检查更新</button>
            <button class="outline-btn" type="button" @click="openFeedbackUrl">反馈 / 建议</button>
            <button class="outline-btn" type="button" @click="openLicenseUrl">使用协议</button>
            <button class="outline-btn" type="button" @click="openProjectUrl">项目主页（真的不给个Star嘛）</button>
          </div>
          <div class="setting-item setting-item--center">
            <img class="software-logo" src="/logo.png" alt="BetterKugou Logo">
          </div>
        </section>
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
import { applyTheme } from '../utils/themeManager.js'

const emit = defineEmits(['close', 'settings-changed'])

// 从 package.json 获取版本信息
const appVersion = ref('0.1.4-alpha-pre1')

const sections = [
  { id: 'playback', label: '播放设置' },
  { id: 'download', label: '下载与缓存' },
  { id: 'custom', label: '自定义功能' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'software', label: '软件设置' }
]

const activeSection = ref('playback')
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

const cacheSizeOptions = [
  { value: 2048, label: '2048 MB' },
  { value: 4096, label: '4096 MB' },
  { value: 6144, label: '6144 MB' },
  { value: 8192, label: '8192 MB' },
  { value: 10240, label: '10240 MB' },
  { value: -1, label: '无限制' }
]

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
  for (const { id } of sections) {
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

const currentCacheSizeLabel = computed(() => {
  const index = localSettings?.download?.cacheSizeIndex ?? 0
  return cacheSizeOptions[index]?.label || '无限制'
})

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
  if (!ready.value) return
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
  if (!ready.value) return
  const patch = collectSettingsPatch(localSettings, syncedSettings)
  if (!Object.keys(patch).length) return
  try {
    await updateSettings(patch)
    settingsSaveError.value = ''
    syncFromStore()
    emit('settings-changed', cloneDeep(localSettings))
  } catch (err) {
    settingsSaveError.value = '设置保存失败，修改尚未保存。请重新操作以重试。'
    logger.error('SettingsView', '[SettingsView] 更新设置失败:', err)
  }
}

watch(localSettings, () => {
  if (isSyncingFromStore.value || !ready.value) return
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    void persistEditableSettings()
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
    const result = await exportSettings()
    if (result?.canceled) return
    logger.info('SettingsView', '[SettingsView] 设置已导出到:', result.path)
  } catch (err) {
    logger.error('SettingsView', '[SettingsView] 导出设置失败:', err)
  } finally {
    isExporting.value = false
  }
}

async function handleImportSettings() {
  if (isImporting.value) return
  isImporting.value = true
  try {
    const result = await importSettings()
    if (result?.canceled) return
    syncedSettings = ensureDefaults(settings)
    isSyncingFromStore.value = true
    replaceReactive(localSettings, syncedSettings)
    await nextTick()
    isSyncingFromStore.value = false
    logger.info('SettingsView', '[SettingsView] 设置导入成功')
  } catch (err) {
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

function handleShortcutKeyDown(event) {
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
  const conflict = shortcutList.value.find(s => 
    s.id !== editingShortcut.value && 
    localSettings.shortcuts.keys[s.id] === shortcutKey
  )
  
  if (conflict) {
    shortcutErrors.value[editingShortcut.value] = `与"${conflict.label}"冲突`
    setTimeout(() => {
      delete shortcutErrors.value[editingShortcut.value]
    }, 3000)
    stopEditingShortcut()
    return
  }
  
  // 尝试注册全局快捷键（如果启用）
  if (localSettings.shortcuts.enableGlobal) {
    // TODO: 调用 Electron API 注册全局快捷键
    // 这里需要检查注册是否成功
    const registered = tryRegisterGlobalShortcut(shortcutKey)
    if (!registered) {
      shortcutErrors.value[editingShortcut.value] = '无法注册此快捷键'
      setTimeout(() => {
        delete shortcutErrors.value[editingShortcut.value]
      }, 3000)
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

function tryRegisterGlobalShortcut(key) {
  // 如果未启用全局快捷键,直接返回成功
  if (!localSettings.shortcuts.enableGlobal) {
    return true
  }
  
  // 测试是否能注册全局快捷键
  if (window.electronAPI?.testGlobalShortcut) {
    try {
      const result = window.electronAPI.testGlobalShortcut(key)
      if (!result) {
        logger.warn('SettingsView', '⚠️ 快捷键无法注册:', key)
      }
      return result
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
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void persistEditableSettings()
})

defineExpose({
  scrollToSection
})
</script>

<style src="./styles/SettingsView.css" scoped></style>
