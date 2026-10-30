import { ConverterFactory } from 'opencc-js/core'
import simplifiedDictionaries from 'opencc-js/to/cn'
import traditionalDictionaries from 'opencc-js/from/cn'
import { parseDesktopLyrics } from './desktopLyrics'

const graphemeSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const chineseSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null
const japaneseText = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const foreignCjkText = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const hanText = /\p{Script=Han}/u
const englishProfanity = /(?<![\p{L}\p{N}_])(?:motherfuck(?:er|ers|ing)?|fuck(?:er|ers|ing|ed|s)?|bullshit|shit(?:ty|ting|ted|s)?|assholes?|bitch(?:es|ing)?|bastards?|damn(?:ed)?)(?![\p{L}\p{N}_])/giu
const chineseProfanity = /(?:[操艹草]你[妈媽]|[他她你][妈媽]的|[傻煞][逼屄]|[妈媽]的|王八蛋|狗娘[养養]的|[滚滾]蛋)/gu
let simplifiedConverter
let traditionalConverter

function graphemes(text) {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), item => item.segment) : Array.from(text)
}

/** Optional metadata must never make otherwise valid timed lyrics unusable. */
function readLanguage(content, rawData) {
  const language = rawData?.language || content.match(/^\s*\[language:(.*)\]\s*$/m)?.[1]
  if (!language) return null
  try {
    let decoded = language
    if (typeof decoded === 'string') {
      try {
        decoded = JSON.parse(decoded)
      } catch {
        const bytes = Uint8Array.from(atob(decoded), character => character.charCodeAt(0))
        decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      }
    }
    return Array.isArray(decoded?.content) ? decoded : null
  } catch {
    // Translations and pronunciations are optional; malformed metadata is preserved.
    return null
  }
}

function encodeLanguage(language) {
  const bytes = new TextEncoder().encode(JSON.stringify(language))
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
}

function splitTimedLine(line) {
  const match = line.match(/^(\s*\[(\d+),(\d+)\])(.*)$/)
  if (match) return { prefix: match[1], body: match[4], krc: true }
  const lrc = line.match(/^(\s*(?:\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+)(.*)$/)
  return lrc ? { prefix: lrc[1], body: lrc[2], krc: false } : null
}

function timedText(content) {
  return content.split(/\r\n|\n|\r/).map(line => {
    const timed = splitTimedLine(line)
    return timed ? timed.body.replace(/<\d+,\d+(?:,\d+)?>/g, '') : ''
  }).join('\n')
}

/** Convert whole lines so phrase disambiguation and profanity detection cross KRC tokens. */
function transformText(text, options, preserveForeign) {
  let result = text
  if (!preserveForeign && hanText.test(result)) {
    if (options.preferSimplifiedChinese !== false) {
      simplifiedConverter ||= ConverterFactory(...simplifiedDictionaries)
      result = simplifiedConverter(result)
    } else {
      traditionalConverter ||= ConverterFactory(...traditionalDictionaries)
      result = traditionalConverter(result)
    }
  }
  if (options.showProfanity !== true) {
    const mask = value => '*'.repeat(graphemes(value).length)
    result = result.replace(englishProfanity, mask).replace(chineseProfanity, mask)
  }
  return result
}

/** Insert only missing Chinese word boundaries, preserving original spaces and punctuation. */
function segmentText(text, enabled) {
  if (!enabled || !chineseSegmenter || !hanText.test(text) || foreignCjkText.test(text)) return text
  let result = ''
  for (const { segment } of chineseSegmenter.segment(text)) {
    if (/\p{Script=Han}$/u.test(result) && /^\p{Script=Han}/u.test(segment)) result += ' '
    result += segment
  }
  return result
}

/** Keep every timing token verbatim while assigning transformed graphemes to its original span. */
function transformKrc(body, options, preserveForeign) {
  const parts = body.split(/(<\d+,\d+(?:,\d+)?>)/g)
  const sourceParts = parts.filter((_, index) => index % 2 === 0)
  const sourceCounts = sourceParts.map(text => graphemes(text).length)
  const sourceLength = sourceCounts.reduce((sum, count) => sum + count, 0)
  if (!sourceLength) return body
  const converted = transformText(sourceParts.join(''), options, preserveForeign)
  const characters = graphemes(converted)
  const segmented = segmentText(converted, options.segmentLyrics === true && !preserveForeign)
  // Segmentation only adds spaces. Attach each new boundary to the following grapheme.
  const decorated = []
  let sourceIndex = 0
  let added = ''
  for (const character of graphemes(segmented)) {
    if (character === ' ' && characters[sourceIndex] !== ' ') added += character
    else { decorated.push(added + character); added = ''; sourceIndex += 1 }
  }
  if (added && decorated.length) decorated[decorated.length - 1] += added
  let originalOffset = 0
  let outputOffset = 0
  for (let index = 0; index < parts.length; index += 2) {
    originalOffset += sourceCounts[index / 2]
    // Rare dictionary mappings can change character count; preserve token order and durations.
    const end = Math.round(originalOffset / sourceLength * decorated.length)
    parts[index] = decorated.slice(outputOffset, end).join('')
    outputOffset = end
  }
  return parts.join('')
}

/**
 * Build a display copy of LRC/KRC and optional translations. Never mutate source data,
 * metadata unrelated to language, line/word timing, offsets or repeat timestamps.
 * Japanese/Korean originals retain their orthography; Chinese translations are converted.
 */
export function processLyricContent(content, rawData = null, options = {}) {
  if (typeof content !== 'string') return { content: '', rawData }
  const preserveForeign = foreignCjkText.test(timedText(content))
  const language = readLanguage(content, rawData)
  const convertedLanguage = language ? {
    ...language,
    content: language.content.map(item => {
      if (item?.type !== 1 || !Array.isArray(item.lyricContent)) return item
      return { ...item, lyricContent: item.lyricContent.map(row => Array.isArray(row)
        ? row.map(value => typeof value === 'string'
          ? segmentText(transformText(value, options, foreignCjkText.test(value)), options.segmentLyrics === true) : value)
        : row) }
    })
  } : null
  const encodedLanguage = convertedLanguage ? encodeLanguage(convertedLanguage) : null
  const processed = content.split(/(\r\n|\n|\r)/).map(line => {
    if (encodedLanguage && /^\s*\[language:.*\]\s*$/.test(line)) return `[language:${encodedLanguage}]`
    const timed = splitTimedLine(line)
    if (!timed) return line
    const body = timed.krc ? transformKrc(timed.body, options, preserveForeign)
      : segmentText(transformText(timed.body, options, preserveForeign), options.segmentLyrics === true && !preserveForeign)
    return timed.prefix + body
  }).join('')
  return { content: processed, rawData: encodedLanguage ? { ...rawData, language: encodedLanguage } : rawData }
}

/** Return available Japanese romanization aligned to the same millisecond timeline as lyrics. */
export function readLyricRomanization(content, rawData = null) {
  if (typeof content !== 'string' || !japaneseText.test(timedText(content))) return []
  const rows = readLanguage(content, rawData)?.content.find(item => item?.type === 0)?.lyricContent
  if (!Array.isArray(rows)) return []
  const pronunciation = rows.map(row => {
    const text = Array.isArray(row) ? row.filter(value => typeof value === 'string').join(' ').trim() : ''
    return [/\p{Script=Latin}/u.test(text) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) ? text : '']
  })
  return parseDesktopLyrics(content, { language: { content: [{ type: 1, lyricContent: pronunciation }] } })
    .filter(line => line.translation).map(line => ({ time: line.time, text: line.translation }))
}
