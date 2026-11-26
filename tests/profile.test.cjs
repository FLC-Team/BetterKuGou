const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { parse, compileTemplate } = require('@vue/compiler-sfc')
const vue = require('vue')
const { getModulesDefinitions } = require('../KuGouMusicApi/server')

const root = path.resolve(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('the desktop API discovers the profile update route from the real module directory', async () => {
  const modules = await getModulesDefinitions(path.join(root, 'KuGouMusicApi/module'), {}, false)
  const update = modules.find(value => value.identifier === 'user_update')
  assert.equal(update.route, '/user/update')
  assert.equal(update.module, path.join(root, 'KuGouMusicApi/module/user_update.js'))
})

test('profile fields are redacted from backend query and exception diagnostics', () => {
  const source = fs.readFileSync(path.join(root, 'KuGouMusicApi/server.js'), 'utf8')
  const diagnosticFunctions = source.slice(source.indexOf('const SENSITIVE_QUERY_KEYS'), source.indexOf('const envPath'))
  const diagnostics = vm.runInNewContext(`${diagnosticFunctions}\n;({ getSafeRequestUrl, getSafeErrorDetails })`, { URL })
  const safe = diagnostics.getSafeRequestUrl('/user/update?nickname=private-name&signature=private-note&sex=1&birthday=2000-01-01&page=2')
  for (const value of ['private-name', 'private-note', '2000-01-01', 'sex=1']) assert.equal(safe.includes(value), false)
  assert.match(safe, /page=2/)
  const error = diagnostics.getSafeErrorDetails(new Error('request failed nickname=private-name&signature=private-note&birthday=2000-01-01'))
  for (const value of ['private-name', 'private-note', '2000-01-01']) assert.equal(JSON.stringify(error).includes(value), false)
})

function backend() {
  const requests = [], encrypted = []
  const sandbox = { module: { exports: {} }, process: { env: {} }, require(name) {
    if (name === '../util') return { cryptoRSAEncrypt: value => { encrypted.push(JSON.parse(value)); return 'abcd' }, signParamsKey: () => 'signed-key' }
    if (name === '../util/config.json') return { appid: 1, clientver: 2, liteAppid: 3, liteClientver: 4 }
    return require(name)
  } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'KuGouMusicApi/module/user_update.js'), 'utf8'), sandbox)
  return { requests, encrypted, sandbox,
    update: params => sandbox.module.exports(params, async request => { requests.push(request); return { status: 200, body: { status: 1 } } }) }
}

test('profile updates preserve the proven upstream authentication and forward only supported edited fields', async () => {
  const fixture = backend()
  await fixture.update({ cookie: { token: 'placeholder-token', userid: '123', KUGOU_API_MID: 'device-id' },
    nickname: ' New Name ', signature: '', sex: 0, birthday: '', arbitrary: 'ignored', photo: 'ignored' })
  const request = fixture.requests[0]
  assert.equal(request.baseURL, 'http://update.user.kugou.com')
  assert.equal(request.url, '/v1/update_userinfo')
  assert.equal(request.method, 'POST')
  assert.equal(request.clearDefaultParams, true)
  assert.equal(request.notSignature, true)
  assert.deepEqual(plain(request.data.data), { nickname: 'New Name', signature: '', sex: '0', birthday: '' })
  assert.equal(request.data.userid, 123)
  assert.equal(request.data.mid, 'device-id')
  assert.equal(request.data.p, 'ABCD')
  assert.equal(request.data.key, 'signed-key')
  assert.equal(request.data.token, undefined)
  assert.equal(request.params, undefined)
  assert.equal(fixture.encrypted[0].token, 'placeholder-token')
  fixture.sandbox.process.env.platform = 'lite'
  await fixture.update({ token: 'placeholder-token', userid: 123, nickname: 'Lite' })
  assert.equal(fixture.requests[1].data.appid, 3)
  assert.equal(fixture.requests[1].data.clientver, 4)
})

test('invalid profile fields and absent login never reach the upstream mutation boundary', async () => {
  const fixture = backend()
  for (const patch of [{}, { nickname: '' }, { nickname: {} }, { sex: false }, { sex: 3 },
    { birthday: '2025-02-29' }, { birthday: '2024-2-2' }, { signature: 'a'.repeat(201) }, { photo: 'not-supported' }]) {
    await assert.rejects(fixture.update({ token: 'placeholder-token', userid: 123, ...patch }), error => error.status === 400)
  }
  await assert.rejects(fixture.update({ nickname: 'Name' }), error => error.status === 401)
  await fixture.update({ token: 'placeholder-token', userid: 123, birthday: '2024-02-29' })
  assert.equal(fixture.requests.length, 1)
})

function profileApi(request) {
  const source = fs.readFileSync(path.join(root, 'src/api/profile.js'), 'utf8').replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(`${source}\n;({ getUserProfile, updateUserProfile })`, { libraryRequest: request })
}

test('profile API scopes reads and writes to the shared authenticated client and keeps clearing fields', async () => {
  const calls = []
  const api = profileApi(async (...args) => { calls.push(args); return { status: 1, data: { userid: 123, nickname: 'Name', sex: 0, signature: 'About', birthday: '2000-02-29' } } })
  const profile = await api.getUserProfile({ userid: '123' })
  assert.deepEqual(plain(profile), { userid: '123', nickname: 'Name', sex: '0', signature: 'About', birthday: '2000-02-29' })
  assert.equal(calls[0][0], '/user/detail')
  assert.equal(calls[0][2].authenticated, true)
  await api.updateUserProfile({ nickname: ' New ', signature: '', birthday: '', sex: '2' })
  assert.equal(calls[1][0], '/user/update')
  assert.deepEqual(plain(calls[1][1]), { nickname: 'New', signature: '', birthday: '', sex: '2' })
  assert.equal(calls[1][2].method, 'post')
  assert.equal(calls[1][2].mutation, true)
  assert.equal(calls[1][2].authenticated, true)
  for (const patch of [{}, { token: 'unexpected' }, { sex: '4' }, { birthday: '2025-02-29' }]) assert.throws(() => api.updateUserProfile(patch))
  const wrongAccount = profileApi(async () => ({ status: 1, data: { userid: 'other', nickname: 'Other' } }))
  await assert.rejects(wrongAccount.getUserProfile({ userid: '123' }), /账号状态/)
  const aliases = profileApi(async () => ({ status: 1, data: { nickname: {}, username: 'Valid name' } }))
  assert.equal((await aliases.getUserProfile({ userid: '123' })).nickname, 'Valid name')
})

function editor({ get = async () => ({ nickname: 'Name', signature: 'About', sex: '2', birthday: '' }), update = async () => ({ status: 1 }) } = {}) {
  const source = parse(fs.readFileSync(path.join(root, 'src/components/common/ProfileEditor.vue'), 'utf8')).descriptor.script.content
    .replace(/^import[^\n]*\n/gm, '').replace('export default', 'module.exports =')
  const storage = new Map([['kugou_userid', '123'], ['kugou_token', 'placeholder-token']])
  const emitted = [], calls = [], focus = [], appRoot = { inert: false }
  const trigger = { isConnected: true, closest: () => null, focus: () => focus.push('trigger') }
  const document = { hidden: false, activeElement: trigger, getElementById: () => appRoot }
  const sandbox = { module: { exports: {} }, AbortController, setTimeout, clearTimeout, document,
    localStorage: { getItem: key => storage.get(key) }, window: { matchMedia: () => ({ matches: true }) },
    getUserProfile: get, updateUserProfile: (...args) => { calls.push(args); return update(...args) } }
  vm.runInNewContext(source, sandbox)
  const definition = sandbox.module.exports
  const view = { ...definition.data(), blocked: false, userInfo: { userid: '123', username: 'Name' },
    $emit: (...args) => emitted.push(args), $nextTick: () => Promise.resolve(),
    $refs: { surface: { focus: () => focus.push('surface') }, nicknameInput: { focus: () => focus.push('nickname') } } }
  for (const [key, method] of Object.entries(definition.methods)) view[key] = method.bind(view)
  for (const [key, getter] of Object.entries(definition.computed)) Object.defineProperty(view, key, { get: () => getter.call(view) })
  definition.created.call(view)
  return { view, calls, emitted, storage, document, appRoot, focus,
    mount: () => definition.mounted.call(view), unmount: () => definition.beforeUnmount.call(view) }
}

test('profile editor keeps failed drafts, prevents duplicate saves and publishes only after server acknowledgement', async () => {
  const pending = deferred()
  let attempt = 0
  const fixture = editor({ update: () => ++attempt === 1 ? Promise.reject(new Error('Server unavailable')) : pending.promise })
  const { view, calls, emitted } = fixture
  await view.load()
  view.draft.nickname = 'Updated'
  view.draft.signature = ''
  await view.save()
  assert.equal(view.error, 'Server unavailable')
  assert.equal(view.draft.nickname, 'Updated')
  assert.equal(view.draft.signature, '')
  assert.equal(view.saving, false)
  assert.equal(emitted.length, 0)
  const saving = view.save()
  await view.save()
  view.close()
  assert.equal(calls.length, 2)
  assert.equal(emitted.length, 0, 'in-flight write cannot be closed or reported as complete')
  assert.deepEqual(plain(calls[1][0]), { nickname: 'Updated', signature: '' })
  pending.resolve({ status: 1 })
  await saving
  assert.deepEqual(plain(emitted), [['updated', { userid: '123', username: 'Updated' }], ['close']])
  fixture.unmount()
})

test('profile reads and writes ignore former-account completions and disposal aborts pending work', async () => {
  const load = deferred()
  const fixture = editor({ get: (_fallback, options) => { fixture.readSignal = options.signal; return load.promise } })
  const reading = fixture.view.load()
  fixture.storage.set('kugou_token', 'replacement-token')
  load.resolve({ nickname: 'Old', signature: '', sex: '1', birthday: '' })
  await reading
  assert.equal(fixture.view.loaded, false)
  fixture.unmount()
  assert.equal(fixture.readSignal.aborted, true)

  const update = deferred()
  const second = editor({ update: () => update.promise })
  await second.view.load()
  second.view.draft.nickname = 'Changed'
  const saving = second.view.save()
  second.storage.set('kugou_userid', 'other')
  update.resolve({ status: 1 })
  await saving
  assert.equal(second.emitted.length, 0)
  second.unmount()
})

test('profile modal isolates app content and restores the existing inert state and trigger on disposal', async () => {
  const fixture = editor()
  fixture.mount()
  assert.equal(fixture.appRoot.inert, true)
  await Promise.resolve(); await Promise.resolve()
  assert.ok(fixture.focus.includes('surface'))
  fixture.unmount()
  assert.equal(fixture.appRoot.inert, false)
  assert.equal(fixture.focus.at(-1), 'trigger')
})

test('compiled profile form exposes its real controls and disables submission while the account update is pending', async () => {
  const descriptor = parse(fs.readFileSync(path.join(root, 'src/components/common/ProfileEditor.vue'), 'utf8')).descriptor
  const compiled = compileTemplate({ source: descriptor.template.content, filename: 'ProfileEditor.vue', id: 'profile-test' })
  assert.deepEqual(compiled.errors, [])
  const code = compiled.code.replace(/^import \{([^}]+)\} from "vue"/gm, (_all, imports) =>
    `const { ${imports.replace(/ as /g, ': ')} } = Vue`).replace('export function render', 'function render')
  // Shallow VNode rendering executes the compiled bindings/events; native v-model hooks require a browser DOM.
  const render = new Function('Vue', `${code}\nreturn render`)({ ...vue, resolveComponent: name => name, withDirectives: vnode => vnode })
  const pending = deferred()
  const fixture = editor({ update: () => pending.promise })
  await fixture.view.load()
  const flatten = node => !node || typeof node !== 'object' ? [] :
    [node, ...(Array.isArray(node.children) ? node.children.flatMap(flatten) : [])]
  const nodes = () => flatten(render.call(fixture.view, fixture.view, []))
  let controls = nodes()
  assert.equal(controls.find(node => node.type === 'section').props.role, 'dialog')
  assert.equal(controls.filter(node => node.type === 'input' && node.props.type === 'radio').length, 3)
  controls.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === '1').props['onUpdate:modelValue']('1')
  controls.find(node => node.type === 'textarea').props['onUpdate:modelValue']('')
  const saving = controls.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  controls = nodes()
  assert.equal(controls.find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
  assert.deepEqual(plain(fixture.calls[0][0]), { signature: '', sex: '1' })
  pending.resolve({ status: 1 })
  await saving
  assert.deepEqual(fixture.emitted.map(value => value[0]), ['updated', 'close'])
  fixture.unmount()
})
