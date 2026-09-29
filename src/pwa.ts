import { registerSW } from 'virtual:pwa-register'

export function setupPWA(): void {
  // Service worker only in production builds (dev keeps HMR clean).
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    registerSW({ immediate: true })
  }
}

interface MediaHandlers {
  play: () => void
  pause: () => void
}

/** Lock-screen / hardware media-key controls. */
export function setupMediaSession({ play, pause }: MediaHandlers): (playing: boolean, title: string) => void {
  const ms = 'mediaSession' in navigator ? navigator.mediaSession : null
  if (ms) {
    ms.setActionHandler('play', play)
    ms.setActionHandler('pause', pause)
    ms.setActionHandler('stop', pause)
  }
  return (playing, title) => {
    if (!ms) return
    ms.playbackState = playing ? 'playing' : 'paused'
    ms.metadata = new MediaMetadata({
      title,
      artist: 'noise',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    })
  }
}

// ---- install prompt ----

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const HINT_KEY = 'noise:install-hint-dismissed'

const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

// iOS Safari (not Chrome/Firefox shells) has no install API — only the Share menu.
const isIOSSafari = () => {
  const ua = navigator.userAgent
  const iOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
  return iOS && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua)
}

/**
 * Mobile install affordance. Android/Chromium: button → native install sheet.
 * iOS Safari: dismissible hint pointing at the Share menu. Hidden once installed.
 * (Visibility on desktop is suppressed in CSS.)
 */
export function setupInstall(els: {
  root: HTMLElement
  button: HTMLButtonElement
  hint: HTMLElement
  dismiss: HTMLButtonElement
  /** Where focus goes if it was inside the row when the row disappears. */
  fallbackFocus?: HTMLElement
}): void {
  const { root, button, hint, dismiss, fallbackFocus } = els
  if (isStandalone()) return
  let deferred: BeforeInstallPromptEvent | null = null

  /** Hide the row without dropping keyboard/screen-reader focus to <body>. */
  const hideRoot = () => {
    const hadFocus = root.contains(document.activeElement)
    root.hidden = true
    if (hadFocus) fallbackFocus?.focus()
  }
  const hide = () => {
    hideRoot()
    deferred = null
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // suppress the mini-infobar; we show our own button
    deferred = e as BeforeInstallPromptEvent
    button.hidden = false
    hint.hidden = true
    root.hidden = false
  })

  button.addEventListener('click', async () => {
    if (!deferred) return
    const evt = deferred
    deferred = null // a prompt can only be used once
    await evt.prompt()
    const { outcome } = await evt.userChoice
    if (outcome === 'accepted') hide()
    else hideRoot() // Chrome will re-fire beforeinstallprompt later if eligible
  })

  window.addEventListener('appinstalled', hide)

  let dismissed = false
  try {
    dismissed = localStorage.getItem(HINT_KEY) === '1'
  } catch {
    /* ignore */
  }
  if (isIOSSafari() && !dismissed) {
    button.hidden = true
    hint.hidden = false
    root.hidden = false
    dismiss.addEventListener('click', () => {
      hideRoot()
      try {
        localStorage.setItem(HINT_KEY, '1')
      } catch {
        /* ignore */
      }
    })
  }
}
