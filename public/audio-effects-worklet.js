/* Dedicated audio thread: bounded buffers only, never waits for a host response. */
class BkAudioEffectsProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const settings = options.processorOptions || {}
    this.blockFrames = 512
    this.bridgeFrames = Number.isInteger(settings.bridgeFrames) ? settings.bridgeFrames : Math.ceil(sampleRate * 0.064 / 128) * 128
    this.maxLatency = Math.ceil(sampleRate * 10)
    this.capacity = this.maxLatency + this.bridgeFrames + this.blockFrames * 4
    this.dry = new Float32Array(this.capacity * 2)
    this.block = new Float32Array(this.blockFrames * 2)
    this.analysis = new Float32Array(2048)
    this.analysisOffset = 0
    this.analysisSequence = 0
    this.pendingAnalysis = new Set()
    this.wetSlots = Array.from({ length: 32 }, () => ({ sequence: -1, pcm: new Float32Array(this.blockFrames * 2) }))
    this.hostPort = null
    this.generation = 0
    this.frame = 0
    this.generationFrame = 0
    this.blockOffset = 0
    this.sequence = 0
    this.latency = 0
    this.previousLatency = 0
    this.latencyFade = 0
    this.enabled = false
    this.playing = false
    this.draining = false
    this.drainUntil = 0
    this.drainEndPosition = null
    this.tailSamples = 0
    this.disposed = false
    this.hostAvailable = true
    this.wetMix = 0
    this.wasWet = false
    this.lastOutput = new Float32Array(2)
    this.fallbackCorrection = new Float32Array(2)
    this.correctionMix = 0
    this.trackId = ''
    this.trackFrame = 0
    this.trackPosition = 0
    this.trackToken = 0
    this.presentedMarker = null
    this.presentationMarkers = []
    this.presentationEpoch = 0
    this.tempo = null
    this.automaticTempo = true
    this.reportAt = 0
    this.statusReportAt = 0
    this.underruns = 0
    this.lastMissingSequence = -1
    this.pending = new Set()
    this.overloaded = false
    this.port.onmessage = event => this.control(event.data)
  }

  sendHost(message) {
    if (!this.hostPort || this.disposed) return
    try { this.hostPort.postMessage(message) } catch {
      this.hostAvailable = false
      this.hostPort = null
      this.port.postMessage({ type: 'status', state: 'failed', error: '音效连接中断，已恢复原声播放' })
    }
  }

  reset(position) {
    this.generation++
    this.frame = 0
    this.generationFrame = 0
    this.blockOffset = 0
    this.sequence = 0
    this.analysisOffset = 0
    this.pendingAnalysis.clear()
    this.trackFrame = 0
    this.trackPosition = Math.max(0, Number(position) || 0)
    this.presentedMarker = { frame: 0, position: this.trackPosition, trackId: this.trackId, token: this.trackToken }
    this.presentationMarkers = []
    this.wetMix = 0
    this.wasWet = false
    this.correctionMix = 0
    this.lastOutput.fill(0)
    this.latencyFade = 0
    this.reportAt = 0
    this.statusReportAt = 0
    this.draining = false
    this.drainEndPosition = null
    this.lastMissingSequence = -1
    this.pending.clear()
    this.overloaded = false
    this.dry.fill(0)
    for (const slot of this.wetSlots) slot.sequence = -1
    this.sendHost({ type: 'reset', generation: this.generation, trackId: this.trackId, position: this.trackPosition })
  }

  setLatency(samples) {
    if (!Number.isInteger(samples) || samples < 0 || samples === this.latency) return
    if (samples > this.maxLatency) {
      this.hostAvailable = false
      this.port.postMessage({ type: 'status', state: 'failed', error: '插件延迟超过支持的 10 秒上限，已恢复原声播放' })
      return
    }
    const position = this.trackPosition + Math.max(0, this.frame - this.trackFrame) / sampleRate
    this.previousLatency = this.latency
    this.latency = samples
    this.latencyFade = Math.ceil(sampleRate * 0.01)
    this.generation++
    this.generationFrame = this.frame
    this.blockOffset = 0
    this.sequence = 0
    this.analysisOffset = 0
    this.pending.clear()
    this.pendingAnalysis.clear()
    this.overloaded = false
    this.wetMix = 0
    for (const slot of this.wetSlots) slot.sequence = -1
    // Keep the dry history while the new native generation warms up.
    this.sendHost({ type: 'reset', generation: this.generation, trackId: this.trackId, position })
    this.port.postMessage({ type: 'status', reason: 'resync-required', detail: 'plugin-latency-changed',
      latencySamples: this.enabled ? this.bridgeFrames + this.latency : 0, pluginLatencySamples: this.latency })
  }

  control(message) {
    if (!message || this.disposed) return
    if (message.type === 'connect') {
      const replacing = !!this.hostPort || this.frame > 0
      this.hostPort?.close?.()
      this.hostPort = message.port
      this.hostPort.onmessage = event => this.receive(event.data)
      this.hostPort.start?.()
      this.sendHost({ type: 'configure', sampleRate, frames: this.blockFrames, channels: 2 })
      if (replacing) {
        this.generation++
        this.generationFrame = this.frame
        this.blockOffset = 0
        this.sequence = 0
        this.pending.clear(); this.pendingAnalysis.clear()
        this.analysisOffset = 0
        this.overloaded = false; this.hostAvailable = true; this.wetMix = 0
        for (const slot of this.wetSlots) slot.sequence = -1
        this.sendHost({ type: 'reset', generation: this.generation, trackId: this.trackId,
          position: this.trackPosition + Math.max(0, this.frame - this.trackFrame) / sampleRate })
      }
      this.sendHost({ type: 'track', trackId: this.trackId, generation: this.generation, position: this.trackPosition })
      this.sendHost({ type: 'transport', playing: this.playing, generation: this.generation,
        position: this.trackPosition + Math.max(0, this.frame - this.trackFrame) / sampleRate })
    } else if (message.type === 'enabled') {
      this.presentationEpoch = Number.isSafeInteger(message.epoch) ? message.epoch : this.presentationEpoch
      if (this.enabled !== (message.value === true)) {
        this.enabled = message.value === true
        this.reset(message.position ?? this.trackPosition)
        this.port.postMessage({ type: 'status', enabled: this.enabled, latencySamples: this.enabled ? this.bridgeFrames + this.latency : 0 })
      }
    } else if (message.type === 'track') {
      if (message.changed || message.trackId !== this.trackId) {
        this.trackId = message.trackId || ''
        this.trackToken = Number.isSafeInteger(message.token) ? message.token : this.trackToken + 1
        this.trackFrame = this.frame
        this.trackPosition = Math.max(0, Number(message.position) || 0)
        // Input identity changes immediately for the host/BPM tap. Presentation
        // identity changes only when these samples reach the output of the delay.
        const marker = { frame: this.frame, position: this.trackPosition, trackId: this.trackId, token: this.trackToken }
        if (!this.presentedMarker || (!this.presentedMarker.trackId && !this.presentationMarkers.length)) this.presentedMarker = marker
        else if (this.presentationMarkers.at(-1)?.frame === marker.frame) this.presentationMarkers[this.presentationMarkers.length - 1] = marker
        else this.presentationMarkers.push(marker)
        this.analysisOffset = 0
        this.draining = false
        this.drainEndPosition = null
        this.automaticTempo = true
        this.tempo = null
        this.sendHost({ type: 'track', trackId: this.trackId, generation: this.generation, position: this.trackPosition })
      }
      this.playing = message.playing === true
      if (this.playing) { this.draining = false; this.drainEndPosition = null }
      this.report(true)
    } else if (message.type === 'clear') {
      this.trackId = ''
      this.playing = false
      this.draining = false
      this.drainEndPosition = null
      this.automaticTempo = true
      this.tempo = null
      this.reset(0)
      this.sendHost({ type: 'track', trackId: '', generation: this.generation, position: 0 })
      this.report(true)
    } else if (message.type === 'transport') {
      if (message.seeking) {
        this.presentationEpoch = Number.isSafeInteger(message.epoch) ? message.epoch : this.presentationEpoch
        this.reset(message.position)
      }
      this.playing = message.playing === true
      if (this.playing) { this.draining = false; this.drainEndPosition = null }
      else if (message.ended && this.enabled) {
        const endPosition = Math.max(0, Number(message.position) || 0)
        if (this.drainEndPosition !== endPosition) {
          this.draining = true
          this.drainEndPosition = endPosition
          this.drainUntil = this.frame + this.bridgeFrames + this.latency + Math.min(this.tailSamples, sampleRate * 10)
        }
      } else this.draining = false
      this.sendHost({ type: 'transport', generation: this.generation, playing: this.playing, position: message.position, seeking: message.seeking === true })
      this.report(true)
    } else if (message.type === 'latency') this.setLatency(message.samples)
    else if (message.type === 'tail') this.tailSamples = message.samples === -1 ? sampleRate * 10 : Number.isSafeInteger(message.samples) && message.samples >= 0 ? message.samples : 0
    else if (message.type === 'host-state') {
      this.hostAvailable = message.available === true
      if (this.hostAvailable && this.overloaded) this.reset(this.trackPosition + Math.max(0, this.frame - this.trackFrame) / sampleRate)
    }
    else if (message.type === 'tempo') {
      this.tempo = Number.isFinite(message.bpm) ? message.bpm : null
      this.automaticTempo = message.automatic !== false
    } else if (message.type === 'dispose') {
      this.sendHost({ type: 'disconnect' })
      this.disposed = true
      this.hostPort?.close?.()
      this.hostPort = null
    }
  }

  receive(message) {
    if (!message || this.disposed) return
    if (message.type === 'analysis-ack') {
      if (message.generation === this.generation) this.pendingAnalysis.delete(message.sequence)
      return
    }
    if (message.type === 'tempo') {
      if (message.trackId && message.trackId !== this.trackId) return
      if (message.generation !== undefined && message.generation !== this.generation) return
      if (this.automaticTempo && Number.isFinite(message.bpm)) this.tempo = message.bpm
      this.port.postMessage(message)
      return
    }
    if (message.type === 'status') {
      if (message.error) this.hostAvailable = false
      if (message.state === 'ready' || message.running === true) {
        this.hostAvailable = true
        if (this.overloaded) this.reset(this.trackPosition + Math.max(0, this.frame - this.trackFrame) / sampleRate)
      }
      if (Number.isInteger(message.latencySamples)) this.setLatency(message.latencySamples)
      if (message.tailSamples === -1) this.tailSamples = sampleRate * 10
      else if (Number.isSafeInteger(message.tailSamples) && message.tailSamples >= 0) this.tailSamples = message.tailSamples
      return
    }
    if (message.type !== 'audio' || message.generation !== this.generation || !Number.isInteger(message.sequence)) return
    const sequence = message.sequence
    this.pending.delete(sequence)
    if (sequence < 0 || sequence >= this.sequence || sequence < Math.floor((this.frame - this.generationFrame - this.bridgeFrames) / this.blockFrames) - 1) return
    if (Number.isInteger(message.latencySamples) && message.latencySamples !== this.latency) {
      this.setLatency(message.latencySamples)
      return
    }
    // Native control/state work may acknowledge a block with unprocessed PCM.
    // Its timing differs from the wet chain, so use our already aligned dry ring.
    if (message.bypassed === true) return
    const pcm = message.pcm
    if (!pcm || pcm.length !== this.blockFrames * 2 || message.frames !== this.blockFrames || message.channels !== 2) return
    const slot = this.wetSlots[sequence % this.wetSlots.length]
    if (slot.sequence >= sequence) return
    for (let index = 0; index < pcm.length; index++) slot.pcm[index] = Number.isFinite(pcm[index]) ? pcm[index] : 0
    slot.sequence = sequence
    this.hostAvailable = true
  }

  report(force = false, contextTimestamp = currentTime) {
    if (!force && this.frame < this.reportAt) return
    this.reportAt = this.frame + 2048
    const audibleFrame = this.frame - (this.enabled ? this.bridgeFrames + this.latency : 0)
    while (this.presentationMarkers.length && this.presentationMarkers[0].frame <= audibleFrame) {
      this.presentedMarker = this.presentationMarkers.shift()
    }
    const marker = this.presentedMarker || { trackId: this.trackId, token: this.trackToken, frame: this.trackFrame, position: this.trackPosition }
    const nextMarker = this.presentationMarkers[0]
    const maxPosition = Math.min(marker.token === this.trackToken ? this.drainEndPosition ?? Infinity : Infinity,
      nextMarker ? marker.position + Math.max(0, nextMarker.frame - marker.frame) / sampleRate : Infinity)
    const position = Math.min(maxPosition, marker.position + Math.max(0, audibleFrame - marker.frame) / sampleRate)
    this.port.postMessage({ type: 'presentation', trackId: marker.trackId, token: marker.token,
      sourceTrackId: this.trackId, sourceToken: this.trackToken, generation: this.generation,
      epoch: this.presentationEpoch,
      position, draining: this.draining,
      contextTime: contextTimestamp, maxPosition: Number.isFinite(maxPosition) ? maxPosition : null,
      advancing: (this.playing || this.draining) && audibleFrame >= marker.frame && position < maxPosition,
      latencySamples: this.enabled ? this.bridgeFrames + this.latency : 0 })
    if (force || this.frame >= this.statusReportAt) {
      this.statusReportAt = this.frame + sampleRate
      this.port.postMessage({ type: 'status', underruns: this.underruns,
        latencySamples: this.enabled ? this.bridgeFrames + this.latency : 0, bypassed: !this.hostAvailable })
    }
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (this.disposed || !output?.length) return false
    const input = inputs[0] || []
    const analysisInput = inputs[1] || []
    const frames = output[0].length
    if (!this.playing && !this.draining) {
      for (const channel of output) channel.fill(0)
      return true
    }
    for (let offset = 0; offset < frames; offset++) {
      if (this.presentationMarkers[0]?.frame <= this.frame - (this.enabled ? this.bridgeFrames + this.latency : 0)) {
        this.report(true, currentTime + offset / sampleRate)
      }
      if (this.draining && this.frame >= this.drainUntil) {
        this.draining = false
        this.report(true, currentTime + offset / sampleRate)
      }
      if (!this.playing && !this.draining) {
        output[0][offset] = 0
        if (output[1]) output[1][offset] = 0
        continue
      }
      const left = this.draining ? 0 : input[0]?.[offset] || 0
      const right = this.draining ? 0 : input[1]?.[offset] ?? left
      if (this.playing && this.automaticTempo && this.trackId && analysisInput.length) {
        const sample = ((analysisInput[0]?.[offset] || 0) + (analysisInput[1]?.[offset] ?? analysisInput[0]?.[offset] ?? 0)) * 0.5
        this.analysis[this.analysisOffset++] = sample
        if (this.analysisOffset === this.analysis.length) {
          if (this.hostPort && this.pendingAnalysis.size < 4) {
            const sequence = this.analysisSequence++
            this.pendingAnalysis.add(sequence)
            this.sendHost({ type: 'analysis', trackId: this.trackId, generation: this.generation, sequence,
              sampleRate, channels: 1, frames: this.analysis.length,
              position: Math.max(0, this.trackPosition + (this.frame + 1 - this.analysis.length - this.trackFrame) / sampleRate),
              pcm: this.analysis })
          }
          this.analysisOffset = 0
        }
      }
      if (!this.enabled) {
        output[0][offset] = left
        if (output[1]) output[1][offset] = right
        this.frame++
        continue
      }
      const dryIndex = (this.frame % this.capacity) * 2
      this.dry[dryIndex] = left
      this.dry[dryIndex + 1] = right
      this.block[this.blockOffset] = left
      this.block[this.blockOffset + this.blockFrames] = right
      this.blockOffset++
      if (this.blockOffset === this.blockFrames) {
        const sequence = this.sequence++
        if (this.hostPort && !this.overloaded && this.pending.size < 32) {
          this.pending.add(sequence)
          this.sendHost({ type: 'audio', generation: this.generation, sequence, frames: this.blockFrames,
            sampleRate, channels: 2, tempo: this.tempo, trackId: this.trackId,
            position: Math.max(0, this.trackPosition + (this.frame + 1 - this.blockFrames - this.trackFrame) / sampleRate),
            playing: this.playing, pcm: this.block })
        } else if (this.pending.size >= 32 && !this.overloaded) {
          this.overloaded = true
          this.hostAvailable = false
          this.port.postMessage({ type: 'status', state: 'failed', error: '音效处理超时，已恢复原声播放；可重新启用音效重试' })
        }
        this.blockOffset = 0
      }
      const wetFrame = this.frame - this.bridgeFrames
      const dryFrame = wetFrame - this.latency
      const dryRead = dryFrame >= 0 ? (dryFrame % this.capacity) * 2 : -1
      const wetGenerationFrame = wetFrame - this.generationFrame
      const sequence = Math.floor(wetGenerationFrame / this.blockFrames)
      const slot = sequence >= 0 ? this.wetSlots[sequence % this.wetSlots.length] : null
      const hasWet = this.hostAvailable && slot?.sequence === sequence
      if (!hasWet && sequence >= 0 && sequence !== this.lastMissingSequence) {
        this.lastMissingSequence = sequence
        this.underruns++
      }
      // A short gain ramp masks wet/dry changes without changing the presentation clock.
      const step = 1 / Math.max(1, sampleRate * 0.005)
      this.wetMix = Math.max(0, Math.min(1, this.wetMix + (hasWet ? step : -step)))
      const wetRead = wetGenerationFrame % this.blockFrames
      let dryLeft = dryRead >= 0 ? this.dry[dryRead] : 0
      let dryRight = dryRead >= 0 ? this.dry[dryRead + 1] : 0
      if (this.latencyFade > 0) {
        const oldFrame = wetFrame - this.previousLatency
        const oldRead = oldFrame >= 0 ? (oldFrame % this.capacity) * 2 : -1
        const amount = this.latencyFade / Math.ceil(sampleRate * 0.01)
        dryLeft = dryLeft * (1 - amount) + (oldRead >= 0 ? this.dry[oldRead] : 0) * amount
        dryRight = dryRight * (1 - amount) + (oldRead >= 0 ? this.dry[oldRead + 1] : 0) * amount
        this.latencyFade--
      }
      if (!hasWet && this.wasWet) {
        this.fallbackCorrection[0] = this.lastOutput[0] - dryLeft
        this.fallbackCorrection[1] = this.lastOutput[1] - dryRight
        this.correctionMix = 1
      }
      this.wasWet = hasWet
      dryLeft += this.fallbackCorrection[0] * this.correctionMix
      dryRight += this.fallbackCorrection[1] * this.correctionMix
      this.correctionMix = Math.max(0, this.correctionMix - step)
      const mix = hasWet ? this.wetMix : 0
      output[0][offset] = dryLeft * (1 - mix) + (hasWet ? slot.pcm[wetRead] : 0) * mix
      if (output[1]) output[1][offset] = dryRight * (1 - mix) + (hasWet ? slot.pcm[wetRead + this.blockFrames] : 0) * mix
      this.lastOutput[0] = output[0][offset]
      this.lastOutput[1] = output[1]?.[offset] ?? output[0][offset]
      this.frame++
    }
    this.report(false, currentTime + frames / sampleRate)
    return true
  }
}

registerProcessor('bk-audio-effects', BkAudioEffectsProcessor)
