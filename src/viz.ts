// ASCII spectrum: log-spaced frequency columns, bottom-anchored bars.
//
// Smoothness comes from four stages:
//   1. float FFT data (no 8-bit quantisation), averaged over each column's log band
//   2. a small spatial blur across neighbouring columns (noise is spiky per bin)
//   3. time-based attack/release easing (frame-rate independent)
//   4. sub-cell glyphs for the bar top, so height moves in 1/8-row steps
const FILL = '#'
const TOP = ' .,:-=+*#' // 1/8 → 8/8 cell fill, ASCII-only
const MIN_HZ = 40
const MAX_HZ = 16000
const ATTACK_MS = 60
const RELEASE_MS = 260
const BLUR = [0.12, 0.22, 0.32, 0.22, 0.12]

export class AsciiViz {
  private freq: Float32Array<ArrayBuffer> | null = null
  private target: Float32Array
  private levels: Float32Array
  private cols: number
  private rows: number
  private el: HTMLElement
  private last = 0

  constructor(el: HTMLElement, cols = 48, rows = 10) {
    this.el = el
    this.cols = cols
    this.rows = rows
    this.levels = new Float32Array(cols)
    this.target = new Float32Array(cols)
    this.renderIdle()
  }

  resize(cols: number, rows = this.rows): void {
    this.rows = rows
    if (cols === this.cols) return
    // resample existing levels so a resize mid-play doesn't flash
    const prev = this.levels
    this.levels = new Float32Array(cols)
    for (let c = 0; c < cols; c++) this.levels[c] = prev[Math.floor((c / cols) * prev.length)] ?? 0
    this.target = new Float32Array(cols)
    this.cols = cols
  }

  renderIdle(): void {
    this.levels.fill(0)
    const blank = ' '.repeat(this.cols)
    const lines = Array.from({ length: this.rows - 1 }, () => blank)
    lines.push('.'.repeat(this.cols))
    this.el.textContent = lines.join('\n') + '\n' + this.axis()
  }

  private axis(): string {
    const labels = ['40', '100', '250', '1k', '2.5k', '6k', '16k']
    const line = Array(this.cols).fill(' ')
    const usable = this.cols < 56 ? labels.filter((_, i) => i % 2 === 0) : labels
    usable.forEach((label, i) => {
      const pos = Math.round((i / (usable.length - 1)) * (this.cols - label.length))
      for (let j = 0; j < label.length; j++) line[pos + j] = label[j]
    })
    return line.join('')
  }

  private sample(analyser: AnalyserNode): void {
    if (!this.freq || this.freq.length !== analyser.frequencyBinCount) {
      this.freq = new Float32Array(analyser.frequencyBinCount)
    }
    analyser.getFloatFrequencyData(this.freq)
    const { minDecibels: lo, maxDecibels: hi } = analyser
    const nyquist = analyser.context.sampleRate / 2
    const bins = this.freq.length
    const raw = new Float32Array(this.cols)
    const ratio = MAX_HZ / MIN_HZ

    for (let c = 0; c < this.cols; c++) {
      const f0 = MIN_HZ * Math.pow(ratio, c / this.cols)
      const f1 = MIN_HZ * Math.pow(ratio, (c + 1) / this.cols)
      // fractional bin edges → weighted average, so narrow low bands interpolate smoothly
      const b0 = (f0 / nyquist) * bins
      const b1 = Math.max(b0 + 1, (f1 / nyquist) * bins)
      let sum = 0
      let w = 0
      for (let b = Math.floor(b0); b < Math.ceil(b1); b++) {
        const weight = Math.min(b + 1, b1) - Math.max(b, b0)
        if (weight <= 0 || b >= bins) continue
        // average in linear power, then back to dB (less spiky than averaging dB)
        sum += Math.pow(10, this.freq[b] / 10) * weight
        w += weight
      }
      const db = w ? 10 * Math.log10(sum / w + 1e-20) : lo
      raw[c] = Math.min(1, Math.max(0, (db - lo) / (hi - lo)))
    }

    // spatial blur
    const r = BLUR.length >> 1
    for (let c = 0; c < this.cols; c++) {
      let acc = 0
      let wsum = 0
      for (let k = -r; k <= r; k++) {
        const i = c + k
        if (i < 0 || i >= this.cols) continue
        acc += raw[i] * BLUR[k + r]
        wsum += BLUR[k + r]
      }
      this.target[c] = acc / wsum
    }
  }

  /** Returns true while anything is still visible (for decay after stop). */
  render(analyser: AnalyserNode | null, active: boolean, snap = false): boolean {
    const now = performance.now()
    const dt = this.last ? Math.min(100, now - this.last) : 16
    this.last = now

    if (analyser && active) this.sample(analyser)
    else this.target.fill(0)

    const kUp = snap ? 1 : 1 - Math.exp(-dt / ATTACK_MS)
    const kDown = snap ? 1 : 1 - Math.exp(-dt / RELEASE_MS)
    let alive = false
    for (let c = 0; c < this.cols; c++) {
      const cur = this.levels[c]
      const t = this.target[c]
      this.levels[c] = cur + (t - cur) * (t > cur ? kUp : kDown)
      if (this.levels[c] > 0.004) alive = true
    }
    if (!alive) this.last = 0

    const steps = TOP.length - 1
    const out: string[] = []
    for (let r = this.rows - 1; r >= 0; r--) {
      let line = ''
      for (let c = 0; c < this.cols; c++) {
        const h = this.levels[c] * this.rows - r // cells of fill in this row
        if (h >= 1) line += FILL
        else if (h > 0) line += TOP[Math.max(1, Math.round(h * steps))]
        else line += r === 0 ? '.' : ' '
      }
      out.push(line)
    }
    out.push(this.axis())
    this.el.textContent = out.join('\n')
    return alive
  }
}
