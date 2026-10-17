<template>
  <span v-if="badges.length" class="song-badges">
    <span v-for="badge in badges" :key="badge.key" class="song-badge" :class="'song-badge-' + badge.key" :title="badge.title" :aria-label="badge.title">{{ badge.label }}</span>
  </span>
</template>

<script>
import { getSongBadges } from '../../utils/songMetadata.js'

export default {
  name: 'SongBadges',
  props: { song: { type: Object, required: true } },
  computed: {
    badges() { return getSongBadges(this.song) }
  }
}
</script>

<style scoped>
.song-badges { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; vertical-align: middle; }
.song-badge { display: inline-block; padding: 1px 4px; border: 1px solid currentColor; border-radius: 3px; color: var(--color-primary); font-size: 9px; font-weight: 650; line-height: 1.35; letter-spacing: .3px; white-space: nowrap; }
.song-badge { animation: badge-appear .2s ease-out both; }
@keyframes badge-appear { from { opacity: 0; scale: .9; } to { opacity: 1; scale: 1; } }
@media (prefers-reduced-motion: reduce) { .song-badge { animation: none; } }
</style>
