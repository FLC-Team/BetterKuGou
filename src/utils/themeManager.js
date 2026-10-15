import { BUILTIN_THEMES, getThemePackage, normalizeThemePackage } from '../themes/themePackages.js'

const DARK_THEME = BUILTIN_THEMES[0].tokens
const LIGHT_THEME = BUILTIN_THEMES[1].tokens

const SUPPORTED_THEMES = {
  dark: DARK_THEME,
  light: LIGHT_THEME
}

let latestSettings = null
let systemMediaQuery = null
let systemListener = null

function clamp(number, min, max) {
  return Math.min(Math.max(number, min), max)
}

function componentToHex(component) {
  const hex = component.toString(16)
  return hex.length === 1 ? `0${hex}` : hex
}

function normalizeHex(hex) {
  if (typeof hex !== 'string') return null
  let value = hex.trim()
  if (!value) return null
  if (value[0] !== '#') {
    value = `#${value}`
  }
  if (value.length === 4) {
    const r = value[1]
    const g = value[2]
    const b = value[3]
    value = `#${r}${r}${g}${g}${b}${b}`
  }
  if (!/^#[a-f\d]{6}$/i.test(value)) {
    return null
  }
  return value.toLowerCase()
}

function hexToRgb(hex) {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const int = parseInt(normalized.slice(1), 16)
  if (Number.isNaN(int)) return null
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return { r, g, b }
}

function hexToRgbString(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`
}

function mixChannel(start, end, weight) {
  return Math.round(start + (end - start) * weight)
}

function mix(hexA, hexB, weight) {
  const rgbA = hexToRgb(hexA)
  const rgbB = hexToRgb(hexB)
  if (!rgbA || !rgbB) return hexA
  const w = clamp(weight, 0, 1)
  const r = mixChannel(rgbA.r, rgbB.r, w)
  const g = mixChannel(rgbA.g, rgbB.g, w)
  const b = mixChannel(rgbA.b, rgbB.b, w)
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`
}

function lighten(hex, amount) {
  return mix(hex, '#ffffff', amount)
}

function darken(hex, amount) {
  return mix(hex, '#000000', amount)
}

function getLuminance(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const sr = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4)
  const sg = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4)
  const sb = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4)
  return 0.2126 * sr + 0.7152 * sg + 0.0722 * sb
}

function buildCustomPalette(settings) {
  const customTheme = settings?.customTheme || {}
  const primary = normalizeHex(customTheme.primary) || DARK_THEME['--color-primary']
  const hover = normalizeHex(customTheme.hover) || lighten(primary, 0.2)
  const background = normalizeHex(customTheme.background) || DARK_THEME['--color-background']

  const base = getLuminance(background) > 0.55 ? LIGHT_THEME : DARK_THEME
  const palette = { ...base }

  palette['--color-primary'] = primary
  palette['--color-primary-hover'] = hover
  palette['--color-primary-active'] = darken(primary, 0.25)
  const primaryRgb = hexToRgbString(primary) || palette['--color-primary-rgb']
  palette['--color-primary-rgb'] = primaryRgb
  const alpha = base === LIGHT_THEME ? 0.12 : 0.18
  palette['--color-primary-light'] = primaryRgb ? `rgba(${primaryRgb}, ${alpha})` : palette['--color-primary-light']

  palette['--color-background'] = background
  if (base === LIGHT_THEME) {
    palette['--color-background-light'] = darken(background, 0.05)
    palette['--color-background-lighter'] = darken(background, 0.1)
    palette['--color-border'] = darken(background, 0.2)
    palette['--color-border-light'] = darken(background, 0.1)
    palette['--color-text'] = '#1f1f1f'
    palette['--color-text-secondary'] = '#333333'
    palette['--color-text-tertiary'] = '#4f4f4f'
    palette['--titlebar-icon-color'] = '#666666'
    palette['--titlebar-icon-hover'] = '#000000'
  } else {
    palette['--color-background-light'] = lighten(background, 0.08)
    palette['--color-background-lighter'] = lighten(background, 0.16)
    palette['--color-border'] = lighten(background, 0.28)
    palette['--color-border-light'] = lighten(background, 0.35)
    palette['--color-text'] = '#ffffff'
    palette['--color-text-secondary'] = '#c8c8c8'
    palette['--color-text-tertiary'] = '#989898'
    palette['--titlebar-icon-color'] = '#bbbbbb'
    palette['--titlebar-icon-hover'] = '#ffffff'
  }

  palette['--sidebar-bg'] = background
  palette['--titlebar-bg'] = background
  palette['--color-background-lighter-rgb'] = hexToRgbString(palette['--color-background-lighter'])
  palette['--gradient-primary'] = `linear-gradient(135deg, ${primary} 0%, ${hover} 100%)`
  palette['--shadow-primary'] = `rgba(${primaryRgb}, 0.4)`
  palette['--shadow-primary-hover'] = `rgba(${primaryRgb}, 0.6)`
  palette['--bg-focus'] = `rgba(${primaryRgb}, 0.1)`
  palette['--bg-focus-medium'] = `rgba(${primaryRgb}, 0.2)`
  palette['--lyric-accent'] = primary

  return palette
}

function applyPalette(theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  Object.entries(theme.tokens).forEach(([key, value]) => {
    root.style.setProperty(key, value)
  })
  root.style.colorScheme = theme.base
  root.dataset.theme = theme.id
  root.dataset.themeBase = theme.base
}

function handleSystemChange(event) {
  if (!latestSettings || !['system', 'auto'].includes(latestSettings.custom?.theme)) return
  applyPalette(BUILTIN_THEMES[event.matches ? 0 : 1])
}

function ensureSystemListener() {
  if (typeof window === 'undefined' || !window.matchMedia) return null
  if (!systemMediaQuery) {
    systemMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  }
  if (!systemListener) {
    systemListener = handleSystemChange
    systemMediaQuery.addEventListener('change', systemListener)
  }
  return systemMediaQuery
}

function removeSystemListener() {
  if (systemMediaQuery && systemListener) {
    systemMediaQuery.removeEventListener('change', systemListener)
  }
  systemMediaQuery = null
  systemListener = null
}

/** 从唯一设置来源解析主题；旧配色模式继续兼容，损坏或缺失主题回退默认包。 */
function resolveTheme(settings = {}) {
  const custom = settings.custom || {}
  const choice = custom.theme || 'dark'
  if (['system', 'auto'].includes(choice)) {
    const dark = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches : true
    return BUILTIN_THEMES[dark ? 0 : 1]
  }
  if (choice === 'custom') {
    const tokens = buildCustomPalette(custom)
    return { id: 'custom', name: '自定义配色', base: getLuminance(tokens['--color-background']) > 0.55 ? 'light' : 'dark', tokens }
  }
  return getThemePackage(choice, custom) || BUILTIN_THEMES[0]
}

/** 整包重写所有视觉变量，避免切换时遗留上一个主题的圆角、字体或颜色。 */
function applyTheme(settings) {
  latestSettings = settings || {}
  const choice = latestSettings.custom?.theme
  if (['system', 'auto'].includes(choice)) ensureSystemListener()
  else removeSystemListener()
  applyPalette(resolveTheme(latestSettings))
}

function getThemeSnapshot(theme = 'dark') {
  return resolveTheme({ custom: { ...latestSettings?.custom, theme } }).base
}

/** 导出完整视觉快照，不带播放队列、快捷键、路径或账号设置。 */
function createThemePackage(settings, metadata = {}) {
  const resolved = resolveTheme(settings)
  const installed = getThemePackage(resolved.id, settings?.custom)
  const shareId = !['dark', 'light', 'custom'].includes(resolved.id) ? resolved.id
    : `theme-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`
  return normalizeThemePackage({
    format: 'betterkugou-theme', schemaVersion: 1, id: metadata.id || shareId,
    name: metadata.name || resolved.name, version: metadata.version || installed?.version || '1.0.0',
    author: metadata.author ?? installed?.author ?? '', description: metadata.description ?? installed?.description ?? '',
    base: resolved.base, tokens: { ...resolved.tokens }
  })
}

export {
  applyTheme,
  getThemeSnapshot,
  resolveTheme,
  createThemePackage,
  SUPPORTED_THEMES
}
