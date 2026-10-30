const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const OpenCC = require('opencc-js')

const globals = { atob, btoa, TextDecoder, TextEncoder, Uint8Array, Intl }
const desktopSource = fs.readFileSync(path.join(__dirname, '../src/utils/desktopLyrics.js'), 'utf8')
  .replace(/\bexport (?=function)/g, '')
const parseDesktopLyrics = vm.runInNewContext(`${desktopSource}\nparseDesktopLyrics`, globals)
const source = fs.readFileSync(path.join(__dirname, '../src/utils/lyricProcessing.js'), 'utf8')
  .replace(/^import[^\n]*\n/gm, '').replace(/\bexport (?=function)/g, '')
const { processLyricContent, readLyricRomanization } = vm.runInNewContext(
  `${source}\n({ processLyricContent, readLyricRomanization })`, {
    ...globals, parseDesktopLyrics, ConverterFactory: OpenCC.ConverterFactory,
    simplifiedDictionaries: OpenCC.Locale.to.cn, traditionalDictionaries: OpenCC.Locale.from.cn
  })
const plain = value => JSON.parse(JSON.stringify(value))
const metadata = content => Buffer.from(JSON.stringify({ version: 1, content })).toString('base64')
const timing = content => content.match(/\[(?:\d+,\d+|\d{1,3}:\d{2}(?:\.\d{1,3})?)\]|<\d+,\d+(?:,\d+)?>/g)

test('converts Chinese phrases in both directions while preserving timing, spacing, metadata and source', () => {
  const original = '[ar:原始歌手]\r\n[offset:-50]\r\n[00:01.00][00:03.00]  音樂與頭髮 👨‍👩‍👧‍👦 é  '
  const raw = { decodeContent: original, language: metadata([{ type: 1, lyricContent: [['夢想與時間']] }]) }
  const before = structuredClone(raw)
  const simple = processLyricContent(original, raw, { preferSimplifiedChinese: true, showProfanity: true })
  assert.equal(simple.content, '[ar:原始歌手]\r\n[offset:-50]\r\n[00:01.00][00:03.00]  音乐与头发 👨‍👩‍👧‍👦 é  ')
  assert.deepEqual(timing(simple.content), timing(original))
  assert.deepEqual(raw, before)
  assert.equal(parseDesktopLyrics(simple.content, simple.rawData)[0].translation, '梦想与时间')
  const traditional = processLyricContent('[00:01.00]头发长长，发展梦想', null, { preferSimplifiedChinese: false })
  assert.equal(traditional.content, '[00:01.00]頭髮長長，發展夢想')
})

test('phrase conversion and profanity filtering span KRC word tokens without changing durations', () => {
  const original = '[1000,5000]<0,500,0>头<500,500,0>发 <1000,500,0>fu<1500,500,0>ck <2000,500,0>傻<2500,500,0>逼! 👨‍👩‍👧‍👦'
  const filtered = processLyricContent(original, null, { preferSimplifiedChinese: false, showProfanity: false })
  assert.deepEqual(timing(filtered.content), timing(original))
  const line = parseDesktopLyrics(filtered.content)[0]
  assert.equal(line.text, '頭髮 **** **! 👨‍👩‍👧‍👦')
  assert.equal(line.words[0].word, '頭')
  assert.equal(line.words[1].word, '髮 ')
  assert.equal(line.words[2].word, '**')
  assert.equal(line.words[3].word, '** ')
  assert.equal(line.words.at(-1).endTime, 3000)
  assert.equal(processLyricContent(original, null, { showProfanity: true }).content, original)
})

test('word segmentation crosses timing tokens, preserves existing spaces and does not split foreign text', () => {
  const original = '[1000,2000]<0,200,0>我<200,200,0>喜<400,200,0>欢<600,200,0>音<800,200,0>乐，  hello world!'
  const processed = processLyricContent(original, null, { segmentLyrics: true, showProfanity: true })
  assert.deepEqual(timing(processed.content), timing(original))
  assert.equal(parseDesktopLyrics(processed.content)[0].text, '我 喜欢 音乐，  hello world!')
  assert.equal(parseDesktopLyrics(processed.content)[0].words[1].word, ' 喜')
  const japanese = '[00:00.00]君の夢が広がる\n[00:01.00]未来の音楽'
  assert.equal(processLyricContent(japanese, null, { preferSimplifiedChinese: false, segmentLyrics: true }).content, japanese)
  const korean = '[00:00.00]音樂 사랑해'
  assert.equal(processLyricContent(korean, null, { preferSimplifiedChinese: true, segmentLyrics: true }).content, korean)
})

test('filters complete profanity words without masking innocent substrings or changing whitespace', () => {
  const original = '[00:00.00]Scunthorpe class assignment butter 吹奏 操场 FUCKING Shit asshole BITCH'
  const filtered = processLyricContent(original, null, { showProfanity: false }).content
  assert.equal(filtered, '[00:00.00]Scunthorpe class assignment butter 吹奏 操场 ******* **** ******* *****')
  assert.equal(processLyricContent(original, null, { showProfanity: true }).content, original)
})

test('Chinese translation processing is independent from Japanese originals and preserves pronunciation', () => {
  const language = metadata([
    { type: 0, lyricContent: [['ki', 'mi', 'no'], ['mi', 'rai']] },
    { type: 1, lyricContent: [['音樂與夢想'], ['他媽的未來']] }
  ])
  const original = `[language:${language}]\n[00:03.00]君の音楽\n[00:01.00][00:02.00]未来へ`
  const result = processLyricContent(original, null, { preferSimplifiedChinese: true, showProfanity: false })
  const parsed = parseDesktopLyrics(result.content, result.rawData)
  assert.equal(parsed[0].text, '未来へ')
  assert.equal(parsed[0].translation, '***未来')
  assert.equal(parsed[2].text, '君の音楽')
  assert.equal(parsed[2].translation, '音乐与梦想')
  assert.deepEqual(plain(readLyricRomanization(result.content, result.rawData)), [
    { time: 1000, text: 'mi rai' }, { time: 2000, text: 'mi rai' }, { time: 3000, text: 'ki mi no' }
  ])
})

test('romanization respects offsets, Unicode Latin pronunciation, unavailable rows and source language', () => {
  const original = '[offset:500]\n[100,400]君の\n[1500,700]夢へ\n[3000,800]行こう'
  const raw = { language: { content: [{ type: 0, lyricContent: [['KIMI', 'no'], ['yū', 'me'], ['行こう']] }] } }
  assert.deepEqual(plain(readLyricRomanization(original, raw)), [{ time: 0, text: 'KIMI no' }, { time: 1000, text: 'yū me' }])
  assert.deepEqual(plain(readLyricRomanization('[00:00.00]中文歌词', raw)), [])
  assert.deepEqual(plain(readLyricRomanization('[00:00.00]君の', { language: 'broken' })), [])
  assert.deepEqual(plain(readLyricRomanization('[00:00.00]君の')), [])
})

test('malformed optional metadata and untimed literal tags leave valid lyrics available', () => {
  const original = '[language:broken]\n[ti:原始標題]\n[00:00.00]夢 <literal>  é 🌈'
  const raw = { language: 'broken', extra: 'untouched' }
  const result = processLyricContent(original, raw, { preferSimplifiedChinese: true })
  assert.equal(result.content, '[language:broken]\n[ti:原始標題]\n[00:00.00]梦 <literal>  é 🌈')
  assert.equal(result.rawData, raw)
  assert.equal(parseDesktopLyrics(result.content, result.rawData)[0].text, '梦 <literal>  é 🌈')
  assert.deepEqual(plain(processLyricContent(null)), { content: '', rawData: null })
})
