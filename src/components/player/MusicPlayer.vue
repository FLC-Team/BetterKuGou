<template>
  <div class="music-player" :class="{ 'player-style-netease': playerStyle === 'netease' }">
    <!-- 默认样式：进度条在顶部 -->
    <div v-if="playerStyle !== 'netease'" class="progress-bar-container">
      <input 
        type="range" 
        class="progress-bar" 
        :style="{ '--progress': progressPercent + '%' }"
        min="0" 
        :max="duration"
        :value="displayPlayTime"
        @input="handleProgressDrag"
        @change="handleProgressChange"
        @pointercancel="cancelProgressDrag"
        @blur="cancelProgressDrag"
        @keydown.esc.stop.prevent="cancelProgressDrag"
      />
    </div>

    <!-- 播放器主体 -->
    <div class="player-main" :class="{ 'isPlaying': isPlaying }" v-if="currentSong">
      <!-- 左侧：歌曲信息 -->
      <div class="song-info-section">
        <img 
          v-if="currentSong.cover" 
          :src="currentSong.cover.replace('{size}', '400')" 
          class="song-cover"
          :alt="currentSong.name"
          @click="showLyrics"
          title="点击查看歌词"
        />
        <div class="song-details">
          <div class="song-name">{{ getSongName(currentSong.name) }}</div>
          <div class="song-artist">{{ getSingerNames(currentSong.singerinfo) || currentSong.singername || (currentSong.name && currentSong.name.includes(' - ') ? currentSong.name.split(' - ')[0] : '未知歌手') }}</div>
        </div>
        <button class="icon-btn favorite-btn" :class="{ active: isFavorite }" @click="toggleFavorite">
          <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
            <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
          </svg>
        </button>
        <!-- 默认样式：时间信息在这里 -->
        <div v-if="playerStyle !== 'netease'" class="time-info">
          <span class="current-time">{{ formatTime(displayPlayTime) }}</span>
          <span class="separator">/</span>
          <span class="total-time">{{ formatTime(duration) }}</span>
        </div>
      </div>

      <!-- 中间：播放控制 -->
      <div class="player-controls-section">
        <!-- 网易云样式：收藏和播放模式按钮与控制按钮在一起 -->
        <div v-if="playerStyle === 'netease'" class="control-buttons netease-controls">
          <button class="icon-btn favorite-btn" :class="{ active: isFavorite }" @click="toggleFavorite">
            <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
              <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
            </svg>
          </button>
          
          <button class="control-btn" @click="playPrevious" :disabled="isSwitchingSong" title="上一曲">
            <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
              <path d="M793.6 150.4c-12.8 0-25.6 4.8-35.2 14.4L416 480v-288c0-19.2-16-35.2-35.2-35.2s-35.2 16-35.2 35.2v646.4c0 19.2 16 35.2 35.2 35.2s35.2-16 35.2-35.2V544l342.4 315.2c9.6 9.6 22.4 14.4 35.2 14.4 19.2 0 35.2-16 35.2-35.2V185.6c0-19.2-16-35.2-35.2-35.2z"/>
            </svg>
          </button>
          
          <button class="control-btn play-btn" @click="togglePlay">
            <svg v-if="isPlaying" viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
              <path d="M304 176h80v672h-80zm336 0h80v672h-80z"/>
            </svg>
            <svg v-else viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
              <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
            </svg>
          </button>
          
          <button class="control-btn" @click="playNext" :disabled="isSwitchingSong" title="下一曲">
            <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
              <path d="M230.4 150.4c12.8 0 25.6 4.8 35.2 14.4L608 480v-288c0-19.2 16-35.2 35.2-35.2s35.2 16 35.2 35.2v646.4c0 19.2-16 35.2-35.2 35.2s-35.2-16-35.2-35.2V544L265.6 859.2c-9.6 9.6-22.4 14.4-35.2 14.4-19.2 0-35.2-16-35.2-35.2V185.6c0-19.2 16-35.2 35.2-35.2z"/>
            </svg>
          </button>
          
          <button 
            class="icon-btn" 
            @click="togglePlayMode" 
            @contextmenu.prevent.stop="showPlayModeMenu"
            :title="playModeText"
          >
            <img v-if="playMode === 'loop'" :src="repeatAllIcon" alt="列表循环" width="18" height="18" />
            <img v-else-if="playMode === 'single'" :src="repeatOneIcon" alt="单曲循环" width="18" height="18" />
            <img v-else :src="shuffleIcon" alt="随机播放" width="18" height="18" />
          </button>
        </div>
        
        <!-- 默认样式：只有播放控制按钮 -->
        <div v-else class="control-buttons">
          <button class="control-btn" @click="playPrevious" :disabled="isSwitchingSong" title="上一曲">
            <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
              <path d="M793.6 150.4c-12.8 0-25.6 4.8-35.2 14.4L416 480v-288c0-19.2-16-35.2-35.2-35.2s-35.2 16-35.2 35.2v646.4c0 19.2 16 35.2 35.2 35.2s35.2-16 35.2-35.2V544l342.4 315.2c9.6 9.6 22.4 14.4 35.2 14.4 19.2 0 35.2-16 35.2-35.2V185.6c0-19.2-16-35.2-35.2-35.2z"/>
            </svg>
          </button>
          
          <button class="control-btn play-btn" @click="togglePlay">
            <svg v-if="isPlaying" viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
              <path d="M304 176h80v672h-80zm336 0h80v672h-80z"/>
            </svg>
            <svg v-else viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
              <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
            </svg>
          </button>
          
          <button class="control-btn" @click="playNext" :disabled="isSwitchingSong" title="下一曲">
            <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
              <path d="M230.4 150.4c12.8 0 25.6 4.8 35.2 14.4L608 480v-288c0-19.2 16-35.2 35.2-35.2s35.2 16 35.2 35.2v646.4c0 19.2-16 35.2-35.2 35.2s-35.2-16-35.2-35.2V544L265.6 859.2c-9.6 9.6-22.4 14.4-35.2 14.4-19.2 0-35.2-16-35.2-35.2V185.6c0-19.2 16-35.2 35.2-35.2z"/>
            </svg>
          </button>
        </div>
        
        <!-- 网易云样式：进度条在播放按钮下方 -->
        <div v-if="playerStyle === 'netease'" class="netease-progress-wrapper">
          <span class="time-text">{{ formatTime(displayPlayTime) }}</span>
          <div class="progress-bar-container">
            <input 
              type="range" 
              class="progress-bar" 
              :style="{ '--progress': progressPercent + '%' }"
              min="0" 
              :max="duration"
              :value="displayPlayTime"
              @input="handleProgressDrag"
              @change="handleProgressChange"
        @pointercancel="cancelProgressDrag"
        @blur="cancelProgressDrag"
        @keydown.esc.stop.prevent="cancelProgressDrag"
            />
          </div>
          <span class="time-text">{{ formatTime(duration - displayPlayTime) }}</span>
        </div>
      </div>

      <!-- 右侧:音量和其他控制 -->
      <div class="player-extras-section">
        <!-- 默认样式：显示播放模式按钮 -->
        <button 
          v-if="playerStyle !== 'netease'"
          class="icon-btn" 
          @click="togglePlayMode" 
          @contextmenu.prevent.stop="showPlayModeMenu"
          :title="playModeText"
        >
          <img v-if="playMode === 'loop'" :src="repeatAllIcon" alt="列表循环" width="18" height="18" />
          <img v-else-if="playMode === 'single'" :src="repeatOneIcon" alt="单曲循环" width="18" height="18" />
          <img v-else :src="shuffleIcon" alt="随机播放" width="18" height="18" />
        </button>

        <div class="volume-control">
          <button class="icon-btn" @click="toggleMute">
            <img v-if="isMuted || volume === 0" :src="sound0Icon" alt="静音" width="18" height="18" />
            <img v-else-if="volume <= 30" :src="sound1Icon" alt="音量低" width="18" height="18" />
            <img v-else-if="volume <= 60" :src="sound2Icon" alt="音量中" width="18" height="18" />
            <img v-else :src="sound3Icon" alt="音量高" width="18" height="18" />
          </button>
          <input 
            type="range" 
            class="volume-slider" 
            min="0" 
            max="100" 
            v-model="volume"
            @input="handleVolumeChange"
          />
        </div>

        <button class="icon-btn" @click="togglePlaylist" title="播放列表">
          <img :src="playlistIcon" alt="播放列表" width="18" height="18" />
        </button>
      </div>
    </div>

    <!-- 音频元素 -->
    <audio 
      ref="audioPlayer" 
      @loadedmetadata="handleLoadedMetadata"
      @ended="handleEnded"
      @play="handlePlay"
      @pause="handlePause"
      @timeupdate="handleTimeUpdate"
    ></audio>
    
    <!-- 播放列表抽屉 -->
    <Teleport to="body">
      <PlaylistDrawer
        :visible="showPlaylist"
        :playlist="playlist"
        :currentSong="currentSong"
        :isPlaying="isPlaying"
        @close="showPlaylist = false"
        @open="showPlaylist = true"
        @play="handlePlaylistPlay"
        @remove="handleRemoveSong"
        @clear="handleClearPlaylist"
      />

      <!-- 播放模式右键菜单 -->
      <ContextMenu
        :visible="playModeMenuVisible"
        :position="playModeMenuPosition"
        :items="playModeMenuItems"
        @close="playModeMenuVisible = false"
      />

      <!-- 歌词界面 -->
      <Transition name="lyric-view" @after-leave="handleLyricsHidden">
        <LyricView
          v-if="showLyricView"
          :visible="showLyricView"
          :song="currentSong"
          :lyrics="currentLyrics"
          :lyric-data="currentLyricData"
          :current-play-time="currentTime"
          :preview-time="seekPreviewTime"
          :duration="duration"
          :is-playing="isPlaying"
          :play-mode="playMode"
          :is-favorite="isFavorite"
          :pause-updates="isSwitchingSong"
          @close="closeLyrics"
          @toggle-play="togglePlay"
          @previous="playPrevious"
          @next="playNext"
          @toggle-play-mode="cyclePlayMode"
          @toggle-favorite="toggleFavorite"
          @seek="handleSeek"
        />
      </Transition>
    </Teleport>
  </div>
</template>

<script src="./MusicPlayer.js"></script>

<style src="./styles/MusicPlayer.css" scoped></style>
