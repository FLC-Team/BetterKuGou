const { spawnSync } = require('node:child_process')
const { releaseAssetGroups } = require('../electron/services/updateAssets.cjs')

const platformGroups = { win: 'windows', linux: 'linux', mac: 'macos' }
const hostPlatforms = { win32: 'win', linux: 'linux', darwin: 'mac' }
const aliases = {
  '--win': 'win', '--windows': 'win', '-w': 'win',
  '--linux': 'linux', '-l': 'linux',
  '--mac': 'mac', '--macos': 'mac', '-m': 'mac', '-o': 'mac'
}
const archFlag = /^--(x64|ia32|arm64|armv7l|universal)(?:=(true|false))?$/
const knownGroups = Object.keys(releaseAssetGroups('0.0.0'))

/** Launch one builder instance for each architecture. The NSIS target merges
 * several architectures into an additional universal installer within one run. */
function distributionCommands(args, hostPlatform = process.platform, hostArch = process.arch) {
  const requestedPlatforms = new Set(args.map(arg => aliases[arg.split('=', 1)[0]]).filter(Boolean))
  if (requestedPlatforms.size > 1) throw new Error('请分别运行各平台的安装包构建命令。')
  const [requestedPlatform] = requestedPlatforms
  const platform = requestedPlatform || hostPlatforms[hostPlatform]
  if (!platform) throw new Error(`当前系统不支持打包 ${hostPlatform}。`)
  if (args.some(arg => /^[\w.]+:(?:x64|ia32|arm64|armv7l|universal)$/.test(arg))) {
    throw new Error('请使用独立的架构参数，例如 --arm64。')
  }
  const groupPrefix = `${platformGroups[platform]}-`
  const supported = knownGroups.filter(group => group.startsWith(groupPrefix)).map(group => group.slice(groupPrefix.length))
  const archOptions = new Map(args.map(arg => archFlag.exec(arg)).filter(Boolean).map(match => [match[1], match[2] !== 'false']))
  const requested = [...archOptions].filter(([, enabled]) => enabled).map(([arch]) => arch)
  const defaults = platform === 'linux' || args.includes('--dir') ? [hostArch] : supported
  const archs = requested.length ? requested : defaults.filter(arch => archOptions.get(arch) !== false)
  if (!archs.length) throw new Error('至少选择一个要构建的架构。')
  if (archs.some(arch => !supported.includes(arch))) throw new Error(`不支持 ${platform} ${archs.join(', ')}。`)
  if (archs.length > 1 && args.some(arg => /^(?:--prepackaged|--pd)(?:=|$)/.test(arg))) {
    throw new Error('预打包目录只能用于一个明确的架构。')
  }
  const forwarded = args.filter(arg => !archFlag.test(arg))
  if (!requestedPlatform) forwarded.unshift(`--${platform}`)
  if (!forwarded.some(arg => /^(?:--publish|-p)(?:=|$)/.test(arg))) forwarded.push('--publish', 'never')
  return archs.map(arch => {
    const command = [...forwarded, `--${arch}`]
    // Builder's Linux arch macro expands differently for AppImage, DEB and RPM.
    if (platform === 'linux') command.push('--config.linux.artifactName=${productName}-v${version}-linux-' + arch + '.${ext}')
    return command
  })
}

if (require.main === module) {
  try {
    const builder = require.resolve('electron-builder/cli.js')
    for (const args of distributionCommands(process.argv.slice(2))) {
      const env = process.platform === 'linux' && args.includes('--arm64')
        ? { ...process.env, USE_SYSTEM_FPM: 'true', USE_SYSTEM_MKSQUASHFS: 'true' }
        : process.env
      const result = spawnSync(process.execPath, [builder, ...args], { stdio: 'inherit', windowsHide: true, env })
      if (result.error) throw result.error
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1
        break
      }
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { distributionCommands }
