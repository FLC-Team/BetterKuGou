const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { getTelemetryEnvironment } = require('../electron/services/telemetryEnvironment.js')
const { parseReport } = require('../telemetering/activity.cjs')

async function openSettings(directory) {
  const filename = require.resolve('../electron/settingsStore.js')
  delete require.cache[filename]
  const store = require(filename)
  await store.initSettingsStore({
    getPath: () => directory, getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings() {}
  })
  return store
}

test('only a committed local edit changes consent, including across import, export, restart and queued snapshot writes', async t => {
  const parent = path.resolve(__dirname, '../.agent/tools')
  await fs.promises.mkdir(parent, { recursive: true })
  const directory = await fs.promises.mkdtemp(path.join(parent, 'telemetry-consent-'))
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  await fs.promises.writeFile(filename, JSON.stringify({ software: { telemetryEnabled: 'true' } }))
  const store = await openSettings(directory)
  assert.equal(store.getDefaultSettings().software.telemetryEnabled, false)
  assert.equal(store.getSettings().software.telemetryEnabled, false)
  const backup = path.join(directory, 'backup.json')
  const edit = value => store.setSettings({ software: { telemetryEnabled: value } }, { allowTelemetryChange: true })
  const preference = () => store.getSettings().software.telemetryEnabled
  await fs.promises.writeFile(backup, JSON.stringify({ software: { telemetryEnabled: true } }))
  await store.importSettings(backup)
  assert.equal(preference(), false)
  await store.setSettings({ software: { telemetryEnabled: true } })
  assert.equal(preference(), false)
  await edit('true')
  assert.equal(preference(), false)
  await Promise.all([edit(true), store.overwriteSettings({ software: { telemetryEnabled: false } })])
  assert.equal(preference(), true)
  await edit(0)
  assert.equal(preference(), true)
  await store.exportSettings(backup)
  const portable = JSON.parse(await fs.promises.readFile(backup))
  assert.equal(Object.hasOwn(portable.software, 'telemetryEnabled'), false)
  await store.importSettings(backup)
  assert.equal(preference(), true)
  assert.equal((await openSettings(directory)).getSettings().software.telemetryEnabled, true)
  await edit(false)
  assert.equal(JSON.parse(await fs.promises.readFile(filename)).software.telemetryEnabled, false)
})

/** Runs the real renderer settings code with a controlled bridge and no Electron windows. */
function rendererStore(bridge) {
  function load(file, globals, result) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
      .replace(/^import .*$/gm, '').replace(/^export \{.*\}$/gm, '').replace(/^export /gm, '')
    return vm.runInNewContext(source + '\n' + result, { ...vue, structuredClone, ...globals })
  }
  const utils = load('src/utils/objectUtils.js', {}, '({ cloneDeep, mergeDeep, replaceReactive })')
  return load('src/stores/settingsStore.js', {
    ...utils, window: { settingsAPI: bridge }, applyTheme() {}, logger: { warn() {}, error() {} }
  }, 'useSettingsStore()')
}

test('renderer refreshes imported settings without replaying consent from the file or issuing a second write', async () => {
  let committed = { software: { telemetryEnabled: 'true' } }
  let writes = 0
  const store = rendererStore({
    get: async () => committed,
    import: async () => {
      committed = { software: { telemetryEnabled: false, defaultPage: 'favorites' } }
      return { settings: { software: { telemetryEnabled: true } } }
    },
    set() { writes++ }
  })
  await store.initSettings()
  assert.equal(store.settings.software.telemetryEnabled, false)
  await store.importSettings()
  assert.equal(store.settings.software.defaultPage, 'favorites')
  assert.equal(store.settings.software.telemetryEnabled, false)
  assert.equal(writes, 0)
})

test('native system and process are distinct on translated builds and all supported fields pass the receiver contract', () => {
  const cases = [
    { platform: 'win32', arch: 'x64', machine: 'x86_64', release: '10.0.22631', translated: true, expected: ['windows', '11', 'arm64', 'x64'] },
    { platform: 'win32', arch: 'ia32', machine: 'i686', native: 'AMD64', release: '10.0.19045', expected: ['windows', '10', 'x64', 'ia32'] },
    { platform: 'win32', arch: 'ia32', machine: 'i386', release: '6.1.7601', expected: ['windows', 'older', 'ia32', 'ia32'] },
    { platform: 'win32', arch: 'x64', machine: 'x86_64', release: '10.0.26100', product: 'Windows Server 2025', expected: ['windows', 'unknown', 'x64', 'x64'] },
    { platform: 'darwin', arch: 'x64', machine: 'x86_64', translated: true, productVersion: '15.4', release: '24.4.0', expected: ['macos', '15', 'arm64', 'x64'] },
    { platform: 'darwin', arch: 'arm64', machine: 'arm64', release: '24.4.0', expected: ['macos', 'unknown', 'arm64', 'arm64'] },
    { platform: 'linux', arch: 'arm64', machine: 'aarch64', release: '6.12.1-custom', expected: ['linux', '6', 'arm64', 'arm64'] },
    { platform: 'linux', arch: 'x64', machine: 'unrecognized', release: '', expected: ['linux', 'unknown', 'unknown', 'x64'] }
  ]
  for (const entry of cases) {
    const [os_family, os_version_group, os_arch, app_arch] = entry.expected
    const metadata = getTelemetryEnvironment({
      getVersion: () => '1.2.3-beta.1', runningUnderARM64Translation: entry.translated
    }, {
      platform: entry.platform, arch: entry.arch, env: { PROCESSOR_ARCHITEW6432: entry.native },
      getSystemVersion: () => entry.productVersion
    }, { release: () => entry.release, version: () => entry.product, machine: () => entry.machine })
    assert.deepEqual(metadata, { app_version: '1.2.3-beta.1', os_family, os_version_group, os_arch, app_arch })
    const report = { ...metadata, schema_version: 1, install_id: '87654321-1234-4321-b123-123456789abc', revision: 1, activity_date: '2026-11-22' }
    assert.deepEqual(parseReport(report, report.activity_date), report)
  }
  assert.equal(getTelemetryEnvironment({}, { platform: 'unsupported' }), null)
})
