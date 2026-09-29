/**
 * Live "N here" count in the footer, fed by the /presence WebSocket
 * (worker/index.ts). Hidden until the first message, so it stays invisible in
 * `vite dev` and offline. Reconnects with backoff; disconnects while the page is
 * hidden so background tabs don't count as viewers (unless audio is playing).
 *
 * Also reports play/stop so the server can time minutes listened, and sends a
 * random visitor ID (made up here, kept in localStorage) for unique counts.
 */
export interface Live {
  n: number
  listening: number
}

const VID_KEY = 'noise:vid'

function visitorId(): string {
  try {
    let id = localStorage.getItem(VID_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(VID_KEY, id)
    }
    return id
  } catch {
    return crypto.randomUUID() // private mode: counted once per page load
  }
}

export function setupPresence(el: HTMLElement, count: HTMLElement, label: HTMLElement) {
  const listeners = new Set<(live: Live) => void>()
  let live: Live | null = null
  let playing = false
  let ws: WebSocket | null = null
  let retry = 0
  let timer = 0

  const send = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: playing ? 'play' : 'stop' }))
  }

  const connect = () => {
    if (!('WebSocket' in window) || ws || (document.hidden && !playing)) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/presence?v=${encodeURIComponent(visitorId())}`)
    ws.onopen = () => {
      if (playing) send()
    }
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as Live
        if (typeof data.n !== 'number') return
        retry = 0
        live = data
        count.textContent = String(data.n)
        label.textContent = data.n === 1 ? 'listener' : 'listeners'
        el.hidden = false
        listeners.forEach((fn) => fn(data))
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      ws = null
      if (document.hidden && !playing) return
      clearTimeout(timer)
      timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++)) // 1s … 30s
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !playing) {
      clearTimeout(timer)
      ws?.close()
    } else {
      connect()
    }
  })
  connect()

  return {
    /** Tell the server audio started/stopped (it does the timing). */
    setPlaying(on: boolean) {
      if (on === playing) return
      playing = on
      send()
      if (on) connect()
    },
    onLive(fn: (live: Live) => void) {
      listeners.add(fn)
      if (live) fn(live)
      return () => listeners.delete(fn)
    },
  }
}
