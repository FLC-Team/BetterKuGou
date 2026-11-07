const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const helper = path.join(root, 'installer', 'windows-files.ps1')
const appExe = 'BetterKuGou.exe'
const uninstallerExe = 'Uninstall BetterKuGou.exe'
const manifestName = '.betterkugou-files.json'
const windows = { skip: process.platform !== 'win32' }
const requireNative = process.env.BK_REQUIRE_INSTALLER_FILES_TESTS === '1'
let folderRenameAvailable

function fixture(t) {
  // Expand Windows short names in TEMP while keeping renames on the system volume.
  const temporary = fs.realpathSync.native(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporary, 'betterkugou-installer-files-'))
  assert.equal(path.dirname(directory), temporary)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, '音乐应用')
  const result = path.join(directory, 'result.txt')

  function run(action, { existing = false, success = true, ...overrides } = {}) {
    const executed = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, action],
      {
        cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: {
          ...process.env,
          BK_INSTALL_TARGET: target,
          BK_INSTALL_MODE: 'CurrentUser',
          BK_INSTALL_EXISTING: existing ? '1' : '0',
          BK_INSTALL_ALLOW_BACKUP: existing ? '1' : '0',
          BK_INSTALL_VERSION: '2.0.0',
          BK_INSTALL_RECORDED_VERSION: existing ? '1.0.0' : '',
          BK_INSTALL_EXE: appExe,
          BK_INSTALL_UNINSTALLER: uninstallerExe,
          BK_INSTALL_RESULT: result,
          ...overrides
        }
      })
    assert.ifError(executed.error)
    const bytes = fs.existsSync(result) ? fs.readFileSync(result) : Buffer.alloc(0)
    if (bytes.length >= 2) assert.notEqual(bytes.readUInt16LE(0), 0xfeff, 'NSIS expects UTF-16LE without BOM')
    const value = bytes.toString('utf16le')
    assert.equal(executed.status, success ? 0 : 1, executed.stderr + executed.stdout + value)
    return value
  }

  return { directory, target, run }
}

function writePackage(directory, version) {
  fs.mkdirSync(path.join(directory, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(directory, appExe), 'application ' + version)
  fs.writeFileSync(path.join(directory, uninstallerExe), 'uninstaller ' + version)
  fs.writeFileSync(path.join(directory, 'resources', 'app.asar'), 'resources ' + version)
}

function moveFixture(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination)
      return
    } catch (error) {
      if (attempt === 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    }
  }
}

function requireFolderRename(t, directory, run) {
  if (folderRenameAvailable === undefined) {
    const source = path.join(directory, '权限探针')
    writePackage(source, 'fixture')
    const scope = { existing: true, BK_INSTALL_TARGET: source }
    const staged = run('prepare', scope)
    const previous = staged.replace(/\.BetterKuGou-new-([a-f0-9]+)$/, '.BetterKuGou-old-$1')
    try {
      moveFixture(source, previous)
      moveFixture(previous, source)
      folderRenameAvailable = true
    } catch (error) {
      if (requireNative || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      folderRenameAvailable = false
    }
  }
  if (!folderRenameAvailable) t.skip('The host rejected a direct rename of an independent sample application tree')
  return folderRenameAvailable
}

test('Windows installer requires a dedicated path and refuses system roots and unsafe machine locations', windows, t => {
  const { directory, target, run } = fixture(t)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'photos.txt'), 'personal file')
  assert.match(run('validate', { success: false }), /目标文件夹已有文件/)
  assert.equal(fs.readFileSync(path.join(target, 'photos.txt'), 'utf8'), 'personal file')
  assert.match(run('validate', { success: false, BK_INSTALL_TARGET: path.join(directory, 'NUL.txt') }), /无效的文件或文件夹名称/)
  assert.match(run('validate', { success: false, BK_INSTALL_TARGET: path.join(directory, 'BETTER~1') }), /无效的文件或文件夹名称/)
  assert.match(run('validate', { success: false, BK_INSTALL_TARGET: process.env.USERPROFILE }), /专用的安装子目录/)
  assert.match(run('validate', { success: false, BK_INSTALL_TARGET: process.env.windir }), /Windows 和 Program Files/)
  assert.match(run('validate', {
    success: false, BK_INSTALL_MODE: 'all', BK_INSTALL_MACHINE_ROOT: process.env.ProgramFiles
  }), /直接子目录/)
})

test('Windows installer rejects an ancestor junction without touching its destination', windows, t => {
  const { directory, target, run } = fixture(t)
  fs.mkdirSync(target)
  const junction = path.join(directory, 'linked')
  try {
    fs.symlinkSync(target, junction, 'junction')
  } catch (error) {
    if (requireNative || !['EPERM', 'EACCES'].includes(error.code)) throw error
    t.skip('The host does not allow an independent junction fixture')
    return
  }
  try {
    assert.match(run('validate', { success: false, BK_INSTALL_TARGET: path.join(junction, 'child') }), /路径包含链接/)
    assert.deepEqual(fs.readdirSync(target), [])
  } finally {
    fs.rmdirSync(junction)
  }
})

test('Windows installer swaps complete files and removes only managed files on uninstall', windows, t => {
  const { directory, target, run } = fixture(t)
  if (!requireFolderRename(t, directory, run)) return
  assert.equal(run('validate'), target)
  const stage = run('prepare')
  assert.equal(path.dirname(stage), path.dirname(target))
  assert.notEqual(stage, target)
  writePackage(stage, 'first')
  run('commit')
  run('finish')
  assert.equal(fs.readFileSync(path.join(target, appExe), 'utf8'), 'application first')

  const lateFile = path.join(target, 'late-personal.txt')
  const noBackup = { existing: true, BK_INSTALL_ALLOW_BACKUP: '0' }
  const interruptedStage = run('prepare', noBackup)
  writePackage(interruptedStage, 'blocked')
  fs.writeFileSync(lateFile, 'arrived after validation')
  assert.match(run('commit', { ...noBackup, success: false }), /确认备份/)
  assert.equal(fs.readFileSync(lateFile, 'utf8'), 'arrived after validation')
  run('rollback', noBackup)
  fs.unlinkSync(lateFile)

  const nextStage = run('prepare', { existing: true })
  writePackage(nextStage, 'second')
  run('commit', { existing: true })
  assert.equal(run('finish', { existing: true }), '', 'an exactly managed backup is cleaned')
  const personal = path.join(target, 'resources', 'my-notes.txt')
  fs.writeFileSync(personal, 'keep this')
  run('uninstall', { existing: true })
  assert.equal(fs.readFileSync(personal, 'utf8'), 'keep this')
  assert.equal(fs.existsSync(path.join(target, appExe)), false)
  assert.equal(fs.existsSync(path.join(target, uninstallerExe)), false)
})

test('Windows installer preserves a legacy or mixed directory in a named backup', windows, t => {
  const { directory, target, run } = fixture(t)
  if (!requireFolderRename(t, directory, run)) return
  writePackage(target, 'legacy')
  fs.writeFileSync(path.join(target, 'photos.txt'), 'legacy files')
  assert.equal(run('validate', { existing: true }), 'backup|' + target)
  assert.match(run('prepare', { existing: true, success: false, BK_INSTALL_ALLOW_BACKUP: '0' }), /确认备份/)
  const stage = run('prepare', { existing: true })
  writePackage(stage, 'new')
  run('commit', { existing: true })
  const backup = run('finish', { existing: true })
  assert.equal(path.dirname(backup), path.dirname(target))
  assert.match(path.basename(backup), /\.BetterKuGou-backup-/)
  assert.equal(fs.readFileSync(path.join(backup, 'photos.txt'), 'utf8'), 'legacy files')
  assert.equal(fs.readFileSync(path.join(backup, appExe), 'utf8'), 'application legacy')

  fs.writeFileSync(path.join(target, 'my-music.txt'), 'mixed files')
  assert.equal(run('validate', { existing: true }), 'backup|' + target)
  const nextStage = run('prepare', { existing: true })
  writePackage(nextStage, 'newer')
  run('commit', { existing: true })
  const mixed = run('finish', { existing: true })
  assert.equal(fs.readFileSync(path.join(mixed, 'my-music.txt'), 'utf8'), 'mixed files')
  assert.equal(fs.readFileSync(path.join(target, appExe), 'utf8'), 'application newer')
})

test('Windows installer rejects an incomplete stage and preserves the original app', windows, t => {
  const { target, run } = fixture(t)
  writePackage(target, 'original')
  fs.writeFileSync(path.join(target, 'music.txt'), 'private files')
  const stage = run('prepare', { existing: true })
  fs.writeFileSync(path.join(stage, appExe), 'incomplete app')
  assert.match(run('commit', { existing: true, success: false }), /安装包缺少有效文件/)
  assert.equal(fs.readFileSync(path.join(target, appExe), 'utf8'), 'application original')
  run('rollback', { existing: true })
  assert.equal(fs.existsSync(stage), false)
})

test('Windows installer can roll back a completed file swap when registration fails', windows, t => {
  const { directory, target, run } = fixture(t)
  if (!requireFolderRename(t, directory, run)) return
  writePackage(target, 'original')
  fs.writeFileSync(path.join(target, 'music.txt'), 'private files')
  const stage = run('prepare', { existing: true })
  writePackage(stage, 'replacement')
  run('commit', { existing: true })
  assert.equal(fs.readFileSync(path.join(target, appExe), 'utf8'), 'application replacement')
  run('rollback', { existing: true })
  assert.equal(fs.readFileSync(path.join(target, appExe), 'utf8'), 'application original')
  assert.equal(fs.readFileSync(path.join(target, 'music.txt'), 'utf8'), 'private files')
})

test('Windows installer recovers from interruption between directory swaps and refuses a tampered inventory', windows, t => {
  const { directory, target, run } = fixture(t)
  if (!requireFolderRename(t, directory, run)) return
  writePackage(target, 'legacy')
  let stage = run('prepare', { existing: true })
  moveFixture(target, stage.replace(/\.BetterKuGou-new-([a-f0-9]+)$/, '.BetterKuGou-old-$1'))
  stage = run('prepare', { existing: true })
  assert.equal(fs.readFileSync(path.join(target, appExe), 'utf8'), 'application legacy')
  writePackage(stage, 'new')
  run('commit', { existing: true })
  run('finish', { existing: true })

  const external = path.join(directory, 'outside.txt')
  fs.writeFileSync(external, 'external file')
  const inventory = path.join(target, manifestName)
  const record = JSON.parse(fs.readFileSync(inventory, 'utf8'))
  record.files.push('..\\outside.txt')
  fs.writeFileSync(inventory, JSON.stringify(record))
  assert.match(run('uninstall', { existing: true, success: false }), /无效的文件或文件夹名称/)
  assert.equal(fs.readFileSync(external, 'utf8'), 'external file')
  assert.equal(fs.existsSync(path.join(target, appExe)), true)
})
