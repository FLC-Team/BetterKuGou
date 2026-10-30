const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse } = require('@vue/compiler-sfc')

const filename = path.join(__dirname, '../src/components/common/ThemeRecovery.vue')
const script = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor.scriptSetup.content
  .replace(/^import\b[^\n]*$/gm, '')
const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** Execute the actual native Shadow DOM recovery surface with controllable persistence and animation completion. */
function fixture(t, options = {}) {
  const animations = [], writes = [], previews = [], errors = []
  const keys = new Map(), preferences = new Map()
  const preference = {
    matches: Boolean(options.reduced),
    addEventListener: (name, handler) => preferences.set(name, handler),
    removeEventListener: name => preferences.delete(name)
  }
  let mounted, beforeUnmount, cancelledPreviews = 0
  function makeNode(tagName) {
    const properties = new Map(), attributes = new Map(), listeners = new Map()
    const node = {
      tagName, attributes, listeners, children: [], dataset: {}, isConnected: true,
      style: {
        set cssText(value) {
          properties.clear()
          for (const declaration of value.split(';')) {
            const separator = declaration.indexOf(':')
            if (separator < 0) continue
            const name = declaration.slice(0, separator).trim(), raw = declaration.slice(separator + 1).trim()
            this.setProperty(name, raw.replace(/!important$/, ''), raw.endsWith('!important') ? 'important' : '')
          }
        },
        setProperty: (name, value, priority) => properties.set(name, { value, priority }),
        getPropertyValue: name => properties.get(name)?.value,
        getPropertyPriority: name => properties.get(name)?.priority
      },
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } },
      attachShadow() { this.shadowRoot = makeNode('shadow-root'); this.shadowRoot.host = this; return this.shadowRoot },
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: name => listeners.delete(name),
      focus() {
        let ancestor = this
        while (ancestor.parent) ancestor = ancestor.parent
        document.activeElement = ancestor.host || this
      },
      animate(frames, timing) {
        const animation = {
          node: this, frames, timing, cancelled: false,
          cancel() { this.cancelled = true },
          finish() { this.onfinish?.() }
        }
        animations.push(animation)
        return animation
      }
    }
    return node
  }
  const document = {
    documentElement: { dataset: { themeBase: options.base || 'dark' } },
    createElement: makeNode,
    addEventListener: (name, handler) => keys.set(name, handler),
    removeEventListener: name => keys.delete(name)
  }
  document.body = makeNode('body')
  const originalFocus = makeNode('input')
  document.activeElement = originalFocus
  const api = vm.runInNewContext(`${script}\n;({host})`, {
    document, window: { matchMedia: () => preference },
    ref: value => ({ value }),
    onMounted: callback => { mounted = callback },
    onBeforeUnmount: callback => { beforeUnmount = callback },
    defineProps: () => ({ prepareRestore: options.prepareRestore }),
    useSettingsStore: () => ({ updateSettings: patch => { writes.push(patch); return options.save?.(patch) } }),
    createThemePackage: value => value,
    previewThemePackage: value => previews.push(value),
    cancelThemePreview: () => { cancelledPreviews++ },
    logger: { error: (...args) => errors.push(args) }
  })
  const host = makeNode('div')
  api.host.value = host
  mounted()
  const descendants = node => [node, ...node.children.flatMap(descendants)]
  const panel = descendants(host.shadowRoot).find(node => node.tagName === 'section')
  const buttons = descendants(panel).filter(node => node.tagName === 'button')
  const close = buttons.find(node => node.textContent === '关闭')
  const reset = buttons.find(node => node !== close)
  let disposed = false
  function unmount() { if (!disposed) { disposed = true; beforeUnmount() } }
  t.after(unmount)
  return {
    host, panel, buttons, close, reset, animations, writes, previews, errors, originalFocus, document, keys, preferences, unmount,
    cancelledPreviews: () => cancelledPreviews,
    click(node) { if (!node.disabled) return node.listeners.get('click')?.() },
    key(key = 'r', modifiers = { ctrlKey: true, altKey: true, shiftKey: true }) {
      const event = { key, ...modifiers, prevented: false, stopped: false,
        preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
      keys.get('keydown')?.(event)
      return event
    },
    reduceMotion(value) { preference.matches = value; preferences.get('change')?.() }
  }
}

test('normal playback has no visible or focusable recovery/editor entry; shortcut still restores the current base', async t => {
  const ui = fixture(t, { base: 'light', reduced: true })
  assert.equal(ui.host.style.getPropertyValue('display'), 'none')
  assert.equal(ui.host.style.getPropertyPriority('display'), 'important')
  assert.equal(ui.host.inert, true)
  assert.equal(ui.host.attributes.get('aria-hidden'), 'true')
  assert.equal(ui.buttons.length, 2)
  assert.equal(ui.buttons.some(button => /编辑/.test(button.textContent)), false)
  assert.equal(ui.writes.length, 0)
  assert.equal(ui.key('r', {}).prevented, false)
  const key = ui.key()
  assert.equal(key.prevented && key.stopped, true)
  assert.equal(ui.host.style.getPropertyValue('display'), 'block')
  assert.equal(ui.host.inert, false)
  assert.equal(ui.reset.textContent, '正在恢复…')
  assert.equal(ui.close.disabled, true)
  await flush()
  assert.equal(ui.writes.length, 1)
  assert.equal(ui.writes[0].custom.theme, 'light')
  assert.equal(ui.cancelledPreviews(), 1)
  assert.equal(ui.reset.textContent, '已恢复内置外观')
  assert.equal(ui.close.disabled, false)
  ui.click(ui.close)
  assert.equal(ui.host.style.getPropertyValue('display'), 'none')
  assert.equal(ui.document.activeElement, ui.originalFocus)
})

test('failed persistence retains the safe preview and visible retry until an explicit close or successful retry', async t => {
  let failed = true, released = 0
  const failure = new Error('disk unavailable')
  const ui = fixture(t, {
    reduced: true,
    prepareRestore: async () => () => { released++ },
    save: async () => { if (failed) throw failure }
  })
  ui.key()
  await flush()
  assert.equal(ui.host.style.getPropertyValue('display'), 'block')
  assert.equal(ui.reset.dataset.state, 'error')
  assert.equal(ui.reset.disabled, false)
  assert.equal(ui.cancelledPreviews(), 0)
  assert.equal(ui.errors[0][2], failure)
  assert.equal(released, 1)
  failed = false
  await ui.click(ui.reset)
  assert.equal(ui.writes.length, 2)
  assert.equal(ui.reset.dataset.state, 'success')
  assert.equal(ui.cancelledPreviews(), 1)
  assert.equal(released, 2)
  ui.key('Escape', {})
  assert.equal(ui.host.style.getPropertyValue('display'), 'none')
})

test('repeated shortcuts do not duplicate restoration, and unmount during preparation releases without saving', async t => {
  const preparation = deferred()
  let prepares = 0, released = 0
  const ui = fixture(t, { prepareRestore: () => { prepares++; return preparation.promise } })
  ui.key(); ui.key()
  ui.click(ui.close)
  assert.equal(prepares, 1)
  assert.equal(ui.writes.length, 0)
  assert.equal(ui.host.style.getPropertyValue('display'), 'block')
  ui.unmount()
  preparation.resolve(() => { released++ })
  await flush()
  assert.equal(released, 1)
  assert.equal(ui.writes.length, 0)
  assert.equal(ui.keys.size, 0)
  assert.equal(ui.preferences.size, 0)
  assert.equal(ui.close.listeners.size, 0)
  assert.equal(ui.reset.listeners.size, 0)
  assert.ok(ui.animations.every(animation => animation.cancelled))
})

test('closing becomes inert immediately, rapid reopen ignores stale completion, and reduced motion settles pending exit', async t => {
  const ui = fixture(t)
  ui.key()
  await flush()
  ui.click(ui.close)
  const firstClose = ui.animations.filter(animation => animation.node === ui.panel).at(-1)
  assert.equal(ui.host.inert, true)
  assert.equal(ui.host.style.getPropertyValue('display'), 'block')
  ui.key()
  firstClose.finish()
  assert.equal(ui.host.style.getPropertyValue('display'), 'block')
  assert.equal(ui.host.inert, false)
  await flush()
  ui.click(ui.close)
  const secondClose = ui.animations.filter(animation => animation.node === ui.panel).at(-1)
  ui.reduceMotion(true)
  assert.equal(secondClose.cancelled, true)
  assert.equal(ui.host.style.getPropertyValue('display'), 'none')
  assert.equal(ui.host.inert, true)
})

test('late save completion after unmount cannot change the recovery surface or cancel another preview', async t => {
  const saving = deferred()
  let released = 0
  const ui = fixture(t, { save: () => saving.promise, prepareRestore: async () => () => { released++ } })
  ui.key()
  await flush()
  assert.equal(ui.writes.length, 1)
  ui.unmount()
  saving.resolve()
  await flush()
  assert.equal(released, 1)
  assert.equal(ui.reset.textContent, '正在恢复…')
  assert.equal(ui.cancelledPreviews(), 0)
  assert.ok(ui.animations.every(animation => animation.cancelled))
})

test('retry restores focus lost by the disabled native button so Escape still dismisses the result', async t => {
  const saving = deferred()
  let retry = false
  const ui = fixture(t, { reduced: true, save: () => retry ? saving.promise : Promise.reject(new Error('retry fixture')) })
  ui.key()
  await flush()
  retry = true
  ui.reset.focus()
  const restoring = ui.click(ui.reset)
  ui.document.activeElement = ui.document.body
  saving.resolve()
  await restoring
  assert.equal(ui.document.activeElement, ui.host)
  ui.key('Escape', {})
  assert.equal(ui.host.style.getPropertyValue('display'), 'none')
  assert.equal(ui.document.activeElement, ui.originalFocus)
})

test('late recovery never steals focus from another control or restores it after unmount', async t => {
  for (const unmount of [false, true]) {
    const saving = deferred()
    let retry = false
    const ui = fixture(t, { reduced: true, save: () => retry ? saving.promise : undefined })
    ui.key()
    await flush()
    retry = true
    ui.reset.focus()
    const restoring = ui.click(ui.reset)
    ui.document.activeElement = unmount ? ui.document.body : ui.originalFocus
    if (unmount) ui.unmount()
    saving.resolve()
    await restoring
    assert.equal(ui.document.activeElement, unmount ? ui.document.body : ui.originalFocus)
  }
})
