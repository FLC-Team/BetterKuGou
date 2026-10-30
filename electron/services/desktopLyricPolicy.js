/** Return the native window policy from committed preferences and current window state. */
function evaluateDesktopLyricPolicy({ preferences = {}, playing = false, bounds, cursor,
  mainVisible = false, lyricViewVisible = false, sameDisplay = false, fullscreenOnDisplay = false,
  forceVisible = false } = {}) {
  const inside = point => Boolean(bounds && point && point.x >= bounds.x && point.x < bounds.x + bounds.width &&
    point.y >= bounds.y && point.y < bounds.y + bounds.height)
  const hovered = inside(cursor)
  const locked = preferences.locked === true
  // This DIP rectangle is shared with the fixed #unlockBtn in desktopLyric.html.
  const unlockHovered = locked && preferences.hideUnlockButton !== true && hovered &&
    cursor.x >= bounds.x + bounds.width - 52 && cursor.x < bounds.x + bounds.width - 8 &&
    cursor.y >= bounds.y + 8 && cursor.y < bounds.y + 44
  const hidden = !forceVisible && (
    (preferences.autoHidePaused === true && !playing) ||
    (preferences.hideOnLyricView !== false && mainVisible && lyricViewVisible && sameDisplay) ||
    (preferences.hideOnFullscreen === true && fullscreenOnDisplay)
  )
  const baseOpacity = Math.max(0, Math.min(100, Number.isFinite(preferences.opacity) ? preferences.opacity : 100)) / 100
  const hoverOpacity = Math.max(0, Math.min(100, Number.isFinite(preferences.hoverOpacity) ? preferences.hoverOpacity : 20)) / 100
  let opacity = locked && hovered && preferences.hoverFade === true ? Math.min(baseOpacity, hoverOpacity) : baseOpacity
  // A fully faded locked window must still reveal its explicit recovery target.
  if (unlockHovered || forceVisible) opacity = Math.max(0.2, opacity)
  return { hidden, opacity, ignoreMouse: locked && !unlockHovered, alwaysOnTop: preferences.alwaysOnTop !== false,
    monitorPointer: !hidden && locked && (preferences.hoverFade === true || preferences.hideUnlockButton !== true) }
}

/** Match physical-monitor observations after the caller converts them to Electron DIP coordinates. */
function sameMonitorBounds(left, right) {
  return Boolean(left && right && ['x', 'y', 'width', 'height'].every(key =>
    Number.isFinite(left[key]) && Number.isFinite(right[key]) && Math.abs(left[key] - right[key]) <= 2))
}

module.exports = { evaluateDesktopLyricPolicy, sameMonitorBounds }
