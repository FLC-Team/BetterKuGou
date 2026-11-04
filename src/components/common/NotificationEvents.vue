<script setup>
import { onBeforeUnmount } from 'vue'
import { useMessage } from '@fue/ui'

const api = useMessage()
const entries = new Map()
let disposed = false
/** Desktop windows and main-process failures use the same renderer-owned Fue notification surface. */
const unsubscribe = window.electronAPI?.onAppNotice?.(notice => {
  if (disposed || !notice?.message) return
  const key = notice.id || `${notice.type}:${notice.title || ''}:${notice.message}`
  const previous = entries.get(key)
  if (previous != null) api.destroy(previous)
  const type = ['success', 'warning', 'error', 'info'].includes(notice.type) ? notice.type : 'info'
  const id = api.create({ title: notice.title || '提示', content: notice.message, type,
    duration: ['error', 'warning'].includes(type) ? 0 : 4500,
    pauseOnHover: true, underBar: true,
    onAfterLeave: () => { if (entries.get(key) === id) entries.delete(key) }
  })
  entries.set(key, id)
})
onBeforeUnmount(() => {
  disposed = true
  unsubscribe?.()
  for (const id of entries.values()) api.destroy(id)
  entries.clear()
})
</script>
<template><!-- Fixed IPC events are rendered by the parent Fue provider. --></template>
