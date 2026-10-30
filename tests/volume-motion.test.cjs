const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

/** Keep real Vue patching so cross-level changes cannot replace the speaker or native range. */
function mountVolume(t) {
  const filename = path.join(__dirname, '../src/components/player/VolumeControl.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const component = vm.runInNewContext(descriptor.script.content.replace(/^import[^\n]*\n/gm, '')
    .replace('export default', 'const component =') + '\ncomponent', {
    contextMenuManager: { unregisterMenu() {} },
    document: { removeEventListener() {} }, window: { removeEventListener() {} }
  })
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'volume-motion',
    compilerOptions: { mode: 'function', hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  component.render = new Function('Vue', template.code)({ ...vue,
    Transition: { inheritAttrs: false, setup(_props, { slots }) { return () => slots.default?.() } } })
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const body = node('body')
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    setText: (item, text) => { item.text = text },
    setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _previous, value) => { item.props[key] = value },
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
  const state = vue.reactive({ volume: 80, isMuted: false })
  const changes = []
  const app = renderer.createApp({ render: () => vue.h(component, { ...state,
    onChange(value) { changes.push(value); state.volume = value; state.isMuted = value === 0 }
  }) })
  const container = node('root')
  app.mount(container)
  t.after(() => app.unmount())
  const all = item => [item, ...item.children.flatMap(all)]
  const byClass = name => all(container).filter(item => String(item.props.class || '').split(' ').includes(name))
  return { state, changes, byClass }
}

test('rapid volume levels keep a single speaker, wave set and native input across reversals', async t => {
  const fixture = mountVolume(t)
  const speaker = fixture.byClass('volume-speaker')[0]
  const glyph = fixture.byClass('volume-icon')[0]
  const waves = fixture.byClass('volume-wave')
  const slider = fixture.byClass('volume-slider')[0]
  const fill = fixture.byClass('volume-fill')[0]
  const isVisible = item => item.props.class.split(' ').includes('is-visible')
  for (const [volume, visibleWaves] of [[29, 1], [31, 2], [59, 2], [61, 3], [30, 1], [60, 2], [0, 0], [100, 3]]) {
    fixture.state.volume = volume
    await vue.nextTick()
    assert.equal(fixture.byClass('volume-speaker')[0], speaker)
    assert.deepEqual(fixture.byClass('volume-icon'), [glyph])
    assert.deepEqual(fixture.byClass('volume-wave'), waves)
    assert.equal(waves.filter(isVisible).length, visibleWaves)
    assert.equal(isVisible(fixture.byClass('volume-mute')[0]), volume === 0)
    assert.equal(fixture.byClass('volume-slider')[0], slider)
    assert.equal(fixture.byClass('volume-fill')[0], fill)
    assert.equal(slider.props.value, volume)
    assert.equal(fixture.byClass('volume-range')[0].props.style['--volume-fill'], `${volume}%`)
  }
})

test('latest input commits immediately and mute preserves the remembered slider position', async t => {
  const fixture = mountVolume(t)
  const slider = fixture.byClass('volume-slider')[0]
  for (const value of ['12', '98', '0', '61']) slider.props.onInput({ target: { value } })
  assert.deepEqual(fixture.changes, [12, 98, 0, 61], 'visual transitions never delay or discard audio events')
  await vue.nextTick()
  assert.equal(slider.props.value, 61)
  fixture.state.isMuted = true
  await vue.nextTick()
  assert.equal(slider.props.value, 61)
  assert.match(slider.props['aria-valuetext'], /已静音/)
  assert.match(fixture.byClass('volume-range')[0].props.class, /is-muted/)
  assert.equal(fixture.byClass('volume-range')[0].props.style['--volume-fill'], '61%')
  assert.equal(fixture.byClass('volume-wave').filter(item => item.props.class.includes('is-visible')).length, 0)
  fixture.state.isMuted = false
  await vue.nextTick()
  assert.equal(fixture.byClass('volume-slider')[0], slider)
  assert.equal(fixture.byClass('volume-wave').filter(item => item.props.class.includes('is-visible')).length, 3)
  assert.deepEqual(fixture.changes, [12, 98, 0, 61], 'prop-driven visual updates do not emit another volume commit')
})
