/** 渲染与主进程共用同一主题数据校验；调用方注入内置包，核心不读取文件或设置。 */
export function createThemeCatalog(defaultDark, defaultLight) {

  const THEME_FORMAT = 'betterkugou-theme'
  const THEME_SCHEMA_VERSION = 1
  const MAX_THEME_FILE_BYTES = 128 * 1024
  const MAX_INSTALLED_THEMES = 50

  function freezeTheme(theme) {
    Object.freeze(theme.tokens)
    return Object.freeze(theme)
  }

  const BUILTIN_THEMES = Object.freeze([freezeTheme(defaultDark), freezeTheme(defaultLight)])
  const THEME_TOKEN_NAMES = Object.freeze(Object.keys(defaultDark.tokens))
  const tokenNames = new Set(THEME_TOKEN_NAMES)
  const reservedIds = new Set(['dark', 'light', 'system', 'auto', 'custom'])
  const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype'])
  const supportedFunctions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'var', 'linear-gradient', 'radial-gradient', 'color-mix', 'cubic-bezier', 'invert', 'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'hue-rotate', 'opacity'])

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  /** 分享文件只接受数据对象；递归拒绝会影响对象原型的字段。 */
  function checkKeys(value, depth = 0) {
    if (depth > 8) throw new Error('主题包嵌套层级过深')
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) throw new Error('主题包包含不安全的字段')
      checkKeys(child, depth + 1)
    }
  }

  function textField(value, label, maxLength, fallback = '') {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`${label}格式错误或过长`)
    }
    return value.trim()
  }

  function cssPropertyForToken(name) {
    if (/filter$/.test(name)) return 'filter'
    if (/^--font-family$/.test(name)) return 'font-family'
    if (/^--font-size/.test(name)) return 'font-size'
    if (/radius/.test(name)) return 'border-radius'
    if (/^--spacing/.test(name)) return 'padding'
    if (/^--transition/.test(name)) return 'transition'
    if (/^--shadow/.test(name) && !/^--shadow-(?:primary|primary-hover|dark|dark-light)$/.test(name)) return 'box-shadow'
    if (/^--gradient/.test(name)) return 'background-image'
    return 'color'
  }

  /** 只允许已注册的视觉变量和无外部资源的 CSS 值，不载入任意 CSS 或脚本。 */
  function validateToken(name, value) {
    if (!tokenNames.has(name)) throw new Error(`不支持的主题变量：${name}`)
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[;{}@\\<>\u0000-\u001f]|\/\*|\*\//.test(value)) {
      throw new Error(`主题变量格式错误：${name}`)
    }
    const clean = value.trim()
    if (/url|expression|image-set|javascript|https?:|data:/i.test(clean)) throw new Error(`主题变量不能引用外部资源：${name}`)
    let balance = 0
    for (const char of clean) {
      if (char === '(') balance++
      if (char === ')') balance--
      if (balance < 0) break
    }
    if (balance !== 0) throw new Error(`主题变量括号不匹配：${name}`)
    for (const match of clean.matchAll(/([a-z][a-z-]*)\s*\(/gi)) {
      if (!supportedFunctions.has(match[1].toLowerCase())) throw new Error(`主题变量使用了不支持的函数：${name}`)
    }
    const references = [...clean.matchAll(/var\(([^)]*)\)/gi)]
    if (references.some(match => !tokenNames.has(match[1].trim()))) throw new Error(`主题变量引用不存在：${name}`)
    if (name.endsWith('-rgb')) {
      if (!/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(clean) || clean.split(',').some(channel => Number(channel) > 255)) {
        throw new Error(`RGB 主题变量格式错误：${name}`)
      }
      return clean
    }
    const property = cssPropertyForToken(name)
    if (['padding', 'border-radius', 'font-size'].includes(property)) {
      const match = clean.match(/^(\d+(?:\.\d+)?)(px|rem|em)$/)
      const pixelValue = match ? Number(match[1]) * (match[2] === 'px' ? 1 : 16) : NaN
      const maximum = name === '--radius-full' ? 9999 : property === 'font-size' ? 64 : 120
      if (!match || pixelValue > maximum || (property === 'font-size' && pixelValue < 8)) throw new Error(`主题尺寸超出范围：${name}`)
    } else if (property === 'font-family') {
      if (!/^[\p{L}\p{N}\s,'"-]+$/u.test(clean)) throw new Error('主题字体格式错误')
    } else if (property === 'transition') {
      if (!/^(?:\d+(?:\.\d+)?)(?:ms|s)\s+(?:linear|ease(?:-in|-out|-in-out)?|cubic-bezier\([\d.,\s-]+\))$/.test(clean)) throw new Error(`主题动效格式错误：${name}`)
    } else if (property === 'filter') {
      if (!/^(?:none|(?:(?:invert|brightness|contrast|saturate|grayscale|sepia|hue-rotate|opacity)\([\d.]+(?:%|deg)?\)\s*)+)$/.test(clean)) throw new Error(`图标滤镜格式错误：${name}`)
    } else if (property === 'color' && !/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|transparent|currentColor|(?:rgba?|hsla?|var|color-mix)\(.+\))$/i.test(clean)) {
      throw new Error(`主题颜色格式错误：${name}`)
    } else if (property === 'background-image' && !/^(?:none|(?:linear-gradient|radial-gradient|var)\(.+\))$/.test(clean)) {
      throw new Error(`主题渐变格式错误：${name}`)
    }
    return clean
  }

  function splitCssArguments(value) {
    let depth = 0
    let start = 0
    const parts = []
    for (let index = 0; index < value.length; index++) {
      if (value[index] === '(') depth++
      if (value[index] === ')') depth--
      if (value[index] === ',' && depth === 0) {
        parts.push(value.slice(start, index).trim())
        start = index + 1
      }
    }
    parts.push(value.slice(start).trim())
    return parts
  }

  const cssNumber = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/
  const cssLength = /^(?:0|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em))$/i

  function isColor(value) {
    if (/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|transparent|currentColor)$/i.test(value)) return true
    const func = value.match(/^(rgb|rgba|hsl|hsla|color-mix)\((.*)\)$/i)
    if (!func) return false
    const parts = splitCssArguments(func[2])
    if (func[1].toLowerCase() === 'color-mix') {
      if (parts.length !== 3 || !/^in (?:srgb|srgb-linear|hsl|hwb|lab|lch|oklab|oklch)$/i.test(parts[0])) return false
      const weights = []
      const valid = parts.slice(1).every(part => {
        const weight = part.match(/\s+([+-]?[\d.]+)%$/)
        if (weight) {
          const number = Number(weight[1])
          if (!Number.isFinite(number) || number < 0 || number > 100) return false
          weights.push(number)
        }
        return isColor(weight ? part.slice(0, weight.index) : part)
      })
      return valid && (weights.length < 2 || weights[0] + weights[1] > 0)
    }
    let channels
    let alpha
    if (parts.length > 1) {
      if (![3, 4].includes(parts.length)) return false
      channels = parts.slice(0, 3)
      alpha = parts[3]
    } else {
      const sides = func[2].split('/')
      if (sides.length > 2) return false
      channels = sides[0].trim().split(/\s+/)
      alpha = sides[1]?.trim()
    }
    if (channels.length !== 3 || (alpha !== undefined && !cssNumber.test(alpha))) return false
    if (/^hsl/i.test(func[1])) {
      return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|grad|rad|turn)?$/i.test(channels[0])
        && channels.slice(1).every(channel => cssNumber.test(channel) && channel.endsWith('%'))
    }
    return channels.every(channel => cssNumber.test(channel)) && (parts.length === 1
      || channels.every(channel => channel.endsWith('%') === channels[0].endsWith('%')))
  }

  function colorPrefix(value) {
    if (!value.includes('(')) return value.split(/\s+/)[0]
    let depth = 0
    for (let index = 0; index < value.length; index++) {
      if (value[index] === '(') depth++
      if (value[index] === ')' && --depth === 0) return value.slice(0, index + 1)
    }
    return ''
  }

  function isGradient(value) {
    if (value === 'none') return true
    const func = value.match(/^(linear-gradient|radial-gradient)\((.*)\)$/i)
    if (!func) return false
    const parts = splitCssArguments(func[2])
    if (!isColor(colorPrefix(parts[0]))) {
      const first = parts.shift()
      if (func[1].toLowerCase() === 'linear-gradient') {
        if (!/^(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|grad|rad|turn)|to (?:(?:left|right|top|bottom)(?: (?:left|right|top|bottom))?))$/i.test(first)) return false
      } else if (!/^(?:(?:circle|ellipse|closest-side|farthest-side|closest-corner|farthest-corner|at|left|right|top|bottom|center|[\d.]+(?:px|%|rem|em))(?:\s+|$))+$/i.test(first)) return false
    }
    return parts.length >= 2 && parts.every(stop => {
      const color = colorPrefix(stop)
      if (!isColor(color)) return false
      const positions = stop.slice(color.length).trim()
      return !positions || positions.split(/\s+/).every(position => cssLength.test(position) || /^[+-]?[\d.]+%$/.test(position))
    })
  }

  function isShadow(value) {
    if (value === 'none') return true
    return splitCssArguments(value).every(shadow => {
      let validColors = true
      let colors = 0
      // 已展开的颜色函数没有变量嵌套；color-mix 由平衡括号扫描处理。
      let remaining = ''
      for (let index = 0; index < shadow.length;) {
        const tail = shadow.slice(index)
        const start = tail.match(/^(?:rgba?|hsla?|color-mix)\(/i)
        if (start) {
          const color = colorPrefix(tail)
          if (!color || !isColor(color)) { validColors = false; break }
          colors++
          remaining += ' '
          index += color.length
        } else {
          remaining += shadow[index++]
        }
      }
      const words = remaining.trim().split(/\s+/)
      const lengths = []
      let insets = 0
      for (const word of words) {
        if (/^inset$/i.test(word)) insets++
        else if (isColor(word)) colors++
        else if (cssLength.test(word)) lengths.push(parseFloat(word))
        else return false
      }
      return validColors && colors <= 1 && insets <= 1 && lengths.length >= 2 && lengths.length <= 4
        && (lengths.length < 3 || lengths[2] >= 0)
    })
  }

  /** 不依赖浏览器的语法检查，让主进程和渲染进程筛选出相同的有效主题。 */
  function validateResolvedTokens(tokens) {
    const resolved = new Map()
    function expand(name) {
      if (resolved.has(name)) return resolved.get(name)
      let length = 0
      const value = tokens[name].replace(/var\(([^)]*)\)/gi, (_match, reference) => {
        const replacement = expand(reference.trim())
        length += replacement.length
        if (length > 8192) throw new Error('主题变量引用展开过长')
        return replacement
      })
      if (value.length > 8192) throw new Error('主题变量引用展开过长')
      resolved.set(name, value)
      return value
    }
    for (const name of Object.keys(tokens)) {
      const value = expand(name)
      const property = cssPropertyForToken(name)
      let valid = true
      if (name.endsWith('-rgb')) continue
      if (property === 'color') valid = isColor(value)
      if (property === 'box-shadow') valid = isShadow(value)
      if (property === 'background-image') valid = isGradient(value)
      if (property === 'filter') valid = /^(?:none|(?:(?:invert|brightness|contrast|saturate|grayscale|sepia|hue-rotate|opacity)\((?:\d+(?:\.\d+)?|\.\d+)(?:%|deg)?\)\s*)+)$/.test(value)
      if (property === 'font-family') valid = value.split(',').every(font => /^(?:"[^"']+"|'[^"']+'|[\p{L}\p{N} -]+)$/u.test(font.trim()))
      if (property === 'transition' && /cubic-bezier/i.test(value)) {
        const points = value.match(/cubic-bezier\((.*)\)/)[1].split(',').map(point => point.trim())
        valid = points.length === 4 && points.every(point => cssNumber.test(point) && !point.endsWith('%'))
          && Number(points[0]) >= 0 && Number(points[0]) <= 1 && Number(points[2]) >= 0 && Number(points[2]) <= 1
      }
      if (!valid) throw new Error(`主题变量值无效：${name}`)
      if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports(property, value)) {
        throw new Error(`浏览器不支持的主题变量值：${name}`)
      }
    }
  }

  function assertNoTokenCycles(tokens) {
    const checked = new Set()
    const visiting = new Set()
    function visit(name) {
      if (checked.has(name)) return
      if (visiting.has(name)) throw new Error(`主题变量循环引用：${name}`)
      visiting.add(name)
      for (const match of tokens[name].matchAll(/var\(([^)]*)\)/gi)) visit(match[1].trim())
      visiting.delete(name)
      checked.add(name)
    }
    Object.keys(tokens).forEach(visit)
  }

  /** 校验版本、元数据和变量，并补全继承的默认值；返回干净且可独立分享的完整包。 */
  function normalizeThemePackage(input, { allowBuiltin = false } = {}) {
    if (!isRecord(input)) throw new Error('请选择有效的主题包 JSON 文件')
    checkKeys(input)
    if (input.format !== THEME_FORMAT) throw new Error('这不是 BetterKuGou 主题包')
    if (input.schemaVersion !== THEME_SCHEMA_VERSION) throw new Error('主题包版本不受支持，请使用版本 1')
    const id = textField(input.id, '主题 ID', 64)
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || (!allowBuiltin && reservedIds.has(id))) throw new Error('主题 ID 无效或与内置主题冲突')
    const name = textField(input.name, '主题名称', 80)
    if (!name) throw new Error('主题名称不能为空')
    if (!['dark', 'light'].includes(input.base)) throw new Error('主题基础配色必须为 dark 或 light')
    const version = textField(input.version, '主题版本', 32, '1.0.0')
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('主题版本格式应为 1.0.0')
    if (!isRecord(input.tokens) || !Object.keys(input.tokens).length) throw new Error('主题包缺少视觉变量')
    const base = BUILTIN_THEMES.find(theme => theme.id === input.base)
    const tokens = { ...base.tokens }
    for (const [key, value] of Object.entries(input.tokens)) tokens[key] = validateToken(key, value)
    assertNoTokenCycles(tokens)
    validateResolvedTokens(tokens)
    return {
      format: THEME_FORMAT, schemaVersion: THEME_SCHEMA_VERSION, id, name, version,
      author: textField(input.author, '作者', 80), description: textField(input.description, '主题说明', 240),
      base: input.base, tokens
    }
  }

  function parseThemePackage(source) {
    if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > MAX_THEME_FILE_BYTES) throw new Error('主题包不能超过 128 KB')
    let parsed
    try {
      parsed = JSON.parse(source.replace(/^\uFEFF/, ''))
    } catch {
      throw new Error('主题包不是有效的 JSON 文件')
    }
    return normalizeThemePackage(parsed)
  }

  function serializeThemePackage(theme) {
    return JSON.stringify(normalizeThemePackage(theme), null, 2) + '\n'
  }

  /** 设置文件可能来自旧版本或手工编辑；忽略损坏包，保留内置主题作为回退。 */
  function listThemePackages(custom = {}) {
    const themes = [...BUILTIN_THEMES]
    const seen = new Set(themes.map(theme => theme.id))
    if (!Array.isArray(custom.themePackages)) return themes
    for (const candidate of custom.themePackages.slice(0, MAX_INSTALLED_THEMES)) {
      try {
        const theme = normalizeThemePackage(candidate)
        if (!seen.has(theme.id)) {
          themes.push(theme)
          seen.add(theme.id)
        }
      } catch {
        // 不让单个损坏的已安装主题阻止设置加载；主题列表只呈现可用包。
      }
    }
    return themes
  }

  function getThemePackage(id, custom = {}) {
    const builtin = BUILTIN_THEMES.find(theme => theme.id === id)
    if (builtin) return builtin
    if (!Array.isArray(custom.themePackages)) return null
    for (const candidate of custom.themePackages.slice(0, MAX_INSTALLED_THEMES)) {
      if (candidate?.id !== id) continue
      try {
        return normalizeThemePackage(candidate)
      } catch {
        // 与列表过滤规则一致，损坏包不阻断同 ID 的后续可用包或默认回退。
      }
    }
    return null
  }

  return { THEME_FORMAT, THEME_SCHEMA_VERSION, MAX_THEME_FILE_BYTES, MAX_INSTALLED_THEMES, BUILTIN_THEMES, THEME_TOKEN_NAMES, normalizeThemePackage, parseThemePackage, serializeThemePackage, listThemePackages, getThemePackage }
}
