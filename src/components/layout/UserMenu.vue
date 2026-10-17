<template>
  <Transition name="user-menu-fade" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
    <div v-if="visible" class="user-menu-overlay" @keydown.esc.stop.prevent="handleClose">
      <Transition name="user-menu-slide" appear @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
        <div v-if="visible" ref="menu" class="user-menu" role="group" aria-label="账号菜单" :style="menuStyle" @click.stop>
          <!-- 用户信息头部 -->
          <div class="user-menu-header">
            <div class="user-avatar-large">
              <img v-if="userInfo.avatar" :src="userInfo.avatar" alt="头像" />
              <svg v-else class="default-avatar" viewBox="0 0 1024 1024">
                <path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="currentColor" opacity=".2"></path>
                <path d="M512 640c-70.692 0-128-57.308-128-128s57.308-128 128-128 128 57.308 128 128-57.308 128-128 128z m0-192c-35.346 0-64 28.654-64 64s28.654 64 64 64 64-28.654 64-64-28.654-64-64-64z m256 448H256c-17.673 0-32-14.327-32-32 0-123.514 100.486-224 224-224h96c123.514 0 224 100.486 224 224 0 17.673-14.327 32-32 32z m-479.967-64h447.935c-13.547-77.612-81.232-137.036-159.968-137.036h-96c-78.736 0-146.421 59.424-159.967 137.036z" fill="currentColor"></path>
              </svg>
            </div>
            <div class="user-info-text">
              <div class="user-name">{{ userInfo.username || '用户' }}</div>
              <div class="user-id">ID: {{ userInfo.userid }}</div>
              <div v-if="userInfo.vip_type > 0" class="vip-badge-small">VIP</div>
            </div>
          </div>

          <div class="menu-divider"></div>

          <!-- 菜单选项 -->
          <div class="menu-items">
            <button class="menu-item" @click="handleEditProfile">
              <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
                <path d="M880 836H144c-17.7 0-32 14.3-32 32v56c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-56c0-17.7-14.3-32-32-32zm-622.3-84c2 0 4-.2 6-.5L431.9 722c2-.4 3.9-1.3 5.3-2.8l423.9-423.9a9.96 9.96 0 000-14.1L694.9 114.9c-1.9-1.9-4.4-2.9-7.1-2.9s-5.2 1-7.1 2.9L256.8 538.8c-1.5 1.5-2.4 3.3-2.8 5.3l-29.5 168.2a33.5 33.5 0 009.4 29.8c6.6 6.4 14.9 9.9 23.8 9.9z"/>
              </svg>
              <span>编辑资料</span>
            </button>

            <button class="menu-item" @click="handleSettings">
              <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
                <path d="M924.8 625.7l-65.5-56c3.1-19 4.7-38.4 4.7-57.8s-1.6-38.8-4.7-57.8l65.5-56a32.03 32.03 0 009.3-35.2l-.9-2.6a443.74 443.74 0 00-79.7-137.9l-1.8-2.1a32.12 32.12 0 00-35.1-9.5l-81.3 28.9c-30-24.6-63.5-44-99.7-57.6l-15.7-85a32.05 32.05 0 00-25.8-25.7l-2.7-.5c-52.1-9.4-106.9-9.4-159 0l-2.7.5a32.05 32.05 0 00-25.8 25.7l-15.8 85.4a351.86 351.86 0 00-99 57.4l-81.9-29.1a32 32 0 00-35.1 9.5l-1.8 2.1a446.02 446.02 0 00-79.7 137.9l-.9 2.6c-4.5 12.5-.8 26.5 9.3 35.2l66.3 56.6c-3.1 18.8-4.6 38-4.6 57.1 0 19.2 1.5 38.4 4.6 57.1L99 625.5a32.03 32.03 0 00-9.3 35.2l.9 2.6c18.1 50.4 44.9 96.9 79.7 137.9l1.8 2.1a32.12 32.12 0 0035.1 9.5l81.9-29.1c29.8 24.5 63.1 43.9 99 57.4l15.8 85.4a32.05 32.05 0 0025.8 25.7l2.7.5a449.4 449.4 0 00159 0l2.7-.5a32.05 32.05 0 0025.8-25.7l15.7-85a350 350 0 0099.7-57.6l81.3 28.9a32 32 0 0035.1-9.5l1.8-2.1c34.8-41.1 61.6-87.5 79.7-137.9l.9-2.6c4.5-12.3.8-26.3-9.3-35zM788.3 465.9c2.5 15.1 3.8 30.6 3.8 46.1s-1.3 31-3.8 46.1l-6.6 40.1 74.7 63.9a370.03 370.03 0 01-42.6 73.6L721 702.8l-31.4 25.8c-23.9 19.6-50.5 35-79.3 45.8l-38.1 14.3-17.9 97a377.5 377.5 0 01-85 0l-17.9-97.2-37.8-14.5c-28.5-10.8-55-26.2-78.7-45.7l-31.4-25.9-93.4 33.2c-17-22.9-31.2-47.6-42.6-73.6l75.5-64.5-6.5-40c-2.4-14.9-3.7-30.3-3.7-45.5 0-15.3 1.2-30.6 3.7-45.5l6.5-40-75.5-64.5c11.3-26.1 25.6-50.7 42.6-73.6l93.4 33.2 31.4-25.9c23.7-19.5 50.2-34.9 78.7-45.7l37.9-14.3 17.9-97.2c28.1-3.2 56.8-3.2 85 0l17.9 97 38.1 14.3c28.7 10.8 55.4 26.2 79.3 45.8l31.4 25.8 92.8-32.9c17 22.9 31.2 47.6 42.6 73.6L781.8 426l6.5 39.9zM512 326c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176-176zm79.2 255.2A111.6 111.6 0 01512 614c-29.9 0-58-11.7-79.2-32.8A111.6 111.6 0 01400 502c0-29.9 11.7-58 32.8-79.2C454 401.6 482.1 390 512 390c29.9 0 58 11.6 79.2 32.8C612.4 444 624 472.1 624 502c0 29.9-11.6 58-32.8 79.2z"/>
              </svg>
              <span>设置</span>
            </button>

            <div class="menu-divider"></div>

            <button class="menu-item danger" @click="handleLogout">
              <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
                <path d="M868 732h-70.3c-4.8 0-9.3 2.1-12.3 5.8-7 8.5-14.5 16.7-22.4 24.5a353.84 353.84 0 01-112.7 75.9A352.8 352.8 0 01512.4 866c-47.9 0-94.3-9.4-137.9-27.8a353.84 353.84 0 01-112.7-75.9 353.28 353.28 0 01-76-112.5C167.3 606.2 158 559.9 158 512s9.4-94.2 27.8-137.8c17.8-42.1 43.4-80 76-112.5s70.5-58.1 112.7-75.9c43.6-18.4 90-27.8 137.9-27.8 47.9 0 94.3 9.3 137.9 27.8 42.2 17.8 80.1 43.4 112.7 75.9 7.9 7.9 15.3 16.1 22.4 24.5 3 3.7 7.6 5.8 12.3 5.8H868c6.3 0 10.2-7 6.7-12.3C798 160.5 663.8 81.6 511.3 82 271.7 82.6 79.6 277.1 82 516.4 84.4 751.9 276.2 942 512.4 942c152.1 0 285.7-78.8 362.3-197.7 3.4-5.3-.4-12.3-6.7-12.3zm88.9-226.3L815 393.7c-5.3-4.2-13-.4-13 6.3v76H488c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h314v76c0 6.7 7.8 10.5 13 6.3l141.9-112a8 8 0 000-12.6z"/>
              </svg>
              <span>退出登录</span>
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

<script>
import { logger } from '../../utils/logger.js'

export default {
  name: 'UserMenu',
  props: {
    visible: {
      type: Boolean,
      default: false
    },
    userInfo: {
      type: Object,
      required: true
    },
    position: {
      type: Object,
      default: () => ({ top: 0, right: 0 })
    }
  },
  computed: {
    menuStyle() {
      return {
        top: `${this.position.top}px`,
        right: `${this.position.right}px`
      }
    }
  },
  watch: {
    visible(newVal) {
      clearTimeout(this.clickListenerTimer)
      if (newVal) {
        // 菜单打开时，延迟添加全局点击监听器
        // 延迟是为了避免立即触发关闭
        this.$nextTick(() => {
          if (!this.visible || this.menuDisposed) return
          this.clickListenerTimer = setTimeout(() => {
            if (!this.visible || this.menuDisposed) return
            document.addEventListener('click', this.handleClickOutside)
          }, 100)
        })
      } else {
        // 菜单关闭时，移除监听器
        document.removeEventListener('click', this.handleClickOutside)
      }
    }
  },
  beforeUnmount() {
    this.menuDisposed = true
    clearTimeout(this.clickListenerTimer)
    // 组件销毁前移除监听器
    document.removeEventListener('click', this.handleClickOutside)
  },
  methods: {
    handleClickOutside(event) {
      // 检查点击是否在菜单外部
      const menuEl = this.$refs.menu
      if (menuEl && !menuEl.contains(event.target)) {
        logger.trace('UserMenu', 'UserMenu: 点击外部，关闭菜单')
        this.handleClose()
      }
    },
    handleClose() {
      logger.trace('UserMenu', 'UserMenu: 关闭菜单')
      this.$emit('close')
    },
    handleEditProfile() {
      logger.trace('UserMenu', 'UserMenu: 编辑资料')
      this.$emit('edit-profile')
      this.handleClose()
    },
    handleSettings() {
      logger.trace('UserMenu', 'UserMenu: 打开设置界面')
      this.$emit('open-settings')
      this.handleClose()
    },
    handleLogout() {
      logger.trace('UserMenu', 'UserMenu: 退出登录')
      this.$emit('logout')
      this.handleClose()
    }
  }
}
</script>

<style scoped>
/* 遮罩层淡入淡出动画 */
.user-menu-fade-enter-active,
.user-menu-fade-leave-active {
  transition: opacity 0.2s ease, scale var(--ui-motion-fast) var(--ui-motion-ease);
}

.user-menu-fade-enter-from,
.user-menu-fade-leave-to {
  opacity: 0;
}

/* 菜单滑动动画 */
.user-menu-slide-enter-active {
  transition: all 0.2s ease-out;
}

.user-menu-slide-leave-active {
  transition: all 0.15s ease-in;
}

.user-menu-slide-enter-from {
  opacity: 0;
  transform: translateY(-10px) scale(0.95);
}

.user-menu-slide-leave-to {
  opacity: 0;
  transform: translateY(-5px) scale(0.98);
}

.user-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9998;
  background: transparent;
}

.user-menu {
  position: fixed;
  width: 280px;
  background: var(--color-background-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  z-index: 9999;
  transform-origin: top right;
}

.user-menu-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  background: var(--color-background);
}

.user-avatar-large {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-background-lighter);
  border: 2px solid var(--color-border);
  flex-shrink: 0;
}

.user-avatar-large img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.user-avatar-large .default-avatar {
  width: 32px;
  height: 32px;
  color: var(--color-text-secondary);
}

.user-info-text {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: var(--spacing-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-id {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  margin-bottom: var(--spacing-xs);
}

.vip-badge-small {
  display: inline-block;
  padding: 2px 8px;
  background: var(--gradient-gold);
  color: var(--text-black);
  border-radius: var(--radius-sm);
  font-weight: 600;
  font-size: var(--font-size-xs);
}

.menu-divider {
  height: 1px;
  background: var(--color-border);
  margin: 0;
}

.menu-items {
  padding: var(--spacing-sm) 0;
}

.menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg);
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: var(--font-family);
  cursor: pointer;
  transition: all var(--transition-fast);
  text-align: left;
}

.menu-item:hover {
  background: var(--color-background);
}

.menu-item svg {
  flex-shrink: 0;
}

.menu-item.danger {
  color: var(--color-error);
}

.menu-item.danger:hover {
  background: var(--color-error-light);
}
</style>
