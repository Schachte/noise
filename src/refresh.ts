/**
 * Cache busting + pull-to-refresh.
 *
 * hardRefresh(): if the network is reachable, unregister the service worker and
 * delete every Cache Storage entry, then reload. The next load re-registers the
 * worker and re-caches the latest build. Offline, it only reloads, so the
 * installed app never deletes the only copy it has. Saved settings
 * (localStorage) are untouched.
 */
export async function hardRefresh(): Promise<void> {
  try {
    const online = navigator.onLine && (await fetch('/', { cache: 'no-store' })).ok
    if (online) {
      const regs = (await navigator.serviceWorker?.getRegistrations()) ?? []
      await Promise.all(regs.map((r) => r.unregister()))
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    }
  } catch {
    /* fall through to a plain reload */
  }
  location.reload()
}

/** Visiting /?refresh busts the cache once, then drops the param from the URL. */
export function handleRefreshParam(): boolean {
  const url = new URL(location.href)
  if (!url.searchParams.has('refresh')) return false
  url.searchParams.delete('refresh')
  history.replaceState(null, '', url)
  void hardRefresh()
  return true
}

const THRESHOLD = 64 // px of (damped) pull needed to trigger
const MAX = 96

/** Custom pull-to-refresh for the pinned mobile layout (native one is disabled). */
export function setupPullToRefresh(indicator: HTMLElement, card: HTMLElement): void {
  const mobile = matchMedia('(max-width: 600px)')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const label = indicator.querySelector<HTMLElement>('.ptr-label')!
  const glyph = indicator.querySelector<HTMLElement>('.ptr-glyph')!
  let startX = 0
  let startY = 0
  let pull = 0
  let state: 'idle' | 'pending' | 'pulling' | 'refreshing' = 'idle'

  const render = () => {
    const shown = Math.min(pull, MAX)
    indicator.style.setProperty('--ptr-y', `${shown - 48}px`)
    indicator.style.setProperty('--ptr-o', String(Math.min(1, shown / THRESHOLD)))
    card.style.setProperty('--pull', reduced.matches ? '0px' : `${shown * 0.4}px`)
    const ready = pull >= THRESHOLD
    indicator.classList.toggle('ready', ready)
    glyph.textContent = state === 'refreshing' ? '↻' : '↓'
    label.textContent = state === 'refreshing' ? 'refreshing' : ready ? 'release to refresh' : 'pull to refresh'
  }

  const reset = () => {
    indicator.classList.remove('dragging')
    card.classList.remove('dragging')
    pull = 0
    state = 'idle'
    render()
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      if (!mobile.matches || state === 'refreshing' || e.touches.length !== 1) return
      // Leave sliders, buttons, links and the scrollable preset row alone.
      const t = e.target as Element
      if (t.closest('input, button, a, .presets')) return
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      state = 'pending'
    },
    { passive: true },
  )

  document.addEventListener(
    'touchmove',
    (e) => {
      if (state !== 'pending' && state !== 'pulling') return
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      if (state === 'pending') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
        // must be a mostly-vertical downward drag
        if (dy <= 0 || Math.abs(dx) > dy * 0.6) return reset()
        state = 'pulling'
        indicator.classList.add('dragging')
        card.classList.add('dragging')
      }
      pull = Math.max(0, dy * 0.5) // resistance
      render()
    },
    { passive: true },
  )

  const end = () => {
    if (state !== 'pulling') {
      if (state === 'pending') state = 'idle'
      return
    }
    indicator.classList.remove('dragging')
    card.classList.remove('dragging')
    if (pull >= THRESHOLD) {
      state = 'refreshing'
      pull = THRESHOLD
      indicator.classList.add('spinning')
      render()
      void hardRefresh()
    } else {
      reset()
    }
  }
  document.addEventListener('touchend', end, { passive: true })
  document.addEventListener('touchcancel', reset, { passive: true })
}
