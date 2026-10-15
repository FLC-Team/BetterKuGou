import { isReactive, toRaw } from 'vue'

const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

function assertSafeKeys(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  Object.keys(value).forEach((key) => {
    if (unsafeKeys.has(key)) {
      throw new TypeError(`Unsafe object key: ${key}`)
    }
    assertSafeKeys(value[key], seen)
  })
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

export function cloneDeep(value) {
  if (value === undefined) return undefined
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch (err) {
      // fall through to JSON clone
    }
  }
  return JSON.parse(JSON.stringify(value))
}

/** 原地合并对象和替换数组；先拒绝原型字段，避免不可信配置污染状态。 */
export function mergeDeep(target, source) {
  if (!isPlainObject(target) && !Array.isArray(target)) {
    throw new TypeError('mergeDeep target must be an object or array')
  }
  if (!isPlainObject(source) && !Array.isArray(source)) {
    throw new TypeError('mergeDeep source must be an object or array')
  }
  assertSafeKeys(source)

  const output = target

  Object.keys(source).forEach((key) => {
    const sourceValue = source[key]
    const targetValue = output[key]

    if (Array.isArray(sourceValue)) {
      output[key] = sourceValue.slice()
      return
    }

    if (isPlainObject(sourceValue)) {
      if (!isPlainObject(targetValue)) {
        output[key] = {}
      }
      mergeDeep(output[key], sourceValue)
      return
    }

    if (sourceValue === undefined) {
      delete output[key]
      return
    }

    output[key] = sourceValue
  })

  return output
}

/** 保持响应式对象引用并替换其内容，在删除旧字段前验证全部输入。 */
export function replaceReactive(target, source) {
  if (!isPlainObject(target) && !Array.isArray(target)) {
    throw new TypeError('replaceReactive target must be an object or array')
  }
  if (!isPlainObject(source) && !Array.isArray(source)) {
    throw new TypeError('replaceReactive source must be an object or array')
  }
  assertSafeKeys(source)

  const rawTarget = isReactive(target) ? toRaw(target) : target

  Object.keys(rawTarget).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key]
    }
  })

  Object.keys(source).forEach((key) => {
    const sourceValue = source[key]

    if (Array.isArray(sourceValue)) {
      target[key] = sourceValue.slice()
      return
    }

    if (isPlainObject(sourceValue)) {
      if (!isPlainObject(target[key])) {
        target[key] = {}
      }
      replaceReactive(target[key], sourceValue)
      return
    }

    target[key] = sourceValue
  })

  return target
}

export function createWritableCopy(value) {
  const cloned = cloneDeep(value)
  if (Array.isArray(cloned)) {
    return [...cloned]
  }
  if (isPlainObject(cloned)) {
    return { ...cloned }
  }
  return cloned
}
