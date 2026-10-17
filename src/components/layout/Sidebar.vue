<template>
  <div class="sidebar-space" :class="{ 'sidebar-hidden': isHidden }" @keydown.esc="handleEscape" @focusout="handleWrapperFocusOut">
    <nav
      id="sidebar-navigation"
      ref="sidebar"
      class="sidebar-container"
      :class="{ expanded: isExpanded, 'is-hidden': isHidden }"
      aria-label="主导航"
      :inert="isHidden"
      :aria-hidden="isHidden || undefined"
      @mouseenter="handleMouseEnter"
      @mouseleave="handleMouseLeave"
      @focusin="handleFocusIn"
      @focusout="handleFocusOut"
    >
      <div class="sidebar-top">
        <button type="button" class="sidebar-item" data-sidebar-item="hide" aria-label="收起侧边栏" aria-controls="sidebar-navigation" :aria-expanded="!isHidden" title="收起侧边栏" @click="handleCollapse">
          <span class="sidebar-icon-wrapper"><span class="sidebar-icon" :style="iconStyle(icons.hide)" aria-hidden="true"></span></span>
          <Transition name="sidebar-label"><span v-show="isExpanded" class="sidebar-label">隐藏</span></Transition>
        </button>
        <div class="sidebar-divider" role="separator"></div>
        <button type="button" class="sidebar-item" :class="{ active: activeItem === 'home' }" data-sidebar-item="home" aria-label="主页" :aria-current="activeItem === 'home' ? 'page' : undefined" title="主页" @click="handleItemClick('home')">
          <span class="sidebar-icon-wrapper"><span class="sidebar-icon" :style="iconStyle(icons.home)" aria-hidden="true"></span></span>
          <Transition name="sidebar-label"><span v-show="isExpanded" class="sidebar-label">主页</span></Transition>
        </button>
        <div class="sidebar-divider" role="separator"></div>
      </div>

      <div class="sidebar-scrollable" @scroll="updateIndicator">
        <button type="button" class="sidebar-item" :class="{ active: activeItem === 'favorite', 'requires-login': !userLoggedIn }" data-sidebar-item="favorite" aria-label="我喜欢" :aria-current="activeItem === 'favorite' ? 'page' : undefined" :title="userLoggedIn ? '我喜欢' : '我喜欢（需要登录）'" @click="handleItemClick('favorite')">
          <span class="sidebar-icon-wrapper"><span class="sidebar-icon" :style="iconStyle(icons.favorite)" aria-hidden="true"></span></span>
          <Transition name="sidebar-label"><span v-show="isExpanded" class="sidebar-label">我喜欢</span></Transition>
        </button>
        <template v-if="userLoggedIn">
          <button v-for="playlist in playlists" :key="playlist.id" type="button" class="sidebar-item" :class="{ active: activeItem === `playlist-${playlist.id}` }" :data-sidebar-item="`playlist-${playlist.id}`" :aria-label="playlist.name" :aria-current="activeItem === `playlist-${playlist.id}` ? 'page' : undefined" :title="playlist.name" @click="handleItemClick(`playlist-${playlist.id}`, playlist)">
            <span class="sidebar-icon-wrapper"><span class="sidebar-icon" :style="iconStyle(icons.list)" aria-hidden="true"></span></span>
            <Transition name="sidebar-label"><span v-show="isExpanded" class="sidebar-label">{{ playlist.name }}</span></Transition>
          </button>
          <button type="button" class="sidebar-item sidebar-create" data-sidebar-item="create-playlist" aria-label="新建歌单" title="新建歌单" @click="handleCreatePlaylist">
            <span class="sidebar-icon-wrapper"><span class="sidebar-icon" :style="iconStyle(icons.add)" aria-hidden="true"></span></span>
            <Transition name="sidebar-label"><span v-show="isExpanded" class="sidebar-label">新建歌单</span></Transition>
          </button>
        </template>
      </div>

      <div class="sidebar-divider" role="separator"></div>
      <div class="sidebar-bottom">
        <button ref="accountButton" type="button" class="sidebar-item" :class="{ active: activeItem === 'account' }" data-sidebar-item="account" aria-label="账号" :aria-current="activeItem === 'account' ? 'page' : undefined" :aria-expanded="userMenuVisible" title="账号" @click="handleAccountClick">
          <span class="sidebar-icon-wrapper"><img :src="avatarUrl" class="sidebar-icon-img user-avatar-icon" alt="" @error="avatarFailed = true" /></span>
          <Transition name="sidebar-label"><span v-show="isExpanded" class="sidebar-label">账号</span></Transition>
        </button>
        <button type="button" class="sidebar-item" :class="{ active: activeItem === 'settings' }" data-sidebar-item="settings" aria-label="设置" :aria-current="activeItem === 'settings' ? 'page' : undefined" title="设置" @click="handleSettingsClick">
          <span class="sidebar-icon-wrapper"><span class="sidebar-icon" :style="iconStyle(icons.settings)" aria-hidden="true"></span></span>
          <Transition name="sidebar-label"><span v-show="isExpanded" class="sidebar-label">设置</span></Transition>
        </button>
      </div>
      <div class="active-indicator-slider" :style="indicatorStyle" aria-hidden="true"></div>
    </nav>

    <Transition name="ui-pop" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><button v-if="isHidden" ref="restoreButton" type="button" class="sidebar-restore" aria-label="展开侧边栏" aria-controls="sidebar-navigation" aria-expanded="false" title="展开侧边栏" @click="handleRestore">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
    </button></Transition>

    <UserMenu
      ref="userMenu"
      :visible="userMenuVisible"
      :user-info="userInfo || {}"
      :position="userMenuPosition"
      @close="closeUserMenu"
      @open-settings="handleSettingsClick"
      @logout="handleLogout"
      @edit-profile="$emit('edit-profile')"
    />
  </div>
</template>

<script>
import { logger } from '../../utils/logger.js'
import UserMenu from './UserMenu.vue'
import hideIcon from '../../assets/icons/sidebar-hide.svg'
import homeIcon from '../../assets/icons/sidebar-home.svg'
import listIcon from '../../assets/icons/sidebar-list.svg'
import settingsIcon from '../../assets/icons/sidebar-settings.svg'
import favoriteIcon from '../../assets/icons/sidebar-favorite.svg'
import addIcon from '../../assets/icons/sidebar-add.svg'

export default {
  name: 'Sidebar',
  components: { UserMenu },
  emits: ['navigate', 'create-playlist', 'show-login', 'open-settings', 'logout', 'edit-profile'],
  props: {
    playlists: { type: Array, default: () => [] },
    currentView: { type: String, default: 'home' },
    selectedPlaylistId: { type: [String, Number], default: null },
    userLoggedIn: { type: Boolean, default: false },
    userInfo: { type: Object, default: null }
  },
  data() {
    return {
      icons: { hide: hideIcon, home: homeIcon, list: listIcon, settings: settingsIcon, favorite: favoriteIcon, add: addIcon },
      isExpanded: false,
      isHidden: false,
      hoverTimer: null,
      indicatorFrame: null,
      indicatorTop: -100,
      disposed: false,
      userMenuVisible: false,
      userMenuPosition: { top: 12, right: 12 },
      avatarFailed: false
    }
  },
  computed: {
    activeItem() {
      if (this.userMenuVisible || this.currentView === 'login' || this.currentView === 'account') return 'account'
      if (this.currentView === 'playlist' && this.selectedPlaylistId != null) return `playlist-${this.selectedPlaylistId}`
      return ['home', 'favorite', 'settings'].includes(this.currentView) ? this.currentView : null
    },
    indicatorStyle() {
      return { top: `${this.indicatorTop}px`, opacity: this.indicatorTop < 0 ? 0 : 1 }
    },
    avatarUrl() {
      return (!this.avatarFailed && this.userInfo?.avatar) || `${import.meta.env.BASE_URL}logo.png`
    }
  },
  watch: {
    activeItem: { handler: 'updateIndicator', flush: 'post' },
    playlists: { handler: 'updateIndicator', deep: true, flush: 'post' },
    'userInfo.avatar'() { this.avatarFailed = false },
    userLoggedIn(loggedIn) {
      if (!loggedIn) this.closeUserMenu()
      this.updateIndicator()
    }
  },
  mounted() {
    this.updateIndicator()
    window.addEventListener('resize', this.handleResize)
  },
  beforeUnmount() {
    this.disposed = true
    clearTimeout(this.hoverTimer)
    if (this.indicatorFrame != null) cancelAnimationFrame(this.indicatorFrame)
    window.removeEventListener('resize', this.handleResize)
  },
  methods: {
    iconStyle(url) { return { '--sidebar-icon-url': `url("${url}")` } },

    /** 在布局与滚动更新后定位唯一指示条，滚出歌单可视区的选中项不显示指示条。 */
    updateIndicator() {
      this.$nextTick(() => {
        if (this.disposed) return
        if (this.indicatorFrame != null) cancelAnimationFrame(this.indicatorFrame)
        this.indicatorFrame = requestAnimationFrame(() => {
          this.indicatorFrame = null
          const sidebar = this.$refs.sidebar
          if (this.disposed || !sidebar) return
          const item = sidebar.querySelector('.sidebar-item.active')
          if (!item) { this.indicatorTop = -100; return }
          const itemRect = item.getBoundingClientRect()
          const containerRect = sidebar.getBoundingClientRect()
          const scrollRect = item.closest('.sidebar-scrollable')?.getBoundingClientRect()
          const center = itemRect.top + itemRect.height / 2
          this.indicatorTop = scrollRect && (center < scrollRect.top || center > scrollRect.bottom)
            ? -100 : center - containerRect.top - sidebar.clientTop - 10
        })
      })
    },

    handleMouseEnter() {
      if (this.isHidden) return
      clearTimeout(this.hoverTimer)
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null
        if (!this.disposed && !this.isHidden) this.isExpanded = true
      }, 300)
    },
    handleMouseLeave() {
      clearTimeout(this.hoverTimer)
      this.hoverTimer = null
      if (!this.userMenuVisible) this.isExpanded = false
    },
    /** 将整条浮栏移出左侧并释放内容空间，焦点转交给唯一保留的展开按钮。 */
    handleCollapse() {
      this.closeUserMenu()
      this.isHidden = true
      this.isExpanded = false
      clearTimeout(this.hoverTimer)
      this.hoverTimer = null
      this.$nextTick(() => {
        if (!this.disposed && this.isHidden) this.$refs.restoreButton?.focus({ preventScroll: true })
      })
    },
    /** 保留当前导航与歌单状态，恢复后将键盘焦点交还当前导航项。 */
    handleRestore() {
      this.isHidden = false
      this.$nextTick(() => {
        if (this.disposed || this.isHidden) return
        const sidebar = this.$refs.sidebar
        const target = sidebar?.querySelector('.sidebar-item.active') || sidebar?.querySelector('.sidebar-item')
        target?.focus({ preventScroll: true })
        this.updateIndicator()
      })
    },
    handleEscape() {
      if (this.userMenuVisible && this.$refs.userMenu?.$refs.menu?.contains(document.activeElement)) {
        this.$refs.accountButton?.focus({ preventScroll: true })
      }
      this.closeUserMenu()
      this.isExpanded = false
      clearTimeout(this.hoverTimer)
      this.hoverTimer = null
    },
    handleFocusIn() {
      if (this.isHidden) return
      clearTimeout(this.hoverTimer)
      this.isExpanded = true
    },
    handleFocusOut(event) {
      if (!this.$refs.sidebar?.contains(event.relatedTarget)) this.handleMouseLeave()
    },
    handleWrapperFocusOut(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) this.closeUserMenu()
    },

    handleItemClick(itemId, playlist = null) {
      if (this.disposed) return
      this.closeUserMenu()
      if (!this.userLoggedIn && itemId !== 'home') {
        this.$emit('show-login')
        return
      }
      if (itemId.startsWith('playlist-') && playlist) this.$emit('navigate', 'playlist', playlist)
      else this.$emit('navigate', itemId)
      logger.trace('Sidebar', '切换导航入口', { itemId })
    },
    handleCreatePlaylist() {
      if (this.userLoggedIn) this.$emit('create-playlist')
    },
    handleAccountClick() {
      if (!this.userLoggedIn) {
        this.$emit('show-login')
        return
      }
      this.userMenuVisible = !this.userMenuVisible
      if (this.userMenuVisible) this.positionUserMenu()
      else this.closeUserMenu()
    },

    /** 沿用账号菜单并按真实尺寸贴靠浮栏，靠近窗口边缘时夹紧到可视范围。 */
    positionUserMenu() {
      this.$nextTick(() => {
        if (this.disposed || !this.userMenuVisible) return
        const menu = this.$refs.userMenu?.$refs.menu
        const sidebar = this.$refs.sidebar
        const account = this.$refs.accountButton
        if (!menu || !sidebar || !account) return
        const sidebarRect = sidebar.getBoundingClientRect()
        const expandedWidth = Number.parseFloat(window.getComputedStyle(sidebar).getPropertyValue('--sidebar-expanded-width'))
        const left = sidebarRect.left + (this.isExpanded ? expandedWidth : sidebarRect.width) + 12
        const playerTop = document.querySelector('.music-player')?.getBoundingClientRect().top ?? window.innerHeight
        this.userMenuPosition = {
          top: Math.max(12, Math.min(account.getBoundingClientRect().top, playerTop - menu.offsetHeight - 12)),
          right: Math.max(12, window.innerWidth - left - menu.offsetWidth)
        }
      })
    },
    closeUserMenu() {
      this.userMenuVisible = false
      if (!this.$refs.sidebar?.matches(':hover') && !this.$refs.sidebar?.contains(document.activeElement)) {
        this.handleMouseLeave()
      }
    },
    handleSettingsClick() {
      this.closeUserMenu()
      this.$emit('open-settings')
    },
    handleLogout() {
      this.closeUserMenu()
      this.$emit('logout')
    },
    handleResize() {
      this.updateIndicator()
      if (this.userMenuVisible) this.positionUserMenu()
    }
  }
}
</script>

<style src="./Sidebar.css" scoped></style>
