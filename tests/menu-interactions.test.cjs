const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')
const logger = { trace() {}, info() {}, warn() {}, error() {} }
const flush = async () => { await vue.nextTick(); await vue.nextTick() }
const passthrough = { setup(_props, { slots }) { return () => slots.default?.() } }

function definition(file, globals) {
  const filename = path.resolve(__dirname, '..', file)
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const sandbox = vm.createContext({ logger, ...globals })
  const source = descriptor.script.content.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
  const component = vm.runInContext(source.replace('export default', 'globalThis.component =') + '\ncomponent', sandbox)
  const result = compileTemplate({ filename, id: file, source: descriptor.template.content, compilerOptions: { mode: 'function', hoistStatic: false } })
  assert.deepEqual(result.errors, [])
  component.render = new Function('Vue', result.code)({ ...vue, Transition: passthrough, Teleport: passthrough })
  return component
}

/** Run production templates and handlers, including DOM event propagation and focus changes. */
function mount(t, file) {
  const listeners = new Map(), timers = new Map()
  let timerId = 0
  const document = { activeElement: null,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn) }
  }
  const window = { innerWidth: 1000, innerHeight: 700, addEventListener() {}, removeEventListener() {} }
  const all = node => [node, ...node.children.flatMap(all)]
  function node(type, text = '') {
    const value = { type, text, children: [], parent: null, props: {}, inert: false,
      contains(target) { return all(this).includes(target) },
      closest() { return null },
      focus() { if (!this.isConnected) return; document.activeElement = this; for (const fn of [...(listeners.get('focusin') || [])]) fn({ target: this }) },
      click() { dispatch(this, 'onClick') },
      querySelectorAll(selector) { return all(this).filter(child => selector.startsWith('button') ? child.type === 'button' && !child.props.disabled : child.props.role === 'menuitem' && !child.props['aria-disabled']) },
      querySelector(selector) { return this.querySelectorAll(selector)[0] },
      getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 160 } },
      setAttribute(name, value) { this.props[name] = value }, removeAttribute(name) { delete this.props[name] }
    }
    Object.defineProperty(value, 'isConnected', { get: () => value.type === 'root' || !!value.parent?.isConnected })
    return vue.markRaw(value)
  }
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: () => node('comment'),
    setText(target, text) { target.text = text }, setElementText(target, text) { target.text = text; target.children = [] },
    patchProp(target, name, _old, value) { target.props[name] = value },
    insert(target, parent, anchor) {
      if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1)
      target.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, target)
    },
    remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = null },
    parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] || null
  })
  const component = definition(file, { document, window,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) }
  })
  const source = vue.reactive({ visible: false, items: [{ label: 'First', action: () => actions++ }, { label: 'Second', action: () => actions++ }], userInfo: { username: 'Fixture' } })
  let actions = 0, closes = 0
  const root = node('root'), opener = node('button'), instance = vue.ref(null)
  opener.parent = root; root.children.push(opener); opener.focus()
  const app = renderer.createApp({ render: () => vue.h(component, { ...source, ref: instance, onClose() { closes++; source.visible = false } }) })
  app.config.warnHandler = () => {}
  app.mount(root)
  t.after(() => app.unmount())
  return { document, root, opener, source, instance, listeners, timers, nodes: () => all(root), actions: () => actions, closes: () => closes,
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()) } }
}
function dispatch(target, name, key) {
  let stopped = false
  const event = { target, key, preventDefault() { this.defaultPrevented = true }, stopPropagation() { stopped = true } }
  for (let current = target; current && !stopped; current = current.parent) {
    event.currentTarget = current
    for (const handler of [].concat(current.props[name] || [])) handler(event)
  }
  return { stopped, event }
}

test('context-menu Space activates once, stops propagation and restores the opener before the action', async t => {
  const ui = mount(t, 'src/components/common/ContextMenu.vue')
  ui.source.visible = true; await flush()
  assert.equal(ui.document.activeElement.props.role, 'menu')
  dispatch(ui.document.activeElement, 'onKeydown', 'ArrowDown')
  assert.equal(ui.document.activeElement.props.role, 'menuitem')
  const result = dispatch(ui.document.activeElement, 'onKeydown', ' ')
  assert.equal(result.stopped, true, 'player shortcuts cannot receive a menu activation')
  assert.equal(ui.actions(), 1)
  assert.equal(ui.document.activeElement, ui.opener)
  assert.equal(ui.closes(), 1)
})

test('context-menu Escape and Tab restore focus while outside dismissal preserves the new target', async t => {
  const ui = mount(t, 'src/components/common/ContextMenu.vue')
  for (const key of ['Escape', 'Tab']) {
    ui.source.visible = true; await flush()
    dispatch(ui.document.activeElement, 'onKeydown', key); await flush()
    assert.equal(ui.document.activeElement, ui.opener)
  }
  ui.source.visible = true; await flush()
  const outside = { focus() { ui.document.activeElement = outside } }; outside.focus()
  ui.instance.value.handleClickOutside({ target: outside }); await flush()
  assert.equal(ui.document.activeElement, outside)
})

test('an already-visible menu moved to another trigger returns focus to the newer trigger', async t => {
  const ui = mount(t, 'src/components/common/ContextMenu.vue')
  ui.source.visible = true; await flush()
  const another = { isConnected: true, closest: () => null, focus() { ui.document.activeElement = another } }
  another.focus()
  ui.source.position = { x: 80, y: 90 }; await flush()
  dispatch(ui.document.activeElement, 'onKeydown', 'Escape'); await flush()
  assert.equal(ui.document.activeElement, another)
})

test('account menu receives keyboard focus, Escape returns it once and rapid reopen cannot attach obsolete listeners', async t => {
  const ui = mount(t, 'src/components/layout/UserMenu.vue')
  ui.source.visible = true; await flush(); ui.runTimers()
  assert.equal(ui.document.activeElement.type, 'button')
  assert.notEqual(ui.document.activeElement, ui.opener)
  const first = ui.document.activeElement
  dispatch(first, 'onKeydown', 'End')
  assert.notEqual(ui.document.activeElement, first)
  dispatch(ui.document.activeElement, 'onKeydown', 'Escape'); await flush()
  assert.equal(ui.document.activeElement, ui.opener)
  assert.equal(ui.closes(), 1, 'restoring focus must not re-enter the outside-close listener')
  assert.equal(ui.listeners.get('focusin').size, 0)
  ui.source.visible = true; await flush(); ui.source.visible = false; await flush(); ui.runTimers()
  assert.equal(ui.listeners.get('click').size, 0)
  ui.source.visible = true; await flush(); ui.runTimers()
  assert.equal(ui.listeners.get('click').size, 1)
})

test('keyboard suggestion navigation reveals either edge without moving input focus and ignores obsolete ticks', async () => {
  const component = definition('src/components/layout/TitleBar.vue', { UserMenu: {}, minimizeIcon: '', maximizeIcon: '', restoreIcon: '', closeIcon: '' })
  const callbacks = []
  let bounds = { top: 180, bottom: 220 }
  const panel = { scrollTop: 0, clientTop: 1, clientHeight: 100, getBoundingClientRect: () => ({ top: 10 }), querySelector: () => ({ getBoundingClientRect: () => bounds }) }
  const view = { activeSuggestion: 4, showSearchHints: true, $refs: { searchHints: panel }, $nextTick: fn => callbacks.push(fn) }
  const reveal = component.methods.revealActiveSuggestion.bind(view)
  reveal(); callbacks.shift()(); assert.equal(panel.scrollTop, 109)
  bounds = { top: -20, bottom: 10 }; reveal(); callbacks.shift()(); assert.equal(panel.scrollTop, 78)
  reveal(); view.activeSuggestion = 5; callbacks.shift()(); assert.equal(panel.scrollTop, 78)
  reveal(); view.showSearchHints = false; callbacks.shift()(); assert.equal(panel.scrollTop, 78)
  view.showSearchHints = true
  panel.scrollTop = 0; panel.offsetHeight = 102; panel.getBoundingClientRect = () => ({ top: 10, height: 51 })
  bounds = { top: 90, bottom: 110 }; reveal(); callbacks.shift()()
  assert.equal(panel.scrollTop, 99, 'opening scale must not leave the selected result clipped when the popup settles')
})
