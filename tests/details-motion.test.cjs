const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../src/components/common/detailsMotion.js'), 'utf8')
const createDetailsMotion = new Function(source.replace('export function', 'function') + '\nreturn createDetailsMotion')()

/** Model native open geometry and a controllable WAAPI timeline, without inspecting implementation text. */
function fixture({ open = false, reduced = false } = {}) {
  const listeners = new Map(), preferenceListeners = new Map(), animations = []
  let resize, disconnected = false, active = null
  const summary = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) }
  const content = {}
  const preference = { matches: reduced, addEventListener: (key, fn) => preferenceListeners.set(key, fn), removeEventListener: key => preferenceListeners.delete(key) }
  const details = { open, style: { overflow: 'clip', boxSizing: '' }, children: [summary, content], fullHeight: 240, closedHeight: 44,
    querySelector: () => summary,
    getBoundingClientRect() { return { height: active ? active.height : this.open ? this.fullHeight : this.closedHeight } },
    animate(frames, options) {
      const animation = { frames, options, height: parseFloat(frames[0].height), cancelled: false,
        cancel() { this.cancelled = true; if (active === this) active = null },
        finish() { this.onfinish?.() }
      }
      active = animation; animations.push(animation); return animation
    },
    ownerDocument: { defaultView: { matchMedia: () => preference,
      ResizeObserver: class { constructor(callback) { resize = callback } observe() {} disconnect() { disconnected = true } }
    } }
  }
  const motion = createDetailsMotion(details)
  const click = (target = { closest: () => null }, defaultPrevented = false) => {
    let prevented = false
    listeners.get('click')?.({ target, defaultPrevented, preventDefault() { prevented = true } })
    return prevented
  }
  return { details, motion, animations, preference, listeners, preferenceListeners, click,
    resize: () => resize(), disconnected: () => disconnected }
}

test('native summary activation keeps the content open until its closing animation completes', () => {
  const ui = fixture()
  assert.equal(ui.click(), true)
  assert.equal(ui.details.open, true)
  assert.equal(ui.animations[0].frames[1].height, '240px')
  ui.animations[0].finish()
  assert.equal(ui.details.style.overflow, 'clip')
  ui.click()
  assert.equal(ui.details.open, true)
  assert.equal(ui.animations[1].frames[1].height, '44px')
  ui.animations[1].finish()
  assert.equal(ui.details.open, false)
  ui.motion.dispose()
})

test('rapid reversal starts from the current displayed height and ignores stale animation completions', () => {
  const ui = fixture()
  ui.motion.setOpen(true)
  ui.animations[0].height = 110
  ui.motion.setOpen(false)
  assert.equal(ui.animations[1].frames[0].height, '110px')
  ui.animations[0].finish()
  assert.equal(ui.details.open, true, 'a cancelled open cannot finish a later close')
  ui.animations[1].height = 75
  ui.motion.setOpen(true)
  assert.equal(ui.animations[2].frames[0].height, '75px')
  ui.animations[1].finish()
  ui.animations[2].finish()
  assert.equal(ui.details.open, true)
  assert.equal(ui.details.style.boxSizing, '')
  ui.motion.dispose()
})

test('dynamic shrinking content is measured without the old animated height becoming a minimum', () => {
  const ui = fixture()
  ui.motion.setOpen(true)
  ui.animations[0].height = 160
  ui.details.fullHeight = 90
  ui.resize()
  assert.equal(ui.animations[1].frames[0].height, '160px')
  assert.equal(ui.animations[1].frames[1].height, '90px')
  ui.animations[1].finish()
  assert.equal(ui.details.getBoundingClientRect().height, 90)
  ui.motion.dispose()
})

test('reduced motion settles immediately, including a preference change during a pending close', () => {
  const ui = fixture({ reduced: true })
  ui.motion.setOpen(true)
  assert.equal(ui.details.open, true)
  assert.equal(ui.animations.length, 0)
  ui.preference.matches = false
  ui.motion.setOpen(false)
  ui.preference.matches = true
  ui.preferenceListeners.get('change')()
  assert.equal(ui.details.open, false)
  assert.equal(ui.animations[0].cancelled, true)
  ui.motion.dispose()
})

test('nested summary controls retain their action, and disposing releases all animation listeners', () => {
  const ui = fixture()
  assert.equal(ui.click({ closest: () => ({ tagName: 'BUTTON' }) }), false)
  assert.equal(ui.click({ closest: () => null }, true), false)
  assert.equal(ui.animations.length, 0)
  ui.motion.setOpen(true)
  ui.motion.dispose()
  assert.equal(ui.animations[0].cancelled, true)
  assert.equal(ui.listeners.size, 0)
  assert.equal(ui.preferenceListeners.size, 0)
  assert.equal(ui.disconnected(), true)
  ui.motion.setOpen(false)
  assert.equal(ui.details.open, true)
})
