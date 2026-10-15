<template>
  <div class="favorite-view" :aria-busy="loading">
    <div class="page-header">
      <h1 class="page-title">{{ pageTitle }}</h1>
      <div class="header-actions">
        <button type="button" class="action-btn" :disabled="favoriteList.length === 0" @click="playAll">
          <svg viewBox="0 0 1024 1024" width="18" height="18" fill="currentColor">
            <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
            <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8zm-257.6 134V390.9L628.5 512 461.8 633.1z"/>
          </svg>
          播放全部
        </button>
        <button type="button" class="action-btn" :disabled="loading" @click="loadFavorites(true)">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="errorMessage && favoriteList.length > 0" class="refresh-error" role="alert">
      <span>{{ errorMessage }}</span>
      <button type="button" class="action-btn" :disabled="loading" @click="loadFavorites(true)">重试</button>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading && favoriteList.length === 0" class="loading-container">
      <span class="loading-spinner" role="status" aria-label="加载中"></span>
      <p>加载中...</p>
    </div>

    <!-- 加载失败 -->
    <div v-else-if="errorMessage && favoriteList.length === 0" class="empty-state" role="alert">
      <p class="empty-text">无法打开{{ pageTitle }}</p>
      <p class="empty-hint">{{ errorMessage }}</p>
      <button type="button" class="primary-btn" @click="loadFavorites(true)">重试</button>
    </div>

    <!-- 空状态 -->
    <div v-else-if="favoriteList.length === 0" class="empty-state">
      <svg viewBox="0 0 1024 1024" width="80" height="80" fill="currentColor" opacity="0.3">
        <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
      </svg>
      <p class="empty-text">{{ isPlaylistView ? '歌单里还没有歌曲' : '还没有收藏的歌曲' }}</p>
      <p class="empty-hint">{{ isPlaylistView ? '稍后刷新看看，或去发现更多音乐' : '去发现页面找些喜欢的音乐吧' }}</p>
      <button class="primary-btn" @click="goToDiscover">
        去发现音乐
      </button>
    </div>

    <!-- 歌曲列表 -->
    <div v-else class="song-list">
      <div class="list-header">
        <div class="col-index" @click="toggleSortOrder">
          <span>#</span>
          <span class="sort-arrow" v-if="sortOrder === 'asc'">↑</span>
          <span class="sort-arrow" v-else-if="sortOrder === 'desc'">↓</span>
          <span class="sort-arrow" v-else>↕</span>
        </div>
        <div class="col-title">歌曲</div>
        <div class="col-artist">歌手</div>
        <div class="col-album">专辑</div>
        <div class="col-duration">时长</div>
      </div>

      <div 
        v-for="(song, index) in sortedFavoriteList" 
        :key="song.hash"
        class="song-item"
        :class="{ playing: isCurrentlyPlaying(song) }"
        @dblclick="playSong(song)"
        @contextmenu.prevent.stop="showContextMenu($event, song)"
      >
        <div class="col-index">
          <span class="index-number">{{ index + 1 }}</span>
        </div>

        <div class="col-title">
          <img v-if="song.cover" :src="song.cover.replace('{size}', '400')" class="song-cover" :alt="song.name" />
          <div class="song-info">
            <div class="song-name">
              {{ getSongName(song.name) }}
              <span v-if="song.relate_goods && song.relate_goods.some(g => g.level >= 5)" class="quality-badge">SQ</span>
            </div>
          </div>
        </div>

        <div class="col-artist">
          <span class="artist-link" @click.stop="goArtist(song)">
            {{ getSingerNames(song.singerinfo, song) || song.singername || song.author_name || (song.name && song.name.includes(' - ') ? song.name.split(' - ')[0] : '-') }}
          </span>
        </div>
  <div class="col-album"><span class="album-link" @click.stop="goAlbum(song)">{{ song.albuminfo?.name || song.remark || '-' }}</span></div>
        <div class="col-duration">
          {{ formatDuration(song.timelen) }}
          <div class="action-buttons">
            <button class="icon-btn play-btn-inline" @click.stop="playSong(song)" :title="isCurrentlyPlaying(song) ? '暂停' : '播放'">
              <svg v-if="isCurrentlyPlaying(song)" viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                <path d="M304 176h80v672h-80zm336 0h80v672h-80z"/>
              </svg>
              <svg v-else viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
              </svg>
            </button>
            <button v-if="!isPlaylistView" class="icon-btn favorite-btn active" @click.stop="removeFavorite(song)" title="取消收藏">
              <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 右键菜单 -->
    <ContextMenu
      :visible="contextMenuVisible"
      :position="contextMenuPosition"
      :items="contextMenuItems"
      @close="closeContextMenu"
    />
  </div>
</template>

<script src="./logic/FavoriteView.js"></script>

<style src="./styles/FavoriteView.css" scoped></style>
