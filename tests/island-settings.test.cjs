const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { parse, compileTemplate, compileScript } = require('@vue/compiler-sfc')

const root = path.join(__dirname, '..')
const logger = { trace() {}, info() {}, warn() {}, error() {} }
const clone = value => JSON.parse(JSON.stringify(value))
const stripImports = source => source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')

function loadModule(file, globals, names) {
  const source = stripImports(fs.readFileSync(path.join(root, file), 'utf8'))
    .replace(/^export \{.*\}\s*$/gm, '')
    .replace(/\bexport (?=(?:async )?function|const)/g, '')
  return vm.runInNewContext(`${source}\n;({ ${names.join(', ')} })`, { ...vue, logger, ...globals })
}

function loadUtils() {
  return loadModule('src/utils/objectUtils.js', { structuredClone }, ['cloneDeep', 'mergeDeep', 'replaceReactive'])
}

function loadRendererStore(settingsAPI) {
  return loadModule('src/stores/settingsStore.js', {
    ...loadUtils(), window: { settingsAPI }, applyTheme() {},
    localStorage: { getItem() { return null }, setItem() {} }
  }, ['initSettings', 'useSettingsStore', 'migrateSettings', 'baseDefaultSettings'])
}

function loadMainSchema() {
  const context = vm.createContext({
    module: { exports: {} }, process, structuredClone,
    require(name) {
      if (name === './logger') return logger
      if (name === './autoLaunch') return {}
      return require(name)
    }
  })
  vm.runInContext(fs.readFileSync(path.join(root, 'electron/settingsStore.js'), 'utf8'), context)
  return vm.runInContext("defaultsCache = createDefaults({ getPath: name => '/placeholder/' + name }); ({ defaults: defaultsCache, normalize: ensureSchema })", context)
}

/** Exercise the real settings script and template with isolated Vue effects and bridge calls. */
function loadView(store, islandLyric) {
  const component = fs.readFileSync(path.join(root, 'src/views/SettingsView.vue'), 'utf8')
  const { descriptor } = parse(component)
  const source = stripImports(descriptor.scriptSetup.content)
  const callbacks = []
  const sandbox = vm.createContext({
    ...vue, ...loadUtils(), logger,
    window: { electronAPI: islandLyric ? { islandLyric } : {} },
    document: { removeEventListener() {} }, setTimeout, clearTimeout,
    useSettingsStore: () => store, applyTheme() {}, defineEmits: () => () => {}, defineExpose() {},
    onMounted() {}, onBeforeUnmount: callback => callbacks.push(callback)
  })
  const scope = vue.effectScope()
  const names = ['localSettings', 'flushEditableSettings', 'islandLyricsAvailable', 'settingsSaveError']
  const view = scope.run(() => vm.runInContext(`${source}\n;({ ${names.join(', ')} })`, sandbox))
  const compiled = compileTemplate({ source: descriptor.template.content, filename: 'SettingsView.vue', id: 'island-settings' })
  assert.equal(compiled.errors.length, 0)
  return { ...view, template: compiled.code, dispose() { scope.stop(); callbacks.forEach(callback => callback()) } }
}

const islandDefaults = {
  enabled: false, showLogo: true, mode: 'mainland', displayId: 'primary', position: null,
  alwaysTwoLines: false, hideTranslation: false, songInfoOnly: false, boldText: false,
  fontFamily: '', fontSize: 22, karaokeEnabled: true, autoHide: true,
  hideOnFullscreen: false, hideOnLyricView: true, opacity: 1, backgroundOpacity: 1,
  colors: { text: '#ffffff', inactive: '#656565', background: '#000000' },
  scale: 1, leftContent: 'logo', rightContent: 'cover'
}
const boolKeys = ['enabled', 'showLogo', 'alwaysTwoLines', 'hideTranslation', 'songInfoOnly', 'boldText', 'karaokeEnabled', 'autoHide', 'hideOnFullscreen', 'hideOnLyricView']
const passthrough = { inheritAttrs: false, setup(_props, { slots }) { return () => vue.h(vue.Fragment, null, slots.default?.()) } }
const motionVue = { ...vue, Transition: passthrough, Teleport: passthrough }
function compileComponent(name) {
  const filename = path.join(root, 'src/components/common', name + '.vue')
  const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
  return compileScript(descriptor, { id: name, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
    .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
    .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
}
const compiledComponent = compileComponent('IslandLyricSettings')
const compiledSelect = compileComponent('AnimatedSelect')
const compiledMenu = compileComponent('DropdownMenu')
const managerCode = fs.readFileSync(path.join(root, 'src/utils/contextMenuManager.js'), 'utf8').replace('export default new ContextMenuManager()', 'return new ContextMenuManager()')
const flush = async () => { await vue.nextTick(); await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }

/** Mount real controls; the custom host substitutes DOM storage, never business handlers. */
function mountControls(t, options = {}) {
  let displayListener, released = 0, unmounted = false
  const order = [], calls = []
  const api = options.browser ? undefined : {
    onDisplaysChanged(callback) { order.push('subscribe'); displayListener = callback; return () => { released++ } },
    getDisplays() { order.push('displays'); return options.getDisplays ? options.getDisplays() : Promise.resolve([{ id: '101', label: 'Primary display', primary: true }]) },
    getCapabilities() { order.push('capabilities'); return options.getCapabilities ? options.getCapabilities() : Promise.resolve({ fullscreenDetection: true }) },
    show() { calls.push('show'); return options.show ? options.show() : Promise.resolve({ success: true }) }
  }
  const listenerHost = { addEventListener() {}, removeEventListener() {} }
  const window = { ...listenerHost, electronAPI: { islandLyric: api }, innerWidth: 1280, innerHeight: 720, matchMedia: () => ({ matches: true }) }
  const document = { ...listenerHost, activeElement: null }
  class Observer { observe() {} disconnect() {} }
  const manager = new Function(managerCode)()
  const DropdownMenu = new Function('Vue', 'contextMenuManager', 'window', 'document', 'ResizeObserver', compiledMenu)(motionVue, manager, window, document, Observer)
  const AnimatedSelect = new Function('Vue', 'DropdownMenu', 'window', 'MutationObserver', compiledSelect)(motionVue, DropdownMenu, window, Observer)
  const Component = new Function('Vue', 'window', 'logger', 'AnimatedSelect', compiledComponent)(motionVue, window, logger, AnimatedSelect)
  const nodes = item => [item, ...item.children.flatMap(nodes)]
  const text = item => item.text + item.children.map(text).join('')
  const invoke = (item, name, value = {}) => {
    const handlers = item.props[name]
    for (const handler of Array.isArray(handlers) ? handlers : [handlers]) handler?.({ stopPropagation() {}, preventDefault() {}, ...value })
  }
  const node = (type, value = '') => {
    const item = { type, text: value, props: {}, children: [], parent: null, tagName: type.toUpperCase(), scrollTop: 0,
      offsetWidth: 208, offsetHeight: 40, offsetTop: 0, offsetLeft: 0, scrollHeight: 220, clientHeight: 220,
      getBoundingClientRect: () => ({ left: 40, right: 248, top: 40, bottom: 80, width: 208, height: 40 }),
      contains(target) { return nodes(this).includes(target) },
      setAttribute(key, value) { this.props[key] = value }, removeAttribute(key) { delete this.props[key] },
      querySelector(selector) { const index = selector.match(/data-menu-index="(-?\d+)"/)?.[1]; return nodes(this).find(child => String(child.props['data-menu-index']) === index) || null },
      matches(selector) {
        if (selector !== ':disabled') return false
        for (let current = this; current; current = current.parent) if (current.props.disabled) return true
        return false
      },
      closest() { for (let current = this; current; current = current.parent) if (current.inert || current.props.hidden) return current; return null },
      focus() { if (!this.matches(':disabled')) document.activeElement = this }
    }
    Object.defineProperties(item, { parentElement: { get: () => item.parent }, isConnected: { get: () => item.type === 'root' || Boolean(item.parent?.isConnected) } })
    return vue.markRaw(item)
  }
  const renderer = vue.createRenderer({
    createElement: type => node(type), createText: value => node('text', value), createComment: () => node('comment'),
    setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp(item, key, _previous, value) { item.props[key] = value },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item)
      item.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(item)
      else parent.children.splice(index, 0, item)
    },
    remove(item) { if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item); item.parent = null },
    parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1]
  })
  const preferences = options.preferences || vue.ref(clone(islandDefaults))
  const container = node('root')
  const app = renderer.createApp({ render: () => vue.h(Component, {
    modelValue: preferences.value, 'onUpdate:modelValue': value => { preferences.value = value }, available: !options.browser,
    beforeAction: options.beforeAction || (async () => true)
  }) })
  app.config.warnHandler = warning => {
    // Replacing Teleport with an ordinary test component produces this Vue-only slot diagnostic.
    if (!warning.startsWith('Non-function value encountered for default slot')) throw new Error(warning)
  }
  app.mount(container)
  const unmount = () => { if (!unmounted) { unmounted = true; app.unmount() } }
  t.after(unmount)
  const byId = id => nodes(container).find(item => item.props.id === id)
  const openSelect = async id => {
    const trigger = byId(id)
    assert.equal(trigger.props['aria-haspopup'], 'listbox', id + ' uses the real AnimatedSelect')
    if (!trigger.props['aria-expanded']) invoke(trigger, 'onClick')
    await flush()
  }
  const select = async (id, label) => {
    await openSelect(id)
    const rows = nodes(container).filter(item => item.props.role === 'option')
    const row = rows.find(item => text(item).trim() === label)
    assert.ok(row, 'Actual dropdown option: ' + label + '; found: ' + JSON.stringify(rows.map(text)))
    invoke(row, 'onClick')
    await flush()
  }
  return { calls, order, preferences, publish: value => displayListener(value), released: () => released,
    unmount, text: () => text(container), byId, openSelect, select,
    button: label => nodes(container).find(item => item.type === 'button' && text(item) === label),
    all: () => nodes(container) }
}

test('both schemas supply complete defaults and preserve only strictly typed island booleans', () => {
  const renderer = loadRendererStore()
  const main = loadMainSchema()
  assert.deepEqual(clone(main.defaults.islandLyrics), islandDefaults)
  assert.deepEqual(clone(renderer.baseDefaultSettings.islandLyrics), islandDefaults)
  for (const normalize of [main.normalize, value => renderer.migrateSettings(value, renderer.baseDefaultSettings)]) {
    assert.deepEqual(clone(normalize({}).islandLyrics), islandDefaults)
    for (const key of boolKeys) {
      for (const value of [true, false]) assert.equal(normalize({ islandLyrics: { [key]: value } }).islandLyrics[key], value)
      for (const value of ['true', 'false', 1, 0, null, {}, []]) assert.equal(normalize({ islandLyrics: { [key]: value } }).islandLyrics[key], islandDefaults[key])
    }
    const legacy = normalize({ islandLyrics: { enabled: true, showLogo: false, showTranslation: false, preset: 'custom' }, playback: { showTranslation: false } })
    assert.deepEqual(clone(legacy.islandLyrics), { ...islandDefaults, enabled: true, showLogo: false })
    assert.equal(legacy.playback.showTranslation, false)
    for (const islandLyrics of [null, false, true, 'enabled', [], 1]) assert.deepEqual(clone(normalize({ islandLyrics }).islandLyrics), islandDefaults)
  }
})

test('both schemas clamp finite numbers and positions and validate enums, fonts and colors identically', () => {
  const renderer = loadRendererStore()
  const main = loadMainSchema()
  for (const normalize of [main.normalize, value => renderer.migrateSettings(value, renderer.baseDefaultSettings)]) {
    const schema = islandLyrics => clone(normalize({ islandLyrics }).islandLyrics)
    for (const [key, minimum, maximum] of [['fontSize', 14, 40], ['opacity', .2, 1], ['backgroundOpacity', 0, 1], ['scale', .5, 2]]) {
      assert.equal(schema({ [key]: -100 })[key], minimum)
      assert.equal(schema({ [key]: 100000 })[key], maximum)
      for (const value of ['22', '', null, true, {}, NaN, Infinity]) assert.equal(schema({ [key]: value })[key], islandDefaults[key])
    }
    assert.equal(schema({ fontSize: 22.6 }).fontSize, 23)
    assert.equal(schema({ scale: .75 }).scale, .75)
    assert.deepEqual(schema({ position: { x: -200000, y: 27.6, width: 10 } }).position, { x: -100000, y: 28 })
    for (const position of [null, {}, { x: '5', y: 2 }, { x: 1 }, { x: NaN, y: 1 }]) assert.equal(schema({ position }).position, null)
    assert.equal(schema({ mode: 'floating' }).mode, 'floating')
    assert.equal(schema({ mode: 'other' }).mode, 'mainland')
    for (const field of ['leftContent', 'rightContent']) {
      for (const value of ['none', 'logo', 'cover']) assert.equal(schema({ [field]: value })[field], value)
      assert.equal(schema({ [field]: 'script' })[field], islandDefaults[field])
    }
    assert.equal(schema({ displayId: ' 1234 ' }).displayId, '1234')
    assert.equal(schema({ fontFamily: ' 思源黑体 ' }).fontFamily, '思源黑体')
    for (const fontFamily of ['bad\nfont', '\x00', 'x'.repeat(101), {}, 12]) assert.equal(schema({ fontFamily }).fontFamily, '')
    for (const displayId of ['', ' ', 'bad\nmonitor', 'x'.repeat(101), {}, 12]) assert.equal(schema({ displayId }).displayId, 'primary')
    assert.deepEqual(schema({ colors: { text: '#AABBCC', inactive: 'rgba(0,0,0,1)', background: '#fff', other: '#123456' } }).colors,
      { text: '#aabbcc', inactive: '#656565', background: '#000000' })
    for (const colors of [null, [], '#ffffff']) assert.deepEqual(schema({ colors }).colors, islandDefaults.colors)
  }
})

test('logo visibility saves while disabled and survives a later enable and restart', async () => {
  let snapshot = null
  const writes = []
  const loaded = loadRendererStore({ get: async () => snapshot, set: async value => { snapshot = clone(value); writes.push(snapshot); return snapshot } })
  await loaded.initSettings()
  const store = loaded.useSettingsStore()
  const view = loadView(store, { show: async () => ({ success: true }) })
  try {
    view.localSettings.islandLyrics.showLogo = false
    assert.equal(await view.flushEditableSettings(), true)
    assert.deepEqual(writes.at(-1).islandLyrics, { ...islandDefaults, showLogo: false })
    view.localSettings.islandLyrics.enabled = true
    assert.equal(await view.flushEditableSettings(), true)
    assert.deepEqual(writes.at(-1).islandLyrics, { ...islandDefaults, enabled: true, showLogo: false })
    assert.match(view.template, /localSettings\.islandLyrics/)
    assert.match(view.template, /before-action.*flushEditableSettings/)
    const reloaded = loadRendererStore({ get: async () => snapshot, set: async value => value })
    await reloaded.initSettings()
    assert.equal(reloaded.useSettingsStore().settings.islandLyrics.showLogo, false)
  } finally { view.dispose() }
})

test('real controls update parent drafts; failed saves retain edits and retry without replacing playback', async t => {
  let snapshot = null, failWrite = false
  const loaded = loadRendererStore({ get: async () => snapshot, set: async value => {
    if (failWrite) throw new Error('Disk full')
    snapshot = clone(value); return snapshot
  } })
  await loaded.initSettings()
  const store = loaded.useSettingsStore()
  await store.saveSessionSnapshot({ currentSong: { hash: 'confirmed' }, playbackState: { currentTime: 42 } })
  const view = loadView(store, { show: async () => ({ success: true }) })
  const preferences = vue.computed({ get: () => view.localSettings.islandLyrics, set: value => { view.localSettings.islandLyrics = value } })
  const ui = mountControls(t, { preferences, beforeAction: view.flushEditableSettings })
  try {
    await flush()
    ui.byId('island-logo').props.onChange({ target: { checked: false } })
    await vue.nextTick()
    failWrite = true
    await ui.byId('island-enabled').props.onChange({ target: { checked: true } })
    assert.equal(ui.calls.length, 0)
    assert.equal(view.localSettings.islandLyrics.enabled, true)
    assert.equal(view.localSettings.islandLyrics.showLogo, false)
    assert.equal(store.settings.islandLyrics.enabled, false)
    assert.equal(store.settings.islandLyrics.showLogo, true)
    assert.match(view.settingsSaveError.value, /修改仍保留/)
    failWrite = false
    await vue.nextTick()
    await ui.button('重新显示 / 找回').props.onClick()
    assert.equal(ui.calls.length, 1)
    assert.equal(snapshot.islandLyrics.enabled, true)
    assert.equal(snapshot.islandLyrics.showLogo, false)
    assert.equal(snapshot.session.currentSong.hash, 'confirmed')
    assert.equal(snapshot.session.playbackState.currentTime, 42)
    assert.equal(view.localSettings.session, undefined)
  } finally { ui.unmount(); view.dispose() }
})

test('enabling saves the parent draft before preview, blocks concurrent toggles and disabling never previews', async t => {
  let snapshot = null, finishSave, holdSave = false
  const order = []
  const loaded = loadRendererStore({ get: async () => snapshot, set: async value => {
    order.push('save:start')
    if (holdSave) await new Promise(resolve => { finishSave = resolve })
    snapshot = clone(value)
    order.push('save:complete')
    return snapshot
  } })
  await loaded.initSettings()
  const view = loadView(loaded.useSettingsStore(), { show: async () => ({ success: true }) })
  const preferences = vue.computed({ get: () => view.localSettings.islandLyrics, set: value => { view.localSettings.islandLyrics = value } })
  const ui = mountControls(t, { preferences, beforeAction: async () => {
    assert.equal(view.localSettings.islandLyrics.enabled, true)
    order.push('beforeAction')
    return view.flushEditableSettings()
  }, show: async () => {
    assert.equal(snapshot.islandLyrics.enabled, true)
    order.push('show')
    return { success: true }
  } })
  try {
    await flush()
    order.length = 0
    holdSave = true
    const pending = ui.byId('island-enabled').props.onChange({ target: { checked: true } })
    await flush()
    assert.equal(ui.preferences.value.enabled, true)
    assert.equal(ui.all().find(node => node.type === 'fieldset').props.disabled, true)
    assert.deepEqual(order, ['beforeAction', 'save:start'])
    assert.equal(ui.calls.length, 0)
    await ui.byId('island-enabled').props.onChange({ target: { checked: false } })
    await ui.byId('island-enabled').props.onChange({ target: { checked: true } })
    assert.equal(ui.preferences.value.enabled, true)
    assert.deepEqual(order, ['beforeAction', 'save:start'])
    finishSave()
    await pending
    await flush()
    assert.deepEqual(order, ['beforeAction', 'save:start', 'save:complete', 'show'])
    assert.equal(ui.calls.length, 1)
    holdSave = false
    order.length = 0
    await ui.byId('island-enabled').props.onChange({ target: { checked: false } })
    assert.equal(await view.flushEditableSettings(), true)
    assert.equal(snapshot.islandLyrics.enabled, false)
    assert.equal(ui.calls.length, 1)
    assert.deepEqual(order, ['save:start', 'save:complete'])
  } finally { finishSave?.(); ui.unmount(); view.dispose() }
})

test('every visible setting edits its intended model field and preserves unrelated preferences', async t => {
  const ui = mountControls(t)
  await flush()
  const toggles = { showLogo: 'logo', alwaysTwoLines: 'alwaysTwoLines', hideTranslation: 'hideTranslation', songInfoOnly: 'songInfoOnly', boldText: 'boldText', karaokeEnabled: 'karaokeEnabled', autoHide: 'auto-hide', hideOnFullscreen: 'hide-fullscreen', hideOnLyricView: 'hide-lyrics' }
  for (const [field, id] of Object.entries(toggles)) {
    const next = !islandDefaults[field]
    await ui.byId(`island-${id}`).props.onChange({ target: { checked: next } })
    await vue.nextTick()
    assert.equal(ui.preferences.value[field], next, field)
  }
  await ui.select('island-mode', '浮动 · 自由拖动')
  await vue.nextTick()
  ui.byId('island-position-x').props.onChange({ target: { value: '50' } })
  await vue.nextTick()
  ui.byId('island-position-y').props.onChange({ target: { value: '-24' } })
  await vue.nextTick()
  assert.deepEqual(clone(ui.preferences.value.position), { x: 50, y: -24 })
  await ui.select('island-display', 'Primary display（主屏幕）')
  await vue.nextTick()
  assert.equal(ui.preferences.value.displayId, '101')
  assert.equal(ui.preferences.value.position, null)
  ui.byId('island-font-family').props.onInput({ target: { value: '思源黑体' } })
  await vue.nextTick()
  ui.byId('island-font-size').props.onInput({ target: { value: '30' } })
  await vue.nextTick()
  assert.equal(ui.preferences.value.fontFamily, '思源黑体')
  assert.equal(ui.preferences.value.fontSize, 30)
  for (const [field, value] of [['opacity', '.6'], ['backgroundOpacity', '.3'], ['scale', '1.5']]) {
    ui.byId(`island-${field}`).props.onInput({ target: { value } })
    await vue.nextTick()
    assert.equal(ui.preferences.value[field], Number(value))
  }
  assert.match(ui.text(), /60%/)
  assert.match(ui.text(), /30%/)
  assert.match(ui.text(), /150%/)
  for (const field of ['text', 'inactive', 'background']) {
    ui.byId(`island-color-${field}`).props.onInput({ target: { value: '#123456' } })
    await vue.nextTick()
    assert.equal(ui.preferences.value.colors[field], '#123456')
  }
  ui.all().find(node => node.props['aria-label'] === '重置歌词颜色').props.onClick()
  await vue.nextTick()
  ui.button('恢复默认').props.onClick()
  await vue.nextTick()
  assert.equal(ui.preferences.value.colors.text, '#ffffff')
  assert.equal(ui.preferences.value.colors.inactive, '#123456')
  assert.equal(ui.preferences.value.fontFamily, '')
  assert.deepEqual(ui.calls, [], 'editing controls cannot bypass the parent save transaction')
})

test('side presets derive from content choices without storing a preset or changing Logo visibility', async t => {
  const ui = mountControls(t)
  await flush()
  ui.byId('island-logo').props.onChange({ target: { checked: false } })
  await vue.nextTick()
  await ui.select('island-preset', '交换 · 封面 / Logo')
  await vue.nextTick()
  assert.equal(ui.preferences.value.leftContent, 'cover')
  assert.equal(ui.preferences.value.rightContent, 'logo')
  assert.equal(ui.preferences.value.showLogo, false)
  assert.equal(ui.preferences.value.preset, undefined)
  await ui.select('island-preset', '仅歌词')
  await vue.nextTick()
  assert.equal(ui.preferences.value.leftContent, 'none')
  assert.equal(ui.preferences.value.rightContent, 'none')
  await ui.select('island-left', '专辑封面')
  await vue.nextTick()
  assert.match(ui.byId('island-preset').props['aria-label'], /自定义/)
  await ui.select('island-right', '应用 Logo')
  await vue.nextTick()
  assert.match(ui.byId('island-preset').props['aria-label'], /交换/)
})

test('display subscription beats late enumeration and retains disconnected selection until unmount', async t => {
  let finish
  const ui = mountControls(t, { getDisplays: () => new Promise(resolve => { finish = resolve }) })
  await flush()
  assert.deepEqual(ui.order, ['subscribe', 'displays', 'capabilities'])
  ui.publish([{ id: '202', label: 'New screen', primary: true }])
  finish([{ id: '101', label: 'Stale screen', primary: true }])
  await flush()
  await ui.openSelect('island-display')
  assert.match(ui.text(), /New screen/)
  assert.doesNotMatch(ui.text(), /Stale screen/)
  await ui.select('island-display', 'New screen（主屏幕）')
  await vue.nextTick()
  ui.publish([])
  await vue.nextTick()
  assert.equal(ui.preferences.value.displayId, '202')
  assert.match(ui.text(), /已保存的屏幕/)
  ui.unmount()
  assert.equal(ui.released(), 1)
  ui.publish([{ id: 'late', label: 'After unmount' }])
  assert.equal(ui.released(), 1)
})

test('unsupported external fullscreen detection is disabled; display errors retry and browser controls are unavailable', async t => {
  let fail = true
  const ui = mountControls(t, { getDisplays: async () => { if (fail) throw new Error('Controlled failure'); return [] }, getCapabilities: async () => ({ fullscreenDetection: false }) })
  await flush()
  assert.equal(ui.byId('island-hide-fullscreen').props.disabled, true)
  assert.equal(ui.byId('island-hide-lyrics').props.disabled, undefined)
  assert.match(ui.text(), /仅在 Windows 可用/)
  assert.match(ui.text(), /无法读取显示器/)
  fail = false
  await ui.button('重试读取').props.onClick()
  await flush()
  assert.doesNotMatch(ui.text(), /无法读取显示器/)
  const browser = mountControls(t, { browser: true })
  await flush()
  assert.equal(browser.all().find(node => node.type === 'fieldset').props.disabled, true)
  assert.equal(browser.button('重新显示 / 找回').props.disabled, true)
  browser.byId('island-logo').props.onChange({ target: { checked: false } })
  await browser.byId('island-enabled').props.onChange({ target: { checked: true } })
  assert.equal(browser.preferences.value.showLogo, true)
  assert.equal(browser.preferences.value.enabled, false)
  assert.equal(browser.calls.length, 0)
})

test('preview requires parent save, ignores duplicate clicks and reports failure before permitting retry', async t => {
  let saved = false, finish
  const ui = mountControls(t, { beforeAction: async () => saved, show: () => new Promise(resolve => { finish = resolve }) })
  await flush()
  await ui.button('重新显示 / 找回').props.onClick()
  await flush()
  assert.equal(ui.calls.length, 0)
  assert.match(ui.text(), /请先重试保存/)
  saved = true
  const pending = ui.button('重新显示 / 找回').props.onClick()
  await flush()
  assert.equal(ui.button('处理中…').props.disabled, true)
  await ui.button('处理中…').props.onClick()
  assert.equal(ui.calls.length, 1)
  finish({ success: false, error: '窗口显示失败，请重试。' })
  await pending
  await flush()
  assert.match(ui.text(), /窗口显示失败/)
  const retry = ui.button('重新显示 / 找回').props.onClick()
  await flush()
  finish({ success: true })
  await retry
  await flush()
  assert.equal(ui.calls.length, 2)
  assert.match(ui.text(), /预览 3 秒/)
})
