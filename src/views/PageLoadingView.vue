<template>
  <AppNotice v-if="floating" message="正在打开界面…" type="info" :duration="0" :closable="false" />
  <Transition v-else name="ui-fade" appear @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
    <div class="page-module-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="loading-spinner" aria-hidden="true"></span>
      <p>正在打开页面…</p>
    </div>
  </Transition>
</template>

<script>
export default { name: 'PageLoadingView', props: { floating: { type: Boolean, default: false } } }
</script>

<style scoped>
.page-module-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; min-height: 240px; padding: 36px; color: var(--color-text-secondary); font-size: var(--font-size-sm); }
</style>
