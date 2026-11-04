/** Abortable media/API wait; cancelling a candidate never changes the confirmed deck. */
export function waitForPlaybackOperation(operation, { signal, audio, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      audio?.removeEventListener?.('error', failed)
      if (error) reject(error)
      else resolve(value)
    }
    const cancel = () => finish(undefined, Object.assign(new Error('歌曲加载已取消'), { name: 'AbortError' }))
    const failed = () => finish(undefined, Object.assign(new Error('音频无法加载，请重试或选择其他歌曲'),
      audio?.error?.code === 2 ? { code: 'ERR_NETWORK' } : {}))
    const timer = setTimeout(() => finish(undefined, new Error('歌曲加载超时，请重试或选择其他歌曲')), timeout)
    signal?.addEventListener('abort', cancel, { once: true })
    audio?.addEventListener?.('error', failed)
    Promise.resolve(operation).then(value => finish(value), error => finish(undefined, error))
    if (signal?.aborted) cancel()
  })
}

/** Prepare one paused deck without calling play, including paused startup and quality changes. */
export function waitForPlaybackReady(audio, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('歌曲加载已取消'), { name: 'AbortError' }))
  if (audio.readyState >= 3) return Promise.resolve(true)
  let ready
  const promise = new Promise(resolve => {
    ready = () => resolve(true)
    audio.addEventListener('canplay', ready)
  })
  return waitForPlaybackOperation(promise, { signal, audio }).finally(() => audio.removeEventListener('canplay', ready))
}

/** Linear, bounded-gain crossfade. Wall-clock correction also finishes suspended/background ramps. */
export function createPlaybackTransition({ getVolume, getMuted, setGain, release, finished, now = () => performance.now(),
  schedule = callback => setTimeout(callback, 16), cancelSchedule = clearTimeout }) {
  let ramp = null
  let timer = null
  const gain = (audio, amount) => {
    if (!audio) return
    if (setGain) { setGain(audio, amount); return }
    audio.volume = Math.max(0, Math.min(1, getVolume() * amount))
    audio.muted = getMuted()
  }
  const settle = () => {
    if (timer !== null) cancelSchedule(timer)
    timer = null
    const previous = ramp
    ramp = null
    if (!previous) return
    gain(previous.incoming, 1)
    if (previous.outgoing && previous.outgoing !== previous.incoming) release(previous.outgoing)
  }
  const tick = () => {
    if (!ramp) return
    const amount = Math.max(0, Math.min(1, (now() - ramp.started) / ramp.duration))
    gain(ramp.incoming, amount)
    gain(ramp.outgoing, 1 - amount)
    if (amount >= 1 || ramp.incoming.paused) {
      settle()
      finished?.()
    } else timer = schedule(tick)
  }
  return {
    get active() { return !!ramp },
    settle,
    refresh() {
      if (!ramp) return
      if (timer !== null) cancelSchedule(timer)
      timer = null
      tick()
    },
    start(incoming, outgoing, duration) {
      settle()
      if (!outgoing || outgoing === incoming || outgoing.paused || outgoing.ended || incoming.paused || duration <= 0) {
        gain(incoming, 1)
        if (outgoing && outgoing !== incoming) release(outgoing)
        finished?.()
        return
      }
      ramp = { incoming, outgoing, duration, started: now() }
      tick()
    },
    volumeChanged(active, candidate) {
      if (ramp) this.refresh()
      else gain(active, 1)
      if (candidate && candidate !== active && candidate !== ramp?.outgoing) gain(candidate, 0)
    }
  }
}

/** Read-only navigation shared by preparation and navigation; priority entries are consumed by callers. */
export function selectPlaybackCandidate({ playlist, shuffledPlaylist, playMode, priority = [], target, direction = 1,
  attempted = [], key }) {
  const rejected = new Set(attempted)
  if (direction > 0) {
    const queued = priority.find(song => key(song) && !rejected.has(key(song)))
    if (queued) return { song: queued, priority: true }
  }
  const ordered = playMode === 'shuffle' && shuffledPlaylist.length ? shuffledPlaylist : playlist
  const targetIndex = ordered.findIndex(song => key(song) === key(target))
  for (let offset = 1; offset <= ordered.length; offset++) {
    const index = (Math.max(0, targetIndex) + direction * offset + ordered.length) % ordered.length
    const song = ordered[index]
    if (key(song) && !rejected.has(key(song)) && playlist.some(item => key(item) === key(song))) {
      return { song, priority: false }
    }
  }
  return null
}
