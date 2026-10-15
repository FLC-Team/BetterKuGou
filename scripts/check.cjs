const fs = require('node:fs')
const path = require('node:path')
const { babelParse, parse } = require('@vue/compiler-sfc')

const root = path.resolve(__dirname, '..')
let checked = 0
const errors = []

function report(file, message, line) {
  errors.push(`${path.relative(root, file)}${line ? `:${line}` : ''}: ${message}`)
}

function checkImport(file, source, line) {
  if (!source.startsWith('.')) return
  const target = path.resolve(path.dirname(file), source.split('?')[0])
  const candidates = [target, ...['.js', '.cjs', '.mjs', '.vue', '/index.js'].map(suffix => target + suffix)]
  if (!candidates.some(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())) {
    report(file, `找不到本地引用 ${source}`, line)
  }
}

/** 解析真实源码，捕获语法错误、被覆盖的对象成员及失效的本地模块引用。 */
function checkJavaScript(file, source, startLine = 1) {
  const ast = babelParse(source, { sourceType: 'unambiguous', startLine })
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (file.startsWith(path.join(root, 'src') + path.sep) && !file.endsWith(`${path.sep}logger.js`)
      && node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
      && node.callee.object?.name === 'console') {
      report(file, '业务日志应通过现有 logger 输出，以保持级别过滤和脱敏', node.loc?.start.line)
    }
    if (node.type === 'ObjectExpression') {
      const keys = new Map()
      for (const property of node.properties) {
        if (property.type === 'SpreadElement' || property.computed) continue
        const key = property.key?.name ?? property.key?.value
        if (key == null) continue
        const previous = keys.get(String(key))
        const accessorPair = previous && ['get', 'set'].includes(previous.kind)
          && ['get', 'set'].includes(property.kind) && previous.kind !== property.kind
        if (previous && !accessorPair) report(file, `重复的对象成员 ${key}`, property.loc?.start.line)
        keys.set(String(key), property)
      }
    }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      checkImport(file, node.source.value, node.loc?.start.line)
    }
    if (node.type === 'CallExpression' && node.callee?.name === 'require' && node.arguments[0]?.type === 'StringLiteral') {
      checkImport(file, node.arguments[0].value, node.loc?.start.line)
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'errors'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast)
}

function checkFile(file) {
  try {
    const source = fs.readFileSync(file, 'utf8')
    if (file.endsWith('.vue')) {
      const { descriptor, errors: parseErrors } = parse(source, { filename: file })
      for (const error of parseErrors) report(file, String(error))
      for (const script of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
        if (script.src) checkImport(file, script.src, script.loc.start.line)
        else checkJavaScript(file, script.content, script.loc.start.line)
      }
      for (const style of descriptor.styles) {
        if (style.src) checkImport(file, style.src, style.loc.start.line)
      }
    } else if (file.endsWith('.html')) {
      for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        checkJavaScript(file, match[1], source.slice(0, match.index).split('\n').length)
      }
    } else {
      checkJavaScript(file, source)
    }
    checked += 1
  } catch (error) {
    report(file, error.message, error.loc?.line)
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(?:[cm]?js|vue|html)$/.test(entry.name)) checkFile(file)
  }
}

for (const directory of ['src', 'electron', 'scripts', 'tests']) {
  walk(path.join(root, directory))
}
for (const file of ['vite.config.js', 'KuGouMusicApi/app.js', 'KuGouMusicApi/server.js']) {
  checkFile(path.join(root, file))
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`静态检查通过：${checked} 个 JS、Vue 和 HTML 文件（语法、重复对象成员、本地引用）。`)
}
