const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
// This host has no CSSOM; keep Vue's real template/events and isolate DOM-only motion hooks.
const motionVue = { ...vue,
  Transition: { setup(_props, { slots }) { return () => slots.default?.()[0] } },
  TransitionGroup: { props: ['tag'], setup(props, { attrs, slots }) { return () => vue.h(props.tag || 'div', attrs, slots.default?.()) } }
}
const { parse, compileScript } = require('@vue/compiler-sfc')

const root = path.join(__dirname, '..')
const packageInfo = require('../package.json')
const quietLogger = { error() {} }
const filename = path.join(root, 'src/components/common/AppUpdates.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
// Keep real template behavior while avoiding DOM-only static HTML insertion in the in-memory host.
const compiled = compileScript(descriptor, { id: 'app-updates-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
  .replace(/^import\b[^\n]*$/gm, '')
  .replace('export default', 'return')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
const state = (revision = 0, extra = {}) => ({
  revision, status: 'idle', currentVersion: '1.0.0', channel: 'stable', release: null,
  selectedAssetId: null, progress: null, downloaded: null, source: null, checkedAt: null, error: null, message: '', ...extra
})
const release = (assets = [{ id: 12, name: 'BetterKuGou-setup.exe', format: 'exe', size: 1024 }]) => ({
  id: 5, version: '1.1.0', tag: 'v1.1.0', name: 'BetterKuGou 1.1.0', notes: '新的更新说明',
  url: 'https://github.com/FLC-Team/BetterKuGou/releases/tag/v1.1.0', assets, defaultAssetId: assets[0]?.id
})

/** Mount the actual compiled Vue template with an in-memory host and controllable IPC. */
function mountUpdates(t, options = {}) {
  const order = []
  const calls = []
  let listener
  let released = 0
  const updateAPI = options.browser ? undefined : {
    onState(callback) { order.push('subscribe'); listener = callback; return () => { released++ } },
    getState() { order.push('snapshot'); return Promise.resolve(options.snapshot ?? state()) },
    ...Object.fromEntries(['check', 'download', 'cancel', 'revealDownloadedFile', 'requestInstall'].map(method => [method, (...args) => {
      calls.push({ method, args })
      return options[method]?.(...args) ?? Promise.resolve(method === 'check' ? state(1, { status: 'upToDate' }) : { success: true })
    }]))
  }
  const opened = []
  const component = new Function('Vue', 'packageInfo', 'logger', 'window', 'URL', compiled)(motionVue, packageInfo, quietLogger, {
    electronAPI: { updates: updateAPI, openExternal: async url => opened.push(url) }
  }, URL)
  function makeNode(type, text = '') {
    const node = { type, text, props: {}, children: [], parent: null, listeners: new Map(), selected: false,
      addEventListener: (name, callback) => node.listeners.set(name, callback),
      removeEventListener: name => node.listeners.delete(name)
    }
    Object.defineProperty(node, 'options', { get: () => node.children.filter(child => child.type === 'option') })
    return node
  }
  const renderer = vue.createRenderer({
    createElement: makeNode, createText: value => makeNode('text', value), createComment: () => makeNode('comment'),
    setText: (node, value) => { node.text = value },
    setElementText(node, value) { node.text = value; node.children = [] },
    patchProp(node, key, _previous, value) {
      // Native boolean attributes treat an empty string as present, matching Vue's DOM patcher.
      node.props[key] = key === 'disabled' ? value === '' || Boolean(value) : value
      if (key === 'value') { node.value = value; node._value = value }
      if (key === 'multiple') node.multiple = value
    },
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove(node) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node)
      node.parent = null
    },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null
  })
  const preferences = vue.ref({ autoCheck: true, autoDownload: false, channel: 'stable' })
  const versions = []
  const container = makeNode('root')
  const app = renderer.createApp({
    render: () => vue.h(component, {
      modelValue: preferences.value,
      beforeAction: options.beforeAction || (async () => true),
      'onUpdate:modelValue': value => { preferences.value = value },
      onCurrentVersion: version => versions.push(version)
    })
  })
  app.mount(container)
  let unmounted = false
  const unmount = () => { if (!unmounted) { unmounted = true; app.unmount() } }
  t.after(unmount)
  const nodes = () => {
    const visit = node => [node, ...node.children.flatMap(visit)]
    return visit(container)
  }
  const text = node => node.text + node.children.map(text).join('')
  const find = (tag, content) => nodes().find(node => node.type === tag && text(node) === content)
  return {
    app, container, nodes, text: () => text(container), order, calls, opened, versions, preferences, unmount,
    released: () => released, publish: next => listener?.(next),
    byId: id => nodes().find(node => node.props.id === id),
    button: label => find('button', label),
    async click(label) {
      const button = find('button', label)
      assert.ok(button, `button '${label}' exists`)
      assert.ok(!button.props.disabled, `button '${label}' is enabled`)
      return button.props.onClick()
    }
  }
}

test('browser preview shows the build version and disables desktop-only update controls', async t => {
  const ui = mountUpdates(t, { browser: true })
  await flush()
  assert.match(ui.text(), /仅在桌面客户端中可用/)
  assert.ok(ui.text().includes(packageInfo.version))
  assert.equal(ui.nodes().find(node => node.type === 'fieldset').props.disabled, true)
  assert.equal(ui.button('检查更新'), undefined)
})

test('initial subscription beats an older snapshot and unmount releases it without canceling background work', async t => {
  const snapshot = deferred()
  const ui = mountUpdates(t, { snapshot: snapshot.promise })
  assert.deepEqual(ui.order, ['subscribe', 'snapshot'])
  ui.publish(state(3, { currentVersion: '2.0.0', status: 'downloading', release: release(), progress: { received: 2048, total: 4096, percent: 50, source: 'proxy' } }))
  snapshot.resolve(state(2, { currentVersion: '1.0.0', status: 'upToDate' }))
  await flush()
  assert.match(ui.text(), /v2\.0\.0/)
  assert.match(ui.text(), /50\.0%/)
  assert.match(ui.text(), /git\.tangbai\.cc/)
  assert.equal(ui.versions.at(-1), '2.0.0')
  ui.unmount()
  assert.equal(ui.released(), 1)
  assert.deepEqual(ui.calls, [])
  ui.publish(state(4, { currentVersion: '3.0.0' }))
  assert.equal(ui.versions.at(-1), '2.0.0')
})

test('preferences use the parent draft and a failed settings save prevents checking', async t => {
  let saves = 0
  let canSave = false
  const ui = mountUpdates(t, { beforeAction: async () => { saves++; return canSave } })
  await flush()
  assert.equal(ui.byId('update-channel').props.value, 'stable')
  assert.equal(ui.byId('update-auto-check').props.checked, true)
  assert.equal(ui.byId('update-auto-download').props.checked, false)
  ui.byId('update-channel').props.onChange({ target: { value: 'beta' } })
  await vue.nextTick()
  ui.byId('update-auto-download').props.onChange({ target: { checked: true } })
  await vue.nextTick()
  assert.equal(ui.preferences.value.channel, 'beta')
  assert.equal(ui.preferences.value.autoDownload, true)
  await ui.click('检查更新')
  await flush()
  assert.equal(saves, 1)
  assert.deepEqual(ui.calls, [])
  assert.match(ui.text(), /请先重试保存设置/)
  canSave = true
  await ui.click('检查更新')
  await flush()
  assert.equal(ui.calls[0].method, 'check')
  assert.match(ui.text(), /暂无更高版本/)
})

test('checking waits for settings and reports operation failures without losing the draft', async t => {
  const saving = deferred()
  const ui = mountUpdates(t, { beforeAction: () => saving.promise, check: async () => { throw new Error('网络超时') } })
  await flush()
  const checking = ui.click('检查更新')
  await flush()
  assert.deepEqual(ui.calls, [])
  assert.ok(ui.button('检查更新').props.disabled)
  saving.resolve(true)
  await checking
  await flush()
  assert.match(ui.text(), /网络超时/)
  assert.equal(ui.preferences.value.autoCheck, true)
  assert.equal(ui.button('检查更新').props.disabled, false)
})

test('downloads send only a selected service asset ID and cancellation remains usable while download is pending', async t => {
  const downloading = deferred()
  const installedRelease = release([
    { id: 23, name: 'linux.AppImage', format: 'AppImage', size: 4096 },
    { id: 24, name: 'linux.deb', format: 'deb', size: 8192 }
  ])
  const ui = mountUpdates(t, {
    snapshot: state(1, { status: 'available', release: installedRelease }),
    download: () => downloading.promise,
    cancel: async () => state(3, { status: 'available', release: installedRelease, message: '下载已取消' })
  })
  await flush()
  const select = ui.byId('update-asset')
  select.options[0].selected = false
  select.options[1].selected = true
  select.listeners.get('change')()
  await vue.nextTick()
  const result = ui.click('下载更新包')
  await flush()
  assert.deepEqual(ui.calls[0], { method: 'download', args: [24] })
  ui.publish(state(2, { status: 'downloading', release: installedRelease, selectedAssetId: 24, progress: { received: 1024, total: 8192, percent: 12.5, source: 'github' } }))
  await flush()
  assert.equal(ui.button('取消').props.disabled, false)
  await ui.click('取消')
  downloading.resolve(state(2, { status: 'downloading', release: installedRelease }))
  await result
  await flush()
  assert.equal(ui.calls[1].method, 'cancel')
  assert.equal(ui.button('取消'), undefined, 'late download response cannot restore canceled state')
  assert.ok(ui.button('下载更新包'))
})

test('download completion never installs and explicit installation is deduplicated while confirmation is pending', async t => {
  const confirmation = deferred()
  const ui = mountUpdates(t, {
    snapshot: state(1, { status: 'downloaded', release: release(), downloaded: { name: 'setup.exe', format: 'exe', version: '1.1.0' } }),
    requestInstall: () => confirmation.promise
  })
  await flush()
  assert.deepEqual(ui.calls, [], 'mounting a completed download must not open an installer')
  const installing = ui.click('手动安装')
  await flush()
  assert.ok(ui.button('等待确认…').props.disabled)
  await ui.button('等待确认…').props.onClick()
  assert.equal(ui.calls.filter(call => call.method === 'requestInstall').length, 1)
  confirmation.resolve({ canceled: true })
  await installing
  await flush()
  assert.ok(ui.button('手动安装'))
  assert.doesNotMatch(ui.text(), /安装包已打开/)
  await ui.click('打开所在文件夹')
  await flush()
  assert.equal(ui.calls.at(-1).method, 'revealDownloadedFile')
})

test('opening settings during a background download preserves the asset selection for manual retry after cancellation', async t => {
  const installedRelease = release([
    { id: 23, name: 'linux.AppImage', format: 'AppImage', size: 4096 },
    { id: 24, name: 'linux.deb', format: 'deb', size: 8192 }
  ])
  const ui = mountUpdates(t, {
    snapshot: state(4, { status: 'downloading', release: installedRelease, selectedAssetId: 24, progress: { received: 1024, total: 8192, percent: 12.5, source: 'proxy' } }),
    cancel: async () => state(5, { status: 'available', release: installedRelease, selectedAssetId: 24 })
  })
  await flush()
  assert.match(ui.text(), /来源：git\.tangbai\.cc/)
  await ui.click('取消')
  await flush()
  assert.equal(ui.byId('update-asset').props.disabled, false)
  assert.equal(ui.button('下载更新包').props.disabled, false)
  await ui.click('下载更新包')
  assert.deepEqual(ui.calls.at(-1), { method: 'download', args: [24] })
})

test('AppImage downloads expose file location without an installation action', async t => {
  const ui = mountUpdates(t, { snapshot: state(1, { status: 'downloaded', release: release(), downloaded: { name: 'linux.AppImage', format: 'AppImage', version: '1.1.0' } }) })
  await flush()
  assert.equal(ui.button('手动安装'), undefined)
  assert.ok(ui.button('打开所在文件夹'))
  assert.match(ui.text(), /自行处理安装包/)
  assert.deepEqual(ui.calls, [])
})

test('a completed AppImage download allows selecting and downloading a different Linux package', async t => {
  const installedRelease = release([
    { id: 23, name: 'linux.AppImage', format: 'AppImage', size: 4096 },
    { id: 24, name: 'linux.deb', format: 'deb', size: 8192 }
  ])
  const ui = mountUpdates(t, {
    snapshot: state(4, {
      status: 'downloaded', release: installedRelease, selectedAssetId: 23, source: 'cache',
      downloaded: { name: 'linux.AppImage', format: 'AppImage', version: '1.1.0' }
    })
  })
  await flush()
  assert.equal(ui.button('下载更新包'), undefined, 'the completed asset does not need downloading again')
  assert.match(ui.text(), /来源：已验证缓存/)
  const select = ui.byId('update-asset')
  select.options[0].selected = false
  select.options[1].selected = true
  select.listeners.get('change')()
  await vue.nextTick()
  assert.ok(ui.button('下载更新包'))
  await ui.click('下载更新包')
  assert.deepEqual(ui.calls.at(-1), { method: 'download', args: [24] })
})

test('missing platform packages link to the fixed project releases and release notes stay plain text', async t => {
  const unsupportedRelease = { ...release([]), url: 'https://example.test/other', notes: '<script>alert(1)</script>\n更新内容' }
  const ui = mountUpdates(t, { snapshot: state(1, { status: 'available', release: unsupportedRelease }) })
  await flush()
  assert.match(ui.text(), /没有适用于当前系统和架构/)
  assert.ok(ui.text().includes('<script>alert(1)</script>'))
  assert.equal(ui.nodes().some(node => node.type === 'script'), false)
  assert.equal(ui.button('下载更新包'), undefined)
  await ui.click('查看发布页 ↗')
  assert.deepEqual(ui.opened, ['https://github.com/FLC-Team/BetterKuGou/releases'])
})

test('unknown download progress stays indeterminate and a real zero is distinct from missing progress', async t => {
  const ui = mountUpdates(t, { snapshot: state(1, { status: 'downloading', release: release(), progress: { received: 0, total: 0, percent: null } }) })
  await flush()
  const progress = () => ui.nodes().find(node => node.type === 'progress')
  assert.equal(progress().props.value, undefined, 'native progress must not claim 0% before a total is known')
  assert.match(ui.text(), /准备下载…/)
  assert.doesNotMatch(ui.text(), /0\.0%/)
  ui.publish(state(2, { status: 'downloading', release: release(), progress: { received: 0, total: 1024, percent: 0 } }))
  await flush()
  assert.equal(progress().props.value, 0)
  assert.match(ui.text(), /0\.0%/)
  ui.publish(state(3, { status: 'downloading', release: release(), progress: { received: 1024, total: 1024, percent: 130 } }))
  await flush()
  assert.equal(progress().props.value, 100, 'presented progress remains within native bounds')
  assert.equal(progress().props['aria-label'], '更新包下载进度')
})

test('release notes start expanded with keyboard access and malformed publication dates stay hidden', async t => {
  const ui = mountUpdates(t, { snapshot: state(1, { status: 'available', release: { ...release(), publishedAt: 'not-a-date' } }) })
  await flush()
  const notes = ui.nodes().find(node => node.type === 'details' && node.props.class === 'release-notes')
  assert.ok(notes)
  assert.equal(notes.props.open, '')
  const body = ui.nodes().find(node => node.props['aria-label'] === '版本更新说明')
  assert.equal(body.props.tabindex, '0')
  assert.match(ui.text(), /新的更新说明/)
  assert.doesNotMatch(ui.text(), /Invalid Date/)
})

test('the active channel badge follows committed service state while the channel control keeps the draft', async t => {
  const ui = mountUpdates(t)
  await flush()
  ui.byId('update-channel').props.onChange({ target: { value: 'beta' } })
  await vue.nextTick()
  const badge = () => ui.nodes().find(node => node.type === 'span' && node.props.class === 'updates-channel')
  assert.equal(ui.byId('update-channel').props.value, 'beta')
  assert.equal(badge().text, '正式版', 'unsaved channel must not appear applied to current results')
  ui.publish(state(2, { channel: 'beta' }))
  await flush()
  assert.equal(badge().text, '测试版')
})
