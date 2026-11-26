const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Minimatch } = require('minimatch')
const asar = require('@electron/asar')
const { AsyncTaskManager } = require('builder-util')
const { CancellationToken } = require('builder-util-runtime')
const { PlatformPackager } = require('app-builder-lib')
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher')
const manifest = require('../package.json')

const root = path.resolve(__dirname, '..')

/** Exercise the real app/extraResources copying and ASAR writer without downloading Electron or building native code. */
async function packageRuntime(t) {
  const tools = path.join(root, '.agent/tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'electron-packaging-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), tools)
    for (const filename of Object.keys(require.cache)) {
      if (filename.startsWith(directory + path.sep)) delete require.cache[filename]
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const appDir = path.join(directory, 'source')
  const resources = path.join(directory, 'output/resources')
  fs.mkdirSync(appDir)
  fs.cpSync(path.join(root, 'electron'), path.join(appDir, 'electron'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(manifest))
  const config = manifest.build
  const expand = value => value.replaceAll('${arch}', 'x64')
  const options = { macroExpander: expand, customBuildOptions: config.linux, globalOutDir: path.join(directory, 'output'), defaultSrc: appDir }
  const extra = getFileMatchers(config, 'extraResources', resources, options)
  const exclusions = []
  for (const matcher of extra) matcher.computeParsedPatterns(exclusions, appDir)
  // Linux uses forward slashes here. Normalize on Windows too, so a host-specific glob escape cannot hide the regression.
  const linuxExclusions = exclusions.map(pattern => new Minimatch(pattern.pattern.replaceAll('\\', '/'), { dot: true }))
  const cancellationToken = new CancellationToken()
  const packager = {
    config,
    debugLogger: { isEnabled: false },
    info: { appDir, projectDir: appDir, config, metadata: manifest, buildResourcesDir: 'build', debugLogger: { isEnabled: false },
      areNodeModulesHandledExternally: true, framework: {}, cancellationToken }
  }
  const tasks = new AsyncTaskManager(cancellationToken)
  PlatformPackager.prototype.copyAppFiles.call(packager, tasks, {}, resources, path.join(resources, 'app'),
    { outDir: options.globalOutDir }, config.linux, linuxExclusions, expand)
  await tasks.awaitTasks()
  await copyFiles(extra.filter(matcher => matcher.from === path.join(appDir, 'electron/services')))
  const archive = path.join(resources, 'app.asar')
  const extracted = path.join(directory, 'extracted')
  asar.extractAll(archive, extracted)
  return { archive, extracted, resources }
}

test('Linux ASAR retains the shared transfer module and registers playback media IPC beside external workers', async t => {
  const { archive, extracted, resources } = await packageRuntime(t)
  assert.ok(asar.listPackage(archive).some(filename => filename.replaceAll('\\', '/') === '/electron/services/musicTransfer.cjs'))
  const inside = path.join(extracted, 'electron/services/musicTransfer.cjs')
  const outside = path.join(resources, 'music-download/musicTransfer.cjs')
  assert.deepEqual(fs.readFileSync(inside), fs.readFileSync(outside))
  assert.ok(fs.existsSync(path.join(resources, 'music-download/musicDownloadWorker.cjs')))
  assert.ok(fs.existsSync(path.join(resources, 'audio-effects/audioEffectsWorker.cjs')))
  assert.ok(fs.existsSync(path.join(resources, 'audio-effects/audioEffectsProtocol.cjs')))

  const { createAudioEffectsIntegration } = require(path.join(extracted, 'electron/services/audioEffectsIntegration.js'))
  const handlers = new Map(), protocols = new Map()
  const integration = createAudioEffectsIntegration({
    app: { isPackaged: false, getAppPath: () => extracted, getPath: () => path.join(extracted, 'user-data') },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    protocol: { handle: (scheme, handler) => protocols.set(scheme, handler), unhandle: scheme => protocols.delete(scheme) },
    getMainWindow: () => null, isMainWindowSender: () => true, isQuitting: () => false,
    getSettings: () => ({}), setSettings: async () => {}, logger: { warn() {} }
  })
  t.after(() => integration.stop())
  assert.ok(handlers.has('audio-effects:getStatus'))
  assert.ok(handlers.has('audio-effects:setEnabled'))
  const lease = await handlers.get('audio-effects:acquireMedia')({}, { url: 'https://example.com/audio', identity: 'packaging-test' })
  assert.match(lease.url, /^bk-audio:\/\/media\//)
  assert.ok(protocols.has('bk-audio'))
  assert.equal(await handlers.get('audio-effects:releaseMedia')({}, lease.leaseId), true)
  await integration.stop()
  assert.equal(handlers.size, 0)
  assert.equal(protocols.size, 0)
})
