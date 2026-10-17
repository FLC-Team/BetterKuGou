<template>
  <Teleport to="body">
    <Transition name="studio" appear @before-leave="$event.inert = true" @after-leave="finishClose">
    <section v-if="shown" class="bk-theme-studio" data-bk-theme-safety :class="{ 'is-minimized': minimized }" :inert="closing || undefined" aria-label="界面可视化编辑器">
      <header><div><strong>界面编辑器</strong><small>{{ snapshot.name }} · {{ dirty ? '草稿未应用' : '已应用' }}</small></div><button type="button" :disabled="saving" @click="minimized = !minimized">{{ minimized ? '展开' : '收起' }}</button><button type="button" :disabled="saving" aria-label="关闭编辑器并取消预览" @click="close">×</button></header>
      <Transition name="studio-collapse"><div v-show="!minimized" class="studio-body" :inert="minimized || closing || undefined"><fieldset class="studio-controls" :disabled="saving">
        <p>可先收起面板并导航到任意页面，再拾取元素。预览不写入设置，应用后随主题保存和分享。</p>
        <div class="studio-actions"><button type="button" @click="startPicking">{{ picking ? '正在拾取（Esc 取消）' : '拾取界面元素' }}</button><button type="button" @click="loadCurrent" :disabled="saving">载入当前主题</button><button type="button" @click="restoreDefault" :disabled="saving">恢复内置外观</button></div>
        <label>编辑窗口<select v-model="target" @change="chooseFirstRegion"><option value="main">主窗口 / 全屏歌词 / 菜单 / 队列</option><option value="desktop">独立桌面歌词</option></select></label>
        <label>界面区域<select v-model="region" @change="selectRegion"><option value="">自定义 / 拾取的元素</option><optgroup v-for="group in regionGroups" :key="group" :label="group"><option v-for="item in regions.filter(item => item.group === group && item.target === target)" :key="item.selector" :value="item.selector">{{ item.label }}</option></optgroup></select></label>
        <label>选择器<input v-model="selector" spellcheck="false" @change="readProperties" aria-label="要自定义的元素选择器"></label>
        <small>拾取按页面与元素类型生成选择器，同类型曲目共享样式；可添加 :hover、:focus-visible 或 ::before。当前匹配 {{ matchCount }} 个元素。</small>
        <AnimatedDetails open><template #summary>可视化样式 · 留空恢复继承</template><div class="region-fields"><label v-for="field in properties" :key="field.property">{{ field.label }}<span class="property-input"><input v-if="field.kind === 'color'" type="color" :value="/^#[\da-f]{6}$/i.test(values[field.property] || '') ? values[field.property] : '#ffffff'" :aria-label="field.label + '色板'" @change="changeProperty(field.property, $event.target.value)"><input :value="values[field.property] || ''" :type="field.kind === 'number' ? 'number' : 'text'" :min="field.kind === 'number' ? 0 : undefined" :max="field.kind === 'number' ? 1 : undefined" :step="field.kind === 'number' ? 0.05 : undefined" :placeholder="field.kind === 'length' ? '例：24px / 50%' : '留空使用原样式'" :aria-label="field.label" spellcheck="false" @change="changeProperty(field.property, $event.target.value)"></span></label></div></AnimatedDetails>
        <AnimatedDetails><template #summary>高级 CSS · {{ target === 'main' ? '主窗口' : '桌面歌词' }}</template><p>支持视觉与布局属性、状态选择器、伪元素及 @media / @supports；字体使用本机字体。资源 URL、@import、脚本和外部字体会被拒绝。规则自动限定到所选窗口，优先于组件默认样式。</p><textarea v-model="activeCss" rows="13" spellcheck="false" aria-label="高级 CSS 编辑器" placeholder=".music-player .song-name { font-size: 18px; color: #feca57; }"></textarea><div class="studio-actions"><button type="button" @click="clearCss">清空本窗口 CSS 草稿</button></div></AnimatedDetails>
        <Transition name="ui-fade"><iframe v-if="target === 'desktop'" :srcdoc="desktopPreview" sandbox title="桌面歌词样式预览" class="desktop-preview"></iframe></Transition>
        <p v-if="target === 'desktop'">此预览显示示例歌词；应用后会更新真实桌面歌词窗口。小 / 中 / 大与经典 / 渐变 / 简约模式继续保留，CSS 按你的规则覆盖。</p>
        <div class="studio-actions sticky-actions"><button type="button" @click="preview" :disabled="saving">预览主窗口</button><button type="button" @click="cancelPreview">取消预览</button><button type="button" class="primary" @click="apply" :disabled="saving">{{ saving ? '保存中…' : '应用并保存主题' }}</button></div>
        <Transition name="ui-fade" mode="out-in"><p v-if="message" :key="messageId" :class="{ error }" :role="error ? 'alert' : 'status'">{{ message }}</p></Transition>
        <small>任何时候可用独立「外观恢复」按钮或 Ctrl + Alt + Shift + R 恢复内置外观；草稿关闭后不保存。</small>
      </fieldset></div></Transition>
    </section>
    </Transition>
    <Transition name="picker-hint"><div v-if="picking" data-bk-theme-safety class="bk-picker-hint">点击要编辑的元素 · Esc 取消</div></Transition>
    <Transition name="ui-fade"><div v-if="picking && highlight" data-bk-theme-safety class="bk-picker-highlight" :style="highlight"></div></Transition>
  </Teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import AnimatedDetails from './AnimatedDetails.vue'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { createThemePackage, previewThemePackage, cancelThemePreview } from '../../utils/themeManager.js'
import { compileThemeCss, getThemeCssRule, updateThemeCssRule, normalizeThemePackage } from '../../themes/themePackages.js'
import { THEME_REGIONS, REGION_PROPERTIES, selectorForElement, editThemePackage } from '../../themes/themeAdjustments.js'
const emit = defineEmits(['close'])
const { settings, updateSettings } = useSettingsStore()
const snapshot = ref(createThemePackage(settings))
const css = ref(snapshot.value.css || '')
const desktopCss = ref(snapshot.value.desktopCss || '')
const target = ref('main')
const region = ref('.app-container')
const selector = ref('.app-container')
const regions = THEME_REGIONS
const properties = REGION_PROPERTIES
const values = reactive({})
const minimized = ref(false)
const picking = ref(false)
const highlight = ref(null)
const message = ref('')
const error = ref(false)
const saving = ref(false)
const shown = ref(true)
const closing = ref(false)
const messageId = ref(0)
let disposed = false
let previewTimer = null
const activeCss = computed({ get: () => target.value === 'main' ? css.value : desktopCss.value, set: value => { if (target.value === 'main') css.value = value; else desktopCss.value = value } })
const dirty = computed(() => css.value !== (snapshot.value.css || '') || desktopCss.value !== (snapshot.value.desktopCss || ''))
const regionGroups = computed(() => [...new Set(regions.filter(item => item.target === target.value).map(item => item.group))])
const matchCount = computed(() => {
  if (target.value === 'desktop') return '示例'
  try { return document.querySelectorAll(selector.value).length } catch { return '无效' }
})
const desktopPreview = computed(() => {
  try {
    const sheet = compileThemeCss(desktopCss.value, 'desktop')
    const tokens = Object.entries(snapshot.value.tokens).map(([name, value]) => `${name}:${value}`).join(';')
    return `<!doctype html><html><head><style>:root{${tokens}}body{margin:0;background:#151921;color:white;font:14px system-ui}.lyric-container{padding:22px;text-align:center}.song-info{font-size:12px;opacity:.7}.current-lyric{font-size:24px;margin:12px 0}.karaoke-char.sung{color:#feca57}.next-lyric{opacity:.65}${sheet}</style></head><body data-bk-theme-root="desktop"><div class="lyric-container"><div class="song-info">示例歌曲 · BetterKuGou</div><div class="current-lyric"><span class="karaoke-char sung">让音乐，</span><span class="karaoke-char">更合你意。</span></div><div class="next-lyric">下一句歌词与翻译</div><button class="menu-btn">♫</button></div></body></html>`
  } catch { return '<p>CSS 尚未通过校验，请修正后预览。</p>' }
})
function fail(reason) { error.value = true; message.value = reason.message || '无法应用样式，请检查输入。'; messageId.value++ }
function notify(text) { error.value = false; message.value = text; messageId.value++ }
function readProperties() {
  try {
    const existing = getThemeCssRule(activeCss.value, selector.value)
    for (const key of Object.keys(values)) delete values[key]
    Object.assign(values, existing)
  } catch (reason) { fail(reason) }
}
function selectRegion() { if (region.value) selector.value = region.value; readProperties() }
function chooseFirstRegion() { region.value = regions.find(item => item.target === target.value).selector; selectRegion() }
function changeProperty(property, value) {
  try {
    activeCss.value = updateThemeCssRule(activeCss.value, selector.value, { [property]: value })
    values[property] = value
    if (target.value === 'main') preview()
    else notify('已加入桌面歌词草稿；应用后更新真实窗口。')
  } catch (reason) { fail(reason); readProperties() }
}
function draftPackage() { return normalizeThemePackage({ ...snapshot.value, css: css.value, desktopCss: desktopCss.value }) }
function preview() {
  try {
    previewThemePackage(draftPackage())
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => { cancelThemePreview(); notify('预览已在 30 秒后自动恢复；应用并保存可保留外观。') }, 30000)
    notify('正在临时预览主窗口；30 秒后自动恢复。应用并保存后保留。')
  } catch (reason) { fail(reason) }
}
function cancelPreview() { clearTimeout(previewTimer); previewTimer = null; cancelThemePreview(); notify('已取消预览，保留未保存草稿。') }
async function apply() {
  if (saving.value) return
  try {
    const draft = draftPackage()
    const next = editThemePackage(settings.custom, theme => { theme.base = draft.base; theme.tokens = { ...draft.tokens }; theme.css = draft.css || ''; theme.desktopCss = draft.desktopCss || '' })
    saving.value = true
    const result = await updateSettings({ custom: next })
    if (result?.error) throw result.error
    clearTimeout(previewTimer); cancelThemePreview()
    if (!disposed) { snapshot.value = createThemePackage(settings); css.value = snapshot.value.css || ''; desktopCss.value = snapshot.value.desktopCss || ''; readProperties(); notify('已应用并保存；主窗口与桌面歌词样式会随主题导入导出。') }
  } catch (reason) { cancelThemePreview(); if (!disposed) fail(reason) } finally { if (!disposed) saving.value = false }
}
function loadCurrent() { cancelPreview(); snapshot.value = createThemePackage(settings); css.value = snapshot.value.css || ''; desktopCss.value = snapshot.value.desktopCss || ''; readProperties(); notify('已载入当前保存的主题。') }
function clearCss() { activeCss.value = ''; readProperties(); if (target.value === 'main') preview(); else notify('已清空本窗口 CSS 草稿，应用后保存。') }
async function restoreDefault() {
  try { cancelPreview(); saving.value = true; const result = await updateSettings({ custom: { theme: snapshot.value.base } }); if (result?.error) throw result.error; loadCurrent(); notify('已恢复内置外观，已安装主题仍可重新选择。') } catch (reason) { fail(reason) } finally { saving.value = false }
}
function trackPointer(event) {
  if (!picking.value || event.target.closest?.('[data-bk-theme-safety]')) { highlight.value = null; return }
  const rect = event.target.getBoundingClientRect()
  highlight.value = { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }
}
function pick(event) {
  if (!picking.value || event.target.closest?.('[data-bk-theme-safety]')) return
  event.preventDefault(); event.stopImmediatePropagation()
  try { selector.value = selectorForElement(event.target); target.value = 'main'; region.value = ''; stopPicking(); minimized.value = false; readProperties(); notify('已选中元素类型；修改会限定在当前页面或区域。') } catch (reason) { fail(reason) }
}
function stopPicking() { picking.value = false; highlight.value = null }
function startPicking() { picking.value = !picking.value; minimized.value = picking.value }
function onKey(event) { if (event.key === 'Escape' && picking.value) { event.preventDefault(); event.stopImmediatePropagation(); stopPicking(); minimized.value = false } }
/** Leave the panel mounted until its exit finishes, while immediately cancelling all preview input. */
function close() { if (saving.value || closing.value) return; closing.value = true; stopPicking(); clearTimeout(previewTimer); previewTimer = null; cancelThemePreview(); shown.value = false }
function finishClose() { if (closing.value && !disposed) emit('close') }
onMounted(() => { readProperties(); document.addEventListener('pointermove', trackPointer, true); document.addEventListener('click', pick, true); document.addEventListener('keydown', onKey, true) })
onBeforeUnmount(() => { disposed = true; clearTimeout(previewTimer); cancelThemePreview(); document.removeEventListener('pointermove', trackPointer, true); document.removeEventListener('click', pick, true); document.removeEventListener('keydown', onKey, true) })
</script>

<style scoped>
.bk-theme-studio { position: fixed; right: 14px; top: 58px; z-index: 2147483645; width: min(440px, calc(100vw - 28px)); max-height: calc(100vh - 110px); display: flex; flex-direction: column; color: #e9edf4; background: #1b2230; border: 1px solid #526074; border-radius: 16px; box-shadow: 0 16px 70px #0009; font: 12px/1.65 system-ui, sans-serif; text-align: left; -webkit-app-region: no-drag; }
header { display: flex; gap: 8px; align-items: center; padding: 14px; border-bottom: 1px solid #445063; flex-shrink: 0; }
header > div { flex: 1; min-width: 0; } strong { font-size: 15px; } small { display: block; color: #afbdd2; font-size: 10px; overflow-wrap: anywhere; }
.studio-body { flex: 1 1 auto; padding: 15px; overflow: auto; min-height: 0; min-width: 0; max-height: calc(100vh - 180px); }
.studio-controls { min-width: 0; border: 0; padding: 0; margin: 0; }
p { margin: 0 0 12px; font-size: 11px; } label { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; font-size: 11px; color: #d8e2f2; }
button, input, select, textarea { color: #e9edf4; background: #252f40; border: 1px solid #65738a; border-radius: 6px; font: 11px/1.5 system-ui, sans-serif; min-width: 0; max-width: 100%; }
button { padding: 7px 9px; cursor: pointer; } button:disabled { opacity: .5; cursor: wait; } input, select, textarea { padding: 8px; width: 100%; box-sizing: border-box; }
textarea { resize: vertical; font: 11px/1.8 Consolas, monospace; }
.studio-actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0 14px; } .primary { background: #376ea9; border-color: #8eb2ed; }
.sticky-actions { position: sticky; bottom: -15px; padding: 12px 0; margin-bottom: 0; background: #1b2230; }
.animated-details { border-top: 1px solid #445063; padding: 12px 0; } .animated-details :deep(summary) { cursor: pointer; margin-bottom: 12px; font-size: 12px; }
.region-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 12px; } .property-input { display: flex; gap: 5px; } input[type=color] { width: 32px; flex: 0 0 32px; padding: 2px; min-height: 34px; }
.error { color: #ffacb8; } .desktop-preview { width: 100%; height: 170px; border: 1px solid #526074; border-radius: 8px; }
.bk-picker-highlight { position: fixed; z-index: 2147483644; border: 2px solid #76b6ff; background: #4189e022; pointer-events: none; box-sizing: border-box; }
.bk-picker-hint { position: fixed; z-index: 2147483646; left: 50%; top: 60px; transform: translateX(-50%); padding: 10px 18px; border-radius: 30px; background: #15395a; color: white; font: 12px system-ui; pointer-events: none; }
.bk-picker-highlight { transition: left .1s ease-out, top .1s ease-out, width .1s ease-out, height .1s ease-out, opacity .15s ease; }
.studio-enter-active, .studio-leave-active { transition: opacity .2s ease, transform .24s cubic-bezier(.2,.8,.2,1); }
.studio-enter-from, .studio-leave-to { opacity: 0; transform: translateY(12px) scale(.97); }
.studio-leave-active { pointer-events: none; }
.studio-collapse-enter-active, .studio-collapse-leave-active { transition: max-height .24s ease, padding .24s ease, opacity .18s ease; overflow: hidden; }
.studio-collapse-enter-from, .studio-collapse-leave-to { max-height: 0; padding-block: 0; opacity: 0; }
.picker-hint-enter-active, .picker-hint-leave-active { transition: opacity .18s ease, translate .18s ease; }
.picker-hint-enter-from, .picker-hint-leave-to { opacity: 0; translate: 0 -8px; }
button, input, select, textarea { transition: border-color .16s ease, background-color .16s ease, scale .16s ease; }
button:hover:not(:disabled) { background: #31445f; border-color: #9ccaff; }
button:active:not(:disabled) { scale: .96; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid #9ccaff; outline-offset: 3px; }
@media (max-width: 600px) { .region-fields { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .bk-theme-studio, .studio-body, .bk-picker-hint, .bk-picker-highlight, button, input, select, textarea { transition-duration: .001ms !important; } }
</style>
