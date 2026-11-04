const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { parentPort, workerData, isMainThread } = require('node:worker_threads')
const { transferError, normalizeHash, allowedArtworkUrl, detectFormat, isPreview, requestStream, readBody, inspectFile, transferFile } = require('./musicTransfer.cjs')

const ACTIVE = new Set(['resolving','downloading','verifying','tagging','publishing'])
const COMPLETE = new Set(['completed','completed-with-warning'])
const safeText = (v,n=500) => typeof v==='string' ? v.slice(0,n) : ''
function safeName(value) { const name=String(value||'未知歌曲').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,100); return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)?`_${name}`:name||'未命名' }
function accountKey(value) { return crypto.createHash('sha256').update(String(value || 'guest')).digest('hex').slice(0,32) }
/** Match the renderer's title/artist rules without guessing a split inside a structured artist name. */
function songLabels(song) {
  const clean=value=>typeof value==='string'&& !['未知歌手','-'].includes(value.trim())?safeText(value.trim()):''
  const artists=[]
  for(const field of ['singerinfo','SingerInfo','singers','Singers','authors','Authors','artists']) {
    if(!Array.isArray(song[field]))continue
    for(const entry of song[field]) {
      const value=typeof entry==='string'?clean(entry):entry&&typeof entry==='object'?['name','Name','singer_name','singername','SingerName','author_name','AuthorName'].map(key=>clean(entry[key])).find(Boolean):''
      if(value&&!artists.includes(value))artists.push(value)
    }
  }
  const joined=['singername','SingerName','singer_name','singerName','author_name','AuthorName','author','singerinfo','authors'].map(key=>clean(song[key])).find(Boolean)||''
  if(!artists.length)artists.push(...joined.split(/\s*、\s*|\s+[\/／]\s+/).map(clean).filter(Boolean))
  const titleFields=['OriSongName','songname','song_name','audio_name','title'],fileFields=['name','filename','FileName']
  const field=[...titleFields,...fileFields].find(key=>typeof song[key]==='string'&&song[key].trim())
  let title=field?safeText(song[field]).trim():'未知歌曲'
  const separator=/\s+[-—–](?:\s+|$)/.exec(title)
  if(separator) {
    const prefix=title.slice(0,separator.index).trim(),lower=prefix.toLocaleLowerCase(),parts=/\s*(?:、|&|＆|,|，|;|；|\/|／|\b(?:feat\.?|ft\.?|and)\b)\s*/i
    const known=[joined,...artists].filter(Boolean).map(value=>value.toLocaleLowerCase()),individual=known.flatMap(value=>value.split(parts)),prefixArtists=lower.split(parts).filter(Boolean)
    if(known.includes(lower)||(prefixArtists.length>1&&prefixArtists.every(value=>individual.includes(value)))||(fileFields.includes(field)&&!artists.length)) {
      if(!artists.length)artists.push(...prefix.split(/\s*、\s*|\s+[\/／]\s+/).map(clean).filter(Boolean))
      title=title.slice(separator.index+separator[0].length).trim()
    }
  }
  if(fileFields.includes(field))title=title.replace(/\.(mp3|flac|wav|aac|m4a|ogg|wma|ape|opus)$/i,'').trim()
  return {title:title||'未知歌曲',artists:artists.length?artists:['未知歌手']}
}
function songData(song) {
  const hash=normalizeHash(song?.hash ?? song?.Hash ?? song?.FileHash); if(!hash) throw transferError('INVALID_SONG','歌曲缺少有效音频标识')
  const source=song.source==='cloud'?'cloud':'catalog'
  const labels=songLabels(song)
  const result={hash,source,sourceUserId:source==='cloud'?String(song.sourceUserId||''):'',...labels,album:safeText(song.album_name||song.albuminfo?.name||song.album_info?.album_name),album_id:Number(song.album_id||song.albumid||song.AlbumID)||0,album_audio_id:Number(song.album_audio_id||song.mixsongid||song.MixSongID)||0,audio_id:Number(song.audio_id)||0,originalName:safeText(song.originalName||song.filename||song.name),year:Number(song.year)||0,track:Number(song.track)||0}
  const cover=song.cover||song.imgurl||song.album_img||song.sizable_cover||''
  result.cover=allowedArtworkUrl(String(cover).replace('{size}','500'))?String(cover).replace('{size}','500'):''
  if(typeof song.downloadLyrics?.content==='string') result.downloadLyrics={content:safeText(song.downloadLyrics.content,2*1024*1024),translation:safeText(song.downloadLyrics.translation,2*1024*1024)}
  return result
}

/** Convert raw LRC/KRC to portable line-timed lyrics without changing source text. */
function lyricFiles(raw) {
  const content=typeof raw==='string'?raw:raw?.decodeContent||raw?.content||''
  let translated=[]
  try { const language=content.match(/^\[language:(.*)\]$/m)?.[1]; const parsed=language?JSON.parse(Buffer.from(language,'base64').toString('utf8')):null; translated=parsed?.content?.find(v=>v.type===1)?.lyricContent||[] } catch { /* Optional translation does not invalidate the original lyrics. */ }
  const plain=[]; const timed=[]; let index=0; const offset=Number(content.match(/^\[offset:(-?\d+)\]/m)?.[1]||0)
  for(const line of content.split(/\r?\n/)) {
    const krc=line.match(/^\[(\d+),(\d+)\](.*)$/)
    const lrc=line.match(/^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/)
    if(krc) { const ms=Math.max(0,Number(krc[1])-offset); const stamp=`[${String(Math.floor(ms/60000)).padStart(2,'0')}:${(ms%60000/1000).toFixed(2).padStart(5,'0')}]`; const text=krc[3].replace(/<\d+,\d+(?:,\d+)?>/g,''); plain.push(text); timed.push(stamp+text); if(translated[index]?.[0]) timed.push(stamp+translated[index][0]); index++ }
    else if(lrc) { plain.push(lrc[2]); for(const match of lrc[1].matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) { const ms=Math.max(0,Number(match[1])*60000+Number(match[2])*1000-offset);timed.push(`[${String(Math.floor(ms/60000)).padStart(2,'0')}:${(ms%60000/1000).toFixed(2).padStart(5,'0')}]${lrc[2]}`) } }
    else if(line && !/^\[[a-z]+:/i.test(line)) plain.push(line)
  }
  if(raw?.translation) timed.push(raw.translation)
  return {plain:plain.join('\n'),content:timed.length?timed.join('\n'):plain.join('\n'),extension:timed.length?'lrc':'txt'}
}

/** Use one account-scoped durable task queue; credentials and playback URLs remain in memory. */
function createDownloadEngine({root,defaultDownloadPath,apiBase='http://localhost:6500',allowLocalTestUrls=false,onState=()=>{},onAuthExpired=()=>{},resolveSource,readExtras,taglibPath}={}) {
  root=path.resolve(root)
  const manifest=path.join(root,'tasks.json'); const active=new Map(); let tasks=[]; let session=null; let generation=0; let revision=0; let stopped=false; let suspended=false; let disk=Promise.resolve(); let preferences={downloadPath:defaultDownloadPath,concurrentDownloads:3,quality:'follow',embedMetadata:true,embedCover:true,saveLyrics:true}; let playbackQuality='128'
  const owner=()=>session?.userid||'guest'
  const snapshot=()=>({revision,generation,userId:session?.userid||null,downloadPath:preferences.downloadPath,tasks:tasks.filter(t=>t.owner===owner()).map(t=>({id:t.id,title:t.song.title,artist:t.song.artists.join('、'),status:t.status,received:t.received||0,total:t.total||null,percent:t.total?Math.min(100,100*(t.received||0)/t.total):null,error:t.error||'',warnings:t.warnings||[],fileName:t.output?path.basename(t.output):'',quality:t.format?`${t.format.toUpperCase()}${t.actualBitrate?` · ${t.actualBitrate} kbps`:''}`:t.song.source==='cloud'?'原文件':`请求 ${t.options.quality}`,playlistName:t.playlistName||''}))})
  function publish() { revision++; onState(snapshot()) }
  function persist() { const data=JSON.stringify({version:1,tasks}); const next=disk.then(async()=>{await fsp.mkdir(root,{recursive:true}); const temp=manifest+'.tmp'; await fsp.writeFile(temp,data);for(let attempt=0;;attempt++){try{await fsp.rename(temp,manifest);break}catch(error){if(attempt>=3||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,[30,80,180][attempt]))}}}); disk=next.catch(()=>{}); return next }
  const ready=(async()=>{ await fsp.mkdir(root,{recursive:true}); try {const saved=JSON.parse(await fsp.readFile(manifest,'utf8')); tasks=(Array.isArray(saved.tasks)?saved.tasks:[]).filter(t=>/^[a-f\d-]{36}$/i.test(t.id)&&typeof t.owner==='string'&&normalizeHash(t.song?.hash)&&Array.isArray(t.song?.artists)&&t.options&&path.isAbsolute(t.directory||'')); for(const t of tasks) {
    if(!COMPLETE.has(t.status)&&t.status!=='canceled') {
      t.status='paused'
      if(t.output&&t.outputDigest) {try {if((await inspectFile(t.output)).sha256===t.outputDigest){t.status='completed-with-warning';t.metadataOnly=false;t.warnings=[...(t.warnings||[]),'音频已保存，上次退出时附加信息未完成']}}catch { /* Missing or edited files remain paused and are checked before metadata retry. */ }}
    }
  } } catch(e) {if(e.code!=='ENOENT') throw transferError('MANIFEST','下载记录无法读取，请检查文件权限');} publish() })()
  function current(run) {return !stopped && run.generation===generation && !run.controller.signal.aborted && run.task.owner===owner()}
  async function api(route,params,run) {
    const url=new URL(route,apiBase); for(const [k,v] of Object.entries(params)) if(v!=null) url.searchParams.set(k,String(v))
    if(session) url.searchParams.set('cookie',`token=${encodeURIComponent(session.token)};userid=${encodeURIComponent(session.userid)}`)
    const response=await requestStream(url.href,{signal:run.controller.signal,localApi:true,allowLocalTestUrls}); const body=JSON.parse((await readBody(response)).toString('utf8'))
    if(Number(body.error_code??body.data?.error_code)===20017) {if(current(run)) onAuthExpired({userId:session?.userid,generation}); throw transferError('AUTH_EXPIRED','登录已失效，请重新登录')}
    if(body.status!==undefined && ![1,200].includes(Number(body.status))) throw transferError('PERMISSION','接口未返回可用内容')
    return body
  }
  async function source(run) {
    const t=run.task; if(resolveSource) return resolveSource(t,session,run.controller.signal)
    let data
    if(t.song.source==='cloud') data=await api('/user/cloud/url',{hash:t.song.hash,audio_id:t.song.audio_id,album_audio_id:t.song.album_audio_id,name:t.song.originalName},run)
    else data=await api('/song/url',{hash:t.song.hash,album_id:t.song.album_id,album_audio_id:t.song.album_audio_id,quality:t.options.quality},run)
    const payload=data.data||data
    if(isPreview(data)) throw transferError('PERMISSION','该歌曲只提供试听，不能作为完整下载')
    let url=payload.url||payload.play_url||payload.playUrl||payload.downurl
    if(Array.isArray(url)) url=url[0]; if(typeof url!=='string'||!url) throw transferError('PERMISSION','没有可下载的完整音源')
    return {url,bitrate:Number(payload.bitrate)||null,size:Number(payload.fileSize||payload.filesize||payload.file_size)||null}
  }
  async function extras(run) {
    const t=run.task; if(readExtras) return readExtras(t,session,run.controller.signal)
    const result={}; const signal=run.controller.signal
    if(t.options.embedCover && t.song.cover) { try {const res=await requestStream(t.song.cover,{signal,artwork:true,allowLocalTestUrls}); if(res.statusCode!==200) {res.resume(); throw new Error('cover')}; const data=await readBody(res,8*1024*1024); const format=detectFormat(data,true); if(!['jpg','png'].includes(format)) throw new Error('cover'); result.cover={data,format} } catch(e) {if(signal.aborted) throw e; t.warnings.push('封面未取得')} }
    else if(t.options.embedCover) t.warnings.push('没有可用封面')
    if(t.options.saveLyrics || t.options.embedMetadata) {
      try {
        let raw=t.song.downloadLyrics
        if(!raw) { const response=await api('/search/lyric',{hash:t.song.hash,album_audio_id:t.song.album_audio_id,keywords:`${t.song.artists.join('、')} - ${t.song.title}`},run); const candidates=(response.candidates||response.data?.candidates||[]).filter(c=>c.id&&c.accesskey); const normalize=v=>String(v||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,''); const candidate=candidates.find(c=>normalize(c.hash)===normalize(t.song.hash))||candidates.find(c=>normalize(c.song||c.songname)===normalize(t.song.title)&&t.song.artists.some(a=>normalize(c.singer)===normalize(a))); if(!candidate) throw new Error('lyric'); raw=await api('/lyric',{id:candidate.id,accesskey:candidate.accesskey,fmt:'krc',decode:true},run) }
        result.lyrics=lyricFiles(raw); if(!result.lyrics.plain) throw new Error('empty lyric')
      } catch(e) {if(signal.aborted) throw e; t.warnings.push('歌词未取得')}
    }
    return result
  }
  async function decorate(t,raw,dir,metadata) {
    const staged=path.join(dir,`tagged.${t.format}`); await fsp.copyFile(raw,staged)
    if(t.options.embedMetadata||t.options.embedCover) {
      if(!['mp3','flac'].includes(t.format)) t.warnings.push('此原格式暂不支持嵌入标签')
      else {
        let file
        try { const lib=require(taglibPath || 'node-taglib-sharp'); file=lib.File.createFromPath(staged)
          if(t.options.embedMetadata) { file.tag.title=t.song.title; file.tag.performers=t.song.artists; if(t.song.album) file.tag.album=t.song.album; if(t.song.year>0&&t.song.year<10000) file.tag.year=t.song.year; if(t.song.track>0) file.tag.track=t.song.track; if(metadata.lyrics?.plain) file.tag.lyrics=metadata.lyrics.plain }
          if(t.options.embedCover&&metadata.cover) file.tag.pictures=[lib.Picture.fromFullData(lib.ByteVector.fromByteArray(metadata.cover.data),lib.PictureType.FrontCover,metadata.cover.format==='png'?'image/png':'image/jpeg','封面')]
          file.save(); file.dispose(); file=null
          file=lib.File.createFromPath(staged); if(t.options.embedMetadata&&file.tag.title!==t.song.title) throw new Error('tag readback')
        } catch { t.warnings.push('标签写入失败，已保留原音频'); file?.dispose(); file=null; await fsp.copyFile(raw,staged) } finally {file?.dispose()}
      }
    }
    return staged
  }
  /** Publish through an exclusive hard link in the destination filesystem, never overwrite a user file. */
  async function publishFile(run,staged,lyrics) {
    const t=run.task
    await fsp.mkdir(t.directory,{recursive:true}); const temporary=path.join(t.directory,`.bk-${t.id}.part`)
    await fsp.copyFile(staged,temporary); const base=safeName(`${t.song.artists.join('、')} - ${t.song.title}`)
    if(!current(run)){await fsp.rm(temporary,{force:true});throw transferError('CANCELLED','任务已暂停')}
    let target
    for(let suffix=0;suffix<10000;suffix++) {target=path.join(t.directory,`${base}${suffix?` (${suffix})`:''}.${t.format}`); try {
      try {await fsp.link(temporary,target)} catch(error) {if(!['ENOTSUP','EOPNOTSUPP','EPERM','EXDEV'].includes(error.code))throw error;await fsp.copyFile(temporary,target,fs.constants.COPYFILE_EXCL)}
      break
    } catch(e) {if(e.code!=='EEXIST') throw e; target=null} }
    if(!target) throw transferError('NAME_CONFLICT','无法为下载文件创建唯一名称')
    t.output=target; t.outputDigest=(await inspectFile(target)).sha256
    // Persist publication before optional sidecars; a later failure must not lose a complete file.
    await persist(); await fsp.rm(temporary,{force:true})
    if(t.options.saveLyrics&&lyrics?.content) { try {await fsp.writeFile(target.slice(0,-path.extname(target).length)+'.'+lyrics.extension,lyrics.content,{flag:'wx',encoding:'utf8'})} catch(e) {t.warnings.push(e.code==='EEXIST'?'已有歌词文件未覆盖':'配套歌词保存失败')} }
  }
  async function execute(run) {
    const t=run.task; const dir=path.join(root,'parts',t.id); const part=path.join(dir,'audio.part')
    try {
      t.warnings=[]; t.error=''; t.status='resolving'; publish(); await persist(); await fsp.mkdir(dir,{recursive:true})
      let info
      if(t.metadataOnly&&t.output) {info=await inspectFile(t.output); if(info.sha256!==t.outputDigest) throw transferError('FILE_CHANGED','导出文件已被修改，无法补全'); await fsp.copyFile(t.output,part)}
      else if(t.cachedVerified) {info=await inspectFile(part)}
      else {
        for(let attempt=0;attempt<3;attempt++) {
          try { const resolved=await source(run); if(!current(run)) return; t.status='downloading'; publish()
            info=await transferFile(resolved.url,part,{signal:run.controller.signal,checkpoint:t.checkpoint,allowLocalTestUrls,onCheckpoint:async checkpoint=>{t.checkpoint=checkpoint;await persist()},onProgress:(received,total)=>{t.received=received;t.total=total; const now=Date.now();if(now-(run.lastProgress||0)>150){run.lastProgress=now;publish()}}})
            if(resolved.size&&info.size!==resolved.size) throw transferError('INCOMPLETE','文件长度与音源信息不一致')
            t.actualBitrate=resolved.bitrate>1000?Math.round(resolved.bitrate/1000):resolved.bitrate; break
          } catch(e) { if(!current(run)||attempt===2||!['NETWORK','INCOMPLETE','ECONNRESET'].includes(e.code))throw e;await new Promise(resolve=>{const timer=setTimeout(done,500*(attempt+1));function done(){clearTimeout(timer);run.controller.signal.removeEventListener('abort',done);resolve()}run.controller.signal.addEventListener('abort',done,{once:true})});if(!current(run))return }
        }
      }
      if(!current(run)) return; t.status='verifying'; t.format=info.format; t.received=info.size;t.total=info.size;publish()
      if(t.song.source!=='cloud'&&((t.options.quality==='flac'&&t.format!=='flac')||(['128','320'].includes(t.options.quality)&&t.actualBitrate&&Number(t.options.quality)!==t.actualBitrate)))t.warnings.push('返回音质与请求不同，已按实际格式保存')
      const metadata=await extras(run); if(!current(run)) return; t.status='tagging';publish()
      const staged=await decorate(t,part,dir,metadata); if(!current(run)) return
      t.status='publishing'; publish(); await publishFile(run,staged,metadata.lyrics)
      t.metadataOnly=false;t.status=t.warnings.length?'completed-with-warning':'completed'; await persist(); publish(); await fsp.rm(dir,{recursive:true,force:true})
    } catch(e) {
      if(run.controller.signal.aborted || !current(run)) return
      t.status=t.output?(COMPLETE.has(t.previousStatus)?t.previousStatus:'completed-with-warning'):'failed'; t.error=['PERMISSION','AUTH_EXPIRED','INCOMPLETE','INVALID_AUDIO','FILE_CHANGED','NAME_CONFLICT'].includes(e.code)?e.message:e.code==='ENOSPC'?'磁盘空间不足，请释放空间后重试':'下载失败，请检查网络及目录权限后重试'; t.errorCode=e.code||'DOWNLOAD_FAILED'; if(t.output)t.warnings.push('音频文件已保留，任务记录或附加信息尚未完整保存');await persist().catch(()=>{});publish()
    } finally {active.delete(t.id);schedule()}
  }
  function schedule() {
    if(stopped||suspended)return
    for(const t of tasks) {if(t.owner!==owner()||t.status!=='queued'||active.has(t.id))continue;const limit=Math.min(t.options.concurrentDownloads||3,...[...active.values()].map(run=>run.task.options.concurrentDownloads||3));if(active.size>=limit)break;const run={task:t,generation,controller:new AbortController()};active.set(t.id,run);run.promise=execute(run)}
  }
  async function halt() {suspended=true;generation++;for(const task of tasks)if(task.owner===owner()&&task.status==='queued')task.status='paused'; for(const r of active.values()) {r.controller.abort();if(ACTIVE.has(r.task.status))r.task.status='paused'} await Promise.allSettled([...active.values()].map(r=>r.promise));await persist();suspended=false}
  async function dispatch(action,payload) {
    await ready
    if(action==='configure') { const d=payload?.download||{}; preferences={downloadPath:path.isAbsolute(d.downloadPath||'')?d.downloadPath:defaultDownloadPath,concurrentDownloads:Math.min(10,Math.max(1,Number(d.concurrentDownloads)||3)),quality:['128','320','flac','high'].includes(d.quality)?d.quality:'follow',embedMetadata:d.embedMetadata!==false,embedCover:d.embedCover!==false,saveLyrics:d.saveLyrics!==false};playbackQuality=['128','320','flac','high'].includes(payload?.playback?.audioQuality)?payload.playback.audioQuality:['128','320','flac','high'].includes(payload?.playback?.quality)?payload.playback.quality:'128';publish();schedule();return snapshot() }
    if(action==='setSession') {await halt();if(Number.isSafeInteger(payload?.generation))generation=payload.generation;session=payload?.userid&&payload?.token?{userid:String(payload.userid),token:String(payload.token)}:null;publish();return snapshot()}
    if(action==='getState')return snapshot()
    if(action==='stop') {stopped=true;await halt();return snapshot()}
    if(stopped)throw transferError('STOPPED','下载服务已停止')
    if(action==='enqueue') {
      if(!Array.isArray(payload?.songs)||!payload.songs.length||payload.songs.length>20000)throw transferError('INVALID_SONG','请选择有效歌曲')
      const songs=payload.songs.map(songData);const playlistName=safeText(payload.playlistName); const directory=playlistName?path.join(preferences.downloadPath,safeName(playlistName)):preferences.downloadPath
      if(!path.isAbsolute(directory||''))throw transferError('DIRECTORY','请先设置下载目录')
      const options={...preferences,quality:preferences.quality==='follow'?playbackQuality:preferences.quality};delete options.downloadPath
      for(const song of songs) {if(song.source==='cloud'&&(!session||song.sourceUserId!==session.userid))throw transferError('ACCOUNT','请登录该云盘文件所属账号')}
      for(const song of songs) { const quality=song.source==='cloud'?'original':options.quality; const existing=tasks.find(t=>t.owner===owner()&&t.song.hash===song.hash&&t.song.source===song.source&&t.options.quality===quality&&t.directory===directory&&t.status!=='canceled');if(existing)continue;const task={id:crypto.randomUUID(),owner:owner(),song,playlistName,directory,options:{...options,quality},status:'queued',createdAt:Date.now(),received:0,total:null,warnings:[]}; const cached=(payload.cachedFiles||[]).find(c=>c.hash===song.hash&&c.source===song.source&&c.quality===quality&&path.isAbsolute(c.path||'')); if(cached){const partDir=path.join(root,'parts',task.id);await fsp.mkdir(partDir,{recursive:true});await fsp.copyFile(cached.path,path.join(partDir,'audio.part'));task.cachedVerified=true} tasks.push(task) }
      await persist();publish();schedule();return snapshot()
    }
    const t=tasks.find(t=>t.id===payload&&t.owner===owner()); if(!t)throw transferError('NOT_FOUND','下载任务不存在')
    if(action==='getFile') {if(!t.output||!COMPLETE.has(t.status))throw transferError('NOT_FOUND','下载尚未完成');await fsp.access(t.output);return t.output}
    if(action==='pause'||action==='cancel') { const run=active.get(t.id);if(run){run.controller.abort();await run.promise}if(!COMPLETE.has(t.status)){t.status=action==='pause'?'paused':'canceled';if(action==='cancel'){await fsp.rm(path.join(root,'parts',t.id),{recursive:true,force:true});t.cachedVerified=false}} }
    else if(action==='resume'||action==='retry'||action==='retryMetadata') {if(active.has(t.id)){if(ACTIVE.has(t.status))return snapshot();await active.get(t.id).promise}if(action==='retryMetadata'){if(!t.output||!COMPLETE.has(t.status))throw transferError('NOT_FOUND','音频尚未完成');t.previousStatus=t.status;t.metadataOnly=true}else if(COMPLETE.has(t.status))return snapshot();t.status='queued';t.error=''}
    else throw transferError('INVALID_ACTION','下载操作无效')
    await persist();publish();schedule();return snapshot()
  }
  return {dispatch,ready,snapshot,stop:()=>dispatch('stop')}
}

if(!isMainThread&&parentPort) {
  const engine=createDownloadEngine({...workerData,onState:state=>parentPort.postMessage({type:'state',state}),onAuthExpired:identity=>parentPort.postMessage({type:'authExpired',...identity})});let commands=Promise.resolve()
  parentPort.on('message',message=>{commands=commands.then(async()=>{try{const result=await engine.dispatch(message.action,message.payload);parentPort.postMessage({id:message.id,type:'result',result});if(message.action==='stop')parentPort.close()}catch(e){parentPort.postMessage({id:message.id,type:'error',error:{code:e.code||'DOWNLOAD_FAILED',message:e.code?e.message:'下载操作失败，请重试'}})}})})
}
module.exports={createDownloadEngine,safeName,songData,lyricFiles}
