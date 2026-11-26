<template>
  <Teleport to="body">
    <dialog ref="surface" class="app-dialog" data-bk-theme-safety
      aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message"
      :data-tone="current?.options.tone" :data-closing="closing || undefined"
      @cancel.prevent="choose(null)" @keydown.stop="handleKey" @animationend.self="finishLeave">
      <section v-if="current" class="dialog-panel">
        <div class="dialog-intro">
          <div class="dialog-record" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 14v4m5-8v12m5-17v22m5-17v12m5-8v4" />
            </svg>
          </div>
          <div>
            <p class="dialog-eyebrow">BetterKuGou <span v-if="current.options.eyebrow">/ {{ current.options.eyebrow }}</span></p>
            <h2 id="app-dialog-title">{{ current.options.title }}</h2>
            <p id="app-dialog-message">{{ current.options.message }}</p>
          </div>
        </div>
        <footer class="dialog-footer">
          <label v-if="current.options.checkboxLabel" class="dialog-checkbox">
            <input v-model="checked" type="checkbox" /> {{ current.options.checkboxLabel }}
          </label>
          <div class="dialog-actions">
            <button v-for="action in current.options.actions" :key="action.id" type="button"
              :data-variant="action.variant" :autofocus="action.id === current.options.defaultAction"
              :aria-disabled="closing || undefined" @click="choose(action.id)">{{ action.label }}</button>
          </div>
        </footer>
      </section>
    </dialog>
  </Teleport>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { logger } from '../../utils/logger.js'

const props = defineProps({ blocked: Boolean })
const surface = ref(null)
const current = shallowRef(null)
const checked = ref(false)
const closing = ref(false)
const canceled = { action: null, checked: false }
let result = canceled
let leaveTimer
let offRequest
let offCancel

/** 同一窗口只允许一个确认请求，后来的请求按取消处理。 */
function ask(options, requestId = null) {
  if (props.blocked || current.value || !surface.value) return Promise.resolve(canceled)
  checked.value = false
  return new Promise(resolve => { current.value = { options, requestId, resolve } })
}

watch(current, request => {
  if (!request) return
  try {
    surface.value.showModal()
  } catch (error) {
    logger.error('AppDialog', '打开全屏确认弹窗失败', error)
    finish(canceled)
  }
}, { flush: 'post' })

/** 保留模态层直到退场结束，关闭时由浏览器归还焦点。 */
function finish(response) {
  const request = current.value
  if (!request) return
  clearTimeout(leaveTimer)
  surface.value?.close()
  current.value = null
  closing.value = false
  result = canceled
  request.resolve(response)
}

function finishLeave(event) {
  if (closing.value && (!event || event.animationName.startsWith('app-dialog-out'))) finish(result)
}

function choose(action) {
  if (!current.value || closing.value) return
  result = { action, checked: action !== null && checked.value }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) {
    finish(result)
    return
  }
  closing.value = true
  // 后台窗口或主题关闭 CSS 动画时仍需结算请求。
  leaveTimer = setTimeout(finishLeave, 230)
}

function handleKey(event) {
  if (closing.value || (event.repeat && ['Enter', ' '].includes(event.key))) {
    event.preventDefault()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    choose(null)
  } else if (event.key === 'Tab') {
    const items = [...surface.value.querySelectorAll('input, button')]
    const first = items[0]
    const last = items.at(-1)
    if (event.shiftKey ? event.target === first : event.target === last) {
      event.preventDefault()
      const next = event.shiftKey ? last : first
      next?.focus()
    }
  }
}

watch(() => props.blocked, blocked => { if (blocked) finish(canceled) })

function cancelLocal() {
  if (current.value?.requestId === null) finish(canceled)
}

onMounted(() => {
  const bridge = window.electronAPI?.appDialog
  offRequest = bridge?.onRequest(async ({ requestId, ...options }) => {
    const response = await ask(options, requestId)
    bridge.respond(requestId, response)
  })
  offCancel = bridge?.onCancel(requestId => {
    if (current.value?.requestId === requestId) finish(canceled)
  })
})

onBeforeUnmount(() => {
  offRequest?.()
  offCancel?.()
  finish(canceled)
})

defineExpose({ ask, cancelLocal })
</script>

<style scoped src="./AppDialog.css"></style>
