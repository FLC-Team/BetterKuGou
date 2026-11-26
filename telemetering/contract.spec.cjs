const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const path = require('node:path')
const { once } = require('node:events')
const { createTelemetryServer } = require('./server.cjs')

const statsToken = randomUUID()

function activity(installId, overrides = {}) {
  return {
    schema_version: 1, install_id: installId, activity_date: '2026-07-01', revision: 1,
    app_version: '1.0.0', os_family: 'windows', os_version_group: '11', os_arch: 'arm64', app_arch: 'x64',
    ...overrides
  }
}

// A fresh database per test lets restarts reuse the actual on-disk data and clock.
async function fixture(t, token = statsToken) {
  const workspace = path.resolve(__dirname, '../.agent/tools')
  mkdirSync(workspace, { recursive: true })
  const directory = mkdtempSync(path.join(workspace, 'telemetry-contract-'))
  const databasePath = path.join(directory, 'activity.sqlite')
  let instant = new Date('2026-07-01T00:00:00+08:00')
  let server
  let endpoint

  async function start() {
    server = createTelemetryServer({ databasePath, statsToken: token, now: () => instant })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    endpoint = `http://127.0.0.1:${server.address().port}/telemetering`
  }
  async function stop() {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }
  t.after(async () => {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  })
  await start()

  async function post(body, type = 'application/json') {
    return fetch(endpoint, { method: 'POST', headers: { 'Content-Type': type }, body, duplex: 'half' })
  }
  async function accept(report) {
    const response = await post(JSON.stringify(report))
    assert.equal(response.status, 204, await response.text())
  }
  function query(authorization) {
    return fetch(endpoint + '/stats', { headers: authorization ? { Authorization: authorization } : {} })
  }
  async function summary() {
    const response = await query(`Bearer ${statsToken}`)
    assert.equal(response.status, 200)
    return response.json()
  }
  return {
    post, accept, query, summary,
    setClock(value) { instant = new Date(value) },
    async restart() {
      await stop()
      await start()
    }
  }
}

test('active installs survive restarts and follow the latest revision even across an upgrade and rollback', async t => {
  const api = await fixture(t)
  const id = randomUUID()
  const first = activity(id)
  const upgraded = activity(id, { revision: 2, app_version: '2.0.0', app_arch: 'arm64' })
  await api.accept({ ...first, install_id: first.install_id.toUpperCase() })
  await Promise.all([api.accept(upgraded), api.accept(first), api.accept(upgraded)])
  await api.restart()
  await api.accept(first)

  const stats = await api.summary()
  for (const window of [stats.today, stats.last_30_days]) {
    assert.equal(window.active_installs, 1)
    assert.deepEqual(window.versions, [{ app_version: '2.0.0', count: 1 }])
    assert.deepEqual(window.systems, [{ os_family: 'windows', os_version_group: '11', count: 1 }])
    assert.deepEqual(window.architectures, [{ os_family: 'windows', os_arch: 'arm64', app_arch: 'arm64', count: 1 }])
  }
  assert.ok(!JSON.stringify(stats).includes(id))

  await api.accept(activity(id, { revision: 3 }))
  const rollback = (await api.summary()).today
  assert.equal(rollback.active_installs, 1)
  assert.deepEqual(rollback.versions, [{ app_version: '1.0.0', count: 1 }])
  assert.deepEqual(rollback.architectures, [{ os_family: 'windows', os_arch: 'arm64', app_arch: 'x64', count: 1 }])
})

test('Shanghai midnight shifts the 30-day window and each install contributes its latest environment once', async t => {
  const api = await fixture(t)
  api.setClock('2026-06-30T15:59:59.999Z')
  const id = randomUUID()
  const expired = activity(randomUUID(), { activity_date: '2026-06-01' })
  const edge = activity(randomUUID(), { activity_date: '2026-06-02', os_family: 'linux', os_version_group: 'unknown' })
  const yesterday = activity(id, { activity_date: '2026-06-30', revision: 9 })
  const latest = activity(id, { app_version: '2.0.0', os_family: 'macos', os_version_group: '15', app_arch: 'arm64' })
  for (const report of [expired, edge, yesterday]) await api.accept(report)
  assert.equal((await api.post(JSON.stringify(latest))).status, 400)
  const before = await api.summary()
  assert.equal(before.today.active_installs, 1)
  assert.equal(before.last_30_days.active_installs, 3)

  api.setClock('2026-06-30T16:00:00.000Z')
  assert.equal((await api.summary()).today.active_installs, 0)
  await api.accept(latest)
  await api.accept({ ...yesterday, revision: 10 })
  const stats = await api.summary()
  assert.equal(stats.today.active_installs, 1)
  assert.equal(stats.daily_active.length, 30)
  assert.deepEqual(stats.daily_active[0], { activity_date: '2026-06-02', active_installs: 1 })
  assert.deepEqual(stats.daily_active[1], { activity_date: '2026-06-03', active_installs: 0 })
  assert.deepEqual(stats.daily_active.slice(-2), [
    { activity_date: '2026-06-30', active_installs: 1 },
    { activity_date: '2026-07-01', active_installs: 1 }
  ])
  assert.deepEqual(stats.today.versions, [{ app_version: '2.0.0', count: 1 }])
  assert.equal(stats.last_30_days.active_installs, 2)
  assert.deepEqual(Object.fromEntries(stats.last_30_days.versions.map(row => [row.app_version, row.count])), { '1.0.0': 1, '2.0.0': 1 })
  assert.deepEqual(stats.last_30_days.systems.map(row => row.os_family).sort(), ['linux', 'macos'])
  for (const name of ['versions', 'systems', 'architectures']) {
    assert.equal(stats.last_30_days[name].reduce((total, row) => total + row.count, 0), 2, name)
  }
  assert.equal((await api.post(JSON.stringify(expired))).status, 400)
})

test('intake validates the bounded schema before storing and preserves unknown OS version groups', async t => {
  const api = await fixture(t)
  const base = activity(randomUUID())
  for (const invalid of [
    { schema_version: 2 }, { install_id: 'placeholder-account' }, { activity_date: '2026-06-31' },
    { revision: 0 }, { revision: 1.5 }, { app_version: 'some text' }, { os_family: 'other' },
    { os_family: 'windows', os_version_group: '12' }, { os_family: 'macos', os_version_group: '15.2' },
    { os_family: 'linux', os_version_group: '6.12.29' },
    { os_arch: 'some text' }, { app_arch: 64 }, { song_title: 'placeholder song' }, { account_id: 'placeholder' }
  ]) {
    assert.equal((await api.post(JSON.stringify({ ...base, ...invalid }))).status, 400, Object.keys(invalid)[0])
  }
  assert.equal((await api.post('{')).status, 400)
  assert.equal((await api.post('[]')).status, 400)
  assert.equal((await api.post(JSON.stringify(base), 'text/plain')).status, 415)
  assert.equal((await api.post(' '.repeat(4097))).status, 413)
  async function* oversizedStream() {
    yield Buffer.alloc(4096, ' ')
    yield Buffer.from(' ')
  }
  assert.equal((await api.post(oversizedStream())).status, 413)
  assert.equal((await api.summary()).last_30_days.active_installs, 0)

  const { os_version_group, ...withoutGroup } = base
  await api.accept(withoutGroup)
  assert.deepEqual((await api.summary()).today.systems, [{ os_family: 'windows', os_version_group: 'unknown', count: 1 }])
  await api.accept(activity(randomUUID(), { os_version_group: 'older' }))
  await api.accept(activity(randomUUID(), { os_family: 'linux', os_version_group: '6' }))
  assert.deepEqual((await api.summary()).today.systems.map(row => row.os_version_group).sort(), ['6', 'older', 'unknown'])
})

test('aggregate queries require the configured bearer token and stay private when it is unset', async t => {
  const api = await fixture(t)
  assert.equal((await api.query()).status, 401)
  assert.equal((await api.query('Bearer incorrect-placeholder')).status, 401)
  assert.equal((await api.summary()).today.active_installs, 0)

  const unconfigured = await fixture(t, '')
  await unconfigured.accept(activity(randomUUID()))
  for (const value of [undefined, `Bearer ${statsToken}`]) {
    const response = await unconfigured.query(value)
    assert.equal(response.status, 404)
    assert.ok(!(await response.text()).includes('active_installs'))
  }
})
