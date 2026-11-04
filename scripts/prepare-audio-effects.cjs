const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

/** Build the exact target host before packaging, and stage only that platform/architecture. */
module.exports = async function prepareAudioEffects(context) {
  const arch = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch]
  if (!arch || arch === 'universal' || arch === 'armv7l') throw new Error('Unsupported audio effects target architecture')
  if (context.electronPlatformName !== process.platform) throw new Error('Build audio effects on the target operating system')
  const root = context.packager?.info?.appDir || context.appDir
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Cannot resolve the application directory for the native audio host')
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/build-audio-effects.cjs'), `--arch=${arch}`],
      { cwd: root, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Native audio effects build failed (${code})`)))
  })
  const platformDirectory = `${process.platform}-${arch}`
  const source = path.join(root, 'native', 'audio-effects', 'bin', platformDirectory)
  const target = path.join(root, 'native', 'audio-effects', 'package', arch, platformDirectory)
  await fs.mkdir(target, { recursive: true })
  for (const name of [process.platform === 'win32' ? 'bk-audio-host.exe' : 'bk-audio-host', 'THIRD_PARTY_NOTICES.txt']) {
    await fs.copyFile(path.join(source, name), path.join(target, name))
  }
}
