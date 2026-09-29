/**
 * Footer heart. Clicks show up instantly and are sent in batches:
 * one request after 1.2 s of quiet, or every 5 s at most while clicking.
 * The server enforces the limit (20 per hour per client, then Turnstile).
 * The client only reacts to what the server says.
 */
const DEBOUNCE = 1200
const MAX_WAIT = 5000
const BATCH_MAX = 50 // must match the worker
const HEARTED_KEY = 'noise:hearted'
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface Turnstile {
  render(el: HTMLElement, opts: Record<string, unknown>): string
  remove(id: string): void
}
declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

interface HeartResponse {
  total?: number
  accepted?: number
  challenge?: boolean
  retryAfter?: number
}

let turnstileLoad: Promise<Turnstile> | null = null
function loadTurnstile(): Promise<Turnstile> {
  turnstileLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SRC
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')))
    script.onerror = () => {
      turnstileLoad = null
      reject(new Error('turnstile'))
    }
    document.head.appendChild(script)
  })
  return turnstileLoad
}

export function setupHeart(opts: {
  button: HTMLButtonElement
  count: HTMLElement
  dialog: HTMLDialogElement
  widget: HTMLElement
  close: HTMLButtonElement
  message: HTMLElement
  announce: (msg: string) => void
}) {
  const { button, count, dialog, widget, close, message, announce } = opts
  let base: number | null = null // last total the server reported
  let pending = 0 // clicked, not yet sent
  let sending = 0 // in flight
  let sitekey: string | null = null
  let needChallenge = false
  let blockedUntil = 0 // hard limit (no Turnstile configured)
  let debounce = 0
  let maxWait = 0
  let widgetId: string | null = null

  try {
    if (localStorage.getItem(HEARTED_KEY) === '1') button.classList.add('hearted')
  } catch {
    /* ignore */
  }

  const render = () => {
    if (base === null) {
      count.hidden = pending + sending === 0
      count.textContent = String(pending + sending)
    } else {
      count.hidden = false
      count.textContent = (base + pending + sending).toLocaleString('en-US')
    }
    button.setAttribute('aria-label', `Send a heart${count.hidden ? '' : `, ${count.textContent} so far`}`)
  }

  const clearTimers = () => {
    clearTimeout(debounce)
    clearTimeout(maxWait)
    maxWait = 0
  }

  const schedule = () => {
    clearTimeout(debounce)
    debounce = window.setTimeout(() => void flush(), DEBOUNCE)
    if (!maxWait) maxWait = window.setTimeout(() => void flush(), MAX_WAIT)
  }

  async function flush(token?: string): Promise<void> {
    clearTimers()
    if (sending || pending === 0) return
    if (needChallenge && !token) return
    const n = Math.min(pending, BATCH_MAX)
    pending -= n
    sending = n
    let res: Response
    let data: HeartResponse = {}
    try {
      res = await fetch('/api/hearts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token ? { n, token } : { n }),
      })
      data = (await res.json().catch(() => ({}))) as HeartResponse
    } catch {
      // offline or no server (vite dev): keep them and try again later
      sending = 0
      pending += n
      debounce = window.setTimeout(() => void flush(), 10_000)
      render()
      return
    }
    sending = 0
    if (typeof data.total === 'number') base = data.total
    const accepted = data.accepted ?? 0
    if (res.ok) {
      if (pending) schedule()
    } else if (res.status === 429 || res.status === 403) {
      const rejected = n - accepted
      if (data.challenge && sitekey) {
        pending += rejected
        needChallenge = true
        openChallenge()
      } else {
        // no challenge available: drop the extras and cool down
        pending = 0
        blockedUntil = Date.now() + (data.retryAfter ?? 60) * 1000
        announce('That’s a lot of love. Try again later.')
        button.classList.add('capped')
      }
    } else {
      pending = 0 // bad request: nothing to retry
    }
    render()
  }

  function openChallenge() {
    if (dialog.open || !sitekey) return
    message.textContent = 'That’s a lot of love. Quick check before sending more:'
    dialog.showModal()
    loadTurnstile()
      .then((ts) => {
        if (widgetId) ts.remove(widgetId)
        widgetId = ts.render(widget, {
          sitekey,
          theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
          callback: (token: string) => {
            needChallenge = false
            dialog.close()
            void flush(token)
          },
          'error-callback': () => {
            message.textContent = 'The check didn’t load. Close this and try again later.'
          },
        })
      })
      .catch(() => {
        message.textContent = 'The check didn’t load. Close this and try again later.'
      })
  }

  button.addEventListener('click', () => {
    button.classList.remove('pop')
    void button.offsetWidth
    button.classList.add('pop')
    if (Date.now() < blockedUntil) return
    button.classList.remove('capped')
    try {
      localStorage.setItem(HEARTED_KEY, '1')
    } catch {
      /* ignore */
    }
    button.classList.add('hearted')
    if (pending < BATCH_MAX * 2) pending++ // bound the local queue too
    render()
    if (needChallenge) openChallenge()
    else schedule()
  })

  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => {
    if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    widgetId = null
    button.focus()
  })

  // last-chance send when the page goes away (skipped if a challenge is pending)
  const beacon = () => {
    if (!pending || needChallenge || !navigator.sendBeacon) return
    const n = Math.min(pending, BATCH_MAX)
    if (navigator.sendBeacon('/api/hearts', new Blob([JSON.stringify({ n })], { type: 'application/json' }))) {
      pending -= n
    }
  }
  addEventListener('pagehide', beacon)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) beacon()
  })

  fetch('/api/hearts', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d: { total: number; sitekey: string | null }) => {
      base = d.total
      sitekey = d.sitekey
      render()
    })
    .catch(() => render())

  return {
    /** live total pushed over the presence socket */
    setTotal(total: number) {
      if (sending) return // our own batch is in flight; its response will settle it
      base = total
      render()
    },
  }
}
