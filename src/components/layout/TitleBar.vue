<template>
  <div class="title-bar" :class="{ 'lyric-mode': isLyricViewVisible }">
    <!-- Logo区域 -->
    <div class="logo-container">
      <img src="/logo.png" alt="Logo" class="logo-icon" />
      <span class="app-name">BETTERKUGOU</span>
    </div>
    
    <!-- 左侧拖拽区域 -->
    <div class="drag-area-left">
      <!-- 可拖动区域 -->
    </div>
    
    <!-- 搜索框（居中） -->
    <div class="search-container">
      <div class="search-box">
        <input 
          ref="searchInput"
          v-model="searchKeyword" 
          type="text" 
          placeholder="搜索"
          @keyup.enter="performSearch"
          @focus="isSearchFocused = true"
          @blur="isSearchFocused = false"
        />
        <button class="search-btn" @click="performSearch" :disabled="!searchKeyword.trim()">
          <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
            <path d="M909.6 854.5L649.9 594.8C690.2 542.7 712 479 712 412c0-80.2-31.3-155.4-87.9-212.1-56.6-56.7-132-87.9-212.1-87.9s-155.5 31.3-212.1 87.9C143.2 256.5 112 331.8 112 412c0 80.1 31.3 155.5 87.9 212.1C256.5 680.8 331.8 712 412 712c67 0 130.6-21.8 182.7-62l259.7 259.6a8.2 8.2 0 0011.6 0l43.6-43.5a8.2 8.2 0 000-11.6zM570.4 570.4C528 612.7 471.8 636 412 636s-116-23.3-158.4-65.6C211.3 528 188 471.8 188 412s23.3-116.1 65.6-158.4C296 211.3 352.2 188 412 188s116.1 23.3 158.4 65.6S636 352.2 636 412s-23.3 116.1-65.6 158.4z"/>
          </svg>
        </button>
      </div>
    </div>
    
    <!-- 右侧拖拽区域 -->
    <div class="drag-area-right">
      <!-- 可拖动区域 -->
    </div>
    
    <div class="window-controls">
      <!-- 用户信息或登录按钮 -->
      <div v-if="userLoggedIn && userInfo" ref="userInfoBtn" class="user-info" @click.stop="handleUserClick">
        <div class="user-avatar">
          <img v-if="userInfo.avatar" :src="userInfo.avatar" alt="头像" />
          <svg v-else class="default-avatar" viewBox="0 0 1024 1024">
            <path d="M512 512m-512 0a512 512 0 1 0 1024 0 512 512 0 1 0-1024 0Z" fill="currentColor" opacity=".2"></path>
            <path d="M512 640c-70.692 0-128-57.308-128-128s57.308-128 128-128 128 57.308 128 128-57.308 128-128 128z m0-192c-35.346 0-64 28.654-64 64s28.654 64 64 64 64-28.654 64-64-28.654-64-64-64z m256 448H256c-17.673 0-32-14.327-32-32 0-123.514 100.486-224 224-224h96c123.514 0 224 100.486 224 224 0 17.673-14.327 32-32 32z m-479.967-64h447.935c-13.547-77.612-81.232-137.036-159.968-137.036h-96c-78.736 0-146.421 59.424-159.967 137.036z" fill="currentColor"></path>
          </svg>
        </div>
        <span class="user-name">{{ userInfo.username || '用户' }}</span>
      </div>
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
        <img :src="isMaximized ? icons.restore : icons.maximize" alt="最大化" class="icon" />
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
  props: {
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
      searchKeyword: '',
      isSearchFocused: false,
      // 图标路径配置 - 如需替换图标,只需修改这里的路径
      icons: {
        minimize: minimizeIcon,
        maximize: maximizeIcon,
        restore: restoreIcon,
        close: closeIcon
      }
    }
  },
  watch: {
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
    performSearch() {
      const keyword = this.searchKeyword.trim()
      if (!keyword) {
        logger.trace('TitleBar', '搜索关键词为空')
        return
      }
      logger.trace('TitleBar', '执行搜索:', keyword)
      // 发射搜索事件到父组件
      this.$emit('search', keyword)
      // 清空搜索框并失去焦点
      // this.searchKeyword = ''
      // this.$refs.searchInput.blur()
    }
  }
}
</script>

<style scoped>
.title-bar {
  height: var(--titlebar-height);
  background: var(--color-background);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
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
  display: none !important;
}

.title-bar.lyric-mode .logo-container {
  opacity: 0.3;
}

/* Logo容器 */
.logo-container {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-md);
  -webkit-app-region: no-drag;
  transition: opacity 0.3s ease;
  flex-shrink: 0;
  min-width: 200px;
}

.logo-icon {
  width: 24px;
  height: 24px;
  object-fit: contain;
  transition: transform 0.3s ease;
}

.logo-icon:hover {
  transform: scale(1.05);
}

.app-name {
  font-size: var(--font-size-sm);
  font-weight: 700;
  color: var(--color-text);
  letter-spacing: 0.5px;
  user-select: none;
  transition: color 0.3s ease;
}

/* 拖拽区域 */
.drag-area-left,
.drag-area-right {
  flex: 1;
  height: 100%;
  min-width: 0;
}

/* 搜索容器 */
.search-container {
  -webkit-app-region: no-drag;
  transition: opacity 0.3s ease;
  display: flex;
  justify-content: center;
  flex-shrink: 0;
  min-width: 300px;
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}

.search-box {
  display: flex;
  align-items: center;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  width: 280px;
  transition: all 0.3s ease;
}

.search-box:hover {
  background: var(--bg-hover-light);
  border-color: var(--color-text-tertiary);
}

.search-box:focus-within {
  background: var(--color-background-lighter);
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.search-box input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: var(--spacing-sm) var(--spacing-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  height: 32px;
}

.search-box input::placeholder {
  color: var(--color-text-tertiary);
  opacity: 0.7;
  transition: opacity 0.3s ease;
}

.search-box:focus-within input::placeholder {
  opacity: 0.9;
}

.search-btn {
  background: transparent;
  border: none;
  padding: var(--spacing-sm);
  cursor: pointer;
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  height: 32px;
  width: 32px;
}

.search-btn:hover:not(:disabled) {
  color: var(--color-primary);
  background: var(--bg-hover);
}

.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}



.window-controls {
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
  transition: color var(--transition-base);
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
  transition: color var(--transition-base);
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
</style>
