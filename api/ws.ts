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
import { WebSocketServer } from 'ws'
import { randomUUID } from 'crypto'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS shared modules (kept dependency-free for local dev)
import { createEngine } from '../server/game.mjs'
// @ts-ignore
import { makeStore } from '../server/state.mjs'

const app = express()
app.get('/api/ws', (_req, res) => {
  res.json({ ok: true, service: 'gorilla-ffa', shared: store.shared })
})

const server = createServer(app)
const wss = new WebSocketServer({ server })

const store = makeStore()
const engine = createEngine(store, {
  instanceId: process.env.VERCEL_REGION ? `${process.env.VERCEL_REGION}-${randomUUID()}` : 'vercel-' + randomUUID(),
})

wss.on('connection', (ws) => {
  engine.attach(ws)
  // Ping so idle sockets stay gently alive through the platform proxy.
  ;(ws as any).isAlive = true
  ws.on('pong', () => ((ws as any).isAlive = true))
})

export default server
