/**
 * Serves the static app, a realtime "N here" counter and anonymous usage stats.
 *
 * Static files are served by Workers Static Assets before this script runs; the
 * script only handles:
 *   /presence   WebSocket into one global Durable Object (Hibernation API)
 *   /api/stats  JSON counts for the footer stats panel
 *
 * Privacy: the only identifier is a random ID the browser makes up and keeps in
 * localStorage. No cookies, IPs or user agents are stored. Listening time is
 * measured on the server between "play" and "stop" messages, so a client can't
 * report more time than actually passed.
 */
import { DurableObject } from 'cloudflare:workers'

interface Env {
  ASSETS: Fetcher
  PRESENCE: DurableObjectNamespace<Presence>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/presence' || pathname === '/api/stats') {
      if (pathname === '/presence' && request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      return env.PRESENCE.get(env.PRESENCE.idFromName('global')).fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

interface Attachment {
  vid: string | null
  playingSince: number | null
}

const DAY = 86_400_000
const HOUR = 3_600_000
const MAX_SESSION = 12 * HOUR // cap a single play stretch (e.g. a tab left open for days)
const KEEP_DAYS = 120

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export class Presence extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS visits   (day TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (day, vid));
      CREATE TABLE IF NOT EXISTS visitors (vid TEXT PRIMARY KEY, first_day TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS visitors_first_day ON visitors (first_day);
      CREATE TABLE IF NOT EXISTS peaks    (hour INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS listened (day TEXT PRIMARY KEY, seconds REAL NOT NULL);
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/stats') {
      return Response.json(this.stats(), {
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      })
    }

    const vid = url.searchParams.get('v')
    const valid = vid && /^[a-z0-9-]{8,64}$/i.test(vid) ? vid : null
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ vid: valid, playingSince: null } satisfies Attachment)
    if (valid) this.recordVisit(valid)
    this.broadcast()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { vid: null, playingSince: null }
    let t = ''
    try {
      t = (JSON.parse(typeof message === 'string' ? message : '') as { t?: string }).t ?? ''
    } catch {
      /* treat as ping */
    }
    const now = Date.now()
    if (t === 'play' && att.playingSince === null) {
      att.playingSince = now
      ws.serializeAttachment(att)
      this.broadcast()
    } else if (t === 'stop' && att.playingSince !== null) {
      this.credit(now - att.playingSince, now)
      att.playingSince = null
      ws.serializeAttachment(att)
      this.broadcast()
    } else {
      ws.send(this.payload())
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.finish(ws)
    try {
      ws.close(code === 1005 ? 1000 : code)
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.finish(ws)
  }

  // ---- internals ----

  private finish(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null
    if (att?.playingSince != null) {
      this.credit(Date.now() - att.playingSince, Date.now())
      ws.serializeAttachment({ ...att, playingSince: null })
    }
    this.broadcast(ws)
  }

  private open(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
  }

  private counts(except?: WebSocket): { n: number; listening: number } {
    const socks = this.open(except)
    const listening = socks.filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.playingSince != null).length
    return { n: socks.length, listening }
  }

  private payload(except?: WebSocket): string {
    return JSON.stringify(this.counts(except))
  }

  private broadcast(except?: WebSocket): void {
    const c = this.counts(except)
    // hourly peak of concurrent viewers, for the "now" sparkline
    this.sql.exec(
      'INSERT INTO peaks (hour, n) VALUES (?, ?) ON CONFLICT(hour) DO UPDATE SET n = max(n, excluded.n)',
      Math.floor(Date.now() / HOUR),
      c.n,
    )
    const msg = JSON.stringify(c)
    for (const ws of this.open(except)) {
      try {
        ws.send(msg)
      } catch {
        /* dropped mid-send */
      }
    }
  }

  private recordVisit(vid: string): void {
    const today = dayOf(Date.now())
    this.sql.exec('INSERT OR IGNORE INTO visits (day, vid) VALUES (?, ?)', today, vid)
    this.sql.exec('INSERT OR IGNORE INTO visitors (vid, first_day) VALUES (?, ?)', vid, today)
    // retention: keep per-day detail bounded (all-time totals live in `visitors`)
    const cutoff = dayOf(Date.now() - KEEP_DAYS * DAY)
    this.sql.exec('DELETE FROM visits WHERE day < ?', cutoff)
    this.sql.exec('DELETE FROM peaks WHERE hour < ?', Math.floor((Date.now() - 7 * DAY) / HOUR))
  }

  private credit(ms: number, now: number): void {
    const seconds = Math.max(0, Math.min(ms, MAX_SESSION)) / 1000
    if (seconds < 1) return
    this.sql.exec(
      'INSERT INTO listened (day, seconds) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET seconds = seconds + excluded.seconds',
      dayOf(now),
      seconds,
    )
  }

  private one(query: string, ...args: (string | number)[]): number {
    const row = this.sql.exec(query, ...args).toArray()[0] as Record<string, number> | undefined
    return Number(row ? Object.values(row)[0] : 0) || 0
  }

  private stats() {
    const now = Date.now()
    const days = (n: number) => Array.from({ length: n }, (_, i) => dayOf(now - (n - 1 - i) * DAY))

    // last 24 hours: hourly peak viewers
    const hourNow = Math.floor(now / HOUR)
    const peakRows = new Map(
      this.sql
        .exec('SELECT hour, n FROM peaks WHERE hour > ?', hourNow - 24)
        .toArray()
        .map((r) => [Number(r.hour), Number(r.n)]),
    )
    const hourly = Array.from({ length: 24 }, (_, i) => peakRows.get(hourNow - 23 + i) ?? 0)

    // last 14 days: unique visitors per day
    const d14 = days(14)
    const dailyRows = new Map(
      this.sql
        .exec('SELECT day, COUNT(*) AS c FROM visits WHERE day >= ? GROUP BY day', d14[0])
        .toArray()
        .map((r) => [String(r.day), Number(r.c)]),
    )
    const daily = d14.map((d) => dailyRows.get(d) ?? 0)

    // last 8 weeks (rolling 7-day windows): unique visitors per week
    const weekly = Array.from({ length: 8 }, (_, i) => {
      const end = now - (7 - i) * 7 * DAY
      return this.one(
        'SELECT COUNT(DISTINCT vid) FROM visits WHERE day > ? AND day <= ?',
        dayOf(end - 7 * DAY),
        dayOf(end),
      )
    })

    // all time: total visitors, and the running total over the last 14 days
    const all = this.one('SELECT COUNT(*) FROM visitors')
    const before = this.one('SELECT COUNT(*) FROM visitors WHERE first_day < ?', d14[0])
    const newRows = new Map(
      this.sql
        .exec('SELECT first_day, COUNT(*) AS c FROM visitors WHERE first_day >= ? GROUP BY first_day', d14[0])
        .toArray()
        .map((r) => [String(r.first_day), Number(r.c)]),
    )
    let running = before
    const cumulative = d14.map((d) => (running += newRows.get(d) ?? 0))

    // listening time, including sessions still playing right now
    const liveSeconds = this.open().reduce((sum, ws) => {
      const since = (ws.deserializeAttachment() as Attachment | null)?.playingSince
      return since != null ? sum + Math.min(now - since, MAX_SESSION) / 1000 : sum
    }, 0)
    const listenRows = new Map(
      this.sql
        .exec('SELECT day, seconds FROM listened WHERE day >= ?', d14[0])
        .toArray()
        .map((r) => [String(r.day), Number(r.seconds)]),
    )
    const listenDaily = d14.map((d, i) => (listenRows.get(d) ?? 0) + (i === 13 ? liveSeconds : 0))
    const listenWeek =
      this.one('SELECT COALESCE(SUM(seconds), 0) FROM listened WHERE day > ?', dayOf(now - 7 * DAY)) + liveSeconds
    const listenAll = this.one('SELECT COALESCE(SUM(seconds), 0) FROM listened') + liveSeconds

    return {
      ...this.counts(),
      hourly,
      today: daily[13],
      daily,
      week: weekly[7],
      weekly,
      all,
      cumulative,
      minutes: {
        today: Math.round(listenDaily[13] / 60),
        week: Math.round(listenWeek / 60),
        all: Math.round(listenAll / 60),
        seconds: Math.round(listenAll),
        daily: listenDaily.map((s) => Math.round(s / 60)),
      },
    }
  }
}
