const animations = new WeakMap()
const sizes = new WeakMap()
const states = new WeakMap()

/** 在显式内容更新前后测量容器，展开与收起均从当前可见高度接续。 */
export const contentSize = {
  mounted(element) {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const state = { media, paused: false, onChange: () => { if (media.matches) animations.get(element)?.cancel() } }
    states.set(element, state)
    media.addEventListener?.('change', state.onChange)
  },
  beforeUpdate(element, binding) {
    if (binding.value === binding.oldValue) return
    sizes.set(element, element.getBoundingClientRect().height)
    animations.get(element)?.cancel()
  },
  updated(element, binding) {
    const state = states.get(element)
    if (binding.value === binding.oldValue || state?.paused || state?.media.matches || element.closest('[inert], [aria-hidden="true"]')) return
    const from = sizes.get(element)
    const to = element.getBoundingClientRect().height
    if (from == null || Math.abs(from - to) < 1 || !element.animate) return
    const animation = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)'
    })
    animations.set(element, animation)
    animation.finished.catch(() => {}).finally(() => {
      if (animations.get(element) === animation) animations.delete(element)
    })
  },
  beforeUnmount(element) {
    const state = states.get(element)
    state?.media.removeEventListener?.('change', state.onChange)
    animations.get(element)?.cancel()
    animations.delete(element)
    sizes.delete(element)
    states.delete(element)
  }
}

export function setContentSizeActive(reference, active) {
  const element = reference?.$el || reference
  const state = element && states.get(element)
  if (!state) return
  state.paused = !active
  animations.get(element)?.cancel()
  sizes.delete(element)
}

export { freezeGridLeave, clearGridLeave } from '../../components/common/motionLayout.js'
