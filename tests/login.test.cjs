const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function loadLogin(api = {}) {
  const timers = new Map()
  const saved = []
  const emitted = []
  const alerts = []
  const logs = []
  let nextTimer = 0
  const schedule = (callback, delay) => {
    const id = ++nextTimer
    timers.set(id, { callback, delay })
    return id
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/views/LoginView.vue'), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace('export default', 'module.exports =')
  const log = (...args) => logs.push(args)
  const sandbox = vm.createContext({
    module: { exports: {} },
    console: { log, info: log, warn: log, error: log },
    logger: { trace: log, info: log, warn: log, error: log },
    alert: message => alerts.push(message),
    setTimeout: schedule,
    clearTimeout: id => timers.delete(id),
    setInterval: schedule,
    clearInterval: id => timers.delete(id),
    getQRCodeKey: async () => ({ data: { key: 'private-qr-key' } }),
    createQRCode: async () => ({ data: { qrimg: 'private-qr-image' } }),
    checkQRCodeStatusAPI: async () => ({ data: { status: 1 } }),
    sendCaptchaAPI: async () => ({ status: 1 }),
    loginByPhone: async () => ({ status: 1, data: { token: 'private-token' } }),
    loginByAccount: async () => ({ status: 1, data: { token: 'private-token' } }),
    saveLoginInfo: data => saved.push(data),
    ...api
  })
  vm.runInContext(source, sandbox)
  const options = sandbox.module.exports
  const view = { ...options.data(), $nextTick: () => Promise.resolve() }
  for (const [name, method] of Object.entries(options.methods)) view[name] = method.bind(view)
  view.$emit = (...args) => emitted.push(args)
  return {
    view, timers, saved, emitted, alerts, logs,
    unmount: () => options.beforeUnmount.call(view),
    switchTab(tab) {
      view.currentTab = tab
      options.watch.currentTab.call(view, tab)
    },
    runTimer() {
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      return timer.callback()
    }
  }
}

test('QR polling waits for each response before scheduling the next request', async () => {
  const first = deferred()
  let requests = 0
  const login = loadLogin({ checkQRCodeStatusAPI: () => { requests++; return first.promise } })
  login.view.currentTab = 'qrcode'
  await login.view.generateQRCode()
  assert.equal(login.timers.size, 1)
  const poll = login.runTimer()
  assert.equal(requests, 1)
  assert.equal(login.timers.size, 0)
  first.resolve({ data: { status: 1 } })
  await poll
  assert.equal(login.timers.size, 1)
  login.unmount()
  assert.equal(login.timers.size, 0)
})

test('an in-flight QR success cannot log in after leaving the QR tab', async () => {
  const response = deferred()
  const login = loadLogin({ checkQRCodeStatusAPI: () => response.promise })
  login.view.currentTab = 'qrcode'
  await login.view.generateQRCode()
  const poll = login.runTimer()
  login.switchTab('phone')
  response.resolve({ data: { status: 4, token: 'private-token' } })
  await poll
  assert.equal(login.saved.length, 0)
  assert.equal(login.emitted.length, 0)
  assert.equal(login.timers.size, 0)
})

test('unmount cancels a scheduled QR refresh and stale QR generation', async () => {
  const login = loadLogin({ checkQRCodeStatusAPI: async () => ({ data: { status: 0 } }) })
  login.view.currentTab = 'qrcode'
  await login.view.generateQRCode()
  await login.runTimer()
  assert.equal(login.view.qrcodeStatus, 'expired')
  assert.equal(login.timers.size, 1)
  login.unmount()
  assert.equal(login.timers.size, 0)

  const key = deferred()
  const generating = loadLogin({ getQRCodeKey: () => key.promise })
  generating.view.currentTab = 'qrcode'
  const request = generating.view.generateQRCode()
  generating.unmount()
  key.resolve({ data: { key: 'private-qr-key' } })
  await request
  assert.equal(generating.view.qrcodeKey, '')
  assert.equal(generating.timers.size, 0)
})

test('QR success saves credentials once without logging private payloads', async () => {
  const login = loadLogin({ checkQRCodeStatusAPI: async () => ({ data: { status: 4, token: 'private-token' } }) })
  login.view.currentTab = 'qrcode'
  await login.view.generateQRCode()
  await login.runTimer()
  assert.equal(login.saved.length, 1)
  assert.equal(login.timers.size, 0)
  assert.equal(login.emitted.filter(([event]) => event === 'loginSuccess').length, 1)
  assert.equal(JSON.stringify(login.logs).includes('private-'), false)
})

for (const [method, apiName, form] of [
  ['handlePhoneLogin', 'loginByPhone', { phoneForm: { phone: '13800000000', captcha: '123456' } }],
  ['handleAccountLogin', 'loginByAccount', { accountForm: { username: 'example', password: 'private-password' } }],
  ['sendCaptcha', 'sendCaptchaAPI', { phoneForm: { phone: '13800000000', captcha: '' } }]
]) {
  test(`${method} ignores responses arriving after unmount`, async () => {
    const response = deferred()
    const login = loadLogin({ [apiName]: () => response.promise })
    Object.assign(login.view, form)
    const request = login.view[method]()
    login.unmount()
    response.resolve({ status: 1, data: { token: 'private-token' } })
    await request
    assert.equal(login.saved.length, 0)
    assert.equal(login.emitted.length, 0)
    assert.equal(login.alerts.length, 0)
    assert.equal(login.timers.size, 0)
  })
}

test('captcha failures start no countdown and repeated clicks share one request', async () => {
  const response = deferred()
  let requests = 0
  const login = loadLogin({ sendCaptchaAPI: () => { requests++; return response.promise } })
  login.view.phoneForm.phone = '13800000000'
  const request = login.view.sendCaptcha()
  await login.view.sendCaptcha()
  assert.equal(requests, 1)
  response.resolve({ status: 0 })
  await request
  assert.equal(login.view.captchaCountdown, 0)
  assert.equal(login.timers.size, 0)
})
