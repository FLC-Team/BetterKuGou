const http = require('node:http')
const path = require('node:path')
const { mkdirSync } = require('node:fs')
const { timingSafeEqual } = require('node:crypto')
const { openStore } = require('./store.cjs')
const { parseReport, reportingDay, RequestError } = require('./activity.cjs')

const maxBodyBytes = 4096
const intakePath = '/telemetering'
const statsPath = '/telemetering/stats'
const defaultDatabase = path.join(__dirname, 'data', 'activity.sqlite')

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** Enforces the same byte limit for fixed-length and streamed reports before parsing JSON. */
async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'expected_json')
  }
  if (Number(request.headers['content-length']) > maxBodyBytes) throw new RequestError(413, 'report_too_large')
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBodyBytes) throw new RequestError(413, 'report_too_large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new RequestError(400, 'invalid_json')
    throw error
  }
}

/** Creates a standalone receiver. Only the authenticated stats route can read aggregate data. */
function createTelemetryServer({ databasePath = defaultDatabase, statsToken = '', now = () => new Date() } = {}) {
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
  const tokenBytes = Buffer.from(statsToken)
  const store = openStore(databasePath)
  let lastPrunedDay

  function pruneForDay(today) {
    if (today === lastPrunedDay) return
    store.prune(today)
    lastPrunedDay = today
  }

  try {
    pruneForDay(reportingDay(now()))
  } catch (error) {
    store.close()
    throw error
  }
  const timer = setInterval(() => {
    try {
      pruneForDay(reportingDay(now()))
    } catch (error) {
      console.error('Telemetry retention cleanup failed', error)
    }
  }, 60_000).unref()

  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    try {
      const isIntake = request.url === intakePath
      const isStats = request.url === statsPath && tokenBytes.length > 0
      if (!isIntake && !isStats) throw new RequestError(404, 'not_found')
      const method = isIntake ? 'POST' : 'GET'
      if (request.method !== method) {
        response.setHeader('Allow', method)
        throw new RequestError(405, 'method_not_allowed')
      }
      if (isIntake) {
        const input = await readJson(request)
        const today = reportingDay(now())
        const report = parseReport(input, today)
        pruneForDay(today)
        store.record(report, today)
        response.writeHead(204)
        response.end()
        return
      }
      const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization || '')
      const supplied = Buffer.from(bearer?.[1] || '')
      if (supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes)) {
        response.setHeader('WWW-Authenticate', 'Bearer')
        throw new RequestError(401, 'unauthorized')
      }
      const today = reportingDay(now())
      pruneForDay(today)
      sendJson(response, 200, { as_of: today, time_zone: 'Asia/Shanghai', ...store.summary(today) })
    } catch (error) {
      if (request.aborted || response.destroyed) return
      if (error instanceof RequestError) {
        if (error.status === 413) response.setHeader('Connection', 'close')
        sendJson(response, error.status, { error: error.message })
        return
      }
      console.error('Telemetry storage or request processing failed', error)
      sendJson(response, 500, { error: 'internal_error' })
    }
  })
  server.once('close', () => {
    clearInterval(timer)
    store.close()
  })
  return server
}

if (require.main === module) {
  const port = Number(process.env.TELEMETRY_PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TELEMETRY_PORT')
  const server = createTelemetryServer({
    databasePath: process.env.TELEMETRY_DB_PATH || defaultDatabase,
    statsToken: process.env.TELEMETRY_STATS_TOKEN
  })
  server.listen(port, '127.0.0.1', () => console.info(`Telemetry listening on 127.0.0.1:${port}`))
  process.once('SIGTERM', () => server.close())
  process.once('SIGINT', () => server.close())
}

module.exports = { createTelemetryServer }
