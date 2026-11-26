const os = require('node:os')

function architecture(value) {
  const name = String(value ?? '').toLowerCase()
  if (['x64', 'x86_64', 'amd64'].includes(name)) return 'x64'
  if (['arm64', 'aarch64'].includes(name)) return 'arm64'
  if (['ia32', 'x86'].includes(name) || /^i[3-6]86$/.test(name)) return 'ia32'
  return 'unknown'
}

/** Windows 10 and 11 share NT 10.0. macOS reports its product version separately from Darwin. */
function versionGroup(runtime, system) {
  if (runtime.platform === 'win32') {
    if (/server/i.test(system.version())) return 'unknown'
    const release = /^(\d+)\.(\d+)\.(\d+)$/.exec(system.release())
    if (!release) return 'unknown'
    if (Number(release[1]) < 10) return 'older'
    if (release[1] !== '10' || release[2] !== '0') return 'unknown'
    return Number(release[3]) >= 22000 ? '11' : '10'
  }
  const release = runtime.platform === 'darwin' ? runtime.getSystemVersion?.() : system.release()
  return /^([1-9]\d?)(?:\.|$)/.exec(release)?.[1] || 'unknown'
}

/** Collects only the receiver's coarse environment fields, including native architecture under emulation. */
function getTelemetryEnvironment(app, runtime = process, system = os) {
  const os_family = { win32: 'windows', darwin: 'macos', linux: 'linux' }[runtime.platform]
  if (!os_family) return null
  let os_arch
  if (os_family !== 'linux' && app.runningUnderARM64Translation === true) {
    os_arch = 'arm64'
  } else if (os_family === 'windows' && runtime.arch === 'ia32' && runtime.env?.PROCESSOR_ARCHITEW6432) {
    // WOW64 exposes the native architecture here even when os.machine() describes the x86 view.
    os_arch = architecture(runtime.env.PROCESSOR_ARCHITEW6432)
  } else {
    os_arch = architecture(system.machine?.())
  }
  return {
    app_version: app.getVersion(),
    os_family,
    os_version_group: versionGroup(runtime, system),
    os_arch,
    app_arch: architecture(runtime.arch)
  }
}

module.exports = { getTelemetryEnvironment }
