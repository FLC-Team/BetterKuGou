/** Animate a native disclosure without removing its summary or changing keyboard semantics. */
export function createDetailsMotion(details, { duration = 220 } = {}) {
  const summary = details.querySelector('summary')
  if (!summary) return { setOpen() {}, dispose() {} }
  const view = details.ownerDocument?.defaultView || globalThis
  const preference = view.matchMedia?.('(prefers-reduced-motion: reduce)')
  let desired = details.open
  let animation = null
  let disposed = false
  const originalOverflow = details.style.overflow
  const originalBoxSizing = details.style.boxSizing
  const content = Array.from(details.children).filter(child => child !== summary).map(element => ({ element, inert: element.inert }))

  function settle() {
    const previous = animation
    animation = null
    details.open = desired
    previous?.cancel()
    details.style.overflow = originalOverflow
    details.style.boxSizing = originalBoxSizing
  }

  function setOpen(open) {
    if (disposed) return
    const next = Boolean(open)
    if (next === desired && !animation && next === details.open) return
    const from = details.getBoundingClientRect().height
    desired = next
    for (const child of content) child.element.inert = !desired || child.inert
    animation?.cancel()
    animation = null
    if (preference?.matches || typeof details.animate !== 'function') { settle(); return }
    details.open = true
    details.style.boxSizing = 'border-box'
    let destination = details.getBoundingClientRect().height
    if (!desired) {
      // Native closed geometry also accounts for summary margins and marker layout.
      details.open = false
      destination = details.getBoundingClientRect().height
      details.open = true
    }
    if (Math.abs(from - destination) < 1) { settle(); return }
    details.style.overflow = 'hidden'
    const current = details.animate([{ height: `${from}px` }, { height: `${destination}px` }], {
      duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both'
    })
    animation = current
    current.onfinish = () => { if (animation === current && !disposed) settle() }
  }

  function toggle(event) {
    if (event.defaultPrevented || event.target.closest?.('button, a, input, select, textarea')) return
    event.preventDefault()
    setOpen(!desired)
  }
  const onPreference = () => { if (preference.matches) settle() }
  summary.addEventListener('click', toggle)
  preference?.addEventListener?.('change', onPreference)
  const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(() => {
    if (!animation || !desired || disposed) return
    // Re-measure after cancelling the old height, including shrinking dynamic content.
    setOpen(true)
  }) : null
  for (const child of details.children) if (child !== summary) observer?.observe(child)
  return {
    setOpen,
    dispose() {
      disposed = true
      settle()
      observer?.disconnect()
      summary.removeEventListener('click', toggle)
      preference?.removeEventListener?.('change', onPreference)
      for (const child of content) child.element.inert = child.inert
    }
  }
}
