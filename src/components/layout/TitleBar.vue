<template>
  <div class="title-bar" :class="{ 'lyric-mode': isLyricViewVisible }">
    <!-- Logo区域 -->
    <div class="logo-container">
      <Transition name="ui-pop" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><button v-if="!isLyricViewVisible" type="button" class="navigation-back" aria-label="返回上一页" title="返回上一页" :disabled="!canGoBack" @click="$emit('back')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
      </button></Transition>
      <img src="/logo.png" alt="Logo" class="logo-icon" />
      <span class="app-name">BETTERKUGOU</span>
    </div>
    
    <!-- 搜索框（居中） -->
    <Transition name="ui-fade" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><div v-if="!isLyricViewVisible" class="search-container" role="search" aria-label="音乐搜索">
      <form class="search-box" @submit.prevent="performSearch">
        <button class="search-btn" type="submit" aria-label="搜索" title="搜索" :disabled="!searchKeyword.trim()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <circle cx="10.75" cy="10.75" r="6.75" />
            <path d="m16 16 4.5 4.5" />
          </svg>
        </button>
        <input
          ref="searchInput"
          v-model="searchKeyword"
          type="text"
          aria-label="搜索歌曲、歌手、专辑"
          placeholder="搜索歌曲、歌手、专辑"
          enterkeyhint="search"
          autocomplete="off"
          spellcheck="false"
          @keydown.esc="!$event.isComposing && !$event.target.composing && $event.target.blur()"
        />
        <Transition name="ui-pop" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><button v-if="searchKeyword" class="search-clear" type="button" aria-label="清空搜索" title="清空搜索" @click="clearSearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
        <span v-else class="search-hint" aria-hidden="true">↵</span></Transition>
      </form>
    </div></Transition>
    
    <div class="window-controls">
      <!-- 用户信息或登录按钮 -->
      <button v-if="userLoggedIn && userInfo" ref="userInfoBtn" type="button" class="user-info" aria-label="打开账号菜单" :aria-expanded="showUserMenu" @click.stop="handleUserClick">
        <div class="user-avatar">
          <img v-if="userInfo.avatar" :src="userInfo.avatar" alt="头像" />
          <svg v-else class="default-avatar" viewBox="0 0 1024 1024">
            <path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="currentColor" opacity=".2"></path>
            <path d="M512 640c-70.692 0-128-57.308-128-128s57.308-128 128-128 128 57.308 128 128-57.308 128-128 128z m0-192c-35.346 0-64 28.654-64 64s28.654 64 64 64 64-28.654 64-64-28.654-64-64-64z m256 448H256c-17.673 0-32-14.327-32-32 0-123.514 100.486-224 224-224h96c123.514 0 224 100.486 224 224 0 17.673-14.327 32-32 32z m-479.967-64h447.935c-13.547-77.612-81.232-137.036-159.968-137.036h-96c-78.736 0-146.421 59.424-159.967 137.036z" fill="currentColor"></path>
          </svg>
        </div>
        <span class="user-name">{{ userInfo.username || '用户' }}</span>
      </button>
      <button v-else class="control-btn login-btn" @click="handleLogin" title="登录">
        <svg class="icon" viewBox="0 0 1024 1024" width="18" height="18">
          <path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="currentColor" opacity=".2"></path>
          <path d="M512 640c-70.692 0-128-57.308-128-128s57.308-128 128-128 128 57.308 128 128-57.308 128-128 128z m0-192c-35.346 0-64 28.654-64 64s28.654 64 64 64 64-28.654 64-64-28.654-64-64-64z m256 448H256c-17.673 0-32-14.327-32-32 0-123.514 100.486-224 224-224h96c123.514 0 224 100.486 224 224 0 17.673-14.327 32-32 32z m-479.967-64h447.935c-13.547-77.612-81.232-137.036-159.968-137.036h-96c-78.736 0-146.421 59.424-159.967 137.036z" fill="currentColor"></path>
        </svg>
      </button>
      

      
      <!-- 窗口控制按钮 -->
      <button class="control-btn minimize" @click="minimizeWindow" title="最小化">
        <img :src="icons.minimize" alt="最小化" class="icon" />
      </button>
      <button class="control-btn maximize" @click="toggleMaximize" :title="isMaximized ? '还原' : '最大化'">
        <Transition name="ui-pop" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><img :key="String(isMaximized)" :src="isMaximized ? icons.restore : icons.maximize" :alt="isMaximized ? '还原' : '最大化'" class="icon" /></Transition>
      </button>
      <button class="control-btn close" @click="closeWindow" title="关闭">
        <img :src="icons.close" alt="关闭" class="icon" />
      </button>
    </div>

    <!-- 用户菜单 -->
    <UserMenu
      :visible="showUserMenu"
      :userInfo="userInfo"
      :position="userMenuPosition"
      @close="showUserMenu = false"
      @edit-profile="handleEditProfile"
      @open-settings="handleSettings"
      @logout="handleLogout"
    />
  </div>
</template>

<script>
import { logger } from '../../utils/logger.js'

// 动态导入图标文件
import minimizeIcon from '../../assets/icons/minimize.svg'
import maximizeIcon from '../../assets/icons/full_screen_maximize.svg'
import restoreIcon from '../../assets/icons/full_screen_minimize.svg'
import closeIcon from '../../assets/icons/close.svg'
import UserMenu from './UserMenu.vue'

export default {
  name: 'TitleBar',
  components: {
    UserMenu
  },
  emits: ['update:modelValue', 'back', 'show-login', 'edit-profile', 'open-settings', 'logout', 'search'],
  props: {
    canGoBack: {
      type: Boolean,
      default: false
    },
    modelValue: {
      type: String,
      default: ''
    },
    userLoggedIn: {
      type: Boolean,
      default: false
    },
    userInfo: {
      type: Object,
      default: null
    },
    isLyricViewVisible: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      isMaximized: false,
      showUserMenu: false,
      userMenuPosition: { top: 0, right: 0 },
      // 图标路径配置 - 如需替换图标,只需修改这里的路径
      icons: {
        minimize: minimizeIcon,
        maximize: maximizeIcon,
        restore: restoreIcon,
        close: closeIcon
      }
    }
  },
  computed: {
    searchKeyword: {
      get() { return this.modelValue },
      set(value) { this.$emit('update:modelValue', value) }
    }
  },
  watch: {
    userLoggedIn(value) { if (!value) this.showUserMenu = false },
    isLyricViewVisible(newVal) {
      logger.trace('TitleBar', 'TitleBar: 歌词界面状态 =', newVal)
    }
  },
  mounted() {
    logger.trace('TitleBar', 'TitleBar mounted')
    logger.trace('TitleBar', 'electronAPI available:', !!window.electronAPI)
    
    // 监听窗口最大化状态
    if (window.electronAPI) {
      this.unsubscribeMaximized = window.electronAPI.onMaximized(() => {
        logger.trace('TitleBar', 'Window maximized')
        this.isMaximized = true
      })
      this.unsubscribeUnmaximized = window.electronAPI.onUnmaximized(() => {
        logger.trace('TitleBar', 'Window unmaximized')
        this.isMaximized = false
      })
    } else {
      logger.warn('TitleBar', 'electronAPI not available')
    }
  },
  beforeUnmount() {
    this.unsubscribeMaximized?.()
    this.unsubscribeUnmaximized?.()
  },
  methods: {
    handleLogin() {
      logger.trace('TitleBar', 'Login clicked')
      // 发射登录事件到父组件
      this.$emit('show-login')
    },
    handleUserClick() {
      logger.trace('TitleBar', 'User info clicked')
      // 计算菜单位置（在用户按钮下方）
      if (this.$refs.userInfoBtn) {
        const rect = this.$refs.userInfoBtn.getBoundingClientRect()
        this.userMenuPosition = {
          top: rect.bottom + 8, // 按钮下方 8px
          right: window.innerWidth - rect.right // 右对齐
        }
      }
      // 切换菜单显示状态
      this.showUserMenu = !this.showUserMenu
    },
    handleEditProfile() {
      logger.trace('TitleBar', 'Edit profile clicked')
      // TODO: 实现编辑资料功能
      this.$emit('edit-profile')
    },
    handleSettings() {
      logger.trace('TitleBar', 'Settings clicked')
      this.$emit('open-settings')
    },
    handleLogout() {
      logger.trace('TitleBar', 'Logout clicked')
      this.$emit('logout')
    },
    minimizeWindow() {
      logger.trace('TitleBar', 'Minimize clicked')
      if (window.electronAPI) {
        window.electronAPI.minimize()
      }
    },
    toggleMaximize() {
      logger.trace('TitleBar', 'Toggle maximize clicked, current state:', this.isMaximized)
      if (window.electronAPI) {
        if (this.isMaximized) {
          window.electronAPI.unmaximize()
        } else {
          window.electronAPI.maximize()
        }
      }
    },
    closeWindow() {
      logger.trace('TitleBar', 'Close clicked')
      if (window.electronAPI) {
        window.electronAPI.close()
      }
    },
    // 输入法选词期间不提交；沿用父级搜索事件和关键词规范化。
    performSearch() {
      if (this.$refs.searchInput?.composing) return
      const keyword = this.searchKeyword.trim()
      if (!keyword) {
        logger.trace('TitleBar', '搜索关键词为空')
        return
      }
      logger.trace('TitleBar', '执行搜索:', keyword)
      // 发射搜索事件到父组件
      this.$emit('search', keyword)
    },
    clearSearch() {
      this.searchKeyword = ''
      this.$refs.searchInput?.focus()
    }
  }
}
</script>

<style scoped>
.title-bar {
  height: var(--titlebar-height);
  background: var(--color-background);
  backdrop-filter: blur(10px);
  display: grid;
  grid-template-columns: minmax(max-content, 1fr) minmax(0, 360px) minmax(max-content, 1fr);
  align-items: center;
  column-gap: var(--spacing-md);
  -webkit-app-region: drag;
  user-select: none;
  position: relative;
  z-index: 9997;
  transition: all 0.3s ease;
}

/* 歌词模式：完全透明 */
.title-bar.lyric-mode {
  transition: none;
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar.lyric-mode .search-container {
  /* 全屏歌词时完全隐藏搜索框，避免遮挡与误触 */
  pointer-events: none;
}

.title-bar.lyric-mode .logo-container {
  opacity: 0.3;
}

/* Logo容器 */
.logo-container {
  grid-column: 1;
  justify-self: start;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-md);
  -webkit-app-region: no-drag;
  transition: opacity 0.3s ease, scale var(--ui-motion-fast) var(--ui-motion-ease);
  flex-shrink: 0;
  min-width: 200px;
}

.logo-icon {
  width: 24px;
  height: 24px;
  object-fit: contain;
  transition: transform 0.3s ease, scale var(--ui-motion-fast) var(--ui-motion-ease);
}

.navigation-back {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  -webkit-app-region: no-drag;
}

.navigation-back svg { width: 20px; height: 20px; }
.navigation-back:hover:not(:disabled) { color: var(--color-primary); background: var(--color-background-light); }
.navigation-back:disabled { opacity: .3; cursor: default; }
.navigation-back:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }

.logo-icon:hover {
  transform: scale(1.05);
}

.app-name {
  font-size: var(--font-size-sm);
  font-weight: 700;
  color: var(--color-text);
  letter-spacing: 0.5px;
  user-select: none;
  transition: color 0.3s ease, scale var(--ui-motion-fast) var(--ui-motion-ease);
}

/* 搜索容器 */
.search-container {
  grid-column: 2;
  min-width: 0;
  -webkit-app-region: no-drag;
}

.search-box {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  width: 100%;
  height: 34px;
  padding: 0 5px;
  background: var(--bg-hover-light);
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  transition: background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast), scale var(--ui-motion-fast) var(--ui-motion-ease);
}

.search-box:hover {
  background: var(--bg-hover);
}

.search-box:focus-within {
  background: var(--color-background-light);
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--color-border));
  box-shadow: 0 0 0 3px var(--color-primary-light);
}

.search-box input {
  flex: 1;
  width: 100%;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
}

.search-box input::placeholder {
  color: var(--color-text-secondary);
  opacity: 1;
}

.search-btn,
.search-clear {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  padding: 0;
  border-radius: var(--radius-full);
  cursor: pointer;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color var(--transition-fast), background var(--transition-fast), scale var(--ui-motion-fast) var(--ui-motion-ease);
}

.search-btn svg,
.search-clear svg {
  width: 16px;
  height: 16px;
}

.search-btn:hover:not(:disabled),
.search-clear:hover {
  color: var(--color-text);
  background: var(--bg-hover);
}

.search-btn:focus-visible,
.search-clear:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.search-btn:disabled {
  cursor: default;
}

.search-hint {
  flex: 0 0 24px;
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
  line-height: 1;
  pointer-events: none;
}

.window-controls {
  grid-column: 3;
  justify-self: end;
  display: flex;
  height: 100%;
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}

.control-btn {
  width: var(--titlebar-btn-width);
  height: 100%;
  border: none;
  background: transparent;
  outline: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--titlebar-icon-color);
  cursor: pointer;
  transition: all var(--transition-base);
}

.control-btn svg {
  transition: all var(--transition-base);
  transform: scale(1);
}

.control-btn .icon {
  width: 18px;
  height: 18px;
  transition: all var(--transition-base);
  transform: scale(1);
  filter: var(--titlebar-icon-filter);
}

.control-btn:hover .icon {
  transform: scale(1.15);
  filter: var(--titlebar-icon-hover-filter);
}

.control-btn.close:hover {
  color: var(--color-on-primary);
}

.control-btn.close:hover .icon {
  transform: scale(1.2);
  filter: var(--titlebar-close-icon-filter);
}

/* 登录按钮样式 */
.login-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 0 var(--spacing-md);
  min-width: auto;
  width: auto;
}

.login-btn .icon {
  width: 16px;
  height: 16px;
}

.login-text {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  transition: color var(--transition-base), scale var(--ui-motion-fast) var(--ui-motion-ease);
}

.login-btn:hover .login-text {
  color: var(--color-text);
}

.login-btn:hover .icon {
  transform: scale(1.1);
  filter: var(--titlebar-icon-hover-filter);
}

/* 用户信息样式 */
.user-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-md);
  cursor: pointer;
  transition: all var(--transition-base);
  border-radius: var(--radius-sm);
  margin-right: var(--spacing-xs);
  -webkit-app-region: no-drag;
}

.user-info:hover {
  background: var(--titlebar-btn-hover);
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-background-lighter);
  border: 2px solid var(--color-border);
  transition: all var(--transition-base);
}

.user-info:hover .user-avatar {
  border-color: var(--color-primary);
  transform: scale(1.05);
}

.user-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.user-avatar .default-avatar {
  width: 20px;
  height: 20px;
  color: var(--color-text-secondary);
}

.user-name {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--transition-base), scale var(--ui-motion-fast) var(--ui-motion-ease);
}

.user-info:hover .user-name {
  color: var(--color-text);
}

/* 垂直分割线 */
.divider-vertical {
  width: 1px;
  height: 60%;
  background-color: var(--color-border);
  margin: 0 var(--spacing-sm);
}

@media (max-width: 900px) {
  .user-name { display: none; }
}

@media (max-width: 700px) {
  .title-bar { column-gap: var(--spacing-sm); }
  .logo-container { min-width: 0; }
  .app-name { display: none; }
  .search-hint { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .search-box,
  .search-btn,
  .search-clear { transition: none; }
}
</style>
