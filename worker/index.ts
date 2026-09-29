/**
 * Serves the static app and a realtime "people here now" counter.
 *
 * Static files are served by Workers Static Assets before this script runs, so
 * the script only handles /presence: a WebSocket that joins one global Durable
 * Object. The DO uses the WebSocket Hibernation API, so idle connections cost
 * nothing, and it stores no user data: the count is just the number of open
 * sockets.
 */
import { DurableObject } from 'cloudflare:workers'

interface Env {
  ASSETS: Fetcher
  PRESENCE: DurableObjectNamespace<Presence>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/presence') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 })
      }
      const stub = env.PRESENCE.get(env.PRESENCE.idFromName('global'))
      return stub.fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

export class Presence extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    this.broadcast()
    return new Response(null, { status: 101, webSocket: client })
  }

  // Clients send nothing meaningful; any message is treated as a ping.
  async webSocketMessage(ws: WebSocket): Promise<void> {
    ws.send(this.payload())
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code)
    } catch {
      /* already closed */
    }
    this.broadcast(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast(ws)
  }

  private open(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
  }

  private payload(except?: WebSocket): string {
    return JSON.stringify({ n: this.open(except).length })
  }

  private broadcast(except?: WebSocket): void {
    const msg = this.payload(except)
    for (const ws of this.open(except)) {
      try {
        ws.send(msg)
      } catch {
        /* dropped mid-send */
      }
    }
  }
}
