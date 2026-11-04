const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

const root = path.join(__dirname, '..')
const logger = { trace() {}, info() {}, warn() {}, error() {} }
const clone = value => JSON.parse(JSON.stringify(value))
const stripImports = source => source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const defaults = {
  enabled: false, embed: true, pollingRate: 'medium', displayId: 'primary', region: 'auto',
  windowAlignment: 'auto', contentAlignment: 'auto', albumAlignment: 'auto', originalPosition: 'top',
  adaptive: true, colorMode: 'taskbar', doubleLine: true, karaoke: true, hideTranslation: false,
  songInfoOnly: false, autoHide: false, fontScale: 1, fontFamily: '', transition: 'slide',
  showAlbum: true, showControls: true, showLogo: false, verticalOffset: 0, lineGap: 0,
  maxWidth: 0, marginStart: 0, marginEnd: 0
}

function loadModule(file, globals, names) {
  const source = stripImports(read(file)).replace(/^export \{.*\}\s*$/gm, '').replace(/\bexport (?=(?:async )?function|const)/g, '')
  return vm.runInNewContext(`${source}\n;({ ${names.join(', ')} })`, { ...vue, logger, ...globals })
}
function loadUtils() { return loadModule('src/utils/objectUtils.js', { structuredClone }, ['cloneDeep', 'mergeDeep', 'replaceReactive']) }
function loadRendererStore(settingsAPI) {
  return loadModule('src/stores/settingsStore.js', { ...loadUtils(), window: { settingsAPI }, applyTheme() {}, localStorage: { getItem() { return null }, setItem() {} } },
    ['initSettings', 'useSettingsStore', 'migrateSettings', 'baseDefaultSettings'])
}
function loadMainSchema() {
  const context = vm.createContext({ module: { exports: {} }, process, structuredClone, require(name) {
    if (name === './logger') return logger
    if (name === './autoLaunch') return {}
    if (name === './audioEffectsConfig.cjs') return require('../electron/audioEffectsConfig.cjs')
    return require(name)
  } })
  vm.runInContext(read('electron/settingsStore.js'), context)
  return vm.runInContext("defaultsCache = createDefaults({ getPath: name => '/placeholder/' + name }); ({ defaults: defaultsCache, normalize: ensureSchema })", context)
}
function loadView(store) {
  const { descriptor } = parse(read('src/views/SettingsView.vue'))
  const cleanups = []
  const sandbox = vm.createContext({ ...vue, ...loadUtils(), logger, window: { electronAPI: { taskbarLyric: { show() {} } } }, document: { removeEventListener() {} },
    setTimeout, clearTimeout, useSettingsStore: () => store, applyTheme() {}, defineEmits: () => () => {}, defineExpose() {},
    onMounted() {}, onBeforeUnmount: callback => cleanups.push(callback) })
  const scope = vue.effectScope()
  const view = scope.run(() => vm.runInContext(`${stripImports(descriptor.scriptSetup.content)}\n;({ localSettings, flushEditableSettings, taskbarLyricsAvailable, settingsSaveError })`, sandbox))
  const compiled = compileTemplate({ source: descriptor.template.content, filename: 'SettingsView.vue', id: 'taskbar-settings' })
  assert.deepEqual(compiled.errors, [])
  assert.match(compiled.code, /localSettings\.taskbarLyrics/)
  return { ...view, dispose() { scope.stop(); cleanups.forEach(callback => callback()) } }
}
function loadControls(t, options = {}) {
  const { descriptor } = parse(read('src/components/common/TaskbarLyricSettings.vue'))
  const compiled = compileTemplate({ source: descriptor.template.content, filename: 'TaskbarLyricSettings.vue', id: 'taskbar-settings' })
  assert.deepEqual(compiled.errors, [])
  const preferences = vue.ref(clone(defaults)), mounted = [], cleanups = [], calls = []
  let displayListener, stateListener, releases = 0
  const api = {
    getCapabilities: options.getCapabilities || (async () => ({ supported: true })),
    getDisplays: options.getDisplays || (async () => [{ id: '1', label: 'Screen', primary: true }] ),
    getState: options.getState || (async () => ({ embedded: false, visible: false })),
    show: options.show || (async () => { calls.push('show'); return { success: true } }),
    resetPosition: async () => { calls.push('resetPosition'); return { success: true } },
    onDisplaysChanged(callback) { displayListener = callback; return () => { releases++ } },
    onState(callback) { stateListener = callback; return () => { releases++ } }
  }
  const props = { get modelValue() { return preferences.value }, beforeAction: options.beforeAction || (async () => true), available: options.available !== false }
  const scope = vue.effectScope()
  const component = scope.run(() => vm.runInNewContext(`${stripImports(descriptor.scriptSetup.content)}\n;({ runAction, setPreference, setEnabled, setNumber, setMaxWidth, loadEnvironment, displayOptions, stateMessage, busy, actionError, canOperate, preferences })`, {
    ...vue, logger, window: { electronAPI: { taskbarLyric: api } }, defineProps: () => props,
    defineEmits: () => (_event, value) => { preferences.value = value },
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => cleanups.push(callback)
  }))
  let disposed = false
  const dispose = () => { if (!disposed) { disposed = true; scope.stop(); cleanups.forEach(callback => callback()) } }
  t.after(dispose)
  mounted.forEach(callback => callback())
  return { ...component, calls, dispose, publishDisplays: value => displayListener(value), publishState: value => stateListener(value), releases: () => releases }
}
const flush = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }

test('taskbar schemas migrate old settings and enforce identical safe defaults and types', () => {
  const renderer = loadRendererStore(), main = loadMainSchema()
  assert.deepEqual(clone(main.defaults.taskbarLyrics), defaults)
  assert.deepEqual(clone(renderer.baseDefaultSettings.taskbarLyrics), defaults)
  for (const normalize of [main.normalize, value => renderer.migrateSettings(value, renderer.baseDefaultSettings)]) {
    assert.deepEqual(clone(normalize({}).taskbarLyrics), defaults)
    for (const raw of [null, false, true, 'enabled', [], 1]) assert.deepEqual(clone(normalize({ taskbarLyrics: raw }).taskbarLyrics), defaults)
    for (const [key, fallback] of Object.entries(defaults)) {
      if (typeof fallback === 'boolean') {
        assert.equal(normalize({ taskbarLyrics: { [key]: !fallback } }).taskbarLyrics[key], !fallback)
        for (const invalid of ['true', 1, null, {}]) assert.equal(normalize({ taskbarLyrics: { [key]: invalid } }).taskbarLyrics[key], fallback)
      }
    }
    const result = normalize({ playback: { showTranslation: false }, taskbarLyrics: { hideTranslation: true, unknown: true, displayId: ' 2 ', fontFamily: ' 宋体 ', pollingRate: 'unsafe' } })
    assert.deepEqual(clone(result.taskbarLyrics), { ...defaults, hideTranslation: true, displayId: '2', fontFamily: '宋体' })
    assert.equal(result.playback.showTranslation, false)
    for (const text of ['bad\ntext', 'x'.repeat(101), {}, 23]) {
      assert.equal(normalize({ taskbarLyrics: { fontFamily: text, displayId: text } }).taskbarLyrics.fontFamily, '')
      assert.equal(normalize({ taskbarLyrics: { fontFamily: text, displayId: text } }).taskbarLyrics.displayId, 'primary')
    }
    for (const [key, min, max] of [['fontScale', .5, 2], ['verticalOffset', -200, 200], ['lineGap', -10, 40], ['marginStart', 0, 2000], ['marginEnd', 0, 2000]]) {
      assert.equal(normalize({ taskbarLyrics: { [key]: -9999 } }).taskbarLyrics[key], min)
      assert.equal(normalize({ taskbarLyrics: { [key]: 99999 } }).taskbarLyrics[key], max)
      for (const invalid of ['2', null, Infinity, NaN]) assert.equal(normalize({ taskbarLyrics: { [key]: invalid } }).taskbarLyrics[key], defaults[key])
    }
    for (const [input, expected] of [[0, 0], [-1, 0], [1, 120], [99999, 8192], [Infinity, 0], ['500', 0]]) {
      assert.equal(normalize({ taskbarLyrics: { maxWidth: input } }).taskbarLyrics.maxWidth, expected)
    }
  }
})

test('taskbar edits join the existing save transaction, survive reload, and retain the draft on failure', async () => {
  let snapshot = null, fail = false
  const bridge = { get: async () => snapshot, set: async value => { if (fail) throw new Error('Disk full'); snapshot = clone(value); return snapshot } }
  const loaded = loadRendererStore(bridge)
  await loaded.initSettings()
  const view = loadView(loaded.useSettingsStore())
  try {
    assert.equal(view.taskbarLyricsAvailable, true)
    view.localSettings.taskbarLyrics.showLogo = true
    view.localSettings.taskbarLyrics.fontScale = 1.5
    assert.equal(await view.flushEditableSettings(), true)
    assert.equal(snapshot.taskbarLyrics.fontScale, 1.5)
    fail = true
    view.localSettings.taskbarLyrics.enabled = true
    assert.equal(await view.flushEditableSettings(), false)
    assert.equal(view.localSettings.taskbarLyrics.enabled, true)
    assert.equal(snapshot.taskbarLyrics.enabled, false)
    fail = false
    assert.equal(await view.flushEditableSettings(), true)
    const reloaded = loadRendererStore(bridge)
    await reloaded.initSettings()
    assert.deepEqual(clone(reloaded.useSettingsStore().settings.taskbarLyrics), { ...defaults, showLogo: true, fontScale: 1.5, enabled: true })
  } finally { view.dispose() }
})

test('preview waits for parent persistence, preserves draft after failure, and can retry', async t => {
  let canSave = false
  const component = loadControls(t, { beforeAction: async () => canSave })
  await flush()
  await component.setEnabled(true)
  assert.equal(component.preferences.value.enabled, true)
  assert.deepEqual(component.calls, [])
  assert.match(component.actionError.value, /保存/)
  canSave = true
  await component.runAction('show')
  assert.deepEqual(component.calls, ['show'])
  assert.equal(component.actionError.value, '')
  await component.runAction('resetPosition')
  assert.deepEqual(component.calls, ['show', 'resetPosition'])
})

test('unsupported platforms cannot enable windows, while live screen changes beat initial snapshots', async t => {
  const unavailable = loadControls(t, { getCapabilities: async () => ({ supported: false }) })
  await flush()
  await unavailable.setEnabled(true)
  assert.equal(unavailable.preferences.value.enabled, false)
  assert.deepEqual(unavailable.calls, [])
  let resolveDisplays, resolveState
  const component = loadControls(t, { getDisplays: () => new Promise(resolve => { resolveDisplays = resolve }), getState: () => new Promise(resolve => { resolveState = resolve }) })
  await vue.nextTick()
  component.publishDisplays([{ id: '2', label: 'New screen', primary: true }])
  component.publishState({ embedded: true })
  resolveDisplays([{ id: '1', label: 'Old screen' }])
  resolveState({ embedded: false, visible: true })
  await flush()
  assert.deepEqual(clone(component.displayOptions.value.map(option => option.value)), ['primary', '2'])
  assert.equal(component.stateMessage.value, '正在嵌入任务栏显示。')
  component.dispose()
  assert.equal(component.releases(), 2)
})
