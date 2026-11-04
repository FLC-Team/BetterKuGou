<script setup>
import { h, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { FueButton, useMessage } from '@fue/ui'
import { logger } from '../../utils/logger.js'

// Only adapt application state/actions. Fue owns every visible notification and its lifecycle.
const props = defineProps({
  message: { type: [String, Number], default: '' },
  title: { type: String, default: '' },
  type: { type: String, default: 'info' },
  revision: { type: [String, Number], default: 0 },
  actions: { type: Array, default: () => [] },
  duration: { type: Number, default: undefined },
  closable: { type: Boolean, default: true },
  busy: { type: Boolean, default: false }
})
const emit = defineEmits(['close'])
const api = useMessage()
const running = ref(false)
const closing = ref(false)
const actionError = ref('')
let id = null
let generation = 0
let active = true
let disposed = false
const titles = { info: '提示', success: '操作成功', warning: '请注意', error: '操作未完成' }

/** Close only this owner's entry; replacement/unmount must not clear the caller's newer state. */
function remove() {
  const previous = id
  id = null
  generation++
  if (previous != null) api.destroy(previous)
}

/** Reject stale transition clicks and serialize async actions while retaining the retry on failure. */
async function runAction(action, version) {
  if (disposed || !active || closing.value || id == null || version !== generation || !props.actions.includes(action) || running.value || props.busy || action.disabled) return
  running.value = true
  actionError.value = ''
  try { await action.run?.() } catch (error) {
    logger.warn('AppNotice', '通知操作未完成', error)
    if (!disposed && active && !closing.value && version === generation) actionError.value = error?.message || '操作未完成，请重试。'
  } finally { if (version === generation) running.value = false }
}

/** Synchronize state with the original Fue provider, without maintaining another notification list. */
function publish() {
  remove()
  running.value = false
  closing.value = false
  actionError.value = ''
  if (disposed || !active || !String(props.message || '').trim()) return
  const version = generation
  const type = Object.hasOwn(titles, props.type) ? props.type : 'info'
  id = api.create({
    title: props.title || titles[type], type,
    duration: props.duration ?? (props.actions.length || ['error', 'warning'].includes(type) ? 0 : 4500),
    closable: props.closable,
    pauseOnHover: true,
    underBar: true,
    content: () => h('div', [
      h('span', String(props.message)),
      actionError.value ? h('p', { role: 'alert' }, actionError.value) : null,
      props.actions.length ? h('div', { class: 'bk-notice-actions' }, props.actions.map(action => h(FueButton, {
        size: 'small', disabled: closing.value || props.busy || running.value || Boolean(action.disabled),
        onClick: () => runAction(action, version)
      }, { default: () => action.label }))) : null
    ]),
    onClose: () => {
      if (!props.closable) return false
      if (version === generation) closing.value = true
      return true
    },
    onAfterLeave: () => {
      if (disposed || version !== generation || id == null) return
      id = null
      generation++
      running.value = false
      emit('close')
    }
  })
}
watch(() => [props.message, props.title, props.type, props.revision, props.duration, props.closable], publish, { immediate: true })
onDeactivated(() => { active = false; remove() })
onActivated(() => { if (!active) { active = true; publish() } })
onBeforeUnmount(() => { disposed = true; remove() })
</script>

<template><!-- Message markup, timers and transitions belong exclusively to FueMessageProvider. --></template>
