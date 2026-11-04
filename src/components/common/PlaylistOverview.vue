<template>
  <section v-if="globalId" class="playlist-overview" aria-label="歌单介绍与相关推荐" :aria-busy="loading">
    <p v-if="detail?.intro" class="introduction">{{ detail.intro }}</p>
    <div class="overview-actions"><button type="button" @click="actions?.['show-details']?.({ name: detail?.name || resource?.name }, { type: 'playlist', id: globalId })">歌单评论</button>
      <button v-if="error" type="button" :disabled="loading" @click="load">重新加载歌单介绍</button></div>
    <p v-if="error" role="status">{{ error }}</p>
    <details v-if="similar.length"><summary>相似歌单 · {{ similar.length }}</summary>
      <div class="related-playlists"><button v-for="item in similar" :key="item.globalCollectionId" type="button" @click="$emit('navigate', 'playlist', item)">
        <ArtworkCover :src="item.cover" class="related-cover" /><span>{{ item.name }}</span></button></div>
    </details>
  </section>
</template>
<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import ArtworkCover from './ArtworkCover.vue'
import { getPlaylistDetail, getSimilarPlaylists } from '../../api/library.js'
import { extractLibraryList, normalizePlaylistResource } from '../../utils/libraryMetadata.js'
const props = defineProps({ resource: { type: Object, default: null } })
defineEmits(['navigate'])
const actions = inject('songActions', null)
const globalId = computed(() => props.resource?.globalCollectionId || props.resource?.global_collection_id || (props.resource?.source !== 'owned' ? props.resource?.id : null))
const detail = ref(null), similar = ref([]), error = ref(''), loading = ref(false)
let controller
/** 介绍和相似歌单独立于曲目加载；辅助接口失败不阻断整张歌单播放。 */
async function load() {
  controller?.abort()
  const current = controller = new AbortController()
  detail.value = null; similar.value = []; error.value = ''
  if (!globalId.value) { loading.value = false; return }
  loading.value = true
  const results = await Promise.allSettled([
    getPlaylistDetail(globalId.value, { signal: current.signal }),
    getSimilarPlaylists(globalId.value, { signal: current.signal })
  ])
  if (current.signal.aborted) return
  if (results[0].status === 'fulfilled') detail.value = extractLibraryList(results[0].value)[0] || null
  if (results[1].status === 'fulfilled') {
    const groups = extractLibraryList(results[1].value)
    const entries = groups.flatMap(group => Array.isArray(group.collection_list) ? group.collection_list : [])
    similar.value = entries.map(item => normalizePlaylistResource({ ...item, name: item.collection_name,
      listid: item.cloudlist_id, userid: item.user_id, count: item.song_count }, { source: 'public' })).filter(item => item.globalCollectionId)
  }
  if (results.some(result => result.status === 'rejected')) error.value = '部分歌单介绍暂时无法加载，曲目仍可正常使用。'
  loading.value = false
}
watch(globalId, load, { immediate: true })
onBeforeUnmount(() => controller?.abort())
</script>
<style scoped>
.playlist-overview { margin:20px 0 28px; color:var(--color-text-secondary); font-size:13px; }
.introduction { white-space:pre-line; line-height:1.8; max-width:72ch; }
.overview-actions { display:flex; flex-wrap:wrap; gap:12px; margin:12px 0; }
button { background:var(--color-background-lighter); color:var(--color-text); border:1px solid var(--color-border); border-radius:10px; padding:8px 12px; cursor:pointer; transition:background .15s,transform .15s; }
button:hover { background:var(--bg-hover); } button:active { transform:scale(.98); } button:focus-visible,summary:focus-visible { outline:2px solid var(--color-primary); outline-offset:3px; }
summary { cursor:pointer; padding:12px 0; }
.related-playlists { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; padding:12px 0; }
.related-playlists button { display:flex; align-items:center; gap:10px; text-align:left; }
.related-cover { width:44px; height:44px; flex:none; border-radius:8px; }.related-playlists span { overflow-wrap:anywhere; }
@media(prefers-reduced-motion:reduce) { button { transition:none; } }
</style>
