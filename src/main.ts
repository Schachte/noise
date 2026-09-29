import './style.css'
import { handleRefreshParam, setupPullToRefresh } from './refresh'
import { COLORS, HARSH_NEUTRAL, NoiseEngine, soundName, type NoiseColor } from './audio'
import { AsciiViz } from './viz'
import {
  loadPrefs,
  savePrefs,
  loadPresets,
  savePresets,
  samePreset,
  MAX_PRESETS,
  type Prefs,
  type Preset,
} from './prefs'
import { setupPWA, setupMediaSession, setupInstall } from './pwa'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

const engine = new NoiseEngine()
const vizEl = $('#viz')
const viz = new AsciiViz(vizEl)
const playBtn = $<HTMLButtonElement>('#play')
const statusEl = $('#status')
const statusText = $('#status-text')
const volume = $<HTMLInputElement>('#volume')
const volumeOut = $<HTMLOutputElement>('#volume-out')
const harsh = $<HTMLInputElement>('#harsh')
const harshOut = $<HTMLOutputElement>('#harsh-out')
const favBtn = $<HTMLButtonElement>('#fav')
const themeBtn = $<HTMLButtonElement>('#theme')
const presetsEl = $('#presets')
const segmented = $('.segmented')
const headEnd = $('.head-end')
const presetsWrap = $('#presets-wrap')
const presetsToggle = $<HTMLButtonElement>('#presets-toggle')
const presetsCount = $('#presets-count')
const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const announcer = $('#announcer')
const keysRow = $('#keys')
const keysToggle = $<HTMLButtonElement>('#keys-toggle')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const mobile = matchMedia('(max-width: 600px)')

// ---- layout: fit columns to width; on mobile, fit rows to available height ----
function fitColumns(): void {
  const probe = document.createElement('span')
  probe.textContent = '0'.repeat(100)
  probe.style.cssText = 'position:absolute;visibility:hidden;letter-spacing:0'
  vizEl.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  const charW = rect.width / 100
  const lineH = parseFloat(getComputedStyle(vizEl).lineHeight) || rect.height
  const width = vizEl.clientWidth
  const cols = Math.max(24, Math.floor(width / charW))
  // Stretch glyphs with letter-spacing so the grid spans exactly edge to edge.
  const spacing = Math.max(0, (width - cols * charW) / cols - 0.01)
  vizEl.style.letterSpacing = `${spacing}px`
  const pad = parseFloat(getComputedStyle(vizEl).paddingTop) || 0
  const rows = mobile.matches
    ? Math.max(6, Math.floor((vizEl.clientHeight - pad) / lineH) - 1) // -1 for axis line
    : 10
  viz.resize(cols, rows)
  if (!engine.playing) viz.renderIdle()
}
mobile.addEventListener('change', fitColumns)
new ResizeObserver(fitColumns).observe(vizEl)

// ---- render loop (only runs while there's something to draw) ----
let raf = 0
function loop(): void {
  const alive = viz.render(engine.playing ? engine.analyser : null, engine.playing)
  if (engine.playing || alive) {
    raf = requestAnimationFrame(loop)
  } else {
    raf = 0
    viz.renderIdle()
  }
}
function kick(): void {
  if (!raf) raf = requestAnimationFrame(loop)
}

// ---- motion helpers ----
/** Restart a one-shot CSS animation class. */
function replay(el: Element, cls: string): void {
  el.classList.remove(cls)
  void (el as HTMLElement).offsetWidth
  el.classList.add(cls)
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true })
}

// ---- screen-reader announcements ----
// One always-rendered, visually hidden live region (the visible status pill is display:none on
// mobile, and live regions inside display:none never announce).
let announceTimer = 0
function announce(msg: string): void {
  clearTimeout(announceTimer)
  announcer.textContent = ''
  // clear-then-set so repeating the same message is announced again
  announceTimer = window.setTimeout(() => (announcer.textContent = msg), 60)
}

// ---- state -> UI ----
let wasPlaying = false
function sync(): void {
  const on = engine.playing
  if (on !== wasPlaying) replay(playBtn, 'flip')
  wasPlaying = on
  playBtn.querySelector('.glyph')!.textContent = on ? '\u25A0' : '\u25B6'
  playBtn.querySelector('.label')!.textContent = on ? 'stop' : 'play'
  playBtn.setAttribute('aria-label', on ? 'Stop noise' : 'Play noise')
  statusEl.dataset.on = String(on)
  statusText.textContent = on ? `${engine.color}` : 'idle'
  for (const r of radios) {
    const checked = r.dataset.color === engine.color
    r.setAttribute('aria-checked', String(checked))
    r.tabIndex = checked ? 0 : -1
  }
  document.documentElement.dataset.color = engine.color
  segmented.dataset.value = engine.color
  updateMedia(on, soundName(engine.color))
  syncPresets()
}

// ---- persistence ----
const current = (): Prefs => ({ color: engine.color, volume: +volume.value, harsh: +harsh.value })
const persist = () => savePrefs(current())

async function toggle(): Promise<void> {
  await engine.toggle()
  sync()
  // Every path (button, Space, preset chip, media keys): a focused button's changed
  // label isn't re-read by VoiceOver, so state changes go through the live region.
  announce(engine.playing ? `Playing ${soundName(engine.color)}` : 'Stopped')
  if (reducedMotion.matches && engine.playing) {
    // analyser needs a moment to fill before a static frame is meaningful
    setTimeout(() => viz.render(engine.analyser, true, true), 250)
  } else {
    kick()
  }
}

function setColor(c: NoiseColor): void {
  engine.setColor(c)
  sync()
  persist()
}

function setVolume(v: number): void {
  const pct = Math.round(Math.min(100, Math.max(0, v)))
  volume.value = String(pct)
  volumeOut.value = String(pct)
  volume.style.setProperty('--fill', `${pct}%`)
  volume.setAttribute('aria-valuetext', `${pct}%`)
  engine.setVolume(pct / 100)
  persist()
  syncPresets()
}

function harshText(pct: number): string {
  const neutral = Math.round(HARSH_NEUTRAL * 100)
  return `${pct}, ${pct < neutral - 5 ? 'soft' : pct > neutral + 5 ? 'harsh' : 'neutral'}`
}

function setHarsh(v: number): void {
  const pct = Math.round(Math.min(100, Math.max(0, v)))
  harsh.value = String(pct)
  harshOut.value = String(pct)
  harsh.style.setProperty('--fill', `${pct}%`)
  harsh.setAttribute('aria-valuetext', harshText(pct))
  engine.setHarshness(pct / 100)
  persist()
  syncPresets()
}

// ---- presets ----
let presets: Preset[] = loadPresets()
let justAdded: Preset | null = null

function presetLabel(p: Preset): string {
  return `${soundName(p.color)}, volume ${p.volume}, harshness ${p.harsh}`
}

function applyPreset(p: Preset): void {
  engine.setColor(p.color)
  setVolume(p.volume)
  setHarsh(p.harsh)
  sync()
  persist()
}

/** Click on the active preset toggles play/stop; any other preset switches to it and plays. */
async function playPreset(p: Preset): Promise<void> {
  if (samePreset(p, current())) {
    await toggle()
    return
  }
  applyPreset(p)
  if (!engine.playing) await toggle()
}

function setPresetsOpen(open: boolean): void {
  presetsToggle.setAttribute('aria-expanded', String(open))
  presetsWrap.classList.toggle('open', open)
  presetsEl.inert = !open
}

function renderPresets(): void {
  // Re-rendering replaces the buttons; remember where focus was so it isn't dropped to <body>.
  const active = document.activeElement as HTMLElement | null
  const hadFocus = !!active && presetsWrap.contains(active)
  const focusedIdx = active && presetsEl.contains(active) ? +(active.dataset.index ?? active.dataset.remove ?? -1) : -1

  presetsEl.replaceChildren(
    ...presets.map((p, i) => {
      const wrap = document.createElement('div')
      wrap.className = 'preset'
      wrap.setAttribute('role', 'listitem')

      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip'
      b.dataset.color = p.color
      b.dataset.index = String(i)
      b.setAttribute('aria-keyshortcuts', 'Delete')
      b.innerHTML = `<span class="state" aria-hidden="true"></span><span>${p.volume}·${p.harsh}</span>`

      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'chip-x'
      x.dataset.remove = String(i)
      x.setAttribute('aria-label', `Delete preset: ${presetLabel(p)}`)
      x.innerHTML = '<span aria-hidden="true">\u00D7</span>'

      wrap.append(b, x)
      if (justAdded && samePreset(p, justAdded) && !reducedMotion.matches) wrap.classList.add('enter')
      return wrap
    }),
  )
  justAdded = null
  presetsWrap.hidden = presets.length === 0
  presetsCount.textContent = String(presets.length)
  syncPresets()

  if (!hadFocus) return
  if (!presets.length) {
    favBtn.focus() // the drawer is gone; "save preset" is where new presets come from
  } else if (focusedIdx >= 0) {
    const chips = presetsEl.querySelectorAll<HTMLButtonElement>('.chip')
    chips[Math.min(focusedIdx, chips.length - 1)]?.focus()
  }
}

function syncPresets(): void {
  const cur = current()
  const saved = presets.some((p) => samePreset(p, cur))
  // One pattern only: the label names the action (no aria-pressed, which would double-announce).
  favBtn.dataset.saved = String(saved)
  favBtn.setAttribute('aria-label', saved ? 'Remove preset' : 'Save as preset')
  favBtn.querySelector('.tip-text')!.textContent = saved ? 'Remove preset' : 'Save preset'
  for (const chip of presetsEl.querySelectorAll<HTMLButtonElement>('.chip')) {
    const p = presets[+chip.dataset.index!]
    const active = samePreset(p, cur)
    const playingThis = active && engine.playing
    // aria-current marks the preset matching the current settings; play/stop is in the label.
    if (active) chip.setAttribute('aria-current', 'true')
    else chip.removeAttribute('aria-current')
    chip.setAttribute('aria-label', `${playingThis ? 'Stop' : 'Play'} preset: ${presetLabel(p)}`)
    chip.querySelector('.state')!.textContent = playingThis ? '\u25A0' : '\u25B6'
  }
}

function toggleFavourite(): void {
  const cur = current()
  const idx = presets.findIndex((p) => samePreset(p, cur))
  if (idx >= 0) {
    presets.splice(idx, 1)
    announce('Preset removed')
  } else {
    presets = [...presets, cur].slice(-MAX_PRESETS) // oldest drops off
    justAdded = cur
    replay(favBtn, 'pop')
    announce(`Preset saved: ${presetLabel(cur)}`)
  }
  savePresets(presets)
  renderPresets()
}

function removePreset(i: number): void {
  const item = presetsEl.children[i] as HTMLElement | undefined
  const commit = () => {
    presets.splice(i, 1)
    savePresets(presets)
    renderPresets() // restores focus to the neighbouring chip (or the save button if none left)
    if (!presets.length) setPresetsOpen(false)
    announce(presets.length ? 'Preset removed' : 'Preset removed. No presets left')
  }
  if (!item || reducedMotion.matches) return commit()
  item.classList.add('leaving')
  setTimeout(commit, 140)
}

// ---- theme ----
type Theme = 'light' | 'dark'
const THEME_KEY = 'noise:theme'
const systemDark = matchMedia('(prefers-color-scheme: dark)')
const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!

function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t
  themeBtn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode')
  themeBtn.querySelector('.tip-text')!.textContent = t === 'dark' ? 'Light mode' : 'Dark mode'
  themeMeta.content = getComputedStyle(document.body).backgroundColor
}

function toggleTheme(): void {
  const next: Theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* non-fatal */
  }
  replay(themeBtn, 'spin')
  announce(next === 'dark' ? 'Dark mode' : 'Light mode')
  // Cross-fade the whole page where supported; instant swap otherwise.
  if (document.startViewTransition && !reducedMotion.matches) {
    document.startViewTransition(() => applyTheme(next))
  } else {
    applyTheme(next)
  }
}

// Follow the OS only until the user picks explicitly.
systemDark.addEventListener('change', (e) => {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(THEME_KEY)
  } catch {
    /* ignore */
  }
  if (!stored) applyTheme(e.matches ? 'dark' : 'light')
})

// ---- events ----
playBtn.addEventListener('click', toggle)
// Tooltips are hoverable (WCAG 1.4.13) and live inside their button; a click on the bubble itself
// shouldn't activate the button.
const onTip = (e: Event) => !!(e.target as Element).closest('.tip')
favBtn.addEventListener('click', (e) => onTip(e) || toggleFavourite())

// Tooltip warm-up: after one tooltip shows, siblings appear instantly until the pointer leaves.
let warmTimer = 0
let coolTimer = 0
headEnd.addEventListener('pointerover', (e) => {
  if (!(e.target as Element).closest('.icon-btn')) return
  clearTimeout(coolTimer)
  if (!headEnd.classList.contains('warm')) {
    clearTimeout(warmTimer)
    warmTimer = window.setTimeout(() => headEnd.classList.add('warm'), 400)
  }
})
headEnd.addEventListener('pointerleave', () => {
  clearTimeout(warmTimer)
  coolTimer = window.setTimeout(() => headEnd.classList.remove('warm'), 500)
  headEnd.classList.remove('tips-dismissed')
})
// Escape hides a visible tooltip without moving pointer or focus (WCAG 1.4.13); it comes back on
// the next hover/focus.
headEnd.addEventListener('focusin', () => headEnd.classList.remove('tips-dismissed'))
presetsToggle.addEventListener('click', () =>
  setPresetsOpen(presetsToggle.getAttribute('aria-expanded') !== 'true'),
)
themeBtn.addEventListener('click', (e) => onTip(e) || toggleTheme())
presetsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const x = target.closest<HTMLButtonElement>('.chip-x')
  if (x) return removePreset(+x.dataset.remove!) // renderPresets() keeps focus in the list
  const chip = target.closest<HTMLButtonElement>('.chip')
  if (chip) void playPreset(presets[+chip.dataset.index!])
})
presetsEl.addEventListener('keydown', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.chip')
  if (!chip) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    removePreset(+chip.dataset.index!)
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    e.stopPropagation()
    const chips = [...presetsEl.querySelectorAll<HTMLButtonElement>('.chip')]
    const next = chips[chips.indexOf(chip) + (e.key === 'ArrowRight' ? 1 : -1)]
    next?.focus()
  }
})
volume.addEventListener('input', () => setVolume(+volume.value))
harsh.addEventListener('input', () => setHarsh(+harsh.value))
harsh.addEventListener('dblclick', () => setHarsh(HARSH_NEUTRAL * 100)) // reset to neutral

radios.forEach((r, i) => {
  r.addEventListener('click', () => setColor(r.dataset.color as NoiseColor))
  r.addEventListener('keydown', (e) => {
    // APG radio group: all four arrows move the selection (so ↑/↓ don't change volume here).
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    if (!fwd && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return
    e.preventDefault()
    e.stopPropagation()
    const next = radios[(i + (fwd ? 1 : radios.length - 1)) % radios.length]
    setColor(next.dataset.color as NoiseColor)
    next.focus()
  })
})

// ---- single-key shortcuts (can be switched off: WCAG 2.1.4) ----
const SHORTCUTS_KEY = 'noise:shortcuts'
const shortcutEls = [...document.querySelectorAll<HTMLElement>('[aria-keyshortcuts]')].filter(
  (el) => !el.classList.contains('chip'), // Delete on a chip is focus-scoped, always available
)
const shortcutAttrs = new Map(shortcutEls.map((el) => [el, el.getAttribute('aria-keyshortcuts')!]))
let shortcutsOn = true
try {
  shortcutsOn = localStorage.getItem(SHORTCUTS_KEY) !== 'off'
} catch {
  /* ignore */
}

function setShortcuts(on: boolean): void {
  shortcutsOn = on
  keysToggle.setAttribute('aria-checked', String(on))
  keysRow.classList.toggle('off', !on)
  for (const [el, keys] of shortcutAttrs) {
    if (on) el.setAttribute('aria-keyshortcuts', keys)
    else el.removeAttribute('aria-keyshortcuts')
  }
  try {
    localStorage.setItem(SHORTCUTS_KEY, on ? 'on' : 'off')
  } catch {
    /* non-fatal */
  }
}
keysToggle.addEventListener('click', () => setShortcuts(!shortcutsOn))

/** Elements that consume printable keys themselves (none today, but never hijack typing). */
function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  return el instanceof HTMLInputElement && !['range', 'button', 'checkbox', 'radio'].includes(el.type)
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') headEnd.classList.add('tips-dismissed')
  if (!shortcutsOn || e.defaultPrevented || e.isComposing) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (isTextEntry(e.target as Element)) return
  const onRange = document.activeElement instanceof HTMLInputElement
  // holding a toggle key shouldn't flicker it; adjustments may auto-repeat
  if (e.repeat && ![`ArrowUp`, 'ArrowDown', '[', ']'].includes(e.key)) return
  switch (e.key) {
    case ' ':
      if (document.activeElement instanceof HTMLButtonElement) return // native activation
      e.preventDefault()
      void toggle()
      break
    case '1':
    case '2':
    case '3': {
      const c: NoiseColor = COLORS[+e.key - 1]
      setColor(c)
      announce(soundName(c))
      break
    }
    case 'ArrowUp':
    case 'ArrowDown':
      if (onRange) return
      e.preventDefault()
      setVolume(+volume.value + (e.key === 'ArrowUp' ? 5 : -5))
      announce(`Volume ${volume.value}%`)
      break
    case '[':
    case ']':
      setHarsh(+harsh.value + (e.key === ']' ? 5 : -5))
      // a focused slider announces its own value change
      if (document.activeElement !== harsh) announce(`Harshness ${harshText(+harsh.value)}`)
      break
    case 'f':
      toggleFavourite()
      break
    case 't':
      toggleTheme()
      break
  }
})

// ---- boot ----
const updateMedia = setupMediaSession({
  play: () => void (engine.playing || toggle()),
  pause: () => void (engine.playing && toggle()),
})

const prefs = loadPrefs({ color: 'white', volume: 50, harsh: Math.round(HARSH_NEUTRAL * 100) })
engine.setColor(prefs.color)
setVolume(prefs.volume)
setHarsh(prefs.harsh)
renderPresets()
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
$('#year').textContent = String(new Date().getFullYear())
handleRefreshParam()
sync()
setShortcuts(shortcutsOn)
setupPWA()
setupPullToRefresh($('.ptr'), $('.card'))

// Share (mobile only: shown when the native share sheet exists and on small screens).
const shareBtn = $<HTMLButtonElement>('#share')
if ('share' in navigator && matchMedia('(max-width: 600px)').matches) {
  shareBtn.hidden = false
  shareBtn.addEventListener('click', () => {
    navigator
      .share({ title: 'noise', text: 'White, brown and rain noise in your browser', url: location.origin + '/' })
      .catch(() => {}) // user closed the sheet
  })
}
setupInstall({
  root: $('#install'),
  button: $<HTMLButtonElement>('#install-btn'),
  hint: $('#install-hint'),
  dismiss: $<HTMLButtonElement>('#install-dismiss'),
  fallbackFocus: playBtn,
})
