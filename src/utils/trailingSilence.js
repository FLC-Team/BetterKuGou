const MAX_FILE_BYTES = 64 * 1024 ** 2
const MAX_PCM_BYTES = 128 * 1024 ** 2
const MAX_DURATION = 600
const RMS_LIMIT = 10 ** (-65 / 20)
const PEAK_LIMIT = 10 ** (-55 / 20)
const ANALYSIS_VERSION = 1

function validMetadata(audio) {
  return Number.isFinite(audio?.duration) && audio.duration > 0 && audio.duration <= MAX_DURATION &&
    Number.isInteger(audio.channels) && audio.channels >= 1 && audio.channels <= 8 &&
    Number.isInteger(audio.sampleRate) && audio.sampleRate >= 8000 && audio.sampleRate <= 96000 &&
    Math.ceil(audio.duration * audio.sampleRate) * audio.channels * 4 <= MAX_PCM_BYTES
}

/** Inspect every channel independently; a later sound always ends the trailing silent suffix. */
export async function findTrailingSilence(buffer, mediaDuration, {
  isCurrent = () => true, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0))
} = {}) {
  const { duration, sampleRate, numberOfChannels: channels, length } = buffer || {}
  if (!validMetadata({ duration, sampleRate, channels }) || !Number.isSafeInteger(length) || length <= 0 ||
      length * channels * 4 > MAX_PCM_BYTES || Math.abs(duration - length / sampleRate) > 1e-9 ||
      !Number.isFinite(mediaDuration) || mediaDuration <= 0 ||
      Math.abs(duration - mediaDuration) > 0.1) return null
  const windowStart = Math.ceil(Math.max(duration - 15, duration * 0.9) * sampleRate)
  const blockSize = Math.max(1, Math.round(sampleRate * 0.05))
  const samples = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel))
  if (samples.some(channel => channel.length !== length)) return null
  let silentStart = length
  let foundSound = false
  let processed = 0
  // One guard block establishes the sound-to-silence boundary at the window edge.
  const scanStart = Math.max(0, windowStart - blockSize)
  for (let end = length; end > scanStart;) {
    if (!isCurrent()) return null
    const start = Math.max(scanStart, end - blockSize)
    let silent = true
    for (const channel of samples) {
      let sum = 0
      for (let index = start; index < end; index++) {
        const value = channel[index]
        if (!Number.isFinite(value)) return null
        if (Math.abs(value) > PEAK_LIMIT) { silent = false; break }
        sum += value * value
      }
      if (!silent || Math.sqrt(sum / (end - start)) > RMS_LIMIT) { silent = false; break }
    }
    if (!silent) { foundSound = true; break }
    silentStart = Math.max(windowStart, start)
    processed += (end - start) * channels
    end = start
    if (processed >= 65_536) { processed = 0; await yieldControl() }
  }
  const silenceStart = silentStart / sampleRate
  if (!isCurrent() || !foundSound || duration - silenceStart < 1.5 - 1e-9) return null
  return { silenceStart, skipAt: silenceStart + 0.25, duration }
}

/** Read a bounded complete response; never buffer an unexpectedly large body before checking it. */
async function readAudioBytes(response, expectedSize, signal) {
  if (!response?.ok || response.status === 206 || !response.body?.getReader) {
    await response?.body?.cancel?.()
    return null
  }
  const advertised = response.headers?.get?.('content-length')
  if (advertised != null && Number(advertised) !== expectedSize) { await response.body.cancel(); return null }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  let complete = false
  try {
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (signal.aborted) return null
      if (chunk.done) { complete = true; break }
      size += chunk.value.byteLength
      if (size > expectedSize || size > MAX_FILE_BYTES) return null
      chunks.push(chunk.value)
    }
    if (!complete || size !== expectedSize) return null
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes.buffer
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * Analyze only leased complete cache files, independently of the audible media elements.
 * Native decode cannot be aborted: stale results are discarded and the next decode waits for it.
 */
export function createTrailingSilenceAnalyzer({ getSource, releaseSource, onError = () => {},
  fetch: fetchAudio = (...args) => globalThis.fetch(...args),
  createContext = sampleRate => new globalThis.OfflineAudioContext(1, 1, sampleRate),
  timeoutMs = 10_000 } = {}) {
  let disposed = false
  let version = 0
  let activeJob = null
  let pendingJob = null
  let draining = false
  const results = new Map()

  function report(error) {
    try { onError(error) } catch { /* Optional diagnostics must not affect playback or lease cleanup. */ }
  }
  async function release(leaseId) {
    if (!leaseId) return
    try { await releaseSource?.(leaseId) } catch (error) { report(error) }
  }
  function cancel() {
    version++
    for (const job of [activeJob, pendingJob]) {
      if (!job) continue
      job.controller.abort()
      clearTimeout(job.timer)
      job.resolve(null)
    }
    pendingJob = null
  }
  function remember(key, result) {
    results.delete(key)
    results.set(key, result)
    if (results.size > 32) results.delete(results.keys().next().value)
  }
  async function analyze(job) {
    const current = () => !disposed && job.version === version && !job.controller.signal.aborted
    if (!current() || !Number.isFinite(job.mediaDuration) || job.mediaDuration <= 0 ||
        job.mediaDuration > MAX_DURATION || !job.song?.hash || typeof getSource !== 'function') return null
    let source
    try {
      source = await getSource({ hash: job.song.hash, quality: job.quality, purpose: 'analysis', allowFallback: false,
        ...(job.song.source === 'cloud' ? { source: 'cloud', sourceUserId: job.song.sourceUserId } : {}) })
      if (!current() || source?.status !== 1 || !source.leaseId ||
          !/^bk-cache:\/\/media\/[a-f\d]{48}$/.test(source.url) || !/^[a-f\d]{64}$/i.test(source.sha256) ||
          !Number.isSafeInteger(source.size) || source.size <= 0 || source.size > MAX_FILE_BYTES ||
          !validMetadata(source.audioMetadata) || Math.abs(source.audioMetadata.duration - job.mediaDuration) > 0.1) return null
      const key = JSON.stringify([job.sessionVersion, job.song.source || 'catalog', job.song.sourceUserId || '',
        String(job.song.hash).toLowerCase(), job.quality, source.sha256, ANALYSIS_VERSION])
      if (results.has(key)) {
        const cached = results.get(key)
        remember(key, cached)
        return cached && Math.abs(cached.duration - job.mediaDuration) <= 0.1 ? { ...cached } : null
      }
      const response = await fetchAudio(source.url, { signal: job.controller.signal, credentials: 'omit', cache: 'no-store' })
      if (!current()) { await response?.body?.cancel?.(); return null }
      const bytes = await readAudioBytes(response, source.size, job.controller.signal)
      if (!bytes || !current()) return null
      const context = createContext(source.audioMetadata.sampleRate)
      const buffer = await context.decodeAudioData(bytes)
      if (!current()) return null
      if (buffer.sampleRate !== source.audioMetadata.sampleRate || buffer.numberOfChannels !== source.audioMetadata.channels) return null
      const result = await findTrailingSilence(buffer, job.mediaDuration, { isCurrent: current })
      if (!current()) return null
      remember(key, result)
      return result ? { ...result } : null
    } catch (error) {
      if (current()) report(error)
      return null
    } finally { await release(source?.leaseId) }
  }
  /** Keep only the latest pending identity even while an uncancellable native decode is stalled. */
  async function drain() {
    if (draining) return
    draining = true
    try {
      while (pendingJob) {
        const job = pendingJob
        pendingJob = null
        activeJob = job
        try { job.resolve(await analyze(job)) } catch (error) {
          report(error)
          job.resolve(null)
        } finally { clearTimeout(job.timer); activeJob = null }
      }
    } finally { draining = false }
  }
  function request(song, quality, mediaDuration, sessionVersion) {
    cancel()
    if (disposed) return Promise.resolve(null)
    let resolve
    const promise = new Promise(done => { resolve = done })
    const job = { song: { hash: song?.hash, source: song?.source, sourceUserId: song?.sourceUserId },
      quality, mediaDuration, sessionVersion, version,
      controller: new AbortController(), resolve, timer: null }
    pendingJob = job
    job.timer = setTimeout(() => {
      job.controller.abort()
      job.resolve(null)
      if (pendingJob === job) pendingJob = null
    }, timeoutMs)
    void drain()
    return promise
  }
  function dispose() { disposed = true; cancel(); results.clear() }
  return { request, cancel, dispose }
}
