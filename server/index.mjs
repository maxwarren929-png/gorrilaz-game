/**
 * Jungle Brawl — standalone production + dev WebSocket server.
 *
 * In production (Fly.io / Docker): serves the built client from dist/ and
 * accepts WebSocket upgrades on the same port. One container, one process.
 *
 * In local dev: run `npm run dev` for the Vite client on :5173 and this
 * server on :8787 — or just `node server/index.mjs` after `npm run build`
 * to serve everything from one port.
 *
 * Usage:  node server/index.mjs          (PORT=8787)
 *         PORT=8080 node server/index.mjs
 */
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { networkInterfaces } from 'os'
import { createEngine } from './game.mjs'
import { makeStore } from './state.mjs'

const PORT = Number(process.env.PORT || 8787)
const DIST = join(process.cwd(), 'dist')
const HAS_DIST = existsSync(DIST)

const store = makeStore()
const engine = createEngine(store, { instanceId: 'server-' + process.pid })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const app = createServer((req, res) => {
  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, shared: store.shared }))
    return
  }

  // Serve static client if dist/ exists (production)
  if (HAS_DIST) {
    let url = req.url?.split('?')[0] || '/'
    let filepath = join(DIST, url)
    // SPA fallback: non-file requests serve index.html
    if (!existsSync(filepath) || extname(filepath) === '') {
      filepath = join(DIST, 'index.html')
    }
    try {
      const body = readFileSync(filepath)
      res.writeHead(200, { 'content-type': MIME[extname(filepath)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
    return
  }

  // No dist/ — plain dev server
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('Jungle Brawl WebSocket server. Build the client with: npm run build')
})

const wss = new WebSocketServer({ server: app, maxPayload: 8192 })

wss.on('connection', (ws, req) => {
  const xff = req.headers['x-forwarded-for']
  const ip = (typeof xff === 'string' ? xff : Array.isArray(xff) ? xff[0] : '')?.split(',')[0]?.trim() || req.socket.remoteAddress || ''
  engine.attach(ws, ip)
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))
})

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 15_000)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nJungle Brawl server (store: ${store.shared ? 'Upstash (shared)' : 'in-memory'})`)
  if (HAS_DIST) {
    console.log(`  app:      http://0.0.0.0:${PORT}`)
  }
  console.log(`  websocket: ws://0.0.0.0:${PORT}`)
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  lan (${name}): http://${a.address}:${PORT}`)
      }
    }
  }
  console.log()
})
