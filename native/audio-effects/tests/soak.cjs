// Explicit opt-in endurance test. Audio is synthesized and never sent to a device.
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const binary = process.env.BK_TEST_HOST_BINARY || path.resolve(__dirname, '..', 'bin', `${process.platform}-${process.arch}`, `bk-audio-host${process.platform === 'win32' ? '.exe' : ''}`)
const pluginPath = process.env.BK_SOAK_PLUGIN || process.env.BK_TEST_SERUM_PLUGIN
if (!pluginPath) throw new Error('BK_SOAK_PLUGIN or BK_TEST_SERUM_PLUGIN is required')
const scan = spawnSync(binary, ['--scan', pluginPath], { encoding: 'utf8', windowsHide: true })
if (scan.status !== 0) throw new Error(scan.stderr)
const effect = JSON.parse(scan.stdout).find(item => item.isEffect)
if (!effect) throw new Error('Module contains no effects')
const child = spawn(binary, ['--host'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = Buffer.alloc(0)
const pending = new Map()
let sequence = 0
let stderr = ''
child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-16000) })
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 8) {
    const j = buffer.readUInt32LE(0), p = buffer.readUInt32LE(4)
    if (j > 32 * 1024 * 1024 || p > 1024 * 1024) throw new Error('Protocol length invalid')
    if (buffer.length < 8 + j + p) break
    const header = JSON.parse(buffer.toString('utf8', 8, 8 + j))
    const pcm = Buffer.from(buffer.subarray(8 + j, 8 + j + p))
    buffer = buffer.subarray(8 + j + p)
    const key = header.id ?? (header.type === 'audio' ? `a${header.sequence}` : null)
    const waiter = pending.get(key)
    if (waiter) { pending.delete(key); clearTimeout(waiter.timer); waiter.resolve({ header, pcm }) }
    else if (header.type === 'status' && header.running === false) throw new Error(header.error)
  }
})
function packet(header, pcm = Buffer.alloc(0), expect = true) {
  const j = Buffer.from(JSON.stringify(header)), size = Buffer.alloc(8)
  size.writeUInt32LE(j.length); size.writeUInt32LE(pcm.length, 4)
  const reply = expect ? new Promise((resolve, reject) => {
    const key = header.id ?? `a${header.sequence}`
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timeout ${key} ${stderr}`)) }, 5000)
    pending.set(key, { resolve, reject, timer })
  }) : null
  child.stdin.write(Buffer.concat([size, j, pcm]))
  return reply
}
async function command(command, fields = {}) {
  const reply = await packet({ id: ++sequence, command, ...fields })
  if (!reply.header.ok) throw new Error(JSON.stringify(reply.header.error))
  return reply.header.result
}
async function run() {
  const seconds = Number(process.env.BK_SOAK_SECONDS || 1800)
  await command('configure', { sampleRate: 48000, maxBlockSize: 512, chain: [{ instanceId: 'soak', path: effect.path, classId: effect.classId }] })
  const start = performance.now(), period = 512 / 48
  let blocks = 0, bypassed = 0, nonfinite = 0, maxRoundTripMs = 0, maxScheduleDelayMs = 0
  let nextReport = 0, maxRssBytes = 0
  const pcm = Buffer.alloc(4096), mono = Buffer.alloc(2048)
  console.log(JSON.stringify({ started: new Date().toISOString(), pid: child.pid, effect: effect.name, seconds }))
  while (performance.now() - start < seconds * 1000) {
    const target = start + blocks * period
    const remaining = target - performance.now()
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    maxScheduleDelayMs = Math.max(maxScheduleDelayMs, performance.now() - target)
    for (let i = 0; i < 512; i++) {
      const time = (blocks * 512 + i) / 48000
      const pulse = time % 0.5
      const value = 0.1 * Math.sin(time * Math.PI * 440) + (pulse < 0.03 ? 0.3 * Math.exp(-pulse * 120) * Math.sin(time * Math.PI * 220) : 0)
      pcm.writeFloatLE(value, i * 4); pcm.writeFloatLE(value, (i + 512) * 4); mono.writeFloatLE(value, i * 4)
    }
    const sent = performance.now()
    const reply = await packet({ type: 'audio', sequence: ++sequence, generation: 1, frames: 512, channels: 2, sampleRate: 48000, tempo: 120, position: blocks * 512 / 48000, playing: true }, pcm)
    maxRoundTripMs = Math.max(maxRoundTripMs, performance.now() - sent)
    if (reply.header.bypassed) bypassed++
    for (let i = 0; i < reply.pcm.length; i += 4) if (!Number.isFinite(reply.pcm.readFloatLE(i))) nonfinite++
    packet({ type: 'analysis', trackId: 'synthetic-soak', generation: 1, sampleRate: 48000, channels: 1, frames: 512, position: blocks * 512 / 48000 }, mono, false)
    blocks++
    if (performance.now() - start >= nextReport) {
      if (process.platform === 'win32') {
        const rss = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).WorkingSet64`], { encoding: 'utf8', windowsHide: true })
        maxRssBytes = Math.max(maxRssBytes, Number(rss.stdout.trim()) || 0)
      }
      console.log(JSON.stringify({ elapsedSeconds: (performance.now() - start) / 1000, blocks, bypassed, nonfinite, maxRoundTripMs, maxScheduleDelayMs, maxRssBytes }))
      nextReport += 60000
    }
  }
  await command('getState', { instanceId: 'soak' })
  await command('shutdown')
  child.stdin.end()
  console.log(JSON.stringify({ completed: new Date().toISOString(), blocks, bypassed, nonfinite, maxRoundTripMs, maxScheduleDelayMs, maxRssBytes }))
  if (nonfinite) throw new Error('Non-finite samples')
}
run().catch(error => { console.error(error); child.kill(); process.exitCode = 1 })
