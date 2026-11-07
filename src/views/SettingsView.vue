<template>
  <div class="settings-view" @focusout="flushPendingOnBlur">
    <header class="settings-toolbar">
      <div class="settings-title"><h1>设置</h1><p>按你的习惯，听喜欢的音乐。</p></div>
      <div class="settings-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input ref="searchInput" v-model="searchQuery" type="search" aria-label="搜索设置" placeholder="搜索设置，如音质、字体、缓存" autocomplete="off" @focus="stopEditingShortcut" @keydown.esc.prevent="clearSearch" />
        <button v-if="searchQuery" type="button" aria-label="清空设置搜索" @click="clearSearch">×</button>
      </div>
      <span v-if="saveState === 'pending' || saveState === 'saving'" class="save-status" :class="'is-' + saveState" role="status" aria-live="polite"><Transition name="ui-fade" mode="out-in"><span :key="saveState">{{ saveStatusText }}</span></Transition></span>
    </header>
    <AppNotice :message="settingsSaveError" title="设置保存失败" type="error" :actions="[{ label: '重试保存', run: flushEditableSettings, disabled: saveState === 'saving' }]" />
    <AppNotice :message="saveState === 'saved' && settingsSaveRevision ? '所有更改已保存' : ''" type="success" :revision="settingsSaveRevision" />
    <AppNotice :message="actionMessage" :type="actionMessageType" :revision="actionMessageRevision" @close="actionMessage = ''" />
    <div class="settings-body">
      <aside class="settings-sidebar">
        <nav class="sidebar-nav" aria-label="设置分组">
          <div v-for="group in navigationGroups" :key="group.label" class="nav-group">
            <p class="nav-group-label">{{ group.label }}</p>
            <button v-for="section in group.sections" :key="section.id" type="button" :class="['sidebar-item', { active: activeSection === section.id && !isSearching }]" :aria-current="activeSection === section.id && !isSearching ? 'page' : undefined" :aria-controls="section.id + '-section'" @click="scrollToSection(section.id)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="section.icon" /></svg>
              <span>{{ section.label }}</span>
            </button>
          </div>
        </nav>
        <div class="sidebar-logo"><img src="/logo.png" alt=""><div>BetterKuGou<span>v{{ appVersion }}</span></div></div>
      </aside>
      <main class="settings-main" ref="settingsMain" aria-label="应用设置">
        <section v-if="isSearching" class="settings-results" aria-labelledby="settings-results-heading">
          <header class="section-header"><div><p class="eyebrow">查找偏好</p><h2 id="settings-results-heading">搜索设置</h2><p role="status">找到 {{ searchResults.length }} 个相关分区</p></div></header>
          <button v-for="result in searchResults" :key="result.id" class="settings-result" type="button" @click="openSearchResult(result)">
            <span class="result-category">{{ result.group }}</span><strong>{{ result.label }}</strong><span class="result-matches">{{ result.matches.map(match => match.label).slice(0, 4).join(' · ') || result.description }}</span><span class="result-arrow" aria-hidden="true">→</span>
          </button>
          <div v-if="!searchResults.length" class="settings-empty"><span aria-hidden="true">⌕</span><h3>没有找到相关设置</h3><p>试试“歌词”“颜色”或“快捷键”，也可以从分类中查找。</p><button class="outline-btn" type="button" @click="clearSearch">返回设置</button></div>
        </section>

        <section class="settings-section" id="playback-section" :ref="sectionRefs.playback" data-section="playback" :hidden="!isSectionVisible('playback')" :inert="!isSectionVisible('playback')" :class="{ 'is-active': isSectionVisible('playback') }" aria-labelledby="playback-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="playback-heading" tabindex="-1">播放</h2><p>音质、播放队列与聆听习惯。</p></div></header>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="preferred-quality">优先音质</label><p class="setting-desc">后续歌曲优先使用所选音质；当前歌曲可在播放栏快速切换。可用音质取决于歌曲与账号权限。</p></div><AnimatedSelect id="preferred-quality" class="setting-select" v-model="localSettings.playback.quality" label="优先音质" :options="qualityOptions" /></div>
          <div v-for="option in playbackOptions" :key="option.id" class="setting-item">
            <div class="setting-info"><label class="setting-label" :for="'playback-' + option.id">{{ option.label }}</label><p class="setting-desc" :id="'playback-' + option.id + '-desc'">{{ option.description }}</p></div>
            <label class="setting-switch"><input :id="'playback-' + option.id" type="checkbox" v-model="localSettings.playback[option.id]" :aria-describedby="'playback-' + option.id + '-desc'"><span class="slider"></span></label>
          </div>
        </section>

        <section class="settings-section" id="audioEffects-section" :ref="sectionRefs.audioEffects" data-section="audioEffects" :hidden="!isSectionVisible('audioEffects')" :inert="!isSectionVisible('audioEffects')" :class="{ 'is-active': isSectionVisible('audioEffects') }" aria-labelledby="audioEffects-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="audioEffects-heading" tabindex="-1">音频效果</h2><p>用 VST3 效果器和分析工具调整你的聆听体验。</p></div></header>
          <AudioEffectsSettings :before-action="flushEditableSettings" :inert="isImporting" />
        </section>

        <section class="settings-section" id="lyrics-section" :ref="sectionRefs.lyrics" data-section="lyrics" :hidden="!isSectionVisible('lyrics')" :inert="!isSectionVisible('lyrics')" :class="{ 'is-active': isSectionVisible('lyrics') }" aria-labelledby="lyrics-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="lyrics-heading" tabindex="-1">歌词内容</h2><p>翻译、文字偏好与已保存的歌词。</p></div></header>
          <LyricSettings ref="lyricSettingsRef" v-model="localSettings.playback" :before-action="flushEditableSettings" :inert="isImporting" />
        </section>

        <section class="settings-section" id="fullscreen-section" :ref="sectionRefs.fullscreen" data-section="fullscreen" :hidden="!isSectionVisible('fullscreen')" :inert="!isSectionVisible('fullscreen') || isImporting" :class="{ 'is-active': isSectionVisible('fullscreen') }" aria-labelledby="fullscreen-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="fullscreen-heading" tabindex="-1">全屏歌词</h2><p>调整播放界面的歌词、控件和背景。</p></div></header>
          <div v-for="option in fullscreenLyricToggles" :key="option.key" class="setting-item">
            <div class="setting-info">
              <label class="setting-label" :for="option.id">{{ option.label }}</label>
              <p class="setting-desc" :id="option.id + '-desc'">{{ option.description }}</p>
            </div>
            <label class="setting-switch">
              <input :id="option.id" type="checkbox" v-model="localSettings.fullscreenLyrics[option.key]" :aria-describedby="option.id + '-desc'">
              <span class="slider"></span>
            </label>
          </div>
          <div class="setting-item" :class="{ 'setting-range-disabled': !localSettings.fullscreenLyrics.blurEnabled }">
            <div class="setting-info">
              <label class="setting-label" for="fullscreen-blur-percent">模糊强度</label>
              <p class="setting-desc" id="fullscreen-blur-percent-desc">开启歌词模糊后可调，0% 为清晰。</p>
            </div>
            <div class="setting-range">
              <input id="fullscreen-blur-percent" type="range" min="0" max="100" step="1"
                v-model.number="localSettings.fullscreenLyrics.blurPercent" :disabled="!localSettings.fullscreenLyrics.blurEnabled"
                :aria-valuetext="localSettings.fullscreenLyrics.blurPercent + '%'" aria-describedby="fullscreen-blur-percent-desc">
              <output for="fullscreen-blur-percent">{{ localSettings.fullscreenLyrics.blurPercent }}%</output>
            </div>
          </div>
          <AnimatedDetails class="settings-disclosure">
            <template #summary><span>歌词位置与字体</span></template>
            <div class="setting-item">
              <div class="setting-info"><label class="setting-label" for="fullscreen-position">歌词位置</label></div>
              <AnimatedSelect id="fullscreen-position" class="setting-select" v-model="localSettings.fullscreenLyrics.position"
                label="歌词位置" :options="fullscreenLyricPositions" />
            </div>
            <div v-for="option in fullscreenLyricRanges" :key="option.key" class="setting-item">
              <div class="setting-info"><label class="setting-label" :for="option.id">{{ option.label }}</label></div>
              <div class="setting-range">
                <input :id="option.id" type="range" :min="option.min" :max="option.max" step="1"
                  v-model.number="localSettings.fullscreenLyrics[option.key]" :aria-valuetext="localSettings.fullscreenLyrics[option.key] + ' 像素'">
                <output :for="option.id">{{ localSettings.fullscreenLyrics[option.key] }} px</output>
              </div>
            </div>
            <div class="setting-item">
              <div class="setting-info">
                <label class="setting-label" for="fullscreen-font-family">歌词字体</label>
                <p class="setting-desc" id="fullscreen-font-family-desc">输入本机已安装的字体名称，留空使用默认字体。</p>
              </div>
              <input id="fullscreen-font-family" class="setting-font-input" type="text" maxlength="100"
                v-model.lazy="localSettings.fullscreenLyrics.fontFamily" placeholder="默认字体" aria-describedby="fullscreen-font-family-desc">
            </div>
          </AnimatedDetails>
          <AnimatedDetails class="settings-disclosure">
            <template #summary><span>歌词背景</span></template>
            <div class="setting-item">
              <div class="setting-info"><label class="setting-label" for="fullscreen-background-mode">背景模式</label></div>
              <AnimatedSelect id="fullscreen-background-mode" class="setting-select" v-model="localSettings.fullscreenLyrics.backgroundMode"
                label="背景模式" :options="fullscreenBackgroundModes" />
            </div>
            <BackgroundImageSetting id="fullscreen-background-image" :model-value="localSettings.fullscreenLyrics.backgroundImage"
              label="自定义背景图片" description="选择图片后切换到自定义图片模式。" :disabled="isImporting"
              @update:model-value="setFullscreenBackgroundImage" />
            <div class="setting-item">
              <div class="setting-info">
                <label class="setting-label" for="fullscreen-background-motion">背景动态</label>
                <p class="setting-desc" id="fullscreen-background-motion-desc">鼓点跳动随音乐节奏起伏，流沙让背景缓慢流动。</p>
              </div>
              <AnimatedSelect id="fullscreen-background-motion" class="setting-select" v-model="localSettings.fullscreenLyrics.backgroundMotion"
                label="背景动态" :options="fullscreenBackgroundMotions" aria-describedby="fullscreen-background-motion-desc" />
            </div>
          </AnimatedDetails>
        </section>

        <section class="settings-section" id="desktop-section" :ref="sectionRefs.desktop" data-section="desktop" :hidden="!isSectionVisible('desktop')" :inert="!isSectionVisible('desktop')" :class="{ 'is-active': isSectionVisible('desktop') }" aria-labelledby="desktop-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="desktop-heading" tabindex="-1">桌面歌词</h2><p>在桌面上跟随每一句，自由调整显示方式。</p></div></header>
          <DesktopLyricSettings v-model="localSettings.desktopLyrics" :before-action="flushEditableSettings" />
        </section>

        <section class="settings-section" id="island-section" :ref="sectionRefs.island" data-section="island" :hidden="!isSectionVisible('island')" :inert="!isSectionVisible('island')" :class="{ 'is-active': isSectionVisible('island') }" aria-labelledby="island-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="island-heading" tabindex="-1">灵动岛歌词</h2><p>屏幕上沿的音乐陪伴，也可以自由浮动。</p></div></header>
          <IslandLyricSettings v-model="localSettings.islandLyrics" :before-action="flushEditableSettings" :available="islandLyricsAvailable" />
        </section>

        <section class="settings-section" id="taskbar-section" :ref="sectionRefs.taskbar" data-section="taskbar" :hidden="!isSectionVisible('taskbar')" :inert="!isSectionVisible('taskbar')" :class="{ 'is-active': isSectionVisible('taskbar') }" aria-labelledby="taskbar-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="taskbar-heading" tabindex="-1">任务栏歌词</h2><p>把歌词和播放控制留在 Windows 任务栏。</p></div></header>
          <TaskbarLyricSettings v-model="localSettings.taskbarLyrics" :before-action="flushEditableSettings" :available="taskbarLyricsAvailable" />
        </section>

        <section class="settings-section" id="custom-section" :ref="sectionRefs.custom" data-section="custom" :hidden="!isSectionVisible('custom')" :inert="!isSectionVisible('custom')" :class="{ 'is-active': isSectionVisible('custom') }" aria-labelledby="custom-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="custom-heading" tabindex="-1">外观与主题</h2><p>播放器布局、主题配色与界面细节。</p></div></header>
          <fieldset class="setting-item setting-item--column"><legend class="setting-label">播放器样式</legend><p class="setting-desc">在底部显示经典播放栏，或轻盈的悬浮胶囊。</p><div class="radio-group"><label class="radio-option"><input type="radio" value="default" v-model="localSettings.custom.playerStyle"><span class="radio-option__display">经典播放栏<span>BetterKuGou 默认</span></span></label><label class="radio-option"><input type="radio" value="netease" v-model="localSettings.custom.playerStyle"><span class="radio-option__display">悬浮胶囊<span>网易云样式</span></span></label></div></fieldset>
          <div class="setting-group"><h3>主题与配色</h3><ThemePackages v-model="localSettings.custom" /></div>
          <Transition name="ui-fade" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false"><div v-if="localSettings.custom.theme === 'custom'" class="custom-color-panel"><label v-for="color in customColors" :key="color.id" class="color-setting"><span>{{ color.label }}</span><input type="color" v-model="localSettings.custom.customTheme[color.id]"></label></div></Transition>
          <AnimatedDetails class="settings-disclosure"><template #summary><span>界面精调与高级编辑</span></template><ThemeAdjustments v-model="localSettings.custom" @open-studio="openThemeStudio" /></AnimatedDetails>
        </section>

        <section class="settings-section" id="shortcuts-section" :ref="sectionRefs.shortcuts" data-section="shortcuts" :hidden="!isSectionVisible('shortcuts')" :inert="!isSectionVisible('shortcuts')" :class="{ 'is-active': isSectionVisible('shortcuts') }" aria-labelledby="shortcuts-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="shortcuts-heading" tabindex="-1">快捷键</h2><p>用熟悉的按键，快速控制音乐。</p></div></header>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="enable-global">启用全局快捷键</label><p class="setting-desc" id="enable-global-desc">切换到其他应用后，也能控制音乐播放。</p></div><label class="setting-switch"><input id="enable-global" type="checkbox" v-model="localSettings.shortcuts.enableGlobal" aria-describedby="enable-global-desc"><span class="slider"></span></label></div>
          <div class="shortcut-grid"><div v-for="shortcut in shortcutList" :key="shortcut.id" class="shortcut-card" :class="{ 'is-editing': editingShortcut === shortcut.id, 'has-error': shortcutErrors[shortcut.id] }"><div class="shortcut-info"><div class="shortcut-label">{{ shortcut.label }}</div><div class="shortcut-desc">{{ shortcut.description }}</div></div><div class="shortcut-key-wrapper"><button type="button" class="shortcut-key" :aria-label="shortcut.label + '快捷键：' + formatShortcutKey(localSettings.shortcuts.keys[shortcut.id])" :aria-pressed="editingShortcut === shortcut.id" @click="startEditingShortcut(shortcut.id)"><Transition name="ui-fade" mode="out-in"><span v-if="editingShortcut === shortcut.id" key="recording" class="recording">按下按键…</span><span v-else :key="localSettings.shortcuts.keys[shortcut.id]">{{ formatShortcutKey(localSettings.shortcuts.keys[shortcut.id]) }}</span></Transition></button><Transition name="ui-pop"><button v-if="localSettings.shortcuts.keys[shortcut.id] && localSettings.shortcuts.keys[shortcut.id] !== 'Escape'" type="button" class="clear-shortcut-btn" :aria-label="'清除' + shortcut.label + '快捷键'" @click="clearShortcut(shortcut.id)">×</button></Transition></div><AppNotice :message="shortcutErrors[shortcut.id]" :title="shortcut.label + '快捷键'" type="error" :revision="shortcutErrorRevision" /></div></div>
          <p class="note-text">点击按键后输入新组合；按 Esc 清除绑定。相同组合不能重复绑定。</p>
        </section>

        <section class="settings-section" id="download-section" :ref="sectionRefs.download" data-section="download" :hidden="!isSectionVisible('download')" :inert="!isSectionVisible('download')" :class="{ 'is-active': isSectionVisible('download') }" aria-labelledby="download-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="download-heading" tabindex="-1">下载与缓存</h2><p>管理听过的音乐、存储空间与缓存位置。</p></div></header>
          <PlaylistCacheSettings v-model="localSettings.download" :before-action="flushEditableSettings" />
          <div class="setting-group"><MusicDownloadSettings v-model="localSettings.download" :before-action="flushEditableSettings" /></div>
        </section>

        <section class="settings-section" id="software-section" :ref="sectionRefs.software" data-section="software" :hidden="!isSectionVisible('software')" :inert="!isSectionVisible('software')" :class="{ 'is-active': isSectionVisible('software') }" aria-labelledby="software-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="software-heading" tabindex="-1">启动与应用</h2><p>启动页面、系统托盘与播放恢复。</p></div></header>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="close-action">关闭窗口时</label><p class="setting-desc" id="close-action-desc">最小化到托盘会继续在后台播放；退出程序会停止播放并关闭应用。</p></div><AnimatedSelect id="close-action" class="setting-select" v-model="localSettings.software.minimizeToTray" label="关闭窗口时" :options="closeActionOptions" aria-describedby="close-action-desc" /></div>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="prompt-before-close">关闭前询问</label><p class="setting-desc" id="prompt-before-close-desc">开启后，每次关闭都可选择处理方式；关闭后直接执行上方选择。也可在关闭提示中勾选“不再提示”。</p></div><label class="setting-switch"><input id="prompt-before-close" type="checkbox" v-model="localSettings.software.promptBeforeClose" aria-describedby="prompt-before-close-desc"><span class="slider"></span></label></div>
          <div v-for="option in softwareOptions" :key="option.id" class="setting-item"><div class="setting-info"><label class="setting-label" :for="'software-' + option.id">{{ option.label }}</label><p class="setting-desc" :id="'software-' + option.id + '-desc'">{{ option.description }}</p></div><label class="setting-switch"><input :id="'software-' + option.id" type="checkbox" v-model="localSettings.software[option.id]" :aria-describedby="'software-' + option.id + '-desc'"><span class="slider"></span></label></div>
          <div class="setting-item"><div class="setting-info"><label class="setting-label" for="default-page">启动页面</label><p class="setting-desc">默认打开推荐；收藏页需要登录账号。</p></div><AnimatedSelect id="default-page" class="setting-select" v-model="localSettings.software.defaultPage" label="启动页面" :options="defaultPageOptions" /></div>
        </section>

        <section class="settings-section" id="about-section" :ref="sectionRefs.about" data-section="about" :hidden="!isSectionVisible('about')" :inert="!isSectionVisible('about')" :class="{ 'is-active': isSectionVisible('about') }" aria-labelledby="about-heading">
          <header class="section-header"><div><p class="eyebrow">{{ activeCategory }}</p><h2 id="about-heading" tabindex="-1">更新与备份</h2><p>检查应用更新，备份设置与获取帮助。</p></div></header>
          <AppUpdates v-model="localSettings.software.updates" :before-action="flushEditableSettings" @current-version="appVersion = $event" />
          <div class="setting-group"><div class="group-heading"><div><h3>备份与迁移</h3><p class="setting-desc">导入或导出完整设置。分享配色请前往“外观与主题”导出主题包。</p></div></div><div class="setting-actions"><button class="outline-btn" :class="{ 'is-busy': isExporting }" :aria-busy="isExporting" type="button" @click="handleExportSettings" :disabled="isExporting || isImporting">{{ isExporting ? '导出中…' : '导出设置' }}</button><button class="outline-btn" :class="{ 'is-busy': isImporting }" :aria-busy="isImporting" type="button" @click="handleImportSettings" :disabled="isImporting || isExporting">{{ isImporting ? '导入中…' : '导入设置' }}</button></div></div>
          <div class="about-links"><button type="button" @click="openFeedbackUrl">反馈与建议 ↗</button><button type="button" @click="openLicenseUrl">使用协议 ↗</button><button type="button" @click="openProjectUrl">项目主页 ↗</button></div>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup>
import { logger } from '../utils/logger.js'

import { reactive, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useSettingsStore } from '../stores/settingsStore.js'
import { cloneDeep, mergeDeep, replaceReactive } from '../utils/objectUtils.js'
import ThemePackages from '../components/common/ThemePackages.vue'
import ThemeAdjustments from '../components/common/ThemeAdjustments.vue'
import AppUpdates from '../components/common/AppUpdates.vue'
import PlaylistCacheSettings from '../components/common/PlaylistCacheSettings.vue'
import MusicDownloadSettings from '../components/common/MusicDownloadSettings.vue'
import AudioEffectsSettings from '../components/common/AudioEffectsSettings.vue'
import LyricSettings from '../components/common/LyricSettings.vue'
import DesktopLyricSettings from '../components/common/DesktopLyricSettings.vue'
import IslandLyricSettings from '../components/common/IslandLyricSettings.vue'
import TaskbarLyricSettings from '../components/common/TaskbarLyricSettings.vue'
import BackgroundImageSetting from '../components/common/BackgroundImageSetting.vue'
import AnimatedSelect from '../components/common/AnimatedSelect.vue'
import AnimatedDetails from '../components/common/AnimatedDetails.vue'
import packageInfo from '../../package.json'
import { applyTheme } from '../utils/themeManager.js'

const emit = defineEmits(['close', 'settings-changed', 'open-theme-studio'])

async function openThemeStudio() {
  if (await flushEditableSettings()) emit('open-theme-studio')
}

// 桌面端由更新服务提供实际安装版本；浏览器预览使用构建版本。
const appVersion = ref(typeof packageInfo === 'object' ? packageInfo.version : '')

const sections = [
  { id: 'playback', label: '播放', description: '音质、播放队列与聆听习惯。', group: '聆听',
    icon: 'M9 5v14l11-7z' },
  { id: 'audioEffects', label: '音频效果', description: 'VST3 插件、串联效果链、分析窗口与自动 BPM。', group: '聆听',
    icon: 'M4 4v16M12 4v16M20 4v16M1 9h6M9 15h6M17 7h6' },
  { id: 'lyrics', label: '歌词内容', description: '翻译、文字偏好与已保存的歌词。', group: '聆听',
    icon: 'M4 5h16M4 10h12M4 15h16M4 20h8' },
  { id: 'fullscreen', label: '全屏歌词', description: '调整播放界面的歌词、控件和背景。', group: '歌词窗口',
    icon: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 9h8m-8 6h5' },
  { id: 'desktop', label: '桌面歌词', description: '在桌面上跟随每一句，自由调整显示方式。', group: '歌词窗口',
    icon: 'M3 4h18v13H3zM8 21h8M12 17v4' },
  { id: 'island', label: '灵动岛歌词', description: '屏幕上沿的音乐陪伴，也可以自由浮动。', group: '歌词窗口',
    icon: 'M6 4h12a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM8 18h8M10 21h4' },
  { id: 'taskbar', label: '任务栏歌词', description: '把歌词和播放控制留在 Windows 任务栏。', group: '歌词窗口',
    icon: 'M3 4h18v16H3zM3 15h18M7 18h1M11 18h6' },
  { id: 'custom', label: '外观与主题', description: '播放器布局、主题配色与界面细节。', group: '个性化',
    icon: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-8zM7 9h.01M11 6h.01M16 8h.01M6 14h.01' },
  { id: 'shortcuts', label: '快捷键', description: '用熟悉的按键，快速控制音乐。', group: '个性化',
    icon: 'M3 6h18v12H3zM6 9h1M10 9h1M14 9h1M18 9h.01M7 14h10' },
  { id: 'download', label: '下载与缓存', description: '管理听过的音乐、存储空间与缓存位置。', group: '应用',
    icon: 'M12 3v11m-4-4 4 4 4-4M4 16v5h16v-5' },
  { id: 'software', label: '启动与应用', description: '启动页面、系统托盘与播放恢复。', group: '应用',
    icon: 'M12 3v9M6 5a9 9 0 1 0 12 0' },
  { id: 'about', label: '更新与备份', description: '检查应用更新，备份设置与获取帮助。', group: '应用',
    icon: 'M20 7a9 9 0 0 0-15-1L3 8m0-5v5h5M4 17a9 9 0 0 0 15 1l2-2m0 5v-5h-5' }
]
const navigationGroups = [...new Set(sections.map(section => section.group))].map(label => ({
  label, sections: sections.filter(section => section.group === label)
}))
const editableGroups = ['playback', 'download', 'custom', 'shortcuts', 'software', 'fullscreenLyrics', 'desktopLyrics', 'islandLyrics', 'taskbarLyrics']
const islandLyricsAvailable = Boolean(window.electronAPI?.islandLyric?.show)
const taskbarLyricsAvailable = Boolean(window.electronAPI?.taskbarLyric?.show)
const qualityOptions = [
  { value: '128', label: '标准 128 kbps' },
  { value: '320', label: '高品 320 kbps' },
  { value: 'flac', label: '无损 FLAC' },
  { value: 'high', label: '无损 HIGH' }
]
const defaultPageOptions = [{ value: 'home', label: '推荐首页' }, { value: 'favorites', label: '我的收藏' }]
const closeActionOptions = [{ value: true, label: '最小化到托盘' }, { value: false, label: '退出程序' }]
const playbackOptions = [
  { id: 'smoothTrackSwitch', label: '切歌声音平滑过渡', description: '手动切歌采用约 150 毫秒的交叉淡化，自然续播约 600 毫秒；新歌准备好后立即衔接。' },
  { id: 'preloadNextTrack', label: '提前准备下一首歌曲', description: '只提前准备当前队列的下一首，减少切歌等待；预加载不写入离线缓存。' },
  { id: 'skipTrailingSilence', label: '智能跳过歌曲结尾无声', description: '仅在当前歌曲已有可分析的完整缓存、确认结尾无声后提前续播；不确定时保留原曲尾部。' },
  { id: 'syncPlayHistory', label: '同步听歌记录到酷狗账号', description: '登录后，将实际聆听达到 30 秒（短曲达到一半）的歌曲同步到账号；暂停、跳转和加载失败不计入。' },
  { id: 'fullscreenLyrics', label: '播放时自动打开全屏歌词', description: '每次开始播放，自动进入全屏歌词界面。' },
  { id: 'enqueueFullPlaylist', label: '播放时加入整个歌单', description: '点播歌单中的歌曲时，将同歌单的全部曲目加入播放列表。' },
  { id: 'restartOnPreviousNearEnd', label: '歌曲即将结束时，上一首从头播放', description: '开启后，歌曲剩余不超过 10 秒时点击上一首，将从头播放当前歌曲；关闭时正常切换到上一首。' }
]
const softwareOptions = [
  { id: 'autoLaunch', label: '开机自启动', description: '登录系统时自动运行 BetterKuGou。' },
  { id: 'restorePlaylist', label: '恢复上次的播放列表与位置', description: '再次打开时，找回上一次的队列和歌曲进度。' },
  { id: 'restorePlaybackState', label: '恢复上次的播放状态', description: '记住播放或暂停、音量和循环模式。' }
]
const fullscreenLyricToggles = [
  { key: 'karaokeEnabled', id: 'fullscreen-karaoke', label: '逐字变亮', description: '按演唱进度填亮歌词。关闭后高亮整句。' },
  { key: 'showControls', id: 'fullscreen-controls', label: '显示播放控件', description: '显示播放进度、音量和曲目操作。' },
  { key: 'blurEnabled', id: 'fullscreen-blur', label: '歌词模糊', description: '让当前句之外的歌词更柔和。' }
]
const fullscreenLyricPositions = [
  { value: 'right', label: '右侧（默认）' },
  { value: 'left', label: '左侧' }
]
const fullscreenLyricRanges = [
  { key: 'fontSize', id: 'fullscreen-font-size', label: '歌词字号', min: 16, max: 64 },
  { key: 'lineSpacing', id: 'fullscreen-line-spacing', label: '歌词行间距', min: 0, max: 40 }
]
const fullscreenBackgroundModes = [
  { value: 'frosted', label: '毛玻璃（默认）' },
  { value: 'acrylic', label: '亚克力' },
  { value: 'cover', label: '专辑封面' },
  { value: 'custom', label: '自定义图片' },
  { value: 'main', label: '跟随主背景' }
]
const fullscreenBackgroundMotions = [
  { value: 'static', label: '静态（默认）' },
  { value: 'beat', label: '跟随音乐鼓点' },
  { value: 'quicksand', label: '流沙' }
]
const customColors = [{ id: 'primary', label: '主题色' }, { id: 'hover', label: '悬浮强调色' }, { id: 'background', label: '背景色' }]

const activeSection = ref('playback')
const lyricSettingsRef = ref(null)
const settingsMain = ref(null)
const sectionRefs = Object.fromEntries(sections.map(section => [section.id, ref(null)]))
const searchInput = ref(null)
const searchQuery = ref('')
const searchIndex = ref([])
let navigationRevision = 0
const isSearching = computed(() => Boolean(searchQuery.value.trim()))
const activeCategory = computed(() => sections.find(section => section.id === activeSection.value)?.group)
const searchResults = computed(() => {
  const terms = searchQuery.value.trim().toLocaleLowerCase().split(/\s+/)
  return searchIndex.value.flatMap(section => {
    const context = section.label + ' ' + section.description
    const matches = section.entries.filter(entry => terms.every(term => (context + ' ' + entry.label).toLocaleLowerCase().includes(term)))
    return matches.length || terms.every(term => context.toLocaleLowerCase().includes(term)) ? [{ ...section, matches }] : []
  })
})

function isSectionVisible(id) { return activeSection.value === id && !isSearching.value }

/** 从真实表单标签建立本页索引，包含折叠选项，不读取输入值或歌词正文。 */
function refreshSearchIndex() {
  searchIndex.value = sections.map(section => {
    const labels = sectionRefs[section.id].value?.querySelectorAll?.('label[for], .setting-label, .shortcut-label, .token-field > span:first-child, .radio-option__display, .island-label, .taskbar-label, h3, h4, summary') || []
    const seen = new Set()
    const entries = [...labels].flatMap(element => {
      const label = (element.querySelector?.('strong')?.textContent || element.childNodes?.[0]?.textContent?.trim() || element.textContent)?.trim()
      if (!label || seen.has(label)) return []
      seen.add(label)
      return [{ label, element }]
    })
    return { ...section, entries }
  })
}

watch(searchQuery, () => {
  navigationRevision++
  refreshSearchIndex()
  if (isSearching.value) {
    stopEditingShortcut()
    settingsMain.value?.scrollTo?.({ top: 0, behavior: 'instant' })
  }
}, { flush: 'sync' })

function clearSearch() {
  searchQuery.value = ''
  nextTick(() => searchInput.value?.focus())
}

/** 切回匹配分区后展开目标的折叠祖先，并把焦点放到真实标签对应的控件。 */
async function openSearchResult(result) {
  scrollToSection(result.id)
  const revision = navigationRevision
  await nextTick()
  if (revision !== navigationRevision) return
  const target = result.matches[0]?.element || sectionRefs[result.id].value?.querySelector('h2')
  if (!target) return
  const disclosures = []
  for (let parent = target.parentElement; parent && parent !== settingsMain.value; parent = parent.parentElement) {
    if (parent.matches('details') && !parent.open) disclosures.unshift(parent)
  }
  disclosures.forEach(details => {
    details.querySelector('summary')?.click()
  })
  // 内层展开会让外层重新计算高度并替换动画，需要等替换后的动画也稳定。
  let animations
  do {
    animations = disclosures.flatMap(details => details.getAnimations?.() || [])
    await Promise.allSettled(animations.map(animation => animation.finished))
    await new Promise(resolve => window.requestAnimationFrame(resolve))
    if (revision !== navigationRevision) return
  } while (disclosures.some(details => details.getAnimations?.().some(animation => animation.playState === 'running')))
  // 展开期间用户可能继续搜索、切分类或离页，迟到结果不能抢回滚动和焦点。
  if (revision !== navigationRevision || activeSection.value !== result.id || isSearching.value || target.isConnected === false) return
  target.scrollIntoView?.({ block: 'center', behavior: 'instant' })
  const controlId = target.getAttribute('for')
  const control = controlId ? document.getElementById(controlId)
    : target.closest('summary') || target.closest('label')?.querySelector('input') || target.closest('.shortcut-card')?.querySelector('button') || sectionRefs[result.id].value?.querySelector('h2')
  control?.focus({ preventScroll: true })
}

const shortcutList = ref([
  { id: 'playPause', label: '播放 / 暂停', description: '切换播放和暂停状态' },
  { id: 'nextTrack', label: '下一首', description: '播放下一首歌曲' },
  { id: 'prevTrack', label: '上一首', description: '播放上一首歌曲' },
  { id: 'volumeUp', label: '音量增加', description: '增加音量' },
  { id: 'volumeDown', label: '音量减少', description: '减少音量' },
  { id: 'toggleLyrics', label: '显示/隐藏歌词', description: '切换歌词显示' },
  { id: 'toggleFullscreen', label: '全屏模式', description: '切换全屏显示' },
  { id: 'bossKey', label: '老板键', description: '快速隐藏窗口' }
])

const editingShortcut = ref(null)
const shortcutErrors = ref({})
const shortcutErrorRevision = ref(0)
const shortcutErrorTimers = new Map()
function showShortcutError(id, message) {
  clearTimeout(shortcutErrorTimers.get(id))
  shortcutErrors.value[id] = message
  shortcutErrorRevision.value++
  shortcutErrorTimers.set(id, setTimeout(() => { delete shortcutErrors.value[id]; shortcutErrorTimers.delete(id) }, 3000))
}

const {
  settings,
  ready,
  updateSettings,
  revision,
  exportSettings,
  importSettings,
  chooseDirectory,
  defaults
} = useSettingsStore()

// 设置页只持有可编辑分区，会话由 store 和播放器负责。
const ensureDefaults = (source) => {
  const defaultSettings = defaults()
  const merged = {}
  for (const id of editableGroups) {
    merged[id] = cloneDeep(defaultSettings[id])
    if (source?.[id] && typeof source[id] === 'object') {
      mergeDeep(merged[id], cloneDeep(source[id]))
    }
  }
  return merged
}

const localSettings = reactive(ensureDefaults(settings))
let syncedSettings = cloneDeep(localSettings)
const isSyncingFromStore = ref(false)
let saveTimer = null
const isExporting = ref(false)
const isImporting = ref(false)
const isChoosingPath = ref(false)
const settingsSaveError = ref('')
const settingsSaveRevision = ref(0)
const actionMessage = ref('')
const actionMessageType = ref('success')
const actionMessageRevision = ref(0)
const saveState = ref('saved')
let saveTask = null
let recoveringAppearance = false
const saveStatusText = computed(() => ({ saved: '所有更改已保存', pending: '等待保存…', saving: '正在保存…', error: '更改尚未保存' })[saveState.value])

// 图片导入成功后连同显示模式一起进入同一份待保存草稿。
function setFullscreenBackgroundImage(image) {
  if (isImporting.value) return
  localSettings.fullscreenLyrics.backgroundImage = image
  if (image) localSettings.fullscreenLyrics.backgroundMode = 'custom'
}

// 只提交用户实际编辑的字段，保留同一分区中的外部更新。
function collectSettingsPatch(current, baseline) {
  const patch = {}
  for (const [key, value] of Object.entries(current)) {
    const previous = baseline?.[key]
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        previous && typeof previous === 'object' && !Array.isArray(previous)) {
      const nested = collectSettingsPatch(value, previous)
      if (Object.keys(nested).length) patch[key] = nested
    } else if (JSON.stringify(value) !== JSON.stringify(previous)) {
      patch[key] = cloneDeep(value)
    }
  }
  return patch
}

function syncFromStore() {
  if (!ready.value || saveTask || recoveringAppearance) return
  const incoming = ensureDefaults(settings)
  if (JSON.stringify(incoming) === JSON.stringify(syncedSettings)) return
  const pending = collectSettingsPatch(localSettings, syncedSettings)
  syncedSettings = cloneDeep(incoming)
  mergeDeep(incoming, pending)
  isSyncingFromStore.value = true
  try {
    replaceReactive(localSettings, incoming)
  } finally {
    // 使用 nextTick 确保所有响应式更新完成后再恢复标志
    nextTick(() => {
      isSyncingFromStore.value = false
    })
  }
}

watch(ready, (value) => {
  if (value) syncFromStore()
}, { immediate: true })

watch(revision, () => {
  syncFromStore()
  // 会话广播应用的是已提交主题；恢复本页未保存的主题预览，防止播放中闪回。
  if (ready.value) applyTheme({ custom: localSettings.custom })
})

// 主题编辑立即预览，持久化仍走设置页已有的串行保存流程。
watch(() => localSettings.custom, (custom) => {
  if (ready.value) applyTheme({ custom })
}, { deep: true })

async function persistEditableSettings() {
  if (saveTask) return saveTask
  if (!ready.value || recoveringAppearance) return false
  const patch = collectSettingsPatch(localSettings, syncedSettings)
  if (!Object.keys(patch).length) {
    saveState.value = 'saved'
    settingsSaveError.value = ''
    return true
  }
  const submitted = cloneDeep(localSettings)
  saveState.value = 'saving'
  // 保存期间忽略 store 的乐观广播；落盘后再合并外部更新和本页的后续编辑。
  saveTask = Promise.resolve().then(async () => {
    try {
      await updateSettings(patch)
      const laterEdits = collectSettingsPatch(localSettings, submitted)
      syncedSettings = ensureDefaults(settings)
      const next = mergeDeep(cloneDeep(syncedSettings), laterEdits)
      isSyncingFromStore.value = true
      replaceReactive(localSettings, next)
      await nextTick()
      isSyncingFromStore.value = false
      settingsSaveError.value = ''
      saveState.value = Object.keys(laterEdits).length ? 'pending' : 'saved'
      if (saveState.value === 'saved') settingsSaveRevision.value++
      emit('settings-changed', cloneDeep(localSettings))
      return true
    } catch (err) {
      settingsSaveError.value = '保存失败，你的修改仍保留在此页。请重试保存。'
      saveState.value = 'error'
      logger.error('SettingsView', '[SettingsView] 更新设置失败:', err)
      return false
    } finally {
      saveTask = null
    }
  })
  return saveTask
}

/** 离焦、离页及导出前排空防抖与正在执行的保存，不把旧配置导出。 */
async function flushEditableSettings() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  do {
    if (!await persistEditableSettings()) return false
  } while (Object.keys(collectSettingsPatch(localSettings, syncedSettings)).length)
  return true
}

/** 离页及整份设置替换共用正文保护，不能将未保存歌词当作偏好自动覆盖。 */
function prepareLyricLibraryLeave() {
  const allowed = lyricSettingsRef.value?.prepareLeave?.() !== false
  if (!allowed) scrollToSection('lyrics')
  return allowed
}

/** Recovery supersedes unsaved appearance edits, including edits made during an earlier in-flight save. */
async function prepareThemeRecovery(base) {
  recoveringAppearance = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  // An existing transaction may still commit its captured theme; recovery is queued after it.
  if (saveTask) await saveTask
  const committed = ensureDefaults(settings).custom
  const themeFields = ['theme', 'themePackages', 'themeAdjustmentId', 'customTheme', 'backgroundImage']
  isSyncingFromStore.value = true
  for (const field of themeFields) {
    localSettings.custom[field] = cloneDeep(committed[field])
    syncedSettings.custom[field] = cloneDeep(committed[field])
  }
  localSettings.custom.theme = base
  syncedSettings.custom.theme = base
  localSettings.custom.backgroundImage = ''
  syncedSettings.custom.backgroundImage = ''
  await nextTick()
  isSyncingFromStore.value = false
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  return async () => {
    // Read the actual committed result on success or rollback; no old theme draft remains to replay.
    const current = ensureDefaults(settings).custom
    isSyncingFromStore.value = true
    for (const field of themeFields) {
      localSettings.custom[field] = cloneDeep(current[field])
      syncedSettings.custom[field] = cloneDeep(current[field])
    }
    await nextTick()
    isSyncingFromStore.value = false
    recoveringAppearance = false
    syncFromStore()
    await nextTick()
    if (Object.keys(collectSettingsPatch(localSettings, syncedSettings)).length) {
      saveState.value = 'pending'
      saveTimer = setTimeout(() => { saveTimer = null; void flushEditableSettings() }, 500)
    }
  }
}

function flushPendingOnBlur(event) {
  if (event.target?.matches('input, [role="combobox"], [aria-haspopup="listbox"]')) void flushEditableSettings()
}

watch(localSettings, () => {
  if (isSyncingFromStore.value || !ready.value || recoveringAppearance) return
  saveState.value = 'pending'
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushEditableSettings()
  }, 500)
}, { deep: true })

/** 保留原对外入口；分类只切换可见内容，不卸载草稿或中断后台操作。 */
function scrollToSection(sectionId) {
  if (!sections.some(section => section.id === sectionId)) return
  navigationRevision++
  stopEditingShortcut()
  activeSection.value = sectionId
  searchQuery.value = ''
  nextTick(() => {
    settingsMain.value?.scrollTo?.({ top: 0, behavior: 'instant' })
  })
}

async function handleExportSettings() {
  if (isExporting.value) return
  isExporting.value = true
  try {
    if (!await flushEditableSettings()) return
    const result = await exportSettings()
    if (result?.error) throw result.error
    if (result?.reason === 'unsupported') throw new Error('Export is unavailable')
    if (result?.canceled) return
    actionMessageType.value = 'success'
    actionMessageRevision.value++
    actionMessage.value = '设置已导出。'
  } catch (err) {
    actionMessageType.value = 'error'
    actionMessageRevision.value++
    actionMessage.value = '导出失败，请稍后重试。'
    logger.error('SettingsView', '[SettingsView] 导出设置失败:', err)
  } finally {
    isExporting.value = false
  }
}

async function handleImportSettings() {
  if (isImporting.value || !prepareLyricLibraryLeave()) return
  isImporting.value = true
  try {
    if (!await flushEditableSettings()) return
    if (!prepareLyricLibraryLeave()) return
    const result = await importSettings()
    if (result?.error) throw result.error
    if (result?.reason === 'unsupported') throw new Error('Import is unavailable')
    if (result?.canceled) return
    syncedSettings = ensureDefaults(settings)
    isSyncingFromStore.value = true
    replaceReactive(localSettings, syncedSettings)
    await nextTick()
    isSyncingFromStore.value = false
    settingsSaveError.value = ''
    saveState.value = 'saved'
    actionMessageType.value = 'success'
    actionMessageRevision.value++
    actionMessage.value = '设置已导入并应用。'
    logger.info('SettingsView', '[SettingsView] 设置导入成功')
  } catch (err) {
    actionMessageType.value = 'error'
    actionMessageRevision.value++
    actionMessage.value = '导入失败，原设置已保留。请检查文件格式。'
    logger.error('SettingsView', '[SettingsView] 导入设置失败:', err)
  } finally {
    isImporting.value = false
  }
}

async function handleSelectPath(type) {
  if (isChoosingPath.value) return
  isChoosingPath.value = true
  try {
    const currentValue = type === 'download'
      ? localSettings.download.downloadPath
      : localSettings.download.cachePath

    const result = await chooseDirectory({
      title: type === 'download' ? '选择下载目录' : '选择缓存目录',
      defaultPath: currentValue || undefined,
      buttonLabel: '选择'
    })
    if (result?.canceled || !result?.path) return

    if (type === 'download') {
      localSettings.download.downloadPath = result.path
    } else {
      localSettings.download.cachePath = result.path
    }
  } catch (err) {
    logger.error('SettingsView', '[SettingsView] 选择目录失败:', err)
  } finally {
    isChoosingPath.value = false
  }
}

function handleSelectDownloadPath() {
  return handleSelectPath('download')
}

function handleSelectCachePath() {
  return handleSelectPath('cache')
}

// 快捷键相关函数
function formatShortcutKey(key) {
  if (!key || key === 'Escape') return '未设置'
  return key
    .replace(/Control/g, 'Ctrl')
    .replace(/\+/g, ' + ')
}

function startEditingShortcut(shortcutId) {
  editingShortcut.value = shortcutId
  delete shortcutErrors.value[shortcutId]
  
  // 设置全局标志,阻止触发其他快捷键
  window.__editingShortcut = true
  
  // 添加键盘监听
  document.addEventListener('keydown', handleShortcutKeyDown, { capture: true })
}

function stopEditingShortcut() {
  editingShortcut.value = null
  
  // 清除全局标志
  window.__editingShortcut = false
  
  document.removeEventListener('keydown', handleShortcutKeyDown, { capture: true })
}

async function handleShortcutKeyDown(event) {
  if (!editingShortcut.value) return
  
  event.preventDefault()
  event.stopPropagation()
  
  // 按 ESC 清除快捷键
  if (event.key === 'Escape') {
    localSettings.shortcuts.keys[editingShortcut.value] = 'Escape'
    stopEditingShortcut()
    return
  }
  
  // 构建快捷键字符串
  const keys = []
  if (event.ctrlKey || event.metaKey) keys.push('Control')
  if (event.altKey) keys.push('Alt')
  if (event.shiftKey) keys.push('Shift')
  
  // 获取主键
  let mainKey = event.key
  
  // 特殊键映射
  const keyMap = {
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    ' ': 'Space'
  }
  
  mainKey = keyMap[mainKey] || mainKey
  
  // 忽略单独的修饰键
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(mainKey)) {
    return
  }
  
  keys.push(mainKey)
  const shortcutKey = keys.join('+')
  
  // 检查是否与其他快捷键冲突
  const shortcutId = editingShortcut.value
  const conflict = shortcutList.value.find(s =>
    s.id !== editingShortcut.value && 
    localSettings.shortcuts.keys[s.id] === shortcutKey
  )
  
  if (conflict) {
    showShortcutError(shortcutId, `与"${conflict.label}"冲突`)
    stopEditingShortcut()
    return
  }
  
  // 尝试注册全局快捷键（如果启用）
  if (localSettings.shortcuts.enableGlobal) {
    const registered = await tryRegisterGlobalShortcut(shortcutKey)
    if (editingShortcut.value !== shortcutId) return
    if (!registered) {
      showShortcutError(shortcutId, '无法注册此快捷键')
      stopEditingShortcut()
      return
    }
  }
  
  // 设置快捷键
  localSettings.shortcuts.keys[editingShortcut.value] = shortcutKey
  delete shortcutErrors.value[editingShortcut.value]
  stopEditingShortcut()
}

function clearShortcut(shortcutId) {
  localSettings.shortcuts.keys[shortcutId] = 'Escape'
  delete shortcutErrors.value[shortcutId]
}

async function tryRegisterGlobalShortcut(key) {
  // 如果未启用全局快捷键,直接返回成功
  if (!localSettings.shortcuts.enableGlobal) {
    return true
  }
  
  // 测试是否能注册全局快捷键
  if (window.electronAPI?.testGlobalShortcut) {
    try {
      const result = await window.electronAPI.testGlobalShortcut(key)
      if (!result?.canRegister) {
        logger.warn('SettingsView', '⚠️ 快捷键无法注册:', key)
      }
      return Boolean(result?.canRegister)
    } catch (err) {
      logger.error('SettingsView', '测试快捷键注册失败:', err)
      return false
    }
  }
  
  // 开发模式或 Electron API 不可用时默认返回成功
  return true
}

// URL 跳转处理函数
function openFeedbackUrl() {
  const url = 'https://github.com/YuanXiaCN/BetterKuGou/issues'
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

function openProjectUrl() {
  const url = 'https://github.com/YuanXiaCN/BetterKuGou'
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

function openLicenseUrl() {
  const url = 'https://github.com/YuanXiaCN/BetterKuGou?tab=License-1-ov-file'
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

onMounted(() => { nextTick(refreshSearchIndex) })

onBeforeUnmount(() => {
  navigationRevision++
  stopEditingShortcut() // 清理快捷键编辑监听器
  for (const timer of shortcutErrorTimers.values()) clearTimeout(timer)
  shortcutErrorTimers.clear()
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void flushEditableSettings()
})

defineExpose({
  scrollToSection,
  async flushEditableSettings() {
    if (!prepareLyricLibraryLeave()) return false
    return flushEditableSettings()
  },
  prepareThemeRecovery
})
</script>

<style src="./styles/SettingsView.css" scoped></style>
