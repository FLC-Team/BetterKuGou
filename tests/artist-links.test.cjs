const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

/** Mount the actual common component, preserving its template, props and events. */
function mountLinks(t, song, compact = false) {
  const filename = path.join(__dirname, '../src/components/common/ArtistLinks.vue')
  const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  assert.deepEqual(errors, [])
  const sandbox = vm.createContext({ module: { exports: {} } })
  const metadata = fs.readFileSync(path.join(__dirname, '../src/utils/songMetadata.js'), 'utf8')
  vm.runInContext(metadata.replace(/^export /gm, ''), sandbox)
  vm.runInContext(descriptor.script.content.replace(/^import[^\n]*\n/gm, '')
    .replace('export default', 'module.exports ='), sandbox)
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'artist-links',
    compilerOptions: { mode: 'function', hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  const component = { ...sandbox.module.exports, render: new Function('Vue', template.code)(vue) }
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null, scrollLeft: 0,
    bounds: { left: 0, right: 100 }, getBoundingClientRect() { return this.bounds } })
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    setText: (item, text) => { item.text = text },
    setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _old, value) => { item.props[key] = value },
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
      item.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, item)
    },
    remove(item) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1)
      item.parent = null
    },
    parentNode: item => item.parent,
    nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null
  })
  const emitted = []
  const bubbled = []
  const props = vue.reactive({ song, compact })
  const app = renderer.createApp({ render: () => vue.h('div', {
    onClick: () => bubbled.push('click'), onDblclick: () => bubbled.push('dblclick')
  }, [vue.h(component, { ...props, onSelect: value => emitted.push(value) })]) })
  const root = node('root')
  app.mount(root)
  t.after(() => app.unmount())
  return { root, props, emitted, bubbled }
}

function all(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))]
}

function dispatch(target, eventName, detail = 1) {
  let stopped = false
  const event = { target, detail, stopPropagation() { stopped = true }, preventDefault() {} }
  for (let item = target; item && !stopped; item = item.parent) {
    event.currentTarget = item
    for (const handler of [].concat(item.props[eventName] || [])) handler(event)
  }
  return stopped
}

test('every artist is a separately named native button and clicks isolate parent playback', t => {
  const song = { singerinfo: [{ singer_id: 1, singer_name: 'AC/DC' }, { author_id: 2, author_name: 'Simon & Garfunkel' }] }
  const snapshot = JSON.stringify(song)
  const { root, emitted, bubbled } = mountLinks(t, song)
  const buttons = all(root, item => item.type === 'button')
  assert.deepEqual(buttons.map(button => button.text), ['AC/DC', 'Simon & Garfunkel'])
  for (const button of buttons) {
    assert.equal(button.props.type, 'button')
    assert.equal(button.props['aria-label'], `查看歌手 ${button.text}`)
    assert.equal(dispatch(button, 'onClick', 0), true, 'keyboard activation stays within the artist link')
    assert.equal(dispatch(button, 'onDblclick', 2), true, 'double click cannot start row playback')
    assert.equal(all(button, item => item.type === 'button').length, 1)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{ id: 1, name: 'AC/DC' }, { id: 2, name: 'Simon & Garfunkel' }])
  assert.deepEqual(bubbled, [])
  assert.equal(JSON.stringify(song), snapshot)
})

test('missing metadata is noninteractive and later song props replace the displayed artists', async t => {
  const { root, props, emitted } = mountLinks(t, null)
  assert.equal(all(root, item => item.type === 'button').length, 0)
  assert.equal(all(root, item => item.text === '未知歌手').length, 1)
  props.song = { singername: '未知歌手' }
  await vue.nextTick()
  assert.equal(all(root, item => item.type === 'button').length, 0)
  props.song = { SingerName: 'One、Two', SingerId: 99 }
  await vue.nextTick()
  const buttons = all(root, item => item.type === 'button')
  assert.deepEqual(buttons.map(button => button.text), ['One', 'Two'])
  dispatch(buttons[1], 'onClick')
  assert.deepEqual(JSON.parse(JSON.stringify(emitted)), [{ id: null, name: 'Two' }])
})

test('compact rows reveal focused later and earlier artists without moving outer containers', t => {
  const { root } = mountLinks(t, { singerinfo: ['One', 'Two', 'Three'] }, true)
  const buttons = all(root, item => item.type === 'button')
  const container = buttons[0].parent
  assert.match(container.props.class, /artist-links-compact/)
  buttons[2].bounds = { left: 120, right: 170 }
  dispatch(buttons[2], 'onFocus')
  assert.equal(container.scrollLeft, 70)
  buttons[0].bounds = { left: -30, right: 20 }
  dispatch(buttons[0], 'onFocus')
  assert.equal(container.scrollLeft, 40)
  assert.equal(root.scrollLeft, 0)
  assert.equal(container.parent.scrollLeft, 0)
})

test('wrapping rows leave scrolling alone when an artist receives focus', t => {
  const { root } = mountLinks(t, { singerinfo: ['A long artist name', 'Another artist'] })
  const button = all(root, item => item.type === 'button')[1]
  assert.doesNotMatch(button.parent.props.class, /artist-links-compact/)
  button.bounds = { left: 120, right: 170 }
  dispatch(button, 'onFocus')
  assert.equal(button.parent.scrollLeft, 0)
})

test('compact mouse wheels reveal overflowed artists and preserve outer scrolling at boundaries', t => {
  const { root } = mountLinks(t, { singerinfo: ['One', 'Two', 'Three'] }, true)
  const container = all(root, item => item.type === 'button')[0].parent
  container.clientWidth = 100
  container.scrollWidth = 300
  let prevented = 0
  let stopped = 0
  const wheel = (details = {}) => container.props.onWheel({
    currentTarget: container, deltaX: 0, deltaY: 40, deltaMode: 0,
    preventDefault() { prevented++ }, stopPropagation() { stopped++ }, ...details
  })
  wheel()
  assert.equal(container.scrollLeft, 40)
  wheel({ deltaX: -20, deltaY: 0 })
  assert.equal(container.scrollLeft, 20)
  wheel({ deltaMode: 1, deltaY: 2 })
  assert.equal(container.scrollLeft, 56)
  wheel({ deltaMode: 2, deltaY: 1 })
  assert.equal(container.scrollLeft, 156)
  wheel({ deltaY: 400 })
  assert.equal(container.scrollLeft, 200)
  assert.equal(prevented, 5)
  assert.equal(stopped, 5)
  wheel()
  wheel({ ctrlKey: true, deltaY: -20 })
  wheel({ deltaY: NaN })
  assert.equal(container.scrollLeft, 200)
  assert.equal(prevented, 5, 'the end boundary, zoom and invalid input retain native behavior')
  wheel({ deltaY: -1000 })
  assert.equal(container.scrollLeft, 0)
  wheel({ deltaY: -40 })
  assert.equal(prevented, 6, 'the start boundary does not swallow the page wheel')
  container.scrollWidth = 100
  wheel()
  assert.equal(prevented, 6, 'rows without overflow do not swallow the page wheel')
})

test('wrapping artist rows retain normal mouse-wheel behavior', t => {
  const { root } = mountLinks(t, { singerinfo: ['One', 'Two'] })
  const container = all(root, item => item.type === 'button')[0].parent
  container.clientWidth = 100
  container.scrollWidth = 300
  container.props.onWheel({ currentTarget: container, deltaY: 30, deltaX: 0,
    preventDefault() { assert.fail('wrapping content must preserve native scrolling') } })
  assert.equal(container.scrollLeft, 0)
})
