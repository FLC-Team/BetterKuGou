/** Preserve the departing grid item's geometry while its siblings enter their final layout. */
export function freezeGridLeave(element) {
  const rect = element.getBoundingClientRect()
  const parent = element.parentElement.getBoundingClientRect()
  Object.assign(element.style, {
    width: `${rect.width}px`, height: `${rect.height}px`,
    left: `${rect.left - parent.left}px`, top: `${rect.top - parent.top}px`
  })
  element.setAttribute('inert', '')
  element.setAttribute('aria-hidden', 'true')
}

export function clearGridLeave(element) {
  for (const property of ['width', 'height', 'left', 'top']) element.style.removeProperty(property)
  element.removeAttribute('inert')
  element.removeAttribute('aria-hidden')
}
