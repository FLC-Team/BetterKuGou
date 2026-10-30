<template>
  <div ref="control" class="volume-control" :class="{ 'volume-control-lyric': variant === 'lyric' }"
       @contextmenu.prevent.stop="openEditor">
    <button ref="muteButton" type="button" class="volume-button" @click="$emit('toggle-mute')"
            :aria-label="muted ? '取消静音' : '静音'" :aria-pressed="muted"
            :title="`${muted ? '取消静音' : '静音'}；右键输入音量`">
      <svg class="volume-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path class="volume-speaker" d="M3 9h4l5-4v14l-5-4H3Z" />
        <path class="volume-wave" :class="{ 'is-visible': iconLevel >= 1 }" d="M14.5 9a5 5 0 0 1 0 6" />
        <path class="volume-wave" :class="{ 'is-visible': iconLevel >= 2 }" d="M17 6.5a8.5 8.5 0 0 1 0 11" />
        <path class="volume-wave" :class="{ 'is-visible': iconLevel >= 3 }" d="M19.5 4a12 12 0 0 1 0 16" />
        <path class="volume-mute" :class="{ 'is-visible': muted }" d="m16 9 6 6m0-6-6 6" />
      </svg>
    </button>
    <span class="volume-range" :class="{ 'is-muted': muted }" :style="{ '--volume-fill': volume + '%' }">
      <span class="volume-track" aria-hidden="true"><span class="volume-fill"></span></span>
      <input type="range" class="volume-slider" min="0" max="100" step="1" :value="volume"
             aria-label="音量" :aria-valuetext="`${volume}%${muted ? '（已静音）' : ''}`"
             title="拖动调节音量，右键输入数值" @input="$emit('change', Number($event.target.value))" />
    </span>
    <button ref="valueButton" type="button" class="volume-value" @click.stop="openEditor"
            aria-haspopup="dialog" :aria-expanded="editorOpen" :aria-label="`输入音量，当前 ${muted ? 0 : volume}%`"
            title="输入音量（也可右键）">{{ muted ? 0 : Math.round(volume) }}%</button>
    <Teleport to="body">
      <Transition name="volume-editor" @before-enter="activateEditor" @before-leave="retireEditor">
        <form v-if="editorOpen" ref="editor" class="volume-editor" role="dialog" aria-label="输入音量"
              :style="{ left: position.x + 'px', top: position.y + 'px' }" novalidate
              @submit.prevent="commitVolume" @click.stop @contextmenu.stop @keydown.stop
              @keydown.esc.stop.prevent="closeEditor(true)" @focusout="handleFocusout">
          <label class="volume-field"><span>音量</span><span class="volume-input-wrap">
            <input ref="numberInput" v-model="draft" type="number" min="0" max="100" step="1"
                   aria-label="音量百分比" :aria-invalid="Boolean(error)" @input="error = ''" />
            <span aria-hidden="true">%</span>
          </span></label>
          <p v-if="error" class="volume-error" role="alert">{{ error }}</p>
          <div class="volume-editor-actions">
            <button type="button" @click="closeEditor(true)">取消</button>
            <button type="submit" class="volume-confirm">确定</button>
          </div>
        </form>
      </Transition>
    </Teleport>
  </div>
</template>

<script>
import contextMenuManager from '../../utils/contextMenuManager.js'

export default {
  name: 'VolumeControl',
  props: {
    volume: { type: Number, default: 80 },
    isMuted: { type: Boolean, default: false },
    variant: { type: String, default: 'player' },
    active: { type: Boolean, default: true }
  },
  emits: ['change', 'toggle-mute'],
  data() {
    return { editorOpen: false,
      draft: '', error: '', position: { x: 0, y: 0 }, disposed: false }
  },
  computed: {
    muted() { return this.isMuted || this.volume === 0 },
    iconLevel() { return this.muted ? 0 : this.volume <= 30 ? 1 : this.volume <= 60 ? 2 : 3 }
  },
  watch: {
    active(value) { if (!value) this.closeEditor() }
  },
  beforeUnmount() {
    this.disposed = true
    this.closeEditor()
  },
  methods: {
    /** 在两处播放界面共用菜单互斥及草稿；确认之前不改变真实音量。 */
    async openEditor() {
      if (!this.active || this.disposed) return
      contextMenuManager.registerMenu(this.closeEditor)
      this.draft = String(this.volume)
      this.error = ''
      this.editorOpen = true
      document.addEventListener('pointerdown', this.handleOutsidePointer, true)
      window.addEventListener('blur', this.handleWindowChange)
      window.addEventListener('resize', this.handleWindowChange)
      await this.$nextTick()
      if (!this.editorOpen || this.disposed) return
      const anchor = this.$refs.control.getBoundingClientRect()
      const panel = this.$refs.editor.getBoundingClientRect()
      const top = anchor.top - panel.height - 8
      this.position = {
        x: Math.max(8, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - 8)),
        y: Math.max(8, Math.min(top >= 8 ? top : anchor.bottom + 8, window.innerHeight - panel.height - 8))
      }
      this.$refs.numberInput.focus()
      this.$refs.numberInput.select()
    },
    closeEditor(restoreFocus = false) {
      const wasOpen = this.editorOpen
      this.editorOpen = false
      contextMenuManager.unregisterMenu(this.closeEditor)
      document.removeEventListener('pointerdown', this.handleOutsidePointer, true)
      window.removeEventListener('blur', this.handleWindowChange)
      window.removeEventListener('resize', this.handleWindowChange)
      if (wasOpen && restoreFocus === true && !this.disposed && this.active) this.$refs.valueButton?.focus()
    },
    /** 拒绝空值、非整数及越界数值，避免输入过程误把音量设成零或最大值。 */
    commitVolume() {
      if (!this.editorOpen || !this.active || this.disposed) return
      const value = Number(this.draft)
      if (!String(this.draft).trim() || !Number.isInteger(value) || value < 0 || value > 100) {
        this.error = '请输入 0–100 之间的整数'
        this.$refs.numberInput?.focus()
        return
      }
      this.$emit('change', value)
      this.closeEditor(true)
    },
    handleOutsidePointer(event) {
      if (!this.$refs.control?.contains(event.target) && !this.$refs.editor?.contains(event.target)) this.closeEditor()
    },
    handleWindowChange() { this.closeEditor() },
    handleFocusout(event) {
      if (!this.$refs.editor?.contains(event.relatedTarget)) this.closeEditor()
    },
    activateEditor(element) { element.inert = false; element.removeAttribute('aria-hidden') },
    retireEditor(element) { element.inert = true; element.setAttribute('aria-hidden', 'true') }
  }
}
</script>

<style scoped>
.volume-control { display: flex; align-items: center; gap: 5px; flex-shrink: 0; color: var(--color-text-secondary); --volume-track-color: var(--color-border); --volume-fill-color: var(--color-primary); }
.volume-button, .volume-value { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; height: 30px; padding: 0; border: none; border-radius: var(--radius-sm); background: transparent; color: inherit; cursor: pointer; transition: background-color .16s ease, color .16s ease, scale .16s ease; }
.volume-button { width: 30px; }
.volume-value { min-width: 36px; font-size: 11px; font-variant-numeric: tabular-nums; }
.volume-button:hover, .volume-value:hover { background: var(--bg-hover); color: var(--color-text); }
.volume-button:active, .volume-value:active { scale: .94; }
.volume-button:focus-visible, .volume-value:focus-visible, .volume-slider:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
/* 喇叭主体保持同一节点和位置；快速跨档只反转声波过渡，不叠放整张图标。 */
.volume-icon { display: block; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.volume-wave, .volume-mute { opacity: 0; transform: scale(.8); transform-origin: 12px 12px; transition: opacity .16s ease, transform .18s ease; }
.volume-wave.is-visible, .volume-mute.is-visible { opacity: 1; transform: scale(1); }
.volume-range { position: relative; display: var(--volume-slider-display, block); width: var(--volume-slider-width, 80px); height: 24px; flex-shrink: 0; }
.volume-track { position: absolute; top: 10px; left: 6px; right: 6px; height: 4px; border-radius: 2px; background: var(--volume-track-color); pointer-events: none; }
/* 填充与原生滑块共用有效行程，拖动直接跟手，静音仅降低填充亮度。 */
.volume-fill { display: block; width: var(--volume-fill); height: 100%; border-radius: inherit; background: var(--volume-fill-color); transition: opacity .16s ease; }
.volume-range.is-muted .volume-fill { opacity: .35; }
.volume-slider { position: relative; display: block; width: 100%; height: 24px; margin: 0; padding: 0; appearance: none; background: transparent; border: 0; border-radius: 2px; cursor: pointer; accent-color: var(--volume-fill-color); }
.volume-slider::-webkit-slider-runnable-track { height: 4px; background: transparent; }
.volume-slider::-webkit-slider-thumb { appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: var(--volume-fill-color); transition: scale .16s ease, box-shadow .16s ease; }
.volume-slider::-moz-range-track { height: 4px; background: transparent; }
.volume-slider::-moz-range-progress { background: transparent; }
.volume-slider::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: var(--volume-fill-color); transition: scale .16s ease, box-shadow .16s ease; }
.volume-slider:is(:hover, :focus-visible)::-webkit-slider-thumb { scale: 1.15; }
.volume-slider:is(:hover, :focus-visible)::-moz-range-thumb { scale: 1.15; }
.volume-slider:active::-webkit-slider-thumb { scale: 1.25; }
.volume-slider:active::-moz-range-thumb { scale: 1.25; }
.volume-control-lyric { color: var(--lyric-text-secondary); --volume-slider-width: 62px; --volume-track-color: var(--lyric-track); --volume-fill-color: var(--lyric-text); }
.volume-control-lyric .volume-button:hover, .volume-control-lyric .volume-value:hover { color: var(--lyric-text); background: var(--lyric-hover); }
.volume-editor { position: fixed; z-index: 11000; box-sizing: border-box; width: 220px; max-width: calc(100vw - 16px); padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-background-light); color: var(--color-text); box-shadow: var(--shadow-playlist); font-size: 13px; -webkit-app-region: no-drag; }
.volume-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.volume-input-wrap { display: flex; align-items: center; gap: 6px; }
.volume-input-wrap input { width: 72px; padding: 6px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-background); color: var(--color-text); font: inherit; }
.volume-editor button { padding: 6px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: transparent; color: inherit; font: inherit; cursor: pointer; transition: background-color .16s ease, scale .16s ease; }
.volume-editor button:hover { background: var(--bg-hover); }
.volume-editor button:active { scale: .96; }
.volume-editor button:focus-visible, .volume-input-wrap input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.volume-editor .volume-confirm { background: var(--color-primary); color: var(--color-on-primary, #fff); }
.volume-editor-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.volume-error { color: var(--color-error); margin: 10px 0 0; font-size: 12px; }
.volume-editor-enter-active, .volume-editor-leave-active { transition: opacity .16s ease, translate .16s ease; }
.volume-editor-enter-from, .volume-editor-leave-to { opacity: 0; translate: 0 4px; }
.volume-editor-leave-active { pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .volume-control *, .volume-control *::before, .volume-editor, .volume-editor * { transition: none !important; }
  .volume-slider::-webkit-slider-thumb { transition: none !important; scale: 1 !important; }
  .volume-slider::-moz-range-thumb { transition: none !important; scale: 1 !important; }
}
</style>
