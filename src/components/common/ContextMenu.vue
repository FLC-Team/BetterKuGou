<template>
  <teleport to="body">
    <Transition name="menu" appear>
    <div 
      v-if="visible && !closing"
      ref="menu"
      class="context-menu"
      role="menu"
      tabindex="-1"
      :style="menuStyle"
      @click.stop
      @contextmenu.prevent
      @keydown="handleKey"
    >
      <div 
        v-for="(item, index) in items" 
        :key="index"
        :class="['menu-item', { 'divider': item.divider, 'disabled': item.disabled }]"
        :role="item.divider ? 'separator' : 'menuitem'"
        :tabindex="item.divider || item.disabled ? undefined : -1"
        :aria-disabled="item.disabled || undefined"
        @click="handleItemClick(item)"
      >
        <template v-if="!item.divider">
          <!-- 如果是 SVG 文件路径或 data URL，使用 img 标签 -->
          <img v-if="item.icon && typeof item.icon === 'string' && (item.icon.endsWith('.svg') || item.icon.startsWith('data:image/svg+xml'))" 
               :src="item.icon" 
               class="menu-icon" 
               width="16" 
               height="16" 
               alt="" />
          <!-- 如果是 SVG path 数据，使用原来的方式 -->
          <svg v-else-if="item.icon" class="menu-icon" viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
            <path :d="item.icon"/>
          </svg>
          <span class="menu-label">{{ item.label }}</span>
          <span v-if="item.shortcut" class="menu-shortcut">{{ item.shortcut }}</span>
        </template>
      </div>
    </div>
    </Transition>
  </teleport>
</template>

<script>
export default {
  name: 'ContextMenu',
  emits: ['close'],
  props: {
    visible: {
      type: Boolean,
      default: false
    },
    position: {
      type: Object,
      default: () => ({ x: 0, y: 0 })
    },
    items: {
      type: Array,
      default: () => []
    }
  },
  data() {
    return {
      adjustedPosition: { ...this.position },
      closing: false
    }
  },
  computed: {
    menuStyle() {
      return {
        left: this.adjustedPosition.x + 'px',
        top: this.adjustedPosition.y + 'px'
      }
    }
  },
  watch: {
    visible(newVal) {
      if (newVal) {
        this.closing = false
        this.$nextTick(() => {
          this.adjustMenuPosition()
        })
      } else this.lockMenu()
    },
    position: {
      handler() {
        if (this.visible) {
          this.closing = false
          this.$nextTick(() => {
            this.adjustMenuPosition()
          })
        }
      },
      deep: true
    }
  },
  mounted() {
    document.addEventListener('click', this.handleClickOutside)
    window.addEventListener('resize', this.handleClickOutside)
    window.addEventListener('scroll', this.handleClickOutside, true)
    if (this.visible) this.$nextTick(() => this.adjustMenuPosition())
  },
  beforeUnmount() {
    document.removeEventListener('click', this.handleClickOutside)
    window.removeEventListener('resize', this.handleClickOutside)
    window.removeEventListener('scroll', this.handleClickOutside, true)
  },
  methods: {
    handleItemClick(item) {
      if (this.closing || !this.visible) return
      if (!item.divider && !item.disabled && item.action) {
        this.lockMenu()
        try { item.action() } finally { this.$emit('close') }
      }
    },
    /** Lock the leaving DOM immediately, including programmatic double activation. */
    lockMenu() {
      this.closing = true
      if (this.$refs.menu) this.$refs.menu.inert = true
    },
    handleKey(event) {
      if (this.closing) return
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault()
        this.lockMenu()
        this.$emit('close')
        return
      }
      const entries = Array.from(this.$refs.menu?.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])') || [])
      const index = entries.indexOf(document.activeElement)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
          : index < 0 ? (event.key === 'ArrowDown' ? 0 : entries.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
        entries[next]?.focus()
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        document.activeElement?.click()
      }
    },
    handleClickOutside(event) {
      if (!this.visible || this.closing) return
      // 如果点击的是菜单内部，不关闭
      if (this.$refs.menu && event.target && this.$refs.menu.contains(event.target)) {
        return
      }
      this.lockMenu()
      this.$emit('close')
    },
    adjustMenuPosition() {
      if (!this.$refs.menu) {
        this.adjustedPosition = { ...this.position }
        return
      }

      const menu = this.$refs.menu
      const menuRect = menu.getBoundingClientRect()
      const menuWidth = menuRect.width || 180 // 默认宽度
      const menuHeight = menuRect.height || 200 // 默认高度
      
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      
      let x = this.position.x
      let y = this.position.y
      
      // 检查右边界
      if (x + menuWidth > viewportWidth) {
        x = viewportWidth - menuWidth - 10 // 留10px边距
      }
      
      // 检查左边界
      if (x < 0) {
        x = 10
      }
      
      // 检查下边界
      if (y + menuHeight > viewportHeight) {
        y = viewportHeight - menuHeight - 10 // 留10px边距
      }
      
      // 检查上边界
      if (y < 0) {
        y = 10
      }
      
      this.adjustedPosition = { x, y }
      menu.inert = false
      menu.focus({ preventScroll: true })
    }
  }
}
</script>

<style scoped>
.context-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-menu);
  border: 1px solid var(--border-light-alpha);
  border-radius: 8px;
  box-shadow: var(--shadow-menu);
  padding: 4px;
  z-index: 10000;
  backdrop-filter: blur(10px);
  transform-origin: top left;
}

.menu-enter-active, .menu-leave-active { transition: opacity .15s ease, transform .15s ease; }
.menu-enter-from, .menu-leave-to { opacity: 0; transform: scale(.95) translateY(-5px); }
.menu-leave-active { pointer-events: none; }

.menu-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-white-alpha);
  font-size: 13px;
  border-radius: 4px;
  transition: all 0.15s ease;
  gap: 10px;
  user-select: none;
}

.menu-item:not(.divider):not(.disabled):hover,
.menu-item:not(.divider):not(.disabled):focus-visible {
  background: var(--bg-hover);
  color: var(--text-white);
}
.menu-item:focus-visible { outline: 1px solid var(--color-primary); outline-offset: -1px; }
.menu-item:not(.disabled):not(.divider):active { scale: .97; }

.menu-item.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.menu-item.divider {
  height: 1px;
  padding: 0;
  margin: 4px 8px;
  background: var(--bg-hover);
  cursor: default;
}

.menu-icon {
  flex-shrink: 0;
  opacity: 0.8;
  /* 将SVG图标转为单色，然后使用当前文字颜色 */
  filter: brightness(0) saturate(100%) invert(70%);
  transition: filter 0.15s ease;
}

.menu-item:hover .menu-icon {
  /* 鼠标悬停时使用更亮的颜色 */
  filter: brightness(0) saturate(100%) invert(100%);
  opacity: 1;
}

.menu-label {
  flex: 1;
  white-space: nowrap;
}

.menu-shortcut {
  font-size: 11px;
  opacity: 0.5;
  margin-left: auto;
}
@media (prefers-reduced-motion: reduce) { .context-menu, .menu-item, .menu-icon { transition-duration: .001ms !important; } }
</style>
