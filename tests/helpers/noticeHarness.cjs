const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

const noticeApiKey = Symbol('test-notification-api')

/** Mount the real AppNotice bridge while replacing only the external Fue presentation in memory hosts. */
function registerAppNotice(app) {
  const filename = path.join(__dirname, '../../src/components/common/AppNotice.vue')
  const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
  const compiled = compileScript(descriptor, { id: 'app-notice-harness', inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } }).content
    .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]vue['"]\s*;?\s*$/gm, (_match, names) => `const { ${names.replace(/\bas\b/g, ':')} } = Vue`)
    .replace(/^import\b[^\n]*$/gm, '').replace('export default', 'return')
  const FueButton = {
    inheritAttrs: false,
    props: ['disabled', 'loading'],
    setup(props, { attrs, slots }) {
      return () => vue.h('button', { ...attrs, disabled: Boolean(props.disabled || props.loading) }, slots.default?.())
    }
  }
  const AppNotice = new Function('Vue', 'useMessage', 'FueButton', 'logger', compiled)(vue,
    () => vue.inject(noticeApiKey), FueButton, { warn() {}, error() {} })
  const entries = vue.shallowReactive([])
  let sequence = 0
  const api = {
    create(options) {
      const id = options.id ?? ++sequence
      if (entries.some(entry => entry.id === id)) throw new Error('Duplicate notification ID in test')
      entries.push({ ...options, id })
      return id
    },
    close(id) {
      const entry = entries.find(entry => entry.id === id)
      if (!entry || entry.onClose?.() === false) return
      api.destroy(id)
    },
    destroy(id) {
      const index = entries.findIndex(entry => entry.id === id)
      if (index < 0) return
      const [entry] = entries.splice(index, 1)
      entry.onAfterLeave?.()
    },
    destroyAll() { [...entries].forEach(entry => api.destroy(entry.id)) }
  }
  for (const type of ['default', 'info', 'success', 'warning', 'error']) {
    api[type] = input => api.create({ ...(typeof input === 'string' ? { title: input } : input), type })
  }
  const Outlet = {
    setup() {
      return () => vue.h('notification-outlet', entries.map(entry => vue.h('article', {
        key: entry.id, 'data-notification-id': entry.id, role: ['error', 'warning'].includes(entry.type) ? 'alert' : 'status'
      }, [vue.h('strong', entry.title), vue.h('div', typeof entry.content === 'function' ? entry.content() : entry.content),
        entry.closable === false ? null : vue.h('button', { 'aria-label': '关闭提示', onClick: () => api.close(entry.id) }, '×')])))
    }
  }
  const Root = { ...app._component }
  const rootProps = app._props
  // createApp closes over this object; replacing app._component would not change its mounted root.
  for (const key of Object.keys(app._component)) delete app._component[key]
  app._component.render = () => [vue.h(Root, rootProps), vue.h(Outlet)]
  app.component('AppNotice', AppNotice)
  app.provide(noticeApiKey, api)
  return { api, entries }
}

module.exports = { registerAppNotice }
