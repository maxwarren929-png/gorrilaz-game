# Gorilla FFA — multiplayer server

Tiny WebSocket room server. It does **not** run ragdoll physics. Each browser
simulates its own gorilla; this process only keeps rooms, relays poses, and
sanity-checks combat (range + cooldown + grab pairs).

## Local

```bash
cd server
npm install
npm start
```

Default: `ws://localhost:8787`

Open the client (Vite `npm run dev` or the built `dist/index.html` served
over http). In the menu:

- **Practice Solo** — no server
- **Create Room** — get a 4-letter code / shareable `?room=ABCD` link
- **Join** — type the code

Override the server URL with `?ws=ws://localhost:8787` or
`localStorage.gffa-ws = 'wss://your-host'`.

## Deploy (free-ish WebSocket hosts)

Needs a **single instance** (no multi-region fan-out) and raw WebSockets.

- [Fly.io](https://fly.io) — `fly launch` in this folder, expose port 8787
- [Railway](https://railway.app) — new service from this folder, set `PORT`
- [Render](https://render.com) Web Service — start command `node index.mjs`

Then open the client with `?ws=wss://your-app.fly.dev`.

## Why this model

| Piece | Where it lives | Why |
| --- | --- | --- |
| Walk / climb / jump | Local client | Needs 60 Hz physics or it feels like sludge |
| Other players | Interpolated snapshots @ 20 Hz | 8 ragdolls × 5 bodies is too much to lockstep |
| Punch / grab / slam / throw | Server validates, victim applies | Stops one client inventing hits; still ~100 ms feel |

Anti-cheat is “friend-group honest”: range + cooldown only. No accounts.
