const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')

/** Execute the real dialog action handlers with controlled account/API responses. */
function fixture(overrides = {}, props = {}) {
  const account = { kugou_userid:'account-a', kugou_token:'placeholder-token' }
  const emitted=[]
  let unmount
  const globals={
    computed:vue.computed,ref:vue.ref,nextTick:vue.nextTick,inject:()=>({canWrite:true,addSongs:async()=>true}),onMounted(){},onBeforeUnmount:fn=>{unmount=fn},
    defineProps:()=>({mode:'create',songs:[],playlists:[],resource:null,...props}),defineEmits:()=>((...args)=>emitted.push(args)),
    localStorage:{getItem:key=>account[key]},AbortController,
    createPlaylist:async()=>({status:1}),collectPlaylist:async()=>({status:1}),deletePlaylist:async()=>({status:1}),
    getAllUserPlaylists:async()=>[],getAllPlaylistTracks:async()=>[],addPlaylistSongs:async()=>({status:1}),getPlaylistDetail:async()=>({data:[{globalCollectionId:'public-id',listId:5,ownerId:3,name:'Collection'}]}),
    extractLibraryList:response=>response.data||[],normalizePlaylistResource:(value,options)=>({...value,source:options?.source||value.source}),...overrides
  }
  const content=fs.readFileSync(path.join(__dirname,'../src/components/common/PlaylistDialog.vue'),'utf8')
  const script=content.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*$/gm,'')
  const dialog=new Function(...Object.keys(globals),script+'\nreturn { create, collect, remove, add, close, name, confirmed, error, busy }')(...Object.values(globals))
  return {dialog,account,emitted,unmount:()=>unmount()}
}

test('a timed-out create is read back and retry verifies the previous attempt without duplicate creation',async()=>{
  let writes=0,directory=[]
  const f=fixture({createPlaylist:async()=>{writes++;throw new Error('timeout')},getAllUserPlaylists:async()=>directory})
  f.dialog.name.value='New playlist';await f.dialog.create();assert.equal(writes,1);assert.equal(f.emitted.length,0)
  await f.dialog.create();assert.equal(writes,1);assert.match(f.dialog.error.value,/上次创建/)
  directory=[{listId:8,name:'New playlist',isOwned:true}]
  await f.dialog.create();assert.equal(writes,1);assert.deepEqual(f.emitted.map(value=>value[0]),['changed','close'])
})

test('a changed account cannot trigger follow-up reads or writes from the previous dialog',async()=>{
  let reads=0,writes=0
  const f=fixture({getAllUserPlaylists:async()=>{reads++;return []},createPlaylist:async()=>{writes++;f.account.kugou_userid='account-b';throw new Error('late old response')}})
  f.dialog.name.value='New playlist';await f.dialog.create();assert.equal(reads,1);assert.equal(writes,1);assert.equal(f.emitted.length,0);assert.match(f.dialog.error.value,/账号已变化/)
  await f.dialog.create();assert.equal(reads,1);assert.equal(writes,1)
})

test('delete and uncollect use the account list ID and accept only confirmed directory removal',async()=>{
  const deleted=[];let visible=true
  const resource={id:'global-id',listId:42,source:'owned',isOwned:false,name:'Collected'}
  const f=fixture({deletePlaylist:async id=>{deleted.push(id);throw new Error('timeout')},getAllUserPlaylists:async()=>visible?[resource]:[]},{mode:'manage',resource})
  await f.dialog.remove();assert.deepEqual(deleted,[])
  f.dialog.confirmed.value=true;await f.dialog.remove();assert.deepEqual(deleted,[42]);assert.equal(f.emitted.length,0)
  visible=false;await f.dialog.remove();assert.deepEqual(f.emitted[0],['changed',{removed:resource}])
})

test('collection copies only missing songs and reads back after a timeout before declaring success',async()=>{
  const target={id:'target-global',listId:9,name:'Collection',source:'owned',list_create_gid:'public-id'}
  const sourceSongs=[{hash:'a',name:'A'},{hash:'b',name:'B'}];let directory=[],saved=[sourceSongs[0]],collections=0,adds=[]
  const f=fixture({collectPlaylist:async()=>{collections++;directory=[target];return {status:1,data:{listid:9}}},getAllUserPlaylists:async()=>directory,
    getAllPlaylistTracks:async resource=>resource.source==='public'?sourceSongs:saved,
    addPlaylistSongs:async(id,songs)=>{adds.push([id,songs.map(song=>song.hash)]);saved=[...saved,...songs];throw new Error('timeout after write')}
  },{mode:'manage',resource:{id:'public-id',globalCollectionId:'public-id',name:'Old title',source:'public'}})
  await f.dialog.collect();assert.equal(collections,1);assert.deepEqual(adds,[[9,['b']]]);assert.equal(f.dialog.error.value,'');assert.deepEqual(f.emitted.map(value=>value[0]),['changed','close'])
})

test('collection retries reconcile an unknown target without sending another collect request',async()=>{
  let writes=0,directory=[]
  const f=fixture({collectPlaylist:async()=>{writes++;throw new Error('timeout')},getAllUserPlaylists:async()=>directory},
    {mode:'manage',resource:{id:'public-id',globalCollectionId:'public-id',name:'Collection',source:'public'}})
  await f.dialog.collect();await f.dialog.collect();assert.equal(writes,1);assert.match(f.dialog.error.value,/上次收藏/)
  directory=[{listId:9,name:'Collection',source:'owned'}]
  await f.dialog.collect();assert.equal(writes,1);assert.equal(f.dialog.error.value,'');assert.deepEqual(f.emitted.map(value=>value[0]),['changed','close'])
})

test('bound favorites and unconfirmed favorite candidates cannot be deleted from ordinary playlist entries',async()=>{
  for(const resource of [{listId:42,isFavorite:false},{listId:43,favoriteCandidate:true}]) {
    let writes=0
    const f=fixture({inject:()=>({canWrite:true,state:{resource:{listId:42,isFavorite:true}}}),deletePlaylist:async()=>{writes++}}, {mode:'manage',resource})
    f.dialog.confirmed.value=true;await f.dialog.remove();assert.equal(writes,0);assert.equal(f.emitted.length,0);assert.match(f.dialog.error.value,/收藏歌单不可删除/)
  }
})
