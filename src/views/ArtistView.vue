<template>
  <div class="artist-view list-page">
    <div class="list-content">
      <template v-if="artist">
        <div v-if="errorMessage" class="refresh-error" role="alert"><span>{{ errorMessage }}</span><button type="button" :disabled="initialLoading" @click="loadInitial">重试</button></div>
        <header class="collection-hero">
          <ArtworkCover :src="getAvatar(artist)" class="collection-art" mark="♪" />
          <div class="collection-copy">
            <p class="eyebrow">THE ARTIST / 歌手</p>
            <h1 class="page-title">{{ artist.author_name || artist.name }}</h1>
            <p class="collection-description">从熟悉的代表作，到值得珍藏的每一首。</p>
            <div class="collection-meta"><span>歌手</span><span v-if="artist.fans_cnt">{{ formatNumber(artist.fans_cnt) }} 位粉丝</span></div>
            <div class="collection-actions"><button type="button" class="action-btn" :aria-pressed="followed" @click="toggleFollow">{{ followed ? '已关注' : '＋ 关注歌手' }}</button></div>
          </div>
        </header>

        <!-- Tabs -->
        <div class="tabs">
          <button type="button" :class="{active: activeTab==='hot'}" :aria-pressed="activeTab==='hot'" @click="activeTab='hot'">热门歌曲</button>
          <button type="button" :class="{active: activeTab==='songs'}" :aria-pressed="activeTab==='songs'" @click="activeTab='songs'">单曲</button>
          <button type="button" :class="{active: activeTab==='albums'}" :aria-pressed="activeTab==='albums'" @click="activeTab='albums'">专辑</button>
          <button type="button" :class="{active: activeTab==='about'}" :aria-pressed="activeTab==='about'" @click="activeTab='about'">资料</button>
        </div>

        <!-- 热门歌曲（10 首） -->
        <div v-if="activeTab==='hot'" class="song-list">
          <div class="list-header">
            <div class="col-index">#</div>
            <div class="col-title">歌曲</div>
            <div class="col-artist">歌手</div>
            <div class="col-album">专辑</div>
            <div class="col-duration">时长</div>
          <div class="col-actions-label"><span class="visually-hidden">操作</span></div>
          </div>
          <div v-for="(song, idx) in hotSongs" :key="song.hash || idx" class="song-item" :class="{ playing: !!song.hash && currentSong?.hash === song.hash }" :aria-current="song.hash && currentSong?.hash === song.hash ? 'true' : undefined" @dblclick="play(song)">
            <div class="col-index">
              <span class="index-number">{{ String(idx + 1).padStart(2, '0') }}</span>
            </div>
            <div class="col-title">
              <ArtworkCover :src="song.cover || ''" class="song-cover" />
              <div class="song-info">
                <div class="song-title-line">
                  <button type="button" class="song-name" @click.stop="$emit('search', song)" @dblclick.stop :title="getSongName(song.name)">
                    {{ getSongName(song.name) }}
                    <span v-if="song.relate_goods && song.relate_goods.some(g => g.level >= 5)" class="quality-badge">SQ</span>
                  </button>
                  <SongBadges :song="song" />
                </div>
                <ArtistLinks class="artist-link mobile-artist" :song="song" @select="$emit('navigate', 'artist', $event)" />
              </div>
            </div>
            <div class="col-artist">
              <ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" />
            </div>
            <div class="col-album">
              <button type="button" class="album-link" @click.stop="goAlbum(song)" @dblclick.stop>{{ song.albuminfo?.name || song.remark || '-' }}</button>
            </div>
            <div class="col-duration">{{ formatDuration(song.timelen) }}</div>
            <div class="action-buttons">
                <button type="button" class="icon-btn play-btn-inline" @click.stop="play(song)" title="播放" @dblclick.stop>
                  <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                    <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
                  </svg>
                </button>
              </div>
          </div>
          <div v-if="initialLoadComplete && hotSongs.length === 0" class="empty"><p>暂无热门歌曲</p></div>
          <div v-else-if="!initialLoadComplete" class="loading-container"><span class="loading-spinner" role="status" aria-label="加载中"></span><p>正在加载热门歌曲…</p></div>
        </div>

        <!-- 单曲（无限滚动） -->
        <div v-else-if="activeTab==='songs'" class="song-list" ref="scrollArea">
          <div class="list-header">
            <div class="col-index">#</div>
            <div class="col-title">歌曲</div>
            <div class="col-artist">歌手</div>
            <div class="col-album">专辑</div>
            <div class="col-duration">时长</div>
          <div class="col-actions-label"><span class="visually-hidden">操作</span></div>
          </div>
          <div v-for="(song, idx) in songs" :key="song.hash || idx" class="song-item" :class="{ playing: !!song.hash && currentSong?.hash === song.hash }" :aria-current="song.hash && currentSong?.hash === song.hash ? 'true' : undefined" @dblclick="play(song)">
            <div class="col-index">
              <span class="index-number">{{ String(idx + 1).padStart(2, '0') }}</span>
            </div>
            <div class="col-title">
              <ArtworkCover :src="song.cover || ''" class="song-cover" />
              <div class="song-info">
                <div class="song-title-line">
                  <button type="button" class="song-name" @click.stop="$emit('search', song)" @dblclick.stop :title="getSongName(song.name)">
                    {{ getSongName(song.name) }}
                    <span v-if="song.relate_goods && song.relate_goods.some(g => g.level >= 5)" class="quality-badge">SQ</span>
                  </button>
                  <SongBadges :song="song" />
                </div>
                <ArtistLinks class="artist-link mobile-artist" :song="song" @select="$emit('navigate', 'artist', $event)" />
              </div>
            </div>
            <div class="col-artist">
              <ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" />
            </div>
            <div class="col-album">
              <button type="button" class="album-link" @click.stop="goAlbum(song)" @dblclick.stop>{{ song.albuminfo?.name || song.remark || '-' }}</button>
            </div>
            <div class="col-duration">{{ formatDuration(song.timelen) }}</div>
            <div class="action-buttons">
                <button type="button" class="icon-btn play-btn-inline" @click.stop="play(song)" title="播放" @dblclick.stop>
                  <svg viewBox="0 0 1024 1024" width="16" height="16" fill="currentColor">
                    <path d="M719.4 499.1l-296.1-215A15.9 15.9 0 00398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 000-25.8z"/>
                  </svg>
                </button>
              </div>
          </div>
          <div ref="sentinel" class="sentinel" />
          <div v-if="loadingMore" class="loading" role="status">加载中...</div>
          <div v-else-if="songs.length === 0" class="empty"><p>暂无单曲</p></div>
        </div>

        <!-- 专辑列表 -->
        <div v-else-if="activeTab==='albums'" class="albums">
          <button type="button" class="album-item" v-for="(al, i) in albums" :key="al.album_id || i" @click="openAlbum(al)">
            <ArtworkCover :src="getAlbumCover(al) || ''" class="album-cover" />
            <div class="album-meta">
              <div class="album-name">{{ al.album_name || al.name }}</div>
              <div class="album-date">{{ al.publish_date || '' }}</div>
            </div>
          </button>
          <div v-if="albumsLoading" class="loading" role="status">加载中...</div>
          <div v-else-if="albums.length === 0" class="empty"><p>暂无专辑</p></div>
        </div>

        <!-- 资料 -->
        <div v-else class="about">
          <pre class="about-text">{{ pretty(artist) }}</pre>
        </div>
      </template>
      <div v-else-if="initialLoadComplete" class="error" role="alert">
      <p class="empty-text">暂时无法打开歌手资料</p>
      <p>{{ errorMessage }}</p>
      <button type="button" class="retry-btn" :disabled="initialLoading" @click="loadInitial">{{ initialLoading ? '正在重试…' : '重试' }}</button>
    </div>
      <div v-else class="loading-container">
      <span class="loading-spinner" role="status" aria-label="加载中"></span>
      <p>加载中...</p>
    </div>
    </div>
  </div>
</template>

<script src="./logic/ArtistView.js"></script>

<style src="./styles/ListPage.css" scoped></style>

<style src="./styles/ArtistView.css" scoped></style>
