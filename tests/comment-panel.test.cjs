const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')
const root = path.resolve(__dirname, '..')
const strip = source => source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(api = {}) {
  const document = { body: {}, activeElement: null }
  const sandbox = vm.createContext({ document, AbortController, ArtworkCover: {}, LibrarySongs: {},
    logger: { trace() {}, warn() {}, error() {} }, getSongDetail: async () => ({ data: { mixsongid: 1 } }),
    getComments: async () => ({ data: { list: [], total: 0 } }), getCommentCount: async () => ({ data: { count: 0 } }),
    getCommentReplies: async () => ({ data: { list: [], total: 0 } }), getAudioRelated: async () => ({ data: { list: [], total: 0 } }), ...api })
  for (const file of ['src/utils/songMetadata.js', 'src/utils/libraryMetadata.js', 'src/views/logic/libraryPage.js']) {
    const source = strip(fs.readFileSync(path.join(root, file), 'utf8'))
    const exports = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1])
    Object.assign(sandbox, vm.runInContext(`(() => { ${source.replace(/^export /gm, '')}\nreturn { ${exports.join(',')} } })()`, sandbox))
  }
  const filename = path.join(root, 'src/components/common/SongDetailsPanel.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const compiled = compileTemplate({ source: descriptor.template.content, filename, id: 'comment-panel', compilerOptions: { mode: 'function' } })
  assert.deepEqual(compiled.errors, [])
  const definition = vm.runInContext(strip(descriptor.script.content).replace('export default', 'globalThis.component =') + '\ncomponent', sandbox)
  const emitted = [], ticks = []
  const view = vue.reactive({ ...definition.data(), visible: true, song: { hash: 'fixture-song', album_audio_id: 1, name: '示例歌手 - 示范歌曲.mp3', singername: '示例歌手' }, resource: null, title: '', $options: definition,
    $refs: {}, $emit: (...args) => emitted.push(args), $nextTick: fn => ticks.push(fn) })
  for (const [name, method] of Object.entries(definition.methods)) view[name] = method.bind(view)
  for (const [name, getter] of Object.entries(definition.computed)) Object.defineProperty(view, name, { get: () => getter.call(view) })
  const control = name => vue.markRaw({ name, isConnected: true, closest: () => null, focus() { document.activeElement = this } })
  const opener = control('opener'), close = control('close')
  view.$refs.panel = vue.markRaw({ contains: target => target === close })
  view.$refs.closeButton = close
  document.activeElement = opener
  return { view, definition, document, opener, close, emitted, control, ticks,
    setVisible(value) { view.visible = value; definition.watch.visible.handler.call(view, value) },
    flushTicks() { ticks.splice(0).forEach(fn => fn()) } }
}

test('details retain focus during the close animation and restore it only after leaving', async () => {
  const ui = fixture()
  ui.setVisible(true); ui.flushTicks(); await flush()
  assert.equal(ui.document.activeElement, ui.close)
  ui.setVisible(false)
  assert.equal(ui.document.activeElement, ui.close, 'the exit must not focus an underlying control before retiring the surface')
  ui.view.finishClose()
  assert.equal(ui.document.activeElement, ui.opener)
  assert.deepEqual(ui.emitted, [['closed']])
})

test('rapid close and reopen preserve the original opener and ignore obsolete after-leave callbacks', async () => {
  const ui = fixture()
  ui.setVisible(true); ui.flushTicks(); await flush()
  ui.setVisible(false)
  ui.document.activeElement = ui.document.body
  ui.setVisible(true); ui.flushTicks()
  ui.view.finishClose()
  assert.equal(ui.document.activeElement, ui.close)
  assert.equal(ui.view.returnFocus, ui.opener)
  assert.deepEqual(ui.emitted, [])
  ui.setVisible(false); ui.view.finishClose()
  assert.equal(ui.document.activeElement, ui.opener)
})

test('closing or unmounting details cannot steal focus from a newer dialog', async () => {
  const ui = fixture()
  ui.setVisible(true); ui.flushTicks(); await flush()
  const another = ui.control('new-dialog')
  another.focus(); ui.setVisible(false); ui.view.finishClose()
  assert.equal(ui.document.activeElement, another)
  ui.view.returnFocus = ui.opener
  ui.definition.beforeUnmount.call(ui.view)
  assert.equal(ui.document.activeElement, another)
  assert.equal(ui.view.disposed, true)
})

test('persistent details cancel hidden requests and reject old comment results after reopening', async () => {
  const first = gate(), calls = []
  const ui = fixture({ getComments(_resource, _params, options) { calls.push(options.signal); return calls.length === 1 ? first.promise : Promise.resolve({ data: { list: [{ id: 2, content: '当前评论' }], total: 1 } }) } })
  ui.setVisible(true); await flush()
  ui.setVisible(false)
  assert.equal(calls[0].aborted, true)
  ui.setVisible(true); await flush()
  first.resolve({ data: { list: [{ id: 1, content: '旧请求评论' }], total: 1 } }); await flush()
  assert.equal(ui.view.comments.items[0].id, 2)
  assert.equal(ui.view.comments.loading, false)
  assert.equal(ui.view.heading, '示范歌曲')
  assert.equal(ui.view.subtitle, '示例歌手')
})
