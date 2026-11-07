const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { version } = require('../package.json')
const { releaseAssetGroups } = require('../electron/services/updateAssets.cjs')

function verifyReleaseTag(tag) {
  if (tag !== `v${version}`) {
    throw new Error(`发布标签 ${tag} 与安装包版本 ${version} 不一致。`)
  }
}

/** Check each platform and architecture's exact asset set before publishing. */
function validateReleaseAssets(directory) {
  const groups = releaseAssetGroups(version)
  const expectedFolders = new Set(Object.keys(groups).map(group => `BetterKuGou-${group}`))
  const folders = fs.readdirSync(directory, { withFileTypes: true })
  if (folders.length !== expectedFolders.size || folders.some(folder => !folder.isDirectory() || !expectedFolders.has(folder.name))) {
    throw new Error('发布产物缺少约定的平台与架构目录，或存在多余目录。')
  }
  return Object.entries(groups).flatMap(([group, expected]) => {
    const folder = path.join(directory, `BetterKuGou-${group}`)
    const files = fs.readdirSync(folder, { withFileTypes: true })
    if (files.length !== expected.length || files.some(file => !file.isFile() || !expected.includes(file.name))) {
      throw new Error(`${group} 安装包不完整或存在多余文件。应包含 ${expected.join(', ')}。`)
    }
    return expected.map(name => {
      const file = path.join(folder, name)
      if (fs.statSync(file).size === 0) throw new Error(`安装包为空文件 ${file}。`)
      return file
    })
  })
}

async function assetDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

/** Resume a matching draft with missing assets and verify the remote set before publication. */
async function publishRelease({ tag, directory, repository }, runGh = args => execFileSync('gh', args, { encoding: 'utf8' })) {
  verifyReleaseTag(tag)
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('缺少有效的发布仓库。')
  const files = validateReleaseAssets(directory)
  const prerelease = version.split('+', 1)[0].includes('-')
  const flags = [`--prerelease=${prerelease}`, `--latest=${!prerelease}`]
  const gh = (command, ...args) => runGh(['release', command, tag, '--repo', repository, ...args])

  function readRelease() {
    const selectTag = `.[] | select(.tag_name == ${JSON.stringify(tag)}) | @json`
    const output = runGh(['api', '--paginate', '--jq', selectTag, `repos/${repository}/releases`]).trim()
    const matches = output ? output.split(/\r?\n/).map(line => JSON.parse(line)) : []
    if (matches.length > 1) throw new Error(`找到多个 ${tag} 的发布记录，请先处理冲突。`)
    return matches[0]
  }

  async function missingAssets(release) {
    const missing = new Map(files.map(file => [path.basename(file), file]))
    for (const asset of release.assets) {
      const file = missing.get(asset.name)
      if (release.draft && file && asset.state === 'starter' && asset.size === 0) {
        throw new Error(`${tag} 的上次上传留下空资产 ${asset.name}。请在 GitHub 草稿中移除该空资产后重试。`)
      }
      if (!file || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
        throw new Error(`${tag} 的远端安装包记录无效或存在冲突 ${asset.name}。`)
      }
      if (release.draft && (fs.statSync(file).size !== asset.size || await assetDigest(file) !== asset.digest)) {
        throw new Error(`${tag} 的草稿安装包与本轮构建内容不一致 ${asset.name}。请用原构建产物重试。`)
      }
      missing.delete(asset.name)
    }
    if (!release.draft && (missing.size > 0 || release.prerelease !== prerelease)) {
      throw new Error(`${tag} 已公开，但安装包或发布类型不完整。`)
    }
    return [...missing.values()]
  }

  let release = readRelease()
  if (!release) {
    gh('create', '--draft', '--verify-tag', '--notes-file', 'updata_log.md', `--prerelease=${prerelease}`, '--latest=false')
    release = readRelease()
    if (!release) throw new Error(`无法读取 ${tag} 的草稿。`)
  }
  const missing = await missingAssets(release)
  if (!release.draft) return
  if (missing.length) {
    gh('upload', ...missing)
    release = readRelease()
    if (!release || (await missingAssets(release)).length) throw new Error(`${tag} 尚未收齐全部安装包。`)
  }
  if (release.draft) gh('edit', '--draft=false', '--verify-tag', '--tag', tag, '--notes-file', 'updata_log.md', ...flags)
}

async function main([mode, tag, directory]) {
  if (mode === '--check-tag') verifyReleaseTag(tag)
  else if (mode === '--publish' && directory) await publishRelease({ tag, directory, repository: process.env.GITHUB_REPOSITORY })
  else throw new Error('用法为 --check-tag <标签> 或 --publish <标签> <产物目录>。')
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { verifyReleaseTag, validateReleaseAssets, publishRelease }
