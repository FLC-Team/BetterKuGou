const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../src/utils/desktopLyrics.js'), 'utf8')
  .replace(/\bexport (?=function)/g, '')
const parse = vm.runInNewContext(`${source}\nparseDesktopLyrics`, { atob, TextDecoder, Uint8Array })
const plain = value => JSON.parse(JSON.stringify(value))
const language = rows => Buffer.from(JSON.stringify({ content: [{ type: 1, lyricContent: rows.map(row => [row]) }] }), 'utf8').toString('base64')

test('desktop LRC expands repeated timestamps, applies signed offsets and preserves Unicode and whitespace', () => {
  const result = plain(parse('\ufeff[offset:500]\r\n[00:02.5][00:01.250] 你 😀 < B & C  \r\n[00:03.00]'))
  assert.deepEqual(result, [
    { time: 750, text: ' 你 😀 < B & C  ' },
    { time: 2000, text: ' 你 😀 < B & C  ' },
    { time: 2500, text: '' }
  ])
  assert.equal(parse('[offset:-300]\n[00:01.00]Late')[0].time, 1300)
  assert.equal(parse('[00:01.00]At [00:02.00] tomorrow')[0].text, 'At [00:02.00] tomorrow')
})

test('desktop KRC preserves literal angle brackets, spaces and complete Unicode codepoints', () => {
  const result = plain(parse('[offset:500]\n[1000,3000]<0,1000,0> A < B & 😀 <1000,2000,0>世界  '))
  assert.equal(result[0].time, 500)
  assert.equal(result[0].duration, 3000)
  assert.equal(result[0].text, ' A < B & 😀 世界  ')
  assert.deepEqual(result[0].words, [
    { word: ' A < B & 😀 ', startTime: 0, endTime: 1000, duration: 1000 },
    { word: '世界  ', startTime: 1000, endTime: 3000, duration: 2000 }
  ])
})

test('offset clipping keeps word absolute ends correct at the beginning of the audio', () => {
  const [line] = parse('[offset:1500]\n[1000,2000]<0,1000,0>A<1000,1000,0>B')
  assert.equal(line.time, 0)
  assert.equal(line.duration, 1500)
  assert.deepEqual(plain(line.words), [
    { word: 'A', startTime: 0, endTime: 500, duration: 500 },
    { word: 'B', startTime: 500, endTime: 1500, duration: 1000 }
  ])
})

test('translations follow original source lines before sorting and timestamp expansion', () => {
  const raw = { language: language(['第一行 😀', ' 第二行 ']) }
  const result = parse('[00:03.00][00:01.00]First\n[00:02.00]Second', raw)
  assert.deepEqual(plain(result.map(line => [line.time, line.translation])), [
    [1000, '第一行 😀'], [2000, ' 第二行 '], [3000, '第一行 😀']
  ])
  const embedded = parse(`[language:${raw.language}]\n[1000,1000]<0,1000,0>First`)
  assert.equal(embedded[0].translation, '第一行 😀')
})

test('plain KRC gets a useful whole-line duration and bad optional metadata cannot hide original text', () => {
  const [line] = parse('[1000,2000]Plain < text  ', { language: 'invalid' })
  assert.equal(line.text, 'Plain < text  ')
  assert.equal(line.words[0].duration, 2000)
  assert.equal(line.translation, undefined)
  assert.deepEqual(plain(parse('[ar:Metadata]\n[00:99.00]Invalid time')), [])
  assert.deepEqual(plain(parse(null)), [])
})
