const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { Arch } = require('builder-util/out/arch')

const root = path.join(__dirname, '..')
const fixtureRoot = path.join(root, '.agent', 'tools', 'mock packaging root')
const targets = [['win32', 'ia32'], ['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]

/** Execute the actual builder hook with the installed builder's context shape, without spawning or writing files. */
function hookFixture(platform, controls = {}) {
  const launched = [], copies = [], directories = [], module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/prepare-audio-effects.cjs'), 'utf8'), {
    module, process: { platform, execPath: '/node-executable' },
    require(name) {
      if (name === 'node:path') return path
      if (name === 'node:fs/promises') return { mkdir: async (...args) => directories.push(args), copyFile: async (...args) => copies.push(args) }
      if (name === 'node:child_process') return { spawn(command, args, options) {
        launched.push({ command, args: [...args], options })
        const child = new EventEmitter()
        queueMicrotask(() => controls.error ? child.emit('error', controls.error) : child.emit('exit', controls.exitCode ?? 0))
        return child
      } }
      throw new Error(`Unexpected build hook dependency: ${name}`)
    }
  })
  return { hook: module.exports, launched, copies, directories,
    context: arch => ({ appOutDir: '/output/app', outDir: '/output', arch: Arch[arch], targets: [],
      packager: { info: { appDir: fixtureRoot, projectDir: fixtureRoot } }, electronPlatformName: platform }) }
}

test('beforePack accepts the actual builder context and stages only the requested native target and notices', async () => {
  for (const [platform, arch] of targets) {
    const f = hookFixture(platform)
    await f.hook(f.context(arch))
    assert.equal(f.launched.length, 1)
    assert.equal(f.launched[0].command, '/node-executable')
    assert.deepEqual(f.launched[0].args, [path.join(fixtureRoot, 'scripts/build-audio-effects.cjs'), `--arch=${arch}`])
    assert.equal(f.launched[0].options.cwd, fixtureRoot)
    assert.equal(f.launched[0].options.windowsHide, true)
    assert.equal(f.launched[0].options.shell, undefined, 'paths with spaces must be process arguments rather than shell code')
    const relative = `${platform}-${arch}`
    const binary = platform === 'win32' ? 'bk-audio-host.exe' : 'bk-audio-host'
    assert.deepEqual(f.copies, [binary, 'THIRD_PARTY_NOTICES.txt'].map(name => [
      path.join(fixtureRoot, 'native/audio-effects/bin', relative, name),
      path.join(fixtureRoot, 'native/audio-effects/package', arch, relative, name)
    ]))
  }
})

test('beforePack rejects foreign platforms, unsupported architectures and failed native builds before copying', async () => {
  const f = hookFixture('linux')
  for (const arch of ['universal', 'armv7l']) await assert.rejects(f.hook(f.context(arch)), /Unsupported/)
  await assert.rejects(f.hook({ ...f.context('x64'), arch: 99 }), /Unsupported/)
  await assert.rejects(f.hook({ ...f.context('x64'), electronPlatformName: 'win32' }), /target operating system/)
  assert.equal(f.launched.length, 0)
  for (const controls of [{ exitCode: 7 }, { error: new Error('compiler unavailable') }]) {
    const failed = hookFixture('win32', controls)
    await assert.rejects(failed.hook(failed.context('x64')), /failed \(7\)|compiler unavailable/)
    assert.deepEqual(failed.copies, [])
    assert.deepEqual(failed.directories, [])
  }
})

/** Real build-script planning with all dependency/compiler/process boundaries supplied in memory. */
function planBuild(platform, targetArch, hostArch = targetArch, env = {}, badPin = false) {
  const commands = [], writes = [], reads = []
  const commits = { vst3sdk: '3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96', kissfft: '7bce4153c6bc8aba2db0e889e576f9d00505cbe1', json: '9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03' }
  const execute = () => vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-audio-effects.cjs'), 'utf8'), {
    __dirname: path.join(fixtureRoot, 'scripts'),
    process: { platform, arch: hostArch, env, argv: ['node', '/build-script', `--arch=${targetArch}`] },
    require(name) {
      if (name === 'node:path') return path
      if (name === 'node:fs') return { mkdirSync() {}, existsSync: () => true,
        readFileSync(file) {
          reads.push(file)
          if (path.basename(file) === 'COPYING') return 'Copyright (c) 2003-2010 Mark Borgerding. All rights reserved.'
          if (path.basename(file) === 'BSD-3-Clause') return 'Redistribution and use in source and binary forms are permitted.'
          return `MIT License for ${file}`
        }, writeFileSync: (...args) => writes.push(args) }
      if (name === 'node:child_process') return { spawnSync(command, args, options) {
        commands.push({ command, args: [...args], options })
        return { status: 0, stdout: command === 'git' && args[0] === 'rev-parse'
          ? (badPin ? 'mismatched-commit' : commits[path.basename(options.cwd)]) : '' }
      } }
      throw new Error(`Unexpected build dependency: ${name}`)
    }
  })
  return { execute, commands, writes, reads }
}

test('native build planning maps Windows and macOS targets to compiler architecture flags and bounds Linux cross builds', () => {
  for (const [platform, arch] of targets) {
    const f = planBuild(platform, arch)
    f.execute()
    const configure = f.commands.find(command => command.args.includes('-S'))
    assert.ok(configure)
    assert.equal(configure.options.windowsHide, true)
    if (platform === 'win32') assert.equal(configure.args[configure.args.indexOf('-A') + 1], { ia32: 'Win32', x64: 'x64', arm64: 'ARM64' }[arch])
    if (platform === 'darwin') assert.ok(configure.args.includes(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`))
    assert.ok(configure.args.includes(`-DBK_OUTPUT_DIRECTORY=${path.join(fixtureRoot, 'native/audio-effects/bin', `${platform}-${arch}`)}`))
    assert.deepEqual(f.commands.at(-1).args, ['--self-test'], 'matching-architecture hosts run their native self-test')
  }
  const cross = planBuild('linux', 'arm64', 'x64')
  assert.throws(cross.execute, /matching runner/)
  assert.equal(cross.commands.some(command => command.args.includes('-S')), false)
  const unsupported = planBuild('darwin', 'ia32')
  assert.throws(unsupported.execute, /Unsupported/)
  assert.equal(unsupported.commands.length, 0)
})

test('build rejects mismatched dependency pins before compiling and includes the FFT copyright attribution', () => {
  const bad = planBuild('linux', 'x64', 'x64', {}, true)
  assert.throws(bad.execute, /pinned commit/)
  assert.equal(bad.commands.some(command => command.args.includes('-S')), false)
  const f = planBuild('linux', 'x64')
  f.execute()
  const notices = f.writes.find(([name]) => path.basename(name) === 'THIRD_PARTY_NOTICES.txt')?.[1]
  assert.match(notices, /Mark Borgerding/)
  assert.match(notices, /Redistribution and use/)
  assert.match(notices, /vst3sdk/)
  assert.match(notices, /json/)
})

test('Windows single-architecture generators cannot silently label a host executable as a different target', () => {
  const mismatch = planBuild('win32', 'arm64', 'x64', { BK_NATIVE_GENERATOR: 'Ninja', VSCMD_ARG_TGT_ARCH: 'x64' })
  assert.throws(mismatch.execute, /matching Visual Studio developer environment/)
  assert.equal(mismatch.commands.length, 0)
  const unknown = planBuild('win32', 'ia32', 'x64', { BK_NATIVE_GENERATOR: 'Ninja' })
  assert.throws(unknown.execute, /matching Visual Studio developer environment/)
  const matching = planBuild('win32', 'arm64', 'x64', { BK_NATIVE_GENERATOR: 'Ninja', VSCMD_ARG_TGT_ARCH: 'arm64' })
  matching.execute()
  const configure = matching.commands.find(command => command.args.includes('-S'))
  assert.equal(configure.args[configure.args.indexOf('-G') + 1], 'Ninja')
  assert.equal(configure.args.includes('-A'), false)
  assert.equal(matching.commands.some(command => command.args.includes('--self-test')), false, 'a cross-built executable must not run on the build host')
})

test('extraResources keeps the host, notices and all worker-local modules outside ASAR at the loader paths', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.build.beforePack, 'scripts/prepare-audio-effects.cjs')
  const native = pkg.build.extraResources.find(resource => resource.from === 'native/audio-effects/package/${arch}')
  assert.equal(native?.to, 'audio-effects')
  const worker = pkg.build.extraResources.find(resource => resource.from === 'electron/services' && resource.to === 'audio-effects')
  assert.ok(worker.filter.includes('audioEffectsWorker.cjs'))
  const source = fs.readFileSync(path.join(root, 'electron/services/audioEffectsWorker.cjs'), 'utf8')
  for (const [, relative] of source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
    assert.ok(worker.filter.includes(relative), `Worker dependency ${relative} must be copied beside it`)
  }
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  for (const runner of ['windows-latest', 'ubuntu-24.04', 'macos-latest']) assert.ok(workflow.includes(runner))
  assert.ok(workflow.indexOf('libx11-dev') < workflow.indexOf('npm run build:audio-effects'))
  assert.ok(workflow.indexOf('npm run build:audio-effects') < workflow.indexOf('npm test'))
})
