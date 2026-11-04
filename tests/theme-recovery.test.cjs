const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { registerAppNotice } = require('./helpers/noticeHarness.cjs')

const filename = path.join(__dirname, '../src/components/common/ThemeRecovery.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
const compiled = compileScript(descriptor, { id: 'theme-recovery-notice', inlineTemplate: true,
  templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm,
    (_match, names) => 'const { ' + names.replace(/\bas\b/g, ':') + ' } = Vue')
  .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** Compile the actual recovery component and AppNotice; isolate only persistence and Fue's DOM host. */
function fixture(t, options = {}) {
  const writes = [], previews = [], errors = [], keys = new Map()
  let cancelledPreviews = 0
  const originalFocus = { name: 'original-control' }
  const document = {
    documentElement: { dataset: { themeBase: options.base || 'dark' } },
    activeElement: originalFocus,
    addEventListener: (name, handler) => keys.set(name, handler),
    removeEventListener: (name, handler) => { if (keys.get(name) === handler) keys.delete(name) }
  }
  const Component = new Function('Vue', 'document', 'useSettingsStore', 'createThemePackage',
    'previewThemePackage', 'cancelThemePreview', 'logger', compiled)(
    vue, document, () => ({ updateSettings: patch => { writes.push(patch); return options.save?.(patch) } }),
    value => value, value => { previews.push(value); return options.preview?.(value) },
    () => { cancelledPreviews++ }, { error: (...args) => errors.push(args) })
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: () => node('comment'),
    setText: (item, text) => { item.text = text },
    setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp(item, key, _previous, value) { item.props[key] = value },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item)
      item.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(item)
      else parent.children.splice(index, 0, item)
    },
    remove(item) { if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item); item.parent = null },
    parentNode: item => item.parent,
    nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null
  })
  const root = node('root')
  const app = renderer.createApp({ render: () => vue.h(Component, { prepareRestore: options.prepareRestore }) })
  const notices = registerAppNotice(app)
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const descendants = item => [item, ...item.children.flatMap(descendants)]
  const text = item => item.text + item.children.map(text).join('')
  return {
    writes, previews, errors, document, originalFocus, keys, unmount, notices,
    cancelledPreviews: () => cancelledPreviews, text: () => text(root),
    button: label => descendants(root).find(item => item.type === 'button' &&
      (text(item) === label || item.props['aria-label'] === label)),
    click(button) { if (button && !button.props.disabled) return button.props.onClick?.() },
    key(key = 'r', modifiers = { ctrlKey: true, altKey: true, shiftKey: true }) {
      const event = { key, ...modifiers, prevented: false, stopped: false,
        preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
      keys.get('keydown')?.(event)
      return event
    }
  }
}

test('normal playback has no recovery entry; the shortcut restores the current base through a Fue notification', async t => {
  const ui = fixture(t, { base: 'light' })
  assert.equal(ui.notices.entries.length, 0)
  assert.equal(ui.button('关闭提示'), undefined)
  assert.equal(ui.writes.length, 0)
  assert.equal(ui.key('r', {}).prevented, false)
  const key = ui.key('R')
  assert.equal(key.prevented && key.stopped, true)
  await vue.nextTick()
  assert.equal(ui.notices.entries.length, 1)
  assert.equal(ui.notices.entries[0].closable, false)
  assert.match(ui.text(), /正在恢复内置外观/)
  await flush()
  assert.equal(ui.writes.length, 1)
  assert.equal(ui.writes[0].custom.theme, 'light')
  assert.equal(ui.previews[0].custom.theme, 'light')
  assert.equal(ui.cancelledPreviews(), 1)
  assert.equal(ui.notices.entries[0].type, 'success')
  assert.equal(ui.notices.entries[0].duration, 4500)
  assert.match(ui.text(), /已恢复内置外观/)
  ui.click(ui.button('关闭提示'))
  await flush()
  assert.equal(ui.notices.entries.length, 0)
  assert.equal(ui.document.activeElement, ui.originalFocus, 'notification completion does not steal focus')
})

test('failed persistence keeps the safe preview and notification retry until a successful retry', async t => {
  let failed = true, released = 0
  const failure = new Error('disk unavailable')
  const ui = fixture(t, {
    prepareRestore: async () => () => { released++ },
    save: async () => { if (failed) throw failure }
  })
  ui.key()
  await flush()
  assert.equal(ui.notices.entries[0].type, 'error')
  assert.equal(ui.notices.entries[0].duration, 0)
  assert.match(ui.text(), /保存失败，请重试恢复/)
  assert.equal(ui.button('重试恢复').props.disabled, false)
  assert.equal(ui.cancelledPreviews(), 0)
  assert.equal(ui.errors[0][2], failure)
  assert.equal(released, 1)
  failed = false
  await ui.click(ui.button('重试恢复'))
  await flush()
  assert.equal(ui.writes.length, 2)
  assert.equal(ui.notices.entries.length, 1)
  assert.equal(ui.notices.entries[0].type, 'success')
  assert.equal(ui.cancelledPreviews(), 1)
  assert.equal(released, 2)
  ui.click(ui.button('关闭提示'))
  await flush()
  assert.equal(ui.notices.entries.length, 0)
})

test('repeated shortcuts deduplicate busy restoration; unmount during preparation releases without saving', async t => {
  const preparation = deferred()
  let prepares = 0, released = 0
  const ui = fixture(t, { prepareRestore: () => { prepares++; return preparation.promise } })
  ui.key(); ui.key()
  await vue.nextTick()
  assert.equal(prepares, 1)
  assert.equal(ui.writes.length, 0)
  assert.equal(ui.notices.entries[0].closable, false)
  assert.equal(ui.button('关闭提示'), undefined)
  ui.unmount()
  assert.equal(ui.notices.entries.length, 0)
  preparation.resolve(() => { released++ })
  await flush()
  assert.equal(released, 1)
  assert.equal(ui.writes.length, 0)
  assert.equal(ui.keys.size, 0)
  assert.equal(ui.notices.entries.length, 0)
})

test('closing and immediately reopening replaces the prior notification without stale close affecting the result', async t => {
  const ui = fixture(t)
  ui.key()
  await flush()
  const previous = ui.notices.entries[0]
  ui.click(ui.button('关闭提示'))
  await vue.nextTick()
  ui.key()
  await flush()
  assert.equal(ui.writes.length, 2)
  assert.equal(ui.notices.entries.length, 1)
  assert.equal(ui.notices.entries[0].type, 'success')
  previous.onAfterLeave()
  await vue.nextTick()
  assert.equal(ui.notices.entries.length, 1)
  assert.match(ui.text(), /已恢复内置外观/)
})

test('late save success or failure after unmount releases its transaction without publishing or canceling a newer preview', async t => {
  for (const failed of [false, true]) {
    const saving = deferred()
    let released = 0
    const ui = fixture(t, { save: () => saving.promise, prepareRestore: async () => () => { released++ } })
    ui.key()
    await flush()
    assert.equal(ui.writes.length, 1)
    ui.unmount()
    if (failed) saving.reject(new Error('late save failure'))
    else saving.resolve()
    await flush()
    assert.equal(released, 1)
    assert.equal(ui.cancelledPreviews(), 0)
    assert.equal(ui.notices.entries.length, 0)
    assert.equal(ui.document.activeElement, ui.originalFocus)
  }
})

test('retry keeps busy work singular and does not steal another control focus', async t => {
  const saving = deferred()
  let retry = false, released = 0
  const ui = fixture(t, {
    prepareRestore: async () => () => { released++ },
    save: () => retry ? saving.promise : Promise.reject(new Error('retry fixture'))
  })
  ui.key()
  await flush()
  retry = true
  const staleRetry = ui.button('重试恢复')
  const restoring = ui.click(staleRetry)
  ui.click(staleRetry)
  ui.key()
  await flush()
  assert.equal(ui.writes.length, 2)
  assert.equal(ui.notices.entries[0].closable, false)
  const otherFocus = { name: 'another-control' }
  ui.document.activeElement = otherFocus
  saving.resolve()
  await restoring
  await flush()
  assert.equal(ui.notices.entries[0].type, 'success')
  assert.equal(ui.document.activeElement, otherFocus)
  assert.equal(released, 2)
})

test('preparation and release failures stay retryable and never claim successful persistence', async t => {
  for (const mode of ['prepare', 'release']) {
    const failure = new Error(mode + ' failed')
    const ui = fixture(t, { prepareRestore: async () => {
      if (mode === 'prepare') throw failure
      return () => { throw failure }
    } })
    ui.key()
    await flush()
    assert.equal(ui.writes.length, mode === 'prepare' ? 0 : 1)
    assert.equal(ui.cancelledPreviews(), 0)
    assert.equal(ui.notices.entries[0].type, 'error')
    assert.equal(ui.button('重试恢复').props.disabled, false)
    assert.equal(ui.errors[0][2], failure)
  }
})
