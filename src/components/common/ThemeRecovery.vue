<template><Teleport to="body"><div ref="host" data-bk-theme-safety></div></Teleport></template>
<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { createThemePackage, previewThemePackage, cancelThemePreview } from '../../utils/themeManager.js'
import { createDetailsMotion } from './detailsMotion.js'
const emit = defineEmits(['open-editor'])
const props = defineProps({ prepareRestore: { type: Function, default: null } })
const { settings, updateSettings } = useSettingsStore()
const host = ref(null)
let resetButton
let disposed = false
let saving = false
let disclosureMotion
let feedbackAnimation
let motionPreference
function onMotionPreference() { if (motionPreference?.matches) { feedbackAnimation?.cancel(); feedbackAnimation = null } }
function showStatus(text, state) {
  if (disposed || !resetButton) return
  resetButton.textContent = text
  resetButton.dataset.state = state
  feedbackAnimation?.cancel()
  if (!motionPreference?.matches) {
    feedbackAnimation = resetButton.animate?.([{ opacity: .45, translate: '0 3px' }, { opacity: 1, translate: '0 0' }], { duration: 180, easing: 'ease-out' })
  }
}
/** The host is outside #app and its shadow DOM is independent of themes, including inherited font/colour variables. */
async function restore() {
  if (saving) return
  saving = true
  const base = document.documentElement.dataset.themeBase === 'light' ? 'light' : 'dark'
  previewThemePackage(createThemePackage({ custom: { theme: base } }))
  if (resetButton) { resetButton.disabled = true; resetButton.setAttribute('aria-busy', 'true') }
  showStatus('正在恢复…', 'working')
  let release
  try {
    release = await props.prepareRestore?.(base)
    await updateSettings({ custom: { theme: base } })
    await release?.()
    release = null
    cancelThemePreview()
    showStatus('已恢复内置外观', 'success')
  } catch {
    // Keep the safe preview visible even if persistence failed, so the retry remains reachable.
    showStatus('保存失败，点击重试恢复', 'error')
  } finally { await release?.(); saving = false; if (!disposed && resetButton) { resetButton.disabled = false; resetButton.removeAttribute('aria-busy') } }
}
function handleKey(event) {
  if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === 'r') { event.preventDefault(); event.stopImmediatePropagation(); void restore() }
}
onMounted(() => {
  motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  motionPreference?.addEventListener?.('change', onMotionPreference)
  const node = host.value
  node.style.cssText = 'all:initial!important;position:fixed!important;bottom:8px!important;right:10px!important;z-index:2147483647!important;display:block!important;opacity:1!important;visibility:visible!important;transform:none!important;pointer-events:auto!important;'
  const shadow = node.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = ':host{color-scheme:dark}details{font:11px/1.5 system-ui,sans-serif;color:#e4ecf6;background:#1b2638;border:1px solid #7892b4;border-radius:10px;box-shadow:0 3px 15px #0006;-webkit-app-region:no-drag}summary{cursor:pointer;padding:4px 9px;list-style:none}button{display:block;margin:8px;padding:6px 10px;border:1px solid #8ca0bb;border-radius:6px;background:#263b56;color:#fff;font:12px system-ui,sans-serif;cursor:pointer}p{max-width:190px;padding:0 10px;font-size:10px;color:#cbd8e9}button:focus-visible,summary:focus-visible{outline:2px solid #9ecbff}'
  style.textContent += 'details{box-sizing:border-box;animation:recovery-enter .22s ease-out}button,summary{transition:background-color .16s ease,border-color .16s ease,scale .16s ease}button:hover:not(:disabled),summary:hover{background:#385375}button:active:not(:disabled),summary:active{scale:.97}button:disabled{cursor:wait;opacity:.65}button[data-state=success]{border-color:#83d7bc}button[data-state=error]{border-color:#ff9eaf;color:#ffd5dd}@keyframes recovery-enter{from{opacity:0;translate:0 5px}to{opacity:1;translate:0 0}}@media(prefers-reduced-motion:reduce){details{animation:none}button,summary{transition:none}}'
  const details = document.createElement('details')
  const summary = document.createElement('summary'); summary.textContent = '外观恢复 / 编辑'; summary.title = '始终可用的外观恢复入口'
  const editButton = document.createElement('button'); editButton.type = 'button'; editButton.textContent = '打开界面编辑器'; editButton.addEventListener('click', () => { emit('open-editor'); disclosureMotion?.setOpen(false) })
  resetButton = document.createElement('button'); resetButton.type = 'button'; resetButton.textContent = '恢复内置外观'; resetButton.addEventListener('click', restore)
  const hint = document.createElement('p'); hint.textContent = '恢复快捷键：Ctrl + Alt + Shift + R。已安装主题仍可重新选择。'
  resetButton.setAttribute('aria-live', 'polite')
  const content = document.createElement('div'); content.append(editButton, resetButton, hint)
  details.append(summary, content); shadow.append(style, details)
  disclosureMotion = createDetailsMotion(details)
  document.addEventListener('keydown', handleKey, true)
})
onBeforeUnmount(() => { disposed = true; disclosureMotion?.dispose(); feedbackAnimation?.cancel(); motionPreference?.removeEventListener?.('change', onMotionPreference); document.removeEventListener('keydown', handleKey, true); resetButton?.removeEventListener('click', restore) })
</script>
