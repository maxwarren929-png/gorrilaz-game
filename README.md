# Gorilla FFA

Low-poly ragdoll gorilla arena brawler. Three.js + cannon-es client, small
WebSocket room server, up to 8 players per room with health, fall damage,
rounds, and a comeback-upgrade system.

## Run modes

### Practice (offline)

```bash
npm install
npm run dev          # open the printed URL -> "Practice Solo"
```

### Local multiplayer (same machine)

```bash
npm run dev                  # terminal 1, client on :5173
node server/index.mjs        # terminal 2, room server on :8787
```

Open the game, pick **Create Room**, share the 4-letter code.

### LAN multiplayer

```bash
npm run dev -- --host        # or: npx vite --host
node server/index.mjs
```

Everyone opens `http://<your-LAN-IP>:5173`. The client automatically uses
`ws://<your-LAN-IP>:8787` — the server binds `0.0.0.0` and prints its LAN
socket URLs on startup. To override: add `?ws=ws://<ip>:8787` to the page URL.

### Vercel deployment

```bash
vercel            # requires the @vercel/cli and a linked project
```

The client is served from `dist/` (see `vercel.json`), the multiplayer server
runs as a WebSocket Function at `/api/ws` (Node runtime, Fluid compute). The
client connects to `wss://<your-domain>/api/ws` automatically — no extra config.

## Environment variables

| Variable | Where | Required | Purpose |
| --- | --- | --- | --- |
| `PORT` | local server | no (default 8787) | dev/LAN socket port |
| `UPSTASH_REDIS_REST_URL` | Vercel project env | only for multi-instance rooms | shared room state + event outbox |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel project env | only for multi-instance rooms | shared room state + event outbox |

Without Upstash env vars, the Vercel function uses in-memory state, which is
fine when every player lands on the same warm instance (typical for a
simultaneous 8-friend session on Fluid compute). Add the two env vars to
authoritatively share rooms across instances.

## Networking model

- Your own gorilla is simulated locally at 60 Hz (never round-tripped).
- Other players are interpolated 20 Hz pose snapshots.
- Combat intents (punch / grab / slam / throw / banana / laser) are validated
  on the server: range, cooldowns, one-hit-per-banana-spawn.
- Health, KOs, upgrades, rounds, and room lifecycle are server-authoritative.
- Dropped sockets auto-reconnect with backoff and reclaim the same player id
  within a 25 s grace window.
