const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadLogger(electronAPI) {
  const outputs = []
  const context = vm.createContext({
    window: { electronAPI },
    console: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(method => [method, (...args) => outputs.push(args)]))
  })
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/logger.js'), 'utf8')
    .replace('export const logger', 'globalThis.logger')
  vm.runInContext(source, context)
  return { logger: context.logger, context, outputs }
}

test('all log outputs redact credentials and Axios request configuration while preserving diagnostics', () => {
  const entries = []
  const { logger, context, outputs } = loadLogger({ writeLog: entry => entries.push(entry) })
  vm.runInContext(`
    const error = new Error('GET /song/url?cookie=token%3Dsecret%3Buserid%3Dprivate failed')
    error.code = 'ECONNRESET'
    error.config = { headers: { Authorization: 'Bearer credential' }, data: { password: 'password-secret' } }
    logger.error('api', 'request failed', error)
    const diagnostic = { token: 'token-secret', nested: { accesskey: 'key-secret' }, count: 0 }
    diagnostic.self = diagnostic
    logger.warn('api', 'Bearer header-secret', diagnostic)
  `, context)
  const serialized = JSON.stringify({ entries, outputs, logs: logger.getLogs() })
  for (const secret of ['token-secret', 'key-secret', 'password-secret', 'credential', 'header-secret', 'private']) {
    assert.equal(serialized.includes(secret), false, secret)
  }
  assert.equal(entries[0].data.code, 'ECONNRESET')
  assert.equal(entries[0].data.name, 'Error')
  assert.ok(entries[0].data.stack)
  assert.equal(entries[1].data.count, 0)
  assert.equal(entries[1].data.self, '[CIRCULAR]')
})

test('default trace filtering and bounded retention prevent high-frequency log accumulation', () => {
  const { logger, outputs } = loadLogger()
  logger.trace('player', 'time update', 0)
  assert.equal(logger.getLogs().length, 0)
  assert.equal(outputs.length, 0)
  for (let index = 0; index < 510; index += 1) logger.info('player', 'event', index)
  assert.equal(logger.getLogs().length, 500)
  assert.equal(logger.getLogs()[0].data, 10)
  const copy = logger.getLogs()
  copy.length = 0
  assert.equal(logger.getLogs().length, 500)
})

test('rejected log IPC is handled once and does not reject a business operation', async () => {
  const { logger, outputs } = loadLogger({ writeLog: () => Promise.reject(new Error('Bridge closed')) })
  assert.doesNotThrow(() => logger.warn('api', 'recoverable'))
  await new Promise(resolve => setImmediate(resolve))
  assert.doesNotThrow(() => logger.warn('api', 'recoverable again'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(outputs.filter(args => args[1] === '日志桥接不可用，继续使用控制台').length, 1)
})
