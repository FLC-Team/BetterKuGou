<template>
  <Transition name="ui-fade" appear @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
    <div class="page-module-loading" :class="{ 'is-floating': floating }" role="status" aria-live="polite" aria-busy="true">
      <span class="loading-spinner" aria-hidden="true"></span>
      <p>{{ floating ? '正在打开外观编辑器…' : '正在打开页面…' }}</p>
    </div>
  </Transition>
</template>

<script>
export default { name: 'PageLoadingView', props: { floating: { type: Boolean, default: false } } }
</script>

<style scoped>
.page-module-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; min-height: 240px; padding: 36px; color: var(--color-text-secondary); font-size: var(--font-size-sm); }
.page-module-loading.is-floating { position: fixed; z-index: 10000; right: 24px; bottom: 110px; flex-direction: row; gap: 12px; min-height: 0; max-width: calc(100vw - 40px); padding: 16px 20px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-background-light); box-shadow: var(--shadow-lg); pointer-events: none; }
.page-module-loading.is-floating .loading-spinner { width: 23px; height: 23px; }
</style>
