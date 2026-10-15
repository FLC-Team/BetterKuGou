<template>
  <div class="artist-view" v-if="artist">
    <!-- 头部信息 -->
    <div class="artist-header">
      <img v-if="artist.avatar || artist.pic" :src="getAvatar(artist)" class="avatar" alt="avatar" />
      <div class="meta">
        <h1 class="name">{{ artist.author_name || artist.name }}</h1>
        <div class="stats">
          <span v-if="artist.fans_cnt">粉丝 {{ formatNumber(artist.fans_cnt) }}</span>
        </div>
        <div class="actions">
          <button class="primary-btn" :class="{ outline: followed }" @click="toggleFollow">
            {{ followed ? '已关注' : '关注' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button :class="{active: activeTab==='hot'}" @click="activeTab='hot'">热门歌曲</button>
      <button :class="{active: activeTab==='songs'}" @click="activeTab='songs'">单曲</button>
      <button :class="{active: activeTab==='albums'}" @click="activeTab='albums'">专辑</button>
      <button :class="{active: activeTab==='about'}" @click="activeTab='about'">资料</button>
    </div>

    <!-- 热门歌曲（10 首） -->
    <div v-if="activeTab==='hot'" class="song-list">
      <div class="list-header">
        <div class="col-index">#</div>
        <div class="col-title">歌曲</div>
        <div class="col-artist">歌手</div>
        <div class="col-album">专辑</div>
        <div class="col-duration">时长</div>
      </div>
      <div v-for="(song, idx) in hotSongs" :key="song.hash || idx" class="song-item" @dblclick="play(song)">
        <div class="col-index">
          <span class="index-number">{{ idx + 1 }}</span>
        </div>
        <div class="col-title">
          <img 
            v-if="song.cover" 
            :src="song.cover.replace('{size}','400')" 
            class="song-cover" 
            :alt="song.name"
            @load="onSongCoverLoad(song, $event)"
            @error="onSongCoverError(song, $event)" 
          />
          <div v-else class="song-cover-placeholder">
            <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor" opacity="0.3">
              <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zM288 421a48.01 48.01 0 0196 0 48.01 48.01 0 01-96 0zm224 272c-85.5 0-155.6-67.3-160-151.6a8 8 0 018-8.4h48c4.4 0 8.2 3.6 8 8-1.8 33.2 26.8 61 58 61s59.8-27.8 58-61c-.2-4.4 3.6-8 8-8h48a8 8 0 018 8.4C667.6 625.7 597.5 693 512 693zm176-272a48.01 48.01 0 0196 0 48.01 48.01 0 01-96 0z"/>
            </svg>
          </div>
          <div class="song-info">
            <div class="song-name">
              {{ getSongName(song.name) }}
              <span v-if="song.relate_goods && song.relate_goods.some(g => g.level >= 5)" class="quality-badge">SQ</span>
            </div>
          </div>
        </div>
        <div class="col-artist">
          <span class="artist-link" @click.stop="goArtist(song)">
            {{ getSingerNames(song.singerinfo, song) || artist.author_name || '-' }}
          </span>
        </div>
        <div class="col-album">
          <span class="album-link" @click.stop="goAlbum(song)">{{ song.albuminfo?.name || song.remark || '-' }}</span>
        </div>
        <div class="col-duration">
          {{ formatDuration(song.timelen) }}
          <div class="action-buttons">
            <button class="icon-btn play-btn-inline" @click.stop="play(song)" title="播放">
              <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 单曲（无限滚动） -->
    <div v-else-if="activeTab==='songs'" class="song-list" ref="scrollArea">
      <div class="list-header">
        <div class="col-index">#</div>
        <div class="col-title">歌曲</div>
        <div class="col-artist">歌手</div>
        <div class="col-album">专辑</div>
        <div class="col-duration">时长</div>
      </div>
      <div v-for="(song, idx) in songs" :key="song.hash || idx" class="song-item" @dblclick="play(song)">
        <div class="col-index">
          <span class="index-number">{{ idx + 1 }}</span>
        </div>
        <div class="col-title">
          <img 
            v-if="song.cover" 
            :src="song.cover.replace('{size}','400')" 
            class="song-cover" 
            :alt="song.name"
            @load="onSongCoverLoad(song, $event)"
            @error="onSongCoverError(song, $event)" 
          />
          <div v-else class="song-cover-placeholder">
            <svg viewBox="0 0 1024 1024" width="20" height="20" fill="currentColor" opacity="0.3">
              <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zM288 421a48.01 48.01 0 0196 0 48.01 48.01 0 01-96 0zm224 272c-85.5 0-155.6-67.3-160-151.6a8 8 0 018-8.4h48c4.4 0 8.2 3.6 8 8-1.8 33.2 26.8 61 58 61s59.8-27.8 58-61c-.2-4.4 3.6-8 8-8h48a8 8 0 018 8.4C667.6 625.7 597.5 693 512 693zm176-272a48.01 48.01 0 0196 0 48.01 48.01 0 01-96 0z"/>
            </svg>
          </div>
          <div class="song-info">
            <div class="song-name">
              {{ getSongName(song.name) }}
              <span v-if="song.relate_goods && song.relate_goods.some(g => g.level >= 5)" class="quality-badge">SQ</span>
            </div>
          </div>
        </div>
        <div class="col-artist">
          <span class="artist-link" @click.stop="goArtist(song)">
            {{ getSingerNames(song.singerinfo, song) || artist.author_name || '-' }}
          </span>
        </div>
        <div class="col-album">
          <span class="album-link" @click.stop="goAlbum(song)">{{ song.albuminfo?.name || song.remark || '-' }}</span>
        </div>
        <div class="col-duration">
          {{ formatDuration(song.timelen) }}
          <div class="action-buttons">
            <button class="icon-btn play-btn-inline" @click.stop="play(song)" title="播放">
              <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div ref="sentinel" class="sentinel" />
      <div v-if="loadingMore" class="loading">加载中...</div>
    </div>

    <!-- 专辑列表（简单占位） -->
    <div v-else-if="activeTab==='albums'" class="albums">
      <div class="album-item" v-for="(al, i) in albums" :key="al.album_id || i" @click="openAlbum(al)">
        <img 
          v-if="getAlbumCover(al)" 
          :src="getAlbumCover(al)" 
          class="album-cover" 
          :alt="al.album_name || al.name"
          @error="onAlbumCoverError"
        />
        <div v-else class="album-cover-placeholder">
          <svg viewBox="0 0 1024 1024" width="40" height="40" fill="currentColor" opacity="0.3">
            <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zM288 421a48.01 48.01 0 0196 0 48.01 48.01 0 01-96 0zm224 272c-85.5 0-155.6-67.3-160-151.6a8 8 0 018-8.4h48c4.4 0 8.2 3.6 8 8-1.8 33.2 26.8 61 58 61s59.8-27.8 58-61c-.2-4.4 3.6-8 8-8h48a8 8 0 018 8.4C667.6 625.7 597.5 693 512 693zm176-272a48.01 48.01 0 0196 0 48.01 48.01 0 01-96 0z"/>
          </svg>
        </div>
        <div class="album-meta">
          <div class="album-name">{{ al.album_name || al.name }}</div>
          <div class="album-date">{{ al.publish_date || '' }}</div>
        </div>
      </div>
      <div v-if="albumsLoading" class="loading">加载中...</div>
    </div>

    <!-- 资料 -->
    <div v-else class="about">
      <pre class="about-text">{{ pretty(artist) }}</pre>
    </div>
  </div>

  <div v-else class="loading-container">
    <span class="loading-spinner" role="status" aria-label="加载中"></span>
    <p>加载中...</p>
  </div>
</template>

<script src="./logic/ArtistView.js"></script>

<style src="./styles/ArtistView.css" scoped></style>
