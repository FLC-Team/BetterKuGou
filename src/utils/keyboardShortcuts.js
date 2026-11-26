const keyNames = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space'
}

/** Older recorded bindings may end in a lowercase letter even when Caps Lock is off. */
export function normalizeShortcut(binding) {
  if (typeof binding !== 'string') return ''
  return binding.replace(/(^|\+)[a-z]$/, letter => letter.toUpperCase())
}

/** Recording and playback use the same modifier order, arrow names and letter case. */
export function shortcutFromEvent(event) {
  if (!event.key || event.isComposing || ['Control', 'Alt', 'Shift', 'Meta', 'Dead', 'Process'].includes(event.key)) return ''
  const keys = []
  if (event.ctrlKey || event.metaKey) keys.push('Control')
  if (event.altKey) keys.push('Alt')
  if (event.shiftKey) keys.push('Shift')
  keys.push(keyNames[event.key] || event.key)
  return normalizeShortcut(keys.join('+'))
}
