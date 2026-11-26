<template>
  <img v-if="imageOnly" ref="coverElement" v-show="!failed" :data-artwork-loaded="loaded" :src="displaySource || undefined" :data-artwork-generation="sourceGeneration" :data-artwork-source="displaySource" :data-artwork-original="source" :alt="label" :loading="imageLoading" @load="handleLoad" @error="handleError" />
  <span v-else ref="coverElement" class="artwork-cover" :class="{ 'is-loaded': loaded, 'is-failed': failed }" :aria-label="label || undefined" :role="label ? 'img' : undefined" :aria-hidden="label ? undefined : true">
    <span class="artwork-fallback" aria-hidden="true"><span>{{ mark }}</span></span>
    <img v-if="displaySource && !failed" :key="sourceGeneration + ':' + displaySource" class="artwork-image" :class="{ 'is-loaded': loaded }" :src="displaySource" :data-artwork-generation="sourceGeneration" :data-artwork-source="displaySource" alt="" :loading="imageLoading" @load="handleLoad" @error="handleError" />
  </span>
</template>

<script>
const viewports = new WeakMap()
const pendingLookups = new Set()
const maxViewportLookups = 4
let activeLookups = 0

/** Share an observer per document so scroll containers clip visibility naturally. */
function observeCover(element, update) {
  const doc = element.ownerDocument
  const Observer = doc?.defaultView?.IntersectionObserver
  if (!Observer) {
    update(true)
    return
  }
  let viewport = viewports.get(doc)
  if (!viewport) {
    const callbacks = new Map()
    const observer = new Observer(entries => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
    })
    viewport = { callbacks, observer }
    viewports.set(doc, viewport)
  }
  viewport.callbacks.set(element, update)
  viewport.observer.observe(element)
  return () => {
    viewport.callbacks.delete(element)
    viewport.observer.unobserve(element)
    if (!viewport.callbacks.size) {
      viewport.observer.disconnect()
      viewports.delete(doc)
    }
  }
}

/** Bound how many lookups can reach the serialized cache service before a scroll jump. */
function drainViewportLookups() {
  while (activeLookups < maxViewportLookups && pendingLookups.size) {
    const lookup = pendingLookups.values().next().value
    pendingLookups.delete(lookup)
    activeLookups++
    void lookup().finally(() => {
      activeLookups--
      drainViewportLookups()
    })
  }
}
</script>

<script setup>
import { computed, ref, shallowRef, watch, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import { callPlaylistCache, getPlaylistCacheAPI, getPlaylistCacheSessionVersion } from '../../utils/playlistCache.js'
import { logger } from '../../utils/logger.js'

const props = defineProps({
  src: { type: String, default: '' },
  loading: { type: String, default: 'lazy' },
  label: { type: String, default: '' },
  mark: { type: String, default: '♪' },
  viewport: { type: Boolean, default: false },
  imageOnly: { type: Boolean, default: false }
})
const emit = defineEmits(['error'])
// Keep lookup and persistence on the same concrete URL, including protocol-relative artist avatars.
const source = computed(() => typeof props.src === 'string'
  ? props.src.trim().replace(/\{size\}/g, '400').replace(/^\/\//, 'https://') : '')
const failed = ref(false)
const loaded = ref(false)
const displaySource = ref('')
const sourceGeneration = ref(0)
const coverElement = shallowRef(null)
const active = ref(true)
const visible = ref(false)
const useViewport = computed(() => props.viewport && props.loading !== 'eager')
const canLoad = computed(() => !useViewport.value || (active.value && visible.value))
const imageLoading = computed(() => useViewport.value ? 'eager' : props.loading)
let artworkLeaseId = null
let disposed = false

function releaseArtworkLease(leaseId) {
  if (!leaseId) return
  Promise.resolve(getPlaylistCacheAPI()?.releaseSource?.(leaseId)).catch(error => {
    logger.trace('ArtworkCover', '释放封面缓存失败', { name: error?.name })
  })
}

watch([coverElement, useViewport, active], ([element, managed, isActive], _previous, onCleanup) => {
  visible.value = false
  if (element && managed && isActive) {
    const stop = observeCover(element, intersects => { visible.value = intersects })
    if (stop) onCleanup(stop)
  }
}, { flush: 'post' })

onActivated(() => { active.value = true })
onDeactivated(() => {
  active.value = false
  visible.value = false
})

/** A viewport exit drops unfinished work while retaining images that already loaded. */
watch([source, canLoad], ([url, allowed], [previousUrl], onCleanup) => {
  if (url !== previousUrl || (!allowed && displaySource.value && !loaded.value && !failed.value)) {
    sourceGeneration.value++
    releaseArtworkLease(artworkLeaseId)
    artworkLeaseId = null
    failed.value = false
    loaded.value = false
    displaySource.value = ''
  }
  if (!url || !allowed || displaySource.value) return
  let cancelled = false
  const session = getPlaylistCacheSessionVersion()
  const isCurrent = () => !cancelled && !disposed && canLoad.value && source.value === url
  const lookup = async () => {
    if (!isCurrent()) return
    let cached = null
    try {
      if (session === getPlaylistCacheSessionVersion()) cached = await callPlaylistCache('getArtwork', url)
    } catch (error) {
      logger.trace('ArtworkCover', '读取封面缓存失败', { name: error?.name })
    }
    if (!isCurrent()) {
      releaseArtworkLease(cached?.leaseId)
      return
    }
    artworkLeaseId = cached?.leaseId || null
    displaySource.value = cached?.url || url
  }
  onCleanup(() => {
    cancelled = true
    pendingLookups.delete(lookup)
  })
  if (useViewport.value) {
    pendingLookups.add(lookup)
    drainViewportLookups()
  } else void lookup()
}, { immediate: true })

function isCurrentImage(event) {
  if (disposed || Number(event?.target?.dataset?.artworkGeneration) !== sourceGeneration.value ||
    event?.target?.dataset?.artworkSource !== displaySource.value) return false
  if (!event.target.currentSrc) return true
  try {
    return event.target.currentSrc === new URL(displaySource.value, event.target.ownerDocument?.baseURI).href
  } catch { return event.target.currentSrc === displaySource.value }
}

function handleLoad(event) {
  if (!isCurrentImage(event)) return
  loaded.value = true
  if (!source.value || displaySource.value !== source.value) return
  // 不替换已经显示的网络图片，避免下载完成后重复解码和触发 load。
  callPlaylistCache('cacheArtwork', source.value).then(cached => {
    releaseArtworkLease(cached?.leaseId)
  }).catch(error => logger.trace('ArtworkCover', '保存封面缓存失败', { name: error?.name }))
}

function handleError(event) {
  if (!isCurrentImage(event)) return
  loaded.value = false
  if (displaySource.value !== source.value) {
    releaseArtworkLease(artworkLeaseId)
    artworkLeaseId = null
    displaySource.value = source.value
  } else {
    failed.value = true
    emit('error', event)
  }
}

onBeforeUnmount(() => {
  disposed = true
  sourceGeneration.value++
  releaseArtworkLease(artworkLeaseId)
  artworkLeaseId = null
})
</script>

<style scoped>
.artwork-cover { display: block; position: relative; isolation: isolate; overflow: hidden; background: color-mix(in srgb, var(--color-primary) 9%, var(--color-background-light)); }
.artwork-cover > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.artwork-image { opacity: 0; transition: opacity .24s ease; }
.artwork-image.is-loaded { opacity: 1; }
img[data-artwork-loaded="false"] { opacity: 0; }
img[data-artwork-loaded="true"] { animation: artwork-reveal .24s ease-out; }
@keyframes artwork-reveal { from { opacity: 0; } }
.artwork-fallback { transition: opacity .24s ease, scale .24s ease; }
.is-loaded > .artwork-fallback { opacity: 0; scale: .94; }
.is-failed > .artwork-fallback { animation: artwork-fallback-in .22s ease-out; }
@keyframes artwork-fallback-in { from { opacity: .3; scale: .94; } to { opacity: 1; scale: 1; } }
@media (prefers-reduced-motion: reduce) { .artwork-image, .artwork-fallback, img[data-artwork-loaded] { transition: none; animation: none !important; } }
.artwork-fallback { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-primary); }
.artwork-fallback::before, .artwork-fallback::after { content: ''; position: absolute; width: 68%; height: 68%; border: 1px solid currentColor; border-radius: 50%; opacity: .2; }
.artwork-fallback::after { width: 46%; height: 46%; opacity: .15; }
.artwork-fallback > span { font-size: 1.5em; font-weight: 500; }
</style>
