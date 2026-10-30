<template>
  <Teleport to="body">
    <Transition name="dropdown" appear @before-enter="preparePanel" @before-leave="retirePanel">
      <div v-if="visible && !closing" ref="panel" class="dropdown-menu" :class="$attrs.class"
           :style="[panelStyle, $attrs.style]" :data-bk-theme-safety="safety ? '' : undefined"
           @click.stop @contextmenu.prevent @keydown.stop="handleKey">
        <div v-if="$slots.header" class="dropdown-header"><slot name="header" /></div>
        <div :id="id" ref="optionsElement" class="dropdown-options" :role="role" :aria-label="label" tabindex="-1">
          <span class="dropdown-highlight" :class="{ 'is-visible': highlight.visible }" :style="highlightStyle" aria-hidden="true"></span>
          <template v-for="(item, index) in items" :key="item.key ?? item.value ?? index">
            <div v-if="item.divider" class="dropdown-divider" role="separator"></div>
            <template v-else>
              <div v-if="item.group && item.group !== items[index - 1]?.group" class="dropdown-group" role="presentation">{{ item.group }}</div>
              <button type="button" class="dropdown-row" :class="{ 'is-active': activeIndex === index, 'is-selected': isSelected(item), 'is-danger': item.danger }"
                      :data-menu-index="index" :style="{ '--row-delay': `${Math.min(index, 8) * 16}ms` }"
                      :role="role === 'listbox' ? 'option' : item.selected !== undefined ? 'menuitemradio' : 'menuitem'"
                      :aria-selected="role === 'listbox' ? isSelected(item) : undefined"
                      :aria-checked="role !== 'listbox' && item.selected !== undefined ? item.selected : undefined"
                      :disabled="item.disabled" :aria-disabled="item.disabled || undefined" tabindex="-1"
                      @pointermove="activate(index, false)" @pointerdown="activate(index, false)"
                      @focus="activate(index, false)" @click="choose(item)">
                <img v-if="isImage(item.icon)" :src="item.icon" class="dropdown-icon" alt="" />
                <svg v-else-if="item.icon" class="dropdown-icon" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true"><path :d="item.icon" /></svg>
                <span class="dropdown-copy"><span class="dropdown-label">{{ item.label }}</span><span v-if="item.description" class="dropdown-description">{{ item.description }}</span></span>
                <span v-if="item.shortcut" class="dropdown-shortcut">{{ item.shortcut }}</span>
                <svg v-if="role === 'listbox' || item.selected !== undefined" class="dropdown-check" :class="{ 'is-checked': isSelected(item) }" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4.5 10 3.6 3.6 7.4-7.2" /></svg>
              </button>
            </template>
          </template>
          <p v-if="!items.length" class="dropdown-empty">暂无可选项</p>
        </div>
        <div v-if="$slots.footer" class="dropdown-footer"><slot name="footer" /></div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onDeactivated, ref, watch } from 'vue'
import contextMenuManager from '../../utils/contextMenuManager.js'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  visible: Boolean,
  items: { type: Array, default: () => [] },
  anchor: { default: null },
  position: { type: Object, default: () => ({ x: 0, y: 0 }) },
  align: { type: String, default: 'start' },
  placement: { type: String, default: 'auto' },
  label: { type: String, default: '操作菜单' },
  role: { type: String, default: 'menu' },
  activeValue: { default: undefined },
  minWidth: { type: Number, default: 208 },
  initialFocus: { type: String, default: 'selected' },
  id: String,
  safety: Boolean
})
const emit = defineEmits(['close', 'select'])
const panel = ref(null)
const optionsElement = ref(null)
const closing = ref(false)
const activeIndex = ref(-1)
const geometry = ref({ x: 8, y: 8, origin: 'top left', height: 400 })
const highlight = ref({ visible: false, x: 0, y: 0, width: 0, height: 0 })
let opener = null
let observer
let generation = 0
let searchText = ''
let searchTimer
const panelStyle = computed(() => ({
  left: `${geometry.value.x}px`, top: `${geometry.value.y}px`,
  minWidth: `min(${props.minWidth}px, calc(100vw - 16px))`,
  maxHeight: `${geometry.value.height}px`, transformOrigin: geometry.value.origin,
  ...(props.safety ? { '--color-text': '#e9edf4', '--color-text-secondary': '#aebbd0', '--color-background-light': '#1b2330', '--color-border': '#536078', '--color-primary': '#9ccaff' } : {})
}))
const highlightStyle = computed(() => ({ width: `${highlight.value.width}px`, height: `${highlight.value.height}px`, transform: `translate3d(${highlight.value.x}px, ${highlight.value.y}px, 0)` }))
const enabledIndices = () => props.items.flatMap((item, index) => !item.disabled && !item.divider ? [index] : [])
const isSelected = item => item.selected ?? (props.activeValue !== undefined && item.value === props.activeValue)
const isImage = icon => typeof icon === 'string' && (/\.svg(?:[?#].*)?$/.test(icon) || icon.startsWith('data:image/') || icon.startsWith('/'))

/** Measure untransformed layout so opening motion never shifts the popup's final anchor. */
function positionPanel() {
  if (!panel.value || closing.value || !props.visible) return
  const element = panel.value
  const anchor = props.anchor?.getBoundingClientRect?.()
  const width = element.offsetWidth
  const naturalHeight = Math.min(element.scrollHeight, window.innerHeight - 16)
  let above = false
  if (anchor) {
    const belowRoom = window.innerHeight - anchor.bottom - 16
    const aboveRoom = anchor.top - 16
    above = props.placement === 'top' || (props.placement === 'auto' && belowRoom < naturalHeight && aboveRoom > belowRoom)
    if (props.placement === 'top' && aboveRoom < 80 && belowRoom > aboveRoom) above = false
    geometry.value.height = Math.max(64, above ? aboveRoom : belowRoom)
  } else geometry.value.height = window.innerHeight - 16
  const height = Math.min(naturalHeight, geometry.value.height)
  const preferredX = anchor ? (props.align === 'end' ? anchor.right - width : anchor.left) : props.position.x
  const preferredY = anchor ? (above ? anchor.top - height - 8 : anchor.bottom + 8) : props.position.y
  geometry.value = {
    x: Math.max(8, Math.min(preferredX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(preferredY, window.innerHeight - height - 8)),
    height: geometry.value.height,
    origin: `${above ? 'bottom' : 'top'} ${props.align === 'end' ? 'right' : 'left'}`
  }
}

function measureHighlight() {
  const row = optionsElement.value?.querySelector(`[data-menu-index="${activeIndex.value}"]`)
  highlight.value = row ? { visible: true, x: row.offsetLeft, y: row.offsetTop, width: row.offsetWidth, height: row.offsetHeight } : { ...highlight.value, visible: false }
}

function activate(index, focus = true) {
  if (closing.value || !props.visible || props.items[index]?.disabled || props.items[index]?.divider) return
  activeIndex.value = index
  const row = optionsElement.value?.querySelector(`[data-menu-index="${index}"]`)
  if (focus && row) {
    row.focus({ preventScroll: true })
    const scroller = optionsElement.value
    if (row.offsetTop < scroller.scrollTop) scroller.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = row.offsetTop + row.offsetHeight - scroller.clientHeight
  }
  measureHighlight()
}

function preparePanel(element) { element.inert = false; element.removeAttribute('aria-hidden') }
function retirePanel(element) { element.inert = true; element.setAttribute('aria-hidden', 'true') }

/** Retire input immediately; action execution never waits for the visual exit. */
function close(reason = 'dismiss', notify = true) {
  if (closing.value || !props.visible) return
  closing.value = true
  generation++
  if (panel.value) retirePanel(panel.value)
  contextMenuManager.unregisterMenu(dismiss)
  clearTimeout(searchTimer)
  if (['escape', 'select', 'tab'].includes(reason) && opener?.isConnected) opener.focus?.({ preventScroll: true })
  if (notify) emit('close', reason)
}
function dismiss() { close('dismiss') }
function choose(item) {
  if (closing.value || !props.visible || !item || item.disabled || item.divider) return
  close('select', false)
  try { emit('select', item) } finally { emit('close', 'select') }
}

/** Arrow navigation and incremental text lookup share the animated active row. */
function handleKey(event) {
  if (closing.value) return
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault()
    close(event.key === 'Escape' ? 'escape' : 'tab')
    return
  }
  const indices = enabledIndices()
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const current = indices.indexOf(activeIndex.value)
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const next = event.key === 'Home' ? indices[0] : event.key === 'End' ? indices.at(-1)
      : indices[(current < 0 ? (offset > 0 ? 0 : indices.length - 1) : current + offset + indices.length) % indices.length]
    if (next !== undefined) activate(next)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    choose(props.items[activeIndex.value])
  } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
    event.preventDefault()
    clearTimeout(searchTimer)
    searchText += event.key.toLocaleLowerCase()
    const ordered = [...indices.filter(index => index > activeIndex.value), ...indices.filter(index => index <= activeIndex.value)]
    const match = ordered.find(index => String(props.items[index].label).toLocaleLowerCase().startsWith(searchText))
    if (match !== undefined) activate(match)
    searchTimer = setTimeout(() => { searchText = '' }, 650)
  }
}

function outside(event) {
  if (!props.visible || closing.value || panel.value?.contains(event.target) || props.anchor?.contains?.(event.target)) return
  close('outside')
}
function onScroll(event) { if (!panel.value?.contains(event.target)) close('scroll') }
async function show() {
  const ticket = ++generation
  closing.value = false
  searchText = ''
  opener = props.anchor || document.activeElement
  contextMenuManager.registerMenu(dismiss)
  await nextTick()
  if (ticket !== generation || !props.visible || !panel.value) return
  preparePanel(panel.value)
  positionPanel()
  await nextTick()
  if (ticket !== generation || !props.visible || !panel.value) return
  const indices = enabledIndices()
  const selected = indices.find(index => isSelected(props.items[index]))
  if (selected !== undefined || indices.length) activate(props.initialFocus === 'last' ? indices.at(-1) : props.initialFocus === 'first' ? indices[0] : selected ?? indices[0])
  else optionsElement.value?.focus({ preventScroll: true })
  observer?.disconnect()
  observer = new ResizeObserver(() => { positionPanel(); measureHighlight() })
  observer.observe(panel.value)
  if (optionsElement.value) observer.observe(optionsElement.value)
}
watch(() => props.visible, value => {
  if (value) void show()
  else { generation++; closing.value = true; observer?.disconnect(); contextMenuManager.unregisterMenu(dismiss) }
})
watch(() => props.position, () => { if (props.visible) void nextTick(positionPanel) }, { deep: true })
watch(() => props.anchor, () => { if (props.visible) void nextTick(positionPanel) })
watch(() => props.items, async () => {
  await nextTick()
  if (!props.visible || closing.value) return
  const indices = enabledIndices()
  if (!indices.includes(activeIndex.value)) activate(indices[0] ?? -1)
  positionPanel(); measureHighlight()
}, { deep: true })
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', outside)
  window.addEventListener('resize', dismiss)
  window.addEventListener('scroll', onScroll, true)
  if (props.visible) void show()
})
onDeactivated(dismiss)
onBeforeUnmount(() => {
  generation++
  observer?.disconnect()
  clearTimeout(searchTimer)
  contextMenuManager.unregisterMenu(dismiss)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('focusin', outside)
  window.removeEventListener('resize', dismiss)
  window.removeEventListener('scroll', onScroll, true)
})
defineExpose({ close, panel })
</script>

<style scoped>
.dropdown-menu { position: fixed; z-index: 2147483646; display: flex; flex-direction: column; max-width: calc(100vw - 16px); padding: 6px; border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent); border-radius: 16px; background: var(--color-background-light); color: var(--color-text); box-shadow: var(--shadow-menu), 0 0 0 1px color-mix(in srgb, var(--color-primary) 4%, transparent); font: 13px/1.45 var(--font-family, system-ui, sans-serif); overflow: hidden; isolation: isolate; -webkit-app-region: no-drag; }
.dropdown-options { position: relative; min-height: 0; flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; outline: none; scrollbar-width: thin; }
.dropdown-highlight { position: absolute; top: 0; left: 0; border-radius: 10px; background: color-mix(in srgb, var(--color-primary) 11%, transparent); border: 1px solid color-mix(in srgb, var(--color-primary) 14%, transparent); pointer-events: none; opacity: 0; transition: transform 220ms cubic-bezier(.18,.8,.22,1), width 180ms ease, height 180ms ease, opacity 120ms ease; }
.dropdown-highlight.is-visible { opacity: 1; }
.dropdown-row { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 10px 12px; border: 0; border-radius: 10px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; user-select: none; scale: 1; transition: color 160ms ease, scale 140ms ease, background-color 160ms ease; }
.dropdown-row:hover { scale: 1; }
.dropdown-row:active:not(:disabled) { scale: .975; background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
.dropdown-row:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; box-shadow: none; }
.dropdown-row.is-selected { color: var(--color-primary); }
.dropdown-row.is-danger { color: var(--color-error, #ef6464); }
.dropdown-row:disabled { opacity: .38; cursor: not-allowed; }
.dropdown-copy { display: grid; flex: 1; gap: 2px; min-width: 0; }
.dropdown-label { overflow-wrap: anywhere; }
.dropdown-description, .dropdown-shortcut { color: var(--color-text-secondary); font-size: 10px; }
.dropdown-icon { width: 17px; height: 17px; flex-shrink: 0; opacity: .72; transition: opacity 160ms ease, transform 220ms ease, filter 160ms ease; }
img.dropdown-icon { filter: var(--icon-filter); }
.is-active img.dropdown-icon { filter: var(--icon-hover-filter); }
.is-active .dropdown-icon { opacity: 1; transform: translateX(2px); }
.dropdown-check { width: 17px; height: 17px; flex-shrink: 0; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; opacity: 0; transform: scale(.5) rotate(-12deg); transition: opacity 160ms ease, transform 240ms cubic-bezier(.2,1.5,.4,1); }
.dropdown-check.is-checked { opacity: 1; transform: none; }
.dropdown-divider { height: 1px; margin: 5px 9px; background: var(--color-border); opacity: .65; }
.dropdown-group { padding: 10px 12px 5px; color: var(--color-text-secondary); font-size: 10px; letter-spacing: .06em; }
.dropdown-header { flex-shrink: 0; padding: 9px 11px 12px; border-bottom: 1px solid var(--color-border); margin-bottom: 5px; }
.dropdown-footer { flex-shrink: 0; padding: 10px 11px 7px; border-top: 1px solid var(--color-border); margin-top: 5px; color: var(--color-text-secondary); font-size: 11px; line-height: 1.6; }
.dropdown-empty { padding: 12px; color: var(--color-text-secondary); }
.dropdown-enter-active { transition: opacity 200ms ease, transform 280ms cubic-bezier(.16,1,.3,1); }
.dropdown-leave-active { transition: opacity 140ms ease, transform 160ms ease; pointer-events: none; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-5px) scale(.94); }
.dropdown-enter-active .dropdown-row { animation: dropdown-row-in 240ms both cubic-bezier(.16,1,.3,1); animation-delay: var(--row-delay); }
@keyframes dropdown-row-in { from { opacity: 0; translate: 0 5px; } to { opacity: 1; translate: 0 0; } }
@media (prefers-reduced-motion: reduce) {
  .dropdown-menu, .dropdown-menu * { animation: none !important; transition-duration: .01ms !important; transition-delay: 0ms !important; }
  .dropdown-enter-from, .dropdown-leave-to { transform: none; }
  .dropdown-row:active:not(:disabled) { scale: 1; }
}
@media (forced-colors: active) { .dropdown-highlight { background: Highlight; } .dropdown-row.is-active { color: HighlightText; } .dropdown-row.is-selected { font-weight: 700; } }
</style>
