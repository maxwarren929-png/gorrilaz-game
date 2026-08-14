// Vercel deployment of the Gorilla FFA room server.
//
// Vercel Functions on Fluid compute can serve WebSockets with stock Node
// libraries — this file follows the official pattern: create an HTTP server,
// attach `ws`, and export the server as the default handler. No extra config.
//
// Cross-instance room state uses Upstash when UPSTASH_REDIS_REST_URL +
// UPSTASH_REDIS_REST_TOKEN are present; otherwise it falls back to in-memory
// (fine when all players share a warm instance, which Fluid tends to do for
// a simultaneous 8-person session).

import express from 'express'
import { createServer } from 'http'
import type { IncomingMessage } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { randomUUID } from 'crypto'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS shared modules (kept dependency-free for local dev)
import { createEngine } from '../server/game.mjs'
// @ts-ignore
import { makeStore } from '../server/state.mjs'

const app = express()
const store = makeStore()
const engine = createEngine(store, {
  instanceId: process.env.VERCEL_REGION ? `${process.env.VERCEL_REGION}-${randomUUID()}` : 'vercel-' + randomUUID(),
})

app.get('/api/ws', (_req, res) => {
  res.json({ ok: true, service: 'gorilla-ffa', shared: store.shared })
})

const server = createServer(app)
// Cap frame size to match the validator's MSG_MAX_BYTES so a single malicious
// peer can't buffer/OOM the function before sanitization runs.
const wss = new WebSocketServer({ server, maxPayload: 8192 })

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  // Forward the client IP (behind Vercel's proxy) to the engine for rate-
  // limiting / abuse logs. x-forwarded-for is "client, proxy1, proxy2…".
  const xff = req.headers['x-forwarded-for']
  const ip = (typeof xff === 'string' ? xff : Array.isArray(xff) ? xff[0] : '')?.split(',')[0]?.trim()
  // Basic origin hardening: same-origin (production) and private/local
  // networks (LAN dev) are always allowed; everything else is rejected so a
  // random public page can't open sockets into a running room.
  const origin = req.headers.origin
  if (origin) {
    let ok = false
    try {
      const u = new URL(origin)
      const host = u.hostname
      ok =
        u.protocol + '//' + u.host === origin || // self-canonical
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host.endsWith('.localhost') ||
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc00:|fe80:)/.test(host) // private/link-local
    } catch {
      ok = false
    }
    if (!ok) {
      ws.close(1008, 'origin not allowed')
      return
    }
  }
  engine.attach(ws, ip)
  // Keepalive: dead peers won't emit 'close', so we ping every 15s and
  // terminate any socket that didn't pong since the last tick. This also
  // nudges idle sockets through platform proxy timeouts.
  ;(ws as any).isAlive = true
  ws.on('pong', () => ((ws as any).isAlive = true))
})

setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as any).isAlive === false) {
      ws.terminate()
      continue
    }
    ;(ws as any).isAlive = false
    try {
      ws.ping()
    } catch {
      /* socket already gone */
    }
  }
}, 15_000)

export default server
