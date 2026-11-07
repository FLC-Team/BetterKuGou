export const MAX_BACKGROUND_IMAGE_BYTES = 16 * 1024 * 1024

/** Settings store only managed image identifiers, never paths or URLs. */
export function normalizeBackgroundImageId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : ''
}

export function backgroundImageUrl(value) {
  const id = normalizeBackgroundImageId(value)
  return id ? `bk-background://image/${id}` : ''
}
