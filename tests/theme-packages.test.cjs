const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const projectRoot = path.join(__dirname, '..')
const quietConsole = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, () => {}]))

function loadModule(relativePath, globals, exports) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')
    .replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^export \{[\s\S]*?\}\s*$/gm, '')
    .replace(/\bexport (?=(?:async )?function|const|class)/g, '')
  const sandbox = vm.createContext({ console: quietConsole, TextEncoder, ...globals })
  return vm.runInContext(`${source}\n;({ ${exports.join(', ')} })`, sandbox)
}

function loadPackages(globals = {}) {
  return loadModule('src/themes/themePackages.js', {
    createThemeCatalog: loadModule('src/themes/themeCatalog.mjs', globals, ['createThemeCatalog']).createThemeCatalog,
    defaultDark: require('../src/themes/default-dark.json'),
    defaultLight: require('../src/themes/default-light.json'),
    ...globals
  }, [
    'THEME_FORMAT', 'THEME_SCHEMA_VERSION', 'MAX_THEME_FILE_BYTES', 'MAX_INSTALLED_THEMES',
    'BUILTIN_THEMES', 'THEME_TOKEN_NAMES', 'normalizeThemePackage', 'parseThemePackage',
    'serializeThemePackage', 'listThemePackages', 'getThemePackage'
  ])
}

function themePackage(overrides = {}) {
  return {
    format: 'betterkugou-theme', schemaVersion: 1, id: 'evening-blue', name: '晚间蓝',
    version: '1.2.0', author: '示例作者', description: '可分享的主题', base: 'dark',
    tokens: { '--color-primary': '#123abc', '--sidebar-radius': '20px' },
    ...overrides
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('visual adjustments preserve an imported theme and enforce practical input and package boundaries', () => {
  const packages = loadPackages()
  const manager = loadModule('src/utils/themeManager.js', { ...packages }, ['createThemePackage'])
  const adjustments = loadModule('src/themes/themeAdjustments.js', { ...packages, ...manager }, ['adjustTheme', 'resetThemeAdjustments'])
  const original = packages.normalizeThemePackage(themePackage({ base: 'light', tokens: { '--color-primary': '#123abc', '--shadow-sm': '0 1px 2px #111111' } }))
  const custom = { theme: original.id, themePackages: [original] }
  const next = adjustments.adjustTheme(custom, { '--font-size-base': 20, '--lyric-line': 'rgba(1, 2, 3, 0.8)' })
  const personalized = packages.getThemePackage(next.theme, next)
  assert.notEqual(next.theme, original.id)
  assert.equal(next.themePackages.length, 2)
  assert.equal(personalized.base, 'light')
  assert.equal(personalized.tokens['--color-primary'], '#123abc')
  assert.equal(personalized.tokens['--font-size-base'], '20px')
  assert.deepEqual(plain(next.themePackages[0]), plain(original))
  const more = adjustments.adjustTheme(next, { '--radius-md': 0 })
  assert.equal(more.theme, next.theme)
  assert.equal(more.themePackages.length, 2)
  assert.equal(packages.getThemePackage(more.theme, more).tokens['--font-size-base'], '20px')
  for (const patch of [{ '--font-size-xs': 8 }, { '--font-size-base': Infinity }, { '--radius-md': -1 }, { '--lyric-line': 'url(https://example.invalid)' }, { '--nonexistent': '1px' }]) assert.throws(() => adjustments.adjustTheme(next, patch))
  const reset = adjustments.resetThemeAdjustments(more)
  const resetTheme = packages.getThemePackage(reset.theme, reset)
  assert.equal(resetTheme.tokens['--font-size-base'], '16px')
  assert.equal(resetTheme.tokens['--color-primary'], '#123abc')
  assert.equal(resetTheme.tokens['--shadow-sm'], '0 1px 2px #111111')
  const many = { theme: 'light', themePackages: Array.from({ length: 49 }, (_, i) => themePackage({ id: 'installed-' + i })) }
  const full = adjustments.adjustTheme(many, { '--radius-md': 15 })
  assert.equal(full.themePackages.length, 50)
  assert.ok(packages.getThemePackage(full.theme, full))
  assert.equal(adjustments.adjustTheme(full, { '--radius-md': 16 }).themePackages.length, 50)
  assert.throws(() => adjustments.adjustTheme({ ...many, themePackages: [...many.themePackages, themePackage({ id: 'personal-adjustments' })] }, { '--radius-md': 12 }), /上限/)
})

test('theme JSON round trips as a complete portable manifest with inherited base tokens', () => {
  const packages = loadPackages()
  const input = themePackage({
    name: '  晚间蓝  ', author: '  示例作者  ',
    session: { currentSong: { hash: 'must-not-share' } },
    tokens: { '--color-primary': ' #123abc ', '--sidebar-radius': '20px' }
  })
  const original = structuredClone(input)
  const normalized = packages.normalizeThemePackage(input)
  const serialized = packages.serializeThemePackage(normalized)
  const imported = packages.parseThemePackage('\uFEFF' + serialized)

  assert.equal(imported.name, '晚间蓝')
  assert.equal(imported.author, '示例作者')
  assert.equal(imported.tokens['--color-primary'], '#123abc')
  assert.equal(imported.tokens['--sidebar-radius'], '20px')
  assert.equal(imported.tokens['--color-background'], '#1a1a1a')
  assert.equal(imported.tokens['--lyric-text'], '#ffffff')
  assert.deepEqual(Object.keys(imported.tokens).sort(), [...packages.THEME_TOKEN_NAMES].sort())
  assert.deepEqual(plain(imported), plain(normalized))
  assert.equal(imported.session, undefined)
  assert.equal(serialized.includes('must-not-share'), false)
  assert.deepEqual(input, original)
})

test('light packages inherit their own base and preserve independently editable visual tokens', () => {
  const packages = loadPackages()
  const theme = packages.normalizeThemePackage(themePackage({
    base: 'light', tokens: {
      '--color-primary': 'hsl(215, 75%, 45%)',
      '--gradient-primary': 'linear-gradient(90deg, #123abc, #456def)',
      '--font-family': "'思源黑体', sans-serif",
      '--shadow-cover': '0 12px 24px rgba(0, 0, 0, 0.2)',
      '--transition-fast': '100ms ease-out'
    }
  }))
  assert.equal(theme.tokens['--color-background'], '#f5f7fb')
  assert.equal(theme.tokens['--lyric-text'], '#1f1f1f')
  assert.equal(theme.tokens['--color-primary'], 'hsl(215, 75%, 45%)')
  assert.equal(theme.tokens['--font-family'], "'思源黑体', sans-serif")
  assert.equal(theme.tokens['--transition-fast'], '100ms ease-out')
})

test('malformed CSS is rejected equally without a browser CSS API', () => {
  const packages = loadPackages()
  for (const tokens of [
    { '--color-primary': 'rgba(bad)' },
    { '--shadow-cover': 'garbage' },
    { '--shadow-cover': '0 0 -1px #fff' },
    { '--color-primary': 'color-mix(in srgb, #fff 200%, #000)' },
    { '--color-primary': 'color-mix(in srgb, #fff 0%, #000 0%)' },
    { '--color-primary': 'rgb(20, 20%, 20)' },
    { '--gradient-primary': 'linear-gradient(garbage)' },
    { '--icon-filter': 'invert(..)' },
    { '--transition-fast': '100ms cubic-bezier(0, 0, 2, 1)' },
    { '--color-primary': 'var(--shadow-cover)' }
  ]) {
    assert.throws(() => packages.normalizeThemePackage(themePackage({ tokens })))
  }
})

test('theme import limits UTF-8 bytes rather than JavaScript character counts', () => {
  const packages = loadPackages()
  const withinLimit = JSON.stringify(themePackage({ padding: '汉'.repeat(40000) }))
  const overLimit = JSON.stringify(themePackage({ padding: '汉'.repeat(45000) }))
  assert.ok(overLimit.length < packages.MAX_THEME_FILE_BYTES)
  assert.ok(Buffer.byteLength(overLimit, 'utf8') > packages.MAX_THEME_FILE_BYTES)
  assert.equal(packages.parseThemePackage(withinLimit).id, 'evening-blue')
  assert.throws(() => packages.parseThemePackage(overLimit), /128 KB/)
  assert.throws(() => packages.parseThemePackage('{broken'), /JSON/)
  assert.throws(() => packages.parseThemePackage('null'), /JSON/)
})

test('theme validation rejects unsupported manifests and reserved built-in identifiers', () => {
  const packages = loadPackages()
  for (const id of ['dark', 'light', 'system', 'auto', 'custom', '../theme', 'Uppercase']) {
    assert.throws(() => packages.normalizeThemePackage(themePackage({ id })), /ID/)
  }
  assert.throws(() => packages.normalizeThemePackage(themePackage({ schemaVersion: 2 })), /版本不受支持/)
  assert.throws(() => packages.normalizeThemePackage(themePackage({ format: 'foreign-theme' })), /BetterKuGou/)
  assert.throws(() => packages.normalizeThemePackage(themePackage({ base: 'system' })), /基础配色/)
  assert.throws(() => packages.normalizeThemePackage(themePackage({ name: ' ' })), /名称不能为空/)
  assert.throws(() => packages.normalizeThemePackage(themePackage({ version: 'latest' })), /版本格式/)
  assert.throws(() => packages.normalizeThemePackage(themePackage({ tokens: {} })), /视觉变量/)
  for (const builtin of packages.BUILTIN_THEMES) {
    assert.equal(packages.normalizeThemePackage(builtin, { allowBuiltin: true }).id, builtin.id)
  }
})

test('dangerous fields are rejected throughout nested metadata without polluting prototypes', () => {
  const packages = loadPackages()
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const source = JSON.stringify(themePackage()).replace(/}$/, `,"extra":{"array":[{"${key}":{"polluted":true}}]}}`)
    assert.throws(() => packages.parseThemePackage(source), /不安全/)
  }
  assert.equal({}.polluted, undefined)
  const recursive = themePackage()
  recursive.extra = recursive
  assert.throws(() => packages.normalizeThemePackage(recursive), /层级过深/)
})

test('theme tokens cannot inject resources, CSS declarations, unknown variables or unsafe functions', () => {
  const packages = loadPackages()
  const unsafe = [
    ['--unknown-token', '#ffffff', /不支持/],
    ['--color-primary', 'url(https://example.test/image.png)', /外部资源/],
    ['--color-primary', 'expression(alert(1))', /外部资源/],
    ['--color-primary', '#ffffff; color: red', /格式错误/],
    ['--color-primary', 'rgba(1, 2, 3, 0.5', /括号/],
    ['--color-primary', 'var(--missing-token)', /引用不存在/],
    ['--color-primary', 'paint(example)', /不支持的函数/],
    ['--gradient-primary', 'image-set("image.png" 1x)', /外部资源/],
    ['--color-primary-rgb', '256, 0, 0', /RGB/],
    ['--color-primary', 'red', /颜色格式/]
  ]
  for (const [name, value, message] of unsafe) {
    assert.throws(() => packages.normalizeThemePackage(themePackage({ tokens: { [name]: value } })), message, `${name}: ${value}`)
  }
  const unsupportedValue = 'color-mix(in srgb, #ffffff, #000000)'
  const unsupportedCSS = loadPackages({ CSS: { supports: (_property, value) => value !== unsupportedValue } })
  assert.throws(() => unsupportedCSS.normalizeThemePackage(themePackage({ tokens: { '--color-primary': unsupportedValue } })), /浏览器不支持/)
})

test('layout token bounds reject broken dimensions while allowing documented extremes', () => {
  const packages = loadPackages()
  for (const [name, value] of [
    ['--font-size-base', '7px'], ['--font-size-base', '65px'],
    ['--spacing-md', '121px'], ['--radius-md', '8rem'],
    ['--sidebar-radius', '-1px'], ['--radius-full', '10000px']
  ]) {
    assert.throws(() => packages.normalizeThemePackage(themePackage({ tokens: { [name]: value } })), /尺寸超出范围/, `${name}: ${value}`)
  }
  const valid = packages.normalizeThemePackage(themePackage({ tokens: {
    '--font-size-base': '0.5rem', '--spacing-md': '120px', '--radius-full': '9999px'
  } }))
  assert.equal(valid.tokens['--font-size-base'], '0.5rem')
  assert.equal(valid.tokens['--radius-full'], '9999px')
})

test('cyclic token references cannot break the applied palette', () => {
  const packages = loadPackages()
  for (const tokens of [
    { '--color-primary': 'var(--color-primary)' },
    { '--color-primary': 'var(--color-text)', '--color-text': 'var(--color-primary)' }
  ]) {
    assert.throws(() => packages.normalizeThemePackage(themePackage({ tokens })), /循环引用/)
  }
  const valid = packages.normalizeThemePackage(themePackage({ tokens: { '--color-primary': 'var(--color-text)' } }))
  assert.equal(valid.tokens['--color-primary'], 'var(--color-text)')
})

test('case-insensitive CSS var functions still reject missing variables and reference cycles', () => {
  const packages = loadPackages()
  assert.throws(() => packages.parseThemePackage(JSON.stringify(themePackage({
    tokens: { '--color-primary': 'VAR(--missing-token)' }
  }))), /引用不存在/)
  for (const tokens of [
    { '--color-primary': 'VAR(--color-primary)' },
    { '--color-primary': 'VaR(--color-text)', '--color-text': 'VAR(--color-primary)' }
  ]) {
    assert.throws(() => packages.parseThemePackage(JSON.stringify(themePackage({ tokens }))), /循环引用/)
  }
  const valid = packages.parseThemePackage(JSON.stringify(themePackage({
    tokens: { '--color-primary': 'VAR(--color-text)' }
  })))
  assert.equal(valid.tokens['--color-primary'], 'VAR(--color-text)')
})

test('installed themes retain built-ins, skip bad packages and deduplicate identifiers', () => {
  const packages = loadPackages()
  const themes = packages.listThemePackages({ themePackages: [
    null,
    themePackage({ id: 'first-theme' }),
    themePackage({ id: 'first-theme', name: 'duplicate' }),
    themePackage({ id: 'invalid-theme', tokens: { '--unknown-token': '#ffffff' } }),
    themePackage({ id: 'second-theme', base: 'light' }),
    themePackage({ id: 'dark', name: 'overwrite builtin' })
  ] })
  assert.deepEqual([...themes].map(theme => theme.id), ['dark', 'light', 'first-theme', 'second-theme'])
  assert.equal(themes[0].name, '经典深色')
  assert.equal(themes[2].name, '晚间蓝')
  assert.equal(packages.getThemePackage('missing', { themePackages: themes }), null)
  assert.equal(packages.getThemePackage('second-theme', { themePackages: themes }).base, 'light')
  assert.deepEqual([...packages.listThemePackages({ themePackages: 'broken' })].map(theme => theme.id), ['dark', 'light'])

  const many = Array.from({ length: packages.MAX_INSTALLED_THEMES + 1 }, (_, index) => themePackage({ id: `theme-${index}` }))
  assert.equal(packages.listThemePackages({ themePackages: many }).length, packages.MAX_INSTALLED_THEMES + 2)
  assert.equal(packages.getThemePackage(`theme-${packages.MAX_INSTALLED_THEMES}`, { themePackages: many }), null)
})

function loadManager(globals = {}) {
  return loadModule('src/utils/themeManager.js', { ...loadPackages(), ...globals }, [
    'applyTheme', 'getThemeSnapshot', 'createThemePackage', 'resolveTheme'
  ])
}

function themeFixture(dark = true) {
  const properties = new Map()
  const listeners = new Set()
  const subscriptions = { added: 0, removed: 0 }
  const root = {
    dataset: {},
    style: {
      colorScheme: '',
      setProperty: (name, value) => properties.set(name, value),
      getPropertyValue: name => properties.get(name) || '',
      removeProperty: name => properties.delete(name)
    }
  }
  const media = {
    matches: dark,
    addEventListener(event, listener) {
      assert.equal(event, 'change')
      subscriptions.added++
      listeners.add(listener)
    },
    removeEventListener(event, listener) {
      assert.equal(event, 'change')
      subscriptions.removed++
      listeners.delete(listener)
    }
  }
  const manager = loadManager({
    document: { documentElement: root },
    window: { matchMedia: query => {
      assert.equal(query, '(prefers-color-scheme: dark)')
      return media
    } }
  })
  return {
    manager, root, properties, listeners, subscriptions,
    changeSystem(dark) {
      media.matches = dark
      for (const listener of [...listeners]) listener({ matches: dark })
    }
  }
}

test('switching installed themes fully replaces visual values and reports their base', () => {
  const fixture = themeFixture()
  const custom = {
    theme: 'rounded-night',
    themePackages: [
      themePackage({ id: 'rounded-night', tokens: {
        '--color-primary': '#123abc', '--sidebar-radius': '40px',
        '--font-size-base': '24px', '--lyric-text': '#abcdef'
      } }),
      themePackage({ id: 'day-theme', base: 'light', tokens: { '--color-primary': '#aabbcc' } })
    ]
  }
  fixture.manager.applyTheme({ custom })
  assert.equal(fixture.properties.get('--sidebar-radius'), '40px')
  assert.equal(fixture.properties.get('--font-size-base'), '24px')
  assert.equal(fixture.properties.get('--lyric-text'), '#abcdef')
  assert.equal(fixture.root.dataset.theme, 'rounded-night')
  assert.equal(fixture.manager.getThemeSnapshot('rounded-night'), 'dark')

  custom.theme = 'day-theme'
  fixture.manager.applyTheme({ custom })
  assert.equal(fixture.properties.get('--color-primary'), '#aabbcc')
  assert.equal(fixture.properties.get('--sidebar-radius'), '15px')
  assert.equal(fixture.properties.get('--font-size-base'), '16px')
  assert.equal(fixture.properties.get('--lyric-text'), '#1f1f1f')
  assert.equal(fixture.root.dataset.theme, 'day-theme')
  assert.equal(fixture.root.dataset.themeBase, 'light')
  assert.equal(fixture.root.style.colorScheme, 'light')
  assert.equal(fixture.manager.getThemeSnapshot('day-theme'), 'light')
  assert.deepEqual(Object.fromEntries(fixture.properties), plain(fixture.manager.resolveTheme({ custom }).tokens))

  fixture.manager.applyTheme({ custom: { theme: 'dark' } })
  assert.equal(fixture.properties.get('--color-primary'), '#377db6')
  assert.equal(fixture.properties.get('--lyric-text'), '#ffffff')
  assert.equal(fixture.root.style.colorScheme, 'dark')
})

test('system following adds one listener, changes the full palette and releases it on manual selection', () => {
  const fixture = themeFixture()
  fixture.manager.applyTheme({ custom: { theme: 'system' } })
  fixture.manager.applyTheme({ custom: { theme: 'system' } })
  assert.equal(fixture.listeners.size, 1)
  assert.equal(fixture.subscriptions.added, 1)
  assert.equal(fixture.properties.get('--lyric-text'), '#ffffff')
  const oldListener = [...fixture.listeners][0]

  fixture.changeSystem(false)
  assert.equal(fixture.properties.get('--color-background'), '#f5f7fb')
  assert.equal(fixture.properties.get('--lyric-text'), '#1f1f1f')
  assert.equal(fixture.root.dataset.themeBase, 'light')
  assert.equal(fixture.manager.getThemeSnapshot('system'), 'light')

  fixture.manager.applyTheme({ custom: { theme: 'dark' } })
  assert.equal(fixture.listeners.size, 0)
  assert.equal(fixture.subscriptions.removed, 1)
  oldListener({ matches: false })
  assert.equal(fixture.properties.get('--color-background'), '#1a1a1a')
  assert.equal(fixture.root.dataset.themeBase, 'dark')

  fixture.manager.applyTheme({ custom: { theme: 'auto' } })
  assert.equal(fixture.listeners.size, 1)
  assert.equal(fixture.properties.get('--color-background'), '#f5f7fb')
  fixture.manager.applyTheme({ custom: { theme: 'custom', customTheme: { background: '#ffffff' } } })
  assert.equal(fixture.listeners.size, 0)
  assert.equal(fixture.subscriptions.removed, 2)
})

test('legacy custom colors remain usable with complete inherited theme values', () => {
  const fixture = themeFixture()
  const settings = { custom: {
    theme: 'custom', customTheme: { primary: 'aabbcc', hover: '#abc', background: '#fff' }
  } }
  fixture.manager.applyTheme(settings)
  assert.equal(fixture.properties.get('--color-primary'), '#aabbcc')
  assert.equal(fixture.properties.get('--color-primary-hover'), '#aabbcc')
  assert.equal(fixture.properties.get('--color-primary-rgb'), '170, 187, 204')
  assert.equal(fixture.properties.get('--color-background'), '#ffffff')
  assert.equal(fixture.properties.get('--sidebar-bg'), '#ffffff')
  assert.equal(fixture.properties.get('--font-size-base'), '16px')
  assert.equal(fixture.properties.get('--lyric-text'), '#1f1f1f')
  assert.equal(fixture.manager.getThemeSnapshot('custom'), 'light')
  assert.equal(fixture.root.dataset.theme, 'custom')

  settings.custom.customTheme.background = '#000000'
  fixture.manager.applyTheme(settings)
  assert.equal(fixture.root.dataset.themeBase, 'dark')
  assert.equal(fixture.properties.get('--lyric-text'), '#ffffff')
  assert.equal(fixture.manager.getThemeSnapshot('custom'), 'dark')
})

test('missing or damaged installed themes fall back to the complete default palette', () => {
  const fixture = themeFixture(false)
  const settings = { custom: {
    theme: 'broken-theme',
    themePackages: [themePackage({ id: 'broken-theme', tokens: { '--color-primary': 'url(unsafe)' } })]
  } }
  fixture.manager.applyTheme({ custom: { theme: 'light' } })
  fixture.manager.applyTheme(settings)
  assert.equal(fixture.root.dataset.theme, 'dark')
  assert.equal(fixture.properties.get('--color-background'), '#1a1a1a')
  assert.equal(fixture.properties.get('--lyric-text'), '#ffffff')
  assert.equal(fixture.manager.getThemeSnapshot('broken-theme'), 'dark')
  assert.equal(fixture.manager.resolveTheme({ custom: { theme: 'removed-theme' } }).id, 'dark')
  assert.equal(loadManager().resolveTheme({ custom: { theme: 'system' } }).base, 'dark')
})

test('sharing legacy custom colors exports a manifest that contains no account or playback settings', () => {
  const manager = loadManager()
  const packages = loadPackages()
  const settings = {
    custom: { theme: 'custom', customTheme: { primary: '#aabbcc', background: '#ffffff' }, savePath: 'private-path' },
    session: { currentSong: { hash: 'private-song' }, playbackState: { currentTime: 75 } },
    shortcuts: { keys: { playPause: 'private-shortcut' } },
    account: { token: 'private-token' }
  }
  const exported = manager.createThemePackage(settings, { id: 'shared-day', name: '分享浅色', author: '示例作者' })
  const source = packages.serializeThemePackage(exported)
  const imported = packages.parseThemePackage(source)
  assert.deepEqual(Object.keys(imported).sort(), [
    'format', 'schemaVersion', 'id', 'name', 'version', 'author', 'description', 'base', 'tokens'
  ].sort())
  assert.equal(imported.base, 'light')
  assert.equal(imported.tokens['--color-primary'], '#aabbcc')
  assert.equal(imported.tokens['--color-background'], '#ffffff')
  assert.equal(imported.tokens['--lyric-text'], '#1f1f1f')
  assert.equal(source.includes('private-'), false)
  assert.deepEqual(plain(imported.tokens), plain(manager.resolveTheme(settings).tokens))
  assert.equal(settings.session.playbackState.currentTime, 75)
})

test('exports of built-ins receive shareable identifiers while installed metadata survives re-export', () => {
  const manager = loadManager()
  const packages = loadPackages()
  for (const theme of ['dark', 'light']) {
    const shared = manager.createThemePackage({ custom: { theme } })
    assert.equal(shared.id.startsWith('theme-'), true)
    assert.equal(packages.parseThemePackage(packages.serializeThemePackage(shared)).base, theme)
  }
  const installed = themePackage({ id: 'shared-installed', version: '2.1.0', author: '原作者', description: '原说明' })
  const settings = { custom: { theme: installed.id, themePackages: [installed] } }
  const shared = manager.createThemePackage(settings)
  assert.equal(shared.id, installed.id)
  assert.equal(shared.version, '2.1.0')
  assert.equal(shared.author, '原作者')
  assert.equal(shared.description, '原说明')
  assert.equal(shared.tokens['--sidebar-radius'], '20px')

  const fallback = manager.createThemePackage({ custom: {
    theme: 'custom', customTheme: { primary: '#zzzzzz', hover: 123, background: '#nothex' }
  } })
  assert.equal(packages.parseThemePackage(packages.serializeThemePackage(fallback)).tokens['--color-background'], '#1a1a1a')
})
