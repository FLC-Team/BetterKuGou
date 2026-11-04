const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { Worker } = require('node:worker_threads')
const { createDownloadEngine, songData, safeName, lyricFiles } = require('../electron/services/musicDownloadWorker.cjs')
const { transferFile, inspectFile, allowedArtworkUrl } = require('../electron/services/musicTransfer.cjs')
const { createMusicDownloadService } = require('../electron/services/musicDownloadService')

function mp3() { const frame=Buffer.alloc(417);Buffer.from([255,251,144,100]).copy(frame);return Buffer.concat(Array.from({length:40},()=>frame)) }
function flac() {
  const info=Buffer.alloc(34);info.writeUInt16BE(4096,0);info.writeUInt16BE(4096,2);info.writeBigUInt64BE((44100n<<44n)|(15n<<36n)|4096n,10)
  const crc=(buffer,bits,poly)=>{let value=0;for(const byte of buffer){value^=byte<<(bits-8);for(let bit=0;bit<8;bit++)value=((value<<1)^((value&(1<<(bits-1)))?poly:0))&((1<<bits)-1)}return value}
  const header=Buffer.from([255,248,112,8,0,15,255]);const frame=Buffer.concat([header,Buffer.from([crc(header,8,7),2]),Buffer.alloc(8192)]);const checksum=Buffer.alloc(2);checksum.writeUInt16BE(crc(frame,16,0x8005))
  return Buffer.concat([Buffer.from('fLaC'),Buffer.from([128,0,0,34]),info,frame,checksum])
}
async function area(t){const base=path.resolve(__dirname,'../.agent/tools');await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'download-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir}
async function server(t,handler){const s=http.createServer(handler);await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve)}));return `http://127.0.0.1:${s.address().port}`}
async function wait(engine,predicate){for(let i=0;i<300;i++){const state=engine.snapshot();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('download did not reach expected state: '+JSON.stringify(engine.snapshot().tasks))}
async function engineFor(t,options={}){const dir=await area(t);const output=path.join(dir,'output');const engine=createDownloadEngine({root:path.join(dir,'state'),defaultDownloadPath:output,allowLocalTestUrls:true,...options});await engine.ready;t.after(()=>engine.stop());await engine.dispatch('configure',{download:{downloadPath:output,embedMetadata:false,embedCover:false,saveLyrics:false}});return {engine,dir,output}}

test('download normalization excludes secrets and unsafe metadata while preserving cloud identity',()=>{
  const song=songData({hash:'ABC123',source:'cloud',sourceUserId:'user-a',token:'do-not-store',url:'https://example.invalid/private?token=secret',singerinfo:[{name:'歌手甲'},{name:'歌手乙'}],songname:'Song, Part | 2',downloadLyrics:{content:'[00:01.00]一句'}})
  assert.equal(song.hash,'abc123');assert.equal(song.sourceUserId,'user-a');assert.deepEqual(song.artists,['歌手甲','歌手乙']);assert.equal(song.title,'Song, Part | 2');assert.equal(JSON.stringify(song).includes('do-not-store'),false);assert.equal(song.url,undefined)
  assert.equal(safeName('CON'),'_CON');assert.equal(safeName('../bad:name. '),'.._bad_name');assert.equal(allowedArtworkUrl('http://localhost/private'),false)
  const legacy=songData({hash:'legacy',name:'歌手甲 / 歌手乙 - 歌名 - Live.mp3',singername:'歌手甲 / 歌手乙'})
  assert.equal(legacy.title,'歌名 - Live');assert.deepEqual(legacy.artists,['歌手甲','歌手乙'])
  const titled=songData({hash:'structured',title:'Hello - Live',artists:[{name:'Band & Friends'},{name:'Guest'}]})
  assert.equal(titled.title,'Hello - Live');assert.deepEqual(titled.artists,['Band & Friends','Guest'])
})

test('KRC exports line timings, original spacing and matching translation; plain lyrics stay TXT',()=>{
  const language=Buffer.from(JSON.stringify({content:[{type:1,lyricContent:[['你好']]}]})).toString('base64')
  const lyrics=lyricFiles(`[language:${language}]\n[1000,2000]<0,1000,0>Hello <1000,1000,0>world`)
  assert.equal(lyrics.extension,'lrc');assert.equal(lyrics.plain,'Hello world');assert.equal(lyrics.content,'[00:01.00]Hello world\n[00:01.00]你好')
  assert.equal(lyricFiles('Only text').extension,'txt')
})

test('resumption requires matching strong ETag and exact Content-Range',async t=>{
  const dir=await area(t);const audio=mp3();let receivedRange
  const base=await server(t,(req,res)=>{receivedRange=req.headers.range;const start=Number(req.headers.range?.match(/bytes=(\d+)/)?.[1]||0);res.writeHead(start?206:200,{'Content-Length':audio.length-start,ETag:'"stable"',...(start?{'Content-Range':`bytes ${start}-${audio.length-1}/${audio.length}`}:{})});res.end(audio.subarray(start))})
  const file=path.join(dir,'audio.part');await fs.writeFile(file,audio.subarray(0,1000));const result=await transferFile(base,file,{allowLocalTestUrls:true,checkpoint:{etag:'"stable"',total:audio.length}})
  assert.equal(receivedRange,'bytes=1000-');assert.equal(result.size,audio.length);assert.deepEqual(await fs.readFile(file),audio)
})

test('changed range identity and servers ignoring ranges restart instead of appending',async t=>{
  const dir=await area(t);const audio=mp3();let count=0
  const base=await server(t,(req,res)=>{count++;if(req.headers.range){res.writeHead(206,{'Content-Length':audio.length-5,ETag:'"changed"','Content-Range':`bytes 5-${audio.length-1}/${audio.length}`});res.end(audio.subarray(5))}else{res.writeHead(200,{'Content-Length':audio.length,ETag:'"changed"'});res.end(audio)}})
  const file=path.join(dir,'audio.part');await fs.writeFile(file,Buffer.alloc(5));await transferFile(base,file,{allowLocalTestUrls:true,checkpoint:{etag:'"old"',total:audio.length}})
  assert.equal(count,2);assert.deepEqual(await fs.readFile(file),audio)
})

test('HTML pretending to be audio is never accepted',async t=>{
  const dir=await area(t);const base=await server(t,(_req,res)=>res.end('<html>not an audio file</html>'))
  await assert.rejects(transferFile(base,path.join(dir,'bad.part'),{allowLocalTestUrls:true}),{code:'INVALID_AUDIO'})
})

test('valid signatures with missing audio frames or truncated frame payloads are rejected',async t=>{
  const dir=await area(t)
  for(const [name,data] of [['id3',Buffer.from('ID3\x04\0\0\0\0\0\0')],['mp3',mp3().subarray(0,600)],['flac',flac().subarray(0,42)]]) {
    const file=path.join(dir,name);await fs.writeFile(file,data);await assert.rejects(inspectFile(file),{code:'INVALID_AUDIO'})
  }
})

test('batch publication preserves existing user files and deduplicates active tasks',async t=>{
  const audio=mp3();const base=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Length':audio.length});res.end(audio)})
  const {engine,output,dir}=await engineFor(t,{resolveSource:async()=>({url:base})});await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'歌手 - 歌曲.mp3'),'user-owned')
  const payload={songs:[{hash:'abc',songname:'歌曲',singername:'歌手',token:'not-persisted'}]};await engine.dispatch('enqueue',payload);await engine.dispatch('enqueue',payload)
  const state=await wait(engine,s=>s.tasks[0]?.status==='completed');assert.equal(state.tasks.length,1);assert.equal(state.tasks[0].fileName,'歌手 - 歌曲 (1).mp3');assert.equal(await fs.readFile(path.join(output,'歌手 - 歌曲.mp3'),'utf8'),'user-owned');assert.deepEqual(await fs.readFile(await engine.dispatch('getFile',state.tasks[0].id)),audio)
  assert.equal((await fs.readFile(path.join(dir,'state/tasks.json'),'utf8')).includes('not-persisted'),false)
})

test('missing optional artwork and lyrics keep the complete audio with warnings',async t=>{
  const audio=mp3();const base=await server(t,(_req,res)=>res.end(audio));const {engine,output}=await engineFor(t,{resolveSource:async()=>({url:base}),readExtras:async task=>{task.warnings.push('没有歌词');return {}}})
  await engine.dispatch('configure',{download:{downloadPath:output,embedCover:false,embedMetadata:false,saveLyrics:true}});await engine.dispatch('enqueue',{songs:[{hash:'abc'}]})
  const state=await wait(engine,s=>s.tasks[0]?.status==='completed-with-warning');assert.match(state.tasks[0].warnings.join(),/歌词/);assert.equal((await inspectFile(await engine.dispatch('getFile',state.tasks[0].id))).format,'mp3')
})

test('MP3 and FLAC tags, cover and lyrics round-trip without changing the source audio',async t=>{
  const library=require('node-taglib-sharp');const picture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS6sAAAAASUVORK5CYII=','base64')
  for(const [format,audio] of [['mp3',mp3()],['flac',flac()]]) {
    const base=await server(t,(_req,res)=>res.end(audio));const {engine,output}=await engineFor(t,{resolveSource:async()=>({url:base}),readExtras:async()=>({cover:{format:'png',data:picture},lyrics:{plain:'原文歌词',content:'[00:01.00]原文歌词\n[00:01.00]译文',extension:'lrc'}})})
    await engine.dispatch('configure',{download:{downloadPath:output,embedMetadata:true,embedCover:true,saveLyrics:true}});await engine.dispatch('enqueue',{songs:[{hash:format,name:`歌手甲、歌手乙 - 测试歌曲.${format}`,singername:'歌手甲、歌手乙',album_name:'测试专辑'}]})
    const state=await wait(engine,s=>['completed','completed-with-warning','failed'].includes(s.tasks[0]?.status));assert.equal(state.tasks[0].status,'completed',JSON.stringify(state.tasks[0]));const filePath=await engine.dispatch('getFile',state.tasks[0].id);const tagged=library.File.createFromPath(filePath)
    try{assert.equal(tagged.tag.title,'测试歌曲');assert.deepEqual(tagged.tag.performers,['歌手甲','歌手乙']);assert.equal(tagged.tag.lyrics,'原文歌词');assert.equal(tagged.tag.pictures.length,1)}finally{tagged.dispose()}
    assert.match(await fs.readFile(filePath.replace(/\.[^.]+$/,'.lrc'),'utf8'),/译文/)
    // ID3v1 may be appended as well as ID3v2 prepended; the complete MPEG frame sequence must remain unchanged.
    if(format==='mp3')assert.notEqual((await fs.readFile(filePath)).indexOf(audio),-1)
  }
})

test('pause and restart restore private tasks paused and account changes cannot resume them',async t=>{
  const audio=mp3();const base=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Length':audio.length,ETag:'"slow"'});res.write(audio.subarray(0,1000));const timer=setTimeout(()=>res.end(audio.subarray(1000)),1000);res.on('close',()=>clearTimeout(timer))});const {engine,dir,output}=await engineFor(t,{resolveSource:async()=>({url:base})})
  await engine.dispatch('setSession',{userid:'a',token:'private-token'});await engine.dispatch('enqueue',{songs:[{hash:'abc'}]});await wait(engine,s=>s.tasks[0]?.received>0);let id=engine.snapshot().tasks[0].id;await engine.dispatch('pause',id);assert.equal(engine.snapshot().tasks[0].status,'paused');await engine.stop()
  const restored=createDownloadEngine({root:path.join(dir,'state'),defaultDownloadPath:output,allowLocalTestUrls:true,resolveSource:async()=>({url:base})});t.after(()=>restored.stop());await restored.ready;assert.equal(restored.snapshot().tasks.length,0);await restored.dispatch('setSession',{userid:'b',token:'b-token'});await assert.rejects(restored.dispatch('resume',id),{code:'NOT_FOUND'});await restored.dispatch('setSession',{userid:'a',token:'another-token'});assert.equal(restored.snapshot().tasks[0].status,'paused');assert.equal((await fs.readFile(path.join(dir,'state/tasks.json'),'utf8')).includes('private-token'),false)
})

test('real worker loads from packaged-style directory and task snapshots do not expose paths',async t=>{
  const dir=await area(t);const folder=path.join(dir,'bundle');await fs.mkdir(folder);for(const name of ['musicDownloadWorker.cjs','musicTransfer.cjs'])await fs.copyFile(path.join(__dirname,'../electron/services',name),path.join(folder,name))
  const service=createMusicDownloadService({workerPath:path.join(folder,'musicDownloadWorker.cjs'),root:path.join(dir,'state'),defaultDownloadPath:path.join(dir,'output'),Worker,logger:{error(){}}});t.after(()=>service.stop());await service.configure({download:{downloadPath:path.join(dir,'output')}});await service.setSession({userid:'a',token:'private-token'});const state=await service.getState();assert.equal(state.userId,'a');assert.deepEqual(state.tasks,[]);assert.equal(JSON.stringify(state).includes('private-token'),false)
})

test('cloud downloads enforce ownership and use only the original cloud endpoint without persisting credentials or URLs',async t=>{
  const calls=[];let base
  base=await server(t,(req,res)=>{const url=new URL(req.url,base);calls.push(url.pathname);if(url.pathname==='/user/cloud/url'){res.end(JSON.stringify({status:1,url:[base+'/media?temporary=private-url'],filesize:mp3().length}));return}if(url.pathname==='/media'){res.end(mp3());return}res.writeHead(500);res.end()})
  const {engine,dir}=await engineFor(t,{apiBase:base})
  await engine.dispatch('setSession',{userid:'owner-a',token:'do-not-persist-token'})
  await assert.rejects(engine.dispatch('enqueue',{songs:[{hash:'cloud-a',source:'cloud',sourceUserId:'owner-b'}]}),{code:'ACCOUNT'})
  await engine.dispatch('enqueue',{songs:[{hash:'cloud-a',source:'cloud',sourceUserId:'owner-a',audio_id:1,originalName:'original.mp3'}]})
  await wait(engine,s=>s.tasks[0]?.status==='completed')
  assert.deepEqual(calls,['/user/cloud/url','/media'])
  const persisted=await fs.readFile(path.join(dir,'state/tasks.json'),'utf8');assert.equal(persisted.includes('do-not-persist-token'),false);assert.equal(persisted.includes('private-url'),false);assert.equal(persisted.includes(base),false)
})

test('transient audio failures stop after three attempts and explicit retry can recover',async t=>{
  let attempts=0,fail=true
  const {engine}=await engineFor(t,{resolveSource:async()=>{attempts++;if(fail)throw Object.assign(new Error('offline'),{code:'NETWORK'});return {url:base}}})
  const base=await server(t,(_req,res)=>res.end(mp3()))
  await engine.dispatch('enqueue',{songs:[{hash:'retry'}]});let state=await wait(engine,s=>s.tasks[0]?.status==='failed');assert.equal(attempts,3)
  fail=false;await engine.dispatch('retry',state.tasks[0].id);state=await wait(engine,s=>s.tasks[0]?.status==='completed');assert.equal(attempts,4)
})

test('an optional lyrics failure retains raw audio and metadata retry publishes a new verified copy',async t=>{
  const audio=mp3();const base=await server(t,(_req,res)=>res.end(audio));let missing=true
  const {engine,output}=await engineFor(t,{resolveSource:async()=>({url:base}),readExtras:async task=>{if(missing)task.warnings.push('歌词未取得');return {lyrics:missing?null:{plain:'歌词',content:'[00:01.00]歌词',extension:'lrc'}}}})
  await engine.dispatch('configure',{download:{downloadPath:output,embedMetadata:false,embedCover:false,saveLyrics:true}});await engine.dispatch('enqueue',{songs:[{hash:'metadata'}]})
  let state=await wait(engine,s=>s.tasks[0]?.status==='completed-with-warning');const id=state.tasks[0].id;const original=await engine.dispatch('getFile',id)
  missing=false;await engine.dispatch('retryMetadata',id);state=await wait(engine,s=>s.tasks[0]?.status==='completed');const enriched=await engine.dispatch('getFile',id)
  assert.notEqual(enriched,original);assert.deepEqual(await fs.readFile(original),audio);assert.deepEqual(await fs.readFile(enriched),audio);assert.match(await fs.readFile(enriched.replace(/\.mp3$/,'.lrc'),'utf8'),/歌词/)
  await fs.writeFile(enriched,Buffer.concat([audio,Buffer.from('changed')]))
  await engine.dispatch('retryMetadata',id);state=await wait(engine,s=>s.tasks[0]?.status==='completed');assert.match(state.tasks[0].error,/修改|不完整|校验|下载失败/)
})

test('queued tasks freeze directory, concurrency, quality and metadata preferences at creation',async t=>{
  const audio=mp3();const base=await server(t,(_req,res)=>res.end(audio));let release;const gate=new Promise(resolve=>{release=resolve})
  const {engine,dir,output}=await engineFor(t,{resolveSource:async()=>{await gate;return {url:base}}})
  await engine.dispatch('configure',{playback:{quality:'320'},download:{downloadPath:output,quality:'follow',concurrentDownloads:1,embedMetadata:false,embedCover:false,saveLyrics:false}})
  await engine.dispatch('enqueue',{playlistName:'Playlist',songs:[{hash:'freeze-a'},{hash:'freeze-b'}]})
  await engine.dispatch('configure',{download:{downloadPath:path.join(dir,'new-output'),quality:'flac',concurrentDownloads:9,embedMetadata:true,embedCover:true,saveLyrics:true}})
  release();await wait(engine,s=>s.tasks.every(task=>task.status==='completed'))
  const saved=JSON.parse(await fs.readFile(path.join(dir,'state/tasks.json'),'utf8'))
  for(const task of saved.tasks){assert.equal(task.directory,path.join(output,'Playlist'));assert.equal(task.options.quality,'320');assert.equal(task.options.concurrentDownloads,1);assert.equal(task.options.embedMetadata,false);assert.equal(task.options.embedCover,false);assert.equal(task.options.saveLyrics,false)}
})
