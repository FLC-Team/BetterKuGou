const fs = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const { execFile } = require('node:child_process')
const { download } = require('app-builder-lib/out/binDownload')

const run = promisify(execFile)
const url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis%402.0.1/nsis-bundle-3.12.tar.gz'
const sha512 = 'FYz2y5a8/2XiYx1HyI9cxaeBoy7UGdL53MSgNe5FkZZAGAe49awHkjHG/Vs+2cPHPVRDSrxEczXWGCB3wLBD1g=='
let preparation

/** Prepare a verified NSIS 3.12 bundle in the layout expected by builder 25. */
async function prepareWindowsNsis(root) {
  const cache = path.join(root, '.cache', 'nsis', '3.12')
  const complete = path.join(cache, 'verified-bundle')
  const [digest, directory] = (await fs.readFile(complete, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })).split('\n')
  if (digest === sha512 && /^bundle-[a-zA-Z0-9]{6}$/.test(directory)) {
    return path.join(cache, directory, 'nsis-bundle', 'windows')
  }

  await fs.mkdir(cache, { recursive: true })
  const temporary = await fs.mkdtemp(path.join(cache, 'bundle-'))
  const selection = `${temporary}.verified`
  let prepared = false
  try {
    const archive = path.join(temporary, 'nsis.tar.gz')
    await download(url, archive, sha512)
    const tar = path.join(process.env.SystemRoot, 'System32', 'tar.exe')
    await run(tar, ['-xf', archive, '-C', temporary], { windowsHide: true })
    const bundle = path.join(temporary, 'nsis-bundle')
    const windows = path.join(bundle, 'windows')
    await fs.copyFile(path.join(windows, 'makensis.exe'), path.join(windows, 'Bin', 'makensis.exe'))
    await fs.copyFile(path.join(bundle, 'elevate.exe'), path.join(windows, 'elevate.exe'))
    await fs.unlink(archive)
    // Publish only the small cache pointer after the complete bundle is ready.
    await fs.writeFile(selection, `${sha512}\n${path.basename(temporary)}`, { flag: 'wx' })
    await fs.rename(selection, complete)
    prepared = true
    return windows
  } finally {
    if (!prepared) {
      await fs.rm(selection, { force: true })
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}

module.exports = async function configureWindowsNsis(root) {
  if (process.env.ELECTRON_BUILDER_NSIS_DIR) return
  preparation ??= prepareWindowsNsis(root)
  process.env.ELECTRON_BUILDER_NSIS_DIR = await preparation
}
