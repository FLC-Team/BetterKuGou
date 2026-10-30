const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

const filename = path.join(__dirname, '../src/components/common/DesktopLyricSettings.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
const compiled = compileScript(descriptor, { id: 'desktop-lyric-settings-test', inlineTemplate: true, templateOptions: { compilerOptions: { hoistStatic: false } } }).content
  .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
  .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
const motionVue = { ...vue, Transition: { setup(_props, { slots }) { return () => slots.default?.()[0] } } }
const AnimatedDetails = { setup(_props, { slots }) { return () => vue.h('details', {}, [vue.h('summary', {}, slots.summary?.()), slots.default?.()]) } }
const AnimatedSelect = {
  inheritAttrs: false, props: { modelValue: [String, Number], options: Array, disabled: Boolean, label: String }, emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => vue.h('select-stub', { ...attrs, modelValue: props.modelValue, options: props.options, disabled: props.disabled,
      'aria-label': props.label, 'onUpdate:modelValue': value => emit('update:modelValue', value) })
  }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }

/** Compile the actual settings component; stub only browser layout and native window capabilities. */
function mount(t, options = {}) {
  const calls = [], emitted = []
  const api = options.browser ? null : {
    async show() { calls.push('show'); return options.show ? options.show() : true },
    async resetPosition() { calls.push('resetPosition'); return options.recover ? options.recover() : true }
  }
  const Component = new Function('Vue', 'window', 'logger', 'AnimatedSelect', 'AnimatedDetails', compiled)(motionVue,
    { electronAPI: { desktopLyric: api } }, { warn() {} }, AnimatedSelect, AnimatedDetails)
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const renderer = vue.createRenderer({
    createElement: node, createText: value => node('text', value), createComment: () => node('comment'),
    setText: (item, text) => { item.text = text }, setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp(item, key, _old, value) { item.props[key] = value },
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
  const preferences = vue.ref(options.preferences || { fontSize: 'medium', theme: 'classic', locked: false, bounds: { x: 80, y: 100, width: 800, height: 200 }, externalField: 'keep' })
  const root = node('root')
  const app = renderer.createApp({ render: () => vue.h(Component, {
    modelValue: preferences.value,
    'onUpdate:modelValue': value => { emitted.push(value); preferences.value = value },
    beforeAction: options.beforeAction || (async () => true)
  }) })
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const nodes = item => [item, ...item.children.flatMap(nodes)]
  const text = item => item.text + item.children.map(text).join('')
  return { calls, emitted, preferences, unmount, byId: id => nodes(root).find(item => item.props.id === id), all: () => nodes(root), text: () => text(root) }
}

test('desktop preferences keep parent-only fields and do not persist display fallbacks on mount', async t => {
  const ui = mount(t)
  assert.equal(ui.emitted.length, 0)
  assert.equal(ui.byId('desktop-double-line').props.checked, true)
  assert.equal(ui.byId('desktop-hide-on-lyric-view').props.checked, true)
  assert.equal(ui.byId('desktop-opacity').props.value, 100)
  ui.byId('desktop-karaoke-enabled').props.onChange({ target: { checked: false } })
  await vue.nextTick()
  ui.preferences.value = { ...ui.preferences.value, bounds: { x: 120, y: 240 }, externalField: 'new-external-value' }
  await vue.nextTick()
  ui.byId('desktop-alignment').props['onUpdate:modelValue']('right')
  await vue.nextTick()
  assert.equal(ui.preferences.value.karaokeEnabled, false)
  assert.equal(ui.preferences.value.alignment, 'right')
  assert.equal(ui.preferences.value.externalField, 'new-external-value')
  assert.deepEqual(ui.preferences.value.bounds, { x: 120, y: 240 })
  assert.equal(Object.hasOwn(ui.preferences.value, 'opacity'), false)
  assert.deepEqual(ui.calls, [], 'editing preferences only changes the parent draft')
})

test('dependent controls disable without deleting the stored preference', async t => {
  const ui = mount(t, { preferences: { doubleLine: true, karaokeEnabled: true, hideTranslation: true, transitionEnabled: true, transitionBlur: true, hoverOpacity: 40 } })
  ui.byId('desktop-song-info-only').props.onChange({ target: { checked: true } })
  await vue.nextTick()
  ui.byId('desktop-efficient-mode').props.onChange({ target: { checked: true } })
  await vue.nextTick()
  for (const id of ['desktop-double-line', 'desktop-karaoke-enabled', 'desktop-hide-translation', 'desktop-transition-enabled', 'desktop-transition-blur', 'desktop-hover-opacity']) assert.equal(ui.byId(id).props.disabled, true, id)
  ui.byId('desktop-karaoke-enabled').props.onChange({ target: { checked: false } })
  assert.equal(ui.preferences.value.karaokeEnabled, true)
  ui.byId('desktop-song-info-only').props.onChange({ target: { checked: false } })
  await vue.nextTick()
  ui.byId('desktop-efficient-mode').props.onChange({ target: { checked: false } })
  await vue.nextTick()
  ui.byId('desktop-hover-fade').props.onChange({ target: { checked: true } })
  await vue.nextTick()
  assert.equal(ui.byId('desktop-transition-blur').props.disabled, false)
  assert.equal(ui.byId('desktop-hover-opacity').props.disabled, false)
  assert.equal(ui.preferences.value.hoverOpacity, 40)
  ui.byId('desktop-double-line').props.onChange({ target: { checked: false } })
  await vue.nextTick()
  assert.equal(ui.byId('desktop-hide-translation').props.disabled, true)
  assert.equal(ui.preferences.value.hideTranslation, true)
})

test('font, grouped colors and shadow reset preserve unrelated window options', async t => {
  const ui = mount(t, { preferences: { fontFamily: 'Example Font', activeColor: '#12345680', textColor: '#654321', translationColor: '#abcdef', shadowEnabled: true, shadowDepth: 20, shadowColor: '#abcdef80', bounds: { x: 10 }, alwaysOnTop: false } })
  assert.equal(ui.byId('desktop-active-color').props.value, '#123456')
  assert.equal(ui.byId('desktop-shadow-color').props.value, '#abcdef')
  assert.equal(ui.preferences.value.activeColor, '#12345680')
  assert.equal(ui.preferences.value.shadowColor, '#abcdef80')
  ui.byId('desktop-reset-font').props.onClick()
  await vue.nextTick()
  ui.byId('desktop-reset-colors').props.onClick()
  await vue.nextTick()
  assert.equal(ui.preferences.value.fontFamily, '')
  for (const key of ['activeColor', 'textColor', 'translationColor']) assert.equal(ui.preferences.value[key], '')
  assert.equal(ui.preferences.value.shadowDepth, 20)
  ui.byId('desktop-reset-shadow').props.onClick()
  await vue.nextTick()
  assert.equal(ui.preferences.value.shadowEnabled, true)
  assert.equal(ui.preferences.value.shadowDepth, 5)
  assert.equal(ui.preferences.value.shadowDirection, 315)
  assert.equal(ui.preferences.value.shadowOpacity, 50)
  assert.equal(ui.preferences.value.shadowRadius, 10)
  assert.equal(ui.preferences.value.shadowColorMode, 'cover')
  assert.equal(ui.preferences.value.shadowColor, '#000000')
  assert.equal(ui.preferences.value.alwaysOnTop, false)
  assert.deepEqual(ui.preferences.value.bounds, { x: 10 })
})

test('ranges clamp finite values while dependent shadow controls keep accessible labels', async t => {
  const ui = mount(t)
  ui.byId('desktop-opacity').props.onInput({ target: { value: '500' } })
  await vue.nextTick()
  assert.equal(ui.preferences.value.opacity, 100)
  ui.byId('desktop-stroke-width').props.onInput({ target: { value: '-5' } })
  await vue.nextTick()
  assert.equal(ui.preferences.value.strokeWidth, 0)
  const count = ui.emitted.length
  ui.byId('desktop-opacity').props.onInput({ target: { value: 'invalid' } })
  assert.equal(ui.emitted.length, count)
  assert.equal(ui.all().find(node => node.type === 'fieldset').props.disabled, true)
  assert.equal(ui.byId('desktop-shadow-color-mode').props.disabled, true)
  ui.byId('desktop-shadow-enabled').props.onChange({ target: { checked: true } })
  await vue.nextTick()
  assert.equal(ui.all().find(node => node.type === 'fieldset').props.disabled, false)
  assert.equal(ui.byId('desktop-shadow-color-mode').props.disabled, false)
  const controls = ui.all().filter(node => ['input', 'select-stub'].includes(node.type))
  const ids = controls.map(node => node.props.id)
  assert.equal(ids.length, new Set(ids).size)
  for (const control of controls) assert.ok(ui.all().some(node => node.type === 'label' && node.props.for === control.props.id), control.props.id)
})

test('opening and recovering wait for saved drafts, deduplicate and expose retryable failures', async t => {
  let saved = false
  let resolveSave
  const ui = mount(t, { beforeAction: () => saved ? true : new Promise(resolve => { resolveSave = resolve }) })
  const pending = ui.byId('desktop-open').props.onClick()
  await vue.nextTick()
  await ui.byId('desktop-recover').props.onClick()
  assert.deepEqual(ui.calls, [])
  assert.equal(ui.byId('desktop-open').props.disabled, true)
  resolveSave(false)
  await pending
  await flush()
  assert.match(ui.text(), /请先重试保存设置/)
  assert.deepEqual(ui.calls, [])
  saved = true
  await ui.byId('desktop-open').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, ['show'])
  assert.match(ui.text(), /桌面歌词已打开/)
  await ui.byId('desktop-recover').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, ['show', 'resetPosition'])
  assert.match(ui.text(), /已回到主屏幕下方并解锁/)
})

test('native failures and browser-only sessions cannot claim a successful window action', async t => {
  const ui = mount(t, { show: async () => false })
  await ui.byId('desktop-open').props.onClick()
  await flush()
  assert.match(ui.text(), /无法打开桌面歌词/)
  assert.doesNotMatch(ui.text(), /桌面歌词已打开/)
  assert.equal(ui.byId('desktop-open').props.disabled, false)
  const browser = mount(t, { browser: true })
  assert.equal(browser.byId('desktop-open').props.disabled, true)
  assert.equal(browser.byId('desktop-recover').props.disabled, true)
  await browser.byId('desktop-open').props.onClick()
  assert.deepEqual(browser.calls, [])
  assert.match(browser.text(), /仅在桌面客户端中可用/)
})

test('unmount while saving cannot open a late native window', async t => {
  let resolveSave
  const ui = mount(t, { beforeAction: () => new Promise(resolve => { resolveSave = resolve }) })
  const pending = ui.byId('desktop-open').props.onClick()
  ui.unmount()
  resolveSave(true)
  await pending
  assert.deepEqual(ui.calls, [])
})
