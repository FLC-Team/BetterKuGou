const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const release = {
  id: 5, version: '0.2.0', tag: 'v0.2.0', name: 'Version 0.2.0', notes: 'Release notes',
  publishedAt: '2026-10-17T00:00:00Z', url: 'https://github.com/example/project/releases/tag/v0.2.0',
  defaultAssetId: 7,
  assets: [{ id: 7, name: 'BetterKuGou-v0.2.0-x64-setup.exe', size: 100, format: 'exe', url: 'https://github.com/example/package.exe', digest: 'sha256:placeholder' }]
}

function fixture({ terminateExits = true } = {}) {
  const timers = new Set()
  const workers = []
  const states = []
  const logs = []
  const logger = Object.fromEntries(['trace', 'warn', 'error', 'info'].map(level => [level, (...args) => logs.push({ level, args })]))
  class MockWorker extends EventEmitter {
    constructor(workerPath, options) {
      super()
      this.path = workerPath
      this.options = options
      this.commands = []
      this.terminateCalls = 0
      workers.push(this)
    }
    postMessage(message) { this.commands.push(message) }
    terminate() {
      this.terminateCalls++
      if (terminateExits) this.emit('exit', 1)
      return Promise.resolve(1)
    }
    result(command, result) { this.emit('message', { id: command.id, type: 'result', result }) }
    fail(command, code = 'NETWORK') { this.emit('message', { id: command.id, type: 'error', error: { code, message: `Failure: ${code}` } }) }
    last(action) { return this.commands.filter(command => command.action === action).at(-1) }
  }
  const context = {
    module: { exports: {} }, process,
    require(name) {
      if (name === '../logger') return logger
      return require(name)
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} }
      timers.add(timer)
      return timer
    },
    clearTimeout(timer) { timers.delete(timer) }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/services/updateService.js'), 'utf8'), context)
  const exported = context.module.exports
  const service = exported.createUpdateService({
    workerPath: '/resources/updater/updateWorker.cjs', downloadRoot: '/user-data/updates',
    currentVersion: '0.1.0', platform: 'win32', arch: 'x64', Worker: MockWorker,
    logger, onState: snapshot => states.push(snapshot)
  })
  return {
    service, workers, timers, states, logs, ...exported,
    fire(delay) {
      const timer = [...timers].find(entry => entry.delay === delay)
      assert.ok(timer, `Expected timer ${delay}`)
      timers.delete(timer)
      timer.callback()
    },
    checked(value = release) {
      const worker = workers.at(-1)
      worker.result(worker.last('check'), { release: value, hasReleases: true, latestVersion: value?.version || '0.1.0', source: 'proxy', checkedAt: '2026-10-17T00:00:00Z' })
      return worker
    },
    downloaded() {
      const worker = workers.at(-1)
      const record = {
        path: '/user-data/updates/package.exe', assetId: 7, assetName: release.assets[0].name,
        version: release.version, format: 'exe', source: 'proxy', size: 100, digest: 'sha256:placeholder'
      }
      worker.result(worker.last('download'), record)
      return record
    }
  }
}

test('automatic checks start after ten seconds and unrelated saved settings preserve the daily schedule', () => {
  const f = fixture()
  f.service.configure({})
  const initialTimer = [...f.timers][0]
  assert.equal(initialTimer.delay, 10_000)
  assert.equal(f.workers.length, 0)
  f.service.configure({ autoCheck: true, autoDownload: false, channel: 'stable' })
  assert.equal([...f.timers][0], initialTimer)
  f.fire(f.INITIAL_CHECK_DELAY)
  assert.equal(f.service.getState().status, 'checking')
  assert.equal(f.workers.length, 1)
  assert.equal(f.workers[0].options.workerData.downloadRoot, '/user-data/updates')
  const command = f.workers[0].last('check')
  assert.equal(command.channel, 'stable')
  assert.equal(command.currentVersion, '0.1.0')
  assert.equal(command.platform, 'win32')
  assert.equal(command.arch, 'x64')
  f.checked(null)
  assert.equal(f.service.getState().status, 'upToDate')
  const dailyTimer = [...f.timers][0]
  assert.equal(dailyTimer.delay, f.CHECK_INTERVAL)
  f.service.configure({ autoCheck: true, autoDownload: false, channel: 'stable' })
  assert.equal([...f.timers][0], dailyTimer)
  f.fire(f.CHECK_INTERVAL)
  assert.equal(f.workers[0].commands.filter(item => item.action === 'check').length, 2)
})

test('initial saved beta preferences never check or download when automatic checking is disabled', () => {
  const f = fixture()
  f.service.configure({ autoCheck: false, autoDownload: true, channel: 'beta' })
  assert.equal(f.service.getState().channel, 'beta')
  assert.equal(f.service.getState().status, 'idle')
  assert.equal(f.timers.size, 0)
  assert.equal(f.workers.length, 0)
  f.service.configure({ autoCheck: false, autoDownload: true, channel: 'beta' })
  assert.equal(f.workers.length, 0)
  assert.equal(f.timers.size, 0)
})

test('initial saved beta preferences respect the startup delay before the first automatic beta check', () => {
  const f = fixture()
  f.service.configure({ autoCheck: true, autoDownload: false, channel: 'beta' })
  assert.equal(f.service.getState().channel, 'beta')
  assert.equal(f.service.getState().status, 'idle')
  assert.equal(f.workers.length, 0)
  assert.equal([...f.timers][0].delay, f.INITIAL_CHECK_DELAY)
  f.fire(f.INITIAL_CHECK_DELAY)
  assert.equal(f.service.getState().status, 'checking')
  assert.equal(f.workers[0].last('check').channel, 'beta')
  assert.equal([...f.timers][0].delay, f.CHECK_INTERVAL)
})

test('manual checks return immediately, deduplicate in-flight work, and never expose URLs or paths', () => {
  const f = fixture()
  f.service.configure({ autoCheck: false })
  assert.equal(f.timers.size, 0)
  assert.equal(f.service.check().status, 'checking')
  assert.equal(f.service.check().status, 'checking')
  assert.equal(f.workers[0].commands.length, 1)
  const worker = f.checked()
  assert.equal(f.service.getState().status, 'available')
  assert.equal(worker.last('download'), undefined)
  const publicState = f.service.getState()
  assert.equal(publicState.release.url, undefined)
  assert.equal(publicState.release.assets[0].url, undefined)
  assert.equal(publicState.release.assets[0].digest, undefined)
  publicState.release.assets[0].name = 'untrusted edit'
  assert.equal(f.service.getState().release.assets[0].name, release.assets[0].name)
  const download = f.service.download(7)
  assert.equal(download.status, 'downloading')
  f.service.download(7)
  assert.equal(worker.commands.filter(command => command.action === 'download').length, 1)
  assert.equal(worker.last('download').asset.url, release.assets[0].url)
  f.downloaded()
  const serialized = JSON.stringify(f.service.getState())
  assert.doesNotMatch(serialized, /user-data|https:|sha256:/)
  assert.equal(f.service.getState().downloaded.name, release.assets[0].name)
  assert.equal(f.states.at(-1).status, 'downloaded')
})

test('automatic download uses eligible metadata, reports progress and never introduces installation commands', () => {
  const f = fixture()
  f.service.configure({ autoCheck: false, autoDownload: true })
  f.service.check()
  const worker = f.checked()
  assert.equal(f.service.getState().status, 'downloading')
  const command = worker.last('download')
  worker.emit('message', { id: command.id, type: 'progress', progress: { received: 30, total: 100, percent: 30, source: 'github' } })
  assert.equal(f.service.getState().progress.percent, 30)
  assert.equal(f.service.getState().source, 'github')
  f.downloaded()
  assert.equal(f.service.getState().status, 'downloaded')
  assert.equal(f.service.download(7).status, 'downloaded')
  assert.deepEqual(worker.commands.map(item => item.action), ['check', 'download'])
})

test('missing matching package does not auto-download and invalid IDs cannot inject a download URL', () => {
  const f = fixture()
  f.service.configure({ autoCheck: false, autoDownload: true })
  f.service.check()
  const worker = f.checked({ ...release, defaultAssetId: null, assets: [] })
  assert.equal(f.service.getState().status, 'available')
  assert.match(f.service.getState().message, /暂无适合/)
  f.service.download({ url: 'https://untrusted.example/file' })
  assert.equal(f.service.getState().error.code, 'UPDATE_NO_ASSET')
  assert.equal(worker.last('download'), undefined)
})

test('user cancellation suppresses this version for the session but manual download remains available', () => {
  const f = fixture()
  f.service.configure({ autoCheck: false, autoDownload: true })
  f.service.check()
  const worker = f.checked()
  const original = worker.last('download')
  const cancelled = f.service.cancel()
  assert.equal(cancelled.status, 'available')
  assert.equal(worker.last('cancel').targetId, original.id)
  worker.result(original, { path: 'stale.exe', version: release.version })
  worker.emit('message', { id: original.id, type: 'progress', progress: { percent: 99 } })
  assert.equal(f.service.getState().downloaded, null)
  assert.equal(f.service.getState().progress, null)
  f.service.configure({ autoCheck: false, autoDownload: true })
  f.service.check()
  f.checked()
  assert.equal(worker.commands.filter(item => item.action === 'download').length, 1)
  assert.equal(f.service.getState().status, 'available')
  f.service.download(7)
  assert.equal(worker.commands.filter(item => item.action === 'download').length, 2)
  f.service.cancel()
  f.service.check()
  f.checked({ ...release, id: 9, version: '0.3.0' })
  assert.equal(worker.commands.filter(item => item.action === 'download').length, 3)
})

test('disabling auto-download cancels automatic work while preserving manual downloads', () => {
  const automatic = fixture()
  automatic.service.configure({ autoCheck: false, autoDownload: true })
  automatic.service.check()
  const worker = automatic.checked()
  automatic.service.configure({ autoCheck: false, autoDownload: false })
  assert.equal(automatic.service.getState().status, 'available')
  assert.equal(worker.last('cancel').targetId, worker.last('download').id)
  automatic.service.configure({ autoCheck: false, autoDownload: true })
  assert.equal(worker.commands.filter(item => item.action === 'download').length, 2)

  const manual = fixture()
  manual.service.configure({ autoCheck: false, autoDownload: false })
  manual.service.check()
  manual.checked()
  manual.service.download(7)
  manual.service.configure({ autoCheck: false, autoDownload: true })
  manual.service.configure({ autoCheck: false, autoDownload: false })
  assert.equal(manual.service.getState().status, 'downloading')
  assert.equal(manual.workers[0].last('cancel'), undefined)
})

test('switching channel cancels the previous task and discards its result before checking the new channel', () => {
  const f = fixture()
  f.service.configure({ autoCheck: false, channel: 'stable' })
  f.service.check()
  const worker = f.workers[0]
  const stale = worker.last('check')
  f.service.configure({ autoCheck: false, channel: 'beta' })
  const latest = worker.last('check')
  assert.notEqual(latest.id, stale.id)
  assert.equal(latest.channel, 'beta')
  assert.equal(f.service.getState().channel, 'beta')
  assert.equal(worker.last('cancel').targetId, stale.id)
  worker.result(stale, { release })
  assert.equal(f.service.getState().status, 'checking')
  assert.equal(f.service.getState().release, null)
  worker.result(latest, { release: { ...release, version: '0.3.0-beta.1' }, source: 'github' })
  assert.equal(f.service.getState().release.version, '0.3.0-beta.1')
  assert.equal(f.timers.size, 0)
})

test('changing channel discards downloaded packages and resets the existing automatic schedule', () => {
  const f = fixture()
  f.service.configure({ autoCheck: true })
  const oldTimer = [...f.timers][0]
  f.service.check()
  f.checked()
  f.service.download(7)
  f.downloaded()
  f.service.configure({ autoCheck: true, channel: 'beta' })
  assert.equal(f.service.getState().downloaded, null)
  assert.equal(f.service.getState().selectedAssetId, null)
  assert.equal(f.service.getState().release, null)
  assert.equal(f.timers.has(oldTimer), false)
  assert.equal([...f.timers][0].delay, f.CHECK_INTERVAL)
})

test('worker failures reject the current operation and a later task uses a fresh worker', () => {
  const f = fixture()
  f.service.check()
  const first = f.workers[0]
  const original = first.last('check')
  first.emit('error', new Error('worker failed'))
  assert.equal(f.service.getState().status, 'error')
  assert.equal(f.service.getState().error.code, 'UPDATE_WORKER_FAILED')
  f.service.check()
  assert.equal(f.workers.length, 2)
  first.result(original, { release })
  first.emit('exit', 1)
  assert.equal(f.service.getState().status, 'checking')
  f.checked()
  f.workers[1].emit('exit', 0)
  assert.equal(f.service.getState().error.code, 'UPDATE_WORKER_EXIT')
})

test('worker errors preserve a useful retryable release candidate', () => {
  const f = fixture()
  f.service.check()
  const worker = f.checked()
  f.service.download(7)
  worker.fail(worker.last('download'), 'DISK_ERROR')
  assert.equal(f.service.getState().status, 'error')
  assert.equal(f.service.getState().error.code, 'DISK_ERROR')
  assert.equal(f.service.getState().release.version, release.version)
  assert.equal(f.service.download(7).status, 'downloading')
})

test('unrelated committed settings do not restart a failed automatic download', () => {
  const f = fixture()
  const preferences = { autoCheck: false, autoDownload: true }
  f.service.configure(preferences)
  f.service.check()
  const worker = f.checked()
  worker.fail(worker.last('download'), 'NETWORK')
  f.service.configure(preferences)
  f.service.configure(preferences)
  assert.equal(f.service.getState().status, 'error')
  assert.equal(worker.commands.filter(item => item.action === 'download').length, 1)
  f.service.check()
  f.checked()
  assert.equal(worker.commands.filter(item => item.action === 'download').length, 2)
})

test('disabling automatic checking invalidates its pending result before it can start a download', () => {
  const f = fixture()
  f.service.configure({ autoCheck: true, autoDownload: true })
  f.fire(f.INITIAL_CHECK_DELAY)
  const worker = f.workers[0]
  const checking = worker.last('check')
  f.service.configure({ autoCheck: false, autoDownload: true })
  assert.equal(worker.last('cancel').targetId, checking.id)
  assert.equal(f.timers.size, 0)
  worker.result(checking, { release, source: 'proxy' })
  assert.equal(f.service.getState().status, 'idle')
  assert.equal(worker.last('download'), undefined)
  f.service.check()
  f.checked()
  assert.equal(f.service.getState().status, 'downloading')
})

test('downloaded files are verified in the worker, verification is deduplicated and paths stay private', async () => {
  const f = fixture()
  await assert.rejects(f.service.getDownloadedFile(), error => error.code === 'UPDATE_NOT_DOWNLOADED')
  f.service.check()
  const worker = f.checked()
  f.service.download(7)
  const record = f.downloaded()
  const pending = f.service.getDownloadedFile()
  assert.equal(pending, f.service.getDownloadedFile())
  const verification = worker.last('verify')
  assert.equal(verification.file.path, record.path)
  assert.equal(worker.commands.filter(item => item.action === 'verify').length, 1)
  worker.result(verification, record)
  assert.equal((await pending).path, record.path)
  assert.equal(f.service.getState().downloaded.path, undefined)
  assert.equal(f.service.getState().status, 'downloaded')
})

test('rechecking the same release retains the downloaded file and failed verification requires downloading again', async () => {
  const f = fixture()
  f.service.check()
  const worker = f.checked()
  f.service.download(7)
  f.downloaded()
  f.service.check()
  f.checked()
  assert.equal(f.service.getState().status, 'downloaded')
  const verification = f.service.getDownloadedFile()
  worker.fail(worker.last('verify'), 'HASH_MISMATCH')
  await assert.rejects(verification, error => error.code === 'HASH_MISMATCH')
  assert.equal(f.service.getState().downloaded, null)
  assert.equal(f.service.getState().error.code, 'HASH_MISMATCH')
  await assert.rejects(f.service.getDownloadedFile(), error => error.code === 'UPDATE_NOT_DOWNLOADED')
})

test('verification of an existing package takes precedence over a background check', async () => {
  const f = fixture()
  f.service.check()
  const worker = f.checked()
  f.service.download(7)
  const record = f.downloaded()
  f.service.check()
  const checking = worker.last('check')
  const pending = f.service.getDownloadedFile()
  assert.equal(worker.last('cancel').targetId, checking.id)
  worker.result(checking, { release: null })
  worker.result(worker.last('verify'), record)
  assert.equal((await pending).path, record.path)
  assert.equal(f.service.getState().status, 'downloaded')
})

test('failed rechecks retain downloaded packages and verification recovers the downloaded state', async () => {
  const f = fixture()
  f.service.check()
  const worker = f.checked()
  f.service.download(7)
  const record = f.downloaded()
  f.service.check()
  worker.fail(worker.last('check'), 'TIMEOUT')
  assert.equal(f.service.getState().status, 'error')
  assert.equal(f.service.getState().downloaded.version, release.version)
  const pending = f.service.getDownloadedFile()
  worker.result(worker.last('verify'), record)
  assert.equal((await pending).path, record.path)
  assert.equal(f.service.getState().status, 'downloaded')
  assert.equal(f.service.getState().error, null)
})

test('stop is shared, clears schedules, rejects verification and ignores all later messages', async () => {
  const f = fixture()
  f.service.configure({})
  f.service.check()
  const worker = f.checked()
  f.service.download(7)
  const record = f.downloaded()
  const verification = f.service.getDownloadedFile()
  const rejected = assert.rejects(verification, error => error.code === 'UPDATE_STOPPED')
  const stop = f.service.stop()
  assert.equal(stop, f.service.stop())
  assert.equal(worker.last('stop').action, 'stop')
  assert.equal([...f.timers].some(item => item.delay === f.INITIAL_CHECK_DELAY), false)
  const revision = f.service.getState().revision
  worker.result(worker.last('verify'), record)
  assert.equal(f.service.getState().revision, revision)
  worker.emit('exit', 0)
  await stop
  await rejected
  assert.equal(f.timers.size, 0)
  assert.equal(worker.terminateCalls, 0)
  assert.equal(f.service.check().revision, revision)
  await assert.rejects(f.service.getDownloadedFile(), error => error.code === 'UPDATE_STOPPED')
})

test('stop terminates an unresponsive worker after a bounded grace period', async () => {
  const f = fixture({ terminateExits: false })
  f.service.check()
  const stop = f.service.stop()
  f.fire(f.STOP_TIMEOUT)
  await stop
  assert.equal(f.workers[0].terminateCalls, 1)
  assert.equal(f.timers.size, 0)
})

test('automatic checking can be disabled without creating a worker and disposal remains safe', async () => {
  const f = fixture()
  f.service.configure({})
  f.service.configure({ autoCheck: false })
  assert.equal(f.timers.size, 0)
  assert.equal(f.workers.length, 0)
  await f.service.stop()
  assert.equal(f.service.configure({ autoCheck: true }).status, 'idle')
  assert.equal(f.timers.size, 0)
})
