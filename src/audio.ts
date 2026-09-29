import { createRainBuffer } from './rain'

export type NoiseColor = 'white' | 'brown' | 'rain'
export const COLORS: readonly NoiseColor[] = ['white', 'brown', 'rain']
export const isColor = (v: unknown): v is NoiseColor => COLORS.includes(v as NoiseColor)
/** Human label: "white noise", "brown noise", "rain". */
export const soundName = (c: NoiseColor): string => (c === 'rain' ? 'rain' : `${c} noise`)

const BUFFER_SECONDS = 4
const FADE = 0.08
export const HARSH_NEUTRAL = 0.7

/**
 * Below NEUTRAL: log-sweep a lowpass from 200 Hz up to 20 kHz (softer -> open).
 * Above NEUTRAL: fully open, plus up to +10 dB of 3.8 kHz presence (the "hiss" band).
 */
export function harshToParams(h: number): { cutoff: number; presenceDb: number } {
  const lo = Math.min(h / HARSH_NEUTRAL, 1)
  const hi = Math.max(0, (h - HARSH_NEUTRAL) / (1 - HARSH_NEUTRAL))
  return { cutoff: 200 * Math.pow(100, lo), presenceDb: hi * 10 }
}

function fillWhite(data: Float32Array): void {
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
}

// Leaky integrator over white noise -> 1/f^2 (brown/red) spectrum.
function fillBrown(data: Float32Array): void {
  let last = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    last = (last + 0.02 * white) / 1.02
    data[i] = last * 3.5
  }
}

// iOS/iPadOS: the mute switch silences Web Audio unless the page holds a
// "playback" audio session, and the session drops when the app backgrounds.
// A looping inaudible <audio> keeps both alive; other platforms skip it.
const isIOS = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

export class NoiseEngine {
  private ctx: AudioContext | null = null
  private keep: HTMLAudioElement | null = null
  private gain!: GainNode
  private lowpass!: BiquadFilterNode
  private presence!: BiquadFilterNode
  private source: AudioBufferSourceNode | null = null
  private buffers = new Map<NoiseColor, AudioBuffer>()
  readonly analyser!: AnalyserNode

  color: NoiseColor = 'white'
  volume = 0.5
  /** 0 = soft/muffled, NEUTRAL = unfiltered, 1 = bright/harsh. */
  harshness = HARSH_NEUTRAL
  playing = false

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx
    const ctx = new AudioContext()
    this.gain = ctx.createGain()
    this.gain.gain.value = 0

    // Tone chain: source -> lowpass -> presence -> gain
    this.lowpass = ctx.createBiquadFilter()
    this.lowpass.type = 'lowpass'
    this.lowpass.Q.value = 0.5
    this.presence = ctx.createBiquadFilter()
    this.presence.type = 'peaking'
    this.presence.frequency.value = 3800
    this.presence.Q.value = 0.8
    this.lowpass.connect(this.presence)
    this.presence.connect(this.gain)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.82
    analyser.minDecibels = -100
    analyser.maxDecibels = -10
    this.gain.connect(analyser)
    analyser.connect(ctx.destination)
    ;(this as { analyser: AnalyserNode }).analyser = analyser
    this.ctx = ctx
    this.applyHarshness(true)
    // iOS PWA: the context can suspend when the app is backgrounded or the screen
    // locks. Resume on return to the app and on any touch while playing.
    document.addEventListener('visibilitychange', () => {
      if (this.playing) this.recover()
    })
    window.addEventListener('pointerdown', () => {
      if (this.playing) this.recover()
    })
    ctx.onstatechange = () => {
      // 'interrupted' is Safari-only (calls, Siri); resume when it clears.
      if (this.playing && (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted')) {
        void ctx.resume().catch(() => {})
      }
    }
    return ctx
  }

  private applyHarshness(immediate = false): void {
    if (!this.ctx) return
    const { cutoff, presenceDb } = harshToParams(this.harshness)
    const now = this.ctx.currentTime
    const set = (p: AudioParam, v: number) =>
      immediate ? p.setValueAtTime(v, now) : p.setTargetAtTime(v, now, 0.03)
    set(this.lowpass.frequency, cutoff)
    set(this.presence.gain, presenceDb)
  }

  setHarshness(h: number): void {
    this.harshness = Math.min(1, Math.max(0, h))
    this.applyHarshness()
  }

  private buffer(color: NoiseColor): AudioBuffer {
    const ctx = this.ensure()
    let buf = this.buffers.get(color)
    if (!buf) {
      if (color === 'rain') {
        buf = createRainBuffer(ctx)
      } else {
        buf = ctx.createBuffer(1, ctx.sampleRate * BUFFER_SECONDS, ctx.sampleRate)
        const data = buf.getChannelData(0)
        color === 'white' ? fillWhite(data) : fillBrown(data)
      }
      this.buffers.set(color, buf)
    }
    return buf
  }

  private startSource(): void {
    const ctx = this.ensure()
    const src = ctx.createBufferSource()
    src.buffer = this.buffer(this.color)
    src.loop = true
    src.connect(this.lowpass)
    src.start()
    this.source = src
  }

  private stopSource(at: number): void {
    const src = this.source
    if (!src) return
    src.stop(at)
    src.onended = () => src.disconnect()
    this.source = null
  }

  private ramp(to: number): number {
    const ctx = this.ensure()
    const now = ctx.currentTime
    const g = this.gain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(to, now + FADE)
    return now + FADE
  }

  /**
   * Everything up to starting the source runs synchronously: iOS only honours
   * audio started inside the tap itself, and an `await` ends the tap.
   */
  async play(): Promise<void> {
    if (this.playing) return
    // Safari 17+: official switch from "ambient" (silenced by the mute switch)
    // to "playback" audio.
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = 'playback'
    const ctx = this.ensure()
    if (isIOS()) {
      if (!this.keep) {
        this.keep = new Audio('/silence.wav')
        this.keep.loop = true
        this.keep.setAttribute('playsinline', '')
      }
      void this.keep.play().catch(() => {})
    }
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume()
    this.startSource()
    this.ramp(this.volume)
    this.playing = true
    // Rain takes ~0.2–1 s to render; do it while idle so switching to it is instant.
    if (!this.buffers.has('rain')) {
      const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 500))
      idle(() => this.buffer('rain'))
    }
    await resumed.catch(() => {})
  }

  stop(): void {
    if (!this.playing || !this.ctx) return
    this.stopSource(this.ramp(0))
    this.playing = false
    this.keep?.pause()
  }

  /** Re-grab the audio session after iOS interruptions, backgrounding or lock. */
  private recover(): void {
    if (this.ctx && (this.ctx.state === 'suspended' || (this.ctx.state as string) === 'interrupted')) {
      void this.ctx.resume().catch(() => {})
    }
    if (this.keep && this.keep.paused) void this.keep.play().catch(() => {})
  }

  toggle(): Promise<void> | void {
    return this.playing ? this.stop() : this.play()
  }

  setColor(color: NoiseColor): void {
    if (color === this.color) return
    this.color = color
    if (!this.playing || !this.ctx) return
    this.recover()
    // Crossfade: fade out current, swap, fade back in.
    const end = this.ramp(0)
    this.stopSource(end)
    window.setTimeout(() => {
      if (!this.playing || this.source) return
      this.startSource()
      this.ramp(this.volume)
    }, FADE * 1000)
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    if (this.playing && this.ctx) this.ramp(this.volume)
  }
}
