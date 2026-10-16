const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '..')
const catalogPromise = import(pathToFileURL(path.join(root, 'src/themes/themeCatalog.mjs')).href).then(({ createThemeCatalog }) => createThemeCatalog(require('../src/themes/default-dark.json'), require('../src/themes/default-light.json')))
const manifest = (extra = {}) => ({ format: 'betterkugou-theme', schemaVersion: 1, id: 'personal-test', name: 'Test appearance', base: 'dark', tokens: { '--color-primary': '#123456' }, ...extra })
function loadModule(file, globals, names) {
  const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '').replace(/^export \{[\s\S]*?\}\s*$/gm, '').replace(/\bexport (?=(?:async )?function|const|class)/g, '')
  return vm.runInNewContext(`${source}\n;({${names.join(',')}})`, { TextEncoder, ...globals })
}
function documentFixture() {
  const nodes = new Map()
  const properties = new Map()
  return { properties, nodes, body: { dataset: {} }, documentElement: { dataset: {}, style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) } }, getElementById: id => nodes.get(id), createElement: () => ({ textContent: '', remove() { nodes.delete(this.id) } }), head: { appendChild(node) { nodes.set(node.id, node) } } }
}

test('advanced CSS shares visual rules and safe conditionals in a schema-1 portable round trip', async () => {
  const catalog = await catalogPromise
  const css = '/* local appearance */ .music-player:hover .song-name, .title-bar:focus-within { color: var(--color-primary); padding: 8px 12px } @media screen and (max-width: 700px) { .music-player { border-radius: 18px; width: calc(100% - 20px) } } @supports (display: grid) { .home-view { display: grid } } .song-name:before { content: "♫"; opacity: .8 }'
  const desktopCss = '.current-lyric { font-size: 30px; color: rgba(1, 2, 3, .7) }'
  const input = manifest({ css, desktopCss, credentials: { token: 'must-not-export' } })
  const normalized = catalog.normalizeThemePackage(input)
  const output = catalog.parseThemePackage(catalog.serializeThemePackage(normalized))
  assert.equal(output.schemaVersion, 1)
  assert.equal(output.css, normalized.css)
  assert.equal(output.desktopCss, normalized.desktopCss)
  assert.match(output.css, /!important/)
  assert.doesNotMatch(catalog.serializeThemePackage(normalized), /must-not-export/)
  assert.equal(catalog.normalizeThemePackage(manifest()).css, undefined)
  assert.match(catalog.compileThemeCss(output.css), /::before/)
  assert.match(catalog.compileThemeCss(output.desktopCss, 'desktop'), /body\[data-bk-theme-root="desktop"\]/)
  const fonts = Array(200).fill('"A"').join(',')
  const large = Array.from({ length: 58 }, (_, index) => `.region-${index}{font-family:${fonts};}`).join('\n')
  assert.throws(() => catalog.normalizeThemePackage(manifest({ css: large, desktopCss: large })), /128 KB/)
})

test('CSS AST validation rejects resource, parser, selector, script and unknown-property escapes', async () => {
  const catalog = await catalogPromise
  const bad = [
    '@import "https://example.invalid/x.css";', '@font-face {font-family:x; src:url(x)}', '@keyframes cover {to{opacity:0}}',
    '.x { background: url(https://example.invalid/a.png) }', '.x { background: image-set("x" 1x) }', '.x { background: u/**/rl(x) }', '.x { color: var(--unknown, red) }', '.x { --injected: red }',
    '.x { behavior: url(x) }', '.x { color: expression(alert(1)) }', '.x { background: \\75rl(x) }', '.x { color: #fff;',
    '.x { color: rgb(1, 2, 3 }', '.x { & .inner {color:red} }', '.x:unknown {color:red}', '.x:has(.secret) {color:red}', '[src="x"] {color:red}', '.music-player::hover {color:red}', '.song-name:placeholder {color:red}', '.foo::before .song-name {color:red}', '.foo:is(.x::before) {color:red}', '.foo* {color:red}',
    '@media (unknown-query: yes) {.x{color:red}}', '@supports selector(:has(*)) {.x{color:red}}', '.x { color: attr(data-secret) }', '.x { *color: red }', '.x { color: red; @import "x"; }'
  ]
  for (const css of bad) assert.throws(() => catalog.normalizeThemePackage(manifest({ css })), undefined, css)
  for (const css of [null, 0, {}, 'a'.repeat(50 * 1024)]) assert.throws(() => catalog.normalizeThemePackage(manifest({ css })))
})

test('compiled selectors retain state and pseudo elements, scope document roots and exclude the recovery host', async () => {
  const catalog = await catalogPromise
  for (const selector of ['html body .lyric-view', 'html > body > .playlist-drawer', ':root', '.context-menu button:hover', '.sidebar-item[data-sidebar-item="home"]', '.x:is(.a, .b):not(:disabled)', '.x:nth-child(2n + 1)', '.x::after', '.x:before']) {
    const compiled = catalog.compileThemeCss(`${selector} { color: #fff }`)
    assert.match(compiled, /body\[data-bk-theme-root="main"\]/, selector)
    assert.match(compiled, /:not\(\[data-bk-theme-safety\]\)/, selector)
    assert.match(compiled, /:not\(\[data-bk-theme-safety\] \*\)/, selector)
    assert.doesNotMatch(compiled, /\.app-container body|:before:not|::after:not/, selector)
  }
  assert.match(catalog.compileThemeCss(':root{opacity:0}'), /\.app-container:not/)
  assert.match(catalog.compileThemeCss('html body .lyric-view{color:#fff}'), /"main"\] \.lyric-view/)
})

test('visual region edits preserve advanced rules, clear individual overrides and persist both windows', async () => {
  const catalog = await catalogPromise
  const manager = loadModule('src/utils/themeManager.js', catalog, ['createThemePackage'])
  const edits = loadModule('src/themes/themeAdjustments.js', { ...catalog, ...manager }, ['adjustThemeTokens', 'setThemeStyles', 'TOKEN_FIELDS'])
  let css = '@media (max-width: 700px) {.music-player{padding:12px}}'
  css = catalog.updateThemeCssRule(css, '.lyric-view .lyric-text', { 'font-size': '34px', 'line-height': '1.8', color: 'rgba(255,255,255,.7)' })
  assert.equal(catalog.getThemeCssRule(css, '.lyric-view .lyric-text')['font-size'], '34px')
  css = catalog.updateThemeCssRule(css, '.lyric-view .lyric-text', { color: '' })
  assert.equal(catalog.getThemeCssRule(css, '.lyric-view .lyric-text').color, undefined)
  assert.match(css, /@media/)
  const duplicate = catalog.updateThemeCssRule('.music-player{color:red}.music-player{color:blue;padding:3px}', '.music-player', { color: '' })
  assert.equal(catalog.getThemeCssRule(duplicate, '.music-player').color, undefined)
  assert.doesNotMatch(duplicate, /color:/)
  assert.match(duplicate, /padding/)
  let custom = edits.setThemeStyles({ theme: 'dark', themePackages: [] }, css, '.current-lyric {font-size:32px}')
  const personalId = custom.theme
  custom = edits.adjustThemeTokens(custom, { '--spacing-xs': '7px', '--gradient-primary': 'linear-gradient(90deg, #123456, #ffffff)', '--shadow-menu': '0 3px 9px #000000' })
  assert.equal(custom.theme, personalId)
  assert.equal(custom.themePackages.length, 1)
  const persisted = JSON.parse(JSON.stringify(custom))
  const shared = manager.createThemePackage({ custom: persisted })
  assert.match(shared.css, /34px/)
  assert.match(shared.desktopCss, /32px/)
  assert.equal(shared.tokens['--spacing-xs'], '7px')
  assert.deepEqual([...edits.TOKEN_FIELDS].map(field => field.token).sort(), [...catalog.THEME_TOKEN_NAMES].sort())
})

test('sheet switching/removal and preview cancellation leave no previous CSS or token values', async () => {
  const catalog = await catalogPromise
  const document = documentFixture()
  const manager = loadModule('src/utils/themeManager.js', { ...catalog, document }, ['applyTheme', 'previewThemePackage', 'cancelThemePreview'])
  const installed = catalog.normalizeThemePackage(manifest({ css: '.music-player{border-radius:33px}', desktopCss: '.current-lyric{font-size:31px}' }))
  const settings = { custom: { theme: installed.id, themePackages: [installed] } }
  manager.applyTheme(settings)
  assert.equal(document.body.dataset.bkThemeRoot, 'main')
  assert.match(document.nodes.get('bk-theme-custom-css').textContent, /33px/)
  manager.previewThemePackage(catalog.normalizeThemePackage(manifest({ id: 'preview', tokens: { '--color-primary': '#abcdef' }, css: '.music-player{border-radius:44px}' })))
  manager.applyTheme(settings) // Unrelated session broadcasts must not destroy a draft preview.
  assert.match(document.nodes.get('bk-theme-custom-css').textContent, /44px/)
  manager.cancelThemePreview()
  assert.match(document.nodes.get('bk-theme-custom-css').textContent, /33px/)
  assert.equal(document.properties.get('--color-primary'), '#123456')
  manager.applyTheme({ custom: { theme: 'light' } })
  assert.equal(document.nodes.has('bk-theme-custom-css'), false)
  assert.equal(document.properties.get('--color-primary'), catalog.BUILTIN_THEMES[1].tokens['--color-primary'])
  manager.applyTheme(settings)
  manager.applyTheme({ custom: { theme: installed.id, themePackages: [] } })
  assert.equal(document.nodes.has('bk-theme-custom-css'), false)
})

test('desktop HTML replaces appearance sheets/tokens and clears them on a builtin switch', () => {
  const html = fs.readFileSync(path.join(root, 'electron/desktopLyric.html'), 'utf8')
  const start = html.indexOf('    function applyAppearance(')
  const end = html.indexOf('\n    //', start)
  const document = documentFixture()
  const api = vm.runInNewContext(html.slice(start, end) + '\n;({applyAppearance})', { document })
  api.applyAppearance({ tokens: { '--lyric-accent': '#123456' }, css: 'body[data-bk-theme-root="desktop"] .current-lyric{color:#123456}' })
  assert.match(document.nodes.get('desktop-appearance-css').textContent, /#123456/)
  api.applyAppearance({ tokens: { '--lyric-text': '#ffffff' }, css: '.next-lyric{font-size:22px}' })
  assert.equal(document.properties.has('--lyric-accent'), false)
  assert.match(document.nodes.get('desktop-appearance-css').textContent, /22px/)
  api.applyAppearance(undefined)
  assert.equal(document.nodes.has('desktop-appearance-css'), false)
  assert.equal(document.properties.size, 0)
})
