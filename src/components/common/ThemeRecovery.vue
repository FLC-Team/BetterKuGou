<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useSettingsStore } from '../../stores/settingsStore.js'
import { createThemePackage, previewThemePackage, cancelThemePreview } from '../../utils/themeManager.js'
import { logger } from '../../utils/logger.js'

const props = defineProps({ prepareRestore: { type: Function, default: null } })
const { updateSettings } = useSettingsStore()
const message = ref('')
const type = ref('info')
const saving = ref(false)
const revision = ref(0)
let disposed = false

/** Restore the safe preview first, drain pending edits, then persist; errors stay in the protected Fue surface. */
async function restore() {
  if (disposed || saving.value) return
  saving.value = true
  message.value = '正在恢复内置外观…'
  type.value = 'info'
  revision.value++
  const base = document.documentElement.dataset.themeBase === 'light' ? 'light' : 'dark'
  let release
  try {
    previewThemePackage(createThemePackage({ custom: { theme: base } }))
    release = await props.prepareRestore?.(base)
    if (disposed) return
    await updateSettings({ custom: { theme: base, backgroundImage: '' } })
    const finishRestore = release
    release = null
    await finishRestore?.()
    if (!disposed) {
      cancelThemePreview()
      type.value = 'success'
      message.value = '已恢复内置外观，已安装主题仍可重新选择。'
    }
  } catch (error) {
    // Keep the safe preview if saving fails so the notification retry remains reachable.
    logger.error('ThemeRecovery', '恢复内置外观失败', error)
    if (!disposed) { type.value = 'error'; message.value = '保存失败，请重试恢复。' }
  } finally {
    try { await release?.() } catch (error) {
      logger.error('ThemeRecovery', '结束外观恢复事务失败', error)
      if (!disposed) { type.value = 'error'; message.value = '保存失败，请重试恢复。' }
    }
    saving.value = false
  }
}
function handleKey(event) {
  if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toLowerCase() === 'r') {
    event.preventDefault()
    event.stopImmediatePropagation()
    void restore()
  }
}
onMounted(() => document.addEventListener('keydown', handleKey, true))
onBeforeUnmount(() => { disposed = true; document.removeEventListener('keydown', handleKey, true) })
</script>

<template>
  <AppNotice :message="message" :type="type" :revision="revision" title="外观恢复" :busy="saving"
    :closable="!saving" :duration="type === 'success' ? 4500 : 0"
    :actions="type === 'error' ? [{ label: '重试恢复', run: restore }] : []" @close="message = ''" />
</template>
