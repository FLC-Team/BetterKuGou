<template>
  <div class="island-settings" :aria-busy="busy">
    <div class="island-heading">
      <div><h3>灵动岛歌词</h3><p>贴在屏幕上沿的单行歌词，左侧应用 Logo、中间歌词、右侧小封面；浮动模式下可点击或用键盘展开紧凑控制。</p></div>
      <button type="button" class="island-button" :disabled="!available || busy" @click="showIsland">{{ busy ? '处理中…' : '重新显示 / 找回' }}</button>
    </div>
    <p v-if="!available" class="island-note">灵动岛歌词仅在桌面客户端中可用。</p>
    <fieldset class="island-controls" :disabled="!available || busy">
      <div class="island-row">
        <div><label for="island-enabled">启用灵动岛歌词</label><p>保存后生效，下次启动恢复；手动开启时可预览 3 秒，也可从托盘开关。</p></div>
        <label class="island-switch"><input id="island-enabled" type="checkbox" :checked="preferences.enabled" @change="setEnabled($event.target.checked)"><span></span></label>
      </div>
      <div class="island-row">
        <div><label for="island-mode">灵动大陆模式</label><p>大陆模式贴在屏幕上沿，并在鼠标靠近时避让；浮动模式可拖动，拖到顶部会吸附。</p></div>
        <AnimatedSelect id="island-mode" class="island-select" :model-value="preferences.mode" :options="modeOptions" label="灵动大陆模式" :disabled="!available || busy" @update:model-value="setPreference('mode', $event)" />
      </div>
      <div class="island-row">
        <div><label for="island-display">显示器</label><p>跟随主显示器或固定到指定屏幕；拔出所选屏幕时回到主屏幕。</p></div>
        <AnimatedSelect id="island-display" class="island-select" :model-value="preferences.displayId" :options="displayOptions" label="显示器" :disabled="!available || busy" @update:model-value="selectDisplay" />
      </div>
      <div v-if="preferences.mode === 'floating'" class="island-row">
        <div><span class="island-label">浮动位置</span><p>可直接拖动歌词调整；留空使用默认位置。</p></div>
        <div class="position-controls"><label>X <input id="island-position-x" type="number" min="-100000" max="100000" :value="preferences.position?.x ?? ''" placeholder="自动" @change="setPosition('x', $event.target.value)"></label><label>Y <input id="island-position-y" type="number" min="-100000" max="100000" :value="preferences.position?.y ?? ''" placeholder="自动" @change="setPosition('y', $event.target.value)"></label><button type="button" class="island-button" @click="setPreference('position', null)">恢复位置</button></div>
      </div>

      <h4>内容与布局</h4>
      <div class="island-option-grid">
        <div v-for="option in contentOptions" :key="option.key" class="island-row">
          <div><label :for="option.id || 'island-' + option.key">{{ option.label }}</label><p>{{ option.description }}</p></div>
          <label class="island-switch"><input :id="option.id || 'island-' + option.key" type="checkbox" :checked="preferences[option.key]" @change="setPreference(option.key, $event.target.checked)"><span></span></label>
        </div>
      </div>
      <div class="island-row">
        <div><label for="island-preset">两侧内容预设</label><p>也可单独选择左右内容，组合会自动归为自定义。</p></div>
        <AnimatedSelect id="island-preset" class="island-select" :model-value="contentPreset" :options="presetOptions" label="两侧内容预设" :disabled="!available || busy" @update:model-value="applyPreset" />
      </div>
      <div class="island-row">
        <div><span class="island-label">左右内容</span><p>Logo 的显示同时受“显示应用 Logo”开关控制。</p></div>
        <div class="side-controls"><label for="island-left">左侧<AnimatedSelect id="island-left" class="island-select" :model-value="preferences.leftContent" :options="sideOptions" label="左侧内容" :disabled="!available || busy" @update:model-value="setPreference('leftContent', $event)" /></label><label for="island-right">右侧<AnimatedSelect id="island-right" class="island-select" :model-value="preferences.rightContent" :options="sideOptions" label="右侧内容" :disabled="!available || busy" @update:model-value="setPreference('rightContent', $event)" /></label></div>
      </div>

      <h4>字体与颜色</h4>
      <div class="island-option-grid">
        <div v-for="option in textOptions" :key="option.key" class="island-row">
          <div><label :for="'island-' + option.key">{{ option.label }}</label><p>{{ option.description }}</p></div>
          <label class="island-switch"><input :id="'island-' + option.key" type="checkbox" :checked="preferences[option.key]" @change="setPreference(option.key, $event.target.checked)"><span></span></label>
        </div>
      </div>
      <div class="island-row">
        <div><label for="island-font-family">字体</label><p>输入已安装字体的名称；留空使用系统字体，未安装时自动回退。</p></div>
        <div class="font-controls"><input id="island-font-family" type="text" maxlength="100" :value="preferences.fontFamily" placeholder="系统默认字体" @input="setFontFamily($event.target.value)"><button type="button" class="island-button" @click="setPreference('fontFamily', '')">恢复默认</button></div>
      </div>
      <div class="island-row">
        <div><label for="island-font-size">字号</label><p>14–40 像素，整体大小还可在下方调整。</p></div>
        <div class="range-controls"><input id="island-font-size" type="range" min="14" max="40" step="1" :value="preferences.fontSize" @input="setNumber('fontSize', $event.target.value, 14, 40, true)"><output for="island-font-size">{{ preferences.fontSize }} px</output></div>
      </div>
      <div class="color-controls">
        <div v-for="color in colorOptions" :key="color.key" class="color-control">
          <label :for="'island-color-' + color.key">{{ color.label }}</label>
          <div><input :id="'island-color-' + color.key" type="color" :value="preferences.colors[color.key]" @input="setColor(color.key, $event.target.value)"><span>{{ preferences.colors[color.key] }}</span><button type="button" class="island-button" :aria-label="'重置' + color.label" @click="setColor(color.key, color.default)">重置</button></div>
        </div>
      </div>

      <h4>透明度与大小</h4>
      <div v-for="slider in appearanceOptions" :key="slider.key" class="island-row">
        <div><label :for="'island-' + slider.key">{{ slider.label }}</label><p>{{ slider.description }}</p></div>
        <div class="range-controls"><input :id="'island-' + slider.key" type="range" :min="slider.min" :max="slider.max" step="0.01" :value="preferences[slider.key]" @input="setNumber(slider.key, $event.target.value, slider.min, slider.max)"><output :for="'island-' + slider.key">{{ Math.round(preferences[slider.key] * 100) }}%</output></div>
      </div>

      <h4>自动隐藏</h4>
      <div class="island-row">
        <div><label for="island-auto-hide">暂停时自动隐藏</label><p>开启后暂停或没有音乐时隐藏；点击“重新显示 / 找回”可预览 3 秒。</p></div>
        <label class="island-switch"><input id="island-auto-hide" type="checkbox" :checked="preferences.autoHide" @change="setPreference('autoHide', $event.target.checked)"><span></span></label>
      </div>
      <div class="island-row">
        <div><label for="island-hide-fullscreen">其他应用全屏时隐藏</label><p>{{ !available ? '此选项仅在 Windows 桌面客户端可用。' : !capabilitiesLoaded ? '正在检查系统支持…' : capabilities.fullscreenDetection ? '同一屏幕的其他应用进入全屏时暂时隐藏，离开全屏后恢复。' : '当前系统不支持外部应用全屏检测；此选项仅在 Windows 可用。' }}</p></div>
        <label class="island-switch"><input id="island-hide-fullscreen" type="checkbox" :checked="preferences.hideOnFullscreen" :disabled="!capabilities.fullscreenDetection" @change="setPreference('hideOnFullscreen', $event.target.checked)"><span></span></label>
      </div>
      <div class="island-row">
        <div><label for="island-hide-lyrics">打开全屏歌词时隐藏</label><p>同一屏幕打开 BetterKuGou 的全屏歌词时隐藏灵动岛，各平台均可使用。</p></div>
        <label class="island-switch"><input id="island-hide-lyrics" type="checkbox" :checked="preferences.hideOnLyricView" @change="setPreference('hideOnLyricView', $event.target.checked)"><span></span></label>
      </div>
    </fieldset>
    <Transition name="ui-fade"><p v-if="environmentError" class="island-feedback is-error" role="alert">{{ environmentError }} <button type="button" class="island-button" :disabled="loadingEnvironment" @click="loadEnvironment">重试读取</button></p></Transition>
    <Transition name="ui-fade" mode="out-in"><p v-if="actionError || message" :key="actionError || message" class="island-feedback" :class="{ 'is-error': actionError }" :role="actionError ? 'alert' : 'status'">{{ actionError || message }}</p></Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { logger } from '../../utils/logger.js'
import AnimatedSelect from './AnimatedSelect.vue'

const props = defineProps({
  modelValue: { type: Object, required: true },
  beforeAction: { type: Function, required: true },
  available: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue'])
const api = typeof window !== 'undefined' ? window.electronAPI?.islandLyric : null
const preferences = computed(() => props.modelValue)
const busy = ref(false)
const actionError = ref('')
const message = ref('')
const displays = ref([])
const capabilities = ref({ fullscreenDetection: false })
const capabilitiesLoaded = ref(false)
const loadingEnvironment = ref(false)
const environmentError = ref('')
let disposed = false
let releaseDisplays = null
let displayRevision = 0
const missingDisplay = computed(() => preferences.value.displayId !== 'primary' && !displays.value.some(display => display.id === preferences.value.displayId))
const displayOptions = computed(() => [
  { value: 'primary', label: '跟随主显示器' },
  ...displays.value.map(display => ({ value: display.id, label: display.label + (display.primary && !/主屏|主显示器/.test(display.label) ? '（主屏幕）' : '') })),
  ...(missingDisplay.value ? [{ value: preferences.value.displayId, label: '已保存的屏幕（未连接）' }] : [])
])
const modeOptions = [{ value: 'mainland', label: '灵动大陆 · 贴顶' }, { value: 'floating', label: '浮动 · 自由拖动' }]
const presetOptions = [{ value: 'default', label: '默认 · Logo / 封面' }, { value: 'swap', label: '交换 · 封面 / Logo' }, { value: 'lyrics', label: '仅歌词' }, { value: 'custom', label: '自定义', disabled: true }]
const contentOptions = [
  { key: 'showLogo', id: 'island-logo', label: '显示应用 Logo', description: '显示选定位置的 BetterKuGou 标识，不影响歌词和专辑封面。' },
  { key: 'alwaysTwoLines', label: '始终显示双行', description: '显示当前句与翻译或下一句，关闭时保持单行歌词。' },
  { key: 'hideTranslation', label: '灵动岛内隐藏翻译与音译', description: '隐藏本岛副行的译文和已有音译，其他歌词视图沿用原偏好。' },
  { key: 'songInfoOnly', label: '只显示歌曲信息', description: '显示歌名与歌手，不显示歌词。' }
]
const textOptions = [
  { key: 'boldText', label: '粗体歌词', description: '加强文字粗细，提升辨识度。' },
  { key: 'karaokeEnabled', label: '卡拉 OK 逐字高亮', description: '歌曲提供逐字时间时，按实际播放进度高亮文字。' }
]
const sideOptions = [{ value: 'none', label: '无' }, { value: 'logo', label: '应用 Logo' }, { value: 'cover', label: '专辑封面' }]
const presets = { default: ['logo', 'cover'], swap: ['cover', 'logo'], lyrics: ['none', 'none'] }
const contentPreset = computed(() => Object.keys(presets).find(key => presets[key][0] === preferences.value.leftContent && presets[key][1] === preferences.value.rightContent) || 'custom')
const colorOptions = [{ key: 'text', label: '歌词颜色', default: '#ffffff' }, { key: 'inactive', label: '未高亮颜色', default: '#656565' }, { key: 'background', label: '背景颜色', default: '#000000' }]
const appearanceOptions = [
  { key: 'opacity', label: '整体不透明度', description: '同时调整文字、封面和背景，最低保留 20%。', min: .2, max: 1 },
  { key: 'backgroundOpacity', label: '背景不透明度', description: '只调整背景，文字与封面保持清晰。', min: 0, max: 1 },
  { key: 'scale', label: '整体缩放', description: '缩放歌词与左右内容，范围 50%–200%。', min: .5, max: 2 }
]

function setPreference(key, value) {
  if (!props.available || busy.value || disposed) return
  emit('update:modelValue', { ...preferences.value, [key]: value })
}
/** 手动启用复用预览流程，等待父级确认新草稿落盘；关闭仍由父级普通保存处理。 */
function setEnabled(value) {
  if (!props.available || busy.value || disposed) return
  setPreference('enabled', value)
  if (value) return showIsland()
}
function setNumber(key, value, minimum, maximum, integer = false) {
  const number = Number(value)
  if (!Number.isFinite(number)) return
  const bounded = Math.max(minimum, Math.min(maximum, number))
  setPreference(key, integer ? Math.round(bounded) : bounded)
}
function setFontFamily(value) { setPreference('fontFamily', value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 100)) }
function setColor(key, value) {
  if (/^#[0-9a-f]{6}$/i.test(value)) setPreference('colors', { ...preferences.value.colors, [key]: value.toLowerCase() })
}
function setPosition(axis, value) {
  if (value === '') { setPreference('position', null); return }
  const number = Number(value)
  if (!Number.isFinite(number)) return
  setPreference('position', { ...(preferences.value.position || { x: 0, y: 0 }), [axis]: Math.round(Math.max(-100000, Math.min(100000, number))) })
}
function selectDisplay(id) {
  if (!props.available || busy.value || disposed) return
  emit('update:modelValue', { ...preferences.value, displayId: id, position: null })
}
function applyPreset(key) {
  if (!presets[key] || !props.available || busy.value || disposed) return
  emit('update:modelValue', { ...preferences.value, leftContent: presets[key][0], rightContent: presets[key][1] })
}

/** 先排空设置页草稿，再请求真实窗口预览；迟到回执不更新已离开的设置页。 */
async function showIsland() {
  if (!props.available || !api?.show || busy.value || disposed) return
  busy.value = true
  actionError.value = ''
  message.value = ''
  try {
    await nextTick()
    if (!await props.beforeAction()) throw new Error('请先重试保存设置。')
    if (disposed) return
    const result = await api.show()
    if (disposed) return
    if (!result?.success) throw new Error(result?.error || '无法显示灵动岛歌词，请重试。')
    message.value = '灵动岛已重新显示；开启自动隐藏时可预览 3 秒。'
  } catch (error) {
    if (!disposed) actionError.value = error?.message || '无法显示灵动岛歌词，请重试。'
    logger.warn('IslandLyricSettings', '显示灵动岛失败', { code: error?.code })
  } finally { if (!disposed) busy.value = false }
}

function acceptDisplays(value) {
  if (disposed || !Array.isArray(value)) return
  displayRevision++
  const seen = new Set()
  displays.value = value.filter(display => display && (typeof display.id === 'string' || Number.isInteger(display.id)))
    .map(display => ({ id: String(display.id), label: typeof display.label === 'string' ? display.label : `显示器 ${display.id}`, primary: display.primary === true }))
    .filter(display => display.id !== 'primary' && !seen.has(display.id) && seen.add(display.id))
}

/** 先订阅热插拔，再读显示器与能力；迟到快照不能覆盖已收到的新屏幕列表。 */
async function loadEnvironment() {
  if (!props.available || disposed || loadingEnvironment.value) return
  loadingEnvironment.value = true
  environmentError.value = ''
  const revision = displayRevision
  const [displayResult, capabilityResult] = await Promise.allSettled([
    Promise.resolve().then(() => { if (!api?.getDisplays) throw new Error('Display enumeration unavailable'); return api.getDisplays() }),
    Promise.resolve().then(() => { if (!api?.getCapabilities) throw new Error('Capabilities unavailable'); return api.getCapabilities() })
  ])
  if (disposed) return
  if (displayResult.status === 'fulfilled' && Array.isArray(displayResult.value)) {
    if (revision === displayRevision) acceptDisplays(displayResult.value)
  } else {
    environmentError.value = '无法读取显示器列表，请重试。'
    logger.warn('IslandLyricSettings', '读取显示器列表失败', displayResult.reason)
  }
  capabilities.value = { fullscreenDetection: capabilityResult.status === 'fulfilled' && capabilityResult.value?.fullscreenDetection === true }
  capabilitiesLoaded.value = true
  if (capabilityResult.status === 'rejected') {
    environmentError.value = environmentError.value || '无法读取全屏检测能力，请重试。'
    logger.warn('IslandLyricSettings', '读取全屏检测能力失败', capabilityResult.reason)
  }
  loadingEnvironment.value = false
}

onMounted(() => {
  if (!props.available) return
  if (api?.onDisplaysChanged) releaseDisplays = api.onDisplaysChanged(acceptDisplays)
  void loadEnvironment()
})
onBeforeUnmount(() => { disposed = true; releaseDisplays?.() })
</script>

<style scoped>
.island-settings { font-size: var(--font-size-xs); }
.island-heading, .island-row { display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.island-heading { align-items: flex-start; }
.island-heading > div, .island-row > div:first-child { flex: 1; min-width: 0; }
h3 { margin: 0; font-size: 18px; font-weight: 600; color: var(--color-text); }
h4 { margin: 28px 0 4px; color: var(--color-text); font-size: var(--font-size-sm); }
p { color: var(--color-text-secondary); line-height: 1.7; margin: 6px 0 0; }
.island-note { margin: 12px 0; }
.island-controls { padding: 0; border: 0; min-width: 0; }
.island-controls:disabled { opacity: .55; }
.island-row { padding: 17px 0; border-bottom: 1px solid var(--color-border); }
.island-row label, .island-label { color: var(--color-text); font-size: var(--font-size-sm); }
.island-option-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 28px; }
.island-option-grid .island-row { gap: 16px; }
input[type="text"], input[type="number"] { min-width: 0; max-width: 250px; padding: 9px; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-background-light); color: var(--color-text); }
.island-select { width: 190px; }
.island-button { flex: 0 0 auto; padding: 9px 13px; border: 1px solid var(--color-border); border-radius: 7px; color: var(--color-text); background: transparent; cursor: pointer; white-space: nowrap; }
.island-button:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }
.island-button:disabled { opacity: .5; cursor: default; }
.island-button:focus-visible, input:focus-visible, .island-select:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.island-switch { display: block; position: relative; width: 37px; height: 22px; flex: 0 0 37px; }
.island-switch input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; cursor: pointer; }
.island-switch span { display: block; width: 100%; height: 100%; border-radius: 22px; background: var(--color-border); pointer-events: none; transition: background-color .18s ease; }
.island-switch span::after { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; border-radius: 50%; background: var(--color-text); transition: transform .18s ease; }
.island-switch input:checked + span { background: var(--color-primary); }
.island-switch input:checked + span::after { transform: translateX(15px); }
.island-switch input:focus-visible + span { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.island-switch input:disabled + span { opacity: .5; }
.font-controls, .position-controls, .side-controls, .range-controls { display: flex; align-items: center; gap: 10px; }
.font-controls input { width: 170px; }
.position-controls label, .side-controls label { display: flex; align-items: center; gap: 8px; }
.position-controls input { width: 76px; }
.side-controls .island-select { width: 110px; }
.range-controls { width: 230px; flex: 0 1 230px; }
.range-controls input { min-width: 80px; width: 100%; accent-color: var(--color-primary); }
.range-controls output { min-width: 50px; text-align: right; font-variant-numeric: tabular-nums; color: var(--color-text); }
.color-controls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; padding-top: 20px; }
.color-control > label { display: block; margin-bottom: 10px; color: var(--color-text); }
.color-control > div { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.color-control input { width: 32px; height: 32px; padding: 2px; border: 1px solid var(--color-border); border-radius: 6px; background: transparent; cursor: pointer; }
.color-control span { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
.color-control button { padding: 6px 8px; }
.island-feedback { margin-top: 16px; }
.is-error { color: var(--color-error); }
@media (max-width: 1100px) {
  .island-option-grid { grid-template-columns: 1fr; }
  .island-row { flex-wrap: wrap; gap: 14px; }
  .font-controls, .position-controls, .side-controls { flex-wrap: wrap; }
  .color-controls { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) { .island-switch span, .island-switch span::after { transition: none; } }
</style>
