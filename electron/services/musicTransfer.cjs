const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns')
const net = require('node:net')
const crypto = require('node:crypto')

function transferError(code, message) { return Object.assign(new Error(message), { code }) }
function normalizeHash(value) { return typeof value === 'string' && /^[a-z\d_-]{1,128}$/i.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value.toLowerCase()) ? value.toLowerCase() : null }
function privateAddress(address) {
  if (net.isIP(address) === 4) { const [a, b] = address.split('.').map(Number); return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) }
  if (net.isIP(address) === 6) { const v = address.toLowerCase(); return v.startsWith('::ffff:') ? privateAddress(v.slice(7)) : v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) }
  return true
}
function allowedArtworkUrl(raw) {
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && (!u.port || ['80', '443'].includes(u.port)) && (u.hostname === 'kgimg.com' || u.hostname.endsWith('.kgimg.com') || ['imge.kugou.com', 'imgessl.kugou.com', 'img.kugou.com', 'singerimg.kugou.com'].includes(u.hostname)) && ![...u.searchParams.keys()].some(k => /token|cookie|secret|password|signature/i.test(k)) } catch { return false }
}
function detectFormat(b, artwork = false) {
  if (artwork) { if (b.subarray(0, 3).equals(Buffer.from([255,216,255]))) return 'jpg'; if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png'; if (b.subarray(0,3).toString() === 'GIF') return 'gif'; if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP') return 'webp'; return null }
  if (b.subarray(0,4).toString() === 'fLaC') return 'flac'
  if (b.subarray(0,4).toString() === 'OggS') return 'ogg'
  if (b.subarray(0,4).toString() === 'MAC ') return 'ape'
  if (b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WAVE') return 'wav'
  if (b.subarray(4,8).toString() === 'ftyp') return 'm4a'
  if (b.subarray(0,3).toString() === 'ID3') return 'mp3'
  for (let i=0; i<Math.min(b.length-3,4096); i++) if (b[i]===255 && (b[i+1]&224)===224 && (b[i+1]&6)!==0 && (b[i+2]&240)!==240 && (b[i+2]&12)!==12) return 'mp3'
  return null
}
function isPreview(value) {
  return [value, value?.data].some(v => v && (['is_free_part','isFreePart','IsFreePart','is_try','isTrial','is_trial','trial','preview','is_preview'].some(k => v[k]===true || Number(v[k])===1) || Number(v.try_end)>Number(v.try_begin) || Number(v.free_part?.end)>0 || v.free_part===true || Number(v.free_part)===1))
}

/** Requests expose no credentials to media hosts; DNS and every redirect are checked. */
function requestStream(raw, {signal, localApi=false, artwork=false, allowLocalTestUrls=false, headers={}, redirects=0}={}) {
  return new Promise((resolve,reject) => {
    let u; try { u=new URL(raw) } catch { reject(transferError('INVALID_URL','下载来源无效')); return }
    const test=allowLocalTestUrls && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || redirects>5 || (artwork && !test && !allowedArtworkUrl(raw)) || (!localApi && !test && (net.isIP(u.hostname) || (u.port && !['80','443'].includes(u.port))))) { reject(transferError('INVALID_URL','下载来源无效')); return }
    const opts={signal,headers:{'User-Agent':'BetterKuGou/Download','Accept-Encoding':'identity',...headers}}
    if (!localApi && !test) opts.lookup=(host,options,cb) => dns.lookup(host,{...options,all:true},(e,a) => { if(e) return cb(e); if(!a.length || a.some(x=>privateAddress(x.address))) return cb(transferError('INVALID_URL','下载来源地址无效')); return options?.all ? cb(null,a) : cb(null,a[0].address,a[0].family) })
    const req=(u.protocol==='https:'?https:http).get(u,opts,res=>{
      if ([301,302,303,307,308].includes(res.statusCode)) { res.resume(); if(localApi || !res.headers.location) return reject(transferError('INVALID_REDIRECT','下载来源重定向无效')); requestStream(new URL(res.headers.location,u).href,{signal,artwork,allowLocalTestUrls,headers,redirects:redirects+1}).then(resolve,reject); return }
      res.on('error',()=>{}) // Consumers attach their own stream error handler; prevent an early unhandled event.
      resolve(res)
    })
    req.setTimeout(15000,()=>req.destroy(transferError('NETWORK','下载连接超时')))
    req.on('error',e=>reject(e.name==='AbortError'?transferError('CANCELLED','任务已暂停'):transferError(e.code==='INVALID_URL'?'INVALID_URL':'NETWORK','下载网络请求失败')))
  })
}
async function readBody(response, limit=4*1024*1024) { const chunks=[]; let length=0; for await(const chunk of response) { length+=chunk.length; if(length>limit) { response.destroy(); throw transferError('TOO_LARGE','响应超出允许大小') } chunks.push(chunk) } return Buffer.concat(chunks) }

/** Check container boundaries and complete MPEG frames, so a valid signature alone cannot pass. */
async function validateAudio(handle, format, size) {
  const invalid=()=>{throw transferError('INVALID_AUDIO','音频结构不完整或已损坏，请重试')}
  let cached=Buffer.alloc(0),cachedAt=0
  async function read(position,length) {
    if(position<0||position+length>size)invalid()
    if(position<cachedAt||position+length>cachedAt+cached.length){cached=Buffer.alloc(Math.min(Math.max(65536,length),size-position));const result=await handle.read(cached,0,cached.length,position);cached=cached.subarray(0,result.bytesRead);cachedAt=position}
    const result=cached.subarray(position-cachedAt,position-cachedAt+length);if(result.length!==length)invalid();return result
  }
  if(format==='mp3') {
    let position=0,frames=0
    if((await read(0,3)).toString()==='ID3'){const h=await read(0,10);if(h.subarray(6,10).some(v=>v>127))invalid();position=10+(h[6]<<21)+(h[7]<<14)+(h[8]<<7)+h[9]+(h[5]&16?10:0)}
    const rates=[44100,48000,32000]
    const mpeg1={3:[32,64,96,128,160,192,224,256,288,320,352,384,416,448],2:[32,48,56,64,80,96,112,128,160,192,224,256,320,384],1:[32,40,48,56,64,80,96,112,128,160,192,224,256,320]}
    const mpeg2={3:[32,48,56,64,80,96,112,128,144,160,176,192,224,256],2:[8,16,24,32,40,48,56,64,80,96,112,128,144,160],1:[8,16,24,32,40,48,56,64,80,96,112,128,144,160]}
    while(position<size) {
      if(size-position===128&&(await read(position,3)).toString()==='TAG')break
      if(size-position>=32&&(await read(position,8)).toString()==='APETAGEX')break
      const h=await read(position,4),version=(h[1]>>3)&3,layer=(h[1]>>1)&3,rate=(h[2]>>2)&3,bitrateIndex=(h[2]>>4)-1
      if(h[0]!==255||(h[1]&224)!==224||version===1||!layer||rate===3||bitrateIndex<0||bitrateIndex>=14)invalid()
      const bitrate=(version===3?mpeg1:mpeg2)[layer][bitrateIndex]*1000,sampleRate=rates[rate]/(version===3?1:version===2?2:4),padding=(h[2]>>1)&1
      const length=layer===3?Math.floor(12*bitrate/sampleRate+padding)*4:Math.floor((version!==3&&layer===1?72:144)*bitrate/sampleRate)+padding
      if(position+length>size)invalid();position+=length;frames++
    }
    if(!frames)invalid()
  } else if(format==='flac') {
    let position=4,first=true,last=false
    while(!last){const h=await read(position,4),kind=h[0]&127,length=h.readUIntBE(1,3);last=Boolean(h[0]&128);if(first&&(kind!==0||length!==34))invalid();position+=4;if(position+length>size)invalid();position+=length;first=false}
    const frame=await read(position,2);if(frame[0]!==255||(frame[1]&254)!==248)invalid()
    // Each complete FLAC frame includes a CRC16; complete concatenated frames also have zero remainder.
    const table=Array.from({length:256},(_,value)=>{let crc=value<<8;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&32768)?0x8005:0))&65535;return crc})
    let checksum=0
    for await(const chunk of handle.createReadStream({start:position,autoClose:false}))for(const byte of chunk)checksum=((checksum<<8)^table[((checksum>>8)^byte)&255])&65535
    if(checksum!==0)invalid()
  } else if(format==='wav') {
    const head=await read(0,12);if(head.readUInt32LE(4)+8!==size)invalid()
    let position=12,data=false
    while(position<size){const h=await read(position,8),length=h.readUInt32LE(4);if(h.subarray(0,4).toString()==='data'&&length>0)data=true;position+=8+length+(length%2);if(position>size)invalid()}
    if(!data)invalid()
  } else if(format==='m4a') {
    let position=0,audio=false,index=false
    while(position<size){const h=await read(position,8),type=h.subarray(4,8).toString();let length=h.readUInt32BE(0);if(length===1){const extended=(await read(position+8,8)).readBigUInt64BE();if(extended>BigInt(Number.MAX_SAFE_INTEGER))invalid();length=Number(extended)}else if(length===0)length=size-position;if(length<8||position+length>size)invalid();if(type==='mdat'&&length>8)audio=true;if(type==='moov')index=true;position+=length}
    if(!audio||!index)invalid()
  } else if(format==='ogg') {
    let position=0,ended=false
    while(position<size){const h=await read(position,27);if(h.subarray(0,4).toString()!=='OggS'||h[4]!==0)invalid();const lacing=await read(position+27,h[26]);position+=27+h[26]+lacing.reduce((sum,v)=>sum+v,0);if(position>size)invalid();ended=Boolean(h[5]&4)}
    if(!ended)invalid()
  } else if(size<64)invalid()
}
async function inspectFile(file) {
  const handle=await fsp.open(file,'r'); let head
  let format
  try { const b=Buffer.alloc(4096); const {bytesRead}=await handle.read(b,0,b.length,0); head=b.subarray(0,bytesRead);format=detectFormat(head);if(!format)throw transferError('INVALID_AUDIO','返回内容不是支持的音频文件');await validateAudio(handle,format,(await handle.stat()).size) } finally { await handle.close() }
  const sha=crypto.createHash('sha256'); let size=0
  for await(const chunk of fs.createReadStream(file)) { sha.update(chunk); size+=chunk.length }
  return {format,size,sha256:sha.digest('hex')}
}

/** Resume only with a strong validator and exact byte range, otherwise safely restart. */
async function transferFile(url,file,{signal,checkpoint={},onCheckpoint=async()=>{},onProgress=()=>{},allowLocalTestUrls=false}={}) {
  let offset=0; try { offset=(await fsp.stat(file)).size } catch(e) { if(e.code!=='ENOENT') throw e }
  const etag=typeof checkpoint.etag==='string' && !checkpoint.etag.startsWith('W/') ? checkpoint.etag : null
  let response=await requestStream(url,{signal,allowLocalTestUrls,headers:offset && etag ? {Range:`bytes=${offset}-`,'If-Range':etag} : {}})
  let append=false; let total=null
  const range=String(response.headers['content-range']||'').match(/^bytes (\d+)-(\d+)\/(\d+)$/)
  if (response.statusCode===206 && offset && etag && range && Number(range[1])===offset && Number(range[2])>=offset && Number(range[3])>Number(range[2]) && response.headers.etag===etag && (!checkpoint.total || checkpoint.total===Number(range[3]))) { append=true; total=Number(range[3]) }
  else if(response.statusCode!==200) {
    response.resume()
    if(offset && etag && [206,416].includes(response.statusCode)) response=await requestStream(url,{signal,allowLocalTestUrls})
    else throw transferError([401,403].includes(response.statusCode)?'PERMISSION':'NETWORK','无法获取完整音频，请重试')
  }
  if(!append && response.statusCode!==200) { response.resume(); throw transferError('NETWORK','音频响应状态无效') }
  if(!append) { offset=0; total=Number(response.headers['content-length'])||null }
  const next={etag:typeof response.headers.etag==='string'&&!response.headers.etag.startsWith('W/')?response.headers.etag:null,total}
  let handle; let received=offset
  try {
    handle=await fsp.open(file,append?'a':'w')
    // A new validator must never describe bytes left from the previous representation.
    if(!append) await handle.sync()
    await onCheckpoint(next)
    for await(const chunk of response) { if(signal?.aborted) throw transferError('CANCELLED','任务已暂停'); let written=0; while(written<chunk.length) written+=(await handle.write(chunk,written,chunk.length-written)).bytesWritten; received+=chunk.length; onProgress(received,total) }
    await handle.sync()
  } finally {
    try { await handle?.close() } finally { response.destroy() }
  }
  if(signal?.aborted) throw transferError('CANCELLED','任务已暂停')
  if(total!==null && received!==total) throw transferError('INCOMPLETE','音频传输不完整，请重试')
  if(!received) throw transferError('INVALID_AUDIO','音频文件为空')
  return inspectFile(file)
}
module.exports={transferError,normalizeHash,privateAddress,allowedArtworkUrl,detectFormat,isPreview,requestStream,readBody,inspectFile,transferFile}
