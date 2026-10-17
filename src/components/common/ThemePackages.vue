<template>
  <div class="theme-packages">
    <div class="theme-heading">
      <div>
        <div class="theme-label">主题包</div>
        <p class="theme-description">选择喜欢的主题，或导入他人分享的主题包。切换后立即生效。</p>
      </div>
      <span class="theme-current">当前：{{ currentThemeName }}</span>
    </div>

    <TransitionGroup name="ui-list" tag="div" class="theme-grid ui-list-container" aria-label="可用主题包" @before-leave="freezeGridLeave" @before-enter="clearGridLeave" @leave-cancelled="clearGridLeave">
      <article
        v-for="theme in availableThemes"
        :key="theme.id"
        class="theme-card"
        :class="{ 'is-selected': selectedTheme === theme.id }"
      >
        <button
          type="button"
          class="theme-card-select"
          :aria-pressed="selectedTheme === theme.id"
          @click="selectTheme(theme.id)"
        >
          <span class="theme-preview" :style="previewStyle(theme)" aria-hidden="true">
            <span class="theme-preview-sidebar"></span>
            <span class="theme-preview-content">
              <span class="theme-preview-title"></span>
              <span class="theme-preview-tiles"><i></i><i></i><i></i></span>
              <span class="theme-preview-player"></span>
            </span>
          </span>
          <span class="theme-card-heading">
            <span class="theme-name">{{ theme.name }}</span>
            <span class="theme-badge">{{ selectedTheme === theme.id ? '使用中' : isBuiltin(theme.id) ? '内置' : '已导入' }}</span>
          </span>
          <span class="theme-card-description">{{ theme.description || `${theme.base === 'light' ? '浅色' : '深色'}主题` }}</span>
          <span v-if="theme.author" class="theme-author">{{ theme.author }} · v{{ theme.version }}</span>
        </button>
        <button
          v-if="!isBuiltin(theme.id)"
          type="button"
          class="theme-remove"
          :aria-label="`移除主题 ${theme.name}`"
          @click="removeTheme(theme.id)"
        >
          移除主题
        </button>
      </article>
    </TransitionGroup>

    <div class="theme-modes" aria-label="其他主题模式">
      <button
        type="button"
        class="btn btn-secondary theme-mode"
        :class="{ 'is-selected': selectedTheme === 'system' }"
        :aria-pressed="selectedTheme === 'system'"
        @click="selectTheme('system')"
      >
        跟随系统
      </button>
      <button
        type="button"
        class="btn btn-secondary theme-mode"
        :class="{ 'is-selected': selectedTheme === 'custom' }"
        :aria-pressed="selectedTheme === 'custom'"
        @click="selectTheme('custom')"
      >
        自定义配色
      </button>
    </div>

    <div class="theme-share">
      <div class="theme-label">分享当前主题</div>
      <p class="theme-description">导出独立的主题包文件，分享给其他用户后即可导入使用。</p>
      <div class="theme-metadata">
        <label>
          <span>主题名称</span>
          <input v-model="exportName" class="input" type="text" maxlength="80" placeholder="为主题起个名字">
        </label>
        <label>
          <span>作者（选填）</span>
          <input v-model="exportAuthor" class="input" type="text" maxlength="80" placeholder="你的昵称">
        </label>
      </div>
      <div class="theme-actions">
        <button class="btn btn-primary" type="button" :disabled="isExporting || isImporting" @click="exportTheme">
          {{ isExporting ? '导出中…' : '导出当前主题' }}
        </button>
        <button class="btn btn-secondary" type="button" :disabled="isImporting || isExporting" @click="fileInput?.click()">
          {{ isImporting ? '导入中…' : '导入主题包' }}
        </button>
        <input
          ref="fileInput"
          class="theme-file-input"
          type="file"
          accept=".bk-theme.json,.json,application/json"
          aria-label="选择主题包文件"
          @change="importTheme"
        >
      </div>
      <p class="theme-description theme-file-hint">支持 .bk-theme.json 或 .json 文件，最大 {{ maxFileSizeLabel }}。</p>
    </div>

    <Transition name="ui-fade" mode="out-in"><p
      v-if="message"
      :key="messageKey"
      class="theme-message"
      :class="{ 'is-error': messageType === 'error' }"
      :role="messageType === 'error' ? 'alert' : 'status'"
    >
      {{ message }}
    </p></Transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { freezeGridLeave, clearGridLeave } from './motionLayout.js'
import {
  BUILTIN_THEMES,
  MAX_THEME_FILE_BYTES,
  MAX_INSTALLED_THEMES,
  getThemePackage,
  listThemePackages,
  normalizeThemePackage,
  parseThemePackage,
  serializeThemePackage
} from '../../themes/themePackages.js'
import { createThemePackage } from '../../utils/themeManager.js'

const props = defineProps({
  modelValue: { type: Object, required: true }
})
const emit = defineEmits(['update:modelValue'])

const fileInput = ref(null)
const isImporting = ref(false)
const isExporting = ref(false)
const message = ref('')
const messageKey = ref(0)
const messageType = ref('success')
const exportName = ref('')
const exportAuthor = ref('')
const builtinIds = new Set(BUILTIN_THEMES.map(theme => theme.id))
const pendingDownloads = new Map()
let disposed = false

const selectedTheme = computed(() => props.modelValue.theme === 'auto' ? 'system' : props.modelValue.theme || 'dark')
const installedThemes = computed(() => listThemePackages(props.modelValue).filter(theme => !isBuiltin(theme.id)))
const availableThemes = computed(() => [...BUILTIN_THEMES, ...installedThemes.value])
const currentPackage = computed(() => getThemePackage(selectedTheme.value, props.modelValue))
const currentThemeName = computed(() => {
  if (selectedTheme.value === 'system') return '跟随系统'
  if (selectedTheme.value === 'custom') return '自定义配色'
  return currentPackage.value?.name || '默认深色'
})
const maxFileSizeLabel = MAX_THEME_FILE_BYTES >= 1024 * 1024
  ? `${Math.round(MAX_THEME_FILE_BYTES / (1024 * 1024))} MB`
  : `${Math.round(MAX_THEME_FILE_BYTES / 1024)} KB`

watch([selectedTheme, currentPackage], () => {
  exportName.value = selectedTheme.value === 'system' ? '我的系统配色' : currentThemeName.value
  exportAuthor.value = currentPackage.value?.author || ''
}, { immediate: true })

function isBuiltin(id) {
  return builtinIds.has(id)
}

function updateCustom(patch) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

function showMessage(text, type = 'success') {
  message.value = text
  messageType.value = type
  messageKey.value++
}

function selectTheme(id) {
  updateCustom({ theme: id })
  showMessage(`已切换到「${id === 'system' ? '跟随系统' : id === 'custom' ? '自定义配色' : availableThemes.value.find(theme => theme.id === id)?.name || id}」。`)
}

/** 只给缩略预览映射所需颜色，避免主题包的其他令牌影响设置面板。 */
function previewStyle(theme) {
  const fallback = getThemePackage(theme.base, props.modelValue)?.tokens || {}
  const tokens = { ...fallback, ...theme.tokens }
  const resolveColor = name => tokens[name]?.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/gi, (match, key) => resolveColor(key) || match)
  return {
    '--preview-background': resolveColor('--color-background'),
    '--preview-surface': resolveColor('--color-background-light'),
    '--preview-primary': resolveColor('--color-primary'),
    '--preview-text': resolveColor('--color-text')
  }
}

/** 删除当前主题时回到同一明暗基色，保留用户的自定义颜色和其他设置。 */
function removeTheme(id) {
  const theme = installedThemes.value.find(item => item.id === id)
  if (!theme) return
  const wasSelected = selectedTheme.value === id
  const patch = { themePackages: installedThemes.value.filter(item => item.id !== id) }
  if (wasSelected) patch.theme = theme.base
  updateCustom(patch)
  showMessage(`已移除「${theme.name}」${wasSelected ? '，已切换到内置主题' : ''}。`)
}

/** 校验文件大小及主题包内容后按 ID 安装或更新；卸载后不再提交读取结果。 */
async function importTheme(event) {
  const input = event.target
  const file = input.files?.[0]
  if (!file || isImporting.value) return
  isImporting.value = true
  message.value = ''
  try {
    if (!/\.json$/i.test(file.name)) throw new Error('请选择 .bk-theme.json 或 .json 主题包文件。')
    if (file.size > MAX_THEME_FILE_BYTES) throw new Error(`主题包文件过大，请选择不超过 ${maxFileSizeLabel} 的文件。`)
    const source = await file.text()
    if (disposed) return
    const theme = normalizeThemePackage(parseThemePackage(source))
    const existing = installedThemes.value.some(item => item.id === theme.id)
    if (!existing && installedThemes.value.length >= MAX_INSTALLED_THEMES) {
      throw new Error(`最多保留 ${MAX_INSTALLED_THEMES} 个主题包，请先移除不再使用的主题。`)
    }
    const themePackages = installedThemes.value.filter(item => item.id !== theme.id)
    themePackages.push(theme)
    updateCustom({ themePackages, theme: theme.id })
    showMessage(`已${existing ? '更新' : '导入'}并切换到「${theme.name}」。`)
  } catch (error) {
    if (!disposed) showMessage(error instanceof Error ? error.message : '导入主题包失败，请检查文件内容。', 'error')
  } finally {
    input.value = ''
    if (!disposed) isImporting.value = false
  }
}

/** 仅导出当前主题清单，下载链接和延迟释放任务均由组件管理。 */
function exportTheme() {
  if (isExporting.value || isImporting.value) return
  isExporting.value = true
  message.value = ''
  let url
  let link
  try {
    const name = exportName.value.trim() || currentThemeName.value
    const theme = createThemePackage({ custom: props.modelValue }, {
      name,
      author: exportAuthor.value.trim()
    })
    const content = serializeThemePackage(theme)
    const filename = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'theme'
    url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    link = document.createElement('a')
    link.href = url
    link.download = `${filename}.bk-theme.json`
    document.body.appendChild(link)
    link.click()
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url)
      pendingDownloads.delete(url)
    }, 1000)
    pendingDownloads.set(url, timer)
    showMessage(`已导出「${name}」，可将主题包文件分享给其他用户。`)
  } catch (error) {
    if (url) URL.revokeObjectURL(url)
    showMessage(error instanceof Error ? error.message : '导出主题包失败，请重试。', 'error')
  } finally {
    link?.remove()
    isExporting.value = false
  }
}

onBeforeUnmount(() => {
  disposed = true
  for (const [url, timer] of pendingDownloads) {
    clearTimeout(timer)
    URL.revokeObjectURL(url)
  }
  pendingDownloads.clear()
})
</script>

<style scoped>
.theme-packages {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  min-width: 0;
}

.theme-heading,
.theme-card-heading,
.theme-actions,
.theme-modes {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.theme-heading,
.theme-card-heading {
  justify-content: space-between;
}

.theme-label,
.theme-name {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.theme-description,
.theme-card-description,
.theme-author {
  margin: var(--spacing-xs) 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.theme-current,
.theme-badge {
  color: var(--color-primary);
  background: var(--color-primary-light);
  border-radius: var(--radius-full);
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-xs);
  overflow-wrap: anywhere;
}

.theme-grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: var(--spacing-md);
}

.theme-card {
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-background-light);
  overflow: hidden;
  transition: border-color var(--transition-fast), background-color var(--transition-fast), box-shadow var(--transition-fast), transform .18s ease, opacity .18s ease;
}
.theme-card:focus-within { border-color: var(--color-primary); box-shadow: var(--shadow-control-hover); }
.theme-card.ui-list-enter-active, .theme-card.ui-list-leave-active { transition: opacity .18s ease, translate .18s ease, scale .18s ease; }
.theme-card.ui-list-move { transition: transform .18s ease; }
.theme-card.is-selected .theme-preview { scale: .98; }
.theme-preview { transition: background-color .2s ease, scale .2s ease; }
.theme-card.ui-list-leave-active { pointer-events: none; }
.theme-card-select:disabled, .theme-remove:disabled { pointer-events: none; }

.theme-card:hover,
.theme-card.is-selected {
  border-color: var(--color-primary);
}

.theme-card-select {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  width: 100%;
  height: 100%;
  padding: var(--spacing-md);
  color: var(--color-text);
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
}

.theme-card:has(.theme-remove) .theme-card-select {
  height: auto;
}

.theme-card-select:focus-visible,
.theme-mode:focus-visible,
.theme-remove:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -3px;
}

.theme-card-heading {
  width: 100%;
  align-items: flex-start;
}

.theme-name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.theme-badge {
  flex-shrink: 0;
}

.theme-preview {
  display: flex;
  gap: 10px;
  width: 100%;
  height: 90px;
  padding: 10px;
  border-radius: var(--radius-md);
  background: var(--preview-background);
}

.theme-preview-sidebar {
  width: 18px;
  border-radius: 6px;
  background: var(--preview-surface);
}

.theme-preview-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
}

.theme-preview-title {
  width: 40%;
  height: 5px;
  border-radius: 4px;
  background: var(--preview-text);
  opacity: 0.7;
}

.theme-preview-tiles {
  display: flex;
  flex: 1;
  gap: 6px;
}

.theme-preview-tiles i {
  flex: 1;
  background: var(--preview-surface);
  border-radius: 4px;
}

.theme-preview-tiles i:first-child,
.theme-preview-player {
  background: var(--preview-primary);
}

.theme-preview-player {
  height: 7px;
  border-radius: 4px;
}

.theme-remove {
  display: block;
  margin: 0 var(--spacing-md) var(--spacing-md);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.theme-remove:hover {
  color: var(--color-error);
}

.theme-mode {
  border: 1px solid var(--color-border);
}

.theme-mode.is-selected {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--color-primary-light);
}

.theme-share {
  padding: var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.theme-metadata {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: var(--spacing-md);
  margin: var(--spacing-md) 0;
}

.theme-metadata label {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.theme-file-input {
  display: none;
}

.theme-file-hint {
  margin-top: var(--spacing-sm);
}

.theme-message {
  margin: 0;
  color: var(--color-success);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.theme-message.is-error {
  color: var(--color-error);
}
</style>
