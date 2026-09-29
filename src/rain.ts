/**
 * Procedural rain, rendered once into a seamless stereo loop.
 *
 * Layers (each channel independent, so the field feels wide):
 *  1. wash    – band-limited pink noise: the steady hiss of distant rainfall,
 *               with slow "gust" swells that complete whole cycles per loop.
 *  2. patter  – hundreds of tiny drops per second: short noise ticks through a
 *               resonant band-pass at a random pitch, log-distributed loudness.
 *  3. plinks  – occasional drops landing in water: a decaying sine whose pitch
 *               rises (Minnaert bubble resonance).
 *  4. body    – low brown-noise rumble so it isn't all treble.
 * Drops are written modulo the loop length, and noise layers are cross-faded
 * at the seam, so the loop point is inaudible.
 */

const SECONDS = 12
const SEAM = 0.25 // seconds of cross-fade at the loop point

// Small seeded PRNG so every visit gets the same (tuned) rain.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fill `n + seam` samples via `gen`, then fold the tail into the head (equal-power). */
function seamless(n: number, seam: number, gen: (out: Float32Array) => void): Float32Array {
  const tmp = new Float32Array(n + seam)
  gen(tmp)
  const out = tmp.subarray(0, n)
  for (let i = 0; i < seam; i++) {
    const t = i / seam
    out[i] = out[i] * Math.sin((t * Math.PI) / 2) + tmp[n + i] * Math.cos((t * Math.PI) / 2)
  }
  return out
}

function wash(out: Float32Array, sr: number, rand: () => number, n: number): void {
  // Paul Kellet's pink filter
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  // one-pole high-pass ~500 Hz and low-pass ~8 kHz to shape the hiss
  const hpA = Math.exp((-2 * Math.PI * 500) / sr)
  const lpA = Math.exp((-2 * Math.PI * 8000) / sr)
  let hpX = 0, hpY = 0, lp = 0
  // gust envelope: sum of sinusoids with whole cycles per loop (periodic in n)
  const g1 = (2 * Math.PI * 1) / n, g2 = (2 * Math.PI * 3) / n, g3 = (2 * Math.PI * 7) / n
  const p1 = rand() * 6.28, p2 = rand() * 6.28, p3 = rand() * 6.28
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
    hpY = hpA * (hpY + pink - hpX)
    hpX = pink
    lp = lpA * lp + (1 - lpA) * hpY
    const gust = 1 + 0.18 * Math.sin(g1 * i + p1) + 0.1 * Math.sin(g2 * i + p2) + 0.06 * Math.sin(g3 * i + p3)
    out[i] = lp * gust
  }
}

function body(out: Float32Array, rand: () => number): void {
  let last = 0
  for (let i = 0; i < out.length; i++) {
    last = (last + 0.02 * (rand() * 2 - 1)) / 1.02
    out[i] = last * 1.2
  }
}

/** Resonant band-passed noise tick, added at `start` (wrapping). */
function tick(out: Float32Array, sr: number, rand: () => number, start: number, amp: number): void {
  const n = out.length
  const f = 1400 * Math.pow(5, rand()) // 1.4–7 kHz
  const q = 1.5 + rand() * 4
  const tau = (0.002 + rand() * 0.01) * sr // 2–12 ms decay
  const len = Math.min(Math.ceil(tau * 6), n)
  // RBJ band-pass (constant peak gain)
  const w0 = (2 * Math.PI * f) / sr
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  const b0 = alpha / a0, b2 = -alpha / a0
  const a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  const attack = sr * 0.0004
  for (let k = 0; k < len; k++) {
    const env = (k < attack ? k / attack : 1) * Math.exp(-k / tau)
    const x = (rand() * 2 - 1) * env
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    out[(start + k) % n] += y * amp
  }
}

/** Water-drop "plink": decaying sine with a rising pitch. */
function plink(out: Float32Array, sr: number, rand: () => number, start: number, amp: number): void {
  const n = out.length
  const f0 = 900 * Math.pow(3.5, rand()) // ~0.9–3 kHz
  const rise = 1 + 0.15 + rand() * 0.35
  const tau = (0.004 + rand() * 0.012) * sr
  const len = Math.min(Math.ceil(tau * 6), n)
  let phase = 0
  for (let k = 0; k < len; k++) {
    const f = f0 * (1 + (rise - 1) * (1 - Math.exp(-k / tau)))
    phase += (2 * Math.PI * f) / sr
    const env = Math.min(1, k / (sr * 0.0003)) * Math.exp(-k / tau)
    out[(start + k) % n] += Math.sin(phase) * env * amp
  }
}

function channel(sr: number, seed: number): Float32Array {
  const rand = rng(seed)
  const n = Math.floor(sr * SECONDS)
  const seam = Math.floor(sr * SEAM)

  const out = seamless(n, seam, (buf) => wash(buf, sr, rand, n))
  const low = seamless(n, seam, (buf) => body(buf, rand))
  for (let i = 0; i < n; i++) out[i] = out[i] * 0.55 + low[i] * 0.35

  // Poisson-distributed drops: exponential inter-arrival times
  const place = (rate: number, fn: (at: number, amp: number) => void, minAmp: number) => {
    for (let t = -Math.log(1 - rand()) / rate; t < SECONDS; t += -Math.log(1 - rand()) / rate) {
      // log-uniform loudness: lots of faint drops, few close ones
      fn(Math.floor(t * sr), minAmp * Math.pow(1 / minAmp, rand() ** 1.8))
    }
  }
  place(260, (at, a) => tick(out, sr, rand, at, a * 0.55), 0.04)
  place(9, (at, a) => plink(out, sr, rand, at, a * 0.12), 0.15)

  return out
}

/** Render the rain loop into a stereo AudioBuffer. */
export function createRainBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate
  const L = channel(sr, 0x5eed1)
  const R = channel(sr, 0x5eed2)
  // Normalise to a loudness close to the other noises, soft-clip the rare peak.
  let sum = 0
  for (let i = 0; i < L.length; i++) sum += L[i] * L[i] + R[i] * R[i]
  const rms = Math.sqrt(sum / (L.length * 2))
  const k = 0.2 / rms
  const buf = ctx.createBuffer(2, L.length, sr)
  const outL = buf.getChannelData(0)
  const outR = buf.getChannelData(1)
  for (let i = 0; i < L.length; i++) {
    outL[i] = Math.tanh(L[i] * k)
    outR[i] = Math.tanh(R[i] * k)
  }
  return buf
}
