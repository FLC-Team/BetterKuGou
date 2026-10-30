const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

// Keep real component templates and handlers; the in-memory host has no CSS animation timeline.
const passthrough = { setup(_props, { slots }) { return () => vue.h(vue.Fragment, null, slots.default?.()) } }
const motionVue = { ...vue, Transition: passthrough, Teleport: passthrough }
function compile(name) {
  const filename = path.join(__dirname, '../src/components/common', name + '.vue')
  const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
  return compileScript(descriptor, { id: name, inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
    .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
    .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
}
const menuCode = compile('DropdownMenu')
const selectCode = compile('AnimatedSelect')
const managerCode = fs.readFileSync(path.join(__dirname, '../src/utils/contextMenuManager.js'), 'utf8').replace('export default new ContextMenuManager()', 'return new ContextMenuManager()')
const flush = async () => { await vue.nextTick(); await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
function event(key, extra = {}) {
  return { key, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...extra }
}
function invoke(node, name, argument = {}) {
  const handlers = node.props[name]
  for (const handler of Array.isArray(handlers) ? handlers : [handlers]) handler?.(argument)
}

/** Execute the actual Vue components with focus, measurements and native listener lifetimes modeled. */
function fixture(t, { kind = 'menu', props = {}, fieldset = false, reduced = false } = {}) {
  const documentListeners = new Map(), windowListeners = new Map(), resizes = [], mutations = [], animations = []
  const manager = new Function(managerCode)()
  const listenerHost = listeners => ({
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); if (!listeners.get(name)?.size) listeners.delete(name) }
  })
  const document = { ...listenerHost(documentListeners), activeElement: null }
  const window = { ...listenerHost(windowListeners), innerWidth: 800, innerHeight: 600, matchMedia: () => ({ matches: reduced }) }
  const dispatch = (listeners, name, target) => { for (const callback of [...(listeners.get(name) || [])]) callback(event('', { target })) }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); resizes.push(this) }
    observe(node) { this.observed.add(node) }
    disconnect() { this.observed.clear() }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.observed = new Set(); mutations.push(this) }
    observe(node) { this.observed.add(node) }
    disconnect() { this.observed.clear() }
  }
  function nodes(node) { return [node, ...node.children.flatMap(nodes)] }
  function makeNode(type, text = '') {
    const node = { type, text, props: {}, children: [], parent: null, tagName: type.toUpperCase(), scrollTop: 0, inert: false,
      contains(target) { return !!target && nodes(this).includes(target) },
      setAttribute(name, value) { this.props[name] = value }, removeAttribute(name) { delete this.props[name] },
      matches(selector) { return selector === ':disabled' && Boolean(this.props.disabled || (this.parentElement?.tagName === 'FIELDSET' && this.parentElement.props.disabled)) },
      closest(selector) {
        if (selector !== '[inert], [hidden]') return null
        for (let current = this; current; current = current.parentElement) if (current.inert || current.props.hidden) return current
        return null
      },
      querySelector(selector) { const index = selector.match(/data-menu-index="(-?\d+)"/)?.[1]; return nodes(this).find(child => String(child.props['data-menu-index']) === index) || null },
      getBoundingClientRect() { return this.rect || { left: 20, right: 150, top: 20, bottom: 58, width: 130, height: 38 } },
      focus() {
        for (let ancestor = this; ancestor; ancestor = ancestor.parent) if (ancestor.inert) return
        if (!this.isConnected || this.matches(':disabled')) return
        document.activeElement = this
        invoke(this, 'onFocus', event('', { target: this }))
        dispatch(documentListeners, 'focusin', this)
      },
      animate(frames, options) { const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true } }; animations.push(animation); return animation }
    }
    Object.defineProperties(node, {
      parentElement: { get: () => node.parent },
      isConnected: { get: () => node.type === 'root' || !!node.parent?.isConnected },
      offsetWidth: { get: () => String(node.props.class).includes('dropdown-menu') ? 240 : String(node.props.class).includes('dropdown-row') ? 224 : 130 },
      offsetHeight: { get: () => 40 }, offsetLeft: { get: () => 0 },
      offsetTop: { get: () => Number(node.props['data-menu-index'] || 0) * 40 },
      scrollHeight: { get: () => 180 }, clientHeight: { get: () => 120 }
    })
    return vue.markRaw(node)
  }
  const renderer = vue.createRenderer({
    createElement: makeNode, createText: value => makeNode('text', value), createComment: () => makeNode('comment'),
    setText(node, value) { node.text = value }, setElementText(node, value) { node.text = value; node.children = [] },
    patchProp(node, key, previous, value) {
      node.props[key] = key === 'disabled' ? value === '' || Boolean(value) : value
      if (key === 'inert') node.inert = value === '' || Boolean(value)
      if (['disabled', 'inert', 'hidden'].includes(key) && previous !== value) for (const observer of mutations) if (observer.observed.has(node)) queueMicrotask(() => observer.callback())
    },
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = null },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null
  })
  const DropdownMenu = new Function('Vue', 'contextMenuManager', 'document', 'window', 'ResizeObserver', menuCode)(motionVue, manager, document, window, ResizeObserver)
  const AnimatedSelect = new Function('Vue', 'DropdownMenu', 'window', 'MutationObserver', selectCode)(motionVue, DropdownMenu, window, MutationObserver)
  const roots = [], records = []
  function mount(options = {}) {
    const source = vue.reactive({ ...(kind === 'menu' ? { visible: true, items: [{ value: 'a', label: 'Alpha' }] } : { modelValue: 'a', options: [{ value: 'a', label: 'Alpha' }] }), ...props, ...options })
    const root = makeNode('root'), instance = vue.ref(), order = [], values = []
    const wrapperDisabled = vue.ref(false), wrapperInert = vue.ref(false), wrapperHidden = vue.ref(false)
    const app = renderer.createApp({ render: () => {
      const content = vue.h(kind === 'menu' ? DropdownMenu : AnimatedSelect, {
        ...source, ref: instance,
        onClose(reason) { order.push(['close', reason]); source.visible = false },
        onSelect(item) { order.push(['select', item.value, panel()?.inert]); source.onAction?.(item) },
        'onUpdate:modelValue'(value) { source.modelValue = value },
        onChange(value) { values.push(value) }
      })
      return fieldset ? vue.h('fieldset', { disabled: wrapperDisabled.value, inert: wrapperInert.value, hidden: wrapperHidden.value }, [content]) : content
    } })
    app.config.warnHandler = () => {}
    const all = () => nodes(root)
    const panel = () => all().find(node => String(node.props.class).split(' ').includes('dropdown-menu'))
    app.mount(root)
    let unmounted = false
    const unmount = () => { if (!unmounted) { unmounted = true; app.unmount() } }
    roots.push(root); records.push({ unmount })
    return { source, root, instance, order, values, wrapperDisabled, wrapperInert, wrapperHidden, all, panel,
      rows: () => all().filter(node => node.props['data-menu-index'] !== undefined),
      trigger: () => all().find(node => String(node.props.class).includes('animated-select-trigger')),
      key: key => invoke(panel(), 'onKeydown', event(key)), unmount }
  }
  const ui = mount()
  const external = makeNode('button'); external.parent = makeNode('root')
  t.after(() => records.forEach(record => record.unmount()))
  return { ...ui, mount, document, window, manager, external, resizes, mutations, animations,
    documentListeners, windowListeners,
    dispatchDocument: (name, target) => dispatch(documentListeners, name, target),
    dispatchWindow: (name, target) => dispatch(windowListeners, name, target),
    cleanup: () => records.forEach(record => record.unmount()) }
}

test('keyboard skips disabled rows and separators, supports boundaries and typeahead, and retires before acting once', async t => {
  const ui = fixture(t, { props: { items: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Blocked', disabled: true }, { divider: true }, { value: 'c', label: 'Charlie' }, { value: 'd', label: 'Delta' }] } })
  await flush()
  assert.equal(ui.document.activeElement.props['data-menu-index'], 0)
  ui.key('ArrowDown'); assert.equal(ui.document.activeElement.props['data-menu-index'], 3)
  ui.key('End'); assert.equal(ui.document.activeElement.props['data-menu-index'], 4)
  ui.key('Home'); assert.equal(ui.document.activeElement.props['data-menu-index'], 0)
  ui.key('d'); assert.equal(ui.document.activeElement.props['data-menu-index'], 4)
  const row = ui.rows().at(-1)
  ui.key('Enter')
  invoke(row, 'onClick')
  assert.deepEqual(ui.order, [['select', 'd', true], ['close', 'select']])
  assert.equal(ui.panel().inert, true)
})

test('opening a different menu dismisses the previous menu and all native listeners and observers are released', async t => {
  const ui = fixture(t)
  await flush()
  const other = ui.mount({ visible: false })
  other.source.visible = true
  await flush()
  assert.equal(ui.source.visible, false)
  assert.equal(other.source.visible, true)
  assert.equal(ui.order[0][1], 'dismiss')
  ui.cleanup()
  assert.equal(ui.manager.activeMenuCloser, null)
  assert.equal(ui.documentListeners.size, 0)
  assert.equal(ui.windowListeners.size, 0)
  assert(ui.resizes.every(observer => observer.observed.size === 0))
})

test('measured anchoring chooses room above or below and clamps horizontal viewport edges', async t => {
  const ui = fixture(t, { props: { anchor: { getBoundingClientRect: () => ({ left: 760, right: 790, top: 500, bottom: 530 }) } } })
  await flush()
  assert.equal(ui.panel().props.style.left, '552px')
  assert.equal(ui.panel().props.style.top, '312px')
  assert.equal(ui.panel().props.style.transformOrigin, 'bottom left')
  ui.source.anchor = { getBoundingClientRect: () => ({ left: -20, right: 100, top: 20, bottom: 50 }) }
  await flush()
  assert.equal(ui.panel().props.style.left, '8px')
  assert.equal(ui.panel().props.style.top, '58px')
  assert.equal(ui.panel().props.style.transformOrigin, 'top left')
})

test('internal scrolling keeps the menu open, external scrolling and outside pointer presses dismiss it', async t => {
  const ui = fixture(t)
  await flush()
  const options = ui.all().find(node => node.props.role === 'menu')
  ui.dispatchWindow('scroll', options)
  assert.equal(ui.source.visible, true)
  ui.dispatchWindow('scroll', ui.external)
  assert.equal(ui.source.visible, false)
  await flush(); ui.source.visible = true; await flush()
  ui.dispatchDocument('pointerdown', ui.external)
  assert.equal(ui.source.visible, false)
  assert.equal(ui.order.at(-1)[1], 'outside')
})

test('a cancelled opening cannot steal focus, while Escape restores the live opener', async t => {
  const ui = fixture(t, { props: { visible: false } })
  ui.external.focus()
  ui.source.visible = true
  await vue.nextTick()
  ui.source.visible = false
  await flush()
  assert.equal(ui.document.activeElement, ui.external)
  ui.source.visible = true
  await flush()
  assert.notEqual(ui.document.activeElement, ui.external)
  ui.key('Escape')
  assert.equal(ui.document.activeElement, ui.external)
  assert.equal(ui.source.visible, false)
  await flush(); ui.source.visible = true; await flush()
  assert.equal(ui.panel().inert, false)
  assert.equal(ui.panel().props['aria-hidden'], undefined)
})

test('select preserves numeric versus string values, announces the chosen value, and emits same-value retries', async t => {
  const ui = fixture(t, { kind: 'select', props: { modelValue: 0, label: '容量', options: [{ value: 0, label: '数字' }, { value: '0', label: '字符串' }] } })
  ui.instance.value.open()
  await flush()
  assert.deepEqual(ui.rows().map(row => row.props['aria-selected']), [true, false])
  assert.equal(ui.all().find(node => node.props.id === ui.trigger().props['aria-controls'])?.props.role, 'listbox')
  invoke(ui.rows()[1], 'onClick')
  await flush()
  assert.equal(ui.source.modelValue, '0')
  assert.match(ui.trigger().props['aria-label'], /容量.*字符串/)
  ui.instance.value.open(); await flush(); invoke(ui.rows()[1], 'onClick'); await flush()
  assert.deepEqual(ui.values, ['0', '0'])
  assert.equal(ui.trigger().props['aria-expanded'], false)
  ui.unmount()
  assert(ui.animations.every(animation => animation.cancelled))
})

test('disabled properties and inherited fieldset changes prevent opening and dismiss an already-open select', async t => {
  const ui = fixture(t, { kind: 'select', fieldset: true, props: { disabled: true } })
  ui.instance.value.open(); await flush(); assert.equal(ui.panel(), undefined)
  ui.source.disabled = false; ui.wrapperDisabled.value = true; await flush()
  ui.instance.value.open(); await flush(); assert.equal(ui.panel(), undefined)
  ui.wrapperDisabled.value = false; await flush(); ui.instance.value.open(); await flush()
  assert(ui.panel())
  ui.wrapperDisabled.value = true; await flush(); assert.equal(ui.panel(), undefined)
  ui.wrapperDisabled.value = false; await flush(); ui.instance.value.open(); await flush()
  ui.source.disabled = true; await flush(); assert.equal(ui.panel(), undefined)
  ui.cleanup()
  assert(ui.mutations.every(observer => observer.observed.size === 0))
})

test('Home and End on the closed select focus the corresponding enabled boundary without changing its value', async t => {
  const ui = fixture(t, { kind: 'select', reduced: true, props: { modelValue: 'b', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Charlie' }] } })
  invoke(ui.trigger(), 'onKeydown', event('End')); await flush()
  assert.equal(ui.document.activeElement.props['data-menu-index'], 2)
  assert.equal(ui.source.modelValue, 'b')
  ui.key('Escape'); await flush()
  invoke(ui.trigger(), 'onKeydown', event('Home')); await flush()
  assert.equal(ui.document.activeElement.props['data-menu-index'], 0)
  invoke(ui.rows()[0], 'onClick'); await flush()
  assert.equal(ui.animations.length, 0)
})

test('retiring or hiding an ancestor closes its teleported select and rejects a stale choice', async t => {
  const ui = fixture(t, { kind: 'select', fieldset: true, props: { options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] } })
  for (const state of [ui.wrapperInert, ui.wrapperHidden]) {
    ui.instance.value.open(); await flush()
    const staleRow = ui.rows()[1]
    state.value = true
    await flush()
    assert.equal(ui.panel(), undefined)
    invoke(staleRow, 'onClick')
    assert.equal(ui.source.modelValue, 'a')
    ui.instance.value.open(); await flush()
    assert.equal(ui.panel(), undefined)
    state.value = false; await flush()
  }
  assert.deepEqual(ui.values, [])
  ui.cleanup()
  assert(ui.mutations.every(observer => observer.observed.size === 0))
})
