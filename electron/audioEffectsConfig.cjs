const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const AUDIO_EFFECTS_BUFFER_MS_OPTIONS = Object.freeze([64, 128, 256, 512])
const DEFAULT_AUDIO_EFFECTS_BUFFER_MS = 128

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => !forbiddenKeys.has(key))
}

function text(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) &&
    value.trim() && !forbiddenKeys.has(value.trim()) ? value.trim() : null
}

/** Keep only portable preferences; native plugin state, scan results and per-track tempo live in the service. */
function normalizeAudioEffects(value) {
  const normalized = { enabled: false, bufferMs: DEFAULT_AUDIO_EFFECTS_BUFFER_MS, searchPaths: [], chain: [] }
  if (!record(value)) return normalized
  normalized.enabled = Object.hasOwn(value, 'enabled') && value.enabled === true
  if (Object.hasOwn(value, 'bufferMs') && AUDIO_EFFECTS_BUFFER_MS_OPTIONS.includes(value.bufferMs)) normalized.bufferMs = value.bufferMs
  const paths = new Set()
  if (Object.hasOwn(value, 'searchPaths') && Array.isArray(value.searchPaths)) {
    for (const item of value.searchPaths) {
      const directory = text(item, 4096)
      if (!directory || paths.has(directory)) continue
      paths.add(directory)
      normalized.searchPaths.push(directory)
      if (normalized.searchPaths.length === 64) break
    }
  }
  const instances = new Set()
  if (Object.hasOwn(value, 'chain') && Array.isArray(value.chain)) {
    for (const item of value.chain) {
      if (!record(item)) continue
      const instanceId = Object.hasOwn(item, 'instanceId') && typeof item.instanceId === 'string' &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(item.instanceId) && text(item.instanceId, 64)
      const pluginId = Object.hasOwn(item, 'pluginId') && text(item.pluginId, 1024)
      if (!instanceId || !pluginId || instances.has(instanceId)) continue
      instances.add(instanceId)
      normalized.chain.push({ instanceId, pluginId,
        bypassed: Object.hasOwn(item, 'bypassed') && item.bypassed === true,
        alwaysOnTop: Object.hasOwn(item, 'alwaysOnTop') && item.alwaysOnTop === true })
      if (normalized.chain.length === 64) break
    }
  }
  return normalized
}

module.exports = { normalizeAudioEffects, AUDIO_EFFECTS_BUFFER_MS_OPTIONS, DEFAULT_AUDIO_EFFECTS_BUFFER_MS }
