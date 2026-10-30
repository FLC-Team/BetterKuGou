<template>
  <div class="desktop-settings" :aria-busy="working">
    <header class="desktop-heading">
      <div><h3>桌面歌词</h3><p>让歌词陪在桌面上。位置、尺寸和下方偏好会自动保存。</p></div>
      <div class="desktop-actions"><button id="desktop-open" type="button" :disabled="!available || working" @click="runAction('show')">{{ working ? '处理中…' : '打开桌面歌词' }}</button><button id="desktop-recover" type="button" :disabled="!canRecover || working" @click="runAction('resetPosition')">找回并解锁</button></div>
    </header>
    <p v-if="!available" class="desktop-note">桌面歌词窗口仅在桌面客户端中可用。</p>
    <Transition name="ui-fade" mode="out-in"><p v-if="message" :key="message" class="desktop-note" :class="{ 'desktop-error': failed }" :role="failed ? 'alert' : 'status'">{{ message }}</p></Transition>

    <AnimatedDetails class="desktop-section" :open="true">
      <template #summary><span><strong>播放与动画</strong><small>行数、逐字高亮与换句效果</small></span><span class="desktop-disclosure" aria-hidden="true">⌄</span></template>
      <div v-for="option in playbackOptions" :key="option.key" class="desktop-row" :class="{ 'is-disabled': isDisabled(option.key) }">
        <div><label :for="controlId(option.key)">{{ option.label }}</label><p :id="controlId(option.key) + '-help'">{{ option.description }}</p></div>
        <label class="desktop-switch"><input :id="controlId(option.key)" type="checkbox" :checked="preference(option.key, option.default)" :disabled="isDisabled(option.key)" :aria-describedby="controlId(option.key) + '-help'" @change="setPreference(option.key, $event.target.checked)"><span></span></label>
      </div>
    </AnimatedDetails>

    <AnimatedDetails class="desktop-section">
      <template #summary><span><strong>显示与隐藏</strong><small>暂停、全屏与鼠标悬停时的表现</small></span><span class="desktop-disclosure" aria-hidden="true">⌄</span></template>
      <div v-for="option in visibilityOptions" :key="option.key" class="desktop-row">
        <div><label :for="controlId(option.key)">{{ option.label }}</label><p :id="controlId(option.key) + '-help'">{{ option.description }}</p></div>
        <label class="desktop-switch"><input :id="controlId(option.key)" type="checkbox" :checked="preference(option.key, option.default)" :aria-describedby="controlId(option.key) + '-help'" @change="setPreference(option.key, $event.target.checked)"><span></span></label>
      </div>
      <div v-for="option in opacityOptions" :key="option.key" class="desktop-row desktop-range-row" :class="{ 'is-disabled': isDisabled(option.key) }">
        <div><label :for="controlId(option.key)">{{ option.label }}</label><p :id="controlId(option.key) + '-help'">{{ option.description }}</p></div>
        <div class="desktop-range"><input :id="controlId(option.key)" type="range" min="0" max="100" step="1" :value="preference(option.key, option.default)" :disabled="isDisabled(option.key)" :aria-describedby="controlId(option.key) + '-help'" :aria-valuetext="preference(option.key, option.default) + '%'" @input="setNumber(option.key, $event, 0, 100)"><output :for="controlId(option.key)">{{ preference(option.key, option.default) }}%</output></div>
      </div>
    </AnimatedDetails>

    <AnimatedDetails class="desktop-section">
      <template #summary><span><strong>字体与配色</strong><small>大小、对齐、描边和独立文字颜色</small></span><span class="desktop-disclosure" aria-hidden="true">⌄</span></template>
      <div class="desktop-row"><div><label for="desktop-size">歌词大小</label><p>小 / 中 / 大，默认为中。</p></div><AnimatedSelect id="desktop-size" :model-value="preference('fontSize', 'medium')" label="歌词大小" :options="sizeOptions" @update:model-value="setPreference('fontSize', $event)" /></div>
      <div class="desktop-row"><div><label for="desktop-theme">歌词样式</label><p>自定义颜色留空时，沿用所选样式及主题包配色。</p></div><AnimatedSelect id="desktop-theme" :model-value="preference('theme', 'classic')" label="歌词样式" :options="themeOptions" @update:model-value="setPreference('theme', $event)" /></div>
      <div class="desktop-row"><div><label for="desktop-alignment">歌词对齐</label><p>短句按所选方向排列；长句继续跟随演唱位置。</p></div><AnimatedSelect id="desktop-alignment" :model-value="preference('alignment', 'center')" label="歌词对齐" :options="alignmentOptions" @update:model-value="setPreference('alignment', $event)" /></div>
      <div class="desktop-row desktop-font-row"><div><label for="desktop-font-family">字体</label><p id="desktop-font-help">输入本机已安装的字体名称；留空或字体不可用时使用默认字体。</p></div><div class="desktop-font"><input id="desktop-font-family" type="text" maxlength="128" autocomplete="off" placeholder="默认字体" :value="preference('fontFamily', '')" aria-describedby="desktop-font-help" @input="setPreference('fontFamily', $event.target.value)"><button id="desktop-reset-font" type="button" :disabled="!preferences.fontFamily" @click="setPreference('fontFamily', '')">恢复默认字体</button></div></div>
      <div class="desktop-row desktop-range-row"><div><label for="desktop-stroke-width">文字描边</label><p>调节描边强度，让歌词在不同桌面背景上保持清晰。</p></div><div class="desktop-range"><input id="desktop-stroke-width" type="range" min="0" max="200" step="1" :value="preference('strokeWidth', 100)" :aria-valuetext="preference('strokeWidth', 100) + '%'" @input="setNumber('strokeWidth', $event, 0, 200)"><output for="desktop-stroke-width">{{ preference('strokeWidth', 100) }}%</output></div></div>
      <div class="desktop-subheading"><h4>文字颜色</h4><button id="desktop-reset-colors" type="button" :disabled="!colorOptions.some(option => preferences[option.key])" @click="resetColors">恢复样式配色</button></div>
      <div class="desktop-colors">
        <div v-for="option in colorOptions" :key="option.key" class="desktop-color">
          <label :for="controlId(option.key)">{{ option.label }}</label><div><input :id="controlId(option.key)" type="color" :value="colorValue(option.key)" @input="setPreference(option.key, $event.target.value)"><span>{{ preferences[option.key] || '继承当前样式' }}</span><button type="button" :disabled="!preferences[option.key]" :aria-label="'恢复' + option.label" @click="setPreference(option.key, '')">恢复</button></div>
        </div>
      </div>
    </AnimatedDetails>

    <AnimatedDetails class="desktop-section">
      <template #summary><span><strong>歌词阴影</strong><small>颜色、方向、深度与柔和程度</small></span><span class="desktop-disclosure" aria-hidden="true">⌄</span></template>
      <div class="desktop-row"><div><label for="desktop-shadow-enabled">启用歌词阴影</label><p>为原文和第二行文字添加柔和的投影。</p></div><label class="desktop-switch"><input id="desktop-shadow-enabled" type="checkbox" :checked="preference('shadowEnabled', false)" @change="setPreference('shadowEnabled', $event.target.checked)"><span></span></label></div>
      <fieldset class="desktop-shadow-controls" :disabled="!preferences.shadowEnabled" aria-label="歌词阴影选项">
        <div class="desktop-row"><div><label for="desktop-shadow-color-mode">阴影颜色</label><p>可跟随封面主色；无法读取封面时使用下方自定义颜色。</p></div><AnimatedSelect id="desktop-shadow-color-mode" :model-value="preference('shadowColorMode', 'cover')" label="阴影颜色来源" :options="shadowColorOptions" :disabled="!preferences.shadowEnabled" @update:model-value="setPreference('shadowColorMode', $event)" /></div>
        <div class="desktop-row"><div><label for="desktop-shadow-color">自定义阴影颜色</label><p>{{ preference('shadowColorMode', 'cover') === 'cover' ? '当前作为封面颜色不可用时的备用颜色。' : '使用所选颜色绘制阴影。' }}</p></div><input id="desktop-shadow-color" type="color" :value="colorValue('shadowColor')" @input="setPreference('shadowColor', $event.target.value)"></div>
        <div v-for="option in shadowRanges" :key="option.key" class="desktop-row desktop-range-row"><div><label :for="controlId(option.key)">{{ option.label }}</label></div><div class="desktop-range"><input :id="controlId(option.key)" type="range" min="0" :max="option.max" step="1" :value="preference(option.key, option.default)" :aria-valuetext="preference(option.key, option.default) + option.unit" @input="setNumber(option.key, $event, 0, option.max)"><output :for="controlId(option.key)">{{ preference(option.key, option.default) }}{{ option.unit }}</output></div></div>
        <div class="desktop-actions desktop-reset-row"><button id="desktop-reset-shadow" type="button" @click="resetShadow">恢复阴影参数</button></div>
      </fieldset>
    </AnimatedDetails>

    <AnimatedDetails class="desktop-section">
      <template #summary><span><strong>窗口与锁定</strong><small>置顶、鼠标穿透与解锁入口</small></span><span class="desktop-disclosure" aria-hidden="true">⌄</span></template>
      <div v-for="option in windowOptions" :key="option.key" class="desktop-row"><div><label :for="controlId(option.key)">{{ option.label }}</label><p :id="controlId(option.key) + '-help'">{{ option.description }}</p></div><label class="desktop-switch"><input :id="controlId(option.key)" type="checkbox" :checked="preference(option.key, option.default)" :aria-describedby="controlId(option.key) + '-help'" @change="setPreference(option.key, $event.target.checked)"><span></span></label></div>
    </AnimatedDetails>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import AnimatedDetails from './AnimatedDetails.vue'
import AnimatedSelect from './AnimatedSelect.vue'
import { logger } from '../../utils/logger.js'

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, beforeAction: { type: Function, required: true } })
const emit = defineEmits(['update:modelValue'])
const preferences = computed(() => props.modelValue || {})
const api = typeof window !== 'undefined' ? window.electronAPI?.desktopLyric : null
const available = typeof api?.show === 'function'
const canRecover = typeof api?.resetPosition === 'function'
const working = ref(false)
const message = ref('')
const failed = ref(false)
let disposed = false

const playbackOptions = [
  { key: 'doubleLine', label: '双行歌词', description: '第二行显示翻译；没有翻译时预览下一句。', default: true },
  { key: 'karaokeEnabled', label: '逐字变亮', description: '按演唱进度从左向右填亮；关闭后使用整句高亮。', default: true },
  { key: 'hideTranslation', label: '隐藏翻译和音译', description: '仅覆盖桌面歌词显示，保留全局的翻译和罗马音偏好。', default: false },
  { key: 'songInfoOnly', label: '仅显示歌曲信息', description: '显示歌名和歌手，暂时隐藏歌词内容。', default: false },
  { key: 'efficientMode', label: '节能模式', description: '降低高亮刷新频率并暂停装饰动画，减少资源占用。', default: false },
  { key: 'transitionEnabled', label: '换句动画', description: '下一句平滑移入当前行；节能模式下暂时停用。', default: true },
  { key: 'transitionBlur', label: '换句模糊效果', description: '在换句时加入轻微模糊，跟随换句动画启用。', default: true }
]
const visibilityOptions = [
  { key: 'autoHidePaused', label: '暂停时自动隐藏', description: '恢复播放后重新显示，保留窗口位置。', default: false },
  { key: 'hideOnFullscreen', label: '其他应用全屏时隐藏', description: '适用于 Windows：前台其他应用占满屏幕时暂时隐藏。', default: false },
  { key: 'hideOnLyricView', label: '打开全屏歌词时隐藏', description: '同一显示器打开本应用的全屏歌词时隐藏，离开后恢复。', default: true },
  { key: 'hoverFade', label: '鼠标悬停时淡化', description: '锁定后，鼠标移入时降低歌词不透明度，移开后恢复。', default: false }
]
const opacityOptions = [
  { key: 'hoverOpacity', label: '悬停时不透明度', description: '控制淡化后保留多少歌词；0% 为完全透明。', default: 20 },
  { key: 'opacity', label: '歌词不透明度', description: '100% 为完全不透明，0% 为完全透明。', default: 100 }
]
const sizeOptions = [{ value: 'small', label: '小' }, { value: 'medium', label: '中（默认）' }, { value: 'large', label: '大' }]
const themeOptions = [{ value: 'classic', label: '经典（默认）' }, { value: 'gradient', label: '渐变' }, { value: 'minimal', label: '简约' }]
const alignmentOptions = [{ value: 'left', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' }]
const colorOptions = [{ key: 'activeColor', label: '已唱歌词' }, { key: 'textColor', label: '未唱歌词' }, { key: 'translationColor', label: '翻译与下一句' }]
const shadowColorOptions = [{ value: 'cover', label: '跟随封面' }, { value: 'custom', label: '自定义颜色' }]
const shadowRanges = [
  { key: 'shadowDepth', label: '阴影深度', default: 5, max: 30, unit: ' px' },
  { key: 'shadowDirection', label: '阴影方向', default: 315, max: 360, unit: '°' },
  { key: 'shadowOpacity', label: '阴影不透明度', default: 50, max: 100, unit: '%' },
  { key: 'shadowRadius', label: '阴影模糊半径', default: 10, max: 40, unit: ' px' }
]
const windowOptions = [
  { key: 'alwaysOnTop', label: '保持窗口置顶', description: '让桌面歌词显示在普通应用窗口上方。', default: true },
  { key: 'locked', label: '锁定桌面歌词', description: '鼠标穿透操作下方窗口；可通过这里或托盘菜单解锁。', default: false },
  { key: 'hideUnlockButton', label: '隐藏解锁按钮', description: '锁定后不显示桌面解锁入口，仍可从托盘或此页解锁。', default: false }
]

function preference(key, fallback) { return preferences.value[key] ?? fallback }
function controlId(key) { return key === 'locked' ? 'desktop-lock' : 'desktop-' + key.replace(/[A-Z]/g, character => '-' + character.toLowerCase()) }
function isDisabled(key) {
  if (['doubleLine', 'karaokeEnabled', 'hideTranslation'].includes(key) && preferences.value.songInfoOnly) return true
  if (key === 'hideTranslation') return preferences.value.doubleLine === false
  if (key === 'transitionEnabled') return preferences.value.efficientMode === true
  if (key === 'transitionBlur') return preferences.value.efficientMode === true || preferences.value.transitionEnabled === false
  return key === 'hoverOpacity' && preferences.value.hoverFade !== true
}

/** 只覆盖本次编辑的字段；窗口位置、外部更新与未知兼容字段保留在父级草稿中。 */
function patchPreferences(patch) {
  if (!disposed) emit('update:modelValue', { ...preferences.value, ...patch })
}
function setPreference(key, value) { if (!isDisabled(key)) patchPreferences({ [key]: value }) }
function setNumber(key, event, minimum, maximum) {
  const value = Number(event.target.value)
  if (Number.isFinite(value)) setPreference(key, Math.max(minimum, Math.min(maximum, Math.round(value))))
}
function colorValue(key) {
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(preferences.value[key] || '')) return preferences.value[key].slice(0, 7)
  if (key === 'shadowColor') return '#000000'
  if (key !== 'activeColor') return '#ffffff'
  return preferences.value.theme === 'gradient' ? '#b9b1ff' : preferences.value.theme === 'minimal' ? '#ffffff' : '#feca57'
}
function resetColors() { patchPreferences({ activeColor: '', textColor: '', translationColor: '' }) }
function resetShadow() { patchPreferences({ shadowColorMode: 'cover', shadowColor: '#000000', shadowDepth: 5, shadowDirection: 315, shadowOpacity: 50, shadowRadius: 10 }) }

/** 打开或找回窗口前先排空草稿；失败不伪报成功，原按钮保留可重试入口。 */
async function runAction(method) {
  if (disposed || working.value || typeof api?.[method] !== 'function') return
  working.value = true
  message.value = ''
  failed.value = false
  try {
    if (!await props.beforeAction()) throw new Error('请先重试保存设置，再操作桌面歌词。')
    if (disposed) return
    const result = await api[method]()
    if (disposed) return
    if (!result || result.success === false) throw new Error(method === 'show' ? '无法打开桌面歌词，请重试。' : '找回桌面歌词失败，请重试。')
    message.value = method === 'show' ? '桌面歌词已打开。' : '桌面歌词已回到主屏幕下方并解锁。'
  } catch (cause) {
    if (!disposed) { failed.value = true; message.value = cause?.message || '桌面歌词操作失败，请重试。' }
    logger.warn('DesktopLyricSettings', '桌面歌词窗口操作失败', { method, cause })
  } finally { if (!disposed) working.value = false }
}
onBeforeUnmount(() => { disposed = true })
</script>

<style scoped>
.desktop-settings { min-width: 0; margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--color-border); font-size: var(--font-size-xs); }
.desktop-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 18px; }
.desktop-heading > div:first-child { flex: 1; min-width: 0; }
h3, h4 { margin: 0; color: var(--color-text); font-size: var(--font-size-sm); font-weight: 600; }
.desktop-heading p, .desktop-row p, .desktop-note { margin: 5px 0 0; color: var(--color-text-secondary); font-size: calc(var(--font-size-xs) - 1px); line-height: 1.8; overflow-wrap: anywhere; }
.desktop-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.desktop-section { border-top: 1px solid var(--color-border); }
.desktop-section :deep(summary) { display: flex; align-items: center; justify-content: space-between; gap: 20px; list-style: none; padding: 18px 0; }
.desktop-section :deep(summary::-webkit-details-marker) { display: none; }
.desktop-section strong { display: block; font-size: var(--font-size-sm); font-weight: 500; }
.desktop-section small { display: block; margin-top: 5px; color: var(--color-text-secondary); font-size: 11px; }
.desktop-disclosure { color: var(--color-text-secondary); transition: rotate .2s ease; }
.desktop-section[open] .desktop-disclosure { rotate: 180deg; }
.desktop-row { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 17px 0; }
.desktop-row + .desktop-row { border-top: 1px solid color-mix(in srgb, var(--color-border) 55%, transparent); }
.desktop-row > div:first-child { flex: 1; min-width: 0; }
.desktop-row label { color: var(--color-text); font-size: var(--font-size-sm); line-height: 1.6; }
.desktop-row :deep(.animated-select-trigger) { max-width: 160px; flex: 0 0 auto; }
.desktop-switch { position: relative; display: block; width: 37px; height: 22px; flex: 0 0 37px; }
.desktop-switch input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.desktop-switch span { display: block; height: 100%; border: 1px solid var(--color-border); border-radius: 22px; background: var(--color-background-lighter); pointer-events: none; transition: background-color .18s ease; }
.desktop-switch span::after { content: ''; position: absolute; width: 14px; height: 14px; top: 4px; left: 4px; border-radius: 50%; background: var(--color-text-secondary); transition: transform .18s ease, background-color .18s ease; }
.desktop-switch input:checked + span { background: var(--color-primary); border-color: transparent; }
.desktop-switch input:checked + span::after { transform: translateX(15px); background: var(--color-on-primary); }
.desktop-switch input:focus-visible + span, input:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.desktop-switch input:disabled { cursor: default; }
.is-disabled, .desktop-shadow-controls:disabled { opacity: .5; }
.desktop-range { display: flex; align-items: center; gap: 10px; width: 190px; max-width: 100%; flex: 0 1 190px; }
.desktop-range input { min-width: 60px; width: 100%; height: 24px; accent-color: var(--color-primary); cursor: pointer; }
.desktop-range output { min-width: 48px; text-align: right; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.desktop-font { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; max-width: 280px; }
.desktop-font input { min-width: 0; width: 180px; max-width: 100%; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-background-light); color: var(--color-text); font: inherit; }
button { flex: 0 0 auto; padding: 8px 13px; border: 1px solid var(--color-border); border-radius: 40px; color: var(--color-text); font-size: 11px; line-height: 1.6; transition: border-color .16s ease, color .16s ease, scale .16s ease, opacity .16s ease; }
button:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }
button:active:not(:disabled) { scale: .97; }
button:disabled { opacity: .5; cursor: default; }
.desktop-subheading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 20px 0 12px; }
.desktop-subheading h4 { font-size: 12px; }
.desktop-colors { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; padding-bottom: 20px; }
.desktop-color { border: 1px solid var(--color-border); border-radius: 10px; padding: 12px; }
.desktop-color label { display: block; margin-bottom: 10px; font-size: 12px; }
.desktop-color > div { display: flex; align-items: center; gap: 9px; }
.desktop-color span { color: var(--color-text-secondary); font-size: 10px; flex: 1; }
.desktop-color button { padding: 4px 8px; }
input[type="color"] { width: 32px; height: 30px; flex: 0 0 32px; padding: 2px; border: 1px solid var(--color-border); border-radius: 7px; background: transparent; cursor: pointer; }
.desktop-shadow-controls { min-width: 0; padding: 0; margin: 0; border: 0; transition: opacity .18s ease; }
.desktop-reset-row { justify-content: flex-end; padding: 8px 0 20px; }
.desktop-note.desktop-error { color: var(--color-error); }
@container (max-width: 540px) { .desktop-heading { flex-direction: column; gap: 12px; } .desktop-row { gap: 14px; } .desktop-range { flex-basis: 150px; width: 150px; } .desktop-font-row { align-items: flex-start; flex-direction: column; } .desktop-font { justify-content: flex-start; max-width: 100%; } }
@container (max-width: 390px) { .desktop-range-row { flex-wrap: wrap; gap: 9px; } .desktop-range-row > div:first-child { flex-basis: 100%; } .desktop-range { flex: 1 1 100%; width: 100%; } .desktop-row label { font-size: 12px; } }
@media (prefers-reduced-motion: reduce) { *, *::after { transition: none !important; animation: none !important; } }
</style>
