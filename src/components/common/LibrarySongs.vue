<template>
  <section class="library-songs" :aria-label="label">
    <div v-if="songs.length && showToolbar" class="library-toolbar">
      <label><input type="checkbox" :checked="selectedSongs.length === songs.length && songs.length > 0" :indeterminate="selectedSongs.length > 0 && selectedSongs.length < songs.length" @change="selectAll($event.target.checked)"> {{ selectedSongs.length ? `已选择 ${selectedSongs.length} 首` : `${songs.length} 首${total != null ? ` / 共 ${total} 首` : ''}` }}</label>
      <div><button type="button" @click="$emit('play-all', selectedSongs.length ? selectedSongs : songs)">{{ selectedSongs.length ? '播放所选' : '播放已加载歌曲' }}</button><button v-if="selectedSongs.length" type="button" @click="$emit('add-to-playlist', selectedSongs)">添加到歌单</button><button type="button" @click="$emit('download', selectedSongs.length ? selectedSongs : songs)">{{ selectedSongs.length ? '下载所选' : '批量下载' }}</button></div>
    </div>
    <WindowedList :items="songs" item-key="hash" :threshold="200" scroll-container-selector=".library-page, .song-panel-body">
      <template #default="{ item: song, index }">
        <div class="library-song song-item" :data-window-index="index" :class="{ playing: sameSong(song, currentSong), 'with-selection': showToolbar }" :aria-current="sameSong(song, currentSong) ? 'true' : undefined" @dblclick="$emit('play', song)">
          <input v-if="showToolbar" type="checkbox" :aria-label="`选择 ${title(song)}`" :checked="selectedKeys.includes(selectionKey(song, index))" @change="selectSong(song, index, $event.target.checked)" @click.stop @dblclick.stop>
          <button class="row-play play-btn-inline" type="button" :aria-label="`播放 ${title(song)}`" @click.stop="$emit('play', song)" @dblclick.stop>{{ String(index + 1).padStart(2, '0') }}<span aria-hidden="true">▶</span></button>
          <ArtworkCover :src="song.cover || song.sizable_cover || song.imgurl || ''" class="row-cover" />
          <div class="row-copy"><div class="row-title"><button type="button" class="song-name" @click.stop="$emit('search', song)" @dblclick.stop>{{ title(song) }}</button><SongBadges :song="song" /></div><ArtistLinks :song="song" @select="$emit('navigate', 'artist', $event)" /></div>
          <button type="button" class="row-album" :disabled="!albumId(song)" @click.stop="$emit('navigate', 'album', { id: albumId(song), name: song.album_name })" @dblclick.stop>{{ song.album_name || '—' }}</button>
          <span class="row-duration">{{ duration(song) }}</span>
          <button type="button" class="row-favorite" :class="{ active: library?.isFavorite(song) }" :aria-pressed="library?.isFavorite(song) || false" :disabled="library?.isFavoritePending(song) || (library && !library.canWrite)" :title="library && !library.canWrite ? '登录并联网后可收藏' : '收藏歌曲'" :aria-label="library?.isFavorite(song) ? '取消收藏' : '收藏歌曲'" @click.stop="$emit('toggle-favorite', song)" @dblclick.stop>{{ library?.isFavoritePending(song) ? '…' : library?.isFavorite(song) ? '♥' : '♡' }}</button>
          <button type="button" class="row-more" :aria-label="`${title(song)}的更多操作`" :aria-expanded="menuSong === song" @click.stop="openMenu($event, song)" @dblclick.stop>···</button>
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
    total: { type: Number, default: null }, label: { type: String, default: '歌曲列表' }, showToolbar: { type: Boolean, default: true } },
  emits: ['play', 'play-all', 'play-next', 'navigate', 'search', 'toggle-favorite', 'add-to-playlist', 'download', 'share', 'show-details'],
  data() { return { menuSong: null, menuPosition: { x: 0, y: 0 }, selectedKeys: [] } },
  computed: {
    selectedSongs() { return this.songs.filter((song, index) => this.selectedKeys.includes(this.selectionKey(song, index))) },
    menuItems() {
      const song = this.menuSong
      if (!song) return []
      return [['下一首播放', 'play-next'], ['添加到歌单', 'add-to-playlist'], ['下载', 'download'], ['分享', 'share'], ['评论与其他版本', 'show-details']]
        .map(([label, event]) => ({ label, action: () => this.$emit(event, song) }))
    }
  },
  deactivated() { this.closeMenu() },
  beforeUnmount() { this.closeMenu() },
  methods: {
    selectionKey(song, index) { return `${song.sourceUserId || ''}:${song.hash || song.FileHash || ''}:${song.fileid || index}` },
    selectSong(song, index, selected) { const key = this.selectionKey(song, index); this.selectedKeys = selected ? [...new Set([...this.selectedKeys, key])] : this.selectedKeys.filter(item => item !== key) },
    selectAll(selected) { this.selectedKeys = selected ? this.songs.map((song, index) => this.selectionKey(song, index)) : [] },
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

<style scoped>
.library-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:20px 0;color:var(--color-text-secondary);font-size:12px}.library-toolbar>div{display:flex;gap:8px}.library-toolbar button,.row-more,.row-favorite{border:1px solid var(--color-border);border-radius:999px;background:transparent;color:var(--color-text);padding:8px 12px;cursor:pointer}.library-song{display:grid;grid-template-columns:34px 42px minmax(120px,1fr) minmax(70px,.45fr) 48px 36px 36px;gap:12px;align-items:center;min-height:76px;padding:10px 8px;border-bottom:1px solid var(--color-border);transition:background .2s,color .2s}.library-song:hover,.library-song.playing{background:var(--color-background-light)}.row-cover{width:42px;height:42px;border-radius:8px}.row-play{position:relative;background:none;border:0;color:var(--color-text-secondary);font-variant-numeric:tabular-nums;cursor:pointer}.row-play span{display:none}.row-play:hover{font-size:0}.row-play:hover span{display:inline;font-size:13px}.row-copy{min-width:0}.row-title{display:flex;align-items:center;gap:7px}.song-name,.row-album{border:0;background:none;padding:0;color:inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.song-name{font-size:14px;font-weight:600}.row-copy :deep(.artist-links){margin-top:5px;color:var(--color-text-secondary);font-size:12px}.row-album,.row-duration{font-size:12px;color:var(--color-text-secondary)}.row-duration{text-align:right;font-variant-numeric:tabular-nums}.row-more,.row-favorite{padding:6px;border:0;font-size:18px}.row-favorite.active{color:var(--color-primary)}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:2px solid var(--color-primary);outline-offset:3px}@media(max-width:760px){.library-song{grid-template-columns:28px 36px minmax(90px,1fr) 36px 32px;gap:8px}.row-cover{width:36px;height:36px}.row-album,.row-duration{display:none}.library-toolbar{align-items:flex-start;flex-wrap:wrap}}@media(prefers-reduced-motion:reduce){.library-song{transition:none}}
</style>
<style scoped>
.library-song.with-selection{grid-template-columns:18px 34px 42px minmax(120px,1fr) minmax(70px,.45fr) 48px 36px 36px}.library-song>input,.library-toolbar input{accent-color:var(--color-primary);cursor:pointer}.library-toolbar label{display:flex;align-items:center;gap:8px}.library-toolbar>div{flex-wrap:wrap}@media(max-width:760px){.library-song.with-selection{grid-template-columns:18px 28px 36px minmax(80px,1fr) 36px 32px;gap:7px}}
</style>
