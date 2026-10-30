<template>
  <div class="lyric-settings">
    <div class="lyric-group">
      <div class="lyric-row lyric-group-heading">
        <div><label for="lyric-library-enabled">曲目与歌词管理</label><p id="lyric-library-help">保存和管理曲目及歌词。关闭后不读取或自动保存歌词，已有数据仍会保留。</p></div>
        <label class="lyric-switch"><input id="lyric-library-enabled" type="checkbox" :checked="library.enabled !== false" :disabled="!available || managerProtected" aria-describedby="lyric-library-help" @change="setLibraryPreference('enabled', $event.target.checked)"><span></span></label>
      </div>
      <AnimatedDetails :open="true" class="lyric-library-options">
        <template #summary><span>保存与更新选项</span><span class="lyric-disclosure" aria-hidden="true">⌄</span></template>
        <fieldset class="lyric-controls" :disabled="!available || library.enabled === false">
          <div class="lyric-row"><div><label>管理已保存的歌词</label><p>按曲目查看歌词，选择版本或编辑内容。</p></div><button ref="openButton" type="button" class="lyric-button" :disabled="managerOpen || opening" :aria-expanded="managerOpen" aria-controls="saved-lyric-library" @click="openLibrary">{{ opening ? '打开中…' : managerOpen ? '已打开' : '打开' }}</button></div>
          <div class="lyric-row"><div><label for="lyric-auto-save">自动保存在线歌词</label><p>将选中的可用歌词保存到本地。</p></div><label class="lyric-switch"><input id="lyric-auto-save" type="checkbox" :checked="library.autoSave !== false" @change="setLibraryPreference('autoSave', $event.target.checked)"><span></span></label></div>
          <div class="lyric-row"><div><label for="lyric-min-match">自动保存最低匹配</label><p>精确匹配歌曲标识；较高匹配歌名和歌手；中等仅匹配歌名。低于等级不自动保存，不影响播放。</p></div><AnimatedSelect id="lyric-min-match" :model-value="library.minMatch || 'high'" :options="matchOptions" label="自动保存最低匹配" :disabled="!available || library.enabled === false || library.autoSave === false" @update:model-value="setLibraryPreference('minMatch', $event)" /></div>
          <div class="lyric-row"><div><label for="lyric-auto-update">自动更新已保存的在线歌词</label><p>使用在线版本时在后台检查并保存更新；保留手动编辑的版本。</p></div><label class="lyric-switch"><input id="lyric-auto-update" type="checkbox" :checked="library.autoUpdate !== false" @change="setLibraryPreference('autoUpdate', $event.target.checked)"><span></span></label></div>
        </fieldset>
      </AnimatedDetails>
      <p v-if="!available" class="lyric-note">歌词保存与管理仅在桌面客户端中可用。</p>
      <Transition name="ui-fade" mode="out-in"><p v-if="error" :key="error" class="lyric-error" role="alert">{{ error }}</p></Transition>
      <Transition name="lyric-manager" @before-leave="$event.inert = true" @before-enter="$event.inert = false" @leave-cancelled="$event.inert = false">
        <LyricLibrary v-if="managerOpen && library.enabled !== false" id="saved-lyric-library" ref="libraryPanel" :before-action="beforeAction" @close="closeLibrary" @protected-state="managerProtected = $event" />
      </Transition>
    </div>
    <div class="lyric-group">
      <h3>歌词内容处理</h3>
      <div class="lyric-row"><div><label for="lyric-translation">中文翻译</label><p>有翻译时显示；与全屏和桌面歌词工具栏共用此选项。</p></div><label class="lyric-switch"><input id="lyric-translation" type="checkbox" :checked="preferences.showTranslation !== false" @change="setPreference('showTranslation', $event.target.checked)"><span></span></label></div>
      <div class="lyric-row"><div><label for="lyric-romanization">罗马音</label><p>选择日语罗马音的显示方式，需要歌词提供读音数据。</p></div><AnimatedSelect id="lyric-romanization" :model-value="preferences.romanization || 'off'" :options="romanizationOptions" label="罗马音" @update:model-value="setPreference('romanization', $event)" /></div>
      <div class="lyric-row"><div><label for="lyric-simplified">更喜欢简体中文</label><p>关闭时将中文转换为繁体。更改后重新处理当前歌词。</p></div><label class="lyric-switch"><input id="lyric-simplified" type="checkbox" :checked="preferences.preferSimplifiedChinese !== false" @change="setPreference('preferSimplifiedChinese', $event.target.checked)"><span></span></label></div>
      <div class="lyric-row"><div><label for="lyric-segment">歌词分割</label><p>按中文词语分隔长句，保留原有播放时间。</p></div><label class="lyric-switch"><input id="lyric-segment" type="checkbox" :checked="preferences.segmentLyrics === true" @change="setPreference('segmentLyrics', $event.target.checked)"><span></span></label></div>
      <div class="lyric-row"><div><label for="lyric-profanity">显示脏词</label><p>关闭时，将已识别的中英文脏词替换为星号。</p></div><label class="lyric-switch"><input id="lyric-profanity" type="checkbox" :checked="preferences.showProfanity === true" @change="setPreference('showProfanity', $event.target.checked)"><span></span></label></div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AnimatedDetails from './AnimatedDetails.vue'
import AnimatedSelect from './AnimatedSelect.vue'
import LyricLibrary from './LyricLibrary.vue'
import { logger } from '../../utils/logger.js'

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, beforeAction: { type: Function, required: true } })
const emit = defineEmits(['update:modelValue'])
const preferences = computed(() => props.modelValue || {})
const library = computed(() => preferences.value.lyricLibrary || {})
const api = typeof window !== 'undefined' ? window.electronAPI?.lyricLibrary : null
const available = Boolean(api?.list && api?.read && api?.select && api?.saveEdit)
const matchOptions = [{ value: 'exact', label: '精确' }, { value: 'high', label: '较高' }, { value: 'medium', label: '中等' }, { value: 'any', label: '不限' }]
const romanizationOptions = [{ value: 'off', label: '禁用' }, { value: 'on', label: '有读音时显示' }]
const managerOpen = ref(false)
const managerProtected = ref(false)
const opening = ref(false)
const openButton = ref(null)
const libraryPanel = ref(null)
const error = ref('')
let disposed = false

function setPreference(key, value) { emit('update:modelValue', { ...preferences.value, [key]: value }) }
function setLibraryPreference(key, value) { setPreference('lyricLibrary', { ...library.value, [key]: value }) }

/** 读取歌词库前先保存管理开关，防止界面草稿与主进程的启用状态不一致。 */
async function openLibrary() {
  if (!available || library.value.enabled === false || opening.value || managerOpen.value || disposed) return
  opening.value = true
  error.value = ''
  try {
    if (!await props.beforeAction()) throw new Error('请先重试保存设置，再打开歌词管理。')
    if (!disposed && library.value.enabled !== false) managerOpen.value = true
  } catch (cause) {
    if (!disposed) error.value = cause?.message || '无法打开歌词管理，请重试。'
    logger.warn('LyricSettings', '打开歌词管理失败', { code: cause?.code })
  } finally { if (!disposed) opening.value = false }
}
function closeLibrary() {
  managerOpen.value = false
  managerProtected.value = false
  nextTick(() => { if (!disposed) openButton.value?.focus?.({ preventScroll: true }) })
}
watch(() => library.value.enabled, enabled => { if (enabled === false) closeLibrary() })
onBeforeUnmount(() => { disposed = true })
defineExpose({ prepareLeave: () => libraryPanel.value?.prepareLeave?.() ?? true })
</script>

<style scoped>
.lyric-settings { min-width: 0; font-size: var(--font-size-xs); }
.lyric-group { margin-top: 22px; border-top: 1px solid var(--color-border); padding-top: 22px; }
.lyric-group h3 { margin: 0 0 8px; font-size: var(--font-size-sm); font-weight: 600; }
.lyric-controls { border: 0; padding: 0; margin: 0; min-width: 0; transition: opacity .18s ease; }
.lyric-controls:disabled { opacity: .5; }
.lyric-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px 0; }
.lyric-row + .lyric-row { border-top: 1px solid color-mix(in srgb, var(--color-border) 55%, transparent); }
.lyric-row > div { flex: 1; min-width: 0; }
.lyric-row label { color: var(--color-text); font-size: var(--font-size-sm); line-height: 1.7; }
.lyric-row p, .lyric-note { margin: 5px 0 0; color: var(--color-text-secondary); font-size: calc(var(--font-size-xs) - 1px); line-height: 1.8; overflow-wrap: anywhere; }
.lyric-group-heading { padding-top: 0; }
.lyric-group-heading > div > label { font-weight: 600; }
.lyric-library-options :deep(summary) { display: flex; align-items: center; justify-content: space-between; gap: 18px; list-style: none; padding: 9px 0; color: var(--color-text-secondary); font-size: 11px; }
.lyric-library-options :deep(summary::-webkit-details-marker) { display: none; }
.lyric-disclosure { display: block; transition: rotate .2s ease; }
.lyric-library-options[open] .lyric-disclosure { rotate: 180deg; }
.lyric-row :deep(.animated-select-trigger) { max-width: 155px; flex: 0 0 auto; }
.lyric-switch { display: block; position: relative; width: 37px; height: 22px; flex: 0 0 37px; }
.lyric-switch input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.lyric-switch span { display: block; width: 100%; height: 100%; border-radius: 22px; border: 1px solid var(--color-border); background: var(--color-background-lighter); pointer-events: none; transition: background-color .18s ease; }
.lyric-switch span::after { content: ''; position: absolute; width: 14px; height: 14px; left: 4px; top: 4px; border-radius: 50%; background: var(--color-text-secondary); transition: transform .18s ease, background-color .18s ease; }
.lyric-switch input:checked + span { background: var(--color-primary); border-color: transparent; }
.lyric-switch input:checked + span::after { transform: translateX(15px); background: var(--color-on-primary); }
.lyric-switch input:focus-visible + span { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.lyric-switch input:disabled { cursor: default; }
.lyric-switch input:disabled + span { opacity: .5; }
.lyric-button { flex: 0 0 auto; padding: 8px 15px; border: 1px solid var(--color-border); border-radius: 40px; color: var(--color-text); transition: border-color .16s ease, color .16s ease, scale .16s ease; }
.lyric-button:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }
.lyric-button:active:not(:disabled) { scale: .97; }
.lyric-button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.lyric-button:disabled { opacity: .5; cursor: default; }
.lyric-error { margin: 10px 0; color: var(--color-error); line-height: 1.8; }
.lyric-manager-enter-active, .lyric-manager-leave-active { transition: opacity .2s ease, transform .2s ease; }
.lyric-manager-enter-from, .lyric-manager-leave-to { opacity: 0; transform: translateY(-8px); }
@container (max-width: 430px) { .lyric-row { gap: 16px; } .lyric-row label { font-size: 12px; } .lyric-row :deep(.animated-select-trigger) { max-width: 125px; } }
@media (prefers-reduced-motion: reduce) { *, *::after { transition: none !important; animation: none !important; } }
</style>
