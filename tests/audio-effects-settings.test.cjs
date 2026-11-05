const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { registerAppNotice } = require('./helpers/noticeHarness.cjs')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { normalizeAudioEffects } = require('../electron/audioEffectsConfig.cjs')

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const initialState = () => ({ revision: 1, supported: true, enabled: false, bufferMs: 128, running: false, scanning: false,
  scanProgress: null, searchPaths: [], error: null, saveError: null, latencyMs: 10,
  plugins: [{ id: 'plugin-a', name: 'Test Compressor', vendor: 'Vendor A', category: 'Dynamics', version: '1.0' },
    { id: 'plugin-b', name: 'Test Delay', vendor: 'Vendor B', category: 'Delay' }],
  chain: [{ instanceId: 'instance-a', pluginId: 'plugin-a', name: 'Test Compressor', bypassed: false, editorOpen: false, alwaysOnTop: false },
    { instanceId: 'instance-b', pluginId: 'plugin-b', name: 'Test Delay', bypassed: false, editorOpen: false, alwaysOnTop: false }],
  tempo: { trackId: 'song-a', bpm: 120, automaticBpm: 120, manualBpm: null, status: 'ready' } })

/** Compile the actual component and render its controls; service boundaries are the only application mocks. */
function mount(t, options = {}) {
  const filename = path.join(__dirname, '../src/components/common/AudioEffectsSettings.vue')
  const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
  const compiled = compileScript(descriptor, { id: 'audio-effects-settings-test', inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } }).content
    .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
    .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
  let snapshot = options.snapshot || initialState()
  let listener, unsubscribed = 0
  const calls = [], order = []
  const api = {
    getStatus: () => { order.push('snapshot'); return options.getStatus ? options.getStatus() : Promise.resolve(snapshot) },
    onStatus(callback) { order.push('subscribe'); listener = callback; return () => { unsubscribed++ } }
  }
  for (const method of ['listPlugins', 'scan', 'cancelScan', 'chooseDirectory', 'addPlugin', 'removePlugin', 'movePlugin',
    'setBypass', 'setEnabled', 'setBufferMs', 'openEditor', 'closeEditor', 'setTempoOverride', 'retry', 'retrySave']) {
    api[method] = async (...args) => {
      calls.push([method, ...args])
      if (options[method]) return options[method](...args)
      snapshot = structuredClone(snapshot)
      snapshot.revision++
      if (method === 'setEnabled') snapshot.enabled = args[0]
      if (method === 'setBufferMs') snapshot.bufferMs = args[0]
      if (method === 'scan') snapshot.scanning = true
      if (method === 'cancelScan') snapshot.scanning = false
      if (method === 'setTempoOverride') {
        snapshot.tempo.manualBpm = args[0].bpm
        snapshot.tempo.bpm = args[0].bpm ?? snapshot.tempo.automaticBpm
      }
      if (method === 'setBypass') snapshot.chain.find(item => item.instanceId === args[0].instanceId).bypassed = args[0].bypassed
      if (method === 'removePlugin') snapshot.chain = snapshot.chain.filter(item => item.instanceId !== args[0])
      if (method === 'movePlugin') {
        const index = snapshot.chain.findIndex(item => item.instanceId === args[0].instanceId)
        const [item] = snapshot.chain.splice(index, 1)
        snapshot.chain.splice(args[0].index, 0, item)
      }
      if (method === 'openEditor') Object.assign(snapshot.chain.find(item => item.instanceId === args[0].instanceId), { editorOpen: true, alwaysOnTop: args[0].alwaysOnTop })
      if (method === 'closeEditor') snapshot.chain.find(item => item.instanceId === args[0]).editorOpen = false
      if (method === 'retrySave') snapshot.saveError = null
      return snapshot
    }
  }
  const motionVue = { ...vue, Transition: { inheritAttrs: false, setup(_props, { slots }) { return () => slots.default?.() } },
    TransitionGroup: { inheritAttrs: false, setup(_props, { slots }) { return () => vue.h('ol', slots.default?.()) } } }
  const select = { props: ['modelValue', 'options', 'disabled', 'busy'], emits: ['update:modelValue'],
    setup(props, { emit }) { return () => vue.h('select', { value: props.modelValue, disabled: props.disabled, busy: props.busy,
      onChange: event => emit('update:modelValue', Number(event.target.value)) }, props.options.map(option => vue.h('option', { value: option.value }, option.label))) } }
  const component = new Function('Vue', 'window', 'logger', 'AnimatedSelect', compiled)(motionVue,
    { electronAPI: options.browser ? undefined : { audioEffects: api } }, { warn() {} }, select)
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null,
    setAttribute(name, value) { this.props[name] = value }, removeAttribute(name) { delete this.props[name] } })
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
  const root = node('root')
  const app = renderer.createApp({ render: () => vue.h(component, { beforeAction: async () => {
    order.push('save'); return options.beforeAction ? options.beforeAction() : true
  } }) })
  registerAppNotice(app)
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const nodes = item => [item, ...item.children.flatMap(nodes)]
  const text = item => item.text + item.children.map(text).join('')
  const all = () => nodes(root)
  const find = predicate => all().find(predicate)
  return { calls, order, unmount, unsubscribed: () => unsubscribed,
    publish(value) { snapshot = value; listener(value) }, text: () => text(root), all,
    byId: id => find(item => item.props.id === id),
    button: label => find(item => item.type === 'button' && text(item) === label),
    labelled: label => find(item => item.props['aria-label'] === label),
    card: name => find(item => item.type === 'li' && String(item.props.class).includes('effect-card') && text(item).includes(name)),
    async tempo(value) { find(item => item.props.id === 'effects-tempo').props.onInput({ target: { value } }); await vue.nextTick() },
    submitTempo: () => find(item => item.type === 'form').props.onSubmit({ preventDefault() {} }) }
}

test('normalization limits persistent fields, preserves repeated plugins and rejects polluted records', () => {
  assert.deepEqual(normalizeAudioEffects(null), { enabled: false, bufferMs: 128, searchPaths: [], chain: [] })
  const value = normalizeAudioEffects({ enabled: true, searchPaths: [' /plugins ', '/plugins', '', 'bad\0path'],
    chain: [{ instanceId: 'a', pluginId: 'plugin-a', bypassed: true, alwaysOnTop: true, state: 'private-data' },
      { instanceId: 'b', pluginId: 'plugin-a', bypassed: 'true', alwaysOnTop: 1 },
      { instanceId: 'a', pluginId: 'duplicate' }, { instanceId: 'bad', pluginId: '__proto__' }],
    tempo: { bpm: 120 }, token: 'placeholder' })
  assert.deepEqual(value, { enabled: true, bufferMs: 128, searchPaths: ['/plugins'], chain: [
    { instanceId: 'a', pluginId: 'plugin-a', bypassed: true, alwaysOnTop: true },
    { instanceId: 'b', pluginId: 'plugin-a', bypassed: false, alwaysOnTop: false } ] })
  assert.deepEqual(normalizeAudioEffects(JSON.parse('{"enabled":true,"__proto__":{"polluted":true}}')), { enabled: false, bufferMs: 128, searchPaths: [], chain: [] })
  assert.equal(normalizeAudioEffects({ chain: [JSON.parse('{"instanceId":"a","pluginId":"x","constructor":{}}')] }).chain.length, 0)
  assert.equal(normalizeAudioEffects(Object.create({ enabled: true, searchPaths: ['/inherited'] })).enabled, false)
  assert.equal({}.polluted, undefined)
})

test('normalization bounds directory, identifier and chain sizes without coercing booleans', () => {
  const value = normalizeAudioEffects({ enabled: 1, searchPaths: ['x'.repeat(4097), ...Array.from({ length: 80 }, (_, i) => `/plugins/${i}`)],
    chain: [{ instanceId: 'x'.repeat(65), pluginId: 'a' }, { instanceId: 'valid', pluginId: 'x'.repeat(1025) },
      ...Array.from({ length: 80 }, (_, i) => ({ instanceId: String(i), pluginId: 'a' }))] })
  assert.equal(value.enabled, false)
  assert.equal(value.searchPaths.length, 64)
  assert.equal(value.chain.length, 64)
  assert.equal(value.chain[0].instanceId, '0')
})

test('buffer preferences accept only supported durations and migrate older settings to 128ms', () => {
  for (const bufferMs of [64, 128, 256, 512]) assert.equal(normalizeAudioEffects({ bufferMs }).bufferMs, bufferMs)
  for (const bufferMs of [null, undefined, '256', 0, -1, 129, 8192, Infinity, {}, true]) {
    assert.equal(normalizeAudioEffects({ bufferMs }).bufferMs, 128)
  }
  assert.equal(normalizeAudioEffects(Object.create({ bufferMs: 512 })).bufferMs, 128)
})

test('buffer choice saves through the service after the parent barrier and failures remain retryable', async t => {
  let fail = true
  const snapshot = initialState()
  const ui = mount(t, { setBufferMs: async bufferMs => {
    if (fail) throw new Error('缓冲设置保存失败')
    return { ...snapshot, revision: 2, bufferMs }
  } })
  await flush()
  assert.equal(ui.byId('effects-buffer').props.value, 128)
  assert.deepEqual(ui.byId('effects-buffer').children.map(item => item.props.value), [64, 128, 256, 512])
  ui.byId('effects-buffer').props.onChange({ target: { value: '256' } })
  await flush()
  assert.equal(ui.order.at(-1), 'save')
  assert.deepEqual(ui.calls, [['setBufferMs', 256]])
  assert.equal(ui.byId('effects-buffer').props.value, 128)
  assert.match(ui.text(), /缓冲设置保存失败/)
  fail = false
  await ui.button('重试').props.onClick()
  await flush()
  assert.equal(ui.byId('effects-buffer').props.value, 256)
  ui.byId('effects-buffer').props.onChange({ target: { value: '999' } })
  await flush()
  assert.equal(ui.calls.length, 2)
})

test('imported instance identifiers match native editor events while missing-plugin identifiers remain portable', () => {
  const invalid = ['中文实例', 'with space', ' leading', 'trailing ', 'dot.name', 'path/name', '', 'x'.repeat(65), 123, null]
  const chain = invalid.map(instanceId => ({ instanceId, pluginId: 'missing' }))
  chain.push({ instanceId: 'Valid_123-instance', pluginId: '未安装的插件:vendor/path', bypassed: true })
  chain.push({ instanceId: 'a'.repeat(64), pluginId: 'legacy.plugin.id' })
  const result = normalizeAudioEffects({ chain })
  assert.equal(result.chain.length, 2)
  assert.equal(result.chain[0].instanceId, 'Valid_123-instance')
  assert.equal(result.chain[0].pluginId, '未安装的插件:vendor/path')
  assert.equal(result.chain[1].instanceId.length, 64)
})

test('subscription precedes status read and older snapshots cannot restore a removed instance', async t => {
  const initial = deferred()
  const ui = mount(t, { getStatus: () => initial.promise })
  assert.deepEqual(ui.order, ['subscribe', 'snapshot'])
  ui.publish({ ...initialState(), revision: 4, chain: [] })
  initial.resolve(initialState())
  await flush()
  assert.match(ui.text(), /添加第一个效果/)
  assert.equal(ui.card('Test Compressor'), undefined)
  ui.unmount()
  assert.equal(ui.unsubscribed(), 1)
})

test('all mutations wait for parent persistence, failed actions remain retryable and directory cancellation is quiet', async t => {
  let saved = false
  const ui = mount(t, { beforeAction: async () => saved, chooseDirectory: async () => null })
  await flush()
  await ui.button('添加插件目录').props.onClick()
  assert.deepEqual(ui.calls, [])
  await flush()
  assert.match(ui.text(), /请先重试保存其他设置/)
  saved = true
  await ui.button('重试').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, [['chooseDirectory']])
  assert.doesNotMatch(ui.text(), /已添加|已保存|操作成功/)
  await ui.byId('audio-effects-enabled').props.onChange({ target: { checked: true } })
  await flush()
  assert.equal(ui.byId('audio-effects-enabled').props.checked, true)
})

test('failed initial reads retry without duplicate subscriptions or concurrent snapshots', async t => {
  let reads = 0
  const retry = deferred()
  const ui = mount(t, { getStatus: () => ++reads === 1 ? Promise.reject(new Error('读取失败')) : retry.promise })
  await flush()
  const click = ui.button('重试').props.onClick
  const pending = click()
  await click()
  assert.equal(reads, 2)
  assert.equal(ui.order.filter(value => value === 'subscribe').length, 1)
  retry.resolve(initialState())
  await pending
  await flush()
  assert.doesNotMatch(ui.text(), /读取失败/)
  assert.equal(ui.byId('audio-effects-enabled').props.disabled, false)
})

test('scan cancellation remains available in flight and rejects late scan responses', async t => {
  const scanning = deferred()
  const ui = mount(t, { scan: () => scanning.promise,
    cancelScan: async () => ({ ...initialState(), revision: 5, scanning: false }) })
  await flush()
  const started = ui.button('扫描插件').props.onClick()
  await flush()
  ui.publish({ ...initialState(), revision: 3, scanning: true, scanProgress: { completed: 2, total: 10 } })
  await flush()
  assert.match(ui.text(), /已检查 2 \/ 10/)
  await ui.button('取消扫描').props.onClick()
  scanning.resolve({ ...initialState(), revision: 4, scanning: true })
  await started
  await flush()
  assert.equal(ui.button('取消扫描'), undefined)
  assert.deepEqual(ui.calls.map(call => call[0]), ['scan', 'cancelScan'])
})

test('a canceled scanner rejection cannot replace the confirmed cancellation with a stale error', async t => {
  const scanning = deferred()
  const ui = mount(t, { scan: () => scanning.promise,
    cancelScan: async () => ({ ...initialState(), revision: 5, scanning: false }) })
  await flush()
  const started = ui.button('扫描插件').props.onClick()
  await flush()
  ui.publish({ ...initialState(), revision: 3, scanning: true })
  await flush()
  await ui.button('取消扫描').props.onClick()
  scanning.reject(new Error('扫描已取消'))
  await started
  await flush()
  assert.doesNotMatch(ui.text(), /扫描已取消/)
  assert.equal(ui.button('扫描插件').props.disabled, false)
})

test('search, reorder, bypass, editor controls and removal call only the selected service instances', async t => {
  const ui = mount(t)
  await flush()
  ui.byId('effects-plugin-search').props.onInput({ target: { value: 'vendor b' } })
  await flush()
  assert.equal(ui.labelled('添加 Test Compressor'), undefined)
  await ui.labelled('添加 Test Delay').props.onClick()
  await ui.labelled('下移 Test Compressor').props.onClick()
  await flush()
  assert.deepEqual(ui.calls.slice(-2), [['addPlugin', 'plugin-b'], ['movePlugin', { instanceId: 'instance-a', index: 1 }]])
  const controls = card => {
    const all = item => [item, ...item.children.flatMap(all)]
    return all(card)
  }
  const firstCard = ui.card('Test Compressor')
  const checkboxes = controls(firstCard).filter(item => item.type === 'input')
  await checkboxes[0].props.onChange({ target: { checked: true } })
  await checkboxes[1].props.onChange({ target: { checked: true } })
  await flush()
  assert.deepEqual(ui.calls.slice(-2), [['setBypass', { instanceId: 'instance-a', bypassed: true }],
    ['openEditor', { instanceId: 'instance-a', alwaysOnTop: true }]])
  await ui.button('关闭界面').props.onClick()
  await ui.labelled('移除 Test Compressor').props.onClick()
  await flush()
  assert.deepEqual(ui.calls.slice(-2), [['closeEditor', 'instance-a'], ['removePlugin', 'instance-a']])
  assert.equal(ui.card('Test Compressor'), undefined)
})

test('tempo validation preserves invalid drafts and manual, scaled and automatic modes remain per track', async t => {
  const ui = mount(t)
  await flush()
  for (const invalid of ['', 'NaN', '19.9', '401']) {
    await ui.tempo(invalid)
    await ui.submitTempo()
    await flush()
    assert.match(ui.text(), /请输入 20–400/)
    assert.equal(ui.byId('effects-tempo').props.value, invalid)
  }
  assert.deepEqual(ui.calls, [])
  await ui.tempo('125.25')
  await ui.submitTempo()
  await flush()
  await ui.button('×2').props.onClick()
  await flush()
  await ui.button('÷2').props.onClick()
  await flush()
  await ui.button('恢复自动').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, [
    ['setTempoOverride', { trackId: 'song-a', bpm: 125.25 }], ['setTempoOverride', { trackId: 'song-a', bpm: 250.5 }],
    ['setTempoOverride', { trackId: 'song-a', bpm: 125.25 }], ['setTempoOverride', { trackId: 'song-a', bpm: null }]])
  assert.equal(ui.byId('effects-tempo').props.value, '')
})

test('a host fallback tempo is not presented as an analyzed song speed', async t => {
  const ui = mount(t, { snapshot: { ...initialState(), tempo: { trackId: 'song-a', bpm: 120, automaticBpm: null, manualBpm: null, status: 'waiting' } } })
  await flush()
  assert.match(ui.text(), /尚未获得可靠速度/)
  assert.match(ui.text(), /同步效果暂按 120 BPM/)
  assert.equal(ui.button('×2').props.disabled, true)
  await ui.button('×2').props.onClick()
  assert.deepEqual(ui.calls, [])
})

test('plugin latency is distinct from the sample-rate-aligned audio bridge buffer', async t => {
  const ui = mount(t, { snapshot: { ...initialState(), enabled: true, running: true, sampleRate: 44100, latencyMs: 12 } })
  await flush()
  assert.match(ui.text(), /插件延迟 12 ms/)
  assert.match(ui.text(), /约 130.61 ms 音频缓冲/)
  ui.publish({ ...initialState(), revision: 2, enabled: true, running: true, bufferMs: 256, appliedBufferMs: 64, sampleRate: 48000, latencyMs: 12 })
  await flush()
  assert.match(ui.text(), /约 64 ms 音频缓冲/)
})

test('host readiness follows the applied switch while a disabled retained host never appears to process audio', async t => {
  const ui = mount(t, { snapshot: { ...initialState(), running: true, enabled: false } })
  await flush()
  assert.match(ui.text(), /音频效果已关闭/)
  assert.doesNotMatch(ui.text(), /效果链已就绪|正在处理音频|音效处理另有约/)
  ui.publish({ ...initialState(), revision: 2, running: true, enabled: true, appliedEnabled: false, pendingChanges: true })
  await flush()
  assert.match(ui.text(), /音频效果已关闭/)
  assert.match(ui.text(), /修改尚未应用/)
  ui.publish({ ...initialState(), revision: 3, running: true, enabled: false, appliedEnabled: true, pendingChanges: true })
  await flush()
  assert.match(ui.text(), /效果链已就绪/)
  assert.doesNotMatch(ui.text(), /正在处理音频/)
  assert.match(ui.text(), /修改尚未应用/)
})

test('a missing native component is described as unavailable in the environment', async t => {
  const ui = mount(t, { snapshot: { ...initialState(), supported: false } })
  await flush()
  assert.match(ui.text(), /当前环境没有可用的音效组件/)
  assert.doesNotMatch(ui.text(), /当前平台.*不支持/)
  assert.equal(ui.byId('audio-effects-enabled').props.disabled, true)
})

test('changing track or unmounting during a parent save prevents stale native mutations', async t => {
  const save = deferred()
  const ui = mount(t, { beforeAction: () => save.promise })
  await flush()
  await ui.tempo('100')
  const applying = ui.submitTempo()
  ui.publish({ ...initialState(), revision: 4, tempo: { trackId: 'song-b', bpm: 90, manualBpm: null, automaticBpm: 90, status: 'ready' } })
  save.resolve(true)
  await applying
  await flush()
  assert.deepEqual(ui.calls, [])
  assert.equal(ui.byId('effects-tempo').props.value, '')
  const otherSave = deferred()
  const other = mount(t, { beforeAction: () => otherSave.promise })
  await flush()
  const choosing = other.button('添加插件目录').props.onClick()
  other.unmount()
  otherSave.resolve(true)
  await choosing
  assert.deepEqual(other.calls, [])
  assert.equal(other.unsubscribed(), 1)
})

test('browser mode disables native operations and save failures expose the dedicated retry', async t => {
  const browser = mount(t, { browser: true })
  await flush()
  assert.match(browser.text(), /仅在桌面客户端/)
  assert.equal(browser.byId('audio-effects-enabled').props.disabled, true)
  await browser.button('扫描插件').props.onClick()
  assert.deepEqual(browser.calls, [])
  const ui = mount(t, { snapshot: { ...initialState(), pendingChanges: true, saveError: { message: '磁盘写入失败' } } })
  await flush()
  assert.match(ui.text(), /效果设置尚未保存：磁盘写入失败/)
  assert.match(ui.text(), /修改尚未应用，正在使用上次成功的效果链/)
  await ui.button('重试保存').props.onClick()
  await flush()
  assert.deepEqual(ui.calls, [['retrySave']])
  assert.doesNotMatch(ui.text(), /尚未保存/)
})

test('drag reordering accepts only an in-component instance and ignores external drag data', async t => {
  const ui = mount(t)
  await flush()
  await ui.card('Test Delay').props.onDrop({ preventDefault() {} })
  assert.deepEqual(ui.calls, [])
  ui.card('Test Compressor').props.onDragstart({ preventDefault() {}, dataTransfer: { setData() {} } })
  await ui.card('Test Delay').props.onDrop({ preventDefault() {} })
  await flush()
  assert.deepEqual(ui.calls, [['movePlugin', { instanceId: 'instance-a', index: 1 }]])
})
