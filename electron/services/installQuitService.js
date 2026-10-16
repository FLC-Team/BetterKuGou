const net = require('node:net')
const { randomUUID } = require('node:crypto')
const defaultLogger = require('../logger')

const ERROR_CODES = new Set([
  'BUSY', 'PROTOCOL', 'TIMEOUT', 'SAVE_FAILED', 'RENDERER_UNAVAILABLE',
  'RENDERER_CHANGED', 'SHUTTING_DOWN'
])

/**
 * 接收安装器的固定本机协议；只有当前连接的保存回执已发送成功，才请求正常退出。
 * 默认命名管道沿用当前用户权限，绝不向所有用户开放读写。
 */
function createInstallQuitService(options = {}) {
  const endpoint = options.endpoint || `\\\\.\\pipe\\BetterKuGou.InstallQuit.v1.${process.pid}`
  const logger = options.logger || defaultLogger
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 1000
  const prepareTimeoutMs = options.prepareTimeoutMs ?? 10000
  const sockets = new Map()
  let server = null
  let startPromise = null
  let stopPromise = null
  let stopping = false
  let quitting = false
  let current = null

  function clearTimer(connection) {
    clearTimeout(connection.timer)
    connection.timer = null
  }

  function notify(payload) {
    try {
      return options.onPrepare?.(payload) !== false
    } catch (error) {
      logger.error('installer', '通知主窗口保存安装前状态失败', error)
      return false
    }
  }

  /** 先失效请求再通知渲染进程，防止同步或迟到回执重新触发退出。 */
  function cancel(errorCode = 'RENDERER_CHANGED', requestId) {
    if (!current || quitting || (requestId && current.requestId !== requestId)) return false
    const request = current
    current = null
    clearTimer(request.connection)
    notify({ requestId: request.requestId, phase: 'canceled', errorCode })
    if (!request.connection.socket.destroyed && !request.connection.socket.writableEnded) {
      request.connection.socket.end(`FAIL/1 ${ERROR_CODES.has(errorCode) ? errorCode : 'SAVE_FAILED'}\n`,
        () => request.connection.socket.destroy())
    }
    return true
  }

  function fail(connection, errorCode) {
    clearTimer(connection)
    if (!connection.socket.destroyed && !connection.socket.writableEnded) {
      connection.socket.end(`FAIL/1 ${errorCode}\n`, () => connection.socket.destroy())
    }
  }

  function armTimeout(connection, duration) {
    clearTimer(connection)
    connection.timer = setTimeout(() => {
      if (current?.connection === connection) cancel('TIMEOUT')
      else fail(connection, 'TIMEOUT')
    }, duration)
    connection.timer.unref?.()
  }

  function receiveLine(connection, line) {
    if (stopping || quitting) return fail(connection, 'SHUTTING_DOWN')
    if (connection.phase === 'hello' && line === 'HELLO/1') {
      connection.phase = 'ready'
      connection.socket.write('READY/1\n')
      armTimeout(connection, handshakeTimeoutMs)
      return
    }
    if (connection.phase !== 'ready' || line !== 'QUIT/1') {
      if (current?.connection === connection) cancel('PROTOCOL')
      else fail(connection, 'PROTOCOL')
      return
    }
    if (current) return fail(connection, 'BUSY')
    connection.phase = 'preparing'
    current = { requestId: randomUUID(), connection }
    armTimeout(connection, prepareTimeoutMs)
    if (!notify({ requestId: current.requestId, phase: 'prepare' })) cancel('RENDERER_UNAVAILABLE')
  }

  function accept(socket) {
    if (stopping || quitting || sockets.size >= 8) {
      // Do not wait for an unauthenticated peer to read a refusal: such sockets
      // are outside the bounded connection set and must not hold server.close().
      socket.destroy()
      return
    }
    const connection = { socket, phase: 'hello', buffer: '', timer: null }
    sockets.set(socket, connection)
    socket.setEncoding('utf8')
    armTimeout(connection, handshakeTimeoutMs)
    socket.on('data', chunk => {
      // The protocol has two short ASCII commands, never paths, JSON or renderer input.
      if (connection.buffer.length + chunk.length > 64 || /[^\x0a\x0d\x20-\x7e]/.test(chunk)) {
        if (current?.connection === connection) cancel('PROTOCOL')
        else fail(connection, 'PROTOCOL')
        return
      }
      connection.buffer += chunk
      let newline
      while (!socket.writableEnded && (newline = connection.buffer.indexOf('\n')) !== -1) {
        const line = connection.buffer.slice(0, newline).replace(/\r$/, '')
        connection.buffer = connection.buffer.slice(newline + 1)
        receiveLine(connection, line)
      }
    })
    const disconnect = () => {
      clearTimer(connection)
      sockets.delete(socket)
      if (current?.connection === connection) cancel('RENDERER_CHANGED')
    }
    socket.on('end', disconnect)
    socket.on('close', disconnect)
    socket.on('error', error => {
      logger.trace('installer', '安装器连接已中断', { code: error.code })
      disconnect()
    })
  }

  function start() {
    if (startPromise) return startPromise
    if (stopping) return Promise.resolve(false)
    startPromise = new Promise(resolve => {
      server = net.createServer(accept)
      server.on('error', error => {
        logger.error('installer', '安装退出协作管道失败，应用继续启动', error)
        cancel('SHUTTING_DOWN')
        resolve(false)
      })
      server.once('listening', () => resolve(true))
      try {
        server.listen(endpoint)
        server.unref()
      } catch (error) {
        logger.error('installer', '创建安装退出协作管道失败，应用继续启动', error)
        resolve(false)
      }
    })
    return startPromise
  }

  /** 仅接受当前请求的一次布尔结果，错误信息收敛为固定码，成功后走 app.quit。 */
  function complete(requestId, result) {
    if (stopping || quitting || !current || current.requestId !== requestId ||
      current.connection.phase !== 'preparing' || typeof result?.success !== 'boolean') return false
    if (!result.success) {
      cancel(ERROR_CODES.has(result.errorCode) ? result.errorCode : 'SAVE_FAILED', requestId)
      return true
    }
    const request = current
    const { connection } = request
    if (connection.socket.destroyed || connection.socket.writableEnded) {
      cancel('RENDERER_CHANGED', requestId)
      return false
    }
    connection.phase = 'reply'
    armTimeout(connection, handshakeTimeoutMs)
    connection.socket.end('SAVED/1\n', error => {
      if (error || current !== request || stopping || connection.socket.destroyed) return
      clearTimer(connection)
      current = null
      quitting = true
      try {
        options.onQuit?.()
      } catch (quitError) {
        // Saving has committed and shutdown has begun; never resume the application here.
        logger.error('installer', '保存完成后请求应用退出失败', quitError)
      } finally {
        connection.socket.destroy()
      }
    })
    return true
  }

  /** 不等待任何保存回执；主动失效、销毁连接后关闭监听，避免退出清理互相等待。 */
  function stop() {
    if (stopPromise) return stopPromise
    stopping = true
    stopPromise = Promise.resolve().then(async () => {
      cancel('SHUTTING_DOWN')
      if (startPromise) await startPromise
      for (const [socket, connection] of sockets) {
        clearTimer(connection)
        socket.destroy()
      }
      sockets.clear()
      if (server?.listening) await new Promise(resolve => server.close(resolve))
    })
    return stopPromise
  }

  return { start, stop, complete, cancel, getAddress: () => server?.address() }
}

module.exports = { createInstallQuitService }
