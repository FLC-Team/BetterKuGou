<template>
  <div class="lyric-view" v-if="visible" @click="closeLyricView" @keydown.esc.stop="closeLyricView" role="dialog" aria-label="歌曲歌词">
    <!-- 模糊背景 -->
    <div class="lyric-background">
      <Transition name="track-background" @before-leave="retireTrackLayer">
        <img v-if="coverUrl"
             :key="coverUrl"
             :src="coverUrl"
             alt=""
             class="background-image">
      </Transition>
      <div class="background-overlay"></div>
    </div>

    <!-- 主要内容 -->
    <div class="lyric-container" @click.stop>
      <!-- 左侧专辑信息 -->
      <div class="album-section">
        <!-- 专辑封面 -->
        <div class="album-cover-wrapper">
          <Transition :name="trackTransitionName" @before-leave="retireTrackLayer">
            <div :key="song?.hash || 'empty'" class="track-piece track-cover">
              <img v-if="coverUrl"
                   :src="coverUrl"
                   :data-track-key="song?.hash"
                   alt="专辑封面"
                   @error="handleCoverError"
                   class="album-cover">
              <div v-else class="album-cover-placeholder">
                <svg viewBox="0 0 1024 1024" width="120" height="120" fill="currentColor">
                  <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64z"/>
                </svg>
              </div>
            </div>
          </Transition>
        </div>

        <!-- 歌曲信息 -->
        <div class="song-info">
          <div class="track-text-stage">
            <Transition :name="trackTransitionName" @before-leave="retireTrackLayer">
              <h2 :key="song?.hash || 'empty'" class="song-title track-piece track-title">{{ getSongName(song) }}</h2>
            </Transition>
          </div>
          <div class="track-text-stage">
            <Transition :name="trackTransitionName" @before-leave="retireTrackLayer">
              <p :key="song?.hash || 'empty'" class="song-artist track-piece track-artist">{{ getSingerNames(song) }}</p>
            </Transition>
          </div>
        </div>

        <div class="playback-panel">
          <input
            class="lyric-progress"
            type="range"
            min="0"
            :max="duration > 0 ? duration : 0"
            step="0.1"
            :value="displayPlayTime"
            :disabled="!Number.isFinite(duration) || duration <= 0"
            :style="{ '--progress': progressPercentage + '%' }"
            aria-label="歌曲进度"
            :aria-valuetext="`${formatTime(displayPlayTime)} / ${formatTime(duration)}`"
            @input="previewSeek"
            @change="commitSeek"
            @pointercancel="cancelSeek"
            @blur="cancelSeek"
            @keydown.esc.stop="handleProgressEscape"
          />
          <!-- 时间显示 -->
          <div class="time-display">
            <span>{{ formatTime(displayPlayTime) }}</span>
            <span>{{ formatTime(duration) }}</span>
          </div>

          <!-- 播放控制按钮 -->
          <div class="playback-controls">
            <!-- 收藏按钮 -->
            <button type="button" class="control-btn favorite-btn" :class="{ active: isFavorite }" :aria-pressed="isFavorite" @click="toggleFavorite" :title="isFavorite ? '取消收藏' : '收藏'" :aria-label="isFavorite ? '取消收藏' : '收藏'">
              <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
                <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
              </svg>
            </button>

            <!-- 上一首按钮 -->
            <button type="button" class="control-btn" @click="playPrevious" title="上一首" aria-label="上一首">
              <svg viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
                <path d="M272.9 512l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L186.8 492.3a31.99 31.99 0 000 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H532c6.7 0 10.4-7.7 6.3-12.9L272.9 512zm304 0l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L490.8 492.3a31.99 31.99 0 000 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H836c6.7 0 10.4-7.7 6.3-12.9L576.9 512z"/>
              </svg>
            </button>

            <!-- 播放/暂停按钮 -->
            <button type="button" class="control-btn play-btn" @click="togglePlayPause" :title="isPlaying ? '暂停' : '播放'" :aria-label="isPlaying ? '暂停' : '播放'">
              <svg v-if="isPlaying" viewBox="0 0 1024 1024" width="32" height="32" fill="currentColor">
                <path d="M304 176h80v672h-80zm336 0h80v672h-80z"/>
              </svg>
              <svg v-else viewBox="0 0 1024 1024" width="32" height="32" fill="currentColor">
                <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
              </svg>
            </button>

            <!-- 下一首按钮 -->
            <button type="button" class="control-btn" @click="playNext" title="下一首" aria-label="下一首">
              <svg viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
                <path d="M751.1 512L485.7 172.9c-4.1-5.2-.4-12.9 6.3-12.9h77.3c4.9 0 9.6 2.3 12.6 6.1l255.3 326.1c9.4 12.1 9.4 29.4 0 41.5L581.9 859.8c-3 3.9-7.7 6.1-12.6 6.1H492c-6.7 0-10.4-7.7-6.3-12.9L751.1 512zm-304 0L181.7 172.9c-4.1-5.2-.4-12.9 6.3-12.9h77.3c4.9 0 9.6 2.3 12.6 6.1l255.3 326.1c9.4 12.1 9.4 29.4 0 41.5L277.9 859.8c-3 3.9-7.7 6.1-12.6 6.1H188c-6.7 0-10.4-7.7-6.3-12.9L447.1 512z"/>
              </svg>
            </button>

            <!-- 播放模式按钮 -->
            <button type="button" class="control-btn mode-btn" @click="togglePlayMode" :title="playModeText" :aria-label="playModeText">
              <span class="mode-icon" :style="playModeIconStyle" aria-hidden="true"></span>
            </button>
          </div>
          <div class="lyric-tools">
            <label class="lyric-quality" title="音质偏好；可用音质取决于歌曲与账号权限">
              <span>音质</span>
              <select aria-label="全屏歌词音质偏好" :value="qualityPreference" @change="$emit('change-quality', $event.target.value)" @keydown.stop>
                <option v-for="option in qualityOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <!-- 翻译切换按钮 -->
            <button 
              type="button"
              v-if="hasTranslation"
              class="control-btn translation-btn" 
              :class="{ active: showTranslation }" 
              @click="toggleTranslation" 
              :title="showTranslation ? '隐藏翻译' : '显示翻译'"
              :aria-label="showTranslation ? '隐藏翻译' : '显示翻译'"
              :aria-pressed="showTranslation"
            >
              <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor">
                <path d="M140 188h584v164h92V144c0-17.7-14.3-32-32-32H96c-17.7 0-32 14.3-32 32v736c0 17.7 14.3 32 32 32h232v-92H140V188z"/>
                <path d="M414.3 256h-60.6c-3.4 0-6.4 2.2-7.6 5.4L219 629.4c-.3.8-.4 1.7-.4 2.6 0 4.4 3.6 8 8 8h55.1c3.4 0 6.4-2.2 7.6-5.4L322 540h196.2l32.7 94.6c1.3 3.2 4.3 5.4 7.6 5.4H614c4.4 0 8-3.6 8-8 0-.9-.1-1.8-.4-2.6L494.3 261.4c-1.3-3.2-4.3-5.4-7.6-5.4zM353.7 447L420 277.7 486.3 447H353.7z"/>
                <path d="M936 528H800v-93c0-4.4-3.6-8-8-8h-56c-4.4 0-8 3.6-8 8v93H592c-13.3 0-24 10.7-24 24v176c0 13.3 10.7 24 24 24h136v152c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8V752h136c13.3 0 24-10.7 24-24V552c0-13.3-10.7-24-24-24zM888 704H728V576h160v128z"/>
              </svg>
              <span>翻译</span>
            </button>
          </div>
          <div class="lyric-quality-status" role="status">
            <span>{{ qualityMessage || qualityStatus }}</span>
            <button v-if="qualityMessage" type="button" @click="$emit('retry-quality')">重试</button>
          </div>
        </div>
      </div>

      <!-- 右侧歌词 -->
      <div class="lyrics-section">
        <Transition :name="trackTransitionName" @before-leave="retireTrackLayer">
        <div :key="lyricContentKey" class="lyrics-container track-piece track-lyrics" ref="lyricsContainer">
          <div v-if="!lyrics" class="lyric-loading" role="status">正在加载歌词…</div>
          
          <!-- 所有歌词行，通过transform控制位置实现动画 -->
          <div 
            v-for="(line, index) in (lyrics ? parsedLyrics : [])"
            :key="index"
            class="lyric-line"
            :class="{ 
              'current': !isBridgeActive && index === currentLyricIndex,
              'played': index < currentLyricIndex || (isBridgeActive && index === bridgeInfo?.startLyricIndex),
              'upcoming': index > currentLyricIndex || (isBridgeActive && bridgeInfo?.startLyricIndex === -1),
              'has-translation': showTranslation && line.translation
            }"
            :style="getLyricLineStyle(index)"
            :ref="createLyricLineRef(index, lyricContentKey)"
          >
            <!-- 主要歌词（原文） -->
            <div class="main-lyric">
              <div class="lyric-text">
              <!-- 渲染歌词内容 -->
              <template v-if="line.words && line.words.length > 0">
                <template v-for="(word, wordIndex) in line.words" :key="wordIndex">
                  <template v-for="(char, charIdx) in word.word.split('')" :key="`${wordIndex}-${charIdx}`">
                    <span 
                      v-if="char === ' '"
                      class="lyric-word karaoke-char is-space"
                      :data-word-index="wordIndex"
                      :data-line-index="index"
                      :data-start="word.startTime"
                      :data-end="word.endTime"
                      :data-line-start="line.time"
                      :style="{ display: 'inline-block', width: '0.25em', minWidth: '0.25em' }"
                    >&#8203;</span>
                    <span 
                      v-else
                      class="lyric-word karaoke-char"
                      :data-word-index="wordIndex"
                      :data-line-index="index"
                      :data-start="word.startTime"
                      :data-end="word.endTime"
                      :data-line-start="line.time"
                    >{{ char }}</span>
                  </template>
                </template>
              </template>
              <template v-else>
                <template v-for="(char, charIndex) in line.text" :key="charIndex">
                  <span 
                    v-if="char === ' '"
                    class="lyric-char karaoke-char is-space"
                    :data-char-index="charIndex"
                    :data-line-index="index"
                    :style="{ display: 'inline-block', width: '0.25em', minWidth: '0.25em' }"
                  >&#8203;</span>
                  <span 
                    v-else
                    class="lyric-char karaoke-char"
                    :data-char-index="charIndex"
                    :data-line-index="index"
                  >{{ char }}</span>
                </template>
              </template>
              </div>
            </div>
            
            <!-- 翻译歌词 -->
            <div 
              v-if="showTranslation && line.translation" 
              class="translation-lyric"
            >
              {{ line.translation }}
            </div>
          </div>

          <!-- 桥段进度条（覆盖在正在播放的歌词位置） -->
          <transition name="bridge-fade">
            <div 
              v-if="lyrics && isBridgeActive && bridgeInfo"
              class="bridge-progress-bar overlay"
              :style="{
                transform: `translate(-50%, -50%) scaleX(${Math.max(0.05, (100 - bridgeProgress) / 100)})`,
                backgroundColor: getBridgeProgressColor()
              }"
            ></div>
          </transition>

        </div>
        </Transition>
      </div>

      <!-- 关闭按钮 -->
      <button ref="closeButton" type="button" class="close-btn" @click="closeLyricView" aria-label="收起歌词" title="收起歌词">
        <svg viewBox="0 0 1024 1024" width="24" height="24" fill="currentColor">
          <path d="M511.744 716.288l-316.8-316.672a32 32 0 0 1 45.248-45.248l271.488 271.36 272-271.808a32 32 0 0 1 45.312 45.248l-317.248 317.12z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script src="./LyricView.js"></script>

<style src="./styles/LyricView.css" scoped></style>
