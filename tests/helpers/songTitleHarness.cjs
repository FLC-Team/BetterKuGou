const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

/** Compile the actual title button while allowing event tests to control its clock. */
function loadSongTitle(clock = { setTimeout, clearTimeout }) {
  const filename = path.resolve(__dirname, '../../src/components/common/SongTitle.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const sandbox = vm.createContext({ module: { exports: {} }, ...clock })
  vm.runInContext(descriptor.script.content.replace('export default', 'module.exports ='), sandbox, { filename })
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'SongTitle',
    compilerOptions: { mode: 'function', hoistStatic: false } })
  assert.deepEqual(template.errors, [])
  return { ...sandbox.module.exports, render: new Function('Vue', template.code)(vue) }
}

module.exports = { loadSongTitle }
