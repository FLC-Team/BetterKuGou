<template><Teleport to="body"><div ref="host" data-bk-theme-safety></div></Teleport></template>
<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { createThemePackage, previewThemePackage, cancelThemePreview } from '../../utils/themeManager.js'
const emit = defineEmits(['open-editor'])
const props = defineProps({ prepareRestore: { type: Function, default: null } })
const { settings, updateSettings } = useSettingsStore()
const host = ref(null)
let resetButton
let disposed = false
let saving = false
/** The host is outside #app and its shadow DOM is independent of themes, including inherited font/colour variables. */
async function restore() {
  if (saving) return
  saving = true
  const base = document.documentElement.dataset.themeBase === 'light' ? 'light' : 'dark'
  previewThemePackage(createThemePackage({ custom: { theme: base } }))
  if (resetButton) resetButton.textContent = '正在恢复…'
  let release
  try {
    release = await props.prepareRestore?.(base)
    await updateSettings({ custom: { theme: base } })
    await release?.()
    release = null
    cancelThemePreview()
    if (!disposed && resetButton) resetButton.textContent = '已恢复内置外观'
  } catch {
    // Keep the safe preview visible even if persistence failed, so the retry remains reachable.
    if (!disposed && resetButton) resetButton.textContent = '保存失败，点击重试恢复'
  } finally { await release?.(); saving = false }
}
function handleKey(event) {
  if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === 'r') { event.preventDefault(); event.stopImmediatePropagation(); void restore() }
}
onMounted(() => {
  const node = host.value
  node.style.cssText = 'all:initial!important;position:fixed!important;bottom:8px!important;right:10px!important;z-index:2147483647!important;display:block!important;opacity:1!important;visibility:visible!important;transform:none!important;pointer-events:auto!important;'
  const shadow = node.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = ':host{color-scheme:dark}details{font:11px/1.5 system-ui,sans-serif;color:#e4ecf6;background:#1b2638;border:1px solid #7892b4;border-radius:10px;box-shadow:0 3px 15px #0006;-webkit-app-region:no-drag}summary{cursor:pointer;padding:4px 9px;list-style:none}button{display:block;margin:8px;padding:6px 10px;border:1px solid #8ca0bb;border-radius:6px;background:#263b56;color:#fff;font:12px system-ui,sans-serif;cursor:pointer}p{max-width:190px;padding:0 10px;font-size:10px;color:#cbd8e9}button:focus-visible,summary:focus-visible{outline:2px solid #9ecbff}'
  const details = document.createElement('details')
  const summary = document.createElement('summary'); summary.textContent = '外观恢复 / 编辑'; summary.title = '始终可用的外观恢复入口'
  const editButton = document.createElement('button'); editButton.type = 'button'; editButton.textContent = '打开界面编辑器'; editButton.addEventListener('click', () => { emit('open-editor'); details.open = false })
  resetButton = document.createElement('button'); resetButton.type = 'button'; resetButton.textContent = '恢复内置外观'; resetButton.addEventListener('click', restore)
  const hint = document.createElement('p'); hint.textContent = '恢复快捷键：Ctrl + Alt + Shift + R。已安装主题仍可重新选择。'
  details.append(summary, editButton, resetButton, hint); shadow.append(style, details)
  document.addEventListener('keydown', handleKey, true)
})
onBeforeUnmount(() => { disposed = true; document.removeEventListener('keydown', handleKey, true); resetButton?.removeEventListener('click', restore) })
</script>
