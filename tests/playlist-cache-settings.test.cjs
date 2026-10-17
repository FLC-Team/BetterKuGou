const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

const filename = path.join(__dirname, '../src/components/common/PlaylistCacheSettings.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
const compiled = compileScript(descriptor, { id: 'cache-settings-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
  .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }

function mount(t, options = {}) {
  const calls = [], order = []
  let listener, disposed = 0
  const snapshot = { revision: 1, generation: 1, userId: 'placeholder', usedBytes: 1024 ** 2, limitBytes: 2 * 1024 ** 3, playlists: [{ hashes: ['a', 'b'] }, { hashes: ['b'] }] }
  const api = options.browser ? undefined : {
    onState(callback) { order.push('subscribe'); listener = callback; return () => { disposed++ } },
    getState() { order.push('snapshot'); return Promise.resolve(options.snapshot || snapshot) },
    async clear() { calls.push('clear'); return { ...snapshot, revision: 5, playlists: [], usedBytes: 0 } },
    async retry() { calls.push('retry'); return options.actionResult || { ...snapshot, revision: 5 } }
  }
  const Component = new Function('Vue', 'window', 'logger', compiled)(vue, { electronAPI: { playlistCache: api } }, { warn() {} })
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
  const preferences = vue.ref({ offlinePlaylistCacheEnabled: true, cacheSizeIndex: 0, concurrentDownloads: 3, downloadPath: '/reserved' })
  const root = node('root')
  const app = renderer.createApp({ render: () => vue.h(Component, {
    modelValue: preferences.value, 'onUpdate:modelValue': value => { preferences.value = value },
    beforeAction: options.beforeAction || (async () => true)
  }) })
  app.mount(root)
  t.after(() => app.unmount())
  const nodes = item => [item, ...item.children.flatMap(nodes)]
  const text = item => item.text + item.children.map(text).join('')
  return { calls, order, preferences, publish: value => listener(value), disposed: () => disposed,
    unmount: () => app.unmount(), text: () => text(root), byId: id => nodes(root).find(item => item.props.id === id),
    button: label => nodes(root).find(item => item.type === 'button' && text(item) === label),
    all: () => nodes(root) }
}

test('cache preferences edit the parent draft and preserve reserved configuration', async t => {
  const ui = mount(t)
  await flush()
  assert.deepEqual(ui.order, ['subscribe', 'snapshot'])
  assert.match(ui.text(), /2 首离线可用/)
  ui.byId('offline-cache-enabled').props.onChange({ target: { checked: false } })
  await vue.nextTick()
  ui.byId('offline-cache-size').props.onChange({ target: { value: '5' } })
  await vue.nextTick()
  assert.equal(ui.preferences.value.offlinePlaylistCacheEnabled, false)
  assert.equal(ui.preferences.value.cacheSizeIndex, 5)
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
  assert.equal(browser.button('清理本账号缓存'), undefined)
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
