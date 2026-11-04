<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { FueConfigProvider, FueMessageProvider, zhCN } from '@fue/ui'
import fueStyles from '@fue/ui/style.css?inline'
import AppNotice from './AppNotice.vue'
import NotificationEvents from './NotificationEvents.vue'

defineProps({ startupFailure: { type: Object, default: null } })
const target = ref(null)
let host
let readyFrame
let disposed = false
let previousFocus
const quitAfterStartupFailure = () => window.electronAPI?.quitAfterStartupFailure?.()
/** F8 reaches notifications even from a modal focus trap; Escape returns to the originating control. */
function focusNotifications(event) {
  if (event.key !== 'F8' || event.ctrlKey || event.altKey || event.metaKey) return
  const notification = [...(host?.shadowRoot?.querySelectorAll('.fue-alert:not(.fue-alert-leave-active)') || [])].at(-1)
  if (!notification) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (document.activeElement !== host) previousFocus = document.activeElement
  notification.tabIndex = -1
  const item = notification.closest('.fue-message-item')
  const list = item?.parentElement
  // Use layout offsets so the horizontal enter transform cannot scroll the clipped X axis.
  if (list) {
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight
    list.scrollLeft = 0
  }
  notification.focus({ preventScroll: true })
}
/** An evicted library message skips close guards; disable its controls throughout the leave animation. */
function protectLeavingNotice(event) {
  if (!event.composedPath().some(node => node?.classList?.contains('fue-alert-leave-active') || node?.classList?.contains('fue-message-leave-active'))) return
  event.preventDefault()
  event.stopImmediatePropagation()
}
function isolateNotificationKeys(event) {
  event.stopPropagation()
  if (event.key !== 'Escape') return
  event.preventDefault()
  const notice = event.composedPath().find(node => node?.classList?.contains('fue-alert'))
  // Use the library's guarded close control; required notices have no close control.
  notice?.querySelector('.fue-alert__close')?.click()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
}
const themeOverrides = {
  common: {
    colorPrimary: 'var(--color-primary, #63e6be)', colorText: 'var(--color-text, #f2f3f7)',
    colorMuted: 'var(--color-text-secondary, #9299a8)', colorBorder: 'var(--color-border, #2b303b)',
    colorSurface: 'var(--color-background-light, #15171d)', colorSurfaceSoft: 'var(--color-background-lighter, #1e2129)',
    colorDanger: 'var(--color-error, #ff6b74)', colorSuccess: 'var(--color-success, #63e6be)',
    colorWarning: 'var(--color-warning, #f4bf75)', fontFamily: 'var(--font-family, system-ui, sans-serif)',
    shadow: 'var(--shadow-lg, 0 12px 40px #0003)'
  }
}
/** Isolate Fue's real styles from advanced theme CSS so errors and recovery always remain reachable. */
onMounted(async () => {
  host = document.createElement('div')
  host.setAttribute('data-bk-theme-safety', '')
  host.setAttribute('data-bk-notifications', '')
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;visibility:visible!important;opacity:1!important;pointer-events:none!important;transform:none!important;overflow:clip!important;'
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  // Retain Fue Message/Alert transitions and countdown. Clip their horizontal travel and
  // keep long stacks scrollable without displaying a native scrollbar during removal.
  style.textContent = fueStyles + `
    .notification-config .fue-message-list{right:20px;bottom:110px;width:min(380px,calc(100vw - 32px));max-height:calc(100dvh - 150px);overflow-x:hidden;overflow-y:auto;scrollbar-width:none;padding:4px;box-sizing:border-box}
    .fue-message-list::-webkit-scrollbar{display:none}
    .fue-message-item{flex-shrink:0;-webkit-app-region:no-drag}
    .bk-notice-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
    .fue-alert .bk-notice-actions button{width:auto;height:auto;font-size:12px}
    .fue-alert-leave-active,.fue-message-leave-active{pointer-events:none}
    .fue-alert:focus-visible{outline:2px solid var(--fue-color-primary,#63e6be);outline-offset:-2px}
    @media(max-height:400px){.notification-config .fue-message-list{bottom:16px;max-height:calc(100dvh - 56px)}}`
  const container = document.createElement('div')
  container.setAttribute('aria-label', '消息通知')
  shadow.append(style, container)
  document.body.append(host)
  host.addEventListener('keydown', isolateNotificationKeys)
  host.addEventListener('keydown', protectLeavingNotice, true)
  host.addEventListener('click', protectLeavingNotice, true)
  document.addEventListener('keydown', focusNotifications, true)
  target.value = container
  await nextTick()
  if (!disposed) readyFrame = requestAnimationFrame(() => window.electronAPI?.notifyReady?.())
})
onBeforeUnmount(() => {
  disposed = true
  cancelAnimationFrame(readyFrame)
  document.removeEventListener('keydown', focusNotifications, true)
  host?.removeEventListener('keydown', isolateNotificationKeys)
  host?.removeEventListener('keydown', protectLeavingNotice, true)
  host?.removeEventListener('click', protectLeavingNotice, true)
  host?.remove()
})
</script>

<template>
  <Teleport v-if="target" :to="target">
  <FueConfigProvider class="notification-config" :locale="zhCN" :theme-overrides="themeOverrides">
    <FueMessageProvider :to="false" :max="20">
      <NotificationEvents />
      <AppNotice v-if="startupFailure" :message="startupFailure.message" :title="startupFailure.title || '启动失败'" type="error" :closable="false"
        :actions="[{ label: '退出程序', run: quitAfterStartupFailure }]" />
      <Teleport v-else to="#app"><slot /></Teleport>
    </FueMessageProvider>
  </FueConfigProvider>
  </Teleport>
</template>

<style scoped>
.notification-config { display: contents; color: inherit; font: inherit; }
</style>
