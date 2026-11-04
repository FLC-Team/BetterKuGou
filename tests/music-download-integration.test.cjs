const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

/** Exercise the real main/preload boundary with no account, native dialogs or OS windows. */
function fixture(packaged = false, controls = {}) {
  const handlers = new Map(), calls = [], windows = [], dialogs = [], revealed = []
  let options, savedListener
  const settings = { software: { updates: {} }, download: { downloadPath: '/music', offlineCachePath: '' }, playback: { quality: '128', lyricLibrary: { enabled: true } } }
  const state = { revision: 1, generation: 4, userId: 'account-a', tasks: [] }
  const service = {
    ...Object.fromEntries(['getState','enqueue','pause','resume','cancel','retry','retryMetadata'].map(method => [method, async value => { calls.push([method,value]); return state }])),
    async configure(value) { calls.push(['configure',value]); return state },
    async setSession(value) { calls.push(['setSession',value]); return state },
    async getFile(id) { calls.push(['getFile',id]); return '/music/song.mp3' },
    async stop() { calls.push(['stop']) }
  }
  const cache = { configure() {}, getState: () => state, setSession(value) { calls.push(['cacheSession',value]); return state },
    async stop() { calls.push(['cacheStop']) }, handleRequest() {},
    acquireDownloadSource(value) { calls.push(['lease',value]); return { path: '/private/cache.mp3', release() {} } },
    readLyrics() { return { decodeContent: '[00:01.00]cached' } }
  }
  const app = Object.assign(new EventEmitter(), { isPackaged: packaged, commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}), getPath: () => '/user-data', getAppPath: () => '/app', getVersion: () => '1.0.0' })
  class Window extends EventEmitter {
    constructor() { super(); this.sent=[]; this.webContents=Object.assign(new EventEmitter(), { mainFrame:{},openDevTools(){},send:(...args)=>this.sent.push(args) }); windows.push(this) }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return false }
    close() { this.emit('closed') }
  }
  Window.getAllWindows=()=>windows
  const quiet=Object.fromEntries(['trace','info','warn','error'].map(name=>[name,()=>{}]))
  const context=vm.createContext({
    require(name) {
      if(name==='electron')return {app,BrowserWindow:Window,ipcMain:Object.assign(new EventEmitter(),{handle:(channel,handler)=>handlers.set(channel,handler)}),protocol:{registerSchemesAsPrivileged(){},handle(){}},globalShortcut:{unregisterAll(){}},shell:{showItemInFolder:file=>revealed.push(file)},dialog:{async showOpenDialog(window,options){dialogs.push({window,options});return controls.selectDirectory?controls.selectDirectory():{canceled:false,filePaths:['/selected/music']}}}}
      if(name==='./logger')return quiet
      if(name==='./services/musicDownloadService')return {createMusicDownloadService(value){options=value;return controls.downloadFactory?controls.downloadFactory(value):service}}
      if(name==='./services/playlistCacheService')return {createPlaylistCacheService:()=>cache}
      if(name==='./services/lyricLibraryService')return {createLyricLibraryService:()=>({configure(){},stop:async()=>{},read:async()=>({selectedVersionId:'manual',versions:[{id:'manual',data:{decodeContent:'[00:01.00]selected'}}]})})}
      if(name==='./services/backendService')return {createBackendService:()=>({stop:async()=>{}})}
      if(name==='./services/updateService')return {createUpdateService:()=>({})}
      if(name==='./services/desktopLyricPolicy')return require('../electron/services/desktopLyricPolicy')
      if(name==='./services/windowsForeground')return require('../electron/services/windowsForeground')
      if(name==='./settingsStore')return {normalizeDesktopLyrics:require('../electron/settingsStore').normalizeDesktopLyrics,getSettings:()=>settings,onSettingsChange:listener=>{savedListener=listener;return()=>{}}}
      return require(name)
    },__dirname:path.join(__dirname,'../electron'),process:{platform:'linux',resourcesPath:'/resources',env:{}},setTimeout,clearTimeout,setInterval,clearInterval,global:{}
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../electron/main.js'),'utf8'),context)
  const api=vm.runInContext('({createWindow,initializePlaylistCacheService,initializeLyricLibraryService,initializeMusicDownloadService,subscribeToSettingsUpdates,performApplicationCleanup})',context)
  api.createWindow();api.initializePlaylistCacheService();api.initializeLyricLibraryService();api.initializeMusicDownloadService();api.subscribeToSettingsUpdates()
  const event={sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame}
  return {api,calls,service,settings,state,windows,event,dialogs,revealed,options:()=>options,publish:value=>savedListener(value),invoke:(name,arg,source=event)=>handlers.get(name.includes(':')?name:`downloads:${name}`)(source,arg)}
}

test('download worker paths, shutdown ordering and committed preferences are wired to the app lifecycle',async()=>{
  for(const packaged of [false,true]) {
    const f=fixture(packaged)
    assert.equal(f.options().workerPath,path.join(packaged?'/resources/music-download':'/app/electron/services','musicDownloadWorker.cjs'))
    assert.equal(f.options().root,path.join('/user-data','music-downloads'))
    assert.equal(f.calls[0][0],'configure')
    const next={...f.settings,download:{...f.settings.download,quality:'flac'}};f.publish(next)
    assert.equal(f.calls.at(-1)[1],next)
    f.options().onState(f.state);assert.equal(f.windows[0].sent.at(-1)[0],'downloads:state')
    f.options().onAuthExpired({userId:'previous-account'});assert.equal(f.windows[0].sent.at(-1)[0],'downloads:state')
    f.options().onAuthExpired({userId:'account-a'});assert.equal(f.windows[0].sent.at(-1)[1].generation,4)
    await Promise.all([f.api.performApplicationCleanup(),f.api.performApplicationCleanup()])
    assert.equal(f.calls.filter(([name])=>name==='stop').length,1)
    assert.ok(f.calls.findIndex(([name])=>name==='stop')<f.calls.findIndex(([name])=>name==='cacheStop'))
  }
})

test('all download actions reject auxiliary windows and frames, including asynchronous directory and reveal actions',async()=>{
  const f=fixture()
  for(const name of ['get-state','enqueue','pause','resume','cancel','retry','retry-metadata']) for(const source of [{sender:{}},{sender:f.event.sender,senderFrame:{}}])assert.throws(()=>f.invoke(name,null,source),/主窗口/)
  for(const name of ['reveal','choose-directory'])await assert.rejects(f.invoke(name,null,{sender:{}}),/主窗口/)
  assert.equal(f.calls.length,1)
  assert.equal((await f.invoke('choose-directory')).path,'/selected/music')
  assert.equal(f.settings.download.downloadPath,'/music','directory choice returns a draft and never persists preferences')
  await f.invoke('reveal','owned-task');assert.deepEqual(f.revealed,['/music/song.mp3'])
  await f.api.performApplicationCleanup();assert.throws(()=>f.invoke('get-state'),/主窗口/)
})

test('cache identity and selected lyrics feed downloads only through trusted main-process callbacks',async()=>{
  const f=fixture()
  await f.invoke('playlist-cache:set-session',{userId:'account-a',token:'placeholder-token'})
  const identity=f.calls.find(([name])=>name==='setSession')[1]
  assert.equal(identity.userid,'account-a');assert.equal(identity.token,'placeholder-token')
  await f.invoke('playlist-cache:set-session',null);assert.equal(f.calls.filter(([name])=>name==='setSession').at(-1)[1],null)
  assert.equal((await f.options().getDownloadLyrics({hash:'abc'})).content,'[00:01.00]selected')
  const lease=await f.options().getCachedFile({hash:'abc',source:'cloud',sourceUserId:'account-a'},'original')
  assert.equal(lease.path,'/private/cache.mp3');assert.equal(f.calls.at(-1)[1].source,'cloud');assert.equal(f.calls.at(-1)[1].sourceUserId,'account-a')
  await f.api.performApplicationCleanup()
})

test('a delayed private file response cannot reveal the previous account file after account switching',async t=>{
  const { createMusicDownloadService }=require('../electron/services/musicDownloadService')
  let worker
  class DelayedWorker extends EventEmitter {
    constructor(){super();worker=this;this.state={revision:0,generation:0,userId:null,tasks:[]}}
    postMessage(message){
      if(message.action==='getFile'){this.delayed=message;return}
      queueMicrotask(()=>{
        if(message.action==='setSession')this.state={...this.state,generation:message.payload.generation,userId:message.payload.userid||null}
        this.emit('message',{type:'state',state:this.state})
        this.emit('message',{id:message.id,type:'result',result:message.action==='stop'?true:this.state})
      })
    }
    async terminate(){this.emit('exit',0)}
    finishFile(){this.emit('message',{id:this.delayed.id,type:'result',result:'/private/account-a/song.mp3'})}
  }
  const f=fixture(false,{downloadFactory:options=>createMusicDownloadService({...options,Worker:DelayedWorker})})
  t.after(()=>f.api.performApplicationCleanup())
  await f.invoke('playlist-cache:set-session',{userId:'account-a',token:'placeholder-a'})
  const pending=f.invoke('reveal','private-task')
  const rejected=assert.rejects(pending,{code:'STALE_ACCOUNT'})
  await f.invoke('playlist-cache:set-session',{userId:'account-b',token:'placeholder-b'})
  worker.finishFile()
  await rejected
  assert.deepEqual(f.revealed,[])
  assert.equal((await f.invoke('get-state')).userId,'account-b')
})

test('preload exposes a fixed downloads API without account, raw file paths or generic IPC methods',async()=>{
  let exposed
  const ipc=Object.assign(new EventEmitter(),{invoke:async(...args)=>args})
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../electron/preload.js'),'utf8'),{require:name=>name==='electron'?{contextBridge:{exposeInMainWorld(key,value){if(key==='electronAPI')exposed=value}},ipcRenderer:ipc}:require(name),process:{platform:'win32',versions:{}}})
  const downloads=exposed.downloads
  assert.deepEqual(Object.keys(downloads).sort(),['cancel','chooseDirectory','enqueue','getState','onState','pause','resume','retry','retryMetadata','reveal'].sort())
  assert.equal((await downloads.retryMetadata('task'))[0],'downloads:retry-metadata')
  let received;const detach=downloads.onState(value=>{received=value});ipc.emit('downloads:state',{},'state');assert.equal(received,'state');detach();ipc.emit('downloads:state',{},'later');assert.equal(received,'state')
})
