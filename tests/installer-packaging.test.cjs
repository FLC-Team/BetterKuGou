const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Arch } = require('builder-util')
const { minimatch } = require('minimatch')
const { PlatformPackager } = require('app-builder-lib')
const { default: FpmTarget } = require('app-builder-lib/out/targets/FpmTarget')
const { default: AppImageTarget } = require('app-builder-lib/out/targets/AppImageTarget')
const { validateConfiguration } = require('app-builder-lib/out/util/config/config')
const { selectAssets } = require('../electron/services/updateWorker.cjs')
const manifest = require('../package.json')

const root = path.resolve(__dirname, '..')
const config = manifest.build
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
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
  const packager = makePackager('linux', async event => {
    filename = path.basename(event.file)
    throw stopped
  })
  const prototype = target === 'AppImage' ? AppImageTarget.prototype : FpmTarget.prototype
  const context = { name: target, packager, options: config[target] || packager.platformSpecificBuildOptions, outDir: 'release' }
  await assert.rejects(prototype.build.call(context, 'unused-app-directory', arch), error => error === stopped)
  return filename
}

function uploadPatterns(name) {
  const section = workflow.split(`- name: ${name}`)[1]
  assert.ok(section, `${name} workflow step exists`)
  const step = section.split(/\r?\n\s+- name: /)[0]
  return [...step.matchAll(/^\s+(release\/[^\r\n]+)$/gm)].map(match => match[1])
}

test('both upload steps publish real default Linux names and the universal Windows installer', async () => {
  const releasePatterns = uploadPatterns('Upload Release Assets')
  const buildPatterns = uploadPatterns('Upload Build Artifacts')
  for (const arch of [Arch.x64, Arch.arm64]) {
    for (const format of ['deb', 'rpm', 'AppImage']) {
      const name = await targetFilename(format, arch)
      for (const patterns of [releasePatterns, buildPatterns]) {
        assert.ok(patterns.some(pattern => minimatch(`release/${name}`, pattern)), `workflow uploads ${name}`)
      }
      assert.equal(selectAssets([{ id: 1, name, format }], { platform: 'linux', arch: Arch[arch], releaseVersion: manifest.version }).length, 1, `updater accepts ${name}`)
    }
  }
  const packager = makePackager('win')
  const names = [Arch.x64, Arch.ia32, Arch.arm64].map(arch => packager.expandArtifactNamePattern(config.nsis, 'exe', arch))
  assert.equal(new Set(names).size, 1, 'Windows architectures share one installer')
  assert.match(names[0], /-setup\.exe$/)
  for (const patterns of [releasePatterns, buildPatterns]) {
    assert.ok(patterns.some(pattern => minimatch(`release/${names[0]}`, pattern)))
    for (const name of ['BetterKuGou-portable.exe', 'BetterKuGou.zip', 'builder-debug.yml']) {
      assert.equal(patterns.some(pattern => minimatch(`release/${name}`, pattern)), false)
    }
  }
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
