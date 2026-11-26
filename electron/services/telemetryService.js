const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { setTimeout: wait } = require('node:timers/promises')
const defaultLogger = require('../logger')

const endpoint = 'https://betterkugou.flcserver.cn/telemetering'
const dayMs = 86_400_000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const architectures = ['arm64', 'x64', 'ia32', 'unknown']

// The protocol uses Shanghai civil days. No locale formatting or disk I/O on repeated playback ticks.
function dayNumber(time) { return Math.floor((Number(time) + 8 * 3_600_000) / dayMs) }
function isoDay(number) { return new Date(number * dayMs).toISOString().slice(0, 10) }

/** Rebuild persisted reports from a fixed set of dimensions before exposing or sending them. */
function dimensions(value) {
  if (!value || typeof value.app_version !== 'string' || value.app_version.length > 64 ||
    !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(value.app_version)) return null
  const { app_version, os_family, os_arch, app_arch, os_version_group = 'unknown' } = value
  if (!['windows', 'linux', 'macos'].includes(os_family) || !architectures.includes(os_arch) || !architectures.includes(app_arch)) return null
  const group = os_family === 'windows' ? /^(10|11|older)$/ : /^[1-9]\d?$/
  if (os_version_group !== 'unknown' && (typeof os_version_group !== 'string' || !group.test(os_version_group))) return null
  return { app_version, os_family, os_version_group, os_arch, app_arch }
}

function wireReport(installId, row) {
  return { schema_version: 1, install_id: installId, activity_date: row.date, revision: row.revision, ...row.environment }
}

function fingerprint(profile) {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex')
}

function completed(row, withdrawn = false) {
  // A withdrawn, unacknowledged snapshot keeps only its revision, so fresh consent and activity
  // can create a newer snapshot without replaying any previously collected dimensions.
  const signature = row.pending ? (withdrawn ? null : fingerprint(row.environment)) : row.fingerprint
  return { date: row.date, revision: row.revision, pending: false, fingerprint: signature }
}

/** Serializes local changes independently of HTTP, so opting out never waits for a network timeout. */
function createTelemetryService({
  directory, environment, send = (url, options) => fetch(url, options), now = Date.now, logger = defaultLogger,
  retryBaseMs = 60_000
}) {
  const file = path.join(directory, 'activity.json')
  const tmp = file + '.tmp'
  let state, enabled, markedDay, timer, flight
  let disposed = false
  let pendingPurge = null
  let generation = 0
  let retryDelay = retryBaseMs
  let retryMarkAfter = 0
  let operations = Promise.resolve()

  function enqueue(task) {
    const result = operations.then(task)
    operations = result.catch(error => logger.warn('telemetry', '本机活跃统计操作失败', { code: error.code || error.name }))
    return result
  }

  function keepRow(row, today) {
    const date = Date.parse(row.date) / dayMs
    return date <= today && date > today - 30 && (row.pending || date === today)
  }

  async function load() {
    if (state) return
    let data
    try {
      // An interrupted atomic replace leaves an unpublished snapshot. Never replay it.
      await fs.rm(tmp, { force: true })
      data = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
      if (error instanceof SyntaxError) logger.warn('telemetry', '忽略无法解析的本机活跃统计文件')
      else if (error.code !== 'ENOENT') throw error
    }
    const installId = typeof data?.installId === 'string' && uuid.test(data.installId) ? data.installId.toLowerCase() : null
    const days = []
    if (installId && Array.isArray(data.days)) {
      for (const row of data.days.slice(-30)) {
        const profile = dimensions(row?.environment)
        if (typeof row?.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(row.date) ||
          !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.pending !== 'boolean') continue
        if (row.pending && profile) days.push({ date: row.date, revision: row.revision, environment: profile, pending: true })
        if (!row.pending && (row.fingerprint === null || typeof row.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.fingerprint))) {
          days.push(completed(row))
        }
      }
    }
    state = { installId, days }
  }

  async function save(next) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600 })
      // Windows may briefly lock the destination while scanning a newly published snapshot.
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, file)
          break
        } catch (error) {
          if (process.platform !== 'win32' || attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
          await wait([30, 80, 180][attempt])
        }
      }
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(cleanupError =>
        logger.warn('telemetry', '清理未提交的统计文件失败', { code: cleanupError.code }))
      throw error
    }
    state = next
  }

  async function purgeOutbox() {
    if (!pendingPurge) return
    await load()
    const today = isoDay(dayNumber(now()))
    const days = state.days.filter(row => row.date === today).map(row => completed(row, pendingPurge === 'withdraw'))
    if (days.length !== state.days.length || state.days.some(row => row.pending)) await save({ ...state, days })
    pendingPurge = null
  }

  async function prune() {
    if (pendingPurge) await purgeOutbox()
    await load()
    const today = dayNumber(now())
    const days = state.days.filter(row => keepRow(row, today))
    if (days.length !== state.days.length) await save({ ...state, days })
  }

  function cancelSend() {
    clearTimeout(timer)
    timer = null
    flight?.abort()
    flight = null
    retryDelay = retryBaseMs
  }

  function schedule(delay = 0) {
    if (!enabled || disposed || timer || flight || !state?.days.some(row => row.pending)) return
    timer = setTimeout(() => { timer = null; void flush() }, delay)
    timer.unref()
  }

  /** A response can acknowledge only the exact revision that was sent under the current consent. */
  async function flush() {
    const controller = new AbortController()
    flight = controller
    let delay = 0
    const timeout = setTimeout(() => controller.abort(), 15_000)
    timeout.unref()
    try {
      const report = await enqueue(async () => {
        await prune()
        const row = state.days.find(item => item.pending)
        return row && wireReport(state.installId, row)
      })
      if (!report || flight !== controller || disposed) return
      const response = await send(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'omit', redirect: 'error', signal: controller.signal, body: JSON.stringify(report)
      })
      await response.body?.cancel()
      if (flight !== controller || disposed) return
      // Malformed or unsupported snapshots cannot be repaired by retrying the same bytes.
      if (![204, 400, 413, 415].includes(response.status)) {
        throw Object.assign(new Error('Telemetry HTTP status'), { code: 'HTTP_' + response.status })
      }
      if (response.status !== 204) logger.warn('telemetry', '服务拒绝该份活跃报告', { status: response.status })
      await enqueue(async () => {
        if (flight !== controller) return
        const days = state.days.map(row => row.date === report.activity_date && row.revision === report.revision
          ? completed(row) : row).filter(row => keepRow(row, dayNumber(now())))
        await save({ ...state, days })
      })
      retryDelay = retryBaseMs
    } catch (error) {
      if (flight !== controller) return
      delay = retryDelay
      retryDelay = Math.min(retryDelay * 2, 3_600_000)
      logger.trace('telemetry', '稍后重试活跃报告', { code: error.code || error.name, delay })
    } finally {
      clearTimeout(timeout)
      if (flight === controller) {
        flight = null
        schedule(delay)
      }
    }
  }

  /** Apply queued discard decisions in order, even when a disk error forces the first decision to retry. */
  function discardPending(reason) {
    ++generation
    cancelSend()
    return enqueue(() => {
      pendingPurge ??= reason
      return purgeOutbox()
    })
  }

  function clearPending() {
    return discardPending('clear')
  }

  function configure(value) {
    if (disposed || enabled === (value === true)) return operations
    enabled = value === true
    markedDay = undefined
    retryMarkAfter = 0
    if (!enabled) return discardPending('withdraw')
    return enqueue(async () => { await prune(); schedule() })
  }

  function markActive() {
    if (disposed || !enabled) return operations
    const time = Number(now())
    if (time < retryMarkAfter) return operations
    const day = dayNumber(time)
    if (day === markedDay) return operations
    const ticket = generation
    markedDay = day
    return enqueue(async () => {
      try {
        await prune()
        if (ticket !== generation) return
        const profile = dimensions(environment())
        if (!profile) return
        const date = isoDay(day)
        const previous = state.days.find(row => row.date === date)
        if (previous && completed(previous).fingerprint === fingerprint(profile)) return
        const row = { date, revision: (previous?.revision || 0) + 1, environment: profile, pending: true }
        const days = state.days.filter(item => item.date !== date).concat(row)
        await save({ installId: state.installId || randomUUID(), days })
        schedule()
      } catch (error) {
        if (day === markedDay && ticket === generation) {
          markedDay = undefined
          retryMarkAfter = Number(now()) + retryBaseMs
        }
        throw error
      }
    })
  }

  function getPreview() {
    return enqueue(async () => {
      if (!enabled || disposed) return []
      await prune()
      return state.days.filter(row => row.pending).map(row => wireReport(state.installId, row))
    })
  }

  function dispose() {
    disposed = true
    cancelSend()
    return operations
  }

  return { configure, markActive, getPreview, clearPending, dispose }
}

module.exports = { createTelemetryService }
