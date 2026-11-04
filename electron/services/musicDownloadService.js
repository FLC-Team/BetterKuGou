const { Worker: NodeWorker } = require('node:worker_threads')
const defaultLogger = require('../logger')

/** Own one worker and expose only account-scoped presentation state to the renderer. */
function createMusicDownloadService({workerPath,root,defaultDownloadPath,onState=()=>{},onAuthExpired=()=>{},getCachedFile,getDownloadLyrics,logger=defaultLogger,Worker=NodeWorker}) {
  let worker=null;let nextId=0;let stopped=false;let stopPromise=null;let settings={};let session=null;let sessionGeneration=0;const pending=new Map()
  let state={revision:0,userId:null,tasks:[],downloadPath:defaultDownloadPath}
  function snapshot(){return JSON.parse(JSON.stringify(state))}
  function fail(error){for(const request of pending.values()){clearTimeout(request.timer);request.reject(error)}pending.clear()}
  function ensureWorker(){
    if(stopped)throw new Error('下载服务已停止')
    if(worker)return worker
    const instance=new Worker(workerPath,{workerData:{root,defaultDownloadPath,taglibPath:require.resolve('node-taglib-sharp')}});worker=instance
    instance.on('message',message=>{
      if(worker!==instance)return
      if(message.type==='state'){if(message.state.generation===sessionGeneration&&String(message.state.userId||'')===String(session?.userid||'')){state={...message.state,revision:state.revision+1};onState(snapshot())}return}
      if(message.type==='authExpired'){if(message.generation===sessionGeneration&&message.userId===session?.userid)onAuthExpired({userId:message.userId});return}
      const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timer)
      if(!['configure','stop','setSession'].includes(request.action)&&request.generation!==sessionGeneration){request.reject(Object.assign(new Error('账号已变化，请重试'),{code:'STALE_ACCOUNT'}));return}
      if(message.type==='error')request.reject(Object.assign(new Error(message.error?.message||'下载操作失败'),{code:message.error?.code}))
      else if(message.result?.tasks&&request.action!=='stop') {
        if(message.result.generation!==sessionGeneration||String(message.result.userId||'')!==String(session?.userid||''))request.reject(new Error('账号已变化，请重试'))
        else request.resolve(snapshot())
      } else request.resolve(message.result)
    })
    instance.on('error',error=>{if(worker!==instance)return;logger.error('music-download','下载工作进程失败',error);worker=null;fail(Object.assign(new Error('下载服务异常，请重新打开应用后重试'),{code:'WORKER_FAILED'}));state={...state,revision:state.revision+1,error:'下载服务异常，请重新打开应用后重试'};onState(snapshot())})
    instance.on('exit',code=>{if(worker!==instance)return;worker=null;fail(new Error(code?'下载服务异常退出':'下载服务已退出'))})
    // A replacement Worker restores only the current in-memory identity; restored tasks stay paused.
    instance.postMessage({id:0,action:'configure',payload:settings})
    instance.postMessage({id:0,action:'setSession',payload:{...session,generation:sessionGeneration}})
    return instance
  }
  function request(action,payload){return new Promise((resolve,reject)=>{let instance;try{instance=ensureWorker()}catch(e){reject(e);return}const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(new Error('下载服务响应超时，请重试'),{code:'TIMEOUT'}))},30000);timer.unref?.();pending.set(id,{resolve,reject,timer,action,generation:sessionGeneration});instance.postMessage({id,action,payload})})}
  async function stop(){if(stopPromise)return stopPromise;stopPromise=(async()=>{if(!worker){stopped=true;return}const instance=worker;try{await request('stop')}finally{stopped=true;if(worker===instance)worker=null;await instance.terminate();fail(new Error('下载服务已停止'))}})();return stopPromise}
  async function enqueue(payload){
    const leases=[];const cachedFiles=[];const generation=sessionGeneration;const songs=[]
    try {
      if(!Array.isArray(payload?.songs)||!payload.songs.length||payload.songs.length>20000)throw new Error('请选择有效歌曲')
      for(const original of payload.songs){const song={...original};delete song.downloadLyrics
        if(getDownloadLyrics&&(settings.download?.saveLyrics!==false||settings.download?.embedMetadata!==false)){try{const lyrics=await getDownloadLyrics(song);if(lyrics)song.downloadLyrics=lyrics}catch(error){logger.warn('music-download','读取已有歌词失败，将使用在线歌词',{code:error?.code})}}
        if(getCachedFile){const quality=song.source==='cloud'?'original':settings.download?.quality==='follow'||!settings.download?.quality?(settings.playback?.audioQuality||settings.playback?.quality||'128'):settings.download.quality;try{const lease=await getCachedFile(song,quality);if(lease?.path){leases.push(lease);cachedFiles.push({hash:String(song.hash).toLowerCase(),source:song.source==='cloud'?'cloud':'catalog',quality,path:lease.path})}}catch(error){logger.warn('music-download','读取缓存失败，将重新获取音源',{code:error?.code})}}
        if(generation!==sessionGeneration)throw new Error('账号已变化，请重新选择下载歌曲');songs.push(song)
      }
      return await request('enqueue',{songs,playlistName:payload?.playlistName,cachedFiles})
    }finally{await Promise.allSettled(leases.map(lease=>lease.release?.()))}
  }
  function setSession(value) {
    const next=value?.userid&&value?.token?{userid:String(value.userid),token:String(value.token)}:null
    if(next?.userid===session?.userid&&next?.token===session?.token)return request('getState')
    sessionGeneration++;session=next;state={...state,revision:state.revision+1,userId:session?.userid||null,generation:sessionGeneration,tasks:[]};onState(snapshot())
    return request('setSession',{...session,generation:sessionGeneration})
  }
  return {configure:value=>{settings=value||{};return request('configure',settings)},setSession,getState:()=>request('getState'),enqueue,pause:id=>request('pause',id),resume:id=>request('resume',id),cancel:id=>request('cancel',id),retry:id=>request('retry',id),retryMetadata:id=>request('retryMetadata',id),getFile:id=>request('getFile',id),stop}
}
module.exports={createMusicDownloadService}
