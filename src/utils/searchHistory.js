const MAX_HISTORY = 20
const storageKey = owner => `betterkugou_search_history_v1:${encodeURIComponent(owner)}`

/** Keep only bounded, exact submitted keywords; draft input and remote suggestions never enter history. */
export function normalizeSearchHistory(items) {
  if (!Array.isArray(items)) return []
  const result = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const keyword = item.trim()
    if (!keyword || keyword.length > 300 || result.includes(keyword)) continue
    result.push(keyword)
    if (result.length === MAX_HISTORY) break
  }
  return result
}

/** Account-scoped local history contains keywords only and never gets uploaded or exported with settings. */
export function readSearchHistory(owner, storage = globalThis.localStorage) {
  const raw = storage.getItem(storageKey(owner))
  if (!raw) return []
  let items
  try { items = JSON.parse(raw) } catch { return [] }
  return normalizeSearchHistory(items)
}

export function writeSearchHistory(owner, items, storage = globalThis.localStorage) {
  const history = normalizeSearchHistory(items)
  if (history.length) storage.setItem(storageKey(owner), JSON.stringify(history))
  else storage.removeItem(storageKey(owner))
  return history
}
