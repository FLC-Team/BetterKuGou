<template>
  <section class="audio-effects" aria-labelledby="audio-effects-heading">
    <header class="effects-heading">
      <div><p class="effects-eyebrow">YOUR SOUND, YOUR WAY</p><h3 id="audio-effects-heading">VST3 音频效果</h3><p>将已安装的效果插件串联，塑造音乐的声音。</p></div>
      <label class="effects-switch"><input id="audio-effects-enabled" type="checkbox" aria-label="启用 VST3 音频效果" :checked="state.enabled" :disabled="locked" @change="setEnabled($event.target.checked)"><span aria-hidden="true"></span></label>
    </header>

    <div class="effects-status" :class="{ 'is-running': appliedEnabled && state.running, 'is-error': state.error }" role="status" :aria-busy="Boolean(pending || loading)">
      <span class="status-dot" aria-hidden="true"></span><span>{{ statusLabel }}</span>
      <span v-if="appliedEnabled && state.running && Number.isFinite(state.latencyMs)" class="effects-latency">插件延迟 {{ formatNumber(state.latencyMs) }} ms</span>
    </div>
    <p v-if="appliedEnabled && state.running" class="effects-note">音效处理另有约 {{ bridgeLatencyMs }} ms 音频缓冲，实际听到声音的时间还受输出设备影响。</p>
    <p v-if="!available || state.supported === false" class="effects-note">{{ available ? '当前环境没有可用的音效组件。' : 'VST3 插件仅在桌面客户端中可用。' }}</p>
    <AppNotice :message="actionError || (state.error ? errorText(state.error) : '')" type="error" title="音频效果" :actions="[{ label: '重试', run: retryAction, disabled: !available || loading || Boolean(pending) }]" />
    <AppNotice :message="state.saveError ? '效果设置尚未保存：' + errorText(state.saveError) : ''" type="error" title="音频效果" :actions="[{ label: '重试保存', run: () => runAction('retrySave'), disabled: locked }]" />
    <AppNotice :message="state.pendingChanges ? '修改尚未应用，正在使用上次成功的效果链。' : ''" type="warning" title="音频效果" />

    <fieldset :disabled="locked" class="effects-controls">
      <legend class="sr-only">音频效果设置</legend>
      <section class="effects-section" aria-labelledby="effects-buffer-heading">
        <div class="section-heading"><div><h4 id="effects-buffer-heading">音频缓冲</h4><p id="effects-buffer-note">出现杂音或处理超时时可调高。缓冲越大，声音响应越慢；歌词会跟随实际播放时间。</p></div></div>
        <AnimatedSelect id="effects-buffer" label="音频缓冲" aria-describedby="effects-buffer-note" :model-value="state.bufferMs ?? 128" :options="bufferOptions" :disabled="locked" :busy="pending === 'setBufferMs'" @update:model-value="setBufferMs" />
      </section>
      <section class="effects-section" aria-labelledby="effects-chain-heading">
        <div class="section-heading"><div><h4 id="effects-chain-heading">效果链</h4><p>声音按从上到下的顺序处理，可拖动或使用排序按钮。</p></div><span class="effects-count">{{ state.chain.length }} / 64</span></div>
        <p v-if="!state.chain.length" class="effects-empty">从下方插件列表添加第一个效果。</p>
        <TransitionGroup name="effect-row" tag="ol" class="effects-chain" @before-leave="disableLeaving" @before-enter="enableEntering">
          <li v-for="(item, index) in state.chain" :key="item.instanceId" class="effect-card" :class="{ 'is-bypassed': item.bypassed, 'is-unavailable': item.missing || item.error, 'is-drag-target': dropTarget === item.instanceId }" :draggable="!locked" @dragstart="startDrag($event, item.instanceId)" @dragend="endDrag" @dragover.prevent="hoverDrag(item.instanceId)" @drop.prevent="dropAt(item.instanceId)">
            <div class="effect-title"><span class="effect-order" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ item.name || pluginName(item.pluginId) }}</strong><AppNotice :message="item.missing ? '插件未找到，请检查安装位置并重新扫描。' : item.error ? errorText(item.error) : ''" type="error" :title="item.name || pluginName(item.pluginId)" /><p>{{ item.missing || item.error ? '暂不可用' : item.bypassed ? '已旁路' : '参与处理' }}</p></div></div>
            <div class="effect-actions">
              <button type="button" :aria-label="`上移 ${item.name || pluginName(item.pluginId)}`" :disabled="locked || index === 0" @click="move(item.instanceId, index - 1)">↑</button>
              <button type="button" :aria-label="`下移 ${item.name || pluginName(item.pluginId)}`" :disabled="locked || index === state.chain.length - 1" @click="move(item.instanceId, index + 1)">↓</button>
              <label><input type="checkbox" :checked="item.bypassed" @change="bypass(item.instanceId, $event.target.checked)">旁路</label>
              <button type="button" :disabled="locked || (!item.editorOpen && Boolean(item.missing))" @click="toggleEditor(item)">{{ item.editorOpen ? '关闭界面' : '打开界面' }}</button>
              <label><input type="checkbox" :checked="item.alwaysOnTop" :disabled="locked || Boolean(item.missing)" @change="openEditor(item.instanceId, $event.target.checked)">窗口置顶</label>
              <button type="button" class="effect-remove" :aria-label="`移除 ${item.name || pluginName(item.pluginId)}`" @click="remove(item.instanceId)">移除</button>
            </div>
          </li>
        </TransitionGroup>
      </section>

      <section class="effects-section" aria-labelledby="effects-tempo-heading">
        <div class="section-heading"><div><h4 id="effects-tempo-heading">当前歌曲速度</h4><p>向同步延迟、调制等插件提供 BPM；不会改变歌曲播放速度。</p></div><strong class="tempo-value">{{ knownTempo == null ? '—' : formatNumber(knownTempo) }} <small>BPM</small></strong></div>
        <p class="effects-note" role="status">{{ tempoLabel }}</p>
        <form class="tempo-controls" @submit.prevent="applyTempo">
          <label class="sr-only" for="effects-tempo">手动 BPM（20–400）</label><input id="effects-tempo" type="number" min="20" max="400" step="0.01" placeholder="手动 BPM" :value="tempoDraft" :disabled="locked || !state.tempo.trackId" @input="editTempo($event.target.value)">
          <button type="submit" :disabled="locked || !state.tempo.trackId">应用</button>
          <button type="button" :disabled="locked || !validTempo(knownTempo * 2) || !state.tempo.trackId" @click="scaleTempo(2)">×2</button>
          <button type="button" :disabled="locked || !validTempo(knownTempo / 2) || !state.tempo.trackId" @click="scaleTempo(0.5)">÷2</button>
          <button type="button" :disabled="locked || !state.tempo.trackId || state.tempo.manualBpm == null" @click="restoreTempo">恢复自动</button>
        </form>
        <AppNotice :message="tempoError" type="error" title="歌曲速度" />
      </section>

      <section class="effects-section" aria-labelledby="effects-plugins-heading">
        <div class="section-heading"><div><h4 id="effects-plugins-heading">插件库</h4><p>扫描系统默认目录及你添加的目录。</p></div><span class="effects-count">{{ state.plugins.length }} 个插件</span></div>
        <div class="scan-actions"><button type="button" :disabled="locked || state.scanning" @click="runAction('scan')">{{ state.scanning ? '正在扫描…' : '扫描插件' }}</button><button type="button" :disabled="locked || state.scanning" @click="runAction('chooseDirectory')">添加插件目录</button></div>
        <ul v-if="state.searchPaths.length" class="effects-paths"><li v-for="directory in state.searchPaths" :key="directory">{{ directory }}</li></ul>
        <Transition name="effects-feedback"><div v-if="state.scanning" class="effects-scan" role="status"><progress :value="scanPercent ?? undefined" max="100" aria-label="插件扫描进度"></progress><span>{{ scanLabel }}</span></div></Transition>
        <label class="sr-only" for="effects-plugin-search">搜索插件名称或厂商</label><input id="effects-plugin-search" class="plugin-search" type="search" placeholder="搜索插件名称或厂商" :value="query" @input="query = $event.target.value">
        <ul class="plugin-list">
          <li v-for="plugin in filteredPlugins" :key="plugin.id"><div><strong>{{ plugin.name }}</strong><p>{{ [plugin.vendor, plugin.category, plugin.version].filter(Boolean).join(' · ') }}</p></div><button type="button" :aria-label="`添加 ${plugin.name}`" :disabled="locked || state.chain.length >= 64" @click="add(plugin.id)">添加</button></li>
        </ul>
        <p v-if="!filteredPlugins.length" class="effects-empty">{{ query.trim() ? '没有匹配的插件。' : state.scanning ? '正在查找可用的 VST3 效果插件…' : '暂未发现插件，请先扫描。' }}</p>
      </section>
    </fieldset>
    <button v-if="state.scanning" type="button" class="cancel-scan" :disabled="!available || cancelPending" @click="cancelScan">{{ cancelPending ? '正在取消…' : '取消扫描' }}</button>
    <AppNotice :message="message" :revision="messageVersion" type="success" title="音频效果" />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { logger } from '../../utils/logger.js'
import AnimatedSelect from './AnimatedSelect.vue'

const props = defineProps({ beforeAction: { type: Function, default: async () => true } })
const api = window.electronAPI?.audioEffects
const available = Boolean(api?.getStatus && api?.onStatus)
const state = ref({ revision: -1, supported: available, enabled: false, bufferMs: 128, running: false, scanning: false,
  scanProgress: null, plugins: [], chain: [], searchPaths: [], latencyMs: null, error: null, saveError: null,
  tempo: { trackId: null, bpm: null, automaticBpm: null, manualBpm: null, status: 'idle' } })
const query = ref('')
const pending = ref('')
const cancelPending = ref(false)
const loading = ref(available)
const actionError = ref('')
const message = ref('')
const messageVersion = ref(0)
const tempoDraft = ref('')
const tempoError = ref('')
const dropTarget = ref(null)
let dragging = null
let tempoDirty = false
let disposed = false
let unsubscribe = null
let failedAction = null
let actionVersion = 0
let readingStatus = false
const locked = computed(() => !available || state.value.supported === false || loading.value || Boolean(pending.value))
const appliedEnabled = computed(() => (state.value.appliedEnabled ?? state.value.enabled) === true)
const bufferOptions = [
  { value: 64, label: '64 ms · 低延迟' },
  { value: 128, label: '128 ms · 推荐' },
  { value: 256, label: '256 ms · 更稳妥' },
  { value: 512, label: '512 ms · 大缓冲' }
]
const setBufferMs = value => runAction('setBufferMs', [value], () => bufferOptions.some(option => option.value === value))
const bridgeLatencyMs = computed(() => {
  const sampleRate = Number.isFinite(state.value.sampleRate) && state.value.sampleRate > 0 ? state.value.sampleRate : 48000
  const bufferMs = state.value.appliedBufferMs ?? state.value.bufferMs ?? 128
  return formatNumber(Math.ceil(sampleRate * bufferMs / 1000 / 128) * 128 / sampleRate * 1000)
})
const filteredPlugins = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return state.value.plugins.filter(plugin => !search || `${plugin.name} ${plugin.vendor || ''} ${plugin.category || ''}`.toLocaleLowerCase().includes(search))
})
const statusLabel = computed(() => loading.value ? '正在读取效果设置…' : !available ? '请在桌面客户端中使用'
  : state.value.supported === false ? '当前环境没有可用的音效组件' : state.value.error ? '音频效果暂不可用'
    : !appliedEnabled.value ? '音频效果已关闭' : state.value.running ? '效果链已就绪' : '音频效果已启用，等待音频')
const scanPercent = computed(() => {
  const progress = state.value.scanProgress
  if (Number.isFinite(progress?.percent)) return Math.max(0, Math.min(100, progress.percent))
  return Number.isFinite(progress?.completed) && progress.total > 0 ? Math.min(100, progress.completed / progress.total * 100) : null
})
const scanLabel = computed(() => {
  const progress = state.value.scanProgress
  return Number.isFinite(progress?.completed) && Number.isFinite(progress?.total)
    ? `已检查 ${progress.completed} / ${progress.total}` : '正在检查插件…'
})
const tempoLabel = computed(() => {
  const tempo = state.value.tempo
  if (!tempo.trackId) return '播放歌曲后显示速度。'
  if (Number.isFinite(tempo.manualBpm)) return '正在使用这首歌曲的手动速度。'
  if (['analyzing', 'pending', 'loading'].includes(tempo.status)) return '正在分析歌曲速度，同步效果暂按 120 BPM。'
  if (Number.isFinite(tempo.automaticBpm)) return `自动分析：${formatNumber(tempo.automaticBpm)} BPM`
  return '尚未获得可靠速度，同步效果暂按 120 BPM；可手动输入。'
})
const knownTempo = computed(() => state.value.tempo.trackId &&
  (Number.isFinite(state.value.tempo.manualBpm) || Number.isFinite(state.value.tempo.automaticBpm)) &&
  validTempo(state.value.tempo.bpm) ? state.value.tempo.bpm : null)
function formatNumber(value) { return Math.round(value * 100) / 100 }
function errorText(error) { return typeof error === 'string' ? error : error?.message || '操作未完成，请重试。' }
function validTempo(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 20 && value <= 400 }
function pluginName(id) { return state.value.plugins.find(plugin => plugin.id === id)?.name || '未找到的插件' }
function hasInstance(id) { return state.value.chain.some(item => item.instanceId === id) }
function disableLeaving(element) { element.inert = true; element.setAttribute('aria-hidden', 'true') }
function enableEntering(element) { element.inert = false; element.removeAttribute('aria-hidden') }

/** Events and command replies share one service revision; late reads cannot restore removed instances or old tracks. */
function acceptState(next) {
  if (disposed || !next || !Number.isInteger(next.revision) || next.revision < state.value.revision) return false
  const changedTrack = next.tempo?.trackId !== state.value.tempo.trackId
  state.value = { ...next, chain: Array.isArray(next.chain) ? next.chain : [], plugins: Array.isArray(next.plugins) ? next.plugins : [],
    searchPaths: Array.isArray(next.searchPaths) ? next.searchPaths : [], tempo: next.tempo || { trackId: null, bpm: null, automaticBpm: null, manualBpm: null, status: 'idle' } }
  if (changedTrack) { tempoDirty = false; tempoError.value = '' }
  if (!tempoDirty) tempoDraft.value = Number.isFinite(state.value.tempo.manualBpm) ? String(state.value.tempo.manualBpm) : ''
  if (!hasInstance(dragging)) endDrag()
  return true
}

/** Serialize mutations after the parent save and recheck their target after every asynchronous boundary. */
async function runAction(method, args = [], guard = () => true, success = '') {
  if (disposed || locked.value || typeof api?.[method] !== 'function' || !guard()) return false
  const version = ++actionVersion
  pending.value = method
  actionError.value = ''
  message.value = ''
  failedAction = null
  try {
    if (await props.beforeAction() === false) throw new Error('请先重试保存其他设置。')
    if (disposed || !guard()) return false
    const result = await api[method](...args)
    if (disposed || version !== actionVersion) return false
    if (result == null) return false
    acceptState(result)
    if (success && guard() && !result.error && !result.saveError) { message.value = success; messageVersion.value++ }
    return true
  } catch (error) {
    if (!disposed && version === actionVersion) {
      actionError.value = errorText(error)
      failedAction = () => runAction(method, args, guard, success)
      logger.warn('AudioEffectsSettings', '音频效果操作失败', { method, name: error?.name, code: error?.code })
    }
    return false
  } finally {
    if (!disposed && version === actionVersion) pending.value = ''
  }
}
const setEnabled = value => runAction('setEnabled', [value])
const add = id => runAction('addPlugin', [id], () => state.value.chain.length < 64 && state.value.plugins.some(plugin => plugin.id === id))
const remove = id => runAction('removePlugin', [id], () => hasInstance(id))
const bypass = (id, bypassed) => runAction('setBypass', [{ instanceId: id, bypassed }], () => hasInstance(id))
const move = (id, index) => runAction('movePlugin', [{ instanceId: id, index }], () => hasInstance(id) && index >= 0 && index < state.value.chain.length)
const openEditor = (id, alwaysOnTop) => runAction('openEditor', [{ instanceId: id, alwaysOnTop }], () => hasInstance(id))
const toggleEditor = item => item.editorOpen ? runAction('closeEditor', [item.instanceId], () => hasInstance(item.instanceId)) : openEditor(item.instanceId, Boolean(item.alwaysOnTop))

function startDrag(event, id) {
  if (locked.value || !hasInstance(id)) { event.preventDefault(); return }
  dragging = id
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) }
}
function hoverDrag(id) { if (dragging && !locked.value) dropTarget.value = id }
function endDrag() { dragging = null; dropTarget.value = null }
function dropAt(id) {
  const source = dragging
  endDrag()
  if (!source || source === id) return false
  return move(source, state.value.chain.findIndex(item => item.instanceId === id))
}
function editTempo(value) { tempoDraft.value = value; tempoDirty = true; tempoError.value = '' }
async function submitTempo(value) {
  const trackId = state.value.tempo.trackId
  if (!trackId) return false
  const accepted = await runAction('setTempoOverride', [{ trackId, bpm: value }], () => state.value.tempo.trackId === trackId, value == null ? '已恢复自动速度。' : '已更新这首歌曲的速度。')
  if (accepted && !disposed && state.value.tempo.trackId === trackId) {
    tempoDirty = false
    tempoDraft.value = Number.isFinite(state.value.tempo.manualBpm) ? String(state.value.tempo.manualBpm) : ''
    tempoError.value = ''
  }
  return accepted
}
function applyTempo() {
  const value = tempoDraft.value.trim() === '' ? NaN : Number(tempoDraft.value)
  if (!validTempo(value)) { tempoError.value = '请输入 20–400 之间的 BPM。'; return false }
  return submitTempo(value)
}
function scaleTempo(multiplier) {
  const value = knownTempo.value * multiplier
  return validTempo(value) ? submitTempo(formatNumber(value)) : false
}
const restoreTempo = () => submitTempo(null)

/** Cancellation remains available while a scanner request is still in flight. */
async function cancelScan() {
  if (disposed || !available || !state.value.scanning || cancelPending.value) return false
  cancelPending.value = true
  actionError.value = ''
  try {
    const result = await api.cancelScan()
    if (disposed) return false
    acceptState(result)
    if (pending.value === 'scan') { actionVersion++; pending.value = '' }
    actionError.value = ''
    failedAction = null
    return true
  } catch (error) {
    if (!disposed) { actionError.value = errorText(error); failedAction = cancelScan }
    logger.warn('AudioEffectsSettings', '取消插件扫描失败', { name: error?.name, code: error?.code })
    return false
  } finally { if (!disposed) cancelPending.value = false }
}
async function readStatus() {
  if (disposed || !available || readingStatus) return false
  readingStatus = true
  loading.value = true
  actionError.value = ''
  try {
    if (!unsubscribe) unsubscribe = api.onStatus(acceptState)
    acceptState(await api.getStatus())
    if (!disposed) failedAction = null
    return !disposed
  } catch (error) {
    if (!disposed) { actionError.value = errorText(error); failedAction = readStatus }
    logger.warn('AudioEffectsSettings', '读取音频效果状态失败', { name: error?.name, code: error?.code })
    return false
  } finally { readingStatus = false; if (!disposed) loading.value = false }
}
function retryAction() { return failedAction ? failedAction() : runAction('retry') }
onMounted(readStatus)
onBeforeUnmount(() => { disposed = true; actionVersion++; endDrag(); unsubscribe?.(); unsubscribe = null })
</script>

<style scoped>
.audio-effects { container: audio-effects / inline-size; color: var(--color-text); min-width: 0; }
.audio-effects p { color: var(--color-text-secondary); font-size: var(--font-size-xs); line-height: 1.8; margin: 5px 0; overflow-wrap: anywhere; }
.effects-heading, .section-heading, .effect-title, .effect-actions, .plugin-list li, .effects-status { display: flex; align-items: center; gap: 14px; }
.effects-heading, .section-heading, .plugin-list li { justify-content: space-between; }
.effects-heading > div, .effect-title > div, .plugin-list li > div { min-width: 0; }
.audio-effects .effects-eyebrow { font-size: 10px; letter-spacing: 1.7px; margin-bottom: 9px; }
h3 { font-size: 22px; font-weight: 550; margin: 0; } h4 { font-size: 15px; font-weight: 550; margin: 0; }
.effects-status { padding: 14px 0; font-size: 12px; flex-wrap: wrap; color: var(--color-text-secondary); }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-border); transition: background-color .2s ease; }
.is-running .status-dot { background: var(--color-primary); } .is-error .status-dot { background: var(--color-error); }
.effects-latency { margin-left: auto; font-variant-numeric: tabular-nums; }
.effects-controls { border: 0; padding: 0; margin: 0; min-width: 0; }
.effects-section { padding: 24px 0; border-top: 1px solid var(--color-border); }
.section-heading { align-items: flex-start; margin-bottom: 14px; }
.effects-count { white-space: nowrap; font-size: 11px; color: var(--color-text-secondary); }
.effects-chain, .plugin-list, .effects-paths { padding: 0; margin: 0; list-style: none; }
.effects-chain { position: relative; display: grid; gap: 9px; }
.effect-card { padding: 16px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-background-light); transition: opacity .2s ease, border-color .2s ease, background-color .2s ease; }
.effect-card.is-bypassed { background: var(--color-background); } .effect-card.is-unavailable { border-color: color-mix(in srgb, var(--color-error) 45%, var(--color-border)); }
.effect-card.is-drag-target { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 7%, var(--color-background-light)); }
.effect-order { color: var(--color-text-secondary); font-size: 13px; font-variant-numeric: tabular-nums; align-self: flex-start; padding-top: 2px; }
.effect-title strong, .plugin-list strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.effect-actions, .scan-actions, .tempo-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 12px; }
.effect-actions label { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 5px; }
.audio-effects button, .audio-effects input:not([type=checkbox]) { font: inherit; font-size: 12px; border: 1px solid var(--color-border); border-radius: 7px; padding: 8px 12px; color: var(--color-text); background: var(--color-background); transition: border-color .16s ease, color .16s ease, transform .16s ease, opacity .16s ease; }
.audio-effects button { cursor: pointer; } .audio-effects button:hover:not(:disabled) { border-color: var(--color-primary); color: var(--color-primary); }
.audio-effects button:active:not(:disabled) { transform: scale(.97); } .audio-effects button:disabled { opacity: .5; cursor: default; }
.audio-effects :is(button, input):focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.audio-effects input { accent-color: var(--color-primary); } .audio-effects input[type=checkbox] { cursor: pointer; }
.audio-effects .effect-remove { margin-left: auto; } .audio-effects .effect-remove:hover:not(:disabled) { color: var(--color-error); border-color: var(--color-error); }
.audio-effects .plugin-search { width: 100%; box-sizing: border-box; margin: 18px 0 9px; }
.plugin-list { max-height: 340px; overflow-y: auto; scrollbar-gutter: stable; }
.plugin-list li { padding: 12px 0; border-bottom: 1px solid var(--color-border); animation: effect-appear .2s ease; }
.plugin-list button { flex: 0 0 auto; } .effects-paths { margin-top: 12px; color: var(--color-text-secondary); font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
.effects-scan { margin-top: 16px; display: grid; gap: 8px; font-size: 11px; color: var(--color-text-secondary); }
.effects-scan progress { width: 100%; height: 5px; accent-color: var(--color-primary); }
.tempo-value { white-space: nowrap; font-size: 23px; font-weight: 500; font-variant-numeric: tabular-nums; } .tempo-value small { font-size: 10px; color: var(--color-text-secondary); }
.tempo-controls input { width: 110px; }
.audio-effects .effects-empty { padding: 15px 0; } .cancel-scan { margin-bottom: 14px; }
.effects-switch { position: relative; display: block; width: 39px; height: 24px; flex: 0 0 39px; }
.effects-switch input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; }
.effects-switch span { display: block; height: 100%; border-radius: 24px; background: var(--color-border); pointer-events: none; transition: background-color .18s; }
.effects-switch span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--color-text); transition: transform .18s; }
.effects-switch input:checked + span { background: var(--color-primary); } .effects-switch input:checked + span::after { transform: translateX(15px); }
.effects-switch input:focus-visible + span { outline: 2px solid var(--color-primary); outline-offset: 3px; } .effects-switch input:disabled + span { opacity: .5; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.effect-row-enter-active, .effect-row-leave-active, .effect-row-move { transition: transform .2s ease, opacity .2s ease; }
.effect-row-enter-from, .effect-row-leave-to { opacity: 0; transform: translateY(8px); } .effect-row-leave-active { position: absolute; width: 100%; box-sizing: border-box; }
.effects-feedback-enter-active, .effects-feedback-leave-active { transition: opacity .18s ease, transform .18s ease; }
.effects-feedback-enter-from, .effects-feedback-leave-to { opacity: 0; transform: translateY(5px); }
@keyframes effect-appear { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@container audio-effects (max-width: 440px) { .section-heading { gap: 8px; } .effect-card { padding: 12px; } .effect-actions { gap: 5px; } .effect-actions button { padding: 7px 9px; } .effects-latency { margin-left: 20px; } }
@media (prefers-reduced-motion: reduce) { .audio-effects *, .audio-effects *::after { transition: none !important; animation: none !important; } }
</style>
