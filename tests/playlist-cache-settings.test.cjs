const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
// CSS transitions are exercised in Electron; this host tests the actual state/action ordering.
const motionVue = { ...vue, Transition: { setup(_props, { slots }) { return () => slots.default?.()[0] } } }
const { parse, compileScript } = require('@vue/compiler-sfc')

// Exercise the real parent's typed v-model contract without dropdown DOM positioning in this host.
const AnimatedSelect = {
  inheritAttrs: false,
  props: { modelValue: [String, Number], options: Array, disabled: Boolean, label: String },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => vue.h('animated-select-stub', {
      ...attrs, modelValue: props.modelValue, options: props.options, disabled: props.disabled,
      'aria-label': props.label, 'onUpdate:modelValue': value => emit('update:modelValue', value)
    }, props.options?.find(option => option.value === props.modelValue)?.label || '')
  }
}

const filename = path.join(__dirname, '../src/components/common/PlaylistCacheSettings.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
const compiled = compileScript(descriptor, { id: 'cache-settings-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
  .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }

function mount(t, options = {}) {
  const calls = [], order = [], directoryArguments = []
  let listener, disposed = 0
  const snapshot = { revision: 1, generation: 1, userId: 'placeholder', cacheDirectory: '/old/offline-playlists', usedBytes: 1024 ** 2, limitBytes: 2 * 1024 ** 3, playlists: [{ hashes: ['a', 'b'] }, { hashes: ['b'] }] }
  const api = options.browser ? undefined : {
    onState(callback) { order.push('subscribe'); listener = callback; return () => { disposed++ } },
    getState() { order.push('snapshot'); return Promise.resolve(options.snapshot || snapshot) },
    async clear() { calls.push('clear'); return { ...snapshot, revision: 5, playlists: [], usedBytes: 0 } },
    async retry() { calls.push('retry'); return options.actionResult || { ...snapshot, revision: 5 } },
    async chooseDirectory(...args) {
      calls.push('chooseDirectory')
      directoryArguments.push(args)
      return typeof options.directoryResult === 'function' ? options.directoryResult()
        : options.directoryResult || { state: { ...snapshot, revision: 5, cacheDirectory: '/new/offline-playlists', migration: null } }
    }
  }
  const Component = new Function('Vue', 'window', 'logger', 'AnimatedSelect', compiled)(motionVue, { electronAPI: { playlistCache: api } }, { warn() {} }, AnimatedSelect)
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
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
  const preferences = vue.ref({ offlinePlaylistCacheEnabled: true, cacheSizeIndex: 0, concurrentDownloads: 3, downloadPath: '/reserved', cachePath: '/reserved-cache' })
  const root = node('root')
  const app = renderer.createApp({ render: () => vue.h(Component, {
    modelValue: preferences.value, 'onUpdate:modelValue': value => { preferences.value = value },
    beforeAction: options.beforeAction || (async () => true)
  }) })
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const nodes = item => [item, ...item.children.flatMap(nodes)]
  const text = item => item.text + item.children.map(text).join('')
  return { calls, order, preferences, snapshot, directoryArguments, publish: value => listener(value), disposed: () => disposed,
    unmount, text: () => text(root), byId: id => nodes(root).find(item => item.props.id === id),
    button: label => nodes(root).find(item => item.type === 'button' && text(item) === label),
    all: () => nodes(root) }
}

test('cache preferences edit the parent draft and preserve reserved configuration', async t => {
  const ui = mount(t)
  await flush()
  assert.deepEqual(ui.order, ['subscribe', 'snapshot'])
  assert.match(ui.text(), /2 首离线可用/)
  assert.equal(ui.byId('offline-cache-size').props.modelValue, 0)
  assert.deepEqual(ui.byId('offline-cache-size').props.options.map(option => option.value), [0, 1, 2, 3, 4, 5])
  assert.equal(ui.byId('offline-cache-size').props.options.at(-1).label, '无限制')
  ui.byId('offline-cache-enabled').props.onChange({ target: { checked: false } })
  await vue.nextTick()
  ui.byId('offline-cache-size').props['onUpdate:modelValue'](5)
  await vue.nextTick()
  assert.equal(ui.preferences.value.offlinePlaylistCacheEnabled, false)
  assert.equal(ui.preferences.value.cacheSizeIndex, 5)
  assert.equal(ui.byId('offline-cache-size').props.modelValue, 5)
  assert.equal(ui.preferences.value.downloadPath, '/reserved')
  assert.deepEqual(ui.calls, [], 'editing a draft cannot immediately start or clear tasks')
})

test('clear requires its explicit confirmation and successful settings save', async t => {
  let saved = false
  const ui = mount(t, { beforeAction: async () => saved })
  await flush()
  ui.button('清理本账号缓存').props.onClick()
  await vue.nextTick()
  await ui.button('确认清理').props.onClick()
  assert.deepEqual(ui.calls, [])
  assert.match(ui.text(), /请先重试保存设置/)
  saved = true
  await ui.button('确认清理').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, ['clear'])
  assert.match(ui.text(), /再次播放时重新积累缓存/)
})

test('older snapshots do not overwrite state and browser controls stay disabled', async t => {
  const ui = mount(t)
  await flush()
  ui.publish({ revision: 9, userId: null, usedBytes: 0, limitBytes: 1024, playlists: [] })
  ui.publish({ revision: 2, userId: 'old', usedBytes: 100, playlists: [{ hashes: ['old'] }] })
  await vue.nextTick()
  assert.equal(ui.button('清理本账号缓存').props.disabled, true)
  const browser = mount(t, { browser: true })
  await flush()
  assert.match(browser.text(), /仅在桌面客户端/)
  assert.equal(browser.all().find(item => item.type === 'fieldset').props.disabled, true)
  assert.equal(browser.byId('offline-cache-size').props.disabled, true)
  assert.equal(browser.button('清理本账号缓存'), undefined)
  assert.equal(browser.button('更改位置').props.disabled, true)
  await browser.button('更改位置').props.onClick()
  assert.deepEqual(browser.calls, [])
})

test('worker state failures stay visible and cannot be reported as a successful retry', async t => {
  const failure = { revision: 5, generation: 1, userId: 'placeholder', playlists: [], error: { code: 'CACHE_WORKER_FAILED', message: '缓存服务暂时不可用，请重试' } }
  const ui = mount(t, { actionResult: failure })
  await flush()
  ui.publish(failure)
  await vue.nextTick()
  assert.match(ui.text(), /缓存服务暂时不可用/)
  await ui.button('重试未完成缓存').props.onClick()
  await flush()
  assert.match(ui.text(), /缓存服务暂时不可用/)
  assert.doesNotMatch(ui.text(), /已重试已播放歌曲/)
})

test('directory changes wait for saved drafts, deduplicate clicks and do not require an account', async t => {
  let save
  const saving = new Promise(resolve => { save = resolve })
  const ui = mount(t, { beforeAction: () => saving })
  await flush()
  ui.publish({ ...ui.snapshot, revision: 2, userId: null })
  await vue.nextTick()
  assert.equal(ui.button('更改位置').props.disabled, false)
  const change = ui.button('更改位置').props.onClick
  const pending = change()
  await change()
  await vue.nextTick()
  assert.equal(ui.button('更改位置').props.disabled, true)
  assert.deepEqual(ui.calls, [])
  ui.publish({ ...ui.snapshot, revision: 3, generation: 2, userId: 'another-placeholder' })
  save(true)
  await pending
  await flush()
  assert.deepEqual(ui.calls, ['chooseDirectory'])
  assert.deepEqual(ui.directoryArguments, [[]], 'renderer never supplies a filesystem path')
  assert.match(ui.text(), /全部账号/)
  assert.match(ui.text(), /所选文件夹下的 offline-playlists 子文件夹/)
  assert.match(ui.text(), /\/new\/offline-playlists/)
  assert.match(ui.text(), /缓存位置已更改/)
  assert.doesNotMatch(ui.text(), /只读/)
  assert.equal(ui.preferences.value.cachePath, '/reserved-cache', 'only the main process commits a migrated path')
  assert.equal(ui.preferences.value.downloadPath, '/reserved')
})

test('canceling directory selection preserves the path without claiming success', async t => {
  const ui = mount(t, { directoryResult: { canceled: true } })
  await flush()
  await ui.button('更改位置').props.onClick()
  await flush()
  assert.match(ui.text(), /\/old\/offline-playlists/)
  assert.doesNotMatch(ui.text(), /缓存位置已更改/)
  assert.equal(ui.button('更改位置').props.disabled, false)
})

test('failed draft saves block directory changes and preserve a retry entry', async t => {
  let saved = false
  const ui = mount(t, { beforeAction: async () => saved })
  await flush()
  await ui.button('更改位置').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, [])
  assert.match(ui.text(), /请先重试保存设置/)
  assert.equal(ui.button('更改位置').props.disabled, false)
  saved = true
  await ui.button('更改位置').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, ['chooseDirectory'])
  assert.match(ui.text(), /缓存位置已更改/)
  assert.doesNotMatch(ui.text(), /请先重试保存设置/)
})

test('migration progress survives reopened settings and blocks all cache management actions', async t => {
  const stages = { copying: '正在迁移缓存', verifying: '正在校验缓存', committing: '正在切换缓存位置', cleanup: '正在清理旧位置' }
  for (const [phase, label] of Object.entries(stages)) {
    const snapshot = { revision: 20, generation: 1, userId: 'placeholder', cacheDirectory: '/old/offline-playlists',
      migration: { phase, copiedBytes: 1024 ** 2, verifiedBytes: 512 * 1024, totalBytes: 2 * 1024 ** 2 } }
    const ui = mount(t, { snapshot })
    await flush()
    assert.ok(ui.text().includes(label))
    assert.match(ui.text(), phase === 'verifying' ? /0\.5 MB \/ 2\.0 MB/ : /1\.0 MB \/ 2\.0 MB/)
    assert.match(ui.text(), /离开设置页后，迁移仍会继续/)
    const progress = ui.all().find(item => item.type === 'progress')
    assert.equal(progress.props.value, phase === 'verifying' ? 512 * 1024 : 1024 ** 2)
    assert.equal(progress.props.max, 2 * 1024 ** 2)
    for (const label of ['更改位置', '重试未完成缓存', '清理本账号缓存']) {
      const button = ui.button(label)
      assert.equal(button.props.disabled, true)
      await button.props.onClick()
    }
    assert.deepEqual(ui.calls, [])
    assert.equal(ui.button('确认清理'), undefined)
    ui.publish({ ...snapshot, revision: 19, migration: null })
    await vue.nextTick()
    assert.equal(ui.button('更改位置').props.disabled, true, 'an older snapshot cannot hide migration')
    ui.publish({ ...snapshot, revision: 21, cacheDirectory: '/new/offline-playlists', migration: null })
    await vue.nextTick()
    assert.match(ui.text(), /缓存位置已更改/)
    assert.equal(ui.button('更改位置').props.disabled, false)
    ui.unmount()
  }
})

test('migration state arriving while a draft saves prevents a second migration', async t => {
  let save
  const ui = mount(t, { beforeAction: () => new Promise(resolve => { save = resolve }) })
  await flush()
  const pending = ui.button('更改位置').props.onClick()
  ui.publish({ ...ui.snapshot, revision: 2, migration: { phase: 'copying', copiedBytes: 0, totalBytes: 0 } })
  save(true)
  await pending
  await flush()
  assert.deepEqual(ui.calls, [])
  assert.equal(ui.button('更改位置').props.disabled, true)
  assert.equal(ui.all().find(item => item.type === 'progress').props.value, undefined, 'unknown totals use indeterminate progress')
})

test('migration errors and cleanup warnings remain visible through service snapshots', async t => {
  const ui = mount(t, { directoryResult: { error: { code: 'CACHE_DIRECTORY_BUSY', message: '目标文件夹已被占用，请选择其他位置。' } } })
  await flush()
  await ui.button('更改位置').props.onClick()
  await flush()
  assert.match(ui.text(), /目标文件夹已被占用/)
  assert.match(ui.text(), /\/old\/offline-playlists/)
  assert.doesNotMatch(ui.text(), /缓存位置已更改/)
  ui.publish({ ...ui.snapshot, revision: 2, migration: { phase: 'copying', copiedBytes: 0, totalBytes: 10 } })
  ui.publish({ ...ui.snapshot, revision: 3, migration: null, migrationError: { code: 'CACHE_COPY_FAILED', message: '缓存迁移失败，原位置已保留。' } })
  await vue.nextTick()
  assert.match(ui.text(), /缓存迁移失败，原位置已保留/)
  assert.doesNotMatch(ui.text(), /缓存位置已更改/)
  const reopened = mount(t, { snapshot: { ...ui.snapshot, revision: 3, migration: null, migrationError: { message: '缓存迁移失败，原位置已保留。' } } })
  await flush()
  assert.match(reopened.text(), /缓存迁移失败，原位置已保留/)
  ui.publish({ ...ui.snapshot, revision: 4, migration: { phase: 'cleanup', copiedBytes: 10, totalBytes: 10 } })
  ui.publish({ ...ui.snapshot, revision: 5, cacheDirectory: '/new/offline-playlists', migration: null,
    migrationWarning: { code: 'CACHE_CLEANUP_FAILED', message: '缓存已迁移，旧位置仍有文件等待清理。' } })
  await vue.nextTick()
  assert.match(ui.text(), /缓存位置已更改/)
  assert.match(ui.text(), /旧位置仍有文件等待清理/)
  assert.doesNotMatch(ui.text(), /缓存迁移失败/)
})

test('unmounting before or during directory migration prevents late UI work without canceling the service', async t => {
  let save
  const savingUi = mount(t, { beforeAction: () => new Promise(resolve => { save = resolve }) })
  await flush()
  const waiting = savingUi.button('更改位置').props.onClick()
  savingUi.unmount()
  save(true)
  await waiting
  assert.deepEqual(savingUi.calls, [])
  assert.equal(savingUi.disposed(), 1)

  let finish
  const migratingUi = mount(t, { directoryResult: () => new Promise(resolve => { finish = resolve }) })
  await flush()
  const pending = migratingUi.button('更改位置').props.onClick()
  await flush()
  migratingUi.unmount()
  finish({ state: { ...migratingUi.snapshot, revision: 2, cacheDirectory: '/new/offline-playlists' } })
  await pending
  assert.deepEqual(migratingUi.calls, ['chooseDirectory'])
  assert.equal(migratingUi.disposed(), 1)
  assert.equal(migratingUi.preferences.value.cachePath, '/reserved-cache')
})
