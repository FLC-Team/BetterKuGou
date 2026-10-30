/** Decode optional KRC translation metadata without allowing malformed data to hide the lyrics. */
function readTranslations(content, rawData) {
  const language = rawData?.language || content.match(/^\s*\[language:(.*)\]\s*$/m)?.[1]
  if (!language) return []
  try {
    let data = language
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0))
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      }
    }
    const translations = data?.content?.find(item => item?.type === 1)?.lyricContent
    return Array.isArray(translations) ? translations.map(row => typeof row?.[0] === 'string' ? row[0] : '') : []
  } catch {
    // Translation metadata is optional; the original timed text remains usable.
    return []
  }
}

/** Preserve literal text, including spaces and angle brackets, between actual KRC timing tokens. */
function readKrcWords(content, lineStart, lineDuration, offset) {
  const tokens = Array.from(content.matchAll(/<(\d+),(\d+)(?:,\d+)?>/g))
  const lineTime = Math.max(0, lineStart - offset)
  const word = (text, start, duration) => {
    const startTime = Math.max(0, lineStart + start - offset) - lineTime
    const endTime = Math.max(0, lineStart + start + duration - offset) - lineTime
    return { word: text, startTime, endTime, duration: Math.max(0, endTime - startTime) }
  }
  if (!tokens.length) return content ? [word(content, 0, lineDuration)] : []
  const words = []
  if (tokens[0].index > 0) words.push(word(content.slice(0, tokens[0].index), 0, 0))
  tokens.forEach((token, index) => {
    const text = content.slice(token.index + token[0].length, tokens[index + 1]?.index ?? content.length)
    if (text) words.push(word(text, Number(token[1]), Number(token[2])))
  })
  return words
}

/**
 * Parse the desktop timeline in milliseconds. Positive LRC/KRC offset advances
 * lyrics; translations follow source rows before sorting or expanding repeat tags.
 * No HTML decoding, whitespace trimming or Unicode character splitting is applied.
 */
export function parseDesktopLyrics(content, rawData = null) {
  if (typeof content !== 'string' || !content) return []
  content = content.replace(/^\ufeff/, '')
  const offsetMatches = Array.from(content.matchAll(/^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/gim))
  const offset = offsetMatches.length ? Number(offsetMatches.at(-1)[1]) : 0
  const translations = readTranslations(content, rawData)
  const result = []
  let sourceIndex = 0
  for (const sourceLine of content.split(/\r\n|\n|\r/)) {
    const line = sourceLine.replace(/^\s+(?=\[)/, '')
    const krc = line.match(/^\[(\d+),(\d+)\](.*)$/)
    const leadingTags = line.match(/^(?:\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+/)?.[0] || ''
    const timestamps = krc ? [] : Array.from(leadingTags.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g))
    if (!krc && (!timestamps.length || timestamps[0].index !== 0)) continue
    const rawTranslation = translations[sourceIndex++] || ''
    const translation = rawTranslation.trim() ? rawTranslation : ''
    if (krc) {
      const start = Number(krc[1])
      const duration = Number(krc[2])
      const words = readKrcWords(krc[3], start, duration, offset)
      const time = Math.max(0, start - offset)
      result.push({ time, duration: Math.max(0, start + duration - offset) - time,
        text: words.map(word => word.word).join(''), words, isKrc: true, ...(translation ? { translation } : {}) })
      continue
    }
    const text = line.slice(leadingTags.length)
    for (const timestamp of timestamps) {
      if (Number(timestamp[2]) >= 60) continue
      const time = Number(timestamp[1]) * 60000 + Number(timestamp[2]) * 1000 + Number((timestamp[3] || '').padEnd(3, '0'))
      result.push({ time: Math.max(0, time - offset), text, ...(translation ? { translation } : {}) })
    }
  }
  return result.sort((left, right) => left.time - right.time)
}
