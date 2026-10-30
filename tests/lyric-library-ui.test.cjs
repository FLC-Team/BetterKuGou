const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

const motionVue = { ...vue,
  Transition: { setup(_props, { slots }) { return () => slots.default?.()[0] } },
  vModelCheckbox: {}, vModelRadio: {},
  vModelText: { mounted(element, binding) { element.props.value = binding.value }, beforeUpdate(element, binding) { element.props.value = binding.value } }
}
const AnimatedSelect = {
  props: ['modelValue', 'options', 'disabled', 'label'], emits: ['update:modelValue'],
  setup(props, { emit }) { return () => vue.h('select-stub', { ...props, 'onUpdate:modelValue': value => emit('update:modelValue', value) }) }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const sourceRecord = () => ({ hash: 'placeholder-song-hash', title: '测试曲目', artist: '测试歌手', selectedVersionId: 'online-1', updatedAt: 1,
  versions: [
    { id: 'online-1', source: 'online', createdAt: 1, data: { status: 200, decodeContent: '[00:01.00]原歌词' } },
    { id: 'online-2', source: 'online', createdAt: 2, data: { status: 200, decodeContent: '[00:01.00]另一版' } }
  ] })

function mount(t, options = {}) {
  const compile = (relative, globals) => {
    const filename = path.join(__dirname, '../src', relative)
    const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
    const compiled = compileScript(descriptor, { id: 'lyric-library-ui-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
      .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
      .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
    return new Function(...Object.keys(globals), compiled)(...Object.values(globals))
  }
  let record = sourceRecord(), listener, unsubscribed = 0, closed = 0
  const calls = [], protection = []
  const api = {
    async list() { calls.push(['list']); return options.list ? options.list() : [{ hash: record.hash, title: record.title, artist: record.artist, versionCount: record.versions.length }] },
    async read(hash) { calls.push(['read', hash]); return options.read ? options.read(hash) : structuredClone(record) },
    async select(payload) { calls.push(['select', payload]); record.selectedVersionId = payload.versionId; return structuredClone(record) },
    async saveEdit(payload) {
      calls.push(['saveEdit', payload])
      if (options.saveEdit) return options.saveEdit(payload)
      record.versions.push({ id: 'edited-1', source: 'edited', createdAt: 3, data: { status: 200, decodeContent: payload.content } })
      record.selectedVersionId = 'edited-1'
      return structuredClone(record)
    },
    onChanged(callback) { listener = callback; return () => { unsubscribed++ } }
  }
  const AnimatedDetails = { setup(_props, { slots }) { return () => vue.h('details-stub', [slots.summary?.(), slots.default?.()]) } }
  const emptyComponent = { setup() { return () => vue.h('component-stub') } }
  const globals = { Vue: motionVue, window: { electronAPI: { lyricLibrary: options.browser ? undefined : api },
    getComputedStyle() { return { paddingTop: '0' } }, addEventListener() {}, removeEventListener() {} },
    document: { removeEventListener() {} }, logger: { warn() {}, info() {}, error() {} }, AnimatedSelect, AnimatedDetails,
    LyricLibrary: { setup() { return () => vue.h('library-stub') } } }
  let settings
  if (options.settingsViewMode) {
    const utilitySource = fs.readFileSync(path.join(__dirname, '../src/utils/objectUtils.js'), 'utf8')
      .replace(/^import[^\n]*$/gm, '').replace(/export (?=function)/g, '')
    Object.assign(globals, new Function('isReactive', 'toRaw', `${utilitySource}\nreturn { cloneDeep, mergeDeep, replaceReactive }`)(vue.isReactive, vue.toRaw))
    const defaults = () => ({ playback: { lyricLibrary: { enabled: true } }, download: {}, custom: {}, shortcuts: { keys: {} }, software: {}, desktopLyrics: {}, islandLyrics: {} })
    settings = vue.reactive(defaults())
    globals.useSettingsStore = () => ({ settings, ready: vue.ref(true), revision: vue.ref(0), defaults,
      async updateSettings(patch) { calls.push(['saveSettings']); globals.mergeDeep(settings, patch) },
      async importSettings() {
        calls.push(['importSettings'])
        if (options.importSettings) await options.importSettings()
        settings.playback.lyricLibrary.enabled = false
        return {}
      }
    })
    Object.assign(globals, { packageInfo: { version: '0.0.0' }, applyTheme() {}, ThemePackages: emptyComponent,
      ThemeAdjustments: emptyComponent, AppUpdates: emptyComponent, PlaylistCacheSettings: emptyComponent,
      DesktopLyricSettings: emptyComponent, IslandLyricSettings: emptyComponent })
    globals.LyricLibrary = compile('components/common/LyricLibrary.vue', globals)
    globals.LyricSettings = compile('components/common/LyricSettings.vue', globals)
  }
  const Component = compile(options.settingsViewMode ? 'views/SettingsView.vue'
    : `components/common/${options.settingsMode ? 'LyricSettings' : 'LyricLibrary'}.vue`, globals)
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, focus() {},
    addEventListener() {}, removeEventListener() {}, getBoundingClientRect() { return { top: 0 } } })
  const renderer = vue.createRenderer({
    createElement: node, createText: value => node('text', value), createComment: () => node('comment'),
    setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp(item, key, _previous, value) { item.props[key] = value },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item)
      item.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(item)
      else parent.children.splice(index, 0, item)
    },
    remove(item) { if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item) },
    parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1]
  })
  const root = node('root')
  const componentRef = vue.ref(null)
  const preferences = vue.ref({ quality: 'flac', fullscreenLyrics: true, showTranslation: false, lyricLibrary: { enabled: true, autoSave: true, minMatch: 'high', autoUpdate: true }, romanization: 'off', preferSimplifiedChinese: true, segmentLyrics: false, showProfanity: false })
  const app = renderer.createApp({ render: () => vue.h(Component, {
    ref: componentRef,
    ...(options.settingsMode ? { modelValue: preferences.value, 'onUpdate:modelValue': value => { preferences.value = value } } : {}),
    beforeAction: async () => { calls.push(['saveSettings']); return options.beforeAction ? options.beforeAction() : true },
    onClose: () => { closed++ }, 'onProtected-state': value => protection.push(value)
  }) })
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const nodes = item => [item, ...item.children.flatMap(nodes)]
  const text = item => item.text + item.children.map(text).join('')
  const find = predicate => nodes(root).find(predicate)
  return { calls, protection, preferences, settings, unmount, prepareLeave: () => componentRef.value.prepareLeave(), publish: event => listener(event), closed: () => closed, unsubscribed: () => unsubscribed,
    text: () => text(root), button: label => find(item => item.type === 'button' && text(item).includes(label)),
    field: type => find(item => item.type === type), byId: id => find(item => item.props.id === id),
    lyricSettings: () => find(item => item.type === 'div' && String(item.props.class).split(' ').includes('lyric-settings')),
    async openSong() { await flush(); await find(item => item.type === 'button' && text(item).includes('测试曲目')).props.onClick(); await flush() },
    async edit(content) { find(item => item.type === 'textarea').props['onUpdate:modelValue'](content); await flush() }
  }
}

test('library reads wait for persisted settings, failed persistence stops reads and supports retry', async t => {
  let allow = false
  const ui = mount(t, { beforeAction: async () => allow })
  await flush()
  assert.deepEqual(ui.calls, [['saveSettings']])
  assert.match(ui.text(), /请先重试保存设置/)
  allow = true
  await ui.button('刷新').props.onClick()
  await flush()
  assert.deepEqual(ui.calls.slice(-2), [['saveSettings'], ['list']])
  assert.match(ui.text(), /测试曲目/)
})

test('previewing a version does not select it until explicitly used', async t => {
  const ui = mount(t)
  await ui.openSong()
  ui.field('select-stub').props['onUpdate:modelValue']('online-2')
  await flush()
  assert.equal(ui.field('textarea').props.value, '[00:01.00]另一版')
  assert.equal(ui.calls.filter(call => call[0] === 'select').length, 0)
  await ui.button('使用此版本').props.onClick()
  await flush()
  assert.deepEqual(ui.calls.slice(-2), [['saveSettings'], ['select', { hash: 'placeholder-song-hash', versionId: 'online-2' }]])
  assert.match(ui.text(), /已切换歌词版本/)
})

test('saving creates an edited version, retains the original and deduplicates in-flight actions', async t => {
  const pending = deferred()
  const ui = mount(t, { saveEdit: () => pending.promise })
  await ui.openSong()
  await ui.edit('[00:01.00]修正歌词')
  const saving = ui.button('保存为本地版本').props.onClick()
  await flush()
  await ui.button('保存中').props.onClick()
  assert.equal(ui.calls.filter(call => call[0] === 'saveEdit').length, 1)
  assert.equal(ui.protection.at(-1), true)
  const record = sourceRecord()
  record.versions.push({ id: 'edited-1', source: 'edited', languageReset: true, data: { status: 200, decodeContent: '[00:01.00]修正歌词' } })
  record.selectedVersionId = 'edited-1'
  pending.resolve(record)
  await saving
  await flush()
  assert.equal(ui.field('select-stub').props.options.length, 3)
  assert.equal(ui.field('select-stub').props.modelValue, 'edited-1')
  assert.equal(ui.button('保存为本地版本').props.disabled, true)
  assert.equal(ui.protection.at(-1), false)
  assert.match(ui.text(), /此副本已移除原翻译和读音/)
})

test('failed save and external changes preserve edits; close requires an explicit discard', async t => {
  const ui = mount(t, { saveEdit: async () => { throw new Error('磁盘写入失败') } })
  await ui.openSong()
  await ui.edit('[00:01.00]待保存草稿')
  assert.equal(ui.prepareLeave(), false)
  await flush()
  assert.match(ui.text(), /歌词编辑尚未保存/)
  ui.publish({ hash: 'placeholder-song-hash', revision: 4 })
  await ui.button('保存为本地版本').props.onClick()
  await flush()
  assert.equal(ui.field('textarea').props.value, '[00:01.00]待保存草稿')
  assert.match(ui.text(), /磁盘写入失败/)
  assert.match(ui.text(), /请先保存或撤销当前编辑/)
  assert.equal(ui.button('刷新').props.disabled, true)
  await ui.button('关闭').props.onClick()
  await flush()
  assert.equal(ui.closed(), 0)
  await ui.button('继续编辑').props.onClick()
  await flush()
  assert.equal(ui.closed(), 0)
  await ui.button('关闭').props.onClick()
  await flush()
  await ui.button('放弃编辑并关闭').props.onClick()
  assert.equal(ui.closed(), 1)
})

test('clean records allow settings navigation and reverting edits releases the navigation guard', async t => {
  const ui = mount(t)
  await ui.openSong()
  assert.equal(ui.prepareLeave(), true)
  await ui.edit('[00:01.00]待保存内容')
  assert.equal(ui.prepareLeave(), false)
  await ui.button('撤销编辑').props.onClick()
  await flush()
  assert.equal(ui.prepareLeave(), true)
})

test('unmount releases notifications and ignores late reads', async t => {
  const pending = deferred()
  const ui = mount(t, { list: () => pending.promise })
  await flush()
  ui.unmount()
  assert.equal(ui.unsubscribed(), 1)
  pending.resolve([{ hash: 'late', title: '不应出现', versionCount: 1 }])
  await flush()
  assert.equal(ui.calls.some(call => call[0] === 'read'), false)
  assert.equal(ui.protection.at(-1), false)
})

test('lyric preferences preserve playback fields and independently update the library controls', async t => {
  const ui = mount(t, { settingsMode: true })
  await flush()
  ui.byId('lyric-translation').props.onChange({ target: { checked: true } })
  await flush()
  ui.byId('lyric-auto-save').props.onChange({ target: { checked: false } })
  await flush()
  ui.byId('lyric-romanization').props['onUpdate:modelValue']('on')
  await flush()
  assert.equal(ui.preferences.value.quality, 'flac')
  assert.equal(ui.preferences.value.fullscreenLyrics, true)
  assert.equal(ui.preferences.value.showTranslation, true)
  assert.equal(ui.preferences.value.romanization, 'on')
  assert.deepEqual(ui.preferences.value.lyricLibrary, { enabled: true, autoSave: false, minMatch: 'high', autoUpdate: true })
  assert.equal(ui.byId('lyric-min-match').props.disabled, true)
})

test('library opening is blocked by a failed settings save and desktop controls are disabled in a browser', async t => {
  const desktop = mount(t, { settingsMode: true, beforeAction: async () => false })
  await flush()
  await desktop.button('打开').props.onClick()
  await flush()
  assert.match(desktop.text(), /请先重试保存设置/)
  assert.equal(desktop.field('library-stub'), undefined)
  const browser = mount(t, { settingsMode: true, browser: true })
  await flush()
  assert.equal(browser.byId('lyric-library-enabled').props.disabled, true)
  assert.equal(browser.field('fieldset').props.disabled, true)
  assert.equal(browser.byId('lyric-translation').props.disabled, undefined)
})

test('settings import preserves unsaved lyrics and permits retry only after explicit discard', async t => {
  const ui = mount(t, { settingsViewMode: true })
  await flush()
  await ui.button('打开').props.onClick()
  await ui.openSong()
  await ui.edit('[00:01.00]导入前的未保存歌词')
  await ui.button('导入设置').props.onClick()
  await flush()
  assert.equal(ui.calls.filter(call => call[0] === 'importSettings').length, 0)
  assert.equal(ui.settings.playback.lyricLibrary.enabled, true)
  assert.equal(ui.field('textarea').props.value, '[00:01.00]导入前的未保存歌词')
  assert.match(ui.text(), /歌词编辑尚未保存/)
  await ui.button('撤销编辑').props.onClick()
  await flush()
  await ui.button('导入设置').props.onClick()
  await flush()
  assert.equal(ui.calls.filter(call => call[0] === 'importSettings').length, 1)
  assert.equal(ui.settings.playback.lyricLibrary.enabled, false)
  assert.equal(ui.field('textarea'), undefined)
})

test('settings import waits for lyric operations and does not discard a failed-save draft', async t => {
  const pending = deferred()
  const ui = mount(t, { settingsViewMode: true, saveEdit: () => pending.promise })
  await flush()
  await ui.button('打开').props.onClick()
  await ui.openSong()
  await ui.edit('[00:01.00]仍在保存的歌词')
  const saving = ui.button('保存为本地版本').props.onClick()
  await flush()
  await ui.button('导入设置').props.onClick()
  await flush()
  assert.equal(ui.calls.filter(call => call[0] === 'importSettings').length, 0)
  assert.match(ui.text(), /歌词操作尚未完成/)
  pending.reject(new Error('磁盘写入失败'))
  await saving
  await flush()
  assert.equal(ui.field('textarea').props.value, '[00:01.00]仍在保存的歌词')
  await ui.button('导入设置').props.onClick()
  assert.equal(ui.calls.filter(call => call[0] === 'importSettings').length, 0)
})

test('pending settings import retires lyric editing and a failed import restores access', async t => {
  const pending = deferred()
  const ui = mount(t, { settingsViewMode: true, importSettings: () => pending.promise })
  await flush()
  await ui.button('打开').props.onClick()
  await ui.openSong()
  const importing = ui.button('导入设置').props.onClick()
  await flush()
  assert.equal(ui.calls.filter(call => call[0] === 'importSettings').length, 1)
  assert.equal(ui.lyricSettings().props.inert, true)
  pending.reject(new Error('导入文件无效'))
  await importing
  await flush()
  assert.equal(ui.lyricSettings().props.inert, false)
  assert.equal(ui.settings.playback.lyricLibrary.enabled, true)
  assert.equal(ui.field('textarea').props.value, '[00:01.00]原歌词')
  assert.match(ui.text(), /导入失败，原设置已保留/)
})
