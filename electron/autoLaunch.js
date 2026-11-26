const logger = require('./logger')

const PLATFORM = process.platform
const IS_WINDOWS = PLATFORM === 'win32'
const IS_MAC = PLATFORM === 'darwin'
const IS_SUPPORTED = IS_WINDOWS || IS_MAC
const loginArgument = '--bk-login-start'

function getLoginItemOptions() {
  const options = {}
  if (IS_WINDOWS || PLATFORM === 'linux') {
    options.path = process.execPath
  }
  if (IS_WINDOWS) options.args = [loginArgument]
  return options
}

function isAutoLaunchSupported() {
  return IS_SUPPORTED
}

/** Distinguish the initial login window from a deliberate launch without changing its presentation. */
function isLoginLaunchCommand(argv) {
  return Array.isArray(argv) && argv.includes(loginArgument)
}

function wasOpenedAtLogin(app) {
  if (isLoginLaunchCommand(process.argv)) return true
  if (!IS_MAC) return false
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true
  } catch (error) {
    logger.warn('autoLaunch', '无法确认启动来源，等待前台操作或播放后再计活跃', { code: error.code || error.name })
    return true
  }
}

function getAutoLaunchEnabled(app) {
  if (!isAutoLaunchSupported()) {
    return false
  }
  const options = getLoginItemOptions()
  try {
    const settings = app.getLoginItemSettings(options)
    return Boolean(settings?.openAtLogin)
  } catch (err) {
    logger.warn('autoLaunch', '读取自启状态失败', err)
    throw Object.assign(new Error('AUTO_LAUNCH_READ_FAILED'), { code: 'AUTO_LAUNCH_READ_FAILED', cause: err })
  }
}

function setAutoLaunchEnabled(app, enabled) {
  if (!isAutoLaunchSupported()) {
    const error = new Error('AUTO_LAUNCH_UNSUPPORTED')
    error.code = 'AUTO_LAUNCH_UNSUPPORTED'
    throw error
  }
  const options = getLoginItemOptions()
  options.openAtLogin = Boolean(enabled)
  if (IS_MAC) {
    options.openAsHidden = Boolean(enabled)
  }
  try {
    app.setLoginItemSettings(options)
    return getAutoLaunchEnabled(app)
  } catch (err) {
    logger.error('autoLaunch', '设置自启失败', err)
    throw Object.assign(new Error('AUTO_LAUNCH_WRITE_FAILED'), { code: 'AUTO_LAUNCH_WRITE_FAILED', cause: err })
  }
}

module.exports = {
  isAutoLaunchSupported,
  isLoginLaunchCommand,
  wasOpenedAtLogin,
  getAutoLaunchEnabled,
  setAutoLaunchEnabled
}
