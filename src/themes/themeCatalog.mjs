import postcss from 'postcss'

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

  // Advanced styles are parsed as CSS, then rebuilt from accepted nodes. No raw stylesheet is injected.
  const visualProperties = new Set((`color background background-color background-image background-position background-size background-repeat background-origin background-clip background-blend-mode
    opacity content border border-width border-style border-color border-top border-right border-bottom border-left border-top-width border-right-width border-bottom-width border-left-width
    border-top-color border-right-color border-bottom-color border-left-color border-radius border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius
    outline outline-width outline-style outline-color outline-offset box-shadow text-shadow filter backdrop-filter -webkit-backdrop-filter
    font font-family font-size font-weight font-style font-variant line-height letter-spacing word-spacing text-align text-transform text-decoration text-decoration-color text-decoration-thickness text-underline-offset text-indent text-overflow white-space word-break overflow-wrap
    width height min-width min-height max-width max-height aspect-ratio padding padding-top padding-right padding-bottom padding-left padding-inline padding-block margin margin-top margin-right margin-bottom margin-left margin-inline margin-block gap row-gap column-gap
    display visibility overflow overflow-x overflow-y box-sizing position top right bottom left inset z-index float clear isolation
    flex flex-grow flex-shrink flex-basis flex-direction flex-wrap align-items align-content align-self justify-content justify-items justify-self order
    grid grid-template grid-template-columns grid-template-rows grid-auto-columns grid-auto-rows grid-auto-flow grid-column grid-row grid-column-start grid-column-end grid-row-start grid-row-end
    transform transform-origin translate rotate scale transition transition-property transition-duration transition-delay transition-timing-function
    object-fit object-position vertical-align list-style-type fill fill-opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin
    accent-color caret-color color-scheme scrollbar-color scrollbar-width -webkit-text-fill-color -webkit-text-stroke -webkit-text-stroke-width -webkit-text-stroke-color -webkit-background-clip`).split(/\s+/))
  const visualFunctions = new Set([...supportedFunctions, 'calc', 'min', 'max', 'clamp', 'blur', 'drop-shadow', 'repeat', 'minmax', 'fit-content', 'translate', 'translatex', 'translatey', 'translate3d', 'scale', 'scalex', 'scaley', 'scale3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective', 'steps', 'oklch', 'oklab', 'lab', 'lch', 'hwb'])

  /** Validate selector syntax without evaluating it; functional selectors are recursively checked. */
  function validateThemeSelector(selector, depth = 0, allowPseudoElement = true) {
    if (typeof selector !== 'string' || !selector.trim() || selector.length > 700 || depth > 3 || /[\\{};@<>\u0000-\u001f]/.test(selector.replace(/>/g, ''))) throw new Error('CSS 选择器格式不受支持')
    const parts = splitCssArguments(selector)
    if (parts.length > 20) throw new Error('一条 CSS 规则最多包含 20 个选择器')
    for (const part of parts) {
      let rest = part.trim()
      let needsCompound = true
      let hasCompound = false
      while (rest) {
        const whitespace = rest.match(/^\s+/)
        if (whitespace) { rest = rest.slice(whitespace[0].length); if (hasCompound) needsCompound = true; continue }
        if (/^[>+~]/.test(rest)) {
          if (!hasCompound) throw new Error('CSS 组合选择器缺少元素')
          rest = rest.slice(1).trimStart(); needsCompound = true; hasCompound = false; continue
        }
        const simple = rest.match(/^(?:[.#][a-zA-Z_][\w-]*|\*|[a-zA-Z][\w-]*)/)
        if (simple) {
          if (/^[a-zA-Z*]/.test(simple[0]) && hasCompound && !needsCompound) throw new Error('CSS 类型选择器必须位于每组元素开头')
          rest = rest.slice(simple[0].length); hasCompound = true; needsCompound = false; continue
        }
        const attribute = rest.match(/^\[(?:data-[a-z0-9-]+|aria-[a-z0-9-]+|role|type|disabled|checked)(?:\s*(?:[~|^$*]?=)\s*(?:"[\w .:-]*"|'[\w .:-]*'|[\w-]+))?\s*\]/i)
        if (attribute) { rest = rest.slice(attribute[0].length); hasCompound = true; needsCompound = false; continue }
        const pseudo = rest.match(/^(:{1,2})([a-z-]+)/i)
        if (!pseudo) throw new Error(`不支持的 CSS 选择器：${part}`)
        const name = pseudo[2].toLowerCase()
        rest = rest.slice(pseudo[0].length)
        const legacyElements = ['before', 'after', 'first-letter', 'first-line']
        const modernElements = ['placeholder', 'selection', '-webkit-scrollbar', '-webkit-scrollbar-thumb', '-webkit-scrollbar-track', '-webkit-slider-thumb', '-webkit-slider-runnable-track']
        const isPseudoElement = legacyElements.includes(name) || modernElements.includes(name)
        if (pseudo[1] === '::' && !isPseudoElement || pseudo[1] === ':' && modernElements.includes(name)) throw new Error(`CSS 伪类 / 伪元素冒号错误：${pseudo[0]}`)
        if (isPseudoElement && (!allowPseudoElement || rest.trim())) throw new Error('CSS 伪元素必须位于完整选择器末尾')
        if (rest.startsWith('(')) {
          if (pseudo[1] === '::') throw new Error('不支持函数形式的 CSS 伪元素')
          let level = 1, end = 1
          for (; end < rest.length && level; end++) { if (rest[end] === '(') level++; if (rest[end] === ')') level-- }
          if (level) throw new Error('CSS 选择器括号不匹配')
          const argument = rest.slice(1, end - 1)
          if (['is', 'where', 'not'].includes(name)) validateThemeSelector(argument, depth + 1, false)
          else if (['nth-child', 'nth-of-type', 'nth-last-child', 'nth-last-of-type'].includes(name)) {
            if (!/^(?:odd|even|[+-]?\d+|[+-]?\d*n(?:\s*[+-]\s*\d+)?)$/i.test(argument.trim())) throw new Error('CSS nth 选择器格式错误')
          } else throw new Error(`不支持的 CSS 伪类：${name}`)
          rest = rest.slice(end)
        } else if (!['root', 'hover', 'active', 'focus', 'focus-visible', 'focus-within', 'checked', 'disabled', 'enabled', 'empty', 'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'before', 'after', 'first-letter', 'first-line', 'placeholder', 'selection', '-webkit-scrollbar', '-webkit-scrollbar-thumb', '-webkit-scrollbar-track', '-webkit-slider-thumb', '-webkit-slider-runnable-track'].includes(name)) throw new Error(`不支持的 CSS 伪类：${name}`)
        hasCompound = true; needsCompound = false
      }
      if (!hasCompound || needsCompound) throw new Error('CSS 选择器不完整')
    }
    return selector.trim()
  }

  function validateVisualDeclaration(property, value) {
    if (!visualProperties.has(property)) throw new Error(`CSS 只接受视觉属性，不支持：${property}`)
    if (!value || value.length > 1600 || /[\\{};@<>\u0000-\u001f]|\/\*|\*\//.test(value) || /(?:url|image-set|expression|javascript|https?|data|file)\s*[:(]/i.test(value)) throw new Error(`CSS 属性 ${property} 包含不安全或无效的值`)
    for (const match of value.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)) {
      if (!visualFunctions.has(match[1].toLowerCase())) throw new Error(`CSS 函数不受支持：${match[1]}`)
    }
    for (const match of value.matchAll(/var\(([^)]*)\)/gi)) {
      if (!tokenNames.has(match[1].split(',')[0].trim())) throw new Error(`CSS 引用了未知主题变量：${match[1]}`)
    }
    let balance = 0
    let quote = ''
    for (const char of value) {
      if (quote) { if (char === quote) quote = ''; continue }
      if (char === '"' || char === "'") { quote = char; continue }
      if (char === '(') balance++
      if (char === ')' && --balance < 0) throw new Error(`CSS 属性 ${property} 括号不匹配`)
    }
    if (balance || quote) throw new Error(`CSS 属性 ${property} 的括号或引号不匹配`)
    if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports(property, value)) throw new Error(`浏览器不支持 CSS：${property}: ${value}`)
  }

  /** Parse declarations and safe conditional blocks; imports, resources, executable CSS and nesting are rejected. */
  function parsedThemeCss(source) {
    if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > 48 * 1024) throw new Error('高级 CSS 必须是文本且不能超过 48 KB')
    if (!source.trim()) return null
    let ast
    try { ast = postcss.parse(source, { from: undefined }) } catch (error) { throw new Error(`CSS 第 ${error.line || 1} 行：${error.reason || '语法错误'}`) }
    let nodes = 0
    function visit(container, depth = 0) {
      if (depth > 4) throw new Error('CSS 条件嵌套最多 4 层')
      for (const node of [...(container.nodes || [])]) {
        if (++nodes > 800) throw new Error('高级 CSS 规则过多')
        if (node.type === 'comment') { node.remove(); continue }
        if (node.type === 'rule') {
          if (container.type === 'rule') throw new Error('请将 CSS 嵌套选择器展开为完整选择器')
          validateThemeSelector(node.selector)
          visit(node, depth + 1)
        } else if (node.type === 'decl') {
          if (container.type !== 'rule') throw new Error('CSS 属性必须放在选择器规则内')
          node.prop = node.prop.toLowerCase()
          if (node.raws.before?.includes('*') || node.raws.between !== ': ' && /[^\s:]/.test(node.raws.between || '')) throw new Error('CSS 属性语法不受支持')
          validateVisualDeclaration(node.prop, node.value)
          node.important = true
          node.raws = {}
        } else if (node.type === 'atrule') {
          if (container.type === 'rule' || !node.nodes) throw new Error('CSS 条件必须包含完整规则')
          if (node.name.toLowerCase() === 'media') {
            const condition = '(?:\\((?:min-|max-)?(?:width|height|aspect-ratio|resolution|orientation|prefers-color-scheme|prefers-reduced-motion|hover|pointer)\\s*:\\s*[a-z0-9 ./%-]+\\))'
            const media = new RegExp(`^(?:(?:only\\s+)?(?:screen|all)\\s*(?:and\\s+)?)?${condition}(?:\\s+and\\s+${condition})*$`, 'i')
            if (!splitCssArguments(node.params).every(part => media.test(part))) throw new Error('仅支持屏幕尺寸、明暗、动态效果与输入设备的 @media 条件')
          } else if (node.name.toLowerCase() === 'supports') {
            const query = node.params.match(/^(?:not\s+)?\(([a-z-]+)\s*:\s*([^()]+)\)$/i)
            if (!query) throw new Error('@supports 仅支持单一视觉属性查询')
            validateVisualDeclaration(query[1].toLowerCase(), query[2].trim())
          } else throw new Error(`不支持 @${node.name}；主题不能导入资源或字体`)
          visit(node, depth + 1)
        } else throw new Error('CSS 节点格式不受支持')
      }
    }
    visit(ast)
    return ast
  }

  function validateThemeCss(source) {
    const clean = parsedThemeCss(source)?.toString().trim() || ''
    if (new TextEncoder().encode(clean).byteLength > 48 * 1024) throw new Error('规范化后的高级 CSS 不能超过 48 KB，请缩减样式')
    return clean
  }

  /** Scope every target, including pseudo elements and teleports; the recovery host is never themeable. */
  function compileThemeCss(source, target = 'main') {
    const ast = parsedThemeCss(source)
    if (!ast) return ''
    if (!['main', 'desktop'].includes(target)) throw new Error('CSS 目标窗口无效')
    const scope = `body[data-bk-theme-root="${target}"]`
    ast.walkRules(rule => {
      rule.selector = splitCssArguments(rule.selector).map(selector => {
        const mapped = selector.trim()
          .replace(/^(?:(?::root|html|body)(?:\s*>\s*|\s+))+/i, '')
          .replace(/^(?::root|html|body)(?=[\s.#[:>+~]|$)/i, target === 'main' ? '.app-container' : '.lyric-container')
          .replace(/(?<!:):(before|after|first-letter|first-line)\b/gi, '::$1')
        const pseudoElement = mapped.match(/::[a-z-]+$/i)
        const suffix = pseudoElement?.[0] || ''
        const element = suffix ? mapped.slice(0, -suffix.length) : mapped
        return `${scope} ${element}:not([data-bk-theme-safety]):not([data-bk-theme-safety] *)${suffix}`
      }).join(', ')
    })
    return ast.toString()
  }

  function getThemeCssRule(source, selector) {
    validateThemeSelector(selector)
    const ast = parsedThemeCss(source)
    const rules = ast?.nodes.filter(node => node.type === 'rule' && node.selector.trim() === selector.trim()) || []
    return Object.fromEntries(rules.flatMap(rule => rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value])))
  }

  /** Update a visual editor rule in the same CSS document used by the advanced editor. Empty values restore inheritance. */
  function updateThemeCssRule(source, selector, patch) {
    validateThemeSelector(selector)
    const ast = parsedThemeCss(source) || postcss.root()
    const rules = ast.nodes.filter(node => node.type === 'rule' && node.selector.trim() === selector.trim())
    const rule = rules.at(-1) || postcss.rule({ selector })
    if (!rule.parent) ast.append(rule)
    for (const [property, raw] of Object.entries(patch)) {
      const value = String(raw).trim()
      if (!visualProperties.has(property)) throw new Error(`CSS 只接受视觉属性，不支持：${property}`)
      if (value) validateVisualDeclaration(property, value)
      for (const matching of rules.length ? rules : [rule]) matching.nodes?.filter(node => node.type === 'decl' && node.prop === property).forEach(node => node.remove())
      if (value) rule.append({ prop: property, value, important: true })
    }
    if (!rule.nodes?.length) rule.remove()
    for (const matching of rules) if (!matching.nodes?.length) matching.remove()
    return validateThemeCss(ast.toString())
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
    const css = input.css === undefined ? '' : validateThemeCss(input.css)
    const desktopCss = input.desktopCss === undefined ? '' : validateThemeCss(input.desktopCss)
    const normalized = {
      format: THEME_FORMAT, schemaVersion: THEME_SCHEMA_VERSION, id, name, version,
      author: textField(input.author, '作者', 80), description: textField(input.description, '主题说明', 240),
      base: input.base, tokens,
      ...(css ? { css } : {}),
      ...(desktopCss ? { desktopCss } : {})
    }
    if (new TextEncoder().encode(JSON.stringify(normalized, null, 2) + '\n').byteLength > MAX_THEME_FILE_BYTES) throw new Error('完整主题（含 CSS 和 JSON 转义）不能超过 128 KB，请缩减样式')
    return normalized
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

  return { THEME_FORMAT, THEME_SCHEMA_VERSION, MAX_THEME_FILE_BYTES, MAX_INSTALLED_THEMES, BUILTIN_THEMES, THEME_TOKEN_NAMES, normalizeThemePackage, parseThemePackage, serializeThemePackage, listThemePackages, getThemePackage, validateThemeCss, compileThemeCss, validateThemeSelector, getThemeCssRule, updateThemeCssRule }
}
