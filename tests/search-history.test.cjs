const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture() {
  const saved = new Map()
  const localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) }
  const filename = path.join(__dirname, '../src/utils/searchHistory.js')
  const source = fs.readFileSync(filename, 'utf8').replace(/^export /gm, '')
  const api = vm.runInNewContext(`${source}\n;({ normalizeSearchHistory, readSearchHistory, writeSearchHistory })`, { localStorage })
  return { saved, api }
}

test('local search history bounds, deduplicates and trims submitted text without changing the original list', () => {
  const { api } = fixture()
  const original = ['  Song  ', '', 'Song', false, null, '<plain text>', 'x'.repeat(301), ...Array.from({ length: 30 }, (_, index) => `song-${index}`)]
  const history = api.normalizeSearchHistory(original)
  assert.equal(history.length, 20)
  assert.deepEqual(Array.from(history.slice(0, 3)), ['Song', '<plain text>', 'song-0'])
  assert.equal(original[0], '  Song  ')
  assert.deepEqual(Array.from(api.normalizeSearchHistory({ keyword: 'invalid container' })), [])
})

test('search history persists across instances, isolates accounts and clearing removes only the intended history', () => {
  const { api, saved } = fixture()
  api.writeSearchHistory('guest', ['Public'])
  api.writeSearchHistory('user:a', ['Private A'])
  api.writeSearchHistory('user:b', ['Private B'])
  assert.deepEqual(Array.from(api.readSearchHistory('user:a')), ['Private A'])
  assert.deepEqual(Array.from(api.readSearchHistory('user:b')), ['Private B'])
  api.writeSearchHistory('user:a', [])
  assert.deepEqual(Array.from(api.readSearchHistory('user:a')), [])
  assert.deepEqual(Array.from(api.readSearchHistory('guest')), ['Public'])
  assert.equal(saved.size, 2)
  const [key] = saved.keys()
  saved.set(key, '{broken JSON')
  assert.deepEqual(Array.from(api.readSearchHistory('guest')), [])
})

test('storage failure is observable so the caller can retain current history and offer a retry', () => {
  const { api } = fixture()
  const denied = { getItem() { throw new Error('read denied') }, setItem() { throw new Error('write denied') }, removeItem() { throw new Error('remove denied') } }
  assert.throws(() => api.readSearchHistory('guest', denied), /read denied/)
  assert.throws(() => api.writeSearchHistory('guest', ['Song'], denied), /write denied/)
  assert.throws(() => api.writeSearchHistory('guest', [], denied), /remove denied/)
})
