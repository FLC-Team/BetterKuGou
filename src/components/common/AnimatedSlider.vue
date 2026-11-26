<template>
  <input type="range" class="bk-slider" :data-variant="variant" :min="min" :max="max" :step="step"
    :value="modelValue" :style="{ '--slider-position': fillPosition }" @input="onInput" />
</template>

<script>
export default {
  name: 'AnimatedSlider',
  props: {
    modelValue: { type: Number, default: 0 },
    min: { type: [Number, String], default: 0 },
    max: { type: [Number, String], default: 100 },
    step: { type: [Number, String], default: 1 },
    variant: { type: String, default: 'control' }
  },
  emits: ['update:modelValue', 'input'],
  computed: {
    /** 按握柄行程计算填充边界，保留两端完整的空轨和满轨。 */
    fillPosition() {
      const min = Number(this.min)
      const max = Number(this.max)
      const value = this.modelValue
      if (![min, max, value].every(Number.isFinite) || max <= min || value <= min) return '0%'
      if (value >= max) return '100%'
      const fraction = (value - min) / (max - min)
      return `calc(var(--slider-grip-width) / 2 + (100% - var(--slider-grip-width)) * ${fraction})`
    }
  },
  methods: {
    /** 设置可直接绑定数值，播放进度仍可分别消费原生 input 和 change。 */
    onInput(event) {
      this.$emit('update:modelValue', Number(event.target.value))
      this.$emit('input', event)
    }
  }
}
</script>

<style scoped>
.bk-slider {
  --slider-grip-width: 10px;
  --slider-grip-height: 16px;
  --slider-rail-height: 4px;
  --slider-rail-hover-height: 6px;
  --slider-grip-opacity: 1;
  --slider-grip-scale: 1;
  --slider-halo-size: 0px;
  --slider-accent: var(--slider-fill, var(--color-primary));
  --slider-rail: var(--slider-track, color-mix(in srgb, var(--color-text-secondary) 28%, transparent));
  --slider-grip: var(--slider-thumb, var(--slider-accent));
  --slider-halo: color-mix(in srgb, var(--slider-accent) 23%, transparent);
  --slider-direction: right;
  --slider-rail-background: linear-gradient(to var(--slider-direction), var(--slider-accent) var(--slider-position), var(--slider-rail) var(--slider-position));
  --slider-grip-transition: opacity var(--ui-motion-fast), scale var(--ui-motion-normal) var(--ui-motion-ease),
    box-shadow var(--ui-motion-normal) var(--ui-motion-ease), margin-top var(--ui-motion-normal) var(--ui-motion-ease);
  display: block;
  width: 100%;
  min-width: 0;
  height: var(--slider-hit-height, 32px);
  margin: 0;
  padding: 0;
  appearance: none;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
  touch-action: pan-y;
}

.bk-slider:dir(rtl) { --slider-direction: left; }
.bk-slider[data-variant="seek"] {
  --slider-grip-opacity: 0;
  --slider-grip-scale: .75;
  --slider-rail-height: 3px;
  --slider-rail-hover-height: 5px;
}
.bk-slider:disabled { opacity: .45; cursor: default; }

.bk-slider:not(:disabled):is(:focus-visible, :active) {
  --slider-grip-opacity: 1;
  --slider-grip-scale: 1;
  --slider-rail-height: var(--slider-rail-hover-height);
  --slider-halo-size: 4px;
}
.bk-slider:focus-visible { outline: 2px solid var(--slider-accent); outline-offset: 2px; }
@media (hover: hover) {
  .bk-slider:not(:disabled):hover {
    --slider-grip-opacity: 1;
    --slider-grip-scale: 1.05;
    --slider-rail-height: var(--slider-rail-hover-height);
    --slider-halo-size: 3px;
  }
}
.bk-slider:not(:disabled):active {
  --slider-grip-scale: .9;
  --slider-halo-size: 5px;
  cursor: grabbing;
}

.bk-slider::-webkit-slider-runnable-track {
  height: var(--slider-rail-height);
  border-radius: 999px;
  background: var(--slider-rail-background);
  transition: height var(--ui-motion-normal) var(--ui-motion-ease);
}
.bk-slider::-moz-range-track {
  height: var(--slider-rail-height);
  border-radius: 999px;
  background: var(--slider-rail-background);
  transition: height var(--ui-motion-normal) var(--ui-motion-ease);
}
.bk-slider::-webkit-slider-thumb {
  appearance: none;
  width: var(--slider-grip-width);
  height: var(--slider-grip-height);
  margin-top: calc((var(--slider-rail-height) - var(--slider-grip-height)) / 2);
  border-radius: 999px;
  background: var(--slider-grip);
  opacity: var(--slider-grip-opacity);
  scale: var(--slider-grip-scale);
  box-shadow: 0 0 0 var(--slider-halo-size) var(--slider-halo), var(--shadow-slider);
  transition: var(--slider-grip-transition);
}
.bk-slider::-moz-range-thumb {
  width: var(--slider-grip-width);
  height: var(--slider-grip-height);
  border: 0;
  border-radius: 999px;
  background: var(--slider-grip);
  opacity: var(--slider-grip-opacity);
  scale: var(--slider-grip-scale);
  box-shadow: 0 0 0 var(--slider-halo-size) var(--slider-halo), var(--shadow-slider);
  transition: var(--slider-grip-transition);
}

@media (prefers-reduced-motion: reduce) {
  .bk-slider { --slider-grip-transition: none; }
  .bk-slider::-webkit-slider-runnable-track { transition: none; }
  .bk-slider::-moz-range-track { transition: none; }
  .bk-slider::-webkit-slider-thumb { scale: 1; }
  .bk-slider::-moz-range-thumb { scale: 1; }
}

@media (forced-colors: active) {
  .bk-slider {
    forced-color-adjust: none;
    --slider-accent: Highlight;
    --slider-rail: GrayText;
    --slider-grip: CanvasText;
    --slider-halo: Canvas;
  }
}
</style>
