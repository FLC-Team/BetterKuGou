const path = require('node:path')
const { createAudioEffectsService } = require('./audioEffectsService')
const { createAudioEffectsMedia } = require('./audioEffectsMedia')

/** Register a fixed capability surface; native paths and process handles stay in the main process. */
function createAudioEffectsIntegration({ app, ipcMain, protocol, utilityProcess, MessageChannelMain, dialog,
  getMainWindow, isMainWindowSender, isQuitting, getSettings, setSettings, logger }) {
  const nativeDirectory = app.isPackaged ? path.join(process.resourcesPath, 'audio-effects', `${process.platform}-${process.arch}`)
    : path.join(app.getAppPath(), 'native', 'audio-effects', 'bin', `${process.platform}-${process.arch}`)
  const service = createAudioEffectsService({
    root: path.join(app.getPath('userData'), 'audio-effects'),
    nativePath: path.join(nativeDirectory, process.platform === 'win32' ? 'bk-audio-host.exe' : 'bk-audio-host'),
    workerPath: app.isPackaged ? path.join(process.resourcesPath, 'audio-effects', 'audioEffectsWorker.cjs')
      : path.join(app.getAppPath(), 'electron', 'services', 'audioEffectsWorker.cjs'),
    utilityProcess, logger, persistConfig: audioEffects => setSettings({ audioEffects }),
    onStatus: state => { const window = getMainWindow(); if (!isQuitting() && window && !window.isDestroyed()) window.webContents.send('audio-effects:status', state) }
  })
  const media = createAudioEffectsMedia()
  let directorySelection = false, connectionEpoch = 0, lifetimeEpoch = 0
  const channels = []
  function handle(operation, action) {
    const channel = `audio-effects:${operation}`
    channels.push(channel)
    ipcMain.handle(channel, async (event, request) => {
      if (isQuitting() || !isMainWindowSender(event)) throw new Error('此窗口不能操作音频效果')
      return action(request, event)
    })
  }
  for (const operation of ['getStatus', 'listPlugins', 'scan', 'cancelScan', 'addPlugin', 'removePlugin', 'movePlugin',
    'setBypass', 'setEnabled', 'setBufferMs', 'openEditor', 'closeEditor', 'setTempoOverride', 'retry', 'retrySave']) {
    handle(operation, request => service[operation](request))
  }
  handle('chooseDirectory', async (_request, event) => {
    if (directorySelection) throw new Error('正在选择插件目录')
    directorySelection = true
    const epoch = lifetimeEpoch
    try {
      const result = await dialog.showOpenDialog(getMainWindow(), { title: '添加 VST3 插件目录', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths?.[0]) return null
      if (isQuitting() || epoch !== lifetimeEpoch || !isMainWindowSender(event)) throw new Error('窗口已改变，请重新选择目录')
      return service.addDirectory(result.filePaths[0])
    } finally { directorySelection = false }
  })
  handle('acquireMedia', request => media.acquire(request))
  handle('releaseMedia', leaseId => media.release(leaseId))
  handle('connectAudio', async (connectionId, event) => {
    if (typeof connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId)) throw new Error('音效连接标识无效')
    const epoch = ++connectionEpoch
    const { port1, port2 } = new MessageChannelMain()
    try {
      await service.connectAudio(port1)
      if (isQuitting() || epoch !== connectionEpoch || !isMainWindowSender(event)) throw new Error('音效连接已过期')
      event.sender.postMessage('audio-effects:port', { connectionId }, [port2])
      return { connectionId }
    } catch (failure) { port1.close(); port2.close(); throw failure }
  })
  protocol.handle('bk-audio', request => media.handleRequest(request))
  return {
    initialize: () => service.initialize(getSettings().audioEffects),
    configure: settings => service.configure(settings.audioEffects),
    reset() { ++connectionEpoch; ++lifetimeEpoch; media.dispose(); void service.releaseAudio().catch(failure => logger.warn('audio-effects', '释放播放连接失败', failure)) },
    async stop() {
      ++connectionEpoch; ++lifetimeEpoch; media.dispose()
      try { await service.stop() }
      finally { for (const channel of channels) ipcMain.removeHandler(channel); protocol.unhandle('bk-audio') }
    },
    getStatus: service.getStatus
  }
}
module.exports = { createAudioEffectsIntegration }
