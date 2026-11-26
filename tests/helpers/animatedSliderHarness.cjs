const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { parse, compileTemplate } = require('@vue/compiler-sfc')

/** Load the actual slider input and its event bindings in in-memory Vue renderers. */
function loadAnimatedSlider() {
  const filename = path.join(__dirname, '../../src/components/common/AnimatedSlider.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const component = new Function(descriptor.script.content.replace('export default', 'return'))()
  const { code } = compileTemplate({ source: descriptor.template.content, filename, id: 'animated-slider-test',
    compilerOptions: { mode: 'function', hoistStatic: false } })
  return { ...component, render: new Function('Vue', code)(vue) }
}

module.exports = { loadAnimatedSlider }
