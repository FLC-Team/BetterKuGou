/** Count elapsed, advancing playback only; each confirmed play instance can upload once with bounded retries. */
export function createListeningHistory({ getIdentity, isEnabled, upload, now = () => performance.now(),
  unixTime = () => Math.floor(Date.now() / 1000), setTimer = setTimeout, clearTimer = clearTimeout,
  onFailure = () => {} }) {
  let instance = null
  let disposed = false
  const account = () => {
    const value = getIdentity() || {}
    return { userId: String(value.userId || ''), token: value.token || '' }
  }
  const valid = record => {
    const current = account()
    return !disposed && instance === record && isEnabled() && record.account.userId && record.account.token &&
      current.userId === record.account.userId && current.token === record.account.token && !record.controller.signal.aborted
  }
  function reset() {
    if (instance) {
      instance.controller.abort()
      if (instance.timer != null) clearTimer(instance.timer)
    }
    instance = null
  }
  function begin(song, { preserve = false } = {}) {
    if (preserve && instance && valid(instance)) { instance.anchor = null; return }
    reset()
    const identity = account()
    const mixId = song?.album_audio_id ?? song?.MixSongID ?? song?.mixsongid
    if (disposed || !isEnabled() || !identity.userId || !identity.token || !/^\d+$/.test(String(mixId)) || Number(mixId) <= 0 ||
        (song?.source === 'cloud' && String(song.sourceUserId) !== identity.userId)) return
    instance = { song: { album_audio_id: mixId }, account: identity, controller: new AbortController(),
      elapsed: 0, anchor: null, qualified: false, attempts: 0, timer: null, time: null }
  }
  async function submit(record) {
    if (!valid(record)) { if (instance === record) reset(); return }
    record.attempts++
    try {
      await upload(record.song, { time: record.time, pc: 1, signal: record.controller.signal })
      if (valid(record)) record.sent = true
    } catch (error) {
      if (!valid(record)) return
      const permanent = ['ERR_CANCELED', 'KUGOU_AUTH_EXPIRED', 'LOGIN_REQUIRED', 'INVALID_LIBRARY_INPUT', 'LIBRARY_REQUEST_FAILED'].includes(error?.code)
      if (!permanent && record.attempts < 3) {
        record.timer = setTimer(() => { record.timer = null; void submit(record) }, record.attempts * 1500)
      } else onFailure({ code: error?.code || 'HISTORY_UPLOAD_FAILED', attempts: record.attempts })
    }
  }
  function sample({ position, duration, playing, ready, seeking = false, waiting = false, rate = 1 }) {
    const record = instance
    if (!record) return
    if (!valid(record)) { reset(); return }
    if (record.qualified) return
    const clock = now()
    const advancing = playing && ready && !seeking && !waiting && Number.isFinite(position) && position >= 0 && Number.isFinite(rate) && rate > 0
    const previous = record.anchor
    record.anchor = advancing ? { clock, position, rate } : null
    if (!advancing || !previous || previous.rate !== rate) return
    const elapsed = (clock - previous.clock) / 1000
    const progress = position - previous.position
    // Discontinuities, suspended tabs and backward seeks never create listening credit.
    if (elapsed <= 0 || elapsed > 5 || progress <= 0 || progress > elapsed * rate + 0.5) return
    record.elapsed += Math.min(elapsed, progress / rate)
    const threshold = Number.isFinite(duration) && duration > 0 ? Math.min(30, duration / 2) : 30
    if (record.elapsed + 0.0001 < threshold) return
    record.qualified = true
    record.time = unixTime()
    void submit(record)
  }
  return {
    begin, sample, reset,
    discontinuity() { if (instance) instance.anchor = null },
    dispose() { disposed = true; reset() },
  }
}
