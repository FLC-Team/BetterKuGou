import { BUILTIN_THEMES, MAX_INSTALLED_THEMES, listThemePackages, normalizeThemePackage } from './themePackages.js'
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
const adjustableTokens = new Set(['--font-family', ...NUMBER_ADJUSTMENTS.map(item => item.token), ...LYRIC_COLOR_ADJUSTMENTS.map(item => item.token)])

/** 克隆当前完整主题并只更新可见的视觉项，沿原主题包校验和安装上限保存。 */
export function adjustTheme(custom, patch) {
  const installed = listThemePackages(custom).filter(theme => !BUILTIN_THEMES.some(builtin => builtin.id === theme.id))
  const previousId = custom.themeAdjustmentId
  const existing = typeof previousId === 'string' && installed.some(theme => theme.id === previousId)
  if (!existing && installed.length >= MAX_INSTALLED_THEMES) {
    throw new Error('主题包已达上限，请先移除一个不再使用的主题包。')
  }
  const id = existing ? previousId : `personal-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`
  const theme = createThemePackage({ custom }, { id, name: '我的个性主题', description: '在设置中调整的字体、间距、圆角与歌词配色。' })
  for (const [token, value] of Object.entries(patch)) {
    if (!adjustableTokens.has(token)) throw new Error('此项目不支持在设置中调整。')
    const numeric = NUMBER_ADJUSTMENTS.find(item => item.token === token)
    if (numeric) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < numeric.min || number > numeric.max) throw new Error(`${numeric.label}应在 ${numeric.min}–${numeric.max} px 之间。`)
      theme.tokens[token] = `${number}px`
    } else {
      theme.tokens[token] = value
    }
  }
  const normalized = normalizeThemePackage(theme)
  return { ...custom, theme: normalized.id, themeAdjustmentId: normalized.id, themePackages: [...installed.filter(item => item.id !== normalized.id), normalized] }
}

/** 仅恢复精细调整中的项目，保留当前主题的其他配色及已安装主题。 */
export function resetThemeAdjustments(custom) {
  const current = createThemePackage({ custom })
  const builtin = BUILTIN_THEMES.find(theme => theme.base === current.base)
  const patch = Object.fromEntries([...adjustableTokens].map(token => {
    const value = builtin.tokens[token]
    return [token, NUMBER_ADJUSTMENTS.some(item => item.token === token) ? parseFloat(value) : value]
  }))
  return adjustTheme(custom, patch)
}
