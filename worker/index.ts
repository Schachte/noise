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
  /** Turnstile widget keys. Without both, hearts are hard-capped per hour instead of challenged. */
  TURNSTILE_SITEKEY?: string
  TURNSTILE_SECRET?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/presence' || pathname === '/api/stats' || pathname === '/api/hearts') {
      if (pathname === '/presence' && request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      // The rate-limit key is a hash of IP + UTC day. It is held in memory only and
      // never written to storage. Client-supplied copies of these headers are overwritten.
      const headers = new Headers(request.headers)
      const ip = request.headers.get('CF-Connecting-IP') ?? '0.0.0.0'
      headers.set('x-client-key', await sha256(`${ip}|${new Date().toISOString().slice(0, 10)}`))
      headers.set('x-client-ip', ip)
      return env.PRESENCE.get(env.PRESENCE.idFromName('global')).fetch(new Request(request, { headers }))
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface Attachment {
  vid: string | null
  playingSince: number | null
}

const DAY = 86_400_000
const HOUR = 3_600_000
const MAX_SESSION = 12 * HOUR // cap a single play stretch (e.g. a tab left open for days)
const KEEP_DAYS = 120

// hearts
const HEART_BATCH_MAX = 50 // most hearts one request may carry
const HEART_FREE = 20 // per client per window before a challenge
const HEART_BONUS = 100 // extra allowance granted per solved challenge
const HEART_WINDOW = HOUR
const HEART_BODY_MAX = 4096

interface Allowance {
  start: number
  used: number
  allowance: number
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export class Presence extends DurableObject<Env> {
  private sql: SqlStorage
  /** per-client heart allowance; memory only, so eviction just resets the window */
  private limits = new Map<string, Allowance>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS visits   (day TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (day, vid));
      CREATE TABLE IF NOT EXISTS visitors (vid TEXT PRIMARY KEY, first_day TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS visitors_first_day ON visitors (first_day);
      CREATE TABLE IF NOT EXISTS peaks    (hour INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS listened (day TEXT PRIMARY KEY, seconds REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS hearts   (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/hearts') return this.hearts(request)
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

  private counts(except?: WebSocket): { n: number; listening: number; hearts: number } {
    const socks = this.open(except)
    const listening = socks.filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.playingSince != null).length
    return { n: socks.length, listening, hearts: this.heartTotal() }
  }

  private heartTotal(): number {
    return this.one('SELECT COALESCE(SUM(n), 0) FROM hearts')
  }

  private challengeEnabled(): boolean {
    return Boolean(this.env.TURNSTILE_SITEKEY && this.env.TURNSTILE_SECRET)
  }

  /** GET: total + challenge config. POST {n, token?}: add up to n hearts within the allowance. */
  private async hearts(request: Request): Promise<Response> {
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

    if (request.method === 'GET') {
      return json({
        total: this.heartTotal(),
        sitekey: this.challengeEnabled() ? this.env.TURNSTILE_SITEKEY : null,
      })
    }
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

    // same-origin only: stops other sites from spending visitors' allowance
    const origin = request.headers.get('Origin')
    if (!origin || origin !== new URL(request.url).origin) return json({ error: 'forbidden' }, 403)

    const text = await request.text()
    if (text.length > HEART_BODY_MAX) return json({ error: 'too large' }, 413)
    let body: { n?: unknown; token?: unknown }
    try {
      body = JSON.parse(text)
    } catch {
      return json({ error: 'bad json' }, 400)
    }
    const n = body.n
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > HEART_BATCH_MAX) {
      return json({ error: `n must be an integer from 1 to ${HEART_BATCH_MAX}` }, 400)
    }

    const key = request.headers.get('x-client-key') ?? 'unknown'
    const now = Date.now()
    this.pruneLimits(now)
    let lim = this.limits.get(key)
    if (!lim || now - lim.start > HEART_WINDOW) {
      lim = { start: now, used: 0, allowance: HEART_FREE }
      this.limits.set(key, lim)
    }

    if (typeof body.token === 'string' && body.token) {
      if (!this.challengeEnabled()) return json({ error: 'challenge not configured' }, 400)
      const ok = await this.verifyTurnstile(body.token, request.headers.get('x-client-ip'))
      if (!ok) return json({ error: 'challenge failed', total: this.heartTotal(), accepted: 0, challenge: true }, 403)
      lim.allowance += HEART_BONUS
    }

    const accepted = Math.max(0, Math.min(n, lim.allowance - lim.used))
    lim.used += accepted
    if (accepted > 0) {
      this.sql.exec(
        'INSERT INTO hearts (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = n + excluded.n',
        dayOf(now),
        accepted,
      )
      this.broadcast()
    }
    const total = this.heartTotal()
    const remaining = lim.allowance - lim.used
    if (accepted < n) {
      return json(
        { total, accepted, remaining: 0, challenge: this.challengeEnabled(), retryAfter: Math.ceil((lim.start + HEART_WINDOW - now) / 1000) },
        429,
      )
    }
    return json({ total, accepted, remaining })
  }

  private pruneLimits(now: number): void {
    if (this.limits.size < 5000) return
    for (const [k, v] of this.limits) if (now - v.start > HEART_WINDOW) this.limits.delete(k)
  }

  private async verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
    if (token.length > 2048) return false
    const form = new FormData()
    form.append('secret', this.env.TURNSTILE_SECRET ?? '')
    form.append('response', token)
    if (ip) form.append('remoteip', ip)
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
      const data = (await res.json()) as { success?: boolean }
      return data.success === true
    } catch {
      return false
    }
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

    const heartRows = new Map(
      this.sql
        .exec('SELECT day, n FROM hearts WHERE day >= ?', d14[0])
        .toArray()
        .map((r) => [String(r.day), Number(r.n)]),
    )

    return {
      ...this.counts(),
      heartsDaily: d14.map((d) => heartRows.get(d) ?? 0),
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
