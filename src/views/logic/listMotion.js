// 每个列表独立持有观察器，布局采样只针对视口内的行，避免大歌单全量 FLIP。
const states = new WeakMap()
const duration = 180

function clearAnimations(state) {
  state.animations.forEach(animation => animation.cancel())
  state.animations.clear()
  state.ghosts.forEach(ghost => ghost.remove())
  state.ghosts.clear()
}

function animate(state, element, frames, complete) {
  if (typeof element.animate !== 'function') { complete?.(); return }
  const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.2,.7,.2,1)' })
  state.animations.add(animation)
  animation.finished.catch(() => {}).finally(() => {
    state.animations.delete(animation)
    complete?.()
  })
}

function canAnimate(state) {
  return !state.disposed && !state.paused && !state.reduced.matches && !state.element.closest('[inert], [aria-hidden="true"]')
}

function syncRows(state) {
  const rows = new Set(state.element.querySelectorAll(':scope > [data-motion-key]'))
  for (const row of state.rows) {
    if (rows.has(row)) continue
    state.observer?.unobserve(row)
    state.visible.delete(row)
  }
  for (const row of rows) if (!state.paused && !state.rows.has(row)) state.observer?.observe(row)
  state.rows = rows
}

export const listMotion = {
  mounted(element, binding) {
    const state = {
      element, rows: new Set(), visible: new Set(), previous: new Map(),
      animations: new Set(), ghosts: new Set(), animateUntil: 0,
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)'),
      paused: binding?.instance?.isActive === false, disposed: false
    }
    states.set(element, state)
    const scroller = element.closest('.list-page')
    if (typeof IntersectionObserver === 'function') {
      state.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const wasVisible = state.visible.has(entry.target)
            state.visible.add(entry.target)
            if (!wasVisible && performance.now() < state.animateUntil && canAnimate(state)) {
              animate(state, entry.target, [{ opacity: 0, translate: '0 7px' }, { opacity: 1, translate: '0 0' }])
            }
          } else state.visible.delete(entry.target)
        }
      }, { root: scroller, threshold: 0 })
    }
    // 滚动时旧位置已无意义；取消尚在退场的克隆，防止覆盖新的可见行。
    state.onScroll = () => { clearAnimations(state); state.animateUntil = 0 }
    scroller?.addEventListener('scroll', state.onScroll, { passive: true })
    state.scroller = scroller
    state.onReducedChange = () => { if (state.reduced.matches) clearAnimations(state) }
    state.reduced.addEventListener?.('change', state.onReducedChange)
    syncRows(state)
  },
  beforeUpdate(element, binding) {
    const state = states.get(element)
    if (!state || binding.value === binding.oldValue) return
    clearAnimations(state)
    state.previous.clear()
    if (!canAnimate(state)) return
    const rootRect = element.getBoundingClientRect()
    // IntersectionObserver 只保存当前可见元素；不遍历全量曲目的几何信息。
    for (const row of state.visible) {
      if (!row.isConnected) continue
      const rect = row.getBoundingClientRect()
      state.previous.set(row.dataset.motionKey, { row, rect, rootRect, clone: row.cloneNode(true) })
    }
  },
  updated(element, binding) {
    const state = states.get(element)
    if (!state) return
    syncRows(state)
    if (binding.value === binding.oldValue || !canAnimate(state)) return
    state.animateUntil = performance.now() + duration
    const byKey = new Map([...state.rows].map(row => [row.dataset.motionKey, row]))
    const viewport = state.scroller?.getBoundingClientRect()
    for (const [key, snapshot] of state.previous) {
      const row = byKey.get(key)
      if (row) {
        const rect = row.getBoundingClientRect()
        if (viewport && (rect.bottom <= viewport.top || rect.top >= viewport.bottom)) continue
        const dy = snapshot.rect.top - rect.top
        // 遥远的倒序目标用淡入承接，避免行从屏幕外长距离飞入。
        if (Math.abs(dy) > 1 && Math.abs(dy) < (viewport?.height || 900)) {
          animate(state, row, [{ translate: `0 ${dy}px` }, { translate: '0 0' }])
        }
      } else {
        const ghost = snapshot.clone
        ghost.removeAttribute('id')
        ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
        ghost.setAttribute('aria-hidden', 'true')
        ghost.setAttribute('inert', '')
        ghost.removeAttribute('data-motion-key')
        Object.assign(ghost.style, {
          position: 'absolute', pointerEvents: 'none', margin: '0', zIndex: '1',
          top: `${snapshot.rect.top - snapshot.rootRect.top}px`,
          left: `${snapshot.rect.left - snapshot.rootRect.left}px`, width: `${snapshot.rect.width}px`
        })
        state.ghosts.add(ghost)
        element.append(ghost)
        animate(state, ghost, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '8px 0' }], () => {
          state.ghosts.delete(ghost)
          ghost.remove()
        })
      }
    }
    state.previous.clear()
  },
  beforeUnmount(element) {
    const state = states.get(element)
    if (!state) return
    state.disposed = true
    state.observer?.disconnect()
    state.scroller?.removeEventListener('scroll', state.onScroll)
    state.reduced.removeEventListener?.('change', state.onReducedChange)
    clearAnimations(state)
    states.delete(element)
  }
}

/** KeepAlive 失活停止观察和动画，恢复只重新观察已有行，不改变歌曲数据。 */
export function setListMotionActive(reference, active) {
  const element = reference?.$el || reference
  const state = element && states.get(element)
  if (!state) return
  state.paused = !active
  clearAnimations(state)
  state.previous.clear()
  state.visible.clear()
  state.observer?.disconnect()
  if (active) state.rows.forEach(row => state.observer?.observe(row))
}
