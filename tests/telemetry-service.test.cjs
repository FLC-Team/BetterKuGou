const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')
const { createTelemetryService } = require('../electron/services/telemetryService')
const { parseReport } = require('../telemetering/activity.cjs')

const environment = {
  app_version: '1.0.0', os_family: 'windows', os_version_group: '11',
  os_arch: 'arm64', app_arch: 'x64'
}
const quiet = { trace() {}, warn() {} }

async function until(condition) {
  const deadline = Date.now() + 3_000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for the telemetry service')
    await wait(5)
  }
}

async function fixture(t) {
  const parent = path.resolve(__dirname, '../.agent/tools')
  await fs.mkdir(parent, { recursive: true })
  const dir = await fs.mkdtemp(path.join(parent, 'telemetry-client-'))
  const directory = path.join(dir, 'private')
  const services = []
  const context = {
    clock: new Date('2026-11-22T15:59:59.999Z'),
    create(options = {}) {
      const service = createTelemetryService({
        directory, now: () => context.clock, environment: () => environment, logger: quiet,
        send: () => { throw new Error('Offline test transport') }, ...options
      })
      services.push(service)
      return service
    },
    directory
  }
  t.after(async () => {
    await Promise.all(services.map(service => service.dispose()))
    await fs.rm(dir, { recursive: true, force: true })
  })
  return context
}

test('opt-in and confirmed activity are both required; repeated playback ticks and restarts keep one daily report', async t => {
  const f = await fixture(t)
  const requests = []
  const send = async (url, options) => {
    requests.push({ url, options, report: JSON.parse(options.body) })
    return { status: 204 }
  }
  const service = f.create({ send, environment: () => ({ ...environment, song: 'private', account: 'private' }) })
  await service.configure(false)
  await service.markActive()
  assert.deepEqual(await service.getPreview(), [])
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' })
  await service.configure(true)
  assert.deepEqual(await service.getPreview(), [])
  assert.equal(requests.length, 0)
  await Promise.all(Array.from({ length: 100 }, () => service.markActive()))
  await until(async () => requests.length === 1 && (await service.getPreview()).length === 0)
  const { url, options, report } = requests[0]
  assert.equal(url, 'https://betterkugou.flcserver.cn/telemetering')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.equal(options.credentials, 'omit')
  assert.deepEqual(options.headers, { 'Content-Type': 'application/json' })
  assert.deepEqual(report, parseReport(report, '2026-11-22'))
  assert.equal(report.revision, 1)
  assert.equal(report.activity_date, '2026-11-22')
  await service.dispose()

  const resumed = f.create({ send })
  await resumed.configure(true)
  await resumed.markActive()
  f.clock = new Date('2026-11-22T16:00:00.000Z')
  await resumed.markActive()
  await until(async () => requests.length === 2 && (await resumed.getPreview()).length === 0)
  assert.equal(requests[1].report.activity_date, '2026-11-23')
  assert.equal(requests[1].report.revision, 1)
  assert.equal(requests[1].report.install_id, report.install_id)
})

test('offline snapshots survive restart, expire after 30 Shanghai dates and increment revision on upgrade or rollback', async t => {
  const f = await fixture(t)
  const offline = f.create()
  await offline.configure(true)
  await offline.markActive()
  const [first] = await offline.getPreview()
  await offline.dispose()

  const upgrade = f.create({ environment: () => ({ ...environment, app_version: '2.0.0', app_arch: 'arm64' }) })
  await upgrade.configure(true)
  await upgrade.markActive()
  const [second] = await upgrade.getPreview()
  assert.deepEqual(second, { ...first, app_version: '2.0.0', app_arch: 'arm64', revision: 2 })
  await upgrade.dispose()
  const rollback = f.create()
  await rollback.configure(true)
  await rollback.markActive()
  assert.deepEqual(await rollback.getPreview(), [{ ...first, revision: 3 }])
  f.clock = new Date('2026-12-21T10:00:00Z')
  await rollback.markActive()
  assert.deepEqual((await rollback.getPreview()).map(row => row.activity_date), ['2026-11-22', '2026-12-21'])
  f.clock = new Date('2026-12-22T10:00:00Z')
  await rollback.markActive()
  const current = await rollback.getPreview()
  assert.deepEqual(current.map(row => row.activity_date), ['2026-12-21', '2026-12-22'])
  assert.ok(current.every(row => row.install_id === first.install_id && row.revision === 1))
})

test('revoking consent aborts in-flight sends, purges pending data and isolates a late acknowledgement after re-enabling', async t => {
  const f = await fixture(t)
  const sends = []
  const service = f.create({ send: (_, options) => new Promise(resolve => sends.push({ options, resolve })) })
  await service.configure(true)
  await service.markActive()
  await until(() => sends.length === 1)
  const id = JSON.parse(sends[0].options.body).install_id
  const closing = service.configure(false)
  assert.equal(sends[0].options.signal.aborted, true)
  f.clock = new Date('2026-11-23T10:00:00Z')
  const opening = service.configure(true)
  const mark = service.markActive()
  await Promise.all([closing, opening, mark])
  await until(() => sends.length === 2)
  sends[0].resolve({ status: 204 })
  const pending = await service.getPreview()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].activity_date, '2026-11-23')
  assert.equal(pending[0].install_id, id)
  await service.clearPending()
  assert.equal(sends[1].options.signal.aborted, true)
  const disk = await fs.readFile(path.join(f.directory, 'activity.json'), 'utf8')
  assert.ok(!disk.includes('app_version') && !disk.includes('os_arch'))
  sends[1].resolve({ status: 204 })
  await service.markActive()
  assert.deepEqual(await service.getPreview(), [])
  await service.dispose()
  const reopened = f.create()
  await reopened.configure(true)
  await reopened.markActive()
  assert.deepEqual(await reopened.getPreview(), [])
})

test('network errors and throttling retry the original report without another active event', async t => {
  const f = await fixture(t)
  const sent = []
  const service = f.create({
    retryBaseMs: 10,
    send: async (_, options) => {
      sent.push(options.body)
      if (sent.length === 1) throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' })
      return { status: sent.length === 2 ? 429 : 204 }
    }
  })
  await service.configure(true)
  await service.markActive()
  await until(async () => sent.length >= 3 && (await service.getPreview()).length === 0)
  assert.deepEqual(sent, [sent[0], sent[0], sent[0]])
})

test('consent withdrawal discards an unsent report until a fresh same-day activity after restart', async t => {
  const f = await fixture(t)
  const original = f.create()
  await original.configure(true)
  await original.markActive()
  const [first] = await original.getPreview()
  await original.configure(false)
  await original.dispose()

  const sends = []
  const next = f.create({ send: async (_, options) => { sends.push(JSON.parse(options.body)); return { status: 204 } } })
  await next.configure(false)
  await next.configure(true)
  await wait(20)
  assert.deepEqual(sends, [])
  assert.deepEqual(await next.getPreview(), [])
  await next.markActive()
  await until(async () => sends.length === 1 && (await next.getPreview()).length === 0)
  assert.deepEqual(sends[0], { ...first, revision: 2 })
  await next.configure(false)
  await next.configure(true)
  await next.markActive()
  assert.deepEqual(await next.getPreview(), [])
  await wait(20)
  assert.equal(sends.length, 1, 'an acknowledged same-day report stays deduplicated through opt-outs')
})

test('an acknowledgement for a restored older revision leaves the just-used new version queued', async t => {
  const f = await fixture(t)
  const first = f.create()
  await first.configure(true)
  await first.markActive()
  await first.dispose()
  const attempts = []
  const upgraded = f.create({
    environment: () => ({ ...environment, app_version: '2.0.0' }),
    send: (_, options) => new Promise(resolve => attempts.push({ report: JSON.parse(options.body), resolve }))
  })
  await upgraded.configure(true)
  await until(() => attempts.length === 1)
  await upgraded.markActive()
  attempts[0].resolve({ status: 204 })
  await until(() => attempts.length === 2)
  assert.equal(attempts[0].report.revision, 1)
  assert.equal(attempts[1].report.revision, 2)
  assert.deepEqual(await upgraded.getPreview(), [attempts[1].report])
  attempts[1].resolve({ status: 204 })
  await until(async () => (await upgraded.getPreview()).length === 0)
})

test('a failed outbox cleanup must finish before a later opt-in can send', async t => {
  const f = await fixture(t)
  const first = f.create()
  await first.configure(true)
  await first.markActive()
  await first.dispose()

  const stagingPath = path.join(f.directory, 'activity.json.tmp')
  const sends = []
  const service = f.create({ send: async (_, options) => { sends.push(options.body); return { status: 503 } } })
  await service.configure(true)
  await fs.mkdir(stagingPath)
  await assert.rejects(service.configure(false))
  const sentBeforeOptIn = sends.length
  await assert.rejects(service.configure(true))
  await fs.rmdir(stagingPath)
  assert.deepEqual(await service.getPreview(), [])
  await wait(20)
  assert.equal(sends.length, sentBeforeOptIn)
  await service.markActive()
  await until(() => sends.length > sentBeforeOptIn)
  assert.equal(JSON.parse(sends.at(-1)).revision, 2)
})
