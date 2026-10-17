<template>
  <span class="artist-links" :class="{ 'artist-links-compact': compact }" @wheel="scrollArtists">
    <template v-for="(artist, index) in artists" :key="artist.id == null ? 'name:' + artist.name : 'id:' + artist.id">
      <span v-if="index" class="artist-separator" aria-hidden="true">、</span>
      <button
        type="button"
        class="artist-name"
        :aria-label="'查看歌手 ' + artist.name"
        :title="'查看歌手 ' + artist.name"
        @click.stop="$emit('select', artist)"
        @dblclick.stop
        @focus="revealArtist"
      >{{ artist.name }}</button>
    </template>
    <span v-if="!artists.length" class="artist-unknown">未知歌手</span>
  </span>
</template>

<script>
import { getSongArtists } from '../../utils/songMetadata.js'

export default {
  name: 'ArtistLinks',
  props: {
    song: { type: Object, default: null },
    compact: { type: Boolean, default: false }
  },
  emits: ['select'],
  computed: {
    artists() { return getSongArtists(this.song) }
  },
  methods: {
    /** Let ordinary mouse wheels reach overflowed artists while preserving page scrolling at either edge. */
    scrollArtists(event) {
      if (!this.compact || event.ctrlKey) return
      const container = event.currentTarget
      const limit = container.scrollWidth - container.clientWidth
      const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? container.clientWidth : 1
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * scale
      if (limit <= 0 || !Number.isFinite(delta)) return
      const position = Math.max(0, Math.min(limit, container.scrollLeft + delta))
      if (position === container.scrollLeft) return
      container.scrollLeft = position
      event.preventDefault()
      event.stopPropagation()
    },
    /** Reveal focused collaborators in compact rows without scrolling the page. */
    revealArtist(event) {
      if (!this.compact) return
      const container = this.$el
      const bounds = container.getBoundingClientRect()
      const artist = event.currentTarget.getBoundingClientRect()
      let position = container.scrollLeft
      if (artist.left < bounds.left) position -= bounds.left - artist.left
      else if (artist.right > bounds.right) position += artist.right - bounds.right
      if (position === container.scrollLeft) return
      if (typeof container.scrollTo === 'function') {
        const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        container.scrollTo({ left: position, behavior: reduced ? 'auto' : 'smooth' })
      } else container.scrollLeft = position
    }
  }
}
</script>

<style scoped>
.artist-links { display: inline-flex; flex-wrap: wrap; align-items: baseline; min-width: 0; max-width: 100%; color: inherit; font: inherit; line-height: inherit; vertical-align: baseline; }
.artist-name { appearance: none; flex: 0 1 auto; max-width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; line-height: inherit; text-align: left; white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
.artist-name { transition: color .16s ease, opacity .16s ease, scale .16s ease; text-decoration-color: transparent; }
.artist-name:active { scale: .96; }
.artist-name:hover { color: var(--color-primary); text-decoration: underline; text-underline-offset: 2px; }
.artist-name:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; border-radius: 2px; }
.artist-separator { flex: 0 0 auto; }
.artist-links-compact { flex-wrap: nowrap; height: 18px; overflow-x: auto; overflow-y: hidden; line-height: 18px; white-space: nowrap; scrollbar-width: none; }
.artist-links-compact .artist-name { flex: 0 0 auto; max-width: none; white-space: nowrap; }
.artist-links-compact::-webkit-scrollbar { display: none; }
@media (prefers-reduced-motion: reduce) { .artist-links-compact { scroll-behavior: auto; } .artist-name { transition: none; } }
</style>
