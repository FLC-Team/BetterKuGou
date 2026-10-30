<template>
  <button v-bind="$attrs" ref="trigger" type="button" class="animated-select-trigger"
          :class="{ 'is-open': expanded, 'is-busy': busy }" :disabled="disabled"
          :aria-label="`${label}：${selected?.label || placeholder}${status ? `，${status}` : ''}`" aria-haspopup="listbox" :aria-expanded="expanded" :aria-controls="menuId"
          :aria-busy="busy || undefined" @click="toggle" @keydown.stop="handleKey">
    <span class="select-value-stage"><Transition name="select-value"><span :key="`${typeof modelValue}:${modelValue}`" class="select-value">{{ selected?.shortLabel || selected?.label || placeholder }}</span></Transition></span>
    <span class="select-indicators" aria-hidden="true"><span v-if="busy" class="select-spinner"></span><svg v-else class="select-chevron" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" /></svg></span>
  </button>
  <DropdownMenu :id="menuId" :visible="expanded" :anchor="trigger" :items="options" :active-value="modelValue"
                role="listbox" :label="label" :placement="placement" :min-width="menuWidth" :safety="safety" :initial-focus="initialFocus"
                @select="choose" @close="expanded = false">
    <template v-if="status || note" #footer>
      <Transition name="select-status" mode="out-in"><span :key="status" class="select-status" role="status">{{ status }}</span></Transition>
      <span v-if="note" class="select-note">{{ note }}</span>
    </template>
  </DropdownMenu>
</template>

<script setup>
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from 'vue'
import DropdownMenu from './DropdownMenu.vue'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  modelValue: { default: undefined },
  options: { type: Array, default: () => [] },
  label: { type: String, default: '选择选项' },
  placeholder: { type: String, default: '请选择' },
  disabled: Boolean,
  busy: Boolean,
  status: String,
  note: String,
  safety: Boolean,
  placement: { type: String, default: 'auto' }
})
const emit = defineEmits(['update:modelValue', 'change'])
const trigger = ref(null)
const expanded = ref(false)
const initialFocus = ref('selected')
const menuWidth = ref(208)
const menuId = `bk-select-${useId()}`
const selected = computed(() => props.options.find(option => option.value === props.modelValue))
let feedback
let disabledObserver
let motionPreference
const settleFeedback = () => { if (motionPreference?.matches) feedback?.cancel() }
const unavailable = () => props.disabled || trigger.value?.matches(':disabled') || Boolean(trigger.value?.closest?.('[inert], [hidden]'))
function open(focus = 'selected') {
  if (unavailable()) return
  menuWidth.value = Math.max(208, trigger.value?.offsetWidth || 0)
  initialFocus.value = focus
  expanded.value = true
}
function close(restoreFocus = false) { expanded.value = false; if (restoreFocus) trigger.value?.focus({ preventScroll: true }) }
function toggle() { if (expanded.value) close(); else open() }
function handleKey(event) {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); open(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : 'selected') }
  else if (event.key === 'Escape' && expanded.value) { event.preventDefault(); close(true) }
}
/** Preserve typed values and emit re-selections for operations such as quality retry. */
function choose(option) {
  if (unavailable() || option.disabled) return
  emit('update:modelValue', option.value)
  emit('change', option.value)
  feedback?.cancel()
  if (!(motionPreference || window.matchMedia('(prefers-reduced-motion: reduce)')).matches) {
    feedback = trigger.value?.animate([{ boxShadow: '0 0 0 0 color-mix(in srgb, var(--color-primary) 28%, transparent)' }, { boxShadow: '0 0 0 7px transparent' }], { duration: 360, easing: 'ease-out' })
  }
}
watch(() => props.disabled, value => { if (value) close() })
watch(expanded, value => {
  disabledObserver?.disconnect()
  if (!value) return
  disabledObserver = new MutationObserver(() => { if (unavailable()) close() })
  // The popup is teleported; retiring its original surface must also retire the menu.
  for (let ancestor = trigger.value; ancestor; ancestor = ancestor.parentElement) {
    disabledObserver.observe(ancestor, { attributes: true, attributeFilter: ancestor.tagName === 'FIELDSET' ? ['disabled', 'inert', 'hidden'] : ['inert', 'hidden'] })
  }
})
onDeactivated(() => close())
onMounted(() => {
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
  motionPreference.addEventListener?.('change', settleFeedback)
})
onBeforeUnmount(() => {
  feedback?.cancel()
  disabledObserver?.disconnect()
  motionPreference?.removeEventListener?.('change', settleFeedback)
})
defineExpose({ open, close })
</script>

<style scoped>
.animated-select-trigger { display: inline-flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 100px; max-width: 100%; min-height: 38px; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: 11px; background: var(--color-background-light); color: var(--color-text); font: inherit; font-size: 12px; text-align: left; cursor: pointer; -webkit-app-region: no-drag; transition: border-color 180ms ease, background-color 180ms ease, box-shadow 200ms ease, scale 140ms ease; }
.animated-select-trigger:hover, .animated-select-trigger.is-open { border-color: color-mix(in srgb, var(--color-primary) 60%, var(--color-border)); background: color-mix(in srgb, var(--color-primary) 5%, var(--color-background-light)); }
.animated-select-trigger.is-open { box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 10%, transparent); }
.animated-select-trigger:disabled { opacity: .45; cursor: not-allowed; }
.select-value-stage { display: grid; min-width: 0; overflow: hidden; flex: 1; }
.select-value { grid-area: 1 / 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.select-indicators { display: grid; place-items: center; flex-shrink: 0; width: 14px; height: 14px; color: var(--color-text-secondary); }
.select-chevron { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; transition: transform 280ms cubic-bezier(.2,.8,.2,1), color 180ms ease; }
.is-open .select-chevron { transform: rotate(180deg); color: var(--color-primary); }
.select-spinner { width: 11px; height: 11px; border: 1.5px solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: select-spin 700ms linear infinite; }
.select-note { display: block; margin-top: 3px; opacity: .65; font-size: 10px; }
.select-status { display: block; }
.select-value-enter-active, .select-value-leave-active { transition: opacity 160ms ease, translate 220ms cubic-bezier(.16,1,.3,1); }
.select-value-enter-from { opacity: 0; translate: 0 9px; }
.select-value-leave-to { opacity: 0; translate: 0 -9px; }
.select-status-enter-active, .select-status-leave-active { transition: opacity 100ms ease; }
.select-status-enter-from, .select-status-leave-to { opacity: 0; }
@keyframes select-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .animated-select-trigger, .select-chevron, .select-value, .select-status { transition-duration: .01ms !important; }
  .select-value-enter-from, .select-value-leave-to { translate: none; }
  .select-spinner { animation: none; border-color: var(--color-primary); border-style: dotted; }
}
</style>
