<template>
  <div class="taskbar-settings" :aria-busy="busy">
    <div class="taskbar-heading">
      <div><h3>任务栏歌词</h3><p>让歌词留在 Windows 任务栏，切换应用时也能跟随音乐。</p></div>
      <button type="button" class="taskbar-button" :disabled="!canOperate || busy" @click="runAction('show')">{{ busy ? '处理中…' : '重新显示 / 找回' }}</button>
    </div>
    <p v-if="!available || (capabilitiesLoaded && !supported)" class="taskbar-note">任务栏歌词仅在 Windows 桌面客户端中可用。</p>
    <p v-else-if="!capabilitiesLoaded" class="taskbar-note" role="status">正在检查任务栏支持…</p>
    <Transition name="ui-fade"><p v-if="preferences.enabled && stateMessage" class="taskbar-note" role="status">{{ stateMessage }}</p></Transition>
    <fieldset class="taskbar-controls" :disabled="!canOperate || busy">
      <div class="taskbar-row">
        <div><label for="taskbar-enabled">启用任务栏歌词</label><p>保存后生效，下次启动恢复。自动隐藏后仍可从这里重新显示。</p></div>
        <label class="taskbar-switch"><input id="taskbar-enabled" type="checkbox" :checked="preferences.enabled" @change="setEnabled($event.target.checked)"><span></span></label>
      </div>
      <div class="taskbar-row">
        <div><label for="taskbar-embed">嵌入任务栏</label><p>跟随任务栏显示。关闭后改为任务栏上的悬浮歌词；系统不支持嵌入时也会自动使用悬浮模式。</p></div>
        <label class="taskbar-switch"><input id="taskbar-embed" type="checkbox" :checked="preferences.embed" @change="setPreference('embed', $event.target.checked)"><span></span></label>
      </div>
      <div class="taskbar-row">
        <div><label for="taskbar-pollingRate">轮询频率</label><p>检测任务栏的位置变化。频率越高，响应越快，系统占用也会增加。</p></div>
        <AnimatedSelect id="taskbar-pollingRate" class="taskbar-select" :model-value="preferences.pollingRate" :options="pollingOptions" label="轮询频率" :disabled="!canOperate || busy" @update:model-value="setPreference('pollingRate', $event)" />
      </div>
      <div class="taskbar-row">
        <div><label for="taskbar-displayId">屏幕序号</label><p>选择显示歌词的任务栏；拔出所选屏幕时回到主屏幕。</p></div>
        <AnimatedSelect id="taskbar-displayId" class="taskbar-select" :model-value="preferences.displayId" :options="displayOptions" label="屏幕序号" :disabled="!canOperate || busy" @update:model-value="setPreference('displayId', $event)" />
      </div>

      <AnimatedDetails class="settings-disclosure">
        <template #summary><span>位置与布局</span></template>
        <div v-for="option in layoutOptions" :key="option.key" class="taskbar-row">
          <div><label :for="'taskbar-' + option.key">{{ option.label }}</label><p>{{ option.description }}</p></div>
          <AnimatedSelect :id="'taskbar-' + option.key" class="taskbar-select" :model-value="preferences[option.key]" :options="option.options" :label="option.label" :disabled="!canOperate || busy" @update:model-value="setPreference(option.key, $event)" />
        </div>
        <div class="taskbar-row">
          <div><label for="taskbar-adaptive">自适应尺寸</label><p>根据歌词内容调整宽度，始终限制在可用的任务栏区域内。</p></div>
          <label class="taskbar-switch"><input id="taskbar-adaptive" type="checkbox" :checked="preferences.adaptive" @change="setPreference('adaptive', $event.target.checked)"><span></span></label>
        </div>
      </AnimatedDetails>

      <AnimatedDetails class="settings-disclosure">
        <template #summary><span>显示内容</span></template>
        <div v-for="option in contentOptions" :key="option.key" class="taskbar-row">
          <div><label :for="'taskbar-' + option.key">{{ option.label }}</label><p>{{ option.description }}</p></div>
          <label class="taskbar-switch"><input :id="'taskbar-' + option.key" type="checkbox" :checked="preferences[option.key]" @change="setPreference(option.key, $event.target.checked)"><span></span></label>
        </div>
      </AnimatedDetails>

      <AnimatedDetails class="settings-disclosure">
        <template #summary><span>字体与动效</span></template>
        <div class="taskbar-row">
          <div><label for="taskbar-colorMode">颜色模式</label><p>跟随 Windows 任务栏，或固定使用浅色、深色外观。</p></div>
          <AnimatedSelect id="taskbar-colorMode" class="taskbar-select" :model-value="preferences.colorMode" :options="colorOptions" label="颜色模式" :disabled="!canOperate || busy" @update:model-value="setPreference('colorMode', $event)" />
        </div>
        <div class="taskbar-row">
          <div><label for="taskbar-fontScale">字号缩放</label><p>调整歌词的显示字号，范围 50%–200%。</p></div>
          <div class="range-controls"><input id="taskbar-fontScale" type="range" min="0.5" max="2" step="0.05" :value="preferences.fontScale" @input="setNumber('fontScale', $event.target.value, .5, 2)"><output for="taskbar-fontScale">{{ Math.round(preferences.fontScale * 100) }}%</output></div>
        </div>
        <div class="taskbar-row">
          <div><label for="taskbar-fontFamily">字体家族</label><p>输入本机已安装的字体名称；留空或字体不可用时使用系统字体。</p></div>
          <div class="font-controls"><input id="taskbar-fontFamily" type="text" maxlength="100" :value="preferences.fontFamily" placeholder="系统默认字体" @input="setFontFamily($event.target.value)"><button type="button" class="taskbar-button" @click="setPreference('fontFamily', '')">恢复</button></div>
        </div>
        <div class="taskbar-row">
          <div><label for="taskbar-transition">歌词过渡</label><p>选择换句效果；系统减少动态效果时保留即时状态反馈。</p></div>
          <AnimatedSelect id="taskbar-transition" class="taskbar-select" :model-value="preferences.transition" :options="transitionOptions" label="歌词过渡" :disabled="!canOperate || busy" @update:model-value="setPreference('transition', $event)" />
        </div>
      </AnimatedDetails>

      <AnimatedDetails class="settings-disclosure">
        <template #summary><span>精细调整</span></template>
        <div class="taskbar-row">
          <div><span class="taskbar-label">纵向调整</span><p>分别调整垂直偏移和双行歌词的行间距，单位为像素。</p></div>
          <div class="number-controls"><label for="taskbar-verticalOffset">偏移<input id="taskbar-verticalOffset" type="number" min="-200" max="200" step="1" :value="preferences.verticalOffset" @change="setNumber('verticalOffset', $event.target.value, -200, 200, true)"></label><label for="taskbar-lineGap">行距<input id="taskbar-lineGap" type="number" min="-10" max="40" step="1" :value="preferences.lineGap" @change="setNumber('lineGap', $event.target.value, -10, 40, true)"></label></div>
        </div>
        <div class="taskbar-row">
          <div><label for="taskbar-maxWidth">自定义最大宽度</label><p>0 表示不额外限制；正值最小 120 像素，仍不会超过可用区域。</p></div>
          <input id="taskbar-maxWidth" class="single-number" type="number" min="0" max="8192" step="1" :value="preferences.maxWidth" @change="setMaxWidth($event.target.value)">
        </div>
        <div class="taskbar-row">
          <div><span class="taskbar-label">自定义边距</span><p>为区域首端与末端预留空间，避免与其他任务栏工具遮挡。</p></div>
          <div class="number-controls"><label for="taskbar-marginStart">首端<input id="taskbar-marginStart" type="number" min="0" max="2000" step="1" :value="preferences.marginStart" @change="setNumber('marginStart', $event.target.value, 0, 2000, true)"></label><label for="taskbar-marginEnd">末端<input id="taskbar-marginEnd" type="number" min="0" max="2000" step="1" :value="preferences.marginEnd" @change="setNumber('marginEnd', $event.target.value, 0, 2000, true)"></label></div>
        </div>
        <div class="taskbar-actions"><button type="button" class="taskbar-button" @click="runAction('resetPosition')">恢复位置与边距</button></div>
      </AnimatedDetails>

    </fieldset>
    <Transition name="ui-fade"><p v-if="environmentError" class="taskbar-feedback is-error" role="alert">{{ environmentError }} <button type="button" class="taskbar-button" :disabled="loadingEnvironment" @click="loadEnvironment">重试读取</button></p></Transition>
    <Transition name="ui-fade" mode="out-in"><p v-if="actionError || message" :key="actionError || message" class="taskbar-feedback" :class="{ 'is-error': actionError }" :role="actionError ? 'alert' : 'status'">{{ actionError || message }} <button v-if="actionError" type="button" class="taskbar-button" :disabled="!canOperate || busy" @click="runAction(lastAction)">重试</button></p></Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { logger } from '../../utils/logger.js'
import AnimatedSelect from './AnimatedSelect.vue'
import AnimatedDetails from './AnimatedDetails.vue'

const props = defineProps({ modelValue: { type: Object, required: true }, beforeAction: { type: Function, required: true }, available: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue'])
const api = typeof window !== 'undefined' ? window.electronAPI?.taskbarLyric : null
const preferences = computed(() => props.modelValue)
const busy = ref(false), actionError = ref(''), message = ref(''), lastAction = ref('show')
const displays = ref([]), supported = ref(false), capabilitiesLoaded = ref(false)
const loadingEnvironment = ref(false), environmentError = ref(''), state = ref(null)
const canOperate = computed(() => props.available && supported.value)
const stateMessage = computed(() => state.value?.error || state.value?.warning || (state.value?.embedded === true ? '正在嵌入任务栏显示。' : state.value?.embedded === false && state.value?.visible ? '正在任务栏上悬浮显示。' : ''))
let disposed = false, displayRevision = 0, stateRevision = 0
let releaseDisplays = null, releaseState = null
const displayOptions = computed(() => [
  { value: 'primary', label: '跟随主显示器' },
  ...displays.value.map(display => ({ value: display.id, label: display.label + (display.primary && !/主屏|主显示器/.test(display.label) ? '（主屏幕）' : '') })),
  ...(preferences.value.displayId !== 'primary' && !displays.value.some(display => display.id === preferences.value.displayId) ? [{ value: preferences.value.displayId, label: '已保存的屏幕（未连接）' }] : [])
])
const options = entries => entries.map(([value, label]) => ({ value, label }))
const pollingOptions = options([['low', '低 · 节省资源'], ['medium', '中（默认）'], ['high', '高 · 及时响应']])
const layoutOptions = [
  { key: 'region', label: '任务栏区域', description: '自动选择可用区域，或固定在任务栏的首端、末端。', options: options([['auto', '自动（默认）'], ['start', '首端区域'], ['end', '末端区域']]) },
  { key: 'windowAlignment', label: '窗口对齐', description: '决定歌词窗口在选定可用区域中的位置。', options: options([['auto', '自动（默认）'], ['start', '靠首端'], ['center', '居中'], ['end', '靠末端']]) },
  { key: 'contentAlignment', label: '内容对齐', description: '决定歌词文字在窗口中的排列。', options: options([['auto', '自动（默认）'], ['left', '左对齐'], ['center', '居中'], ['right', '右对齐']]) },
  { key: 'albumAlignment', label: '专辑图片对齐', description: '选择封面显示在文字的哪一侧。', options: options([['auto', '自动（默认）'], ['left', '左侧'], ['right', '右侧']]) },
  { key: 'originalPosition', label: '原文位置', description: '双行模式下，选择原文位于上方还是下方。', options: options([['top', '上方（默认）'], ['bottom', '下方']]) }
]
const contentOptions = [
  { key: 'doubleLine', label: '双行模式', description: '显示当前句与翻译、音译或下一句；关闭后只显示一行。' },
  { key: 'karaoke', label: '卡拉 OK 模式', description: '歌词包含逐字时间时，随实际播放进度从左到右填亮。' },
  { key: 'hideTranslation', label: '隐藏翻译和音译', description: '只改变任务栏歌词，不影响全屏和桌面歌词的偏好。' },
  { key: 'songInfoOnly', label: '仅显示歌曲信息', description: '显示歌名和艺人，不显示歌词。' },
  { key: 'autoHide', label: '自动隐藏', description: '暂停或没有歌曲时自动隐藏；重新显示可短暂预览。' },
  { key: 'showAlbum', label: '专辑图片', description: '在歌词旁显示当前歌曲的封面。' },
  { key: 'showControls', label: '控制按钮', description: '显示上一首、播放 / 暂停和下一首，不打断当前应用。' },
  { key: 'showLogo', label: 'BetterKuGou 标志', description: '显示应用标志。' }
]
const colorOptions = options([['taskbar', '跟随任务栏（默认）'], ['light', '浅色'], ['dark', '深色']])
const transitionOptions = options([['slide', '滑动（默认）'], ['fade', '淡入淡出'], ['none', '无动画']])

function setPreference(key, value) {
  if (!canOperate.value || busy.value || disposed) return
  emit('update:modelValue', { ...preferences.value, [key]: value })
}
/** 开启时先落盘再显示；关闭由父级原有保存事务关闭窗口。 */
function setEnabled(value) { setPreference('enabled', value); if (value) return runAction('show') }
function setNumber(key, value, minimum, maximum, integer = false) {
  const number = Number(value)
  if (!Number.isFinite(number)) return
  const bounded = Math.max(minimum, Math.min(maximum, number))
  setPreference(key, integer ? Math.round(bounded) : bounded)
}
function setMaxWidth(value) {
  const width = Number(value)
  if (Number.isFinite(width)) setPreference('maxWidth', width > 0 ? Math.round(Math.max(120, Math.min(8192, width))) : 0)
}
function setFontFamily(value) { setPreference('fontFamily', value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 100)) }

/** 排空父级草稿后调用受限窗口操作；失败可重试，离页后的回执不修改页面。 */
async function runAction(action) {
  if (!canOperate.value || !api?.[action] || !['show', 'resetPosition'].includes(action) || busy.value || disposed) return
  busy.value = true
  lastAction.value = action
  actionError.value = ''
  message.value = ''
  try {
    await nextTick()
    if (!await props.beforeAction()) throw new Error('请先重试保存设置。')
    if (disposed) return
    const result = await api[action]()
    if (disposed) return
    if (!result?.success) throw new Error(result?.error || '无法显示任务栏歌词，请重试。')
    message.value = action === 'show' ? '任务栏歌词已重新显示；自动隐藏开启时可短暂预览。' : '已恢复位置与边距。'
    if (api.getState) {
      const revision = stateRevision
      const snapshot = await api.getState()
      if (revision === stateRevision) acceptState(snapshot)
    }
  } catch (error) {
    if (!disposed) actionError.value = error?.message || '任务栏歌词操作失败，请重试。'
    logger.warn('TaskbarLyricSettings', '任务栏歌词操作失败', { action, code: error?.code })
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
function acceptState(value) { if (!disposed && value && typeof value === 'object') { stateRevision++; state.value = value } }

/** 订阅先于读取快照，确保屏幕热插拔与运行状态不会被迟到响应覆盖。 */
async function loadEnvironment() {
  if (!props.available || disposed || loadingEnvironment.value) return
  loadingEnvironment.value = true
  environmentError.value = ''
  const revision = displayRevision, runtimeRevision = stateRevision
  const [displayResult, capabilityResult, stateResult] = await Promise.allSettled([
    Promise.resolve().then(() => api.getDisplays()), Promise.resolve().then(() => api.getCapabilities()),
    Promise.resolve().then(() => api.getState?.())
  ])
  if (disposed) return
  if (displayResult.status === 'fulfilled' && Array.isArray(displayResult.value)) {
    if (revision === displayRevision) acceptDisplays(displayResult.value)
  } else {
    environmentError.value = '无法读取显示器列表，请重试。'
    logger.warn('TaskbarLyricSettings', '读取显示器列表失败', displayResult.reason)
  }
  supported.value = capabilityResult.status === 'fulfilled' && capabilityResult.value?.supported === true
  capabilitiesLoaded.value = capabilityResult.status === 'fulfilled'
  if (!capabilitiesLoaded.value) {
    environmentError.value = environmentError.value || '无法读取任务栏支持信息，请重试。'
    logger.warn('TaskbarLyricSettings', '读取任务栏支持信息失败', capabilityResult.reason)
  }
  if (stateResult.status === 'fulfilled' && runtimeRevision === stateRevision) acceptState(stateResult.value)
  else if (stateResult.status === 'rejected') logger.warn('TaskbarLyricSettings', '读取任务栏状态失败', stateResult.reason)
  loadingEnvironment.value = false
}
onMounted(() => {
  if (!props.available) return
  releaseDisplays = api?.onDisplaysChanged?.(acceptDisplays)
  releaseState = api?.onState?.(acceptState)
  void loadEnvironment()
})
onBeforeUnmount(() => { disposed = true; releaseDisplays?.(); releaseState?.() })
</script>

<style scoped>
.taskbar-settings { font-size: var(--font-size-xs); }
.taskbar-heading, .taskbar-row { display: flex; justify-content: space-between; align-items: center; gap: 24px; }
.taskbar-heading { align-items: flex-start; }
.taskbar-heading > div, .taskbar-row > div:first-child { flex: 1; min-width: 0; }
h3 { margin: 0; font-size: 18px; font-weight: 600; color: var(--color-text); }
h4 { margin: 28px 0 4px; color: var(--color-text); font-size: var(--font-size-sm); }
p { color: var(--color-text-secondary); line-height: 1.7; margin: 6px 0 0; }
.taskbar-note { margin: 12px 0; }
.taskbar-controls { padding: 0; border: 0; min-width: 0; }
.taskbar-controls:disabled { opacity: .55; }
.taskbar-row { padding: 17px 0; border-bottom: 1px solid var(--color-border); }
.taskbar-row label, .taskbar-label { color: var(--color-text); font-size: var(--font-size-sm); }
.taskbar-select { min-width: 176px; max-width: 240px; }
.taskbar-button { flex-shrink: 0; padding: 8px 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-background-light); color: var(--color-text); cursor: pointer; }
.taskbar-button:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.taskbar-button:disabled { opacity: .5; cursor: default; }
.taskbar-actions { display: flex; justify-content: flex-end; padding-top: 16px; }
.taskbar-feedback { margin: 14px 0 0; padding: 12px 14px; border-radius: 8px; background: var(--color-background-light); }
.is-error { color: var(--color-danger, #cf5c65); }
.taskbar-feedback .taskbar-button { margin-left: 8px; }
.taskbar-switch { position: relative; display: inline-flex; width: 38px; height: 22px; flex: 0 0 38px; }
.taskbar-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 1; }
.taskbar-switch span { position: absolute; inset: 0; border-radius: 20px; background: var(--color-background-lighter); border: 1px solid var(--color-border); transition: background .2s, border-color .2s; }
.taskbar-switch span::after { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; border-radius: 50%; background: var(--color-text-secondary); transition: transform .2s, background .2s; }
.taskbar-switch input:checked + span { background: var(--color-primary); border-color: var(--color-primary); }
.taskbar-switch input:checked + span::after { transform: translateX(16px); background: var(--color-on-primary); }
.taskbar-switch input:focus-visible + span { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.range-controls, .font-controls, .number-controls { display: flex; align-items: center; gap: 10px; }
.range-controls { width: 220px; max-width: 100%; }
.range-controls input { width: 100%; min-width: 50px; accent-color: var(--color-primary); }
.range-controls output { min-width: 42px; color: var(--color-text); text-align: right; font-variant-numeric: tabular-nums; }
input[type='text'], input[type='number'] { padding: 8px 10px; color: var(--color-text); background: var(--color-background-light); border: 1px solid var(--color-border); border-radius: 8px; font: inherit; box-sizing: border-box; }
input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.font-controls input { width: 180px; min-width: 0; }
.number-controls label { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.number-controls input, .single-number { width: 84px; }
@media (max-width: 780px) {
  .taskbar-heading { flex-wrap: wrap; }
  .taskbar-row { gap: 14px; flex-wrap: wrap; }
  .taskbar-row > div:first-child { flex-basis: 52%; }
  .taskbar-select { min-width: 150px; max-width: 100%; }
  .font-controls { flex-wrap: wrap; max-width: 100%; }
  .number-controls { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) { .taskbar-switch span, .taskbar-switch span::after { transition: none; } }
</style>
