<template>
  <div class="windowed-list" style="overflow-anchor: none" @keydown="handleKeydown" @focusin="handleFocusIn" @focusout="handleFocusOut">
    <slot name="header" />
    <template v-for="entry in renderEntries" :key="entry.key">
      <div v-if="entry.spacer" data-window-spacer class="windowed-list-spacer" aria-hidden="true" :style="{ height: `${entry.height}px` }" />
      <slot v-else name="row" :item="items[entry.index]" :index="entry.index">
        <slot :item="items[entry.index]" :index="entry.index" />
      </slot>
    </template>
  </div>
</template>

<script>
const runtimes = new WeakMap()
const initialHeight = 74
const overscan = 6
const focusSelector = 'button, a[href], input, select, textarea, [tabindex]'

/** Prefix heights describe the complete list while only a small window owns DOM nodes. */
export function buildOffsets(keys, heights, estimate = initialHeight) {
  const offsets = [0]
  for (const key of keys) offsets.push(offsets[offsets.length - 1] + (heights.get(key) || estimate))
  return offsets
}

export function rowAtOffset(offsets, offset) {
  let low = 0, high = Math.max(0, offsets.length - 2)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (offsets[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

/** Separate spacers let a focused, offscreen row remain mounted without retaining the intervening rows. */
export function getRenderEntries(keys, offsets, start, end, pinned = []) {
  const indices = new Set(pinned.filter(index => index >= 0 && index < keys.length))
  for (let index = Math.max(0, start); index < Math.min(keys.length, end); index++) indices.add(index)
  const entries = []
  let cursor = 0
  const gap = finish => {
    if (finish > cursor) entries.push({ key: `gap:${cursor}`, spacer: true, height: offsets[finish] - offsets[cursor] })
  }
  for (const index of [...indices].sort((a, b) => a - b)) {
    gap(index)
    entries.push({ key: `row:${keys[index]}`, index })
    cursor = index + 1
  }
  gap(keys.length)
  return entries
}

export default {
  name: 'WindowedList',
  props: {
    items: { type: Array, default: () => [] },
    itemKey: { type: String, default: 'index' },
    threshold: { type: Number, default: 200 }
  },
  data() {
    return { heights: new Map(), estimate: initialHeight, windowStart: 0, windowEnd: 24, focusedKey: null, keyboardKey: null }
  },
  computed: {
    windowed() { return this.items.length > this.threshold },
    keys() {
      const occurrences = new Map()
      return this.items.map((item, index) => {
        const value = item?.[this.itemKey] ?? index
        const key = `${typeof value}:${String(value)}`
        const occurrence = occurrences.get(key) || 0
        occurrences.set(key, occurrence + 1)
        return `${key}:${occurrence}`
      })
    },
    offsets() { return buildOffsets(this.keys, this.heights, this.estimate) },
    renderEntries() {
      return getRenderEntries(this.keys, this.offsets, this.windowed ? this.windowStart : 0,
        this.windowed ? this.windowEnd : this.items.length,
        [this.keys.indexOf(this.focusedKey), this.keys.indexOf(this.keyboardKey)])
    }
  },
  watch: {
    items() {
      const state = runtimes.get(this)
      if (!state) return
      // Filtering and sorting retain their normal scroll position, rather than following a moved song.
      state.anchor = null
      const remaining = new Set(this.keys)
      this.heights = new Map([...this.heights].filter(([key]) => remaining.has(key)))
      if (!remaining.has(this.focusedKey)) this.focusedKey = null
      if (!remaining.has(this.keyboardKey)) this.keyboardKey = null
      this.scheduleMeasure()
    },
    itemKey() { this.scheduleMeasure(true) },
    threshold() { this.scheduleMeasure() }
  },
  created() {
    runtimes.set(this, { active: false, disposed: false, frame: null, observed: new Set(), boxHeights: new WeakMap(), anchor: null,
      invalidate: false, seeded: false, width: null, signature: '', generation: 0, tabDirection: 0 })
  },
  mounted() { this.resumeWindow() },
  activated() { this.resumeWindow() },
  deactivated() { this.pauseWindow() },
  updated() {
    this.observeRows()
    this.scheduleMeasure()
  },
  beforeUnmount() {
    this.pauseWindow()
    const state = runtimes.get(this)
    if (state) state.disposed = true
    runtimes.delete(this)
  },
  methods: {
    /** Slot rows must be direct elements marked with their current data-window-index. */
    rows() {
      return [...(this.$el?.querySelectorAll?.(':scope > [data-window-index]') || [])]
        .filter(row => !row.hasAttribute('inert') && row.getAttribute('aria-hidden') !== 'true')
    },
    rowFor(index) { return this.rows().find(row => Number(row.dataset.windowIndex) === index) },
    rowFrom(target) {
      const row = target?.closest?.('[data-window-index]')
      return row?.parentElement === this.$el && !row.hasAttribute('inert') ? row : null
    },
    focusables(row) {
      return [...(row?.querySelectorAll(focusSelector) || [])].filter(element => element.tabIndex >= 0 &&
        !element.matches(':disabled') && !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length)
    },
    themeSignature() {
      const doc = this.$el.ownerDocument
      return `${doc.documentElement.getAttribute('style')}|${doc.documentElement.className}|${doc.documentElement.getAttribute('data-theme')}|` +
        `${doc.body?.className}|${doc.body?.getAttribute('style')}|` +
        [...doc.head.querySelectorAll('style')].map(element => element.textContent).join('\n')
    },
    /** Resume after App's before-enter nextTick has restored the containing page's scrollTop. */
    resumeWindow() {
      const state = runtimes.get(this)
      if (!state || state.disposed || state.active) return
      state.active = true
      const generation = ++state.generation
      this.$nextTick(() => {
        if (!state.active || state.disposed || generation !== state.generation || !this.$el.isConnected) return
        const doc = this.$el.ownerDocument
        state.view = doc.defaultView
        state.scroller = this.$el.closest('.list-page')
        if (!state.scroller) return
        const signature = this.themeSignature()
        state.invalidate ||= state.signature !== signature || state.width !== state.scroller.clientWidth
        state.signature = signature
        state.onScroll = () => this.scheduleMeasure()
        state.onResize = () => this.scheduleMeasure(true)
        state.onTab = event => { state.tabDirection = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0 }
        state.onPointer = () => { state.tabDirection = 0 }
        state.scroller.addEventListener('scroll', state.onScroll, { passive: true })
        state.view.addEventListener('resize', state.onResize)
        doc.addEventListener('keydown', state.onTab, true)
        doc.addEventListener('pointerdown', state.onPointer, true)
        doc.fonts?.addEventListener?.('loadingdone', state.onResize)
        if (state.view.ResizeObserver) {
          state.resize = new state.view.ResizeObserver(entries => {
            if (!state.active || state.disposed || generation !== state.generation) return
            for (const entry of entries) {
              const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.borderBoxSize?.blockSize
              if (height > 0 && entry.target.hasAttribute?.('data-window-index')) state.boxHeights.set(entry.target, height)
            }
            this.scheduleMeasure()
          })
          state.resize.observe(state.scroller)
        }
        if (state.view.MutationObserver) {
          state.theme = new state.view.MutationObserver(() => this.scheduleMeasure(true))
          state.theme.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
          state.theme.observe(doc.body, { attributes: true, attributeFilter: ['style', 'class'] })
          state.theme.observe(doc.head, { childList: true, subtree: true, characterData: true })
        }
        this.observeRows()
        this.scheduleMeasure()
      })
    },
    pauseWindow() {
      const state = runtimes.get(this)
      if (!state) return
      state.active = false
      state.generation++
      if (state.frame != null) state.view?.cancelAnimationFrame(state.frame)
      state.frame = null
      state.resize?.disconnect()
      state.theme?.disconnect()
      state.observed.clear()
      state.scroller?.removeEventListener('scroll', state.onScroll)
      state.view?.removeEventListener('resize', state.onResize)
      const doc = this.$el?.ownerDocument
      doc?.removeEventListener('keydown', state.onTab, true)
      doc?.removeEventListener('pointerdown', state.onPointer, true)
      doc?.fonts?.removeEventListener?.('loadingdone', state.onResize)
      state.tabDirection = 0
      this.keyboardKey = null
    },
    observeRows() {
      const state = runtimes.get(this)
      if (!state?.active || !state.resize || !this.$el.isConnected) return
      const rows = new Set(this.rows())
      for (const row of state.observed) if (!rows.has(row)) state.resize.unobserve(row)
      for (const row of rows) if (!state.observed.has(row)) state.resize.observe(row)
      state.observed = rows
    },
    scheduleMeasure(invalidate = false) {
      const state = runtimes.get(this)
      if (!state?.active || state.disposed) return
      state.invalidate ||= invalidate
      if (state.frame != null || !state.view) return
      state.frame = state.view.requestAnimationFrame(() => {
        state.frame = null
        this.measureWindow()
      })
    },
    /** Measure only mounted rows, then compensate height changes above the current logical scroll anchor. */
    measureWindow() {
      const state = runtimes.get(this)
      if (!state?.active || state.disposed || !this.$el.isConnected || !state.scroller?.isConnected) return
      const scroller = state.scroller
      const previousOffsets = this.offsets
      const first = [...this.$el.children].find(element => element.hasAttribute('data-window-index') || element.hasAttribute('data-window-spacer'))
      if (!first) return
      const scrollTop = scroller.scrollTop
      // Row FLIP/hover transforms must not enter the logical scroll geometry.
      const contentTop = this.$el.getBoundingClientRect().top + first.offsetTop -
        scroller.getBoundingClientRect().top + scrollTop - scroller.clientTop
      const localTop = scrollTop - contentTop
      const widthChanged = state.width != null && state.width !== scroller.clientWidth
      const invalidate = state.invalidate || widthChanged
      state.invalidate = false
      const previousAnchor = invalidate && state.anchor ? state.anchor : localTop >= 0 && this.items.length ? {
        key: this.keys[rowAtOffset(previousOffsets, localTop)],
        within: localTop - previousOffsets[rowAtOffset(previousOffsets, localTop)]
      } : null
      const heights = invalidate ? new Map() : new Map(this.heights)
      // A resumed/retimed page can be laid out before its new ResizeObserver delivery.
      // Discard the previous theme's border boxes and request fresh fractional measurements.
      if (invalidate) {
        state.boxHeights = new WeakMap()
        for (const row of state.observed) {
          state.resize?.unobserve(row)
          state.resize?.observe(row)
        }
      }
      let changed = invalidate
      const measured = []
      for (const row of this.rows()) {
        const index = Number(row.dataset.windowIndex)
        const height = state.boxHeights.get(row) || row.offsetHeight
        if (!this.keys[index] || !(height > 0)) continue
        measured.push(height)
        if (Math.abs((heights.get(this.keys[index]) || 0) - height) > .25) {
          heights.set(this.keys[index], height)
          changed = true
        }
      }
      if (measured.length && (!state.seeded || invalidate)) {
        measured.sort((a, b) => a - b)
        this.estimate = measured[Math.floor(measured.length / 2)]
        state.seeded = true
      }
      if (changed) this.heights = heights
      state.width = scroller.clientWidth
      if (invalidate) state.signature = this.themeSignature()
      const offsets = this.offsets
      const anchorIndex = previousAnchor ? this.keys.indexOf(previousAnchor.key) : -1
      const intendedScroll = changed && anchorIndex >= 0
        ? Math.max(0, contentTop + offsets[anchorIndex] + previousAnchor.within) : scrollTop
      const viewportTop = intendedScroll - contentTop
      if (this.windowed) {
        this.windowStart = Math.max(0, rowAtOffset(offsets, Math.max(0, viewportTop)) - overscan)
        this.windowEnd = Math.min(this.items.length, rowAtOffset(offsets, Math.max(0, viewportTop + scroller.clientHeight)) + overscan + 1)
      }
      const anchor = rowAtOffset(offsets, Math.max(0, viewportTop))
      state.anchor = viewportTop >= 0 && this.items.length ? { key: this.keys[anchor], within: viewportTop - offsets[anchor] } : null
      if (Math.abs(intendedScroll - scrollTop) > .5) {
        const generation = state.generation
        this.$nextTick(() => {
          if (state.active && generation === state.generation && scroller.isConnected && Math.abs(scroller.scrollTop - scrollTop) < 1) {
            scroller.scrollTop = intendedScroll
          }
        })
      }
    },
    /** Native Tab continues inside each row; only an unmounted adjacent row requires an explicit handoff. */
    handleKeydown(event) {
      if (!this.windowed || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return
      const row = this.rowFrom(event.target)
      const direction = event.shiftKey ? -1 : 1
      if (!row) {
        if (!event.shiftKey && !this.rowFor(0)) {
          const controls = this.focusables(this.$el).filter(control => !this.rowFrom(control))
          if (controls[controls.length - 1] === event.target) {
            event.preventDefault()
            this.focusRow(0, direction)
          }
        }
        return
      }
      const controls = this.focusables(row)
      if (event.target !== controls[direction < 0 ? 0 : controls.length - 1]) return
      const index = Number(row.dataset.windowIndex) + direction
      if (index < 0 || index >= this.items.length || this.rowFor(index)) return
      event.preventDefault()
      this.focusRow(index, direction)
    },
    async focusRow(index, direction) {
      const state = runtimes.get(this)
      if (!state?.active || index < 0 || index >= this.items.length) return
      const key = this.keys[index]
      this.keyboardKey = key
      const generation = state.generation
      await this.$nextTick()
      if (!state.active || state.disposed || generation !== state.generation || this.keys[index] !== key) {
        if (this.keyboardKey === key) this.keyboardKey = null
        return
      }
      const row = this.rowFor(index)
      const controls = this.focusables(row)
      const control = controls[direction < 0 ? controls.length - 1 : 0]
      if (control) {
        this.focusedKey = key
        control.focus({ preventScroll: true })
        const rect = row.getBoundingClientRect(), viewport = state.scroller.getBoundingClientRect()
        if (rect.top < viewport.top) state.scroller.scrollTop += rect.top - viewport.top
        else if (rect.bottom > viewport.bottom) state.scroller.scrollTop += rect.bottom - viewport.bottom
      }
      this.keyboardKey = null
      this.scheduleMeasure()
    },
    handleFocusIn(event) {
      const state = runtimes.get(this)
      const row = this.rowFrom(event.target)
      if (!row) return
      const index = Number(row.dataset.windowIndex)
      this.focusedKey = this.keys[index]
      const direction = state?.tabDirection || 0
      if (state) state.tabDirection = 0
      if (this.windowed && direction && event.relatedTarget && !this.$el.contains(event.relatedTarget)) {
        const boundary = direction < 0 ? this.items.length - 1 : 0
        if (index !== boundary) void this.focusRow(boundary, direction)
      }
    },
    handleFocusOut() {
      this.$nextTick(() => {
        if (!runtimes.get(this)?.active) return
        const row = this.rowFrom(this.$el.ownerDocument.activeElement)
        this.focusedKey = row ? this.keys[Number(row.dataset.windowIndex)] : null
      })
    }
  }
}
</script>

<style scoped>
.windowed-list { position: relative; }
.windowed-list-spacer { display: block; flex: none; padding: 0; margin: 0; border: 0; pointer-events: none; }
</style>
