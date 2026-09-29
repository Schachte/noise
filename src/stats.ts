import type { Live } from './presence'

interface Stats extends Live {
  heartsDaily: number[]
  hourly: number[]
  today: number
  daily: number[]
  week: number
  weekly: number[]
  all: number
  cumulative: number[]
  minutes: { today: number; week: number; all: number; daily: number[] }
}

const BARS = '▁▂▃▄▅▆▇█'

function spark(values: number[]): string {
  const max = Math.max(...values)
  if (max <= 0) return BARS[0].repeat(values.length)
  return values.map((v) => BARS[Math.min(7, Math.round((v / max) * 7))]).join('')
}

const num = (n: number) => n.toLocaleString('en-US')

function duration(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  return h >= 100 ? `${num(h)}h` : `${h}h ${min % 60}m`
}

function row(label: string, value: string, series: number[], range: string): string {
  return `<div class="stats-row">
    <dt>${label}</dt>
    <dd><span class="stats-value">${value}</span><span class="stats-spark" aria-hidden="true" title="${range}">${spark(series)}</span><span class="sr-only">, ${range}</span></dd>
  </div>`
}

/** Footer "stats" button → dialog with micro graphs. Refreshes every 15 s while open. */
export function setupStats(
  dialog: HTMLDialogElement,
  open: HTMLButtonElement,
  close: HTMLButtonElement,
  rows: HTMLElement,
  presence: { onLive(fn: (l: Live) => void): () => void },
): void {
  let data: Stats | null = null
  let timer = 0
  let unsub: (() => void) | null = null

  const render = () => {
    if (!data) return
    const d = data
    rows.innerHTML = [
      row('now', `${num(d.n)} here · ${num(d.listening)} listening`, d.hourly, 'peak per hour, last 24 hours'),
      row('today', `${num(d.today)} visitors`, d.daily, 'visitors per day, last 14 days'),
      row('this week', `${num(d.week)} visitors`, d.weekly, 'visitors per week, last 8 weeks'),
      row('all time', `${num(d.all)} visitors`, d.cumulative, 'total visitors, last 14 days'),
      row(
        'listened',
        `${duration(d.minutes.all)} · ${duration(d.minutes.today)} today`,
        d.minutes.daily,
        'minutes listened per day, last 14 days',
      ),
      row('hearts', num(d.hearts ?? 0), d.heartsDaily, 'hearts per day, last 14 days'),
    ].join('')
  }

  const load = async () => {
    try {
      const res = await fetch('/api/stats', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      data = (await res.json()) as Stats
      render()
    } catch {
      if (!data) rows.innerHTML = '<p class="stats-empty">stats are unavailable right now</p>'
    }
  }

  open.addEventListener('click', () => {
    dialog.showModal()
    void load()
    timer = window.setInterval(load, 15_000)
    // "now" updates instantly from the WebSocket between fetches
    unsub = presence.onLive((l) => {
      if (!data) return
      data = { ...data, n: l.n, listening: l.listening, hearts: l.hearts ?? data.hearts }
      render()
    })
  })
  close.addEventListener('click', () => dialog.close())
  // click on the backdrop closes
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => {
    clearInterval(timer)
    unsub?.()
    unsub = null
    open.focus()
  })
}
