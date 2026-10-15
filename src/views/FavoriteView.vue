<template>
  <div class="favorite-view list-page" :aria-busy="loading">
    <div class="list-content">
      <header class="collection-hero">
        <ArtworkCover :src="favoriteList.find(song => song.cover)?.cover || ''" class="collection-art" mark="♥" />
        <div class="collection-copy">
          <p class="eyebrow">{{ isPlaylistView ? 'PLAYLIST / 我的歌单' : 'MY COLLECTION / 音乐收藏' }}</p>
          <h1 class="page-title">{{ pageTitle }}</h1>
          <p class="collection-description">{{ isPlaylistView ? '把此刻的心情，留在这一张歌单里。' : '反复聆听的旋律，组成属于你的音乐收藏。' }}</p>
          <div class="collection-meta"><span>{{ favoriteList.length }} 首歌曲</span><span>{{ isPlaylistView ? '我的歌单' : '我喜欢' }}</span></div>
          <div class="collection-actions"><button type="button" class="play-all-btn" :disabled="favoriteList.length === 0" @click="playAll"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>播放全部</button>
            <button type="button" class="action-btn" :disabled="loading" @click="loadFavorites(true)">{{ loading ? '刷新中…' : '刷新歌单' }}</button></div>
        </div>
      </header>

      <div class="section-heading"><h2>曲目</h2><span>每一首，都是喜欢的理由</span></div>

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
        <button type="button" class="primary-btn" @click="goToDiscover">
          去发现音乐
        </button>
      </div>

      <!-- 歌曲列表 -->
      <div v-else class="song-list">
        <div class="list-header">
          <div class="col-index"><button type="button" class="sort-button" @click="toggleSortOrder" :aria-label="'切换曲目顺序，当前' + (sortOrder === 'desc' ? '倒序' : sortOrder === 'asc' ? '正序' : '原始顺序')">
            <span>#</span>
            <span class="sort-arrow" v-if="sortOrder === 'asc'">↑</span>
            <span class="sort-arrow" v-else-if="sortOrder === 'desc'">↓</span>
            <span class="sort-arrow" v-else>↕</span>
          </button></div>
          <div class="col-title">歌曲</div>
          <div class="col-artist">歌手</div>
          <div class="col-album">专辑</div>
          <div class="col-duration">时长</div>
          <div class="col-actions-label"><span class="visually-hidden">操作</span></div>
        </div>

        <div
          v-for="(song, index) in sortedFavoriteList"
          :key="song.hash"
          class="song-item"
          :class="{ playing: isCurrentlyPlaying(song) }"
          :aria-current="isCurrentlyPlaying(song) ? 'true' : undefined"
          @dblclick="playSong(song)"
          @contextmenu.prevent.stop="showContextMenu($event, song)"
        >
          <div class="col-index">
            <span class="index-number">{{ String(index + 1).padStart(2, '0') }}</span>
          </div>

          <div class="col-title">
            <ArtworkCover :src="song.cover || ''" class="song-cover" />
            <div class="song-info">
              <button type="button" class="song-name" @click.stop="playSong(song)" @dblclick.stop :title="getSongName(song.name)">
                {{ getSongName(song.name) }}
                <span v-if="song.relate_goods && song.relate_goods.some(g => g.level >= 5)" class="quality-badge">SQ</span>
              </button>
              <button type="button" class="artist-link mobile-artist" @click.stop="goArtist(song)" @dblclick.stop>{{ getSingerNames(song.singerinfo, song) || song.singername || song.author_name || (song.name?.includes(' - ') ? song.name.split(' - ')[0] : '未知歌手') }}</button>
            </div>
          </div>

          <div class="col-artist">
            <button type="button" class="artist-link" @click.stop="goArtist(song)" @dblclick.stop>
              {{ getSingerNames(song.singerinfo, song) || song.singername || song.author_name || (song.name && song.name.includes(' - ') ? song.name.split(' - ')[0] : '-') }}
            </button>
          </div>
    <div class="col-album"><button type="button" class="album-link" @click.stop="goAlbum(song)" @dblclick.stop>{{ song.albuminfo?.name || song.remark || '-' }}</button></div>
          <div class="col-duration">{{ formatDuration(song.timelen) }}</div>
            <div class="action-buttons">
              <button type="button" class="icon-btn play-btn-inline" @click.stop="playSong(song)" title="播放歌曲" @dblclick.stop>
                <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                  <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
                </svg>
              </button>
              <button type="button" v-if="!isPlaylistView" class="icon-btn favorite-btn active" @click.stop="removeFavorite(song)" title="取消收藏" @dblclick.stop>
                <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                  <path d="M923 283.6a260.04 260.04 0 00-56.9-82.8 264.4 264.4 0 00-84-55.5A265.34 265.34 0 00679.7 125c-49.3 0-97.4 13.5-139.2 39-10 6.1-19.5 12.8-28.5 20.1-9-7.3-18.5-14-28.5-20.1-41.8-25.5-89.9-39-139.2-39-35.5 0-69.9 6.8-102.4 20.3-31.4 13-59.7 31.7-84 55.5a258.44 258.44 0 00-56.9 82.8c-13.9 32.3-21 66.6-21 101.9 0 33.3 6.8 68 20.3 103.3 11.3 29.5 27.5 60.1 48.2 91 32.8 48.9 77.9 99.9 133.9 151.6 92.8 85.7 184.7 144.9 188.6 147.3l23.7 15.2c10.5 6.7 24 6.7 34.5 0l23.7-15.2c3.9-2.5 95.7-61.6 188.6-147.3 56-51.7 101.1-102.7 133.9-151.6 20.7-30.9 37-61.5 48.2-91 13.5-35.3 20.3-70 20.3-103.3.1-35.3-7-69.6-20.9-101.9z"/>
                </svg>
              </button>
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
  </div>
</template>

<script src="./logic/FavoriteView.js"></script>

<style src="./styles/ListPage.css" scoped></style>

<style src="./styles/FavoriteView.css" scoped></style>
