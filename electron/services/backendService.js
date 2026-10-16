const logger = require('../logger')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { utilityProcess } = require('electron')

const BACKEND_PORT = 6500
const STARTUP_TIMEOUT = 10_000
const HEALTH_RETRY_DELAY = 100
const STOP_TIMEOUT = 5000

/** 管理单个本地 API 进程，启动、健康检查和停止共享同一生命周期。 */
function createBackendService({
  isDev,
  developmentRoot,
  resourcesPath,
  onProgress = () => {},
  onStatus = () => {},
  isQuitting = () => false
}) {
  let backendProcess = null
  let startupTimer = null
  let healthTimer = null
  let healthRequest = null
  let stopPromise = null
  let readinessPromise = Promise.resolve(false)
  let resolveReadiness = null
  let lastStartupError = null

  function resolveBackend() {
    const directory = isDev
      ? path.join(developmentRoot, 'KuGouMusicApi')
      : path.join(resourcesPath, 'backend')

    return {
      directory,
      entry: path.join(directory, 'app.js')
    }
  }

  function cancelHealthCheck() {
    if (healthTimer) clearTimeout(healthTimer)
    healthTimer = null
    if (healthRequest) {
      const request = healthRequest
      healthRequest = null
      request.destroy()
    }
  }

  function clearTimers() {
    if (startupTimer) clearTimeout(startupTimer)
    startupTimer = null
    cancelHealthCheck()
  }

  /** 同一次启动共享结果；终止时解除等待并释放探测，避免渲染入口悬挂。 */
  function completeReadiness(ready) {
    const resolve = resolveReadiness
    resolveReadiness = null
    clearTimers()
    if (resolve) resolve(ready)
    else readinessPromise = Promise.resolve(ready)
  }

  function waitUntilReady() {
    return backendProcess && !stopPromise ? readinessPromise : Promise.resolve(false)
  }

  /** 立即探测当前实例；启动期短暂失败重试，统一启动期限防止无限等待。 */
  function checkHealth() {
    if (!backendProcess || stopPromise) return
    const processToCheck = backendProcess
    cancelHealthCheck()
    logger.trace('backendService', '🔍 测试后端连接...')

    let request = null
    const handleFailure = (error) => {
      if (backendProcess !== processToCheck || stopPromise || (request && healthRequest !== request)) return
      healthRequest = null
      request?.destroy()
      if (resolveReadiness) {
        lastStartupError = error
        healthTimer = setTimeout(() => {
          healthTimer = null
          if (backendProcess === processToCheck && !stopPromise) checkHealth()
        }, HEALTH_RETRY_DELAY)
      } else {
        completeReadiness(false)
        logger.error('backendService', '❌ 后端连接测试失败:', error)
        onStatus({ status: 'disconnected', error: error.message })
      }
    }

    try {
      request = http.request({
        hostname: 'localhost',
        port: BACKEND_PORT,
        path: '/',
        method: 'GET',
        timeout: 5000
      }, (response) => {
        response.resume()
        if (healthRequest !== request || backendProcess !== processToCheck || stopPromise) return
        if (typeof response.statusCode !== 'number' || response.statusCode < 200 || response.statusCode >= 300) {
          handleFailure(new Error(`Backend HTTP ${response.statusCode}`))
          return
        }
        completeReadiness(true)
        logger.trace('backendService', '✅ 后端连接测试成功，状态码:', response.statusCode)
        onProgress(70, '后端服务就绪', 'backend')
        onStatus({ status: 'connected', port: BACKEND_PORT })
      })
      healthRequest = request

      request.on('error', handleFailure)

      request.on('timeout', () => {
        request.destroy(new Error('Backend health check timed out'))
      })
      request.once('close', () => {
        if (healthRequest === request) healthRequest = null
      })

      request.end()
    } catch (error) {
      handleFailure(error)
    }
  }

  function start() {
    if (stopPromise) return backendProcess
    if (backendProcess) return backendProcess
    clearTimers()
    lastStartupError = null
    readinessPromise = new Promise(resolve => { resolveReadiness = resolve })

    onProgress(10, '正在启动后端服务...', 'backend')
    const { directory, entry } = resolveBackend()

    logger.trace('backendService', '🚀 启动后端服务器...')
    logger.trace('backendService', '📁 后端文件路径:', entry)
    logger.trace('backendService', '📁 工作目录:', directory)
    logger.trace('backendService', '🔧 环境:', isDev ? '开发环境' : '生产环境')

    if (!fs.existsSync(entry) || !fs.existsSync(directory)) {
      const error = new Error(`后端文件不存在: ${entry}`)
      logger.error('backendService', '❌', error.message)
      onProgress(30, '后端启动失败', 'backend')
      onStatus({ status: 'error', error: error.message })
      completeReadiness(false)
      return null
    }

    const env = { ...process.env, PORT: String(BACKEND_PORT), HOST: 'localhost' }
    let launchedProcess
    try {
      launchedProcess = utilityProcess.fork(path.resolve(entry), [], {
        stdio: 'pipe',
        cwd: directory,
        env,
        serviceName: 'BetterKuGou API'
      })
    } catch (error) {
      logger.error('backendService', '❌ 启动后端进程失败:', error)
      onProgress(30, '后端启动失败', 'backend')
      onStatus({ status: 'error', error: error.message })
      completeReadiness(false)
      return null
    }
    backendProcess = launchedProcess

    launchedProcess.stdout.on('data', (data) => {
      if (backendProcess !== launchedProcess || stopPromise) return
      const message = data.toString().trim()
      logger.trace('backendService', `📤 [后端输出] ${message}`)
      if (resolveReadiness && (message.includes('listening') || message.includes('started') || message.includes(String(BACKEND_PORT)))) {
        onProgress(40, '后端服务已启动', 'backend')
        onStatus({ status: 'running', port: BACKEND_PORT })
      }
    })

    launchedProcess.stderr.on('data', (data) => {
      const message = data.toString().trim()
      logger.error('backendService', `📥 [后端错误] ${message}`)
    })

    launchedProcess.on('error', (error) => {
      if (backendProcess !== launchedProcess || stopPromise) return
      logger.error('backendService', '❌ 启动后端进程失败:', error)
      completeReadiness(false)
      onStatus({ status: 'error', error: error.message })
    })

    launchedProcess.once('exit', (code) => {
      logger.trace('backendService', `🔚 后端进程退出，退出代码: ${code}`)
      if (code !== 0 && !isQuitting()) logger.error('backendService', '❌ 后端异常退出')
      if (backendProcess === launchedProcess) {
        backendProcess = null
        completeReadiness(false)
        onStatus({ status: 'disconnected', port: BACKEND_PORT, exitCode: code })
      }
    })

    startupTimer = setTimeout(() => {
      startupTimer = null
      if (backendProcess !== launchedProcess || stopPromise) return
      const error = new Error('Backend startup timed out', { cause: lastStartupError })
      completeReadiness(false)
      logger.error('backendService', '❌ 后端启动超时:', error)
      onProgress(30, '后端启动超时', 'backend')
      onStatus({ status: 'error', error: error.message })
    }, STARTUP_TIMEOUT)
    checkHealth()

    return launchedProcess
  }

  /** 复用正在执行的停止任务，并在退出或失败时释放定时器与监听器。 */
  function stop() {
    if (stopPromise) return stopPromise
    completeReadiness(false)
    const processToStop = backendProcess
    if (!processToStop) {
      logger.trace('backendService', '🔄 后端服务器未运行，跳过关闭')
      return Promise.resolve()
    }

    logger.trace('backendService', '🛑 正在关闭后端服务器...')
    let resolveStop
    let rejectStop
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve
      rejectStop = reject
    })
    const pendingStop = stopPromise
    const pid = processToStop.pid
    let stopTimer = null
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      if (stopTimer) clearTimeout(stopTimer)
      processToStop.removeListener('exit', handleExit)
      if (!error && backendProcess === processToStop) {
        backendProcess = null
        onStatus({ status: 'disconnected', port: BACKEND_PORT })
      }
      stopPromise = null
      if (error) rejectStop(error)
      else resolveStop()
    }
    const handleExit = () => finish()
    processToStop.once('exit', handleExit)

    stopTimer = setTimeout(() => {
      stopTimer = null
      if (settled) return
      logger.warn('backendService', '⚠️ 后端进程未及时退出，强制清理进程树')
      if (process.platform === 'win32' && pid) {
        try {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true
          })
          killer.once('close', (code) => finish(code === 0 ? null : new Error(`taskkill exited with code ${code}`)))
          killer.once('error', finish)
        } catch (error) {
          finish(error)
        }
      } else {
        try {
          if (!pid) throw new Error('Backend PID is unavailable for forced shutdown')
          process.kill(pid, 'SIGKILL')
          finish()
        } catch (error) {
          // ESRCH 表示进程已经退出；其延迟退出事件仍不能影响之后的新实例。
          finish(error.code === 'ESRCH' ? null : error)
        }
      }
    }, STOP_TIMEOUT)
    try {
      processToStop.kill()
    } catch (error) {
      logger.error('backendService', '❌ 关闭后端进程失败，将尝试强制清理:', error)
    }
    return pendingStop
  }

  return {
    start,
    stop,
    checkHealth,
    waitUntilReady,
    isRunning: () => Boolean(backendProcess)
  }
}

module.exports = {
  BACKEND_PORT,
  createBackendService
}
