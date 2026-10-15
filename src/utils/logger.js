// 渲染日志统一过滤级别、脱敏并限制内存保留数量。
const LOG_LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 }
const MAX_LOGS = 500
const SENSITIVE_KEY = /token|password|^pwd$|cookie|authorization|access.?key|^key$|qrcode|qrimg|base64|secu_params|captcha|mobile|phone|userid|username|nickname|avatar|email/i

function sanitizeText(value) {
  if (/^\s*[\[{]/.test(value)) {
    try { return JSON.stringify(sanitizeData(JSON.parse(value))).slice(0, 4000) } catch { /* 普通诊断文本继续使用字段脱敏。 */ }
  }
  return value
    .replace(/Bearer\s+[\w.~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|vip_token|cookie|password|pwd|key|accesskey|captcha|mobile|userid|username)(=|%3D)[^&\s]+/gi, '$1$2[REDACTED]')
    .slice(0, 4000)
}

/** 将诊断数据转成 IPC 可序列化的副本；不保留凭证、请求配置或循环引用。 */
function sanitizeData(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') return sanitizeText(value)
  if (typeof value === 'bigint') return String(value)
  if (value == null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? String(value) : value
  }
  if (depth > 6) return '[DEPTH LIMIT]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (value instanceof Error || (typeof value.message === 'string' && typeof value.stack === 'string')) {
    const diagnostic = {
      name: value.name,
      message: value.message,
      code: value.code,
      stack: value.stack,
      cause: value.cause,
      status: value.response?.status
    }
    return Object.fromEntries(Object.entries(diagnostic).map(([key, item]) =>
      [key, sanitizeData(item, seen, depth + 1)]
    ))
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map(item => sanitizeData(item, seen, depth + 1))
  }
  const output = Object.create(null)
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeData(item, seen, depth + 1)
  }
  return output
}

class Logger {
  constructor() {
    this.logs = []
    this.logLevel = 'info'
    this._bridgeFailureReported = false
    void this._init()
  }

  async _init() {
    try {
      const result = await window.electronAPI?.initLogger?.()
      if (result?.success && Object.hasOwn(LOG_LEVELS, result.logLevel)) {
        this.logLevel = result.logLevel
      }
    } catch (error) {
      this._reportBridgeFailure(error)
    }
  }

  _shouldLog(type) {
    return LOG_LEVELS[type] >= (LOG_LEVELS[this.logLevel] ?? LOG_LEVELS.info)
  }

  _reportBridgeFailure(error) {
    if (this._bridgeFailureReported) return
    this._bridgeFailureReported = true
    console.warn('logger', '日志桥接不可用，继续使用控制台', sanitizeData(error))
  }

  /** 控制台、内存及主进程使用同一脱敏快照；日志桥接失败不干扰业务。 */
  _write(type, module, message, ...details) {
    if (!this._shouldLog(type)) return
    const entry = {
      type,
      module: sanitizeText(String(module)),
      message: sanitizeText(String(message)),
      timestamp: new Date().toISOString()
    }
    if (details.length) entry.data = sanitizeData(details.length === 1 ? details[0] : details)
    this.logs.push(entry)
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)

    const method = type === 'error' ? 'error' : type === 'warn' ? 'warn' : type === 'trace' || type === 'debug' ? 'debug' : 'info'
    console[method](entry.module, entry.message, ...(details.length ? [entry.data] : []))
    try {
      const pending = window.electronAPI?.writeLog?.(entry)
      Promise.resolve(pending).catch(error => this._reportBridgeFailure(error))
    } catch (error) {
      this._reportBridgeFailure(error)
    }
  }

  trace(module, message, ...details) { this._write('trace', module, message, ...details) }
  debug(module, message, ...details) { this._write('debug', module, message, ...details) }
  info(module, message, ...details) { this._write('info', module, message, ...details) }
  warn(module, message, ...details) { this._write('warn', module, message, ...details) }
  error(module, message, ...details) { this._write('error', module, message, ...details) }

  getLogs() { return this.logs.slice() }
  clear() { this.logs = [] }
}

export const logger = new Logger()
