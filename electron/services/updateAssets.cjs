const targets = {
  win32: { group: 'windows', label: 'win', arches: ['x64', 'ia32', 'arm64'], formats: ['exe'] },
  linux: { group: 'linux', label: 'linux', arches: ['x64', 'arm64'], formats: ['AppImage', 'deb', 'rpm'] },
  darwin: { group: 'macos', label: 'mac', arches: ['x64', 'arm64'], formats: ['dmg'] }
}

const linuxLegacyArchitectures = {
  x64: { deb: 'amd64', rpm: 'x86_64' },
  arm64: { deb: 'arm64', rpm: 'aarch64' },
  armv7l: { deb: 'armhf', rpm: 'armv7hl' }
}

function releaseAssetName(version, target, arch, format) {
  const suffix = format === 'exe' ? '-setup.exe' : `.${format}`
  return `BetterKuGou-v${version}-${target.label}-${arch}${suffix}`
}

/** 生成发布任务与更新器共用的精确文件名，按平台与架构分组。 */
function releaseAssetGroups(version) {
  return Object.fromEntries(Object.values(targets).flatMap(target => target.arches.map(arch => [
    `${target.group}-${arch}`, target.formats.map(format => releaseAssetName(version, target, arch, format))
  ])))
}

function legacyNames(version, platform, arch, format) {
  const stems = [`BetterKuGou-${version}`, `BetterKuGou-v${version}`]
  if (platform === 'win32') {
    return [
      ...stems.map(stem => ({ name: `${stem}-${arch}-setup.exe`, arch })),
      ...stems.flatMap(stem => ['setup', 'Setup'].map(suffix => ({ name: `${stem}-${suffix}.exe`, arch: 'universal' })))
    ]
  }
  if (format === 'dmg' || format === 'AppImage') {
    const names = stems.map(stem => `${stem}-${arch}.${format}`)
    if (arch === 'x64') names.push(...stems.map(stem => `${stem}.${format}`))
    return names.map(name => ({ name, arch }))
  }
  const legacyArch = linuxLegacyArchitectures[arch][format]
  const name = format === 'deb' ? `betterkugou_${version}_${legacyArch}.deb` : `betterkugou-${version}.${legacyArch}.rpm`
  return [{ name, arch }]
}

/** 每种格式选一个当前架构的包，只有精确已知的历史命名可以回退。 */
function selectAssets(assets, { platform, arch, releaseVersion, preferredFormat }) {
  const target = Object.hasOwn(targets, platform) ? targets[platform] : null
  if (!target || !releaseVersion || (!target.arches.includes(arch) && !(platform === 'linux' && arch === 'armv7l'))) return []
  const formats = platform === 'linux' && target.formats.includes(preferredFormat)
    ? [preferredFormat, ...target.formats.filter(format => format !== preferredFormat)] : target.formats
  const byName = new Map(assets.map(asset => [asset.name, asset]))
  const selected = []
  for (const format of formats) {
    const names = legacyNames(releaseVersion, platform, arch, format)
    if (target.arches.includes(arch)) names.unshift({ name: releaseAssetName(releaseVersion, target, arch, format), arch })
    const option = names.find(({ name }) => {
      const asset = byName.get(name)
      return asset && (asset.format === undefined || asset.format === format)
    })
    if (option) selected.push({ ...byName.get(option.name), platform, arch: option.arch, format })
  }
  return selected
}

module.exports = { releaseAssetGroups, selectAssets }
