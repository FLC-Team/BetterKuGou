const BLOCK_FRAMES = 512
const PORT_TIMEOUT_MS = 10000
let connectionSequence = 0

/** Transfer the one-use audio capability without exposing Electron IPC to the page. */
export function connectAudioEffectsPort(api, page = globalThis.window, timeout = PORT_TIMEOUT_MS, signal) {
  if (!api?.connectAudio || !page?.addEventListener) return Promise.reject(new Error('当前环境不支持音频插件连接'))
  const connectionId = `audio-${Date.now()}-${++connectionSequence}`
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (port, error) => {
      if (settled) { port?.close?.(); return }
      settled = true
      clearTimeout(timer)
      page.removeEventListener('message', receive)
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve(port)
    }
    const receive = event => {
      if (event.source !== page || event.data?.type !== 'bk-audio-effects-port' || event.data.connectionId !== connectionId) return
      const ports = event.ports || []
      if (ports.length !== 1) {
        ports.forEach(port => port.close?.())
        finish(null, new Error('音频插件连接返回了无效通道'))
        return
      }
      finish(ports[0])
    }
    const aborted = () => finish(null, new Error('音频插件连接已取消'))
    const timer = setTimeout(() => finish(null, new Error('音频插件连接超时，请重试')), timeout)
    page.addEventListener('message', receive)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) { aborted(); return }
    Promise.resolve().then(() => api.connectAudio(connectionId)).then(result => {
      if (result?.ok === false || result?.error) finish(null, new Error(result.error?.message || result.error || '音频插件连接失败'))
    }, error => finish(null, error))
  })
}

function bounded(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

/**
 * Own one WebAudio graph. Call attach only for CORS-authorized media, before play.
 * The player continues owning source selection and media transactions; this module
 * owns deck gains, post-effect volume and the audible clock, never a second queue.
 */
export function createAudioEffectsEngine({ api = globalThis.window?.electronAPI?.audioEffects, onStatus = () => {}, onTempo = () => {},
  onPresentation = () => {}, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  AudioWorkletNodeClass = globalThis.AudioWorkletNode, page = globalThis.window,
  workletUrl = new URL('audio-effects-worklet.js', globalThis.document?.baseURI || 'http://localhost/').href } = {}) {
  const decks = new Map()
  const sources = new WeakMap()
  let context = null
  let worklet = null
  let mix = null
  let master = null
  let initialized = null
  let disposed = false
  let desiredEnabled = false
  let volume = 1
  let muted = false
  let activeAudio = null
  let activeTrackId = ''
  let activeTrackToken = 0
  let presentationEpoch = 0
  let playing = false
  let draining = false
  let presentation = null
  let unsubscribe = null
  let graphFailed = false
  let automaticTempo = true
  let connectedGeneration = null
  let reconnecting = null
  let attemptedGeneration = null
  const initializationAbort = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null
  let status = { ready: false, enabled: false, latencySamples: 0, sampleRate: 0 }

  const emitStatus = patch => { status = { ...status, ...patch }; onStatus({ ...status }) }
  const send = message => { if (!disposed && worklet) worklet.port.postMessage(message) }
  const gainValue = (node, value, instant = false) => {
    if (!node || !context) return
    node.gain.cancelScheduledValues(context.currentTime)
    if (instant || !node.gain.setTargetAtTime) node.gain.setValueAtTime(value, context.currentTime)
    else node.gain.setTargetAtTime(value, context.currentTime, 0.005)
  }

  /** A failed worklet is permanently silent, so reconnect the dry graph explicitly. */
  const failGraph = error => {
    if (disposed || graphFailed) return
    graphFailed = true
    mix?.disconnect()
    mix?.connect(master)
    worklet?.disconnect()
    presentation = null
    emitStatus({ ready: false, enabled: false, error: error?.message || String(error) })
    onPresentation(engine.getPresentedPlayback())
  }

  const handleStatus = value => {
    if (disposed || !value || typeof value !== 'object') return
    if (value.type === 'tempo' || (value.tempo && typeof value.tempo === 'object') || Number.isFinite(value.bpm)) {
      const tempo = value.tempo || value
      if (!tempo.trackId || tempo.trackId === activeTrackId) {
        onTempo(tempo)
        const manual = Number.isFinite(tempo.manualBpm) ? tempo.manualBpm : null
        if (Object.prototype.hasOwnProperty.call(tempo, 'manualBpm')) automaticTempo = manual === null
        const bpm = manual || (Number.isFinite(tempo.bpm) ? tempo.bpm : 120)
        if (automaticTempo || manual) send({ type: 'tempo', bpm, automatic: manual === null })
      }
    }
    if (Number.isFinite(value.latencySamples)) send({ type: 'latency', samples: value.latencySamples })
    if (Number.isSafeInteger(value.tailSamples)) send({ type: 'tail', samples: value.tailSamples })
    // A host failure uses the worklet's aligned dry audio; it does not tear down the clock.
    if (value.error || value.state === 'failed') send({ type: 'host-state', available: false })
    if ((value.state === 'ready' || value.available === true || value.running === true) && !value.reconnectRequired && !reconnecting) send({ type: 'host-state', available: true })
    emitStatus(value)
    if (Number.isSafeInteger(value.audioConnectionGeneration)) {
      if (!value.reconnectRequired && !reconnecting) connectedGeneration = value.audioConnectionGeneration
      else if (value.reconnectRequired && value.running && value.audioConnectionGeneration !== connectedGeneration &&
        value.audioConnectionGeneration !== attemptedGeneration && !reconnecting && worklet) {
        const generation = value.audioConnectionGeneration
        attemptedGeneration = generation
        reconnecting = connectAudioEffectsPort(api, page, PORT_TIMEOUT_MS, initializationAbort?.signal).then(port => {
          if (disposed) { port.close(); return }
          worklet.port.postMessage({ type: 'connect', port }, [port])
          connectedGeneration = generation
          emitStatus({ ready: true, error: '' })
        }).catch(error => { if (!disposed) emitStatus({ error: '音频效果重新连接失败：' + error.message }) })
          .finally(() => { reconnecting = null })
      }
    }
  }

  const engine = {
    async init() {
      if (disposed) throw new Error('音频效果引擎已关闭')
      if (initialized) return initialized
      initialized = (async () => {
        if (!AudioContextClass || !AudioWorkletNodeClass) throw new Error('当前环境不支持音频效果处理')
        context = new AudioContextClass({ latencyHint: 'playback' })
        await context.audioWorklet.addModule(workletUrl)
        if (disposed) throw new Error('音频效果初始化已取消')
        mix = context.createGain()
        master = context.createGain()
        worklet = new AudioWorkletNodeClass(context, 'bk-audio-effects', {
          numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
          processorOptions: { blockFrames: BLOCK_FRAMES, bridgeFrames: Math.ceil(context.sampleRate * 0.064 / 128) * 128 }
        })
        worklet.port.onmessage = event => {
          if (disposed) return
          const message = event.data
          if (message?.type === 'presentation') {
            if ((message.sourceTrackId ?? message.trackId) !== activeTrackId ||
                (message.sourceToken != null && message.sourceToken !== activeTrackToken) ||
                (message.epoch != null && message.epoch !== presentationEpoch)) return
            presentation = message
            draining = message.draining === true
            onPresentation({ ...message })
          } else if (message?.type === 'tempo') onTempo(message)
          else if (message?.type === 'status') emitStatus(message)
        }
        worklet.onprocessorerror = () => failGraph(new Error('音频处理器异常，已恢复原声播放'))
        mix.connect(worklet, 0, 0)
        worklet.connect(master)
        master.connect(context.destination)
        gainValue(master, muted ? 0 : volume, true)
        const port = await connectAudioEffectsPort(api, page, PORT_TIMEOUT_MS, initializationAbort?.signal)
        if (disposed) { port.close(); throw new Error('音频效果初始化已取消') }
        // MessagePort must be transferred, not cloned.
        worklet.port.postMessage({ type: 'connect', port }, [port])
        send({ type: 'enabled', value: desiredEnabled, epoch: presentationEpoch })
        unsubscribe = api?.onStatus?.(handleStatus) || null
        emitStatus({ ready: true, enabled: desiredEnabled, sampleRate: context.sampleRate })
        Promise.resolve(api?.getStatus?.()).then(handleStatus, error => emitStatus({ error: error.message }))
        return engine
      })().catch(async error => {
        if (!decks.size) {
          worklet?.disconnect()
          master?.disconnect()
          await context?.close?.().catch(() => {})
          context = null; worklet = null; mix = null; master = null
          initialized = null
        }
        emitStatus({ ready: false, error: error.message })
        throw error
      })
      return initialized
    },

    /** Each element gets exactly one source node throughout this graph's lifetime. */
    async attach(audio) {
      if (!audio) throw new Error('缺少待连接的音频元素')
      await engine.init()
      if (disposed) throw new Error('音频效果引擎已关闭')
      if (decks.has(audio)) return decks.get(audio)
      if (audio.crossOrigin !== 'anonymous') throw new Error('音频源尚未完成跨域授权，无法启用音效')
      const previous = sources.get(audio)
      const gain = previous?.gain || context.createGain()
      gain.connect(mix)
      let source
      try { source = previous?.source || context.createMediaElementSource(audio) } catch (error) {
        gain.disconnect()
        throw error
      }
      const deck = { source, gain }
      sources.set(audio, deck)
      decks.set(audio, deck)
      try { source.connect(gain) } catch (error) {
        gain.disconnect()
        source.connect(master)
        failGraph(error)
        throw error
      }
      audio.volume = 1
      audio.muted = false
      gainValue(gain, 0, true)
      return deck
    },

    detach(audio) {
      const deck = decks.get(audio)
      if (!deck) return
      if (activeAudio === audio) engine.clearActiveTrack()
      deck.source.disconnect()
      deck.gain.disconnect()
      decks.delete(audio)
    },

    setDeckGain(audio, amount) {
      const deck = decks.get(audio)
      if (!deck) return false
      audio.volume = 1
      audio.muted = false
      gainValue(deck.gain, bounded(amount), true)
      return true
    },

    setMaster(nextVolume, nextMuted = false) {
      volume = bounded(nextVolume, volume)
      muted = nextMuted === true
      gainValue(master, muted ? 0 : volume)
    },

    setActiveTrack({ audio, trackId, position = audio?.currentTime || 0, playing: nextPlaying = false, continuous = false } = {}) {
      if (!audio) { engine.clearActiveTrack(); return true }
      if (!decks.has(audio)) return false
      if (activeAudio && activeAudio !== audio) {
        try { decks.get(activeAudio)?.source.disconnect(worklet, 0, 1) } catch { /* The old analysis tap may already be detached. */ }
      }
      const changed = continuous || activeAudio !== audio || activeTrackId !== String(trackId || '')
      if (changed && activeAudio && !presentation) presentation = { trackId: activeTrackId, token: activeTrackToken,
        position: Math.max(0, Number(activeAudio.currentTime) || 0), contextTime: context?.currentTime || 0, advancing: false }
      if (activeAudio !== audio) decks.get(audio).source.connect(worklet, 0, 1)
      activeAudio = audio
      activeTrackId = String(trackId || '')
      playing = nextPlaying === true
      draining = false
      if (changed) { activeTrackToken++; automaticTempo = true }
      send({ type: 'track', trackId: activeTrackId, token: activeTrackToken,
        position: Math.max(0, Number(position) || 0), playing, changed })
      if (playing) context?.resume?.().catch(error => emitStatus({ error: error.message }))
      return true
    },

    clearActiveTrack() {
      if (activeAudio) {
        try { decks.get(activeAudio)?.source.disconnect(worklet, 0, 1) } catch { /* The deck can already be detached during stop. */ }
      }
      activeAudio = null; activeTrackId = ''; playing = false; draining = false; presentation = null; automaticTempo = true
      activeTrackToken++
      send({ type: 'clear' })
    },

    /** Pausing freezes queued samples; only an explicit seek invalidates old packets. */
    transport({ playing: nextPlaying = playing, seeking = false, ended = false, position = activeAudio?.currentTime || 0 } = {}) {
      if (!nextPlaying && playing && presentation) {
        presentation = { ...presentation, position: engine.getPresentedPlayback().position,
          contextTime: context?.currentTime || 0, advancing: false }
      }
      playing = nextPlaying === true
      draining = !playing && ended === true && desiredEnabled
      if (seeking) { presentation = null; presentationEpoch++ }
      send({ type: 'transport', playing, seeking: seeking === true, ended: ended === true,
        epoch: presentationEpoch, position: Math.max(0, Number(position) || 0) })
      if (playing) context?.resume?.().catch(error => emitStatus({ error: error.message }))
    },

    setEnabled(value) {
      desiredEnabled = value === true
      presentation = null
      presentationEpoch++
      send({ type: 'enabled', value: desiredEnabled, epoch: presentationEpoch, position: activeAudio?.currentTime || 0 })
      emitStatus({ enabled: desiredEnabled && !graphFailed })
      onPresentation(engine.getPresentedPlayback())
    },

    setTempo(value) {
      automaticTempo = value?.automatic !== false
      send({ type: 'tempo', bpm: Number.isFinite(value?.bpm) ? value.bpm : null,
        automatic: automaticTempo })
    },

    getPresentationTime(audio, rawTime = audio?.currentTime || 0) {
      const raw = Math.max(0, Number(rawTime) || 0)
      if (!desiredEnabled || graphFailed || audio !== activeAudio || !presentation) return raw
      if (presentation.token != null && presentation.token !== activeTrackToken) return raw
      return Math.max(0, Math.min(raw, engine.getPresentedPlayback().position))
    },

    /** Output identity follows buffered samples, independently of the host's current input identity. */
    getPresentedPlayback() {
      if (!activeAudio) return null
      if (!desiredEnabled || graphFailed || !presentation) return { trackId: activeTrackId, token: activeTrackToken,
        position: Math.max(0, Number(activeAudio.currentTime) || 0), advancing: playing }
      const elapsed = (playing || draining) && presentation.advancing
        ? Math.max(0, (context?.currentTime || 0) - presentation.contextTime) : 0
      const maximum = Number.isFinite(presentation.maxPosition) ? presentation.maxPosition : Infinity
      return { ...presentation, position: Math.max(0, Math.min(maximum, presentation.position + elapsed)) }
    },

    get activePresentationToken() { return activeTrackToken },

    get ready() { return !!status.ready && !disposed },
    get graphReady() { return !!context && !!master && !!mix && !disposed },
    hasDeck(audio) { return decks.has(audio) },
    get sampleRate() { return context?.sampleRate || 0 },
    get latencySamples() { return status.latencySamples || 0 },

    async dispose() {
      if (disposed) return
      disposed = true
      initializationAbort?.abort()
      unsubscribe?.()
      unsubscribe = null
      worklet?.port.postMessage({ type: 'dispose' })
      for (const deck of decks.values()) { deck.source.disconnect(); deck.gain.disconnect() }
      decks.clear()
      mix?.disconnect(); worklet?.disconnect(); master?.disconnect()
      worklet?.port.close?.()
      await context?.close?.()
      activeAudio = null; presentation = null
    }
  }
  return engine
}
