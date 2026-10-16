import { BUILTIN_THEMES, MAX_INSTALLED_THEMES, THEME_TOKEN_NAMES, listThemePackages, normalizeThemePackage } from './themePackages.js'
import { createThemePackage } from '../utils/themeManager.js'

export const FONT_OPTIONS = [
  { value: 'system-ui, sans-serif', label: '系统默认' },
  { value: '"Microsoft YaHei", sans-serif', label: '微软雅黑' },
  { value: '"Noto Sans SC", sans-serif', label: '思源黑体（需本机安装）' },
  { value: 'Georgia, "SimSun", serif', label: '衬线字体' }
]
export const NUMBER_ADJUSTMENTS = [
  { token: '--font-size-xs', label: '辅助文字', min: 12, max: 16, group: '字体大小' },
  { token: '--font-size-sm', label: '曲目与表单文字', min: 12, max: 20, group: '字体大小' },
  { token: '--font-size-base', label: '正文', min: 14, max: 22, group: '字体大小' },
  { token: '--font-size-lg', label: '分区标题', min: 16, max: 28, group: '字体大小' },
  { token: '--font-size-xl', label: '设置标题', min: 18, max: 32, group: '字体大小' },
  { token: '--font-size-2xl', label: '大标题', min: 20, max: 40, group: '字体大小' },
  { token: '--spacing-md', label: '常规间距', min: 8, max: 28, group: '间距与圆角' },
  { token: '--spacing-lg', label: '分组间距', min: 12, max: 40, group: '间距与圆角' },
  { token: '--spacing-xl', label: '面板留白', min: 20, max: 56, group: '间距与圆角' },
  { token: '--radius-sm', label: '小控件圆角', min: 0, max: 16, group: '间距与圆角' },
  { token: '--radius-md', label: '封面与控件圆角', min: 0, max: 24, group: '间距与圆角' },
  { token: '--radius-lg', label: '面板圆角', min: 0, max: 32, group: '间距与圆角' },
  { token: '--sidebar-radius', label: '侧边栏圆角', min: 0, max: 32, group: '间距与圆角' }
]
export const LYRIC_COLOR_ADJUSTMENTS = [
  { token: '--lyric-background', label: '背景' },
  { token: '--lyric-overlay', label: '封面遮罩' },
  { token: '--lyric-text', label: '主要文字' },
  { token: '--lyric-line', label: '未唱歌词' },
  { token: '--lyric-translation', label: '翻译' },
  { token: '--lyric-accent', label: '当前歌词强调色' },
  { token: '--lyric-control', label: '控制按钮' }
]
const legacyAdjustableTokens = new Set(['--font-family', ...NUMBER_ADJUSTMENTS.map(item => item.token), ...LYRIC_COLOR_ADJUSTMENTS.map(item => item.token)])
const adjustableTokens = new Set(THEME_TOKEN_NAMES)

/** 克隆当前完整主题并只更新可见的视觉项，沿原主题包校验和安装上限保存。 */
export function editThemePackage(custom, change) {
  const installed = listThemePackages(custom).filter(theme => !BUILTIN_THEMES.some(builtin => builtin.id === theme.id))
  const previousId = custom.themeAdjustmentId
  const existing = typeof previousId === 'string' && installed.some(theme => theme.id === previousId)
  if (!existing && installed.length >= MAX_INSTALLED_THEMES) {
    throw new Error('主题包已达上限，请先移除一个不再使用的主题包。')
  }
  const id = existing ? previousId : `personal-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`
  const theme = createThemePackage({ custom }, { id, name: '我的个性主题', description: '可视化编辑与高级 CSS 的完整视觉主题。' })
  change(theme)
  const normalized = normalizeThemePackage(theme)
  return { ...custom, theme: normalized.id, themeAdjustmentId: normalized.id, themePackages: [...installed.filter(item => item.id !== normalized.id), normalized] }
}

/** Set any registered token using its CSS value; full shared validation runs before it can be saved. */
export function adjustThemeTokens(custom, patch) {
  return editThemePackage(custom, theme => {
    for (const [token, value] of Object.entries(patch)) {
      if (!adjustableTokens.has(token)) throw new Error('此项目不支持在设置中调整。')
      theme.tokens[token] = value
    }
  })
}

export function adjustTheme(custom, patch) {
  const values = {}
  for (const [token, value] of Object.entries(patch)) {
    if (!adjustableTokens.has(token)) throw new Error('此项目不支持在设置中调整。')
    const numeric = NUMBER_ADJUSTMENTS.find(item => item.token === token)
    if (numeric) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < numeric.min || number > numeric.max) throw new Error(`${numeric.label}应在 ${numeric.min}–${numeric.max} px 之间。`)
      values[token] = `${number}px`
    } else {
      values[token] = value
    }
  }
  return adjustThemeTokens(custom, values)
}

/** 仅恢复精细调整中的项目，保留当前主题的其他配色及已安装主题。 */
export function resetThemeAdjustments(custom) {
  const current = createThemePackage({ custom })
  const builtin = BUILTIN_THEMES.find(theme => theme.base === current.base)
  const patch = Object.fromEntries([...legacyAdjustableTokens].map(token => {
    const value = builtin.tokens[token]
    return [token, NUMBER_ADJUSTMENTS.some(item => item.token === token) ? parseFloat(value) : value]
  }))
  return adjustTheme(custom, patch)
}

export function setThemeStyles(custom, css, desktopCss) {
  return editThemePackage(custom, theme => { theme.css = css; theme.desktopCss = desktopCss })
}

const tokenLabels = {
  '--font-family': '界面字体', '--color-primary': '主色', '--color-primary-hover': '主色悬停', '--color-primary-active': '主色按下', '--color-primary-light': '主色浅背景', '--color-on-primary': '主色上的文字',
  '--color-background': '主背景', '--color-background-light': '次级背景', '--color-background-lighter': '三级背景', '--color-text': '主要文字', '--color-text-secondary': '次要文字', '--color-text-tertiary': '辅助文字',
  '--sidebar-bg': '侧栏背景', '--sidebar-radius': '侧栏圆角', '--titlebar-bg': '标题栏背景', '--lyric-text': '主要歌词', '--lyric-line': '未唱歌词', '--lyric-accent': '歌词强调色', '--lyric-overlay': '封面遮罩',
  '--spacing-xs': '极小间距', '--spacing-sm': '小间距', '--spacing-md': '常规间距', '--spacing-lg': '分组间距', '--spacing-xl': '面板留白',
  '--radius-sm': '小圆角', '--radius-md': '控件圆角', '--radius-lg': '面板圆角', '--radius-full': '胶囊圆角',
  '--font-size-xs': '辅助文字', '--font-size-sm': '曲目与表单文字', '--font-size-base': '正文', '--font-size-lg': '分区标题', '--font-size-xl': '设置标题', '--font-size-2xl': '大标题'
}
function tokenGroup(token) {
  if (/^--lyric-/.test(token)) return '全屏歌词'
  if (/sidebar/.test(token)) return '侧边导航'
  if (/titlebar/.test(token)) return '标题栏'
  if (/player|slider/.test(token)) return '播放栏'
  if (/playlist/.test(token)) return '播放队列'
  if (/font-/.test(token)) return '全局字体'
  if (/spacing|radius/.test(token)) return '全局间距与圆角'
  if (/shadow/.test(token)) return '阴影'
  if (/gradient/.test(token)) return '渐变背景'
  if (/transition/.test(token)) return '动效'
  if (/filter/.test(token)) return '图标'
  return '全局配色'
}
export const TOKEN_FIELDS = THEME_TOKEN_NAMES.map(token => ({
  token, label: tokenLabels[token] || token.slice(2), group: tokenGroup(token),
  kind: /font-size|spacing|radius/.test(token) ? 'size' : /font-family|transition|filter|shadow-(?!primary|dark)|gradient|-rgb$/.test(token) ? 'text' : 'color'
}))

/** Stable region anchors also cover body teleports; users can refine any selector by picking an element. */
export const THEME_REGIONS = [
  ['全局', '应用背景', '.app-container'], ['全局', '内容画布', '.main-content'], ['标题栏', '标题栏', '.title-bar'], ['标题栏', '窗口按钮', '.title-bar .window-controls button'],
  ['侧边导航', '导航面板', '.sidebar-container'], ['侧边导航', '导航项', '.sidebar-container .sidebar-item'], ['侧边导航', '导航图标', '.sidebar-icon'],
  ['首页', '内容与留白', '.home-content'], ['首页', '首页大标题', '.home-header h1'], ['首页', '推荐卡片', '.home-view .song-card'],
  ['列表页面', '曲目行', '.view-favorite .song-item, .view-search .song-item, .view-daily-recommend .song-item, .view-rank-detail .song-item, .view-album .song-item, .view-artist .song-item'],
  ['列表页面', '曲目标题', '.view-favorite .song-name, .view-search .song-name, .view-daily-recommend .song-name, .view-rank-detail .song-name, .view-album .song-name, .view-artist .song-name'],
  ['播放栏', '播放面板', '.music-player'], ['播放栏', '封面', '.music-player .song-cover'], ['播放栏', '曲目名称', '.music-player .song-name'], ['播放栏', '歌手', '.music-player .song-artist'], ['播放栏', '播放按钮', '.music-player .play-btn'],
  ['全屏歌词', '全屏背景', '.lyric-view'], ['全屏歌词', '封面', '.lyric-view .album-cover-wrapper'], ['全屏歌词', '歌曲标题', '.lyric-view .song-title'], ['全屏歌词', '歌词行', '.lyric-view .lyric-line'], ['全屏歌词', '歌词文字', '.lyric-view .lyric-text'], ['全屏歌词', '翻译', '.lyric-view .translation-lyric'],
  ['播放队列', '抽屉面板', '.playlist-drawer .drawer-content'], ['播放队列', '曲目行', '.playlist-drawer .playlist-item'], ['菜单与弹层', '右键菜单', '.context-menu'], ['设置', '设置画布', '.settings-view'], ['设置', '设置分组', '.settings-section'], ['设置', '输入框', '.settings-view input, .settings-view select'],
  ['桌面歌词', '悬浮面板', '.lyric-container'], ['桌面歌词', '当前歌词', '.current-lyric'], ['桌面歌词', '下一句与翻译', '.next-lyric'], ['桌面歌词', '逐字歌词', '.karaoke-char'], ['桌面歌词', '已唱字符', '.karaoke-char.sung'], ['桌面歌词', '歌曲信息', '.song-info'], ['桌面歌词', '工具栏按钮', '.menu-btn']
].map(([group, label, selector]) => ({ group, label, selector, target: group === '桌面歌词' ? 'desktop' : 'main' }))

export const REGION_PROPERTIES = [
  ['color', '文字颜色', 'color'], ['background', '背景 / 渐变', 'text'], ['opacity', '整体透明度（0–1）', 'number'], ['font-size', '字号', 'length'], ['font-family', '字体', 'text'], ['font-weight', '字重', 'text'], ['line-height', '行高', 'text'], ['letter-spacing', '字距', 'length'],
  ['padding', '内边距', 'text'], ['margin', '外边距', 'text'], ['gap', '元素间距', 'length'], ['width', '宽度', 'length'], ['height', '高度', 'length'], ['min-height', '最小高度', 'length'], ['max-width', '最大宽度', 'length'],
  ['border-radius', '圆角', 'length'], ['border', '边框', 'text'], ['box-shadow', '阴影', 'text'], ['text-shadow', '文字阴影', 'text'], ['backdrop-filter', '背景模糊', 'text'], ['filter', '图像 / 图标滤镜', 'text'], ['object-fit', '封面填充方式', 'text']
].map(([property, label, kind]) => ({ property, label, kind }))

/** Use a page/teleport anchor plus semantic classes, never a global nth-child index. */
export function selectorForElement(element) {
  const anchors = '.lyric-view, .playlist-drawer, .context-menu, .music-player, .sidebar-container, .title-bar, .page-view, .app-container'
  const anchor = element.closest(anchors)
  if (!anchor || element.closest('[data-bk-theme-safety]')) throw new Error('请选择应用界面内的元素')
  const stableClasses = node => [...node.classList].filter(name => /^[a-zA-Z_][\w-]*$/.test(name) && !/^(?:active|show|visible|selected|is-|has-|track-|page-switch|player-slide)/.test(name))
  const path = []
  for (let node = element; node && node !== anchor; node = node.parentElement) {
    if (node.id && /^[a-zA-Z_][\w-]*$/.test(node.id)) { path.unshift('#' + node.id); break }
    const classes = stableClasses(node)
    path.unshift(classes.length ? '.' + classes.slice(0, 2).join('.') : node.tagName.toLowerCase())
    if (path.length >= 4) break
  }
  const pageClass = stableClasses(anchor).find(name => name.startsWith('view-'))
  const anchorClass = pageClass || stableClasses(anchor)[0]
  return [anchorClass ? '.' + anchorClass : anchor.tagName.toLowerCase(), ...path].join(' ')
}
