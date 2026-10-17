<template>
  <div class="theme-adjustments">
    <div class="adjustment-heading"><div><h3>界面个性化</h3><p>编辑完整主题令牌，或按区域、拾取元素调整界面。原主题会保留。</p></div><button type="button" @click="$emit('open-studio')">打开可视化编辑器 / 高级 CSS</button></div>
    <p class="adjustment-note">颜色接受 #RRGGBB、rgba() 和主题变量，支持透明度；尺寸直接作用于对应文字、间距或圆角。区域编辑器还能调整封面、按钮、面板、桌面歌词与任意拾取元素。</p>
    <label class="token-search"><span>查找外观参数（{{ fields.length }} 项）</span><input v-model="query" type="search" placeholder="搜索名称、变量或区域" aria-label="搜索外观参数"></label>
    <TransitionGroup name="ui-list" tag="div" class="token-groups ui-list-container" @before-leave="freezeGridLeave" @before-enter="clearGridLeave" @leave-cancelled="clearGridLeave">
    <AnimatedDetails v-for="group in groups" :key="group" class="token-group" :open="Boolean(query)">
      <template #summary>{{ group }} <small>{{ matching(group).length }} 项</small><button type="button" @click.prevent="resetGroup(group)">恢复本组</button></template>
      <TransitionGroup name="ui-list" tag="div" class="token-grid ui-list-container" @before-leave="freezeGridLeave" @before-enter="clearGridLeave" @leave-cancelled="clearGridLeave">
        <label v-for="field in matching(group)" :key="field.token" class="token-field"><span>{{ field.label }}<code>{{ field.token }}</code></span>
          <span class="token-value">
            <input v-if="field.kind === 'color' && /^#[\da-f]{6}$/i.test(snapshot.tokens[field.token])" type="color" :value="snapshot.tokens[field.token]" :aria-label="field.label + '色板'" @change="update(field.token, $event)">
            <input v-if="field.kind === 'size'" type="number" :value="sizeValue(field.token)" :min="field.token.includes('font-size') ? 8 : 0" :max="field.token === '--radius-full' ? 9999 : field.token.includes('font-size') ? 64 : 120" step="1" :aria-label="field.label + '（像素）'" @change="updateSize(field.token, $event)">
            <input v-else type="text" :value="snapshot.tokens[field.token]" :aria-label="field.label" spellcheck="false" @change="update(field.token, $event)">
            <small v-if="field.kind === 'size'">px</small>
          </span>
        </label>
      </TransitionGroup>
    </AnimatedDetails>
    </TransitionGroup>
    <Transition name="ui-fade" mode="out-in"><p v-if="message" :key="messageKey + ':' + message" :class="['adjustment-message', { 'is-error': error }]" :role="error ? 'alert' : 'status'">{{ message }}</p></Transition>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import AnimatedDetails from './AnimatedDetails.vue'
import { freezeGridLeave, clearGridLeave } from './motionLayout.js'
import { createThemePackage } from '../../utils/themeManager.js'
import { BUILTIN_THEMES } from '../../themes/themePackages.js'
import { TOKEN_FIELDS, adjustThemeTokens } from '../../themes/themeAdjustments.js'
const props = defineProps({ modelValue: { type: Object, required: true } })
const emit = defineEmits(['update:modelValue', 'open-studio'])
const fields = TOKEN_FIELDS
const query = ref('')
const snapshot = computed(() => createThemePackage({ custom: props.modelValue }))
const filtered = computed(() => fields.filter(field => `${field.label} ${field.token} ${field.group}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const groups = computed(() => [...new Set(filtered.value.map(field => field.group))])
const matching = group => filtered.value.filter(field => field.group === group)
const message = ref('')
const error = ref(false)
const messageKey = ref(0)
function reportError(reason) { error.value = true; message.value = reason.message; messageKey.value++ }
function sizeValue(token) {
  const value = snapshot.value.tokens[token]
  return parseFloat(value) * (/r?em$/.test(value) ? 16 : 1)
}
function apply(patch) {
  emit('update:modelValue', adjustThemeTokens(props.modelValue, patch))
  error.value = false
  message.value = '已应用，沿设置保存流程自动保存到我的个性主题。'
  messageKey.value++
}
function update(token, event) {
  try { apply({ [token]: event.target.value }) } catch (reason) { reportError(reason); event.target.value = snapshot.value.tokens[token] }
}
function updateSize(token, event) {
  try { apply({ [token]: `${event.target.value}px` }) } catch (reason) { reportError(reason); event.target.value = sizeValue(token) }
}
function resetGroup(group) {
  try {
    const builtin = BUILTIN_THEMES.find(theme => theme.id === snapshot.value.base)
    apply(Object.fromEntries(fields.filter(field => field.group === group).map(field => [field.token, builtin.tokens[field.token]])))
  } catch (reason) { reportError(reason) }
}
</script>

<style scoped>
.theme-adjustments { margin-top: 28px; padding-top: 25px; border-top: 1px solid var(--color-border); min-width: 0; }
.adjustment-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 15px; flex-wrap: wrap; }
h3 { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text); }
.adjustment-heading p, .adjustment-note { margin: 7px 0 16px; color: var(--color-text-secondary); font-size: var(--font-size-xs); line-height: 1.8; }
button { min-height: 32px; padding: 6px 12px; font-size: 12px; color: var(--color-text); border: 1px solid var(--color-border); border-radius: var(--radius-md); cursor: pointer; }
.token-search { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin: 20px 0; font-size: var(--font-size-xs); }
input { min-width: 0; width: 100%; background: var(--color-background-light); color: var(--color-text); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 8px; min-height: 35px; font-size: 12px; }
.token-search input { width: 260px; max-width: 100%; }
.token-group { border-top: 1px solid var(--color-border); padding: 15px 0; }
.token-group :deep(summary) { display: flex; gap: 12px; align-items: center; color: var(--color-text); font-size: var(--font-size-sm); cursor: pointer; }
.token-group small { color: var(--color-text-secondary); font-size: 11px; }
.token-group button { margin-left: auto; font-size: 10px; min-height: 25px; }
.token-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 18px 26px; padding: 20px 0; }
.token-field { display: flex; flex-direction: column; gap: 10px; min-width: 0; color: var(--color-text); font-size: var(--font-size-xs); }
code { display: block; color: var(--color-text-tertiary); font: 10px/1.6 monospace; overflow-wrap: anywhere; }
.token-value { display: flex; gap: 8px; align-items: center; }
input[type=color] { width: 38px; padding: 3px; flex-shrink: 0; }
.adjustment-message { color: var(--color-text-secondary); font-size: 12px; line-height: 1.8; }
.adjustment-message.is-error { color: var(--color-error); }
input:focus-visible, summary:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
</style>
