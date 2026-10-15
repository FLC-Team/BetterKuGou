/**
 * 主进程统一日志：默认只输出关键事件；BK_LOG_LEVEL 或 DEBUG 显式开启诊断。
 */
const LOG_LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 }
const configuredLevel = process.env.BK_LOG_LEVEL || (process.env.DEBUG ? 'trace' : 'info')
const logLevel = Object.hasOwn(LOG_LEVELS, configuredLevel) ? configuredLevel : 'info'

function write(type, module, message, ...details) {
  if (LOG_LEVELS[type] < LOG_LEVELS[logLevel]) return
  const prefix = `[${new Date().toISOString()}] [${module}/${type.toUpperCase()}]: ${message}`
  const method = type === 'error' ? 'error' : type === 'warn' ? 'warn' : type === 'trace' || type === 'debug' ? 'debug' : 'info'
  console[method](prefix, ...details)
}

module.exports = {
  logLevel,
  trace: (module, message, ...details) => write('trace', module, message, ...details),
  debug: (module, message, ...details) => write('debug', module, message, ...details),
  info: (module, message, ...details) => write('info', module, message, ...details),
  warn: (module, message, ...details) => write('warn', module, message, ...details),
  error: (module, message, ...details) => write('error', module, message, ...details)
}
