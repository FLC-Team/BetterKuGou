const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const deps = path.join(root, '.cache', 'audio-effects', 'deps')
const args = process.argv.slice(2)
const arch = args.find(value => value.startsWith('--arch='))?.slice(7) || process.arch
const supported = { win32: ['x64', 'ia32', 'arm64'], darwin: ['x64', 'arm64'], linux: ['x64', 'arm64'] }
if (!supported[process.platform]?.includes(arch)) throw new Error(`Unsupported host target ${process.platform}-${arch}`)
const output = path.join(root, 'native', 'audio-effects', 'bin', `${process.platform}-${arch}`)
const generator = process.env.BK_NATIVE_GENERATOR
if (process.platform === 'win32' && generator && !generator.startsWith('Visual Studio')) {
  const configuredArch = { x86: 'ia32', x64: 'x64', arm64: 'arm64' }[process.env.VSCMD_ARG_TGT_ARCH]
  if (configuredArch !== arch) {
    throw new Error(`Generator ${generator} requires a matching Visual Studio developer environment for ${arch}; VSCMD_ARG_TGT_ARCH=${process.env.VSCMD_ARG_TGT_ARCH || 'unset'}`)
  }
}
const build = path.join(root, '.cache', 'audio-effects', 'build', `${process.platform}-${arch}${generator ? `-${generator.replace(/[^a-z0-9]/gi, '-')}` : ''}`)

/** Dependencies are pinned and checked before compiling; no package manager or system configuration is changed. */
function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, { cwd, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status})`)
}
function gitOutput(arguments_, cwd) {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || 'Cannot inspect dependency checkout')
  return result.stdout.trim()
}
const dependencies = [
  ['vst3sdk', 'https://github.com/steinbergmedia/vst3sdk.git', 'v3.8.1_build_84', '3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96'],
  ['kissfft', 'https://github.com/mborgerding/kissfft.git', '131.2.0', '7bce4153c6bc8aba2db0e889e576f9d00505cbe1'],
  ['json', 'https://github.com/nlohmann/json.git', 'v3.11.3', '9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03']
]
fs.mkdirSync(deps, { recursive: true })
for (const [name, url, tag, commit] of dependencies) {
  const directory = path.join(deps, name)
  if (!fs.existsSync(path.join(directory, '.git'))) run('git', ['clone', '--depth', '1', '--branch', tag, url, directory])
  if (gitOutput(['rev-parse', 'HEAD'], directory) !== commit) throw new Error(`Dependency ${name} does not match its pinned commit`)
}
const sdk = path.join(deps, 'vst3sdk')
run('git', ['submodule', 'update', '--init', '--depth', '1', 'base', 'cmake', 'pluginterfaces', 'public.sdk'], sdk)
let cmake = process.env.CMAKE || 'cmake'
const configure = ['-S', path.join(root, 'native', 'audio-effects'), '-B', build, `-DBK_DEPS=${deps}`, `-DBK_OUTPUT_DIRECTORY=${output}`, '-DCMAKE_BUILD_TYPE=Release']
if (generator) configure.push('-G', generator)
if (process.platform === 'win32' && (!generator || generator.startsWith('Visual Studio'))) configure.push('-A', { x64: 'x64', ia32: 'Win32', arm64: 'ARM64' }[arch])
if (process.platform === 'darwin') configure.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`)
if (process.platform === 'linux' && arch !== process.arch) throw new Error('Linux cross-compilation requires a configured native toolchain; build on a matching runner')
run(cmake, configure)
run(cmake, ['--build', build, '--config', 'Release', '--target', 'bk-audio-host', '--parallel'])
fs.mkdirSync(output, { recursive: true })
const notices = dependencies.map(([name, , tag]) => {
  const file = name === 'vst3sdk' ? 'LICENSE.txt' : name === 'kissfft' ? 'LICENSES/BSD-3-Clause' : 'LICENSE.MIT'
  const attribution = name === 'kissfft' ? fs.readFileSync(path.join(deps, name, 'COPYING'), 'utf8') + '\n' : ''
  return `${name} ${tag}\n${attribution}${fs.readFileSync(path.join(deps, name, file), 'utf8')}\n`
}).join('\n')
fs.writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices)
if (arch === process.arch && !args.includes('--skip-tests')) run(path.join(output, process.platform === 'win32' ? 'bk-audio-host.exe' : 'bk-audio-host'), ['--self-test'])
