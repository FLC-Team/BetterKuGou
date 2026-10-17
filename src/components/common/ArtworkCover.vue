<template>
  <img v-if="imageOnly" v-show="!failed" :src="displaySource || undefined" :data-artwork-generation="sourceGeneration" :data-artwork-source="displaySource" :data-artwork-original="source" :alt="label" :loading="loading" @load="handleLoad" @error="handleError" />
  <span v-else class="artwork-cover" :aria-label="label || undefined" :role="label ? 'img' : undefined" :aria-hidden="label ? undefined : true">
    <span class="artwork-fallback" aria-hidden="true"><span>{{ mark }}</span></span>
    <img v-if="displaySource && !failed" :key="displaySource" :src="displaySource" :data-artwork-generation="sourceGeneration" :data-artwork-source="displaySource" alt="" :loading="loading" @load="handleLoad" @error="handleError" />
  </span>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { callPlaylistCache, getPlaylistCacheAPI } from '../../utils/playlistCache.js'
import { logger } from '../../utils/logger.js'

const props = defineProps({
  src: { type: String, default: '' },
  loading: { type: String, default: 'lazy' },
  label: { type: String, default: '' },
  mark: { type: String, default: '♪' },
  imageOnly: { type: Boolean, default: false }
})
const emit = defineEmits(['error'])
const source = computed(() => typeof props.src === 'string' ? props.src.replace('{size}', '400') : '')
const failed = ref(false)
const displaySource = ref('')
const sourceGeneration = ref(0)
let artworkLeaseId = null
let disposed = false

function releaseArtworkLease(leaseId) {
  if (!leaseId) return
  Promise.resolve(getPlaylistCacheAPI()?.releaseSource?.(leaseId)).catch(error => {
    logger.trace('ArtworkCover', '释放封面缓存失败', { name: error?.name })
  })
}

/** 查找只读本地封面；下载由真实图片 load 触发，保留列表懒加载。 */
watch(source, async url => {
  const generation = ++sourceGeneration.value
  releaseArtworkLease(artworkLeaseId)
  artworkLeaseId = null
  failed.value = false
  displaySource.value = ''
  if (!url) return
  let cached = null
  try { cached = await callPlaylistCache('getArtwork', url) } catch (error) {
    logger.trace('ArtworkCover', '读取封面缓存失败', { name: error?.name })
  }
  if (disposed || generation !== sourceGeneration.value) {
    releaseArtworkLease(cached?.leaseId)
    return
  }
  artworkLeaseId = cached?.leaseId || null
  displaySource.value = cached?.url || url
}, { immediate: true })

function isCurrentImage(event) {
  return !disposed && Number(event?.target?.dataset?.artworkGeneration) === sourceGeneration.value &&
    event?.target?.dataset?.artworkSource === displaySource.value &&
    (!event.target.currentSrc || event.target.currentSrc === displaySource.value)
}

function handleLoad(event) {
  if (!isCurrentImage(event) || !source.value || displaySource.value !== source.value) return
  // 不替换已经显示的网络图片，避免下载完成后重复解码和触发 load。
  callPlaylistCache('cacheArtwork', source.value).then(cached => {
    releaseArtworkLease(cached?.leaseId)
  }).catch(error => logger.trace('ArtworkCover', '保存封面缓存失败', { name: error?.name }))
}

function handleError(event) {
  if (!isCurrentImage(event)) return
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
.artwork-fallback { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-primary); }
.artwork-fallback::before, .artwork-fallback::after { content: ''; position: absolute; width: 68%; height: 68%; border: 1px solid currentColor; border-radius: 50%; opacity: .2; }
.artwork-fallback::after { width: 46%; height: 46%; opacity: .15; }
.artwork-fallback > span { font-size: 1.5em; font-weight: 500; }
</style>
