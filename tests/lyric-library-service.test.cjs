const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createLyricLibraryService } = require('../electron/services/lyricLibraryService')

const policy = overrides => ({ playback: { lyricLibrary: { enabled: true, autoSave: true, minMatch: 'high', autoUpdate: true, ...overrides } } })
const request = (overrides = {}) => ({ hash: 'song-a', title: 'Test song', artist: 'Test artist', sourceId: 'lyric-1', matchLevel: 'exact', data: { status: 200, decodeContent: '[00:01.00]First line', language: 'translation-data' }, ...overrides })

async function fixture(t, overrides = {}) {
  const toolsRoot = path.resolve(__dirname, '../.agent/tools')
  await fs.mkdir(toolsRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(toolsRoot, 'lyric-library-'))
  const changes = []
  const service = createLyricLibraryService({ root, onChanged: change => changes.push(change), ...overrides })
  service.configure(policy())
  t.after(async () => { await service.stop(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, changes, service }
}

test('raw online lyrics survive restart; edits create selected copies and automatic updates preserve manual choices', async t => {
  const { service, root, changes } = await fixture(t)
  const first = await service.saveOnline(request())
  assert.equal(first.versions.length, 1)
  assert.deepEqual(await service.list(), [{ hash: 'song-a', title: 'Test song', artist: 'Test artist', selectedVersionId: first.selectedVersionId, updatedAt: first.updatedAt, versionCount: 1 }])
  const unchanged = await service.saveOnline(request())
  assert.equal(unchanged.versions.length, 1)
  assert.equal(changes.length, 1)
  const edited = await service.saveEdit({ hash: 'song-a', versionId: first.selectedVersionId, content: '[00:01.00]My correction' })
  assert.equal(edited.versions[0].data.decodeContent, '[00:01.00]First line')
  assert.equal(edited.versions[1].data.decodeContent, '[00:01.00]My correction')
  assert.equal(edited.versions[1].data.language, 'translation-data')
  assert.equal(edited.selectionMode, 'manual')
  const updated = await service.saveOnline(request({ mode: 'autoUpdate', data: { status: 1, decodeContent: '[00:01.00]New online line' } }))
  assert.equal(updated.versions.length, 3)
  assert.equal(updated.selectedVersionId, edited.selectedVersionId)
  await service.select({ hash: 'song-a', versionId: first.selectedVersionId })
  const later = await service.saveOnline(request({ mode: 'autoUpdate', data: { status: 200, decodeContent: '[00:01.00]Later online line' } }))
  assert.equal(later.selectedVersionId, first.selectedVersionId)
  assert.deepEqual(changes.map(change => change.reason), ['online', 'edit', 'online', 'select', 'online'])
  assert.deepEqual(changes.map(change => change.revision), [1, 2, 3, 4, 5])
  const restarted = createLyricLibraryService({ root })
  assert.deepEqual(await restarted.read('SONG-A'), later)
  await restarted.stop()
})

test('auto-selected online content advances while updates require an existing matching source', async t => {
  const { service } = await fixture(t)
  assert.equal(await service.saveOnline(request({ mode: 'autoUpdate' })), null)
  const first = await service.saveOnline(request())
  const update = request({ mode: 'autoUpdate', data: { status: 200, decodeContent: '[00:02.00]Updated' } })
  assert.equal(await service.saveOnline({ ...update, sourceId: 'unrelated-source' }), null)
  service.configure(policy({ autoSave: false }))
  const updated = await service.saveOnline(update)
  assert.notEqual(updated.selectedVersionId, first.selectedVersionId)
  assert.equal(updated.selectedVersionId, updated.versions.at(-1).id)
  service.configure(policy({ autoUpdate: false }))
  assert.equal(await service.saveOnline({ ...update, data: { status: 200, decodeContent: 'Another' } }), null)
  assert.equal((await service.read('song-a')).versions.length, 2)
})

test('match policy gates automatic saves independently from the retained library and disabled reads', async t => {
  const { service, root } = await fixture(t)
  for (const minMatch of ['any', 'medium', 'high', 'exact']) {
    service.configure(policy({ minMatch }))
    const rank = ['any', 'medium', 'high', 'exact']
    for (const matchLevel of rank) {
      const result = await service.saveOnline(request({ hash: `${minMatch}-${matchLevel}`, matchLevel }))
      assert.equal(Boolean(result), rank.indexOf(matchLevel) >= rank.indexOf(minMatch))
    }
  }
  const files = await fs.readdir(root)
  service.configure(policy({ enabled: false }))
  assert.deepEqual(await service.list(), [])
  assert.equal(await service.read('exact-exact'), null)
  assert.equal(await service.saveOnline(request()), null)
  assert.throws(() => service.saveEdit({ hash: 'exact-exact', content: 'Test' }), { code: 'LYRIC_LIBRARY_DISABLED' })
  assert.deepEqual(await fs.readdir(root), files)
  service.configure(policy({ autoSave: false }))
  assert.ok(await service.read('exact-exact'))
  assert.equal(await service.saveOnline(request()), null)
})

test('credentials are removed recursively and hostile identities, empty lyrics and oversized edits are rejected', async t => {
  const { service, root } = await fixture(t)
  const result = await service.saveOnline(request({
    data: { status: 200, decodeContent: 'Safe content', accesskey: 'private-key', nested: { TOKEN: 'private-token', cookie: 'private-cookie', safe: [1, 'text'] } }
  }))
  const serialized = await fs.readFile(path.join(root, (await fs.readdir(root))[0]), 'utf8')
  assert.doesNotMatch(serialized, /private-key|private-token|private-cookie|accesskey|TOKEN|cookie/)
  assert.deepEqual(result.versions[0].data.nested, { safe: [1, 'text'] })
  for (const hash of ['../settings', 'a/b', 'a\\b', 'a.json', '', null, '词']) assert.throws(() => service.read(hash), { code: 'LYRIC_INVALID_HASH' })
  assert.throws(() => service.saveOnline(request({ data: { status: 200, decodeContent: ' ' } })), { code: 'LYRIC_EMPTY' })
  assert.throws(() => service.saveOnline(request({ data: { status: 500, decodeContent: 'error' } })), { code: 'LYRIC_INVALID_DATA' })
  assert.throws(() => service.saveEdit({ hash: 'song-a', versionId: result.selectedVersionId, content: '词'.repeat(350000) }), { code: 'LYRIC_TOO_LARGE' })
  await assert.rejects(service.select({ hash: 'song-a', versionId: '../../file' }), { code: 'LYRIC_VERSION_MISSING' })
})

test('concurrent edits serialize and failed atomic replacement retains the previous file and accepts later retry', async t => {
  let failRename = false
  const disk = { ...fs, rename: async (...args) => { if (failRename) throw Object.assign(new Error('Disk denied'), { code: 'EACCES' }); return fs.rename(...args) } }
  const { service, root } = await fixture(t, { fs: disk })
  const first = await service.saveOnline(request())
  const edit = content => service.saveEdit({ hash: 'song-a', versionId: first.selectedVersionId, content })
  await Promise.all([edit('First correction'), edit('Second correction')])
  const previous = await service.read('song-a')
  assert.equal(previous.versions.length, 3)
  failRename = true
  await assert.rejects(edit('Failed correction'), { code: 'EACCES' })
  assert.deepEqual(await service.read('song-a'), previous)
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false)
  failRename = false
  assert.equal((await edit('Retry correction')).versions.length, 4)
})

test('disabling while a write is pending cancels publication and keeps every previous version', async t => {
  let releaseWrite, reachedWrite, hold = false
  const reached = new Promise(resolve => { reachedWrite = resolve })
  const gate = new Promise(resolve => { releaseWrite = resolve })
  const disk = { ...fs, writeFile: async (...args) => { await fs.writeFile(...args); if (hold) { reachedWrite(); await gate } } }
  const { service, root, changes } = await fixture(t, { fs: disk })
  const first = await service.saveOnline(request())
  hold = true
  const pending = service.saveEdit({ hash: 'song-a', versionId: first.selectedVersionId, content: 'Pending correction' })
  const rejection = assert.rejects(pending, { code: 'LYRIC_LIBRARY_DISABLED' })
  await reached
  service.configure(policy({ enabled: false }))
  releaseWrite()
  await rejection
  service.configure(policy())
  assert.deepEqual(await service.read('song-a'), first)
  assert.equal(changes.length, 1)
  assert.equal((await fs.readdir(root)).length, 1)
  const stopping = service.stop()
  assert.equal(service.stop(), stopping)
  await stopping
  assert.equal(await service.read('song-a'), null)
})

test('corrupt files are preserved and not silently overwritten with a new lyric', async t => {
  const { service, root } = await fixture(t)
  await service.saveOnline(request())
  const filename = path.join(root, (await fs.readdir(root))[0])
  await fs.writeFile(filename, '{invalid json')
  await assert.rejects(service.read('song-a'), { code: 'LYRIC_CORRUPT' })
  await assert.rejects(service.saveOnline(request()), { code: 'LYRIC_CORRUPT' })
  assert.equal(await fs.readFile(filename, 'utf8'), '{invalid json')
})

test('raw and UTF-8 Base64 responses expose editable text while compressed KRC cannot enter the library', async t => {
  const { service } = await fixture(t)
  const content = '[00:01.00]中文歌词\n[00:02.00]Second line'
  const encoded = Buffer.from(content).toString('base64')
  for (const [hash, data] of [
    ['raw-text', { content }], ['encoded-text', { content: encoded }],
    ['nested-text', { data: { content } }], ['nested-encoded', { data: { content: encoded } }]
  ]) {
    const record = await service.saveOnline(request({ hash, data: { status: 200, ...data } }))
    assert.equal(record.versions[0].data.decodeContent, content)
    assert.equal((await service.read(hash)).versions[0].data.decodeContent, content)
  }
  const plain = await service.saveOnline(request({ hash: 'base64-looking-text', data: { status: 200, content: 'YWJj' } }))
  assert.equal(plain.versions[0].data.decodeContent, 'YWJj', 'decoded text without a timestamp must not be guessed as encoded lyrics')
  for (const compressed of ['krc1\x00\x01binary', Buffer.from('krc1\x00\x01binary').toString('base64')]) {
    assert.throws(() => service.saveOnline(request({ data: { status: 200, content: compressed } })), { code: 'LYRIC_COMPRESSED' })
  }
})

test('editing timed row structure removes inherited translation and reading metadata, but an explicit language edit becomes authoritative', async t => {
  const { service } = await fixture(t)
  const oldLanguage = Buffer.from(JSON.stringify({ content: [{ type: 1, lyricContent: [['第一句'], ['第二句']] }, { type: 0, lyricContent: [['a'], ['b']] }] })).toString('base64')
  const originalContent = `[language:${oldLanguage}]\n[00:01.00]First\n[00:02.00]Second`
  const original = await service.saveOnline(request({ data: { status: 200, decodeContent: originalContent, language: oldLanguage, translation: 'legacy', data: { language: oldLanguage } } }))
  const unchanged = await service.saveEdit({ hash: 'song-a', versionId: original.selectedVersionId, content: originalContent.replace('First', 'Corrected') })
  assert.equal(unchanged.versions.at(-1).data.language, oldLanguage)
  assert.equal(unchanged.versions.at(-1).languageReset, false)
  for (const content of [
    originalContent + '\n[00:03.00]Added',
    originalContent.replace('[00:01.00]First\n', ''),
    originalContent.replace('[00:02.00]', '[00:04.00]')
  ]) {
    const edited = await service.saveEdit({ hash: 'song-a', versionId: original.selectedVersionId, content })
    const version = edited.versions.at(-1)
    assert.equal(version.languageReset, true)
    assert.equal(version.data.language, undefined)
    assert.equal(version.data.translation, undefined)
    assert.equal(version.data.data.language, undefined)
    assert.doesNotMatch(version.data.decodeContent, /\[language:/)
    assert.equal((await service.read('song-a')).versions.at(-1).languageReset, true)
  }
  const newLanguage = Buffer.from(JSON.stringify({ content: [{ type: 1, lyricContent: [['新译文']] }] })).toString('base64')
  const explicit = await service.saveEdit({ hash: 'song-a', versionId: original.selectedVersionId, content: `[language:${newLanguage}]\n[00:03.00]Replacement` })
  assert.equal(explicit.versions.at(-1).data.language, undefined)
  assert.match(explicit.versions.at(-1).data.decodeContent, new RegExp(newLanguage))
  assert.equal(explicit.versions.at(-1).languageReset, false)
  const removed = await service.saveEdit({ hash: 'song-a', versionId: original.selectedVersionId, content: originalContent.replace(`[language:${oldLanguage}]\n`, '') })
  assert.equal(removed.versions.at(-1).data.language, undefined)
  assert.equal(removed.versions.at(-1).languageReset, true)
  assert.equal((await service.read('song-a')).versions[0].data.decodeContent, originalContent)
})

test('main IPC restricts library operations to the main top frame and fixes the private root', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('function initializeLyricLibraryService()')
  const end = source.indexOf('/** 离线资源 IPC', start)
  const senderStart = source.indexOf('function isMainWindowSender(event)')
  const senderEnd = source.indexOf('\n}', senderStart) + 2
  const handlers = new Map(), calls = [], changes = []
  const mainWindow = { isDestroyed: () => false, webContents: { mainFrame: {}, send: (...args) => changes.push(args) } }
  let options
  const service = Object.fromEntries(['list', 'read', 'saveOnline', 'saveEdit', 'select'].map(method => [method, argument => { calls.push([method, argument]); return method }]))
  service.configure = settings => calls.push(['configure', settings])
  const context = vm.createContext({
    lyricLibraryService: null, isQuitting: false, mainWindow, path, logger: {},
    app: { getPath: name => { assert.equal(name, 'userData'); return '/user-data' } },
    getSettings: () => policy(), createLyricLibraryService: value => { options = value; return service },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  })
  vm.runInContext(source.slice(senderStart, senderEnd) + '\n' + source.slice(start, end), context)
  vm.runInContext('initializeLyricLibraryService()', context)
  assert.equal(options.root, path.join('/user-data', 'lyric-library'))
  const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame }
  for (const [channel, handler] of handlers) {
    assert.throws(() => handler({ sender: {}, senderFrame: {} }, 'song-a'), /主窗口/)
    assert.throws(() => handler({ sender: event.sender, senderFrame: {} }, 'song-a'), /主窗口/)
    assert.ok(handler(event, 'song-a'))
    assert.match(channel, /^lyric-library:/)
  }
  options.onChanged({ hash: 'song-a', revision: 1, reason: 'edit' })
  assert.deepEqual(changes, [['lyric-library:changed', { hash: 'song-a', revision: 1, reason: 'edit' }]])
  context.isQuitting = true
  assert.throws(() => handlers.get('lyric-library:read')(event, 'song-a'), /主窗口/)
})

test('preload offers fixed library calls and hides the privileged event from change subscribers', async () => {
  const exposed = {}, calls = [], ipc = new EventEmitter()
  ipc.invoke = async (...args) => calls.push(args)
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } } }), window: {}, console
  })
  const api = exposed.electronAPI.lyricLibrary
  await api.list(); await api.read('song-a'); await api.saveOnline(request()); await api.saveEdit({ hash: 'song-a' }); await api.select({ hash: 'song-a' })
  assert.deepEqual(calls.map(call => call[0]), ['lyric-library:list', 'lyric-library:read', 'lyric-library:save-online', 'lyric-library:save-edit', 'lyric-library:select'])
  let received
  const dispose = api.onChanged((...args) => { received = args })
  const change = { hash: 'song-a', revision: 1, reason: 'select' }
  ipc.emit('lyric-library:changed', { privileged: true }, change)
  assert.deepEqual(received, [change])
  dispose()
  assert.equal(ipc.listenerCount('lyric-library:changed'), 0)
  assert.deepEqual(Object.keys(api).sort(), ['list', 'onChanged', 'read', 'saveEdit', 'saveOnline', 'select'])
})
