// Renders scripts/og.html to public/og.png (1200×630 @2x) with headless Chrome.
// Usage: CHROME=/path/to/chrome node scripts/render-og.mjs
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const src = pathToFileURL(fileURLToPath(new URL('og.html', import.meta.url))).href
const out = fileURLToPath(new URL('../public/og.png', import.meta.url))
const PORT = 9338
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/noise-og', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
let t
for (let i = 0; i < 50 && !t; i++) {
  try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page') } catch { await sleep(100) }
}
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d.result); pending.delete(d.id) }
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: src })
await sleep(800)
const { data } = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(data, 'base64'))
console.log('wrote', out)
ws.close()
chrome.kill()
