<template>
  <section class="downloads-view" aria-label="音乐下载">
    <header><div><p class="eyebrow">YOUR MUSIC / DOWNLOADS</p><h2>下载</h2><p>保存音乐、封面与歌词，随时离线聆听。</p></div><button type="button" :disabled="!api || loading" @click="refresh">刷新</button></header>
    <p v-if="!api" role="status">文件下载仅在桌面客户端中可用。</p>
    <p v-if="error || state.error" class="error" role="alert">{{ error || state.error }}</p>
    <p class="directory">{{ state.downloadPath }}</p>
    <div v-if="loading && !state.tasks.length" role="status">正在读取下载任务…</div>
    <p v-else-if="!state.tasks.length" class="empty">还没有下载任务。在歌曲菜单中选择下载，或下载整张歌单。</p>
    <p v-else class="summary">{{ completed }} 首已完成 · {{ state.tasks.length }} 个任务</p>
    <TransitionGroup name="ui-list" tag="div" class="task-list">
      <article v-for="task in state.tasks" :key="task.id" class="task" :aria-busy="busy.has(task.id)">
        <div class="task-copy"><h3>{{ task.title }}</h3><p>{{ task.artist }} · {{ task.quality }}</p><p v-if="task.playlistName">{{ task.playlistName }}</p><p role="status">{{ labels[task.status] || task.status }}<template v-if="task.total"> · {{ bytes(task.received) }} / {{ bytes(task.total) }}</template></p></div>
        <progress v-if="running.has(task.status)" :value="task.percent == null ? undefined : task.percent" max="100" :aria-label="`${task.title} 下载进度`"></progress>
        <p v-if="task.error" class="error" role="alert">{{ task.error }}</p><p v-for="warning in task.warnings" :key="warning" class="warning">{{ warning }}</p>
        <div class="actions">
          <button v-if="running.has(task.status) || task.status === 'queued'" type="button" :disabled="busy.has(task.id)" @click="act('pause', task)">暂停</button>
          <button v-if="task.status === 'paused'" type="button" :disabled="busy.has(task.id)" @click="act('resume', task)">继续</button>
          <button v-if="['failed', 'canceled'].includes(task.status)" type="button" :disabled="busy.has(task.id)" @click="act('retry', task)">重试</button>
          <button v-if="!done.has(task.status) && task.status !== 'canceled'" type="button" :disabled="busy.has(task.id)" @click="act('cancel', task)">取消</button>
          <button v-if="done.has(task.status)" type="button" :disabled="busy.has(task.id)" @click="act('reveal', task)">打开所在目录</button>
          <button v-if="task.status === 'completed-with-warning'" type="button" :disabled="busy.has(task.id)" title="重新获取附加信息并另存新副本，保留原文件" @click="act('retryMetadata', task)">补全并另存副本</button>
        </div>
      </article>
    </TransitionGroup>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
const api=window.electronAPI?.downloads
const state=ref({revision:-1,tasks:[],downloadPath:''});const error=ref('');const loading=ref(false);const busy=reactive(new Set())
const running=new Set(['resolving','downloading','verifying','tagging','publishing']);const done=new Set(['completed','completed-with-warning'])
const labels={queued:'等待下载',resolving:'正在获取音源',downloading:'正在下载',verifying:'正在校验',tagging:'整理歌曲信息',publishing:'正在保存',completed:'已完成','completed-with-warning':'已完成，附加信息不完整',paused:'已暂停',failed:'下载失败',canceled:'已取消'}
const completed=computed(()=>state.value.tasks.filter(t=>done.has(t.status)).length)
let disposed=false;let unsubscribe
function accept(value){if(!disposed&&value&&Number(value.revision)>=state.value.revision)state.value=value}
function bytes(n){return n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.ceil((n||0)/1024)} KB`}
async function refresh(){if(!api||loading.value)return;loading.value=true;try{accept(await api.getState());error.value=''}catch(e){if(!disposed)error.value=e.message||'无法读取下载任务'}finally{if(!disposed)loading.value=false}}
async function act(method,task){if(busy.has(task.id))return;busy.add(task.id);error.value='';try{const result=await api[method](task.id);if(result?.tasks)accept(result)}catch(e){if(!disposed)error.value=e.message||'操作失败，请重试'}finally{busy.delete(task.id)}}
onMounted(()=>{unsubscribe=api?.onState?.(accept);void refresh()});onBeforeUnmount(()=>{disposed=true;unsubscribe?.()})
</script>
<style scoped>
.downloads-view{padding:clamp(16px,3vw,32px);color:var(--color-text);}.downloads-view header{display:flex;justify-content:space-between;align-items:center;gap:20px}.downloads-view h2{font-size:32px;margin:6px 0}.eyebrow{font-size:11px;letter-spacing:.16em}.directory,.summary,.downloads-view p{color:var(--color-text-secondary);overflow-wrap:anywhere}.task-list{display:grid;gap:14px}.task{padding:22px;border:1px solid var(--color-border);border-radius:16px;background:var(--color-background-light);transition:background .2s,transform .2s}.task h3{margin:0;font-size:17px}.task p{font-size:13px;margin:8px 0}.task progress{width:100%;height:5px;accent-color:var(--color-primary)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.downloads-view button{padding:8px 14px;border:1px solid var(--color-border);border-radius:18px;color:var(--color-text);background:var(--color-background);cursor:pointer}.downloads-view button:disabled{opacity:.5;cursor:default}.downloads-view .error{color:var(--color-error,#c84a4a)}.downloads-view .warning{color:var(--color-text-secondary)}.empty{padding:40px 0}@media(prefers-reduced-motion:reduce){.task{transition:none}}
</style>
