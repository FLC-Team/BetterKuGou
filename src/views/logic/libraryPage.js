/** A page owns this state; no account data or requests are shared globally. */
export function createLibraryPageState() {
  return { items: [], page: 0, total: null, more: true, cursor: null, loaded: false, loading: false, error: '', requestAppend: false, fingerprints: [] }
}

/** Read pagination evidence without treating a successful first page as a complete collection. */
export function readLibraryPagination(response, received, loaded, pageSize) {
  const data = response?.data?.data || response?.data || response || {}
  const rawTotal = data.total ?? data.count ?? data.total_count ?? data.comments_num ?? response?.data?.total ?? response?.total
  const total = rawTotal === null || rawTotal === undefined || rawTotal === '' ? null : Number(rawTotal)
  const validTotal = Number.isFinite(total) && total >= 0 ? total : null
  const explicit = data.has_more ?? data.hasMore ?? data.has_next ?? data.more ?? response?.has_more
  const cursor = data.bp ?? data.next_bp ?? data.next_cursor ?? response?.bp ?? null
  const more = explicit !== undefined ? explicit === true || Number(explicit) === 1
    : validTotal !== null ? loaded < validTotal : received >= pageSize
  return { total: validTotal, more: received > 0 && more, cursor }
}

/** Reject repeated pages before appending; callers retain the previous complete page on failure. */
export function appendLibraryPage(state, items, response, { append = false, pageSize = 30 } = {}) {
  const fingerprint = JSON.stringify(items)
  if (append && items.length && state.fingerprints.includes(fingerprint)) throw new Error('服务返回了重复内容，请稍后重试。')
  const next = append ? [...state.items, ...items] : items
  const pagination = readLibraryPagination(response, items.length, next.length, pageSize)
  const total = pagination.total ?? (append ? state.total : null)
  if (items.length === 0 && total !== null && next.length < total) throw new Error('内容未加载完整，请重试。')
  if (total !== null && pagination.total === null) pagination.more = items.length > 0 && next.length < total
  Object.assign(state, pagination, { total, items: next, page: append ? state.page + 1 : 1, loaded: true,
    fingerprints: append ? [...state.fingerprints, fingerprint] : [fingerprint] })
}

/** Categories may be grouped; retain only named identifiers actually returned by the API. */
export function flattenLibraryOptions(input, fields = ['children', 'son', 'tags', 'tag_list', 'list', 'info', 'data']) {
  const result = []
  const seen = new Set()
  const visit = (value, depth = 0) => {
    if (!value || depth > 6) return
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return }
    if (typeof value !== 'object') return
    const id = value.tag_id ?? value.category_id ?? value.type_id ?? value.id
    const name = value.tag_name ?? value.category_name ?? value.type_name ?? value.name ?? value.label
    if (id != null && name && !seen.has(String(id))) { seen.add(String(id)); result.push({ id, name: String(name) }) }
    fields.forEach(field => visit(value[field], depth + 1))
  }
  visit(input)
  return result
}
