<template><Teleport to="body"><div ref="host" data-bk-theme-safety style="display: none !important"></div></Teleport></template>
<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { createThemePackage, previewThemePackage, cancelThemePreview } from '../../utils/themeManager.js'
import { logger } from '../../utils/logger.js'
const props = defineProps({ prepareRestore: { type: Function, default: null } })
const { updateSettings } = useSettingsStore()
const host = ref(null)
let resetButton
let closeButton
let panel
let disposed = false
let saving = false
let visible = false
let previousFocus
let visibilityAnimation
let feedbackAnimation
let motionPreference
function finishVisibility() {
  const animation = visibilityAnimation
  visibilityAnimation = null
  animation?.cancel()
  host.value?.style.setProperty('display', visible ? 'block' : 'none', 'important')
}
function onMotionPreference() {
  if (!motionPreference?.matches) return
  feedbackAnimation?.cancel()
  feedbackAnimation = null
  finishVisibility()
}
/** Keep the recovery surface out of normal playback, and restore focus when the user dismisses it. */
function setVisible(next) {
  if (disposed || !host.value || !panel) return
  const node = host.value
  const wasVisible = visible
  visible = next
  visibilityAnimation?.cancel()
  visibilityAnimation = null
  if (next) {
    if (!wasVisible) previousFocus = document.activeElement
    node.style.setProperty('display', 'block', 'important')
    node.inert = false
    node.removeAttribute('aria-hidden')
    if (!wasVisible) panel.focus({ preventScroll: true })
  } else {
    if (document.activeElement === node && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    node.inert = true
    node.setAttribute('aria-hidden', 'true')
  }
  if (motionPreference?.matches || typeof panel.animate !== 'function' || next === wasVisible) { finishVisibility(); return }
  const frames = [{ opacity: 0, translate: '0 6px' }, { opacity: 1, translate: '0 0' }]
  const animation = panel.animate(next ? frames : frames.toReversed(), { duration: next ? 180 : 140, easing: 'ease-out', fill: 'both' })
  visibilityAnimation = animation
  animation.onfinish = () => { if (!disposed && visibilityAnimation === animation) finishVisibility() }
}
function close() { if (!saving) setVisible(false) }
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
  if (disposed || saving) return
  const restorePanelFocus = document.activeElement === host.value
  saving = true
  setVisible(true)
  const base = document.documentElement.dataset.themeBase === 'light' ? 'light' : 'dark'
  if (resetButton) { resetButton.disabled = true; resetButton.setAttribute('aria-busy', 'true') }
  if (closeButton) closeButton.disabled = true
  showStatus('正在恢复…', 'working')
  let release
  try {
    previewThemePackage(createThemePackage({ custom: { theme: base } }))
    release = await props.prepareRestore?.(base)
    if (disposed) return
    await updateSettings({ custom: { theme: base } })
    const finishRestore = release
    release = null
    await finishRestore?.()
    if (!disposed) {
      cancelThemePreview()
      showStatus('已恢复内置外观', 'success')
    }
  } catch (error) {
    // Keep the safe preview visible even if persistence failed, so the retry remains reachable.
    logger.error('ThemeRecovery', '恢复内置外观失败', error)
    showStatus('保存失败，点击重试恢复', 'error')
  } finally {
    try { await release?.() } catch (error) {
      logger.error('ThemeRecovery', '结束外观恢复事务失败', error)
      showStatus('保存失败，点击重试恢复', 'error')
    }
    saving = false
    if (!disposed && resetButton) { resetButton.disabled = false; resetButton.removeAttribute('aria-busy') }
    if (!disposed && closeButton) closeButton.disabled = false
    // Disabling a clicked retry button can move native focus to body; keep Escape available without stealing another control's focus.
    if (!disposed && visible && restorePanelFocus && (!document.activeElement || document.activeElement === document.body)) panel?.focus({ preventScroll: true })
  }
}
function handleKey(event) {
  if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === 'r') { event.preventDefault(); event.stopImmediatePropagation(); void restore() }
  else if (event.key === 'Escape' && visible && document.activeElement === host.value) { event.preventDefault(); event.stopImmediatePropagation(); close() }
}
onMounted(() => {
  motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  motionPreference?.addEventListener?.('change', onMotionPreference)
  const node = host.value
  node.style.cssText = 'all:initial!important;position:fixed!important;bottom:8px!important;right:10px!important;z-index:2147483647!important;display:none!important;opacity:1!important;visibility:visible!important;transform:none!important;pointer-events:auto!important;'
  node.inert = true
  node.setAttribute('aria-hidden', 'true')
  const shadow = node.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = ':host{color-scheme:dark}section{box-sizing:border-box;padding:8px;max-width:calc(100vw - 20px);font:12px/1.5 system-ui,sans-serif;color:#e4ecf6;background:#1b2638;border:1px solid #7892b4;border-radius:10px;box-shadow:0 3px 15px #0006;-webkit-app-region:no-drag}header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-left:4px}button{display:block;margin:4px;padding:6px 10px;border:1px solid #8ca0bb;border-radius:6px;background:#263b56;color:#fff;font:12px system-ui,sans-serif;cursor:pointer}p{max-width:210px;margin:8px 4px 4px;font-size:11px;color:#cbd8e9}button:focus-visible,section:focus-visible{outline:2px solid #9ecbff;outline-offset:2px}'
  style.textContent += 'button{transition:background-color .16s ease,border-color .16s ease,scale .16s ease}button:hover:not(:disabled){background:#385375}button:active:not(:disabled){scale:.97}button:disabled{cursor:wait;opacity:.65}button[data-state=success]{border-color:#83d7bc}button[data-state=error]{border-color:#ff9eaf;color:#ffd5dd}@media(prefers-reduced-motion:reduce){button{transition:none}}'
  panel = document.createElement('section'); panel.tabIndex = -1; panel.setAttribute('aria-label', '外观恢复')
  const title = document.createElement('strong'); title.textContent = '外观恢复'
  closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.textContent = '关闭'; closeButton.addEventListener('click', close)
  const heading = document.createElement('header'); heading.append(title, closeButton)
  resetButton = document.createElement('button'); resetButton.type = 'button'; resetButton.textContent = '恢复内置外观'; resetButton.addEventListener('click', restore)
  const hint = document.createElement('p'); hint.textContent = '恢复快捷键：Ctrl + Alt + Shift + R。已安装主题仍可重新选择。'
  resetButton.setAttribute('aria-live', 'polite')
  panel.append(heading, resetButton, hint); shadow.append(style, panel)
  document.addEventListener('keydown', handleKey, true)
})
onBeforeUnmount(() => { disposed = true; visibilityAnimation?.cancel(); feedbackAnimation?.cancel(); motionPreference?.removeEventListener?.('change', onMotionPreference); document.removeEventListener('keydown', handleKey, true); resetButton?.removeEventListener('click', restore); closeButton?.removeEventListener('click', close) })
</script>
