<template>
  <span class="artwork-cover" :aria-label="label || undefined" :role="label ? 'img' : undefined" :aria-hidden="label ? undefined : true">
    <span class="artwork-fallback" aria-hidden="true"><span>{{ mark }}</span></span>
    <img v-if="source && !failed" :key="source" :src="source" alt="" loading="lazy" @error="failed = true" />
  </span>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  src: { type: String, default: '' },
  label: { type: String, default: '' },
  mark: { type: String, default: '♪' }
})
const source = computed(() => typeof props.src === 'string' ? props.src.replace('{size}', '400') : '')
const failed = ref(false)
watch(source, () => { failed.value = false })
</script>

<style scoped>
.artwork-cover { display: block; position: relative; isolation: isolate; overflow: hidden; background: color-mix(in srgb, var(--color-primary) 9%, var(--color-background-light)); }
.artwork-cover > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.artwork-fallback { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-primary); }
.artwork-fallback::before, .artwork-fallback::after { content: ''; position: absolute; width: 68%; height: 68%; border: 1px solid currentColor; border-radius: 50%; opacity: .2; }
.artwork-fallback::after { width: 46%; height: 46%; opacity: .15; }
.artwork-fallback > span { font-size: 1.5em; font-weight: 500; }
</style>
