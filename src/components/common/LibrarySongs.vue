<template>
  <section class="library-songs list-page" :aria-label="label">
    <div v-if="songs.length && showToolbar" class="library-toolbar">
      <label v-if="selectionMode"><input type="checkbox" aria-label="选择全部已加载歌曲" :checked="selectedSongs.length === songs.length" :indeterminate="selectedSongs.length > 0 && selectedSongs.length < songs.length" @change="selectAll($event.target.checked)">已选择 {{ selectedSongs.length }} 首</label>
      <span v-else>{{ songs.length }} 首{{ total != null ? ` / 共 ${total} 首` : '' }}</span>
      <div class="library-toolbar-actions">
        <button type="button" class="action-btn" :disabled="selectionMode && !selectedSongs.length" @click="$emit('play-all', selectionMode ? selectedSongs : songs)">{{ selectionMode ? '播放所选' : '播放已加载歌曲' }}</button>
        <button v-if="selectionMode" type="button" class="action-btn" :disabled="!selectedSongs.length" @click="$emit('add-to-playlist', selectedSongs)">添加到歌单</button>
        <button v-if="selectionMode" type="button" class="action-btn" :disabled="!selectedSongs.length" @click="$emit('download', selectedSongs)">下载所选</button>
        <button v-if="selectionMode" type="button" class="action-btn selection-toggle" @click="finishSelection(true)">完成</button>
        <button v-else ref="selectionToggle" type="button" class="action-btn selection-toggle" @click="startSelection">批量操作</button>
      </div>
    </div>
    <WindowedList class="song-list" :items="songs" item-key="hash" :threshold="200" scroll-container-selector=".library-page, .song-panel-body">
      <template #header>
        <div class="list-header">
          <div class="col-index">#</div><div class="col-title">歌曲</div><div class="col-artist">歌手</div>
          <div class="col-album">专辑</div><div class="col-duration">时长</div><div class="col-actions-label"><span class="visually-hidden">操作</span></div>
        </div>
      </template>
      <template #default="{ item: song, index }">
        <div class="library-song song-item" :data-window-index="index" :class="{ playing: sameSong(song, currentSong), 'is-striped': index % 2 === 1 }" :aria-current="sameSong(song, currentSong) ? 'true' : undefined" @dblclick="$emit('play', song)">
          <div class="col-index">
            <input v-if="selectionMode" type="checkbox" :aria-label="`选择 ${title(song)}`" :checked="selectedKeys.includes(selectionKey(song, index))" @change="selectSong(song, index, $event.target.checked)" @click.stop @dblclick.stop>
            <span v-else class="index-number">{{ String(index + 1).padStart(2, '0') }}</span>
          </div>
          <div class="col-title">
            <ArtworkCover :src="song.cover || song.sizable_cover || song.imgurl || ''" class="song-cover" />
            <div class="song-info"><div class="song-title-line"><button type="button" class="song-name" @click.stop="$emit('search', song)" @dblclick.stop>{{ title(song) }}</button><SongBadges :song="song" /></div><ArtistLinks class="artist-link mobile-artist" :song="song" @select="$emit('navigate', 'artist', $event)" /></div>
          </div>
          <div class="col-artist"><ArtistLinks class="artist-link" :song="song" @select="$emit('navigate', 'artist', $event)" /></div>
          <div class="col-album"><button type="button" class="album-link" :disabled="!albumId(song)" @click.stop="$emit('navigate', 'album', { id: albumId(song), name: song.album_name })" @dblclick.stop>{{ song.album_name || '—' }}</button></div>
          <span class="col-duration">{{ duration(song) }}</span>
          <div class="action-buttons">
            <button class="icon-btn play-btn-inline" type="button" :aria-label="`播放 ${title(song)}`" @click.stop="$emit('play', song)" @dblclick.stop><svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg></button>
            <button type="button" class="icon-btn favorite-btn" :class="{ active: library?.isFavorite(song) }" :aria-pressed="library?.isFavorite(song) || false" :aria-busy="library?.isFavoritePending(song)" :disabled="library?.isFavoritePending(song) || (library && !library.canWrite)" :title="library && !library.canWrite ? '登录并联网后可收藏' : '收藏歌曲'" :aria-label="library?.isFavorite(song) ? '取消收藏' : '收藏歌曲'" @click.stop="$emit('toggle-favorite', song)" @dblclick.stop><svg viewBox="0 0 24 24" width="17" height="17" :fill="library?.isFavorite(song) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" /></svg></button>
            <button type="button" class="icon-btn row-more" :aria-label="`${title(song)}的更多操作`" :aria-expanded="menuSong === song" @click.stop="openMenu($event, song)" @dblclick.stop><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg></button>
          </div>
        </div>
      </template>
    </WindowedList>
    <ContextMenu :visible="!!menuSong" :position="menuPosition" :items="menuItems" @close="closeMenu" />
  </section>
</template>

<script>
import ArtworkCover from './ArtworkCover.vue'
import ArtistLinks from './ArtistLinks.vue'
import SongBadges from './SongBadges.vue'
import WindowedList from './WindowedList.vue'
import ContextMenu from './ContextMenu.vue'
import contextMenuManager from '../../utils/contextMenuManager.js'
import { getSongSearchKeyword } from '../../utils/songMetadata.js'
import { librarySongKey } from '../../utils/libraryMetadata.js'

export default {
  name: 'LibrarySongs',
  components: { ArtworkCover, ArtistLinks, SongBadges, WindowedList, ContextMenu },
  inject: { library: { from: 'musicLibrary', default: null } },
  props: { songs: { type: Array, default: () => [] }, currentSong: { type: Object, default: null },
    total: { type: Number, default: null }, label: { type: String, default: '歌曲列表' }, showToolbar: { type: Boolean, default: true },
    selectionScope: { type: [String, Number], default: '' } },
  emits: ['play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details'],
  data() { return { menuSong: null, menuPosition: { x: 0, y: 0 }, selectionMode: false, selectedKeys: [] } },
  computed: {
    selectionRows() { return this.songs.slice() },
    selectedSongs() { return this.songs.filter((song, index) => this.selectedKeys.includes(this.selectionKey(song, index))) },
    menuItems() {
      const song = this.menuSong
      if (!song) return []
      return [['下一首播放', 'play-next'], ['添加到歌单', 'add-to-playlist'], ['下载', 'download'], ['分享', 'share'], ['评论与其他版本', 'show-details']]
        .map(([label, event]) => ({ label, action: () => this.$emit(event, song) }))
    }
  },
  watch: {
    selectionScope: { flush: 'sync', handler() { this.finishSelection(); this.closeMenu() } },
    showToolbar(visible) { if (!visible) this.finishSelection() },
    selectionRows: {
      flush: 'sync',
      handler(rows, previous) {
        // Appending a page preserves deliberate picks; filtering, reordering or replacing rows starts fresh.
        if (rows.length < previous.length || previous.some((song, index) => song !== rows[index])) this.finishSelection()
        this.closeMenu()
      }
    }
  },
  deactivated() { this.finishSelection(); this.closeMenu() },
  beforeUnmount() { this.closeMenu() },
  methods: {
    startSelection() { this.selectedKeys = []; this.selectionMode = true },
    finishSelection(restoreFocus = false) {
      this.selectedKeys = []
      this.selectionMode = false
      if (restoreFocus) this.$nextTick(() => this.$refs.selectionToggle?.focus())
    },
    selectionKey(song, index) { return `${librarySongKey(song)}:${song.fileid ?? ''}:${index}` },
    selectSong(song, index, selected) {
      if (!this.selectionMode || this.songs[index] !== song) return
      const key = this.selectionKey(song, index)
      this.selectedKeys = selected ? [...new Set([...this.selectedKeys, key])] : this.selectedKeys.filter(item => item !== key)
    },
    selectAll(selected) { if (this.selectionMode) this.selectedKeys = selected ? this.songs.map((song, index) => this.selectionKey(song, index)) : [] },
    title(song) { return getSongSearchKeyword(song) || song.name || song.filename || '未知歌曲' },
    albumId(song) { return song.album_id ?? song.AlbumID ?? song.albumid ?? null },
    sameSong(song, current) { const key = librarySongKey(song); return !!key && key === librarySongKey(current) },
    duration(song) { const seconds = Number(song.duration || (song.timelen || 0) / 1000); return seconds > 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—' },
    openMenu(event, song) {
      contextMenuManager.closeActiveMenu()
      const rect = event.currentTarget.getBoundingClientRect()
      this.menuSong = song
      this.menuPosition = { x: rect.right, y: rect.bottom }
      contextMenuManager.registerMenu(this.closeMenu)
    },
    closeMenu() { this.menuSong = null; contextMenuManager.unregisterMenu(this.closeMenu) }
  }
}
</script>

<style src="../../views/styles/ListPage.css" scoped></style>
<style scoped>
.library-songs { min-width: 0; background: transparent; }
.library-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px 18px; margin: 18px 0; color: var(--color-text-secondary); font-size: var(--font-size-xs); }
.library-toolbar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.library-toolbar .action-btn { min-height: 32px; padding: 6px 12px; font-size: var(--font-size-xs); }
.library-toolbar .selection-toggle { color: var(--color-primary); }
.library-toolbar label { display: flex; align-items: center; gap: 8px; }
.library-songs input[type=checkbox] { width: 15px; height: 15px; margin: 0; accent-color: var(--color-primary); cursor: pointer; }
.library-songs input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
</style>
