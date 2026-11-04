const test = require('node:test')
const assert = require('node:assert/strict')
const vue = require('vue')
const { registerAppNotice } = require('./helpers/noticeHarness.cjs')

const flush = async () => { await vue.nextTick(); await Promise.resolve(); await vue.nextTick() }
function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** Mount production AppNotice with a controlled Fue outlet and real Vue update/KeepAlive lifecycles. */
function fixture(t, initial = {}, { keepAlive = false, clearOnClose = false } = {}) {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const renderer = vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: () => node('comment'),
    setText: (item, text) => { item.text = text },
    setElementText: (item, text) => { item.text = text; item.children = [] },
    patchProp: (item, key, _before, value) => { item.props[key] = value },
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
  const state = vue.reactive({ message: '初始提醒', type: 'info', revision: 0, actions: [], ...initial })
  const active = vue.ref(true)
  let closes = 0
  const Owner = { name: 'NoticeOwner', render: () => vue.h(vue.resolveComponent('AppNotice'), { ...state,
    onClose: () => { closes++; if (clearOnClose) state.message = '' } }) }
  const Other = { name: 'OtherPage', render: () => vue.h('div', '其他页面') }
  const app = renderer.createApp({ render: () => keepAlive
    ? vue.h(vue.KeepAlive, null, { default: () => active.value ? vue.h(Owner) : vue.h(Other) })
    : active.value ? vue.h(Owner) : null })
  const notices = registerAppNotice(app)
  const root = node('root')
  app.mount(root)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  const descendants = item => [item, ...item.children.flatMap(descendants)]
  const text = item => item.text + item.children.map(text).join('')
  return { state, active, notices, unmount, text: () => text(root), closes: () => closes,
    button: label => descendants(root).find(item => item.type === 'button' && (text(item) === label || item.props['aria-label'] === label)) }
}

test('replacing or removing a notice never emits a user close or clears newer caller state', async t => {
  const ui = fixture(t, {}, { clearOnClose: true })
  const old = ui.notices.entries[0]
  ui.state.message = '新的提醒'
  await flush()
  assert.equal(ui.notices.entries.length, 1)
  assert.notEqual(ui.notices.entries[0].id, old.id)
  assert.equal(ui.state.message, '新的提醒')
  assert.equal(ui.closes(), 0)
  old.onAfterLeave()
  await flush()
  assert.equal(ui.state.message, '新的提醒')
  assert.equal(ui.closes(), 0)
  const current = ui.notices.entries[0]
  ui.notices.api.close(current.id)
  await flush()
  assert.equal(ui.closes(), 1)
  assert.equal(ui.state.message, '')
  assert.equal(ui.notices.entries.length, 0)
  current.onAfterLeave()
  assert.equal(ui.closes(), 1, 'duplicate external completion does not notify the caller twice')
})

test('same text can be shown again with revision, with correct persistent and timed lifetimes', async t => {
  const ui = fixture(t, { type: 'success' })
  assert.equal(ui.notices.entries[0].duration, 4500)
  ui.notices.api.close(ui.notices.entries[0].id)
  await flush()
  assert.equal(ui.notices.entries.length, 0)
  ui.state.revision++
  await flush()
  assert.equal(ui.notices.entries.length, 1)
  assert.match(ui.text(), /初始提醒/)
  ui.state.type = 'error'
  await flush()
  assert.equal(ui.notices.entries[0].duration, 0)
  ui.state.type = 'warning'
  await flush()
  assert.equal(ui.notices.entries[0].duration, 0)
  ui.state.duration = 7000
  await flush()
  assert.equal(ui.notices.entries[0].duration, 7000)
})

test('disabled and busy actions are rejected even through retained handlers, and pending actions do not reenter', async t => {
  const pending = deferred()
  let calls = 0
  const ui = fixture(t, { actions: [{ label: '重试', disabled: true, run: () => { calls++; return pending.promise } }] })
  const disabled = ui.button('重试')
  assert.equal(disabled.props.disabled, true)
  await disabled.props.onClick()
  assert.equal(calls, 0)
  ui.state.actions[0].disabled = false
  ui.state.busy = true
  await flush()
  await ui.button('重试').props.onClick()
  assert.equal(calls, 0)
  ui.state.busy = false
  await flush()
  const click = ui.button('重试').props.onClick
  const operation = click()
  await click()
  await flush()
  assert.equal(calls, 1)
  assert.equal(ui.button('重试').props.disabled, true)
  pending.resolve()
  await operation
  await flush()
  assert.equal(ui.button('重试').props.disabled, false)
  assert.equal(ui.notices.entries[0].duration, 0, 'actionable notices remain available until resolved or closed')
})

test('rejected actions keep their visible retry and a later success clears the action error', async t => {
  let failed = true, calls = 0
  const ui = fixture(t, { actions: [{ label: '重试', run: async () => { calls++; if (failed) throw new Error('无法写入，请重试') } }] })
  await ui.button('重试').props.onClick()
  await flush()
  assert.equal(ui.notices.entries.length, 1)
  assert.match(ui.text(), /无法写入，请重试/)
  assert.equal(ui.button('重试').props.disabled, false)
  failed = false
  await ui.button('重试').props.onClick()
  await flush()
  assert.equal(calls, 2)
  assert.doesNotMatch(ui.text(), /无法写入，请重试/)
})

test('buttons retained from a replaced or closed notification cannot start work or change the new notice', async t => {
  const oldWork = deferred()
  let calls = 0
  const ui = fixture(t, { actions: [{ label: '重试', run: () => { calls++; return oldWork.promise } }] })
  const oldClick = ui.button('重试').props.onClick
  const working = oldClick()
  ui.state.message = '新操作结果'
  await flush()
  await oldClick()
  assert.equal(calls, 1)
  oldWork.reject(new Error('过期错误'))
  await working
  await flush()
  assert.match(ui.text(), /新操作结果/)
  assert.doesNotMatch(ui.text(), /过期错误/)
  const closedClick = ui.button('重试').props.onClick
  ui.notices.api.close(ui.notices.entries[0].id)
  await closedClick()
  assert.equal(calls, 1)
})

test('unmount prevents retained buttons and late action failures from recreating notifications', async t => {
  const pending = deferred()
  let calls = 0
  const ui = fixture(t, { actions: [{ label: '重试', run: () => { calls++; return pending.promise } }] })
  const click = ui.button('重试').props.onClick
  const action = click()
  ui.unmount()
  assert.equal(ui.notices.entries.length, 0)
  await click()
  pending.reject(new Error('卸载后的错误'))
  await action
  await flush()
  assert.equal(calls, 1)
  assert.equal(ui.notices.entries.length, 0)
  assert.equal(ui.closes(), 0)
})

test('KeepAlive deactivation removes only its own entry, rejects stale clicks and resumes the latest message', async t => {
  let calls = 0
  const ui = fixture(t, { actions: [{ label: '重试', run: () => { calls++ } }] }, { keepAlive: true })
  const foreign = ui.notices.api.info('另一个通知')
  const click = ui.button('重试').props.onClick
  ui.active.value = false
  await flush()
  assert.equal(ui.notices.entries.length, 1)
  assert.equal(ui.notices.entries[0].id, foreign)
  await click()
  ui.state.message = '缓存页最新结果'
  await flush()
  assert.equal(calls, 0)
  assert.equal(ui.notices.entries.length, 1)
  assert.equal(ui.closes(), 0)
  ui.active.value = true
  await flush()
  assert.equal(ui.notices.entries.length, 2)
  assert.match(ui.text(), /缓存页最新结果/)
  await click()
  assert.equal(calls, 0)
  await ui.button('重试').props.onClick()
  assert.equal(calls, 1)
})

test('replacing an action while keeping the message does not leave its old handler callable', async t => {
  let obsoleteCalls = 0, currentCalls = 0
  const ui = fixture(t, { actions: [{ label: '旧操作', run: () => { obsoleteCalls++ } }] })
  const oldClick = ui.button('旧操作').props.onClick
  ui.state.actions = [{ label: '当前操作', run: () => { currentCalls++ } }]
  await flush()
  assert.equal(ui.button('旧操作'), undefined)
  await oldClick()
  assert.equal(obsoleteCalls, 0)
  await ui.button('当前操作').props.onClick()
  assert.equal(currentCalls, 1)
})

test('Fue leave transition rejects action clicks immediately and only reports close after leaving', async t => {
  let calls = 0
  const ui = fixture(t, { actions: [{ label: '重试', run: () => { calls++ } }] })
  const entry = ui.notices.entries[0]
  const click = ui.button('重试').props.onClick
  assert.equal(entry.onClose(), true)
  await flush()
  assert.equal(ui.button('重试').props.disabled, true)
  await click()
  assert.equal(calls, 0)
  assert.equal(ui.closes(), 0)
  ui.notices.api.destroy(entry.id)
  assert.equal(ui.closes(), 1)
})

test('required notices reject guarded close while owner removal can still destroy them', async t => {
  const ui = fixture(t, { closable: false, type: 'error' })
  ui.notices.api.close(ui.notices.entries[0].id)
  assert.equal(ui.notices.entries.length, 1)
  assert.equal(ui.closes(), 0)
  ui.state.message = ''
  await flush()
  assert.equal(ui.notices.entries.length, 0)
  assert.equal(ui.closes(), 0)
})
