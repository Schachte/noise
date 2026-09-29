import { isColor, type NoiseColor } from './audio'

export interface Prefs {
  color: NoiseColor
  volume: number // 0–100
  harsh: number // 0–100
}

const KEY = 'noise:prefs:v1'

const clamp = (n: unknown, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback

export function loadPrefs(defaults: Prefs): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null
    if (!raw || typeof raw !== 'object') return defaults
    return {
      color: isColor(raw.color) ? raw.color : defaults.color,
      volume: clamp(raw.volume, defaults.volume),
      harsh: clamp(raw.harsh, defaults.harsh),
    }
  } catch {
    return defaults // private mode / corrupt JSON
  }
}

let timer = 0
/** Debounced so slider drags don't hammer storage. */
export function savePrefs(prefs: Prefs): void {
  clearTimeout(timer)
  timer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs))
    } catch {
      /* storage full or unavailable — non-fatal */
    }
  }, 150)
}

// ---- presets (favourites) ----

export type Preset = Prefs
const PRESETS_KEY = 'noise:presets:v1'
export const MAX_PRESETS = 6

export const samePreset = (a: Preset, b: Preset) =>
  a.color === b.color && a.volume === b.volume && a.harsh === b.harsh

export function loadPresets(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    const fallback: Prefs = { color: 'white', volume: 50, harsh: 70 }
    return raw
      .filter((p): p is Partial<Prefs> => !!p && typeof p === 'object')
      .map((p) => loadFrom(p, fallback))
      .slice(0, MAX_PRESETS)
  } catch {
    return []
  }
}

function loadFrom(raw: Partial<Prefs>, d: Prefs): Prefs {
  return {
    color: isColor(raw.color) ? raw.color : d.color,
    volume: clamp(raw.volume, d.volume),
    harsh: clamp(raw.harsh, d.harsh),
  }
}

export function savePresets(presets: Preset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets))
  } catch {
    /* non-fatal */
  }
}
