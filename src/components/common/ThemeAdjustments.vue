<template>
  <div class="theme-adjustments">
    <div class="adjustment-heading"><div><h3>精细调整</h3><p>立即预览，自动保存为「我的个性主题」。原主题会保留。</p></div><button type="button" class="reset-button" @click="reset">恢复默认细节</button></div>
    <p class="adjustment-note">以下只调整相应界面元素，不会统一缩放整个应用。恢复默认细节会使用当前明暗主题的默认值。</p>
    <label class="font-setting"><span>界面字体</span><select :value="snapshot.tokens['--font-family']" @change="update('--font-family', $event)"><option v-if="!fontOptions.some(item => item.value === snapshot.tokens['--font-family'])" :value="snapshot.tokens['--font-family']">当前主题字体</option><option v-for="font in fontOptions" :key="font.value" :value="font.value">{{ font.label }}</option></select></label>
    <fieldset v-for="group in numberGroups" :key="group" class="adjustment-group"><legend>{{ group }}</legend><div class="adjustment-grid"><label v-for="field in numbers.filter(item => item.group === group)" :key="field.token" class="numeric-setting"><span>{{ field.label }}<small>{{ field.min }}–{{ field.max }} px</small></span><span class="numeric-control"><input type="number" :value="numericValue(field.token)" :min="field.min" :max="field.max" step="1" :aria-label="field.label" @change="update(field.token, $event)"><span>px</span></span></label></div></fieldset>
    <details class="lyric-adjustments"><summary>进阶：全屏歌词配色</summary><p class="adjustment-note">支持十六进制颜色及 rgba()，可保留透明度。只影响全屏歌词，桌面歌词使用独立样式。</p><div class="color-grid"><label v-for="field in lyricColors" :key="field.token" class="lyric-color"><span>{{ field.label }}</span><span class="color-value"><i :style="{ background: snapshot.tokens[field.token] }" aria-hidden="true"></i><input type="text" :value="snapshot.tokens[field.token]" :aria-label="'全屏歌词' + field.label" spellcheck="false" @change="update(field.token, $event)"></span></label></div></details>
    <p v-if="message" class="adjustment-message" :class="{ 'is-error': error }" :role="error ? 'alert' : 'status'">{{ message }}</p>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { createThemePackage } from '../../utils/themeManager.js'
import { FONT_OPTIONS, NUMBER_ADJUSTMENTS, LYRIC_COLOR_ADJUSTMENTS, adjustTheme, resetThemeAdjustments } from '../../themes/themeAdjustments.js'
const props = defineProps({ modelValue: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue'])
const fontOptions = FONT_OPTIONS
const numbers = NUMBER_ADJUSTMENTS
const lyricColors = LYRIC_COLOR_ADJUSTMENTS
const numberGroups = [...new Set(numbers.map(item => item.group))]
const snapshot = computed(() => createThemePackage({ custom: props.modelValue }))
const message = ref('')
const error = ref(false)
function numericValue(token) {
  const resolve = name => snapshot.value.tokens[name].replace(/var\(\s*(--[a-z0-9-]+)\s*\)/gi, (_match, key) => resolve(key))
  const value = resolve(token)
  return parseFloat(value) * (/r?em$/.test(value) ? 16 : 1)
}
function update(token, event) {
  try {
    const next = adjustTheme(props.modelValue, { [token]: event.target.value })
    emit('update:modelValue', next)
    error.value = false
    message.value = '已预览，修改将自动保存到我的个性主题。'
  } catch (reason) {
    error.value = true
    message.value = reason.message || '无法应用，请检查输入值。'
    event.target.value = numbers.some(item => item.token === token) ? numericValue(token) : snapshot.value.tokens[token]
  }
}
function reset() {
  try {
    emit('update:modelValue', resetThemeAdjustments(props.modelValue))
    error.value = false
    message.value = '字体、间距、圆角和歌词配色已恢复默认细节。'
  } catch (reason) {
    error.value = true
    message.value = reason.message
  }
}
</script>

<style scoped>
.theme-adjustments { margin-top: 28px; padding-top: 25px; border-top: 1px solid var(--color-border); min-width: 0; }
.adjustment-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 15px; flex-wrap: wrap; }
h3 { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text); }
.adjustment-heading p, .adjustment-note { margin-top: 7px; color: var(--color-text-secondary); font-size: 11px; line-height: 1.8; }
.reset-button { min-height: 32px; padding: 6px 12px; font-size: 10px; color: var(--color-text-secondary); border: 1px solid var(--color-border); border-radius: 30px; }
.reset-button:hover { color: var(--color-primary); border-color: var(--color-primary); }
.font-setting { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 22px 0; font-size: 12px; color: var(--color-text); }
select, input { background: var(--color-background-light); color: var(--color-text); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 8px 10px; min-height: 35px; font-size: 11px; max-width: 100%; }
select { width: 240px; }
.adjustment-group { border: 0; border-top: 1px solid var(--color-border); min-width: 0; padding: 15px 0 20px; }
legend { color: var(--color-text-secondary); font-size: 11px; padding-right: 12px; }
.adjustment-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 26px; }
.numeric-setting { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--color-text); font-size: 11px; min-width: 0; }
.numeric-setting small { display: block; margin-top: 4px; font-size: 9px; color: var(--color-text-tertiary); }
.numeric-control { display: flex; align-items: center; gap: 5px; color: var(--color-text-tertiary); font-size: 9px; }
.numeric-control input { width: 61px; }
.lyric-adjustments { padding: 18px 0 4px; border-top: 1px solid var(--color-border); }
summary { color: var(--color-text); font-size: 12px; cursor: pointer; }
.color-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 22px; margin-top: 18px; }
.lyric-color { display: flex; flex-direction: column; gap: 9px; font-size: 11px; min-width: 0; }
.color-value { display: flex; gap: 8px; align-items: center; }
.color-value i { flex: 0 0 23px; height: 23px; border-radius: 50%; border: 1px solid var(--color-border); }
.color-value input { min-width: 0; width: 100%; }
.adjustment-message { margin-top: 14px; color: var(--color-text-secondary); font-size: 11px; line-height: 1.8; }
.adjustment-message.is-error { color: var(--color-error); }
input:focus-visible, select:focus-visible, summary:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
@container (max-width: 920px) { .adjustment-grid, .color-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
