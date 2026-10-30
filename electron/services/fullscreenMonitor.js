const path = require('node:path')
const { createWindowsForegroundMonitor } = require('./windowsForeground')

/** 灵动岛复用共享 Windows 检测器，只适配按需启停和状态通知，不再创建第二套探针协议。 */
function createFullscreenMonitor({ onChange, logger, platform = process.platform,
  scriptPath = path.join(__dirname, 'windowsForeground.ps1') } = {}) {
  const supported = platform === 'win32'
  let active = false
  let generation = 0
  let lastKey = JSON.stringify({ fullscreen: false })
  let stopping = Promise.resolve()

  function publish(sample) {
    const key = JSON.stringify(sample)
    if (key === lastKey) return
    lastKey = key
    try { onChange?.(sample) } catch (error) {
      logger?.warn('fullscreen-monitor', '发布全屏检测状态失败', error)
    }
  }

  const monitor = supported ? createWindowsForegroundMonitor({
    scriptPath, platform,
    onChange: sample => { if (active) publish(sample) },
    onError: error => {
      active = false
      publish({ fullscreen: false })
      logger?.warn('fullscreen-monitor', '全屏检测已停止，可重新开启重试', error)
    }
  }) : null

  /** 先排空旧进程再配置共享检测器；开启/关闭交错时只保留最后一次意图。 */
  function start() {
    if (!supported) return false
    if (active) return true
    active = true
    const request = ++generation
    stopping = monitor.stop()
    void stopping.then(() => {
      if (!active || request !== generation) return
      return monitor.configure({ enabled: true, efficientMode: true })
    }).catch(error => {
      if (request !== generation) return
      active = false
      publish({ fullscreen: false })
      logger?.warn('fullscreen-monitor', '启动全屏检测失败', error)
    })
    return true
  }

  function stop() {
    active = false
    generation += 1
    publish({ fullscreen: false })
    stopping = monitor ? monitor.stop() : Promise.resolve()
    return stopping
  }

  return { supported, isActive: () => active, start, stop }
}

module.exports = { createFullscreenMonitor }
