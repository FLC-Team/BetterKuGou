const fs = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const { execFile } = require('node:child_process')

const run = promisify(execFile)

/** Translate actual ELF needs into RPM capabilities, excluding libraries shipped in this application. */
function rpmDependencies(objects) {
  const bundled = new Set(objects.map(object => object.stdout.match(/\(SONAME\).*\[([^\]]+)\]/)?.[1]).filter(Boolean))
  const dependencies = new Set()
  for (const { stdout } of objects) {
    for (const match of stdout.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)) {
      if (!bundled.has(match[1])) dependencies.add(`${match[1]}()(64bit)`)
    }
    let inNeeds = false
    let library
    for (const line of stdout.split(/\r?\n/)) {
      if (/^Version .* section/.test(line)) {
        inNeeds = line.startsWith('Version needs section')
        library = undefined
      }
      if (!inNeeds) continue
      const file = line.match(/\bFile:\s+(\S+)/)?.[1]
      if (file) library = file
      const version = line.match(/\bName:\s+(\S+)/)?.[1]
      if (library && version && !bundled.has(library)) dependencies.add(`${library}(${version})(64bit)`)
    }
  }
  return [...dependencies].sort()
}

/** Add actual runtime ABI requirements to DEB/RPM targets before FPM writes package metadata. */
module.exports = async function prepareLinuxDependencies(context) {
  if (context.electronPlatformName !== 'linux') return
  const target = context.targets.find(entry => entry.name === 'deb')
  const rpmTarget = context.targets.find(entry => entry.name === 'rpm')
  if (!target && !rpmTarget) return
  const arch = ['ia32', 'x64', 'armv7l', 'arm64'][context.arch]
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Linux dependency target architecture')
  const root = context.packager?.info?.appDir
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Cannot resolve the application directory for Linux dependency checks')
  const tools = path.join(root, '.agent', 'tools')
  await fs.mkdir(tools, { recursive: true })
  const directory = await fs.mkdtemp(path.join(tools, 'linux-dependencies-'))
  try {
    const debian = path.join(directory, 'debian')
    await fs.mkdir(debian)
    await fs.writeFile(path.join(debian, 'control'), 'Source: betterkugou\nSection: sound\nPriority: optional\nMaintainer: BetterKuGou <placeholder@example.invalid>\n\nPackage: betterkugou\nArchitecture: any\nDescription: BetterKuGou dependency scan\n')
    const host = path.join(context.appOutDir, 'resources', 'audio-effects', `linux-${arch}`, 'bk-audio-host')
    const executable = context.packager.executableName
    if (typeof executable !== 'string' || !executable || path.basename(executable) !== executable) throw new Error('Cannot resolve the Linux application executable')
    const application = path.join(context.appOutDir, executable)
    await Promise.all([fs.access(host), fs.access(application)])
    let output
    let rpmRequires
    try {
      // Versioned libraries shipped with Electron belong to this package, not the OS.
      const localLibraries = []
      const binaries = [application, host]
      for (const entry of await fs.readdir(context.appOutDir, { withFileTypes: true })) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || !/\.so(?:\.|$)/.test(entry.name)) continue
        binaries.push(path.join(context.appOutDir, entry.name))
      }
      const objects = []
      for (const binary of binaries) {
        const object = await run('readelf', ['-d', '--version-info', binary], { maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
        objects.push(object)
        const { stdout } = object
        const soname = stdout.match(/\(SONAME\).*\[([^\]]+)\]/)?.[1]
        const versioned = soname?.match(/^([A-Za-z0-9_+.-]+)\.so\.([0-9][A-Za-z0-9_.-]*)$/)
        if (versioned) localLibraries.push(`${versioned[1]} ${versioned[2]} betterkugou`)
      }
      if (rpmTarget) {
        rpmRequires = rpmDependencies(objects)
        if (!rpmRequires.some(value => /^libc\.so\.6\(GLIBC_[^)]+\)\(64bit\)$/.test(value))) throw new Error('Linux dependency scan did not return versioned RPM libc requirements')
      }
      await fs.writeFile(path.join(debian, 'shlibs.local'), localLibraries.length ? `${[...new Set(localLibraries)].join('\n')}\n` : '')
      if (target) output = await run('dpkg-shlibdeps', ['-O', '-xbetterkugou', `-l${context.appOutDir}`, ...binaries.map(binary => `-e${binary}`)], { cwd: directory, maxBuffer: 1024 * 1024 })
    } catch (cause) {
      throw new Error(`Cannot determine Linux runtime dependency versions. Install binutils${target ? ', dpkg-dev' : ''} and the application's system libraries on the build machine. ${cause.stderr || cause.message}`, { cause })
    }
    const changes = []
    if (target) {
      const line = output.stdout.split(/\r?\n/).find(value => value.startsWith('shlibs:Depends='))
      const dependencies = line?.slice('shlibs:Depends='.length).split(/,\s*/).filter(Boolean)
      if (!dependencies?.some(value => /^libc6\s+\(>=\s+[^)]+\)$/.test(value))) throw new Error('Linux dependency scan did not return a versioned libc6 requirement')
      changes.push([target, dependencies])
    }
    if (rpmTarget) changes.push([rpmTarget, rpmRequires])
    for (const [entry] of changes) {
      if (!Array.isArray(entry.options.depends) || entry.options.depends.length === 0) throw new Error('Linux dependency scan requires the explicit Electron runtime dependencies')
    }
    for (const [entry, dependencies] of changes) entry.options.depends = [...new Set([...entry.options.depends, ...dependencies])]
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
