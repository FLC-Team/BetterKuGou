<template>
  <button type="button" @click.stop="handleClick" @dblclick.stop="handleDoubleClick"><slot /></button>
</template>

<script>
export default {
  name: 'SongTitle',
  props: { song: { type: Object, required: true } },
  emits: ['search', 'play'],
  data() { return { searchTimer: null, clickGeneration: 0, interactionActive: true } },
  watch: {
    song: { flush: 'sync', handler() { this.cancelSearch() } }
  },
  activated() { this.interactionActive = true },
  deactivated() { this.interactionActive = false; this.cancelSearch() },
  beforeUnmount() { this.interactionActive = false; this.cancelSearch() },
  methods: {
    /** Keep a pointer single click pending so the native double click can claim playback. */
    handleClick(event) {
      this.cancelSearch()
      if (!this.interactionActive) return
      if (event.detail === 0) {
        this.$emit('search', this.song)
        return
      }
      if (event.detail > 1) return
      const generation = this.clickGeneration
      const song = this.song
      this.searchTimer = setTimeout(() => {
        if (!this.interactionActive || generation !== this.clickGeneration || this.song !== song) return
        this.searchTimer = null
        this.$emit('search', song)
      }, 500)
    },
    handleDoubleClick() {
      this.cancelSearch()
      if (this.interactionActive) this.$emit('play', this.song)
    },
    cancelSearch() {
      this.clickGeneration++
      clearTimeout(this.searchTimer)
      this.searchTimer = null
    }
  }
}
</script>
