const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { Arch } = require('builder-util')
const { minimatch } = require('minimatch')
const { load } = require('js-yaml')
const { PlatformPackager } = require('app-builder-lib')
const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher')
const { default: FpmTarget } = require('app-builder-lib/out/targets/FpmTarget')
const { default: AppImageTarget } = require('app-builder-lib/out/targets/AppImageTarget')
const { validateConfiguration } = require('app-builder-lib/out/util/config/config')
const { selectAssets } = require('../electron/services/updateWorker.cjs')
const { validateReleaseAssets, verifyReleaseTag, publishRelease } = require('../scripts/publish-release.cjs')
const manifest = require('../package.json')

const root = path.resolve(__dirname, '..')
const config = manifest.build
const workflow = load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'))
const methods = ['artifactPatternConfig', 'computeArtifactName', 'expandMacro', 'expandArtifactNamePattern']

function makePackager(platform, onArtifact) {
  return {
    config,
    appInfo: { ...manifest, productName: config.productName, sanitizedProductName: config.productName },
    platform: { buildConfigurationKey: platform },
    platformSpecificBuildOptions: config[platform],
    info: { callArtifactBuildStarted: onArtifact },
    ...Object.fromEntries(methods.map(name => [name, PlatformPackager.prototype[name]]))
  }
}

/** Stop the real builder target immediately after it calculates the artifact name, before any file writes. */
async function targetFilename(target, arch) {
  let filename
  const stopped = new Error('artifact-name-only')
  const packager = makePackager(target === 'dmg' ? 'mac' : 'linux', async event => {
    filename = path.basename(event.file)
    throw stopped
  })
  if (target === 'dmg' && process.platform !== 'darwin') {
    // The macOS builder target loads platform-specific dmg-license on import.
    return packager.expandArtifactNamePattern(config.dmg, target, arch, '${productName}-${version}-${arch}.${ext}', true)
  }
  const prototype = target === 'dmg' ? require('dmg-builder/out/dmg').DmgTarget.prototype
    : target === 'AppImage' ? AppImageTarget.prototype : FpmTarget.prototype
  const context = { name: target, packager, options: config[target] || packager.platformSpecificBuildOptions, outDir: 'release' }
  await assert.rejects(prototype.build.call(context, 'unused-app-directory', arch), error => error === stopped)
  return filename
}

function testDirectory(t) {
  const tools = path.join(root, '.agent/tools')
  fs.mkdirSync(tools, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tools, 'installer-packaging-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), tools)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

async function stageInstallerFiles(directory) {
  const groups = {
    windows: [makePackager('win').expandArtifactNamePattern(config.nsis, 'exe', Arch.x64)],
    linux: await Promise.all(['AppImage', 'deb', 'rpm'].map(format => targetFilename(format, Arch.x64))),
    macos: await Promise.all([Arch.x64, Arch.arm64].map(arch => targetFilename('dmg', arch)))
  }
  return Object.entries(groups).flatMap(([platform, files]) => {
    const folder = path.join(directory, `BetterKuGou-${platform}`)
    fs.mkdirSync(folder)
    return files.map(name => {
      const file = path.join(folder, name)
      fs.writeFileSync(file, 'fixture')
      return file
    })
  })
}

test('release waits for every matrix build and validates all real installer names and the package tag', async t => {
  const { build, release } = workflow.jobs
  const upload = build.steps.find(step => step.name === 'Upload Build Artifacts')
  assert.equal(release.needs, 'build')
  assert.equal(workflow.permissions.contents, 'read')
  assert.equal(release.permissions.contents, 'write')
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.equal(release.if, "startsWith(github.ref, 'refs/tags/v')")
  const publish = release.steps.find(step => step.name === 'Publish complete release').run
  assert.match(publish, /publish-release\.cjs --publish "\$GITHUB_REF_NAME" release-assets/)
  assert.doesNotThrow(() => verifyReleaseTag(`v${manifest.version}`))
  assert.throws(() => verifyReleaseTag(`v${manifest.version}-mismatched`), /不一致/)

  const uploadPatterns = upload.with.path.trim().split(/\r?\n/)
  for (const arch of [Arch.x64, Arch.arm64]) {
    for (const format of ['deb', 'rpm', 'AppImage']) {
      const name = await targetFilename(format, arch)
      assert.ok(uploadPatterns.some(pattern => minimatch(`release/${name}`, pattern)), `workflow uploads ${name}`)
      assert.equal(selectAssets([{ id: 1, name, format }], { platform: 'linux', arch: Arch[arch], releaseVersion: manifest.version }).length, 1, `updater accepts ${name}`)
    }
  }
  const packager = makePackager('win')
  const names = [Arch.x64, Arch.ia32, Arch.arm64].map(arch => packager.expandArtifactNamePattern(config.nsis, 'exe', arch))
  assert.equal(new Set(names).size, 1, 'Windows architectures share one installer')
  const directory = testDirectory(t)
  const staged = await stageInstallerFiles(directory)
  for (const file of staged) assert.ok(uploadPatterns.some(pattern => minimatch(`release/${path.basename(file)}`, pattern)))
  assert.deepEqual(validateReleaseAssets(directory), staged)

  const missing = staged.at(-1)
  fs.unlinkSync(missing)
  assert.throws(() => validateReleaseAssets(directory), /macos 安装包不完整/)
  fs.writeFileSync(missing, '')
  assert.throws(() => validateReleaseAssets(directory), /安装包为空/)
  fs.writeFileSync(missing, 'fixture')
  const unexpected = path.join(path.dirname(missing), 'BetterKuGou-foreign.dmg')
  fs.writeFileSync(unexpected, 'fixture')
  assert.throws(() => validateReleaseAssets(directory), /存在多余文件/)

  for (const name of ['BetterKuGou-portable.exe', 'BetterKuGou.zip', 'builder-debug.yml']) {
    assert.equal(uploadPatterns.some(pattern => minimatch(`release/${name}`, pattern)), false)
  }
})

test('publication resumes partial drafts, verifies uploads and leaves published releases intact', async t => {
  const directory = testDirectory(t)
  const files = await stageInstallerFiles(directory)
  const tag = `v${manifest.version}`
  const prerelease = manifest.version.split('+', 1)[0].includes('-')
  const repo = 'FLC-Team/BetterKuGou'
  const input = { tag, directory, repository: repo }
  const uploaded = file => ({
    name: path.basename(file), state: 'uploaded', size: fs.statSync(file).size,
    digest: `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
  })
  const writes = []
  let release
  let interruptUpload = true
  let dropLastUpload = false
  const runGh = args => {
    if (args[0] === 'api') return release ? JSON.stringify(release) : ''
    const [group, command, ref, repoFlag, repository, ...flags] = args
    assert.deepEqual([group, ref, repoFlag, repository], ['release', tag, '--repo', repo])
    writes.push({ command, flags })
    if (command === 'create') {
      assert.ok(flags.includes('--draft') && flags.includes('--verify-tag') && flags.includes('--latest=false'))
      release = { tag_name: tag, draft: true, prerelease, assets: [] }
    } else if (command === 'upload') {
      assert.equal(release.draft, true)
      assert.ok(flags.every(file => files.includes(file) && !release.assets.some(asset => asset.name === path.basename(file))))
      if (interruptUpload) {
        release.assets.push(uploaded(flags[0]))
        throw new Error('interrupted fixture upload')
      }
      release.assets.push(...(dropLastUpload ? flags.slice(0, -1) : flags).map(uploaded))
    } else if (command === 'edit') {
      assert.equal(release.draft, true)
      assert.equal(release.assets.length, files.length)
      assert.ok(flags.includes('--draft=false') && flags.includes(`--latest=${!prerelease}`))
      release.draft = false
    } else assert.fail(`Unexpected GitHub command ${command}`)
    return ''
  }

  await assert.rejects(publishRelease(input, runGh), /interrupted fixture upload/)
  assert.equal(release.draft, true)
  assert.equal(release.assets.length, 1)
  assert.deepEqual(writes.map(write => write.command), ['create', 'upload'])

  writes.length = 0
  interruptUpload = false
  dropLastUpload = true
  await assert.rejects(publishRelease(input, runGh), /尚未收齐/)
  assert.equal(release.draft, true)
  assert.deepEqual(writes, [{ command: 'upload', flags: files.slice(1) }])

  writes.length = 0
  const firstAsset = release.assets[0]
  release.assets[0] = { ...firstAsset, digest: `sha256:${'0'.repeat(64)}` }
  await assert.rejects(publishRelease(input, runGh), /草稿安装包与本轮构建内容不一致/)
  assert.deepEqual(writes, [])
  release.assets[0] = firstAsset

  dropLastUpload = false
  await publishRelease(input, runGh)
  assert.deepEqual(writes.map(write => write.command), ['upload', 'edit'])
  assert.deepEqual(writes[0].flags, [files.at(-1)])
  assert.equal(release.draft, false)

  writes.length = 0
  fs.writeFileSync(files[0], 'different rebuild of the already published tag')
  await publishRelease(input, runGh)
  assert.deepEqual(writes, [])
  release.assets.pop()
  await assert.rejects(publishRelease(input, runGh), /已公开，但安装包或发布类型不完整/)
  assert.deepEqual(writes, [])
})

test('actual backend resource copy retains runtime files and excludes local settings and credentials', async t => {
  const directory = testDirectory(t)
  const source = path.join(directory, 'source')
  const output = path.join(directory, 'output')
  const runtime = ['app.js', 'index.js', 'main.js', 'server.js', 'package.json', 'LICENSE', 'module/audio.js',
    'util/config.json', 'util/util.js', 'public/index.html', 'node_modules/express/index.js']
  const local = ['.env', '.env.local', '.npmrc', 'token.pem', 'notes.txt', 'module/.env', 'util/local.json',
    'public/secret.p12', 'node_modules/express/.env.local', 'node_modules/express/private.key']
  for (const name of [...runtime, ...local]) {
    const file = path.join(source, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'fixture')
  }
  const resource = config.extraResources.find(entry => entry.to === 'backend')
  await copyFiles([new FileMatcher(source, output, value => value, resource.filter)])
  for (const name of runtime) assert.ok(fs.existsSync(path.join(output, name)), name)
  for (const name of local) assert.equal(fs.existsSync(path.join(output, name)), false, name)
})

async function renderLinuxRemove(directory, format) {
  const packager = makePackager('linux')
  packager.projectDir = root
  packager.executableName = manifest.name
  packager.info.tempDirManager = {
    getTempFile: async ({ suffix }) => path.join(directory, `${format}-${suffix}`)
  }
  const [, remove] = await FpmTarget.prototype.createScripts.call({ packager, options: config[format] })
  return fs.readFileSync(remove, 'utf8')
}

test('the real builder configures both DEB and RPM to remove the registered program target', async t => {
  const directory = testDirectory(t)
  const deb = await renderLinuxRemove(directory, 'deb')
  const rpm = await renderLinuxRemove(directory, 'rpm')
  assert.equal(deb, rpm)
  assert.match(deb, /^target='\/opt\/BetterKuGou\/betterkugou'$/m)
  assert.match(deb, /update-alternatives --remove 'betterkugou' "\$target"/)
})

test('Linux removal cleans the registered target and its fallback only on final removal', { skip: process.platform === 'win32' }, async t => {
  const directory = testDirectory(t)
  const command = path.join(directory, 'betterkugou')
  const target = '/opt/BetterKuGou/betterkugou'
  const template = (await renderLinuxRemove(directory, 'deb')).replace('/usr/bin/betterkugou', './betterkugou')
  fs.writeFileSync(path.join(directory, 'update-alternatives'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` }
  const run = argument => {
    const result = spawnSync('sh', ['-c', template, 'probe', argument], { cwd: directory, encoding: 'utf8', env })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  fs.symlinkSync(target, command)
  for (const argument of ['upgrade', '1', 'abort-upgrade']) {
    assert.equal(run(argument), '')
    assert.equal(fs.readlinkSync(command), target)
  }
  for (const argument of ['remove', 'purge', '0']) {
    assert.deepEqual(run(argument).trim().split('\n'), ['--remove', 'betterkugou', target])
    assert.throws(() => fs.lstatSync(command), { code: 'ENOENT' })
    if (argument !== '0') fs.symlinkSync(target, command)
  }
  fs.symlinkSync('/unrelated/betterkugou', command)
  run('remove')
  assert.equal(fs.readlinkSync(command), '/unrelated/betterkugou')
})

test('electron-builder accepts installer configuration and static DMG assets have exact 1x/2x dimensions', async () => {
  await validateConfiguration(config, { isEnabled: false })
  const background = path.resolve(root, config.dmg.background)
  const pngSize = filename => {
    const bytes = fs.readFileSync(filename)
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  assert.deepEqual(pngSize(background), [config.dmg.window.width, config.dmg.window.height])
  assert.deepEqual(pngSize(background.replace(/\.png$/, '@2x.png')), [1280, 840])
})
