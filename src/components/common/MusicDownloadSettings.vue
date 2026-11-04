<template>
  <div class="music-download-settings">
    <h3>歌曲文件下载</h3><p>原格式保存音乐，可附带封面和歌词；修改仅影响之后创建的任务。</p>
    <fieldset :disabled="!available">
      <div class="setting-item"><div class="setting-info"><label class="setting-label">下载目录</label><p>{{ modelValue.downloadPath || '使用系统音乐目录' }}</p></div><button type="button" :disabled="busy" @click="choose">更改目录</button></div>
      <div class="setting-item"><label class="setting-label" for="music-download-quality">下载音质</label><AnimatedSelect id="music-download-quality" :model-value="modelValue.quality || 'follow'" :options="qualityOptions" label="下载音质" @update:model-value="set('quality', $event)" /></div>
      <div class="setting-item"><label for="music-download-count">同时下载数量</label><input id="music-download-count" type="number" min="1" max="10" :value="modelValue.concurrentDownloads || 3" @change="set('concurrentDownloads', Math.max(1, Math.min(10, Number($event.target.value) || 3)))"></div>
      <label v-for="option in flags" :key="option.key" class="download-option"><input type="checkbox" :checked="modelValue[option.key] !== false" @change="set(option.key, $event.target.checked)">{{ option.label }}</label>
    </fieldset><p v-if="!available">文件下载仅在桌面客户端中可用。</p><p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup>
import { ref } from 'vue'
import AnimatedSelect from './AnimatedSelect.vue'
const props=defineProps({modelValue:{type:Object,default:()=>({})},beforeAction:{type:Function,default:async()=>true}})
const emit=defineEmits(['update:modelValue']);const busy=ref(false);const error=ref('');const available=Boolean(window.electronAPI?.downloads)
const qualityOptions=[{value:'follow',label:'跟随播放偏好'},{value:'128',label:'标准 128K'},{value:'320',label:'高品质 320K'},{value:'flac',label:'FLAC 无损'},{value:'high',label:'高解析音质'}]
const flags=[{key:'embedMetadata',label:'写入歌曲标签与文本歌词'},{key:'embedCover',label:'嵌入专辑封面'},{key:'saveLyrics',label:'同时保存配套歌词文件'}]
function set(key,value){emit('update:modelValue',{...props.modelValue,[key]:value})}
async function choose(){if(busy.value)return;busy.value=true;error.value='';try{if(await props.beforeAction()===false)return;const result=await window.electronAPI.downloads.chooseDirectory();if(result?.path)set('downloadPath',result.path)}catch(e){error.value=e.message||'无法更改下载目录，请重试'}finally{busy.value=false}}
</script>
<style scoped>
.music-download-settings fieldset{border:0;padding:0;margin:0}.music-download-settings p{color:var(--color-text-secondary);font-size:13px;overflow-wrap:anywhere}.setting-item{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0}.download-option{display:flex;align-items:center;gap:10px;padding:10px 0}.music-download-settings button,.music-download-settings input[type=number]{padding:8px 12px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-background);color:var(--color-text)}.music-download-settings input[type=number]{width:72px}.music-download-settings input{accent-color:var(--color-primary)}
</style>
