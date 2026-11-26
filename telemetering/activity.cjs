const fields = new Set([
  'schema_version', 'install_id', 'activity_date', 'revision', 'app_version',
  'os_family', 'os_version_group', 'os_arch', 'app_arch'
])
const architectures = new Set(['x64', 'arm64', 'ia32', 'unknown'])
const families = new Set(['windows', 'macos', 'linux'])
const uuidV4 = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i
const numberPart = '(?:0|[1-9][0-9]*)'
const prereleaseId = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][a-zA-Z0-9-]*)'
const semver = new RegExp(`^${numberPart}\\.${numberPart}\\.${numberPart}(?:-${prereleaseId}(?:\\.${prereleaseId})*)?(?:\\+[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*)?$`)
const dayMs = 86_400_000
const shanghaiDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
})

class RequestError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
  }
}

function validDate(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(value)
  const age = Date.parse(today) - time
  return age >= 0 && age < 30 * dayMs && new Date(time).toISOString().startsWith(value)
}

/** Validates the opt-in daily snapshot before it can enter storage. Errors name only protocol fields. */
function parseReport(input, today) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, 'invalid_report')
  if (Object.keys(input).some(field => !fields.has(field))) throw new RequestError(400, 'unknown_field')
  if (input.schema_version !== 1) throw new RequestError(400, 'invalid_schema_version')
  if (typeof input.install_id !== 'string' || !uuidV4.test(input.install_id)) throw new RequestError(400, 'invalid_install_id')
  if (!validDate(input.activity_date, today)) throw new RequestError(400, 'invalid_activity_date')
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new RequestError(400, 'invalid_revision')
  if (typeof input.app_version !== 'string' || input.app_version.length > 64 || !semver.test(input.app_version)) {
    throw new RequestError(400, 'invalid_app_version')
  }
  if (!families.has(input.os_family)) throw new RequestError(400, 'invalid_os_family')
  const { os_version_group = 'unknown' } = input
  const groupPattern = input.os_family === 'windows' ? /^(10|11|older)$/ : /^[1-9]\d?$/
  if (os_version_group !== 'unknown' && (typeof os_version_group !== 'string' || !groupPattern.test(os_version_group))) {
    throw new RequestError(400, 'invalid_os_version_group')
  }
  if (!architectures.has(input.os_arch) || !architectures.has(input.app_arch)) throw new RequestError(400, 'invalid_architecture')
  return { ...input, install_id: input.install_id.toLowerCase(), os_version_group }
}

module.exports = { parseReport, reportingDay: date => shanghaiDay.format(date), RequestError }
