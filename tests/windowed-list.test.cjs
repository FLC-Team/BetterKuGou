const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

const filename = path.join(__dirname, '../src/components/common/WindowedList.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8')).descriptor
const { component, buildOffsets, getRenderEntries, runtimes } = new Function(
  descriptor.script.content.replace(/^export function /gm, 'function ').replace('export default', 'const component =') +
  '\nreturn {component,buildOffsets,getRenderEntries,runtimes}'
)()

/** Model the scroll flow, actual row heights and native focus without substituting the list's own algorithms. */
function fixture(count = 925) {
  const frames = new Map(), documentListeners = new Map(), windowListeners = new Map(), scrollListeners = new Map()
  const observers = [], mutations = [], rowCache = new Map(), realHeights = new Map()
  let nextFrame = 0, defaultHeight = 74
  const scroller = {
    isConnected: true, scrollTop: 0, clientHeight: 600, clientWidth: 1000, clientTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 600, height: 600 }),
    addEventListener: (name, listener) => scrollListeners.set(name, listener),
    removeEventListener: name => scrollListeners.delete(name)
  }
  const doc = {
    activeElement: null,
    documentElement: { attributes: {}, getAttribute(name) { return this.attributes[name] || '' }, className: '' },
    body: { attributes: {}, getAttribute(name) { return this.attributes[name] || '' }, className: '' },
    head: { querySelectorAll: () => [] },
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    removeEventListener: name => documentListeners.delete(name),
    fonts: { addEventListener() {}, removeEventListener() {} }
  }
  doc.defaultView = {
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    removeEventListener: name => windowListeners.delete(name),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this) }
      observe(element) { this.targets.add(element) }
      unobserve(element) { this.targets.delete(element) }
      disconnect() { this.targets.clear() }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = true; mutations.push(this) }
      observe() { this.connected = true }
      disconnect() { this.connected = false }
    }
  }
  const instance = {
    ...component.data(), items: Array.from({ length: count }, (_, index) => ({ index, name: `song ${index}` })),
    itemKey: 'index', threshold: 200,
    $nextTick: callback => Promise.resolve().then(() => callback?.())
  }
  for (const [name, method] of Object.entries(component.methods)) instance[name] = method.bind(instance)
  for (const [name, getter] of Object.entries(component.computed)) Object.defineProperty(instance, name, { get: () => getter.call(instance) })
  const root = instance.$el = {
    isConnected: true, ownerDocument: doc,
    getBoundingClientRect: () => ({ top: 200 - scroller.scrollTop }),
    closest: selector => selector === '.list-page' ? scroller : null,
    contains: target => target === root || target?.parentElement === root || target?.parentElement?.parentElement === root,
    querySelectorAll: selector => selector === ':scope > [data-window-index]'
      ? root.children.filter(element => element.dataset?.windowIndex != null)
      : [headerControl, ...root.children.flatMap(element => element.controls || [])]
  }
  const headerControl = { parentElement: root, closest: () => null, tabIndex: 0, matches: () => false, getClientRects: () => [{}] }
  function row(index) {
    const key = instance.keys[index]
    if (!rowCache.has(key)) {
      const element = {
        dataset: { windowIndex: String(index) }, parentElement: root,
        hasAttribute: name => name === 'data-window-index', getAttribute: () => null,
        querySelectorAll: () => element.controls,
        getBoundingClientRect: () => ({ top: element.top - scroller.scrollTop, bottom: element.top - scroller.scrollTop + element.height, height: element.height })
      }
      Object.defineProperty(element, 'offsetHeight', { get: () => element.height })
      Object.defineProperty(element, 'offsetTop', { get: () => element.top - 200 })
      element.controls = [0, 1].map(button => ({
        button, parentElement: element, tabIndex: 0, matches: () => false, getClientRects: () => [{}],
        closest: selector => selector === '[data-window-index]' ? element : null,
        focus() {
          const relatedTarget = doc.activeElement
          doc.activeElement = this
          instance.handleFocusIn({ target: this, relatedTarget })
        }
      }))
      rowCache.set(key, element)
    }
    const element = rowCache.get(key)
    element.dataset.windowIndex = String(index)
    return element
  }
  Object.defineProperty(root, 'children', { get() {
    let top = 250
    return instance.renderEntries.map(entry => {
      if (entry.spacer) {
        const location = top
        top += entry.height
        return { offsetTop: location - 200, hasAttribute: name => name === 'data-window-spacer', getBoundingClientRect: () => ({ top: location - scroller.scrollTop }) }
      }
      const element = row(entry.index)
      element.height = realHeights.get(instance.keys[entry.index]) || defaultHeight
      element.top = top
      top += element.height
      return element
    })
  } })
  component.created.call(instance)
  const settle = async () => { await Promise.resolve(); await Promise.resolve() }
  const frame = async () => {
    await settle()
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback())
    await settle()
    component.updated.call(instance)
  }
  return {
    instance, scroller, root, doc, frames, observers, mutations, realHeights, documentListeners, windowListeners, scrollListeners,
    setDefaultHeight: height => { defaultHeight = height },
    async mount() { component.mounted.call(instance); await frame(); await frame() },
    frame, settle,
    async scrollTo(index, offset = 0) {
      scroller.scrollTop = 250 + instance.offsets[index] + offset
      scrollListeners.get('scroll')?.()
      await frame(); await frame()
    },
    dispose() { component.beforeUnmount.call(instance) }
  }
}

test('the actual slot template compiles with direct rows and a named header', () => {
  const compiled = compileTemplate({ source: descriptor.template.content, filename, id: 'windowed-list' })
  assert.deepEqual(compiled.errors, [])
})

test('small lists retain all item identities; large lists bound mounted content and preserve complete height', async t => {
  const small = fixture(50), large = fixture()
  t.after(() => { small.dispose(); large.dispose() })
  await small.mount(); await large.mount()
  assert.deepEqual(small.instance.renderEntries.map(entry => small.instance.items[entry.index]), small.instance.items)
  assert.ok(large.instance.rows().length < 30)
  await large.scrollTo(700, 10)
  assert.ok(large.instance.rows().length < 30)
  assert.ok(large.instance.rowFor(700))
  const renderedHeight = large.instance.renderEntries.reduce((sum, entry) => sum + (entry.spacer ? entry.height : 74), 0)
  assert.equal(renderedHeight, 925 * 74)
})

test('dynamic row growth above the viewport preserves the same song and intra-row offset', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount(); await ui.scrollTo(400, 13)
  const before = ui.scroller.scrollTop
  ui.realHeights.set(ui.instance.keys[397], 154)
  ui.observers[0].callback([])
  await ui.frame()
  assert.equal(ui.scroller.scrollTop, before + 80)
  assert.equal(ui.scroller.scrollTop - 250 - ui.instance.offsets[400], 13)
})

test('responsive row heights invalidate stale offscreen measurements without losing the scroll anchor', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount(); await ui.scrollTo(400, 13)
  ui.scroller.clientWidth = 390
  ui.setDefaultHeight(120)
  ui.observers[0].callback([])
  await ui.frame(); await ui.frame()
  assert.equal(ui.instance.estimate, 120)
  assert.equal(ui.scroller.scrollTop - 250 - ui.instance.offsets[400], 13)
  assert.ok(ui.instance.rowFor(400))
})

test('row translate and scale animations do not change measured list height or scroll position', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount(); await ui.scrollTo(400, 13)
  const before = ui.scroller.scrollTop
  for (const row of ui.instance.rows()) row.getBoundingClientRect = () => ({ top: -999, bottom: -111, height: 888 })
  ui.observers[0].callback([])
  await ui.frame()
  assert.equal(ui.instance.offsets.at(-1), 925 * 74)
  assert.equal(ui.scroller.scrollTop, before)
  assert.equal(ui.scroller.scrollTop - 250 - ui.instance.offsets[400], 13)
  const row = ui.instance.rowFor(397)
  ui.observers[0].callback([{ target: row, borderBoxSize: [{ blockSize: 74.5 }] }])
  await ui.frame()
  assert.equal(ui.instance.heights.get(ui.instance.keys[397]), 74.5, 'fractional layout heights come from ResizeObserver, not transforms')
})

test('activation after hidden resize rejects stale observer boxes before the first new resize delivery', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount(); await ui.scrollTo(400, 13)
  const oldObserver = ui.observers[0]
  const oldEntries = ui.instance.rows().map(target => ({ target, borderBoxSize: [{ blockSize: 74 }] }))
  oldObserver.callback(oldEntries)
  await ui.frame()
  component.deactivated.call(ui.instance)
  ui.root.isConnected = false
  ui.scroller.clientWidth = 390
  ui.setDefaultHeight(120)
  ui.root.isConnected = true
  component.activated.call(ui.instance)
  await ui.frame()
  assert.equal(ui.instance.estimate, 120, 'the first activation frame uses the new layout, before any fresh ResizeObserver callback')
  assert.equal(ui.scroller.scrollTop - 250 - ui.instance.offsets[400], 13)
  oldObserver.callback(oldEntries)
  await ui.frame()
  assert.equal(ui.instance.estimate, 120)
  assert.ok([...ui.instance.heights.values()].every(height => height === 120), 'late deliveries from the disconnected observer cannot reintroduce old heights')
})

for (const attribute of ['body-style', 'html-theme']) {
  test(`hidden ${attribute} changes invalidate old row measurements on activation`, async t => {
    const ui = fixture()
    t.after(() => ui.dispose())
    await ui.mount(); await ui.scrollTo(400, 13)
    ui.observers[0].callback(ui.instance.rows().map(target => ({ target, borderBoxSize: [{ blockSize: 74 }] })))
    await ui.frame()
    component.deactivated.call(ui.instance)
    if (attribute === 'body-style') ui.doc.body.attributes.style = '--font-size-base: 22px'
    else ui.doc.documentElement.attributes['data-theme'] = 'large-print'
    ui.setDefaultHeight(112)
    component.activated.call(ui.instance)
    await ui.frame(); await ui.frame()
    assert.equal(ui.instance.estimate, 112)
    assert.equal(ui.scroller.scrollTop - 250 - ui.instance.offsets[400], 13)
  })
}

test('a focused row survives distant scrolling with separate spacers instead of a growing render window', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount()
  const control = ui.instance.rowFor(2).controls[0]
  control.focus()
  await ui.scrollTo(700)
  assert.equal(ui.doc.activeElement, control)
  assert.equal(ui.instance.rowFor(2).controls[0], control)
  assert.ok(ui.instance.rows().length < 30)
  assert.ok(ui.instance.renderEntries.filter(entry => entry.spacer).length >= 2)
  assert.ok(ui.instance.rowFor(700))
})

test('Tab and Shift+Tab cross unmounted row boundaries and select the correct native control', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount()
  let prevented = false
  const last = ui.instance.windowEnd - 1
  const target = ui.instance.rowFor(last).controls[1]
  target.focus()
  ui.instance.handleKeydown({ key: 'Tab', target, shiftKey: false, preventDefault: () => { prevented = true } })
  await ui.settle()
  assert.equal(prevented, true)
  assert.equal(ui.doc.activeElement, ui.instance.rowFor(last + 1).controls[0])
  await ui.scrollTo(500)
  const first = ui.instance.windowStart
  const reverseTarget = ui.instance.rowFor(first).controls[0]
  reverseTarget.focus()
  ui.instance.handleKeydown({ key: 'Tab', target: reverseTarget, shiftKey: true, preventDefault() {} })
  await ui.settle()
  assert.equal(ui.doc.activeElement, ui.instance.rowFor(first - 1).controls[1])
})

test('KeepAlive pauses all observers and callbacks, then reads the restored scroll position after activation', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount(); await ui.scrollTo(600, 9)
  const previousHeight = ui.instance.offsets.at(-1)
  component.deactivated.call(ui.instance)
  ui.root.isConnected = false
  assert.equal(ui.frames.size, 0)
  assert.equal(ui.scrollListeners.size, 0)
  assert.equal(ui.documentListeners.size, 0)
  assert.ok(ui.observers.every(observer => observer.targets.size === 0))
  assert.ok(ui.mutations.every(observer => !observer.connected))
  ui.instance.scheduleMeasure(true)
  assert.equal(ui.frames.size, 0)
  assert.equal(ui.instance.offsets.at(-1), previousHeight)
  ui.root.isConnected = true
  component.activated.call(ui.instance)
  ui.scroller.scrollTop = 250 + ui.instance.offsets[600] + 9
  await ui.frame(); await ui.frame()
  assert.ok(ui.instance.rowFor(600))
  assert.equal(ui.scroller.scrollTop - 250 - ui.instance.offsets[600], 9)
  ui.dispose()
  assert.equal(ui.frames.size, 0)
  assert.equal(ui.windowListeners.size, 0)
  assert.equal(runtimes.has(ui.instance), false)
})

test('filtering, empty results and duplicate identities preserve the complete data without duplicate vnode keys', async t => {
  const ui = fixture()
  t.after(() => ui.dispose())
  await ui.mount(); await ui.scrollTo(900)
  const last = ui.instance.items[924]
  ui.instance.items = [last]
  component.watch.items.call(ui.instance)
  await ui.frame()
  assert.equal(ui.instance.renderEntries.length, 1)
  assert.equal(ui.instance.items[ui.instance.renderEntries[0].index], last)
  ui.instance.items = []
  component.watch.items.call(ui.instance)
  await ui.frame()
  assert.deepEqual(ui.instance.renderEntries, [])
  ui.instance.items = [{ index: 1 }, { index: 1 }]
  assert.equal(new Set(ui.instance.renderEntries.map(entry => entry.key)).size, 2)
})

test('segment spacers account for variable heights around multiple pinned islands', () => {
  const keys = Array.from({ length: 20 }, (_, index) => String(index))
  const heights = new Map([['2', 120], ['10', 160], ['18', 100]])
  const offsets = buildOffsets(keys, heights)
  const entries = getRenderEntries(keys, offsets, 8, 12, [1, 18])
  assert.deepEqual(entries.filter(entry => !entry.spacer).map(entry => entry.index), [1, 8, 9, 10, 11, 18])
  assert.equal(entries.reduce((sum, entry) => sum + (entry.spacer ? entry.height : heights.get(keys[entry.index]) || 74), 0), offsets.at(-1))
})
