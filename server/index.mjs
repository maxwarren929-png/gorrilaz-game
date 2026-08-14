/**
 * Gorilla FFA — standalone development / LAN WebSocket server.
 *
 * Wraps the shared room engine (game.mjs) with a plain `ws` server. For
 * production on Vercel the same engine is mounted by api/ws.ts.
 *
 * Usage:  node server/index.mjs          (PORT=8787)
 * LAN:    this binds 0.0.0.0 automatically — friends just use your LAN IP.
 */
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { networkInterfaces } from 'os'
import { createEngine } from './game.mjs'
import { makeStore } from './state.mjs'

const PORT = Number(process.env.PORT || 8787)
const store = makeStore()
const engine = createEngine(store, { instanceId: 'local-' + process.pid })

const app = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('gorilla-ffa ws server')
})

const wss = new WebSocketServer({ server: app, maxPayload: 8192 })

wss.on('connection', (ws, req) => {
  // Forward client IP to the engine for logs/future rate-limiting.
  const xff = req.headers['x-forwarded-for']
  const ip = (typeof xff === 'string' ? xff : Array.isArray(xff) ? xff[0] : '')?.split(',')[0]?.trim() || req.socket.remoteAddress || ''
  engine.attach(ws, ip)
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))
})

// Keep connections honest: drop dead sockets so the engine's close handler
// always runs (offline grace / room cleanup depends on it).
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
  console.log(`\nGorilla FFA room server (store: ${store.shared ? 'Upstash (shared)' : 'in-memory'})`)
  console.log(`  local:    ws://localhost:${PORT}`)
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  lan (${name}): ws://${a.address}:${PORT}`)
      }
    }
  }
  console.log()
})
