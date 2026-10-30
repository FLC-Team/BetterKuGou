const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

const root = path.resolve(__dirname, '..')
const filename = path.join(root, 'src/components/player/VolumeControl.vue')
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })

/** Mount the production template with native input events, Teleport and Vue prop updates. */
function mountControl(t, overrides = {}) {
  function eventTarget() {
    const listeners = new Map()
    return {
      listeners,
      addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(callback)
      },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
      dispatch(name, detail = {}) { for (const callback of [...(listeners.get(name) || [])]) callback(detail) }
    }
  }
  const document = { ...eventTarget(), activeElement: null }
  const window = { ...eventTarget(), innerWidth: 1280, innerHeight: 800 }
  const previousDocument = global.document
  global.document = document
  function node(type, text = '') {
    return {
      ...eventTarget(), type, tagName: type.toUpperCase(), text, props: {}, children: [], parent: null, value: '',
      contains(other) { for (let item = other; item; item = item.parent) if (item === this) return true; return false },
      focus() { document.activeElement = this }, select() { this.selected = true },
      setAttribute(name, value) { this.props[name] = value },
      removeAttribute(name) { delete this.props[name] },
      getBoundingClientRect() {
        return type === 'form' ? { width: 220, height: 130 } : { top: 742, bottom: 772, left: 1110, right: 1272 }
      }
    }
  }
  const body = node('body')
  document.body = body
  const sandbox = vm.createContext({ module: { exports: {} }, document, window,
    sound0Icon: 'mute.svg', sound1Icon: 'low.svg', sound2Icon: 'medium.svg', sound3Icon: 'high.svg' })
  vm.runInContext(fs.readFileSync(path.join(root, 'src/utils/contextMenuManager.js'), 'utf8')
    .replace('export default new ContextMenuManager()', 'globalThis.contextMenuManager = new ContextMenuManager()'), sandbox)
  vm.runInContext(descriptor.script.content.replace(/^import[^\n]*\n/gm, '')
    .replace('export default', 'module.exports ='), sandbox)
  const compiled = compileTemplate({ source: descriptor.template.content, filename, id: 'volume-control',
    compilerOptions: { mode: 'function', hoistStatic: false } })
  assert.deepEqual(compiled.errors, [])
  const transition = { inheritAttrs: false, setup(_props, { slots }) { return () => slots.default?.() } }
  const component = { ...sandbox.module.exports,
    render: new Function('Vue', compiled.code)({ ...vue, Transition: transition }) }
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    setText: (item, text) => { item.text = text },
    setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _old, value) => { item.props[key] = value; if (key === 'value') item.value = value },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
      item.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, item)
    },
    remove(item) { item.parent?.children.splice(item.parent.children.indexOf(item), 1); item.parent = null },
    parentNode: item => item.parent,
    nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null,
    querySelector: selector => selector === 'body' ? body : null
  })
  const state = vue.reactive({ volume: 65, isMuted: false, variant: 'player', active: true, ...overrides })
  const changes = []
  let toggles = 0
  let control
  const app = renderer.createApp({ render: () => vue.h(component, { ...state, ref: value => { control = value },
    onChange: value => { changes.push(value); state.volume = value; state.isMuted = value === 0 },
    onToggleMute: () => { toggles++; state.isMuted = !state.isMuted }
  }) })
  const container = node('root')
  app.mount(container)
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); mounted = false } }
  t.after(() => { unmount(); global.document = previousDocument })
  const all = () => {
    const visit = item => [item, ...item.children.flatMap(visit)]
    return [...visit(container), ...visit(body)]
  }
  const find = predicate => all().find(predicate)
  const byClass = name => find(item => String(item.props.class || '').split(' ').includes(name))
  const input = () => find(item => item.props['aria-label'] === '音量百分比')
  return { state, changes, document, window, body, container, node, find, byClass, input, all,
    get control() { return control }, get toggles() { return toggles }, unmount,
    menuManager: sandbox.contextMenuManager }
}

function dispatch(target, name, values = {}) {
  const event = { target, currentTarget: target, stopped: false, prevented: false,
    stopPropagation() { this.stopped = true }, preventDefault() { this.prevented = true }, ...values }
  target.dispatch(name, event)
  for (const handler of [].concat(target.props['on' + name[0].toUpperCase() + name.slice(1)] || [])) handler(event)
  return event
}

async function openEditor(fixture, rightClick = true) {
  const event = dispatch(fixture.byClass(rightClick ? 'volume-control' : 'volume-value'), rightClick ? 'contextmenu' : 'click')
  await vue.nextTick()
  await vue.nextTick()
  return event
}

async function typeVolume(fixture, value) {
  const input = fixture.input()
  input.value = String(value)
  dispatch(input, 'input')
  await vue.nextTick()
}

test('right-click opens an isolated focused numeric editor and committing synchronizes the range', async t => {
  const fixture = mountControl(t)
  const event = await openEditor(fixture)
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  assert.equal(fixture.input().value, '65')
  assert.equal(fixture.document.activeElement, fixture.input())
  assert.equal(fixture.input().selected, true)
  const editor = fixture.byClass('volume-editor')
  assert.equal(editor.props.role, 'dialog')
  assert.ok(fixture.body.contains(editor), 'the editor escapes player and lyric clipping through Teleport')
  assert.ok(parseFloat(editor.props.style.left) + 220 <= 1272)
  assert.ok(parseFloat(editor.props.style.top) + 130 <= 792)
  await typeVolume(fixture, 37)
  assert.deepEqual(fixture.changes, [], 'typing does not change audio until confirmation')
  assert.equal(dispatch(editor, 'submit').prevented, true)
  await vue.nextTick()
  assert.deepEqual(fixture.changes, [37])
  assert.equal(fixture.byClass('volume-slider').props.value, 37)
  assert.equal(fixture.byClass('volume-editor'), undefined)
  assert.equal(fixture.document.activeElement, fixture.byClass('volume-value'))
})

test('both boundaries commit while blank, nonfinite, fractional and out-of-range drafts stay editable', async t => {
  const fixture = mountControl(t, { variant: 'lyric' })
  for (const value of ['', ' ', 'bad', 'Infinity', -1, 101, 5.5]) {
    await openEditor(fixture, false)
    await typeVolume(fixture, value)
    dispatch(fixture.byClass('volume-editor'), 'submit')
    await vue.nextTick()
    assert.deepEqual(fixture.changes, [], String(value))
    assert.equal(fixture.input().props['aria-invalid'], true)
    assert.equal(fixture.byClass('volume-error').props.role, 'alert')
  }
  for (const value of [0, 100]) {
    await typeVolume(fixture, value)
    dispatch(fixture.byClass('volume-editor'), 'submit')
    await vue.nextTick()
    assert.equal(fixture.state.volume, value)
    assert.equal(fixture.byClass('volume-button').props['aria-pressed'], value === 0)
    if (value === 0) await openEditor(fixture)
  }
  assert.deepEqual(fixture.changes, [0, 100])
})

test('Escape and cancel discard drafts without bubbling into lyric close or playback shortcuts', async t => {
  const fixture = mountControl(t)
  await openEditor(fixture)
  await typeVolume(fixture, 15)
  const event = dispatch(fixture.byClass('volume-editor'), 'keydown', { key: 'Escape' })
  await vue.nextTick()
  assert.equal(event.stopped, true)
  assert.equal(event.prevented, true)
  assert.deepEqual(fixture.changes, [])
  assert.equal(fixture.state.volume, 65)
  await openEditor(fixture, false)
  await typeVolume(fixture, 25)
  dispatch(fixture.find(item => item.type === 'button' && item.text === '取消'), 'click')
  await vue.nextTick()
  assert.deepEqual(fixture.changes, [])
  assert.equal(fixture.byClass('volume-editor'), undefined)
  assert.equal(dispatch(fixture.byClass('volume-control'), 'keydown', { key: 'ArrowUp', ctrlKey: true }).stopped, false,
    'after closing, focused volume buttons must still allow the application volume shortcut')
})

test('slider, mute and external state changes use the same controlled state in lyric and player variants', async t => {
  const fixture = mountControl(t)
  const slider = fixture.byClass('volume-slider')
  slider.value = '28'
  dispatch(slider, 'input')
  await vue.nextTick()
  assert.deepEqual(fixture.changes, [28])
  dispatch(fixture.byClass('volume-button'), 'click')
  await vue.nextTick()
  assert.equal(fixture.toggles, 1)
  assert.equal(fixture.byClass('volume-value').text, '0%')
  assert.equal(fixture.byClass('volume-button').props['aria-label'], '取消静音')
  fixture.state.variant = 'lyric'
  fixture.state.volume = 83
  fixture.state.isMuted = false
  await vue.nextTick()
  assert.ok(fixture.byClass('volume-control-lyric'))
  assert.equal(fixture.byClass('volume-slider').props.value, 83)
  assert.equal(fixture.byClass('volume-value').text, '83%')
  assert.equal(fixture.byClass('volume-button').props['aria-pressed'], false)
})

test('outside focus and pointer, window changes, menu replacement and inactive state release the editor', async t => {
  const fixture = mountControl(t)
  const outside = fixture.node('button')
  const closures = [
    () => fixture.document.dispatch('pointerdown', { target: outside }),
    () => dispatch(fixture.byClass('volume-editor'), 'focusout', { relatedTarget: outside }),
    () => fixture.window.dispatch('blur'),
    () => fixture.window.dispatch('resize'),
    () => fixture.menuManager.registerMenu(() => {}),
    () => { fixture.state.active = false }
  ]
  for (const close of closures) {
    fixture.state.active = true
    await vue.nextTick()
    await openEditor(fixture)
    fixture.document.dispatch('pointerdown', { target: fixture.input() })
    assert.ok(fixture.byClass('volume-editor'), 'a click inside the teleported editor leaves it open')
    dispatch(fixture.byClass('volume-editor'), 'focusout', { relatedTarget: fixture.input() })
    assert.equal(fixture.control.editorOpen, true)
    await typeVolume(fixture, 12)
    close()
    await vue.nextTick()
    assert.equal(fixture.byClass('volume-editor'), undefined)
    assert.equal(fixture.document.listeners.get('pointerdown')?.size, 0)
    assert.equal(fixture.window.listeners.get('blur')?.size, 0)
    assert.equal(fixture.window.listeners.get('resize')?.size, 0)
    assert.deepEqual(fixture.changes, [])
  }
  await openEditor(fixture)
  assert.equal(fixture.byClass('volume-editor'), undefined, 'hidden player controls cannot reopen an editor')
})

test('opening closes the prior menu and unmount cancels pending focus without leaking listeners', async t => {
  const fixture = mountControl(t)
  let closed = 0
  fixture.menuManager.registerMenu(() => closed++)
  await openEditor(fixture)
  assert.equal(closed, 1)
  dispatch(fixture.byClass('volume-value'), 'click')
  fixture.unmount()
  await vue.nextTick()
  assert.equal(fixture.menuManager.activeMenuCloser, null)
  assert.equal(fixture.document.listeners.get('pointerdown')?.size, 0)
  assert.equal(fixture.window.listeners.get('blur')?.size, 0)
  assert.equal(fixture.window.listeners.get('resize')?.size, 0)
  assert.deepEqual(fixture.changes, [])
})
