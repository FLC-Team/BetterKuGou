<template>
  <span class="library-actions" @click.stop @dblclick.stop>
    <button v-if="!moreOnly" type="button" class="icon-btn library-heart" :class="{ active: library?.isFavorite(song) }"
      :disabled="library?.isFavoritePending(song)" :aria-busy="library?.isFavoritePending(song)" :aria-pressed="library?.isFavorite(song) || false"
      :aria-label="library?.isFavorite(song) ? '取消收藏' : '收藏歌曲'" :title="library?.isFavorite(song) ? '取消收藏' : '收藏歌曲'"
      @click="actions?.['toggle-favorite']?.(song)">{{ library?.isFavoritePending(song) ? '…' : library?.isFavorite(song) ? '♥' : '♡' }}</button>
    <button type="button" class="icon-btn" aria-label="歌曲更多操作" title="歌曲更多操作" :aria-expanded="open" @click="show">···</button>
    <ContextMenu :visible="open" :position="position" :items="items" @close="close" />
  </span>
</template>
<script setup>
import { computed, inject, onBeforeUnmount, onDeactivated, ref } from 'vue'
import ContextMenu from './ContextMenu.vue'
import contextMenuManager from '../../utils/contextMenuManager.js'
const props = defineProps({ song: { type: Object, default: null }, moreOnly: Boolean })
const library = inject('musicLibrary', null), actions = inject('songActions', null)
const open = ref(false), position = ref({ x: 0, y: 0 })
const items = computed(() => [
  { label: library?.isFavorite(props.song) ? '取消收藏' : '收藏歌曲', disabled: library?.isFavoritePending(props.song), action: () => act('toggle-favorite') },
  { label: '添加到歌单', action: () => act('add-to-playlist') },
  { label: '下载歌曲', action: () => act('download') },
  { label: '评论与其他版本', action: () => act('show-details') },
  { label: '分享歌曲', action: () => act('share') }
])
function act(name) { actions?.[name]?.(props.song); close() }
function close() { open.value = false; contextMenuManager.unregisterMenu(close) }
function show(event) {
  if (!props.song) return
  if (open.value) { close(); return }
  contextMenuManager.closeActiveMenu()
  const rect = event.currentTarget.getBoundingClientRect()
  position.value = { x: rect.left, y: rect.bottom + 4 }
  open.value = true
  contextMenuManager.registerMenu(close)
}
onDeactivated(close)
onBeforeUnmount(close)
</script>
<style scoped>
.library-actions { display:inline-flex; align-items:center; gap:3px; flex-shrink:0; }
.icon-btn { display:inline-grid; place-items:center; border:0; background:transparent; color:var(--color-text-secondary); cursor:pointer; width:30px; height:30px; padding:0; border-radius:8px; font-size:18px; }
.icon-btn:hover { color:var(--color-text); background:var(--bg-hover, #8882); }.library-heart.active { color:var(--color-primary); } button:disabled { opacity:.5; cursor:wait; }
.icon-btn { transition:color .15s,background .15s,scale .15s; }.icon-btn:active { scale:.92; }.icon-btn:focus-visible { outline:2px solid var(--color-primary); outline-offset:2px; }
@media(prefers-reduced-motion:reduce) { .icon-btn { transition:none; } }
</style>
