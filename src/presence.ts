/**
 * Live "N here" count in the footer, fed by the /presence WebSocket
 * (worker/index.ts). Hidden until the first message, so it stays invisible in
 * `vite dev` and offline. Reconnects with backoff; disconnects while the page is
 * hidden so background tabs don't count as viewers.
 */
export function setupPresence(el: HTMLElement, count: HTMLElement): void {
  if (!('WebSocket' in window)) return
  let ws: WebSocket | null = null
  let retry = 0
  let timer = 0

  const connect = () => {
    if (ws || document.hidden) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/presence`)
    ws.onmessage = (e) => {
      try {
        const { n } = JSON.parse(e.data) as { n: number }
        if (typeof n !== 'number') return
        retry = 0
        count.textContent = String(n)
        el.hidden = false
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      ws = null
      if (document.hidden) return
      clearTimeout(timer)
      // 1s, 2s, 4s … capped at 30s
      timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++))
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer)
      ws?.close()
    } else {
      connect()
    }
  })
  connect()
}
