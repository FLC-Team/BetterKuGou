const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync } = require('esbuild')

const sourcePath = path.join(__dirname, '../src/utils/objectUtils.js')
const compiled = transformSync(fs.readFileSync(sourcePath, 'utf8'), { format: 'cjs' }).code
const loaded = new Module(sourcePath, module)
loaded.paths = module.paths
loaded._compile(compiled, sourcePath)
const { mergeDeep, replaceReactive } = loaded.exports

test('merging and replacement reject dangerous nested keys before any target mutation', () => {
  for (const operation of [mergeDeep, replaceReactive]) {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const target = { retained: true, theme: 'dark' }
      const payload = JSON.parse(`{"theme":"light","session":{"playlist":[{"${key}":{"polluted":true}}]}}`)
      assert.throws(() => operation(target, payload), /Unsafe object key/)
      assert.deepEqual(target, { retained: true, theme: 'dark' })
    }
  }
  assert.equal({}.polluted, undefined)
})

test('normal merges preserve nested values and replace arrays', () => {
  const target = { nested: { first: 1 }, songs: [1, 2] }
  assert.equal(mergeDeep(target, { nested: { second: 2 }, songs: [3] }), target)
  assert.deepEqual(target, { nested: { first: 1, second: 2 }, songs: [3] })
})

test('replacement removes absent own keys while preserving the existing object reference', () => {
  const target = { toString: 'old', retained: false, nested: { first: 1, second: 2 } }
  assert.equal(replaceReactive(target, { nested: { second: 3 } }), target)
  assert.deepEqual(target, { nested: { second: 3 } })
})
