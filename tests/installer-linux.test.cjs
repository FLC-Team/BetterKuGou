const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { default: FpmTarget } = require('app-builder-lib/out/targets/FpmTarget')
const config = require('../package.json').build

const root = path.resolve(__dirname, '..')

function temporaryDirectory(t) {
  const tools = path.join(root, '.agent', 'tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'installer-linux-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function installScript(directory, format) {
  const packager = {
    projectDir: root, executableName: 'betterkugou', appInfo: { sanitizedProductName: 'BetterKuGou' },
    platformSpecificBuildOptions: config.linux,
    info: { tempDirManager: { getTempFile: async ({ suffix }) => path.join(directory, `${format}-${suffix}`) } }
  }
  const [install] = await FpmTarget.prototype.createScripts.call({ packager, options: config[format] })
  return fs.readFileSync(install, 'utf8')
}

test('DEB and RPM render the same privileged sandbox configuration through the real builder', async t => {
  const directory = temporaryDirectory(t)
  const deb = await installScript(directory, 'deb')
  assert.equal(deb, await installScript(directory, 'rpm'))
  assert.match(deb, /^app_dir='\/opt\/BetterKuGou'$/m)
  assert.match(deb, /chown root:root "\$app_dir" "\$sandbox"/)
  assert.match(deb, /chmod 4755 "\$sandbox"/)
  assert.doesNotMatch(deb, /--no-sandbox|unshare|chmod 0755 "\$sandbox"|chown -R/)
  assert.ok(!config.rpm.fpm?.some(value => value === '--rpm-autoreq' || value === '--rpm-autoreqprov'))
})

test('Linux install repairs actual sandbox ownership and mode without changing user files', { skip: process.platform !== 'linux' || process.getuid() !== 0 }, async t => {
  const directory = temporaryDirectory(t)
  const app = path.join(directory, 'app')
  const sandbox = path.join(app, 'chrome-sandbox')
  const command = path.join(directory, 'betterkugou')
  const bin = path.join(directory, 'bin')
  const profile = path.join(directory, 'profile')
  fs.mkdirSync(app)
  fs.mkdirSync(bin)
  fs.mkdirSync(profile)
  const personal = path.join(profile, 'settings.json')
  fs.writeFileSync(personal, 'retained')
  fs.chownSync(personal, 1000, 1000)
  fs.writeFileSync(sandbox, 'sandbox fixture', { mode: 0o755 })
  fs.chownSync(sandbox, 1000, 1000)
  fs.chmodSync(app, 0o777)
  const argsFile = path.join(directory, 'alternatives-args')
  fs.writeFileSync(path.join(bin, 'update-alternatives'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$BK_TEST_ALTERNATIVES"\n', { mode: 0o755 })
  for (const name of ['update-mime-database', 'update-desktop-database']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  const script = (await installScript(directory, 'deb'))
    .replace("app_dir='/opt/BetterKuGou'", `app_dir='${app}'`)
    .replace("link='/usr/bin/betterkugou'", `link='${command}'`)
  const execute = () => spawnSync('/bin/sh', ['-c', script, 'probe', 'configure'], {
    env: { ...process.env, HOME: profile, PATH: `${bin}:${process.env.PATH}`, BK_TEST_ALTERNATIVES: argsFile }, encoding: 'utf8'
  })
  for (let index = 0; index < 2; index++) {
    const result = execute()
    assert.equal(result.status, 0, result.stderr)
    const stat = fs.statSync(sandbox)
    assert.equal(stat.uid, 0)
    assert.equal(stat.gid, 0)
    assert.equal(stat.mode & 0o7777, 0o4755)
    assert.equal(fs.statSync(app).mode & 0o022, 0)
    assert.equal(fs.statSync(personal).uid, 1000)
    assert.equal(fs.readFileSync(personal, 'utf8'), 'retained')
  }
  assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), ['--install', command, 'betterkugou', path.join(app, 'betterkugou'), '100'])
  fs.writeFileSync(command, 'unrelated executable')
  assert.notEqual(execute().status, 0)
  assert.equal(fs.readFileSync(command, 'utf8'), 'unrelated executable')
  fs.unlinkSync(sandbox)
  fs.symlinkSync(personal, sandbox)
  assert.notEqual(execute().status, 0)
  assert.equal(fs.statSync(personal).uid, 1000)
})

function loadDependencyHook(execFile) {
  const filename = path.join(root, 'scripts', 'prepare-linux-dependencies.cjs')
  const context = vm.createContext({ module: { exports: {} }, process, require: name => name === 'node:child_process' ? { execFile } : require(name) })
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  return context.module.exports
}

test('afterPack adds actual symbol-version dependencies to the live DEB target and cleans its staging directory', async t => {
  const directory = temporaryDirectory(t)
  const host = path.join(directory, 'resources', 'audio-effects', 'linux-x64', 'bk-audio-host')
  fs.mkdirSync(path.dirname(host), { recursive: true })
  fs.writeFileSync(host, 'fixture')
  const application = path.join(directory, 'betterkugou')
  fs.writeFileSync(application, 'fixture')
  fs.writeFileSync(path.join(directory, 'libvulkan.so.1'), 'fixture')
  const depends = [...config.deb.depends]
  const target = { name: 'deb', options: { depends } }
  let staging
  const hook = loadDependencyHook((command, args, options, callback) => {
    if (command === 'readelf') {
      assert.deepEqual(Array.from(args).slice(0, 2), ['-d', '--version-info'])
      assert.ok([application, host, path.join(directory, 'libvulkan.so.1')].includes(args[2]))
      callback(null, { stdout: args[2].endsWith('.so.1') ? ' 0x000000000000000e (SONAME) Library soname: [libvulkan.so.1]\n' : '', stderr: '' })
      return
    }
    assert.equal(command, 'dpkg-shlibdeps')
    assert.deepEqual(Array.from(args), ['-O', '-xbetterkugou', `-l${directory}`, `-e${application}`, `-e${host}`, `-e${path.join(directory, 'libvulkan.so.1')}`])
    staging = options.cwd
    assert.match(fs.readFileSync(path.join(staging, 'debian', 'control'), 'utf8'), /Package: betterkugou/)
    assert.equal(fs.readFileSync(path.join(staging, 'debian', 'shlibs.local'), 'utf8'), 'libvulkan 1 betterkugou\n')
    callback(null, { stdout: 'shlibs:Depends=libc6 (>= 2.38), libstdc++6 (>= 13.1), libx11-6\n', stderr: '' })
  })
  await hook({ electronPlatformName: 'linux', arch: 1, targets: [target], appOutDir: directory, packager: { executableName: 'betterkugou', info: { appDir: directory } } })
  assert.deepEqual(Array.from(target.options.depends), [...depends, 'libc6 (>= 2.38)', 'libstdc++6 (>= 13.1)', 'libx11-6'])
  assert.equal(fs.existsSync(staging), false)
  assert.deepEqual(depends, config.deb.depends)
})

test('dependency scan refuses missing tooling or incomplete results instead of silently shipping unversioned requirements', async t => {
  const directory = temporaryDirectory(t)
  const host = path.join(directory, 'resources', 'audio-effects', 'linux-arm64', 'bk-audio-host')
  fs.mkdirSync(path.dirname(host), { recursive: true })
  fs.writeFileSync(host, 'fixture')
  fs.writeFileSync(path.join(directory, 'betterkugou'), 'fixture')
  for (const failure of [true, false]) {
    const depends = [...config.deb.depends]
    const target = { name: 'deb', options: { depends } }
    const hook = loadDependencyHook((command, args, options, callback) => {
      if (failure) callback(Object.assign(new Error('spawn dpkg-shlibdeps ENOENT'), { code: 'ENOENT' }))
      else callback(null, { stdout: 'shlibs:Depends=libx11-6\n', stderr: '' })
    })
    await assert.rejects(hook({ electronPlatformName: 'linux', arch: 3, targets: [target], appOutDir: directory, packager: { executableName: 'betterkugou', info: { appDir: directory } } }), failure ? /dpkg-dev/ : /versioned libc6/)
    assert.deepEqual(target.options.depends, depends)
    assert.deepEqual(fs.readdirSync(path.join(directory, '.agent', 'tools')), [])
  }
})

test('RPM derives only actual ELF ABI requirements and excludes bundled libraries and script interpreters', async t => {
  const directory = temporaryDirectory(t)
  const host = path.join(directory, 'resources', 'audio-effects', 'linux-x64', 'bk-audio-host')
  fs.mkdirSync(path.dirname(host), { recursive: true })
  fs.writeFileSync(host, 'fixture')
  fs.writeFileSync(path.join(directory, 'betterkugou'), 'fixture')
  fs.writeFileSync(path.join(directory, 'libffmpeg.so'), 'fixture')
  const backend = path.join(directory, 'resources', 'backend', 'node_modules')
  fs.mkdirSync(backend, { recursive: true })
  fs.writeFileSync(path.join(backend, 'script.js'), '#!/usr/bin/node\n')
  const needs = ' (NEEDED) Shared library: [libc.so.6]\n (NEEDED) Shared library: [libffmpeg.so]\nVersion definition section\n Name: NOT_A_REQUIREMENT\nVersion needs section ".gnu.version_r" contains 2 entries:\n File: libc.so.6 Cnt: 1\n Name: GLIBC_2.38 Flags: none\n File: libffmpeg.so Cnt: 1\n Name: PRIVATE_ABI Flags: none\n'
  const target = { name: 'rpm', options: { depends: [...config.rpm.depends] } }
  const hook = loadDependencyHook((command, args, options, callback) => {
    assert.equal(command, 'readelf')
    assert.deepEqual(Array.from(args).slice(0, 2), ['-d', '--version-info'])
    assert.ok(!args[2].startsWith(backend))
    callback(null, { stdout: args[2].endsWith('libffmpeg.so') ? ' (SONAME) Library soname: [libffmpeg.so]\n' + needs : needs, stderr: '' })
  })
  await hook({ electronPlatformName: 'linux', arch: 1, targets: [target], appOutDir: directory, packager: { executableName: 'betterkugou', info: { appDir: directory } } })
  assert.deepEqual(Array.from(target.options.depends), [...config.rpm.depends, 'libc.so.6()(64bit)', 'libc.so.6(GLIBC_2.38)(64bit)'])
})

test('dependency hook does not invoke Linux tools for Windows, macOS or AppImage', async () => {
  const hook = loadDependencyHook(() => assert.fail('unexpected dpkg-shlibdeps invocation'))
  await hook({ electronPlatformName: 'win32' })
  await hook({ electronPlatformName: 'darwin' })
  await hook({ electronPlatformName: 'linux', targets: [{ name: 'AppImage' }] })
})
