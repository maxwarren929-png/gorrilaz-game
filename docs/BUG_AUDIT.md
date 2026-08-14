# Gorilla FFA Bug Audit

## Scope

Full audit of the Phase 5 prototype, covering: client gameplay (`Game.ts`,
`Gorilla.ts`, `Arena.ts`, `Effects.ts`, `Projectiles.ts`, `Input.ts`,
`CameraRig.ts`, `App.tsx`, `constants.ts`), networking (`NetClient.ts`,
`RemoteAvatar.ts`, `protocol.ts`), authoritative server (`server/*.mjs`,
`api/ws.ts`), and build/deploy config (`vite.config.ts`, `tsconfig.json`,
`vercel.json`).

`npx tsc --noEmit` was run; the type errors it surfaces are listed below as
their own findings (#2, #5, #7, #17). All other findings were verified by
reading the code and confirming the offending lines.

Findings are deduplicated across modules (some root causes surface in both
client and server audits — those are reported once with all affected
locations).

---

## Critical

### 1. `Game` has no `dispose()`; RAF + listeners + WebGL + Cannon world leak on every session

- **Files:** `src/game/Game.ts` (method missing); `src/App.tsx:52,79,100,119`
- **Bug:** `App.tsx` calls `gameRef.current?.dispose()` on unmount and on every
  mode switch. `Game` never defines `dispose()`. `tsc` errors on every call
  site. The `private raf = 0` field at `Game.ts:79` is set by
  `requestAnimationFrame(this.loop)` (line 1125) but never cancelled.
- **Impact:** Every "Practice Solo" / "Create Room" / "Join Room" / "Leave"
  stacks a new 60 Hz RAF loop, another `Input` listener set (8 window
  listeners), another WebGLRenderer context (browsers cap ~16), and another
  Cannon world. After 3–4 sessions the page runs 3–4 physics worlds and
  renderers simultaneously. Also: `net` callbacks (`onWelcome`, `onPunched`, …)
  stay bound to the dead `Game` and mutate a scene still being rendered by a
  newer one.
- **Fix:** Implement `dispose()` that sets `this.running = false`,
  `cancelAnimationFrame(this.raf)`, removes the resize listener, calls
  `this.input.dispose()`, `this.renderer.dispose()`, `this.effects.dispose()`,
  `this.projectiles.dispose()`, disposes each `Gorilla`/`RemoteAvatar`, removes
  bodies/constraints from the world, and nulls all `this.net.*` callbacks.

### 2. `this.onResize` referenced but never defined (build-breaking)

- **File:** `src/game/Game.ts:189`
- **Bug:** Constructor registers `window.addEventListener('resize', this.onResize)`
  but `onResize` is never declared on `Game`. `tsc`: `TS2339: Property
  'onResize' does not exist on type 'Game'`.
- **Impact:** `vite build` with strict TS fails. If it slips through (esbuild
  strips types), `addEventListener('resize', undefined)` registers nothing —
  the canvas/viewport never resizes, and the `opacity-0 → visible` container
  transition in `App.tsx:154` leaves the renderer at 0×0 or stale size.
- **Fix:** Define `private onResize = () => { const w = this.container.clientWidth, h = this.container.clientHeight; this.renderer.setSize(w, h); this.cameraRig.resize(w / h) }`.

### 3. Auto-reconnect is permanently dead (`manuallyClosed` never reset)

- **File:** `src/net/NetClient.ts:43,47,109,298`
- **Bug:** `connect()` starts with `this.disconnect(true)`, which sets
  `this.manuallyClosed = true`. It is never set back to `false` anywhere
  (grep confirms only 3 references: declare, guard, assign). Every subsequent
  close hits the guard in `scheduleReconnect` (`if (this.manuallyClosed ||
  !this.session) return`).
- **Impact:** The entire backoff / rejoin / session-resume subsystem never
  runs. Any dropped socket (wifi blip, server restart, laptop sleep) strands
  the player with a dead `ws` until they manually re-create the room. The
  README's "Dropped sockets auto-reconnect with backoff and reclaim the same
  player id within a 25 s grace window" claim is false today.
- **Fix:** Reset `this.manuallyClosed = false` at the start of `connect()`
  (after the disconnect), or in `acceptWelcome` once a fresh session is
  established.

### 4. Remote pose timestamps use the sender's local boot clock, not a synced clock

- **Files:** `src/game/Game.ts:105,1334,1380` (sender) →
  `src/game/Game.ts:1363` → `src/net/RemoteAvatar.ts:192` (receiver);
  `src/net/NetClient.ts:252` (`clockSkew` computed but never consumed)
- **Bug:** `netClock` is a local accumulator (`this.netClock += dt`, starts at 0
  at each client's boot). Poses are stamped `t = sender.netClock`. The receiver
  interpolates with `renderT = receiver.netClock - 90ms`. These are two
  independent clock domains differing by `(receiverBootWall − senderBootWall)`,
  which is arbitrary (seconds to hours). The computed `clockSkew` (Date.now-based,
  from `phase` messages) is never applied to `netClock`.
- **Impact:** The 90 ms interpolation window is meaningless across clock
  domains. If the receiver booted later, `renderT` is far below every snap's
  `t` → `u` clamps to 0 → avatar renders stale. If earlier, `renderT` is far
  above every snap's `t` → `u` clamps to 1 → avatar snaps to the newest pose
  with **no interpolation and no delay buffer** (20 Hz stutter, 0 ms
  smoothing). The headline "remotes interpolated 90 ms behind" feature does
  not work for any peer that didn't boot at the exact same instant.
- **Fix:** Stamp poses with a server-aligned clock (`Date.now() + net.clockSkew`)
  on both send and sample paths, or have the relay re-stamp `msg.t = Date.now()`
  in `server/game.mjs:479-483` (the server already mutates `msg.id` there).

### 5. `FLAG.flying` does not exist; pose flags become `NaN`/`0` on the wire

- **Files:** `src/net/protocol.ts:30-36` (missing); `src/game/Game.ts:1379`
  (consumer); `server/message.mjs` `sanPose` (passes through opaquely)
- **Bug:** `FLAG` declares `climbing|punching|grabbed|respawning|ko` only.
  `Game.ts:1379` reads `FLAG.flying`, which is `undefined`. `tsc`:
  `TS2339: Property 'flying' does not exist`. `x | undefined` coerces via
  `ToInt32(undefined)=0`, so the flying bit is silently always 0.
- **Impact:** Flying gorillas never advertise flight to remotes. A flying
  opponent renders as a walking/standing pose interpolated through the air.
  Any remote-side VFX keyed on a flying bit (jetpack flame, glide pose) can
  never trigger.
- **Fix:** Add `flying: 32` to `FLAG` in `protocol.ts:30-36` and reserve the
  bit in `server/message.mjs` `sanPose` (which already clamps `s` to `0..255`).

### 6. `Arena.buildArena` returns before spawning any jungle content

- **File:** `src/game/Arena.ts:571`
- **Bug:** `return { damageTreeAt, regrowTrees }` sits at line 571, but every
  `addTree(...)` (590–613), `addVine(...)` (616–625), `addBush(...)` (628–643),
  and the floating-island loop (649–675) is **after** the return → 100%
  unreachable dead code.
- **Impact:** The arena has *zero* trees, vines, bushes, or floating islands.
  No tree CANNON colliders, no tree `pushPole` climb-zones, the module-level
  `trees[]` array is permanently empty, and the returned `damageTreeAt` /
  `regrowTrees` are no-ops — the banana-gun tree-topple feature can never
  trigger. The "jungle" is a bare floor + 7 platforms + ruins.
- **Fix:** Move the `return { damageTreeAt, regrowTrees }` to the end of
  `buildArena` (after the floating-island loop, line 675).

### 7. Phase-5 cooldowns/timers decremented twice per frame → 2× fire rate

- **File:** `src/game/Game.ts:1227-1231` and `1387-1391` (duplicate block)
- **Bug:** The exact same five-line block ticking `bananaCd`, `laserCd`,
  `domainCd`, `domainTimer`, and recomputing `domainActive` appears twice in
  `loop()`. Everything runs at 2× intended rate.
- **Impact (against `constants.ts`):**
  - `laserCd = 1/LASER.tickRate` (1/12 s) halves to ~24 Hz fire rate; LASER
    damage/knockback were tuned at 12 Hz, so DPS roughly doubles.
  - `bananaCd = BANANA.cooldown/actionMul` (0.7 s) becomes ~0.35 s.
  - `domainCd = DOMAIN.cooldown` (18 s) becomes 9 s, and `domainTimer =
    DOMAIN.duration` (15 s) becomes 7.5 s — the dome disappears in half the
    advertised time and the buff window is also halved.
- **Fix:** Delete the second block (lines 1387–1391); keep only the earlier
  one.

### 8. Rejoin via `hydrateRoom` bricks the player (`.room` is `undefined`)

- **File:** `server/game.mjs:436`
- **Bug:** `hydrateRoom` builds player objects without a `room` field. The
  rejoin branch then does `player.room = prev.room` — but `prev.room` is
  `undefined` (prev was itself hydrated). The correct line is `player.room = r`
  (which is what the `create`/`join` branches do at `game.mjs:457`).
- **Impact:** On any shared-store deployment (Vercel/Fluid multi-instance),
  when a player's previous instance is gone and `rooms.get()` misses so
  `hydrateRoom` runs, the rejoined client:
  - has `player.room === undefined`, so every subsequent message hits
    `if (!room) return` (`game.mjs:475`) — player is soft-locked, can't act.
  - on disconnect, `markGone` early-returns at `game.mjs:306`
    (`if (!room) return`), so no offline timer is scheduled and `online` stays
    `true` — the player becomes a permanent ghost in `room.players`, counted
    in `onlineCount`, targetable by combat, blocking round-over detection
    forever.

  This is the bug that manifests as "my friend reconnected and now the room is
  stuck / shows 8 players forever." It does not trigger on the local in-memory
  store because `hydrateRoom` returns `null` and the live room is used.
- **Fix:** Replace `player.room = prev.room` with `player.room = r`.
  Independently, give `hydrateRoom`'s player objects a `room` field set to the
  freshly built room.

### 9. ID spoofing on rejoin (no session secret)

- **File:** `server/game.mjs:412-417`
- **Bug:** Rejoin trusts the client-supplied `msg.id`. Player ids are
  sequential (`'p' + nextId++`, `game.mjs:351`) and are broadcast to everyone
  in `welcome`/`joined`. Anyone who knows (or guesses) an offline player's id
  during the 25 s `OFFLINE_GRACE_MS` window can claim it.
- **Impact:** Attacker disconnects a target (TCP RST / lobby kick), then
  instantly rejoins as them — inheriting their hp, upgrades, wins, kos. The
  victim's real socket then can't reclaim ("Session expired"). In an 8-friend
  lobby this is trivially abusable.
- **Fix:** On `welcome`, generate a random session secret (e.g.
  `crypto.randomUUID()`), return it only to that socket (never broadcast), and
  require it on `rejoin`. Compare server-side before any state is copied.

### 10. Production Vercel function has no ping/pong keepalive; dead sockets never reaped

- **File:** `api/ws.ts:35-40` (contrast `server/index.mjs:35-44` which has the loop)
- **Bug:** `isAlive` is set to `true` on connect and never set to `false`, never
  checked, and `ws.ping()` is never called. The local dev server
  (`server/index.mjs`) implements the loop correctly; the Vercel port omitted it.
- **Impact:** When a client dies (network drop, laptop close, proxy timeout)
  the `ws` 'close' event never fires, so `engine.attach`'s close handler
  (`game.mjs:614`) never runs, so `markGone()`/`finalizeLeave()` never run.
  Result on the shared/Vercel path: ghost players stay `online:true` forever,
  rooms never collapse to lobby, rounds never end, idle reclamation never
  triggers because `onlineCount` stays >0, and the platform proxy also drops
  genuinely-idle sockets that aren't pinged.
- **Fix:** Port the `setInterval` from `server/index.mjs:35-44` into `ws.ts`
  (terminate when `isAlive===false`, else set `isAlive=false` and `ws.ping()`).

### 11. `maxDuration: 300` is too short for a Fluid-compute game session

- **File:** `vercel.json:7`
- **Bug:** A single round is ~185s (`countdown 5 + active 150 + upgrade 25 +
  end 5`, per `server/game.mjs:23`). Two rounds already exceed 300s. On Fluid
  compute the function is reaped at `maxDuration`, severing every WebSocket in
  the room.
- **Impact:** Any match lasting > 5 minutes is hard-killed; all 8 players
  disconnect with no grace. The README's "up to 8 players… rounds, comeback
  upgrades" pitch implies multi-round sessions that can't complete on Vercel.
- **Fix:** Bump to `800` (Fluid compute Pro max).

---

## High

### 12. `slam`/`throw` skip the `player.ko` and `phase` guard; KO'd grabber permanently pins victim

- **File:** `server/game.mjs:523-538`; `knockOut` at `game.mjs:124-132`
- **Bug:** Unlike `punch`/`grab`/`ranged`/`trigger`, the slam/throw handler has
  no `if (player.ko || room.phase !== 'active') return` at the top. When a
  grabber (or victim) is KO'd, `knockOut()` does not delete the entry from
  `room.grabs`. The grab pair persists until `beginCountdown` (next round).
- **Impact:** A KO'd grabber freezes the victim server-side for the remainder
  of the round (up to 150 s). The victim can't be re-grabbed by anyone else
  (`game.mjs:510` rejects duplicates), can't release themselves, and on the
  client is sprung toward a falling KO'd ragdoll. The trapped player is still
  counted as alive for round-end.
- **Fix:** Add the guard to slam/throw, and in `knockOut()` clear any grab
  where the victim is the grabber **or** the grabbed (broadcasting `released`).

### 13. Server cooldowns are looser than the client (DPS bypass)

- **File:** `server/game.mjs:14-16` vs `src/game/constants.ts:79-100,315-337`
- **Bug:**

  | Action | Server | Client |
  |---|---|---|
  | Punch | `HIT_COOLDOWN = 280` ms | `PUNCH.cooldown = 0.48` s (480 ms) |
  | Banana | `BANANA_COOLDOWN = 380` ms | `BANANA.cooldown = 0.7` s (700 ms) |
  | Laser | `LASER_COOLDOWN = 80` ms | `LASER.tickRate = 12` → ~83 ms ✓ |

- **Impact:** A modified client can fire ~1.7× faster (punch) and ~1.8× faster
  (banana) and the server happily accepts. Honest players lose DPS races
  against any packet-level cheat. The server is the referee — this is exactly
  the authority it should own.
- **Fix:** Drive these from the same source as the client (or copy `480`/`700`).
  Keep them tight on the server, never looser.

### 14. `DOMAIN` constants massively mismatch server vs client

- **File:** `server/game.mjs:24` and `:591` vs `src/game/constants.ts:342-352`
- **Bug:**

  | | Server | Client |
  |---|---|---|
  | Duration | `DOMAIN.duration = 6000` ms (6 s) | `DOMAIN.duration = 15` s |
  | Cooldown | `now - lastDomain < 9000` (9 s) | `DOMAIN.cooldown = 18` s |

- **Impact:** Caster thinks they're buffed for 15 s; after 6 s they deal/resist
  normal damage while their UI still shows the dome. They can also recast
  every 9 s server-side while their client thinks it's locked for 18 s —
  re-casts will appear to do nothing client-side but the server will accept
  and broadcast them.
- **Fix:** Align server constants to `15_000` and `18_000` or pull both from a
  shared file.

### 15. `trigger` (Domain Expansion) is unreachable on the server

- **File:** `server/game.mjs:26` (`ALL_UPGRADES`), `:589`
- **Bug:** `ALL_UPGRADES` is missing `domain_expansion`. `masterRoll` only
  draws from `ALL_UPGRADES`, so `domain_expansion` can never appear in
  `p.offer`, so `grantUpgrade` can never grant it. Yet the `trigger` handler
  at `game.mjs:586-595` checks `player.upgrades.includes('domain_expansion')`.
- **Impact:** Today this is dead code. The moment someone adds the id to
  `ALL_UPGRADES` without also wiring the constants fix from #14, players will
  get a domain that behaves nothing like the client predicts. Additionally
  `domainUntil`/`lastDomain` are not persisted in `publicRoom`, so a rejoin or
  cross-instance sync drops an active Domain buff silently.
- **Fix:** Either remove the `trigger` handler until the upgrade is shipped, or
  add `'domain_expansion'` to `ALL_UPGRADES` *and* fix #14 in the same change,
  *and* serialize `domainUntil`/`lastDomain` in `publicRoom` + restore them in
  `hydrateRoom`.

### 16. `maxHp` field is never updated after `big_gorilla`; broadcasts `hp=300, maxHp=100`

- **Files:** `server/game.mjs:214` (broadcasts `p.maxHp`) vs `:83-85`
  (`maxHp(p)` recompute) vs `:712-714` (`hpInit` only sets `MAX_HP`);
  `server/state.mjs:86` (`publicRoom`); client `src/net/NetClient.ts:221-230` +
  `src/net/RemoteAvatar.ts:138-146`
- **Bug:** `maxHp(p)` correctly returns 300 for a big-gorilla player. But the
  cached `p.maxHp` field is set once to `MAX_HP` (100) on join and never
  refreshed when upgrades change. `beginCountdown` broadcasts `maxHp: p.maxHp`
  (100) right after setting `p.hp = maxHp(p)` (300), so the wire says
  **300 / 100**. `publicRoom` persists `maxHp: p.maxHp` (100) into Redis, and
  `applySharedRoom`/rejoin read the stale value back. The client's
  `RemoteAvatar.setHealth` computes `f = hp/maxHp = 3.0` → `hpFill.scale.x = 3`,
  drawing the bar ~3× too wide.
- **Impact:** Big-Gorilla players show an overflowing health pip every round
  start; attacker force scaling that reads `info.maxHp` is also wrong. Self-
  heals after the first hit (applyDamage uses `maxHp(victim)`) but the round-
  reset framing is wrong.
- **Fix:** Replace `p.maxHp` with `maxHp(p)` at line 214 (or recompute
  `p.maxHp = maxHp(p)` inside `grantUpgrade` and on hydrate). Client:
  defensively clamp `f` to `[0,1]` in `setHealth`.

### 17. `roundLive` initialized to `true`; never seeded from `net.phase` on join

- **File:** `src/game/Game.ts:118` (init), `bindNet()` `:222-373` (no seed),
  consumed at `:605, :1250, :1304`
- **Bug:** `private roundLive = true` is correct for practice mode but in
  online mode the game can be constructed while the server's phase is
  `lobby`/`countdown`/`ended`/`upgrading`. `bindNet()` only updates `roundLive`
  inside `net.onPhase` — which does **not** fire for the phase already in
  effect at join time (the initial phase arrived in the `welcome` during
  `net.connect`, before `Game` existed; no `phase` message is re-sent).
- **Impact:** Between joining and the next server-driven phase transition, the
  client believes the round is live:
  - `falldmg` is sent during lobby (`:605`).
  - `fireDomain` is enabled during lobby (`:1250`) — F works in the menu/lobby.
  - `void` KO reports go up during lobby (`:1304`).
- **Fix:** In `bindNet()`, after assigning callbacks, add
  `this.roundLive = net.phase === 'active'`.

### 18. Reconnect on `error` message leaks the old socket and races a second one

- **File:** `src/net/NetClient.ts:122-156` (rejoin `onmessage`), `:142`
- **Bug:** When a `rejoin` gets a non-expired `error`, the handler calls
  `this.scheduleReconnect()` while the socket that delivered the error is
  still open (the server at `game.mjs:416` sends `{type:'error'}` and returns
  **without closing**). `scheduleReconnect` → `openSocket` → `this.ws = ws`
  (new), but the old `ws.onmessage` closure remains bound and live.
- **Impact:** Two simultaneous sockets; the stale one can still deliver a
  `welcome`/`pose` and mutate state, causing duplicate `acceptWelcome`/
  `dispatch`. The old socket's eventual `onclose` also triggers another
  `scheduleReconnect`, compounding. Socket + callback leak. (Latent behind #3
  today; surfaces the moment #3 is fixed.)
- **Fix:** Close and null handlers on the current `this.ws` before calling
  `scheduleReconnect()` in the error branch (`this.ws.onmessage = null;
  this.ws.close()`).

### 19. `connect()` promise can hang forever (close before welcome)

- **File:** `src/net/NetClient.ts:51-75` + `:170-177`
- **Bug:** In `openSocket`, `settled` flips to `true` on `onopen`. If the
  socket then closes before the server sends `welcome`/`error` (server crash
  mid-handshake, proxy timeout), `onclose` sees `settled === true`, so it
  neither calls `onFail()` (reject) nor `scheduleReconnect()` (status is
  `'connecting'`, not `'online'`). The promise returned by `connect()` never
  settles.
- **Impact:** The UI is stuck on "connecting…" indefinitely; the awaiter never
  resumes. Compounded by #3 (no reconnect).
- **Fix:** Track a `resolved` flag and call `onFail()` whenever status is still
  `'connecting'` on close.

### 20. `trackFall` bills phantom fall damage when entering climb or flight mid-fall

- **File:** `src/game/Gorilla.ts:578-583` (`trackFall`)
- **Bug:** The landing/billing branch is `else if (this.airborne)` — which
  fires whenever the gorilla is grounded **OR** climbing **OR** flying. So
  transitioning from a fall into a wall-grab or into flight is treated as a
  "landing": `pendingFall` is set using the pre-transition apex.
- **Impact:** A Flight player who jumps off a tower and engages flight after
  >6 m of descent (or a climber who catches a wall after a long fall) is
  billed fall damage they never actually land. `FALL.safeDistance=6` gates it,
  so any >6 m pre-flight/pre-climb fall deals damage.
- **Fix:** Gate the billing on actual ground contact — only run the
  `pendingFall` block when `grounded`. The climb/flight transitions should
  silently reset `airborne`/`apexY` like the final `else if` does.

### 21. Cross-instance roster/online-state divergence — `applySharedRoom` skips unknown players and never syncs `online`

- **File:** `server/game.mjs:637-655` (`applySharedRoom`); `:268` (hydrate sets `online:false`)
- **Bug:** When a player joins on instance A, `joined` is relayed to B's
  clients via the outbox, but B's server-side `room.players` never gains that
  player (`const p = room.players.get(sp.id); if (!p) continue`). So B cannot
  compute combat or distance against remote players. Separately, `online` is
  never copied out of the shared snapshot, so every hydrated player stays
  `online:false` on B forever; consequently `broadcast` (skips `!p.online`),
  `checkRoundOver`/`onlineCount`, and `maybeStart` are all wrong on the non-
  owning instance.
- **Impact:** The multi-instance shared path the `state.mjs` module exists to
  support does not converge on roster or liveness. Combat validation and
  round flow are broken on any non-owning instance.
- **Fix:** In `applySharedRoom`, insert missing players (mirror the
  `hydrateRoom` player object) and copy `sp.online`; also handle `joined` in
  `applyShareEvent` to add remote players eagerly.

### 22. Lost-update race in the shared Redis write path — no compare-and-set

- **Files:** `server/state.mjs:103-106` (`saveRoom`) driven by
  `server/game.mjs:53-60` (`publish`) called fire-and-forget from `emitAll`
  (`game.mjs:47-51`)
- **Bug:** `publish` does read-modify-write on local state then
  `SET gffa:room:<code> <snapshot>` with no `WATCH`/`MULTI` or Lua. Two
  instances each applying damage/event and calling `saveRoom` clobber each
  other: the last `SET` wins and the other instance's mutations (health, KO,
  grabs, phase) silently vanish from the shared snapshot. Then `applySharedRoom`
  (runs every 250 ms) overwrites local authoritative values from that
  snapshot, reverting legitimate damage.
- **Impact:** This is the core correctness gap of the module whose purpose is
  cross-instance sharing. Documented as accepted risk for warm-instance
  deployments in `MULTIPLAYER.md`, but on Vercel multi-region this is a real
  desync vector.
- **Fix:** Use a Redis atomic update (Lua script, or `WATCH`/`MULTI` retry
  loop) that merges per-field deltas, or version room snapshots and reject
  stale writes; at minimum serialize combat through a single atomic
  counter/authority per room.

### 23. Banana-gun GPU resources never disposed; physics bodies/constraints never removed

- **Files:** `src/game/Gorilla.ts:285-298` (creation), `:1150-1152` (`dispose`)
- **Bug:** The banana gun builds three inline per-instance resources —
  `new THREE.BoxGeometry`, two `new THREE.CylinderGeometry`, and three
  `new THREE.MeshStandardMaterial` — none of which are pushed to
  `this.materials`. `dispose()` only iterates `this.materials`, so those
  geometries + materials leak. `dispose()` also never calls
  `world.removeBody`/`world.removeConstraint`, so the 5 bodies + 4 ConeTwist
  constraints (with `allowSleep=false`) keep simulating.
- **Impact:** GPU memory grows per gorilla destruction; physics keeps ticking
  off-screen bodies. Latent behind #1 today (no `Game.dispose()` exists), but
  the documented cleanup path is incomplete.
- **Fix:** Push the banana-gun materials through `mkMat` (or a dedicated list)
  and dispose the three geometries; in `dispose()`, remove each constraint and
  body from the world.

### 24. `npm run build` skips type-checking; type errors ship to prod

- **Files:** `package.json:8` (`"build": "vite build"`) combined with
  `tsconfig.json:15` (`"noEmit": true`) and `:30` (`"include": ["src",
  "vite.config.ts"]`)
- **Bug:** Vite's build transpiles via esbuild and **does not type-check**.
  The project ships a `typescript` dep and a strict `tsconfig.json`, but
  nothing runs `tsc`. Combined with the include rule, the entire `api/`
  directory and any latent type regressions in `src/` pass silently.
- **Impact:** Broken refactors (e.g. `protocol.ts` union changes that
  `App.tsx`/`NetClient.ts` miss) deploy green. `tsc --noEmit` currently fails
  with 12+ errors (the ones in this report) and `vite build` ignores them all.
- **Fix:** `"build": "tsc -b && vite build"`, add `"api"` to `tsconfig.json`
  `include`, and add `@types/ws` to `devDependencies`.

---

## Medium

### 25. `POSE_MAX_DELTA = 35` makes server-side anti-teleport meaningless

- **File:** `server/message.mjs:8` (clamp at `:50-62`)
- **Bug:** The anti-teleport clamp permits 35 units of motion per 50 ms pose
  tick (i.e. **700 u/s** in an arena whose half-extent is 40). The arena can
  be crossed in ~0.11 s. The check is also disabled entirely when `py <= -10`,
  so any cheater who dips below the floor can teleport freely (and the
  exemption applies to all axes, not just vertical).
- **Impact:** Because all combat range checks (`game.mjs:499,511,551,569`) use
  `player.pose` (self-reported) vs `t.pose`, a cheater can teleport adjacent
  to any victim and pass `dist ≤ PUNCH_RANGE`. Effectively **no server-side
  range enforcement exists** against a client willing to forge poses.
- **Fix:** Lower `POSE_MAX_DELTA` to ~2–3 units/tick (tune for big_gorilla
  scale). Keep the void-fall exemption but only on the `y` axis below the
  floor, not on `x`/`z`.

### 26. Falldamage clamp is 100 on the server, 60 on the client; `bouncy_boy` not enforced

- **Files:** `server/message.mjs` (`case 'falldmg'`), `server/game.mjs:580-582`
- **Bug:** Server clamps `falldmg` to `[0, 100]`; client's own
  `FALL.maxDamage = 60`. The authoritative bound should be the lower of the
  two. The server has no concept of `fallDamageMul`. A player who picked
  `bouncy_boy` (client `m.fallDamageMul = 0`) can still send a `falldmg`
  packet and have it applied. The server trusts whatever the client reports.
- **Impact:** A cheater can only damage *themselves* via this path (useful for
  suiciding to deny an attacker the KO credit). Real authority leak — the docs
  explicitly say fall damage is the one client-reported number, but the clamp
  and the Bouncy Boy immunity should both be server-enforced so an honest
  client and a cheating client get the same rules.
- **Fix:** Clamp to `FALL.maxDamage` (60) and zero-out `falldmg` when
  `p.upgrades.includes('bouncy_boy')`.

### 27. Rejoin duplicate-session guard is local-only; cross-instance reconnect bypasses it

- **File:** `server/game.mjs:412-417`
- **Bug:** `prev.online` is read from the *current instance's* player object.
  If the original session is still alive on instance A (`online:true`) and the
  player reconnects to instance B, B's hydrated copy has `online:false`
  (`game.mjs:268`), so B accepts the rejoin and binds the same id to a second
  live socket.
- **Impact:** Two instances now relay poses/inputs for one identity —
  duplicated `punched`/`health` resolution, KO desync, double-counted
  wins/KOs.
- **Fix:** Make rejoin reservation atomic across instances (e.g. a Redis
  `SETNX gffa:session:<id>` lease with short TTL, or reject when the shared
  snapshot reports `online:true`).

### 28. Two sockets can race the same rejoin id (async handleRaw)

- **File:** `server/game.mjs:412-450` (`handleRaw` is `async`, `await`s `hydrateRoom`)
- **Bug:** Two sockets both enter the rejoin branch before either has swapped
  itself into `r.players`. Both pass the `if (!r || !prev || prev.online)`
  check, both then do `r.players.delete(prev.id); r.players.set(player.id,
  player)`. Second write wins; the first socket's `player` object remains in
  JS memory with `player.room = r` (or undefined per #8) but is no longer
  referenced by `r.players`.
- **Impact:** The orphaned socket keeps receiving messages and silently
  no-ops them, but on disconnect `markGone` either early-returns (#8) or fires
  `finalizeLeave` on a player no longer in `r.players`, broadcasting a bogus
  `left` for an id that's currently active.
- **Fix:** Set `prev.online = true` immediately as a reservation before the
  first `await`, or make the rejoin critical section synchronous.

### 29. Ranged range constants disagree between server and client

- **File:** `server/game.mjs:13` (`RANGED_RANGE = 34`) vs
  `src/net/protocol.ts:14` (`NET.rangedRange = 30`),
  `src/game/constants.ts:329` (`LASER.range = 28`), and banana lifetime
  `BANANA.speed * BANANA.life = 34 * 2.2 ≈ 75`
- **Bug:** Server laser check is `dist > 34` (`game.mjs:569`); server banana-
  impact check is `dist > 40` (`RANGED_RANGE + 6`, `game.mjs:551`). Client
  bananas travel up to ~75 units and lasers nominally reach 28. Server is
  *more* permissive for lasers (good — no false negatives) but *more*
  restrictive for bananas (40 vs 75).
- **Impact:** Long-range banana hits desync — shooter sees a splat and a hit
  marker, victim takes no damage. Annoying, not exploitable.
- **Fix:** Use `RANGED_RANGE = max(LASER.range, BANANA.speed * BANANA.life)`
  on the server (or split per-kind).

### 30. Remote punch/slam/throw knockback ignores `DOMAIN.buffKnock`/`buffResist`

- **File:** `src/game/Game.ts:249-260` (`net.onPunched`)
- **Bug:** For a locally-landed punch, `handlePunch()` applies
  `this.domainBuff()` to the dummy's knockback (`:686`). For a **remote-
  sourced** punch arriving over the wire, the multiplier is only
  `am.forceMul * am.punchKnockMul`. The attacker's active domain buff
  (`DOMAIN.buffKnock = 1.5`) is not included, and neither is the local
  victim's `DOMAIN.buffResist`. Slams (`:288`) and throws (`:298`) have the
  same omission.
- **Impact:** When an opponent has Domain Expansion active, their punches/
  slam/throw feel ~1.5× weaker on the victim's screen than on the attacker's,
  and a victim standing in *their own* domain takes full knockback instead of
  60%. Desynced feel during domain windows; `MULTIPLAYER.md:69` explicitly
  says victims must scale knockback by the attacker's modifier bag.
- **Fix:** Ship `domainActive` in `PlayerInfo` and fold
  `DOMAIN.buffKnock`/`buffResist` into the multiplier here, or move the buff
  into `modsFor` itself. Same fix for `onSlammed`/`onThrown`/`onRanged`.

### 31. `onThrown` divides vertical by `forceMul` but `performThrow` doesn't (arc desync)

- **File:** `src/game/Game.ts:298-311` (`onThrown`) vs `:908-931` (`performThrow`)
- **Bug:** When the local player throws a dummy, `performThrow` uses
  `upImpulse = base * THROW.up` (vertical not divided by `forceMul`). When a
  remote attacker throws the local player, `onThrown` does
  `const up = THROW.up / Math.max(1e-4, tm.forceMul)`. The two formulas
  disagree: a Big Gorilla (forceMul 3) throwing a dummy locally gets
  `up = 0.55`, but a Big Gorilla throwing the local player over the network
  gets `up = 0.55/3 = 0.183`. The victim's arc is 3× flatter than what the
  attacker sees on their own screen for the same action.
- **Impact:** Network throws by upgraded gorillas look and feel nothing like
  the local prediction — the victim shoots sideways instead of arcing. The
  comment at `:302-303` claims this is intentional, but it directly
  contradicts the local-side comment and the attacker-prediction code.
- **Fix:** Pick one. If the intent is "giant throws go flat", apply the same
  `/forceMul` in `performThrow`'s `upImpulse`. If the intent is "vertical pop
  is constant", remove the division in `onThrown`.

### 32. Grab hold distance scales with `sqrt(scale)`, so Big Gorilla's constraint fights sphere collision

- **File:** `src/game/Game.ts:795` (`lockDummyGrab`)
- **Bug:** `hold = GRAB.holdDistance * Math.sqrt(this.player.mods.scale)`. At
  scale 1, `hold=1.6 > 2*0.7=1.4` ✓ (the case the prior audit fixed). But for
  Big Gorilla (scale 3): `hold = 1.6*√3 ≈ 2.77`, while the two torso radii
  sum to `0.7*3 + 0.7*victimScale`. Against a normal victim that's `2.8`,
  against another Big that's `4.2` — the hold point is *inside* the colliders
  in both cases. The `PointToPointConstraint` then pulls the victim into the
  player's torso while collision pushes it out.
- **Impact:** Grabbing as/with Big Gorilla produces severe jitter, slingshot
  launches, or the held target vibrating in place.
- **Fix:** Scale linearly with radii, e.g.
  `hold = GORILLA.torsoRadius * (playerScale + victimScale) + 0.2`.

### 33. Banana `onHit` re-applies knockback to dummies from remote-fired bananas

- **File:** `src/game/Game.ts:1393-1398`
- **Bug:** The projectile-impact callback runs `this.hitDummyRanged(id, dir,
  'banana')` whenever `id.startsWith('dummy:')`. That branch is correct for
  *local* bananas (dummies are local physics), but the callback is invoked by
  `Projectiles.update` for **every** banana, including bananas fired by
  remote players (`live=false`).
- **Impact:** In practice mode there are no remotes, so this is dormant. In
  online mode `this.dummies` is empty (`:196`), so it's also dormant *today*.
  But it's a latent double-knockback / authority bug the moment dummies and
  remotes coexist (shared practice rooms, future PvE).
- **Fix:** Check the banana's `live` flag in the callback and skip
  `hitDummyRanged` for non-owned bananas.

### 34. `pose.id` set without guarding empty `net.id` (reconnect race)

- **File:** `src/game/Game.ts:1380-1382`
- **Bug:** `const pose = this.player.snapshot(...)` returns `PoseMsg` whose
  declared `id` is `''`. The code then does `pose.id = this.net.id`. `tsc`
  complains `Object is possibly 'null'`. If `net.id` is ever empty (e.g.
  during the brief window after a manual `disconnect()` clears `this.id = ''`
  at `NetClient.ts:308` but before the Game is disposed, or right after a
  reconnect before `acceptWelcome`), the pose is sent with `id: ''`. The
  server can't attribute the pose; the snapshot is silently dropped, and every
  remote sees the local gorilla freeze.
- **Impact:** Stale/frozen local avatar for everyone else after disconnect/
  reconnect races.
- **Fix:** Guard `if (!this.net?.id) return` before snapshotting.

### 35. HUD stats object omits `flightRecharge`; recharge display frozen

- **File:** `src/game/Game.ts:1428-1447` (vs `flushStats()` `:408-434`)
- **Bug:** `GameStats` requires `flightRecharge`. The inline HUD payload built
  every frame in `loop()` does not include it. `tsc`: `TS2345: Property
  'flightRecharge' is missing`. Only the rarely-called `flushStats()` emits
  it.
- **Impact:** The "Flight recharging Ns" indicator (`App.tsx:265-268`) only
  updates when `flushStats` runs (upgrade-toggle / practice-picker toggle).
  During normal play the recharge countdown is wrong/stale and never ticks
  down to 0.
- **Fix:** Add `flightRecharge: this.player.flightCooldown` to the inline
  payload.

### 36. Domain Expansion shell doesn't actually block projectiles

- **File:** `src/game/Effects.ts:328-333` (`domain`)
- **Bug:** The Domain Expansion shell is built as a CANNON body in collision
  group `2` (comment claims "GROUND_GROUP-equivalent" while `GROUND_GROUP` is
  actually `1`, `constants.ts:7`). But bananas/lasers are *not* physics
  bodies — they're manual point/ray queries that never consult the CANNON
  world.
- **Impact:** The promised "Solid walls — projectiles collide with them"
  (`constants.ts:341`) is not implemented: banana and laser fire passes
  straight through the opaque dome. Only CANNON bodies (gorillas) are blocked.
- **Fix:** Add the domain sphere to `raycastArena`'s ray targets so laser
  beams clip, and do a sphere-distance test in `Projectiles.update` for
  bananas; or at minimum set the group to `GROUND_GROUP` (`1`).

### 37. Laser impact `RingGeometry` never disposed

- **File:** `src/game/Projectiles.ts:107-120` (`fireBeam`) + cleanup at `160-169`
- **Bug:** Each beam allocates an inline `new THREE.RingGeometry(0.18, 0.7,
  18)` for its impact ring, but despawn only disposes `beam.mats` — the ring's
  geometry is never disposed. The cylinders reuse shared `beamGeo` and the
  disc reuses shared `discGeo`, so the RingGeometry is the lone per-beam leak.
- **Impact:** Continuous laser fire spawns ~12 beams/s. Each despawn leaks
  one `RingGeometry` GPU buffer indefinitely. Unbounded GPU-memory growth
  under sustained Laser Eyes fire.
- **Fix:** Promote the impact ring to a module-level shared geometry (like
  `discGeo`), or dispose `ring.geometry` alongside the materials in despawn.

### 38. Domain geometries never disposed on despawn/teardown

- **File:** `src/game/Effects.ts:298-303` (`update` domain despawn) and
  `:405-418` (`dispose`)
- **Bug:** Domain despawn/teardown disposes only `d.mats`. The per-domain
  inline geometries — the dome `SphereGeometry(radius,48,24)` (line 323),
  three plant-trunk `CylinderGeometry` (370), three plant-leaf `ConeGeometry`
  (373) — are never disposed.
- **Impact:** Each Domain Expansion (18s cooldown) leaks ~7 mid-poly
  geometries; the dome alone is a 48×24 sphere. Repeated casting accumulates
  GPU buffers for the match.
- **Fix:** Track the domain's geometries alongside `mats` (or traverse
  `d.group` and dispose each `mesh.geometry`) and dispose them in both the
  `update` despawn branch and `dispose()`.

### 39. `RemoteAvatar` snapshots never cleared on reconnect or round reset

- **File:** `src/net/RemoteAvatar.ts:56,165-174` (no `reset`/`clear` method);
  `src/game/Game.ts:437-449` (`resetForRound` resets `ko` only)
- **Bug:** `snaps` accumulates per-pose; there is no method to flush it.
  `Game.resetForRound` and reconnect (via `acceptWelcome` + re-`onJoined`)
  reuse avatar objects keyed by id, leaving stale `t`/positions in the buffer.
  Also `push()` performs no stale/out-of-order discard — a retrograde or
  duplicate `t` (possible after reconnect burst) can sit at `snaps[0]` while
  newer snaps sit later, so the `sample` binary search picks a window that
  spans a discontinuity.
- **Impact:** Visual snap/glitch on every round boundary and every reconnect;
  can briefly render a remote at a stale position or "swim" across the arena
  on a glitch tick.
- **Fix:** Add `clearSnaps() { this.snaps.length = 0 }` and call it from
  `Game.resetForRound` and from the `onJoined`/rejoin path when (re)creating
  an avatar. On `push`, if `msg.t <= snaps[last].t` ignore or replace.

### 40. `resolveWsUrl` returns raw `?ws=`/localStorage value with no scheme validation

- **File:** `src/net/protocol.ts:107-118` (`:110-111`)
- **Bug:** `const forced = q.get('ws') || localStorage.getItem('gffa-ws'); if
  (forced) return forced`. A user typing the value recommended in
  `MULTIPLAYER.md` as `?ws=192.168.1.5:8787` (no `ws://`) yields
  `new WebSocket('192.168.1.5:8787')`, which **throws `SyntaxError`
  synchronously** inside `openSocket` (`:162`), escaping the promise —
  `connect()` never resolves or rejects. The stale `localStorage['gffa-ws']`
  also silently overrides the production Vercel URL (checked before the
  `https:` → `wss://` branch).
- **Impact:** Mis-formatted `ws` override hard-crashes/hangs join; the docs
  actively encourage the footgun. Returning players who ever used `?ws=` on
  dev keep connecting to a stale address even after Vercel deploy.
- **Fix:** Validate with a regex `/^wss?:\/\//`; if missing, prepend `ws://`.
  Check `location.protocol === 'https:'` first and ignore localStorage there.
  Wrap `localStorage.getItem` in `try/catch` (it's bare here, unlike the rest
  of the codebase).

### 41. Vercel handler drops `req`, so client IP is never extracted

- **File:** `api/ws.ts:35`
- **Bug:** The `connection` callback is `(ws) => …` — the second arg (`req`)
  is discarded. On Vercel Fluid compute the client IP lives in
  `req.headers['x-forwarded-for']`. The engine's `attach(ws)` (`game.mjs:607`)
  also takes no IP.
- **Impact:** No IP-level rate limiting, abuse blocking, region logging, or
  per-IP flood control is possible on Vercel. A single client could open
  dozens of sockets from one IP and exhaust the 8-slot rooms across codes.
- **Fix:** Capture `(ws, req)`, extract
  `req.headers['x-forwarded-for']?.split(',')[0]`, and thread it into
  `engine.attach(ws, ip)` for the limiter / logs.

### 42. `api/ws.ts` is excluded from the TypeScript program

- **File:** `tsconfig.json:30`
- **Bug:** `"include": ["src", "vite.config.ts"]` — the entire `api/` folder
  is out of program. `api/ws.ts` is the production entry point and is never
  type-checked locally, even if `tsc` were added to `build`. `@types/ws` is
  not installed (only `ws` runtime is in `package.json:21`).
- **Impact:** The `// @ts-ignore`-laden imports of `../server/game.mjs`/
  `state.mjs` and the `express`/`ws` usage get zero verification.
- **Fix:** Add `"api"` to `include` and add `@types/ws` to `devDependencies`;
  remove the `@ts-ignore`s once `.mjs` sibling declarations exist.

### 43. `store` referenced before declaration in the health-check handler (TDZ)

- **File:** `api/ws.ts:24` vs `api/ws.ts:30`
- **Bug:** The express route closure reads `store.shared` on line 24, but
  `const store = makeStore()` is declared on line 30. It only works because
  the handler can't fire until after module evaluation completes.
- **Impact:** If anyone later calls the handler during module init (SSR
  warmup, test import), it throws `ReferenceError: Cannot access 'store'
  before initialization`.
- **Fix:** Move `const store = makeStore()` and `const engine = …` above
  `app.get(...)`.

### 44. `server/package.json` is missing `@upstash/redis`

- **File:** `server/package.json:9-11`
- **Bug:** `server/state.mjs:62` does `await import('@upstash/redis')` when env
  vars are set. The server's own `package.json` only declares `ws`. It only
  works from the project root because Node walks up to the root `node_modules`.
- **Impact:** `cd server && npm install && npm start` with the two Upstash env
  vars set throws `ERR_MODULE_NOT_FOUND` at the first Redis call.
- **Fix:** Add `"@upstash/redis": "^1.38.2"` to `server/package.json`
  `dependencies`, or delete the vestigial file and document root-only installs.

---

## Low

### 45. Void-respawn leaves several action/flight flags stale

- **File:** `src/game/Gorilla.ts:1092-1109` (`tickRespawn` fall entry)
- **Bug:** The fall-entry block clears `punching`, `moveIntent`, `isGrabbed`,
  `grabbedTarget`, `grabbedBy`, `climbing`, `climbZone`, `climbCooldown`, but
  not `flying`, `flyRise`, `flySink`, `flightRiseArmed`, `grabReachTimer`,
  `hitSet`, `staggerTimer`, or `punchCooldown`/`grabCooldown`. Also never
  resets `apexY`/`airborne`/`pendingFall`.
- **Impact:** (a) Falling into the void while `flying=true` respawns with
  flight still "on" but `flightTimer=0` → one frame where `preStep` re-enters
  the flight branch and immediately sets `flightCooldown=FLIGHT.recharge`.
  (b) `grabReachTimer` keeps driving both arms to a forward-clasp target for
  up to ~0.55 s after the body reappears at spawn. (c) A stale `pendingFall`
  could be double-billed by a future code change giving downward velocity.
- **Fix:** Clear `this.flying = this.flyRise = this.flySink = false;
  this.grabReachTimer = 0; this.hitSet.clear(); this.apexY = pos.y;
  this.airborne = false; this.pendingFall = null;` in the fall-entry block
  (or in `resetPose`).

### 46. `releaseGrab()` doesn't clear `heldById` / `isGrabbed` on the victim side

- **File:** `src/game/Game.ts:838-842`
- **Bug:** `releaseGrab()` does not clear `this.heldById` or
  `this.player.isGrabbed`, so a KO'd victim who was being held still has
  `heldById` pointing at a possibly-disconnected holder.
- **Impact:** After being grabbed and then KO'd by a third party, `heldById`
  stays set, so `:1336` keeps recomputing `holdPoint` from a stale/leaving
  holder's `pos`. The limp KO ragdoll gets yanked toward a stale position.
- **Fix:** In `releaseGrab()`, also clear `this.heldById = null;
  this.player.isGrabbed = false; this.player.holdPoint = null;`.

### 47. `handlePunch` doesn't skip KO'd dummies/remotes (inconsistent with `rangedTargets`)

- **File:** `src/game/Game.ts:694-712`
- **Bug:** The remote-punch loop filters `av.flags & FLAG.respawning` but does
  **not** filter `av.ko`. A KO'd remote (limp ragdoll) can still be punched,
  the punch sends `{type:'punch', target:id}` to the server, and
  `this.player.hitSet.add(av)` prevents re-hitting this punch. Compare to
  `rangedTargets()` (`:454-465`) which filters both `av.ko` and `d.ko`.
- **Impact:** Wasted punch events to the server, and the local player's
  `hitSet` is "spent" on a target that shouldn't have been hittable.
- **Fix:** Add `if (av.ko) continue` in the remote loop and `if (enemy.ko)
  continue` in the dummy loop.

### 48. `takeHit` overwrites `laserInterrupt` instead of taking the max

- **File:** `src/game/Gorilla.ts:1052`
- **Bug:** `this.laserInterrupt = 0.5` unconditionally. `applyLaunch`
  (line 1038) correctly uses `Math.max(this.laserInterrupt, 0.6)`. If a
  gorilla already has a longer interrupt (e.g. 0.8 from a prior hit this same
  frame), `takeHit` shortens it.
- **Fix:** `this.laserInterrupt = Math.max(this.laserInterrupt, 0.5)`.

### 49. Latent NaN: `facing` normalized after y is zeroed

- **File:** `src/game/Gorilla.ts:628-630` (`controlMove`)
- **Bug:** The guard is `dir.lengthSquared() > 1e-4` (3D), but then
  `this.facing.set(dir.x, 0, dir.z)` discards y before `normalize()`. A purely-
  vertical input (`dir` ≈ `(0, y, 0)`) passes the guard, sets `facing` to
  `(0,0,0)`, and `normalize()` divides by zero → NaN propagates into gait,
  punch, yaw, and snapshots.
- **Impact:** Not reachable from `Game.computeMoveDir` (always horizontal),
  but it's a latent zero-length-normalize hazard at the public API boundary.
- **Fix:** Guard on the horizontal magnitude:
  `if (dir.x*dir.x + dir.z*dir.z > 1e-4)`.

### 50. `controlWander` has no `ko` guard

- **File:** `src/game/Gorilla.ts:638-639`
- **Bug:** Guards only `respawning` and `isGrabbed`. `preStep` (line 770)
  correctly goes limp when `ko`, but `controlWander` is invoked separately each
  frame from `Game.ts:1273` and would keep applying locomotion force to a KO'd
  dummy.
- **Impact:** Currently none — no code path sets `dummy.ko = true`. Latent: if
  dummies ever become KO-able, they'd keep wandering while limp.
- **Fix:** Add `this.ko` to the early-return guard.

### 51. `onBlur` doesn't clear queued actions (stuck throw-charge on alt-tab)

- **File:** `src/game/Input.ts:168-174`
- **Bug:** `onBlur` clears held flags but does **not** clear the edge-queued
  actions (`jumpQueued`, `punchQueued`, `slamQueued`, `grabQueued`,
  `throwPressedQueued`, `throwReleasedQueued`, `triggerQueued`,
  `upgradeQueued`). The throw path is the worst case: a player holding Q
  (charging) who alt-tabs can miss the `KeyQ` keyup, so `throwReleasedQueued`
  never sets and Game's charge state sticks until they press+release Q again.
- **Impact:** Stale queued action on refocus; potentially a stuck throw-charge
  if the keyup is lost to the blur.
- **Fix:** In `onBlur`, also reset the queued flags and synthesize a
  `throwReleasedQueued` clear so Game can detect the lost release.

### 52. HUD FPS clamped to ≥20 because the `dt` clamp feeds the FPS calc

- **File:** `src/game/Game.ts:1127,1437`
- **Bug:** `let dt = this.clock.getDelta(); if (dt > 0.05) dt = 0.05` clamps
  the display input too. Then `fps: Math.round(1 / Math.max(dt, 1e-4))`.
- **Impact:** During a stutter the reported FPS never drops below ~20 even if
  the real frame took 200 ms. HUD FPS counter is misleading during hitches.
- **Fix:** Compute FPS from the unclamped delta (capture `rawDt` before the
  clamp).

### 53. `vec3` clamps direction vectors to length ≤ 1.5, not a unit vector

- **File:** `server/message.mjs:12-21` (default `clampLen = 1.5`)
- **Bug:** Used for `punch`/`slam`/`throw`/`ranged` `dir`. Per
  `MULTIPLAYER.md` the victim applies knockback on its own sim. Because `dir`
  is not normalized, an attacker can send a vector of length 1.5 and inflate
  outbound knockback/impulse by 50% on every peer. Zero vectors (`[0,0,0]`)
  also pass validation.
- **Impact:** Knockback inflation exploit; `throw` already has a separate
  `charge` for scaling.
- **Fix:** Normalize `dir` to unit length (clamp then divide), or reject
  vectors shorter than a small epsilon.

### 54. Quaternion `q` not validated as a unit quaternion

- **File:** `server/message.mjs:74`
- **Bug:** `q` is clamped per-component to [-1,1] but never validated as a
  unit quaternion. `[1,1,1,1]` (norm 2) and other non-unit tuples pass and get
  relayed to remotes, producing garbage rotations on interpolated ghosts.
- **Fix:** Either normalize (`q`/norm) or reject when
  `|x²+y²+z²+w² − 1|` exceeds a tolerance.

### 55. `RateLimiter.bad` is monotonic — never reset on window rollover

- **File:** `server/message.mjs:163-193`
- **Bug:** `bad` accumulates over the entire connection lifetime. The 1-second
  reset block at L173-177 resets `total` and buckets but not `bad`. After 60
  lifetime malformed/invalid messages (across hours of play) `markBad()`
  returns false and the socket is closed with 1008.
- **Fix:** Reset `this.bad = 0` in the same window-rollover branch.

### 56. `WebSocketServer` constructed without `maxPayload`

- **Files:** `api/ws.ts:28` and `server/index.mjs:25`
- **Bug:** `new WebSocketServer({ server })` — the `ws` default of 100 MiB
  applies, not the 6 KB the validator assumes. `parseRaw` rejects strings
  longer than `MSG_MAX_BYTES` (6144), but that check only runs after `ws` has
  already accepted and buffered the full frame.
- **Impact:** A single malicious peer can push a ~100 MB frame per message to
  buffer/OOM the process before sanitization runs.
- **Fix:** `new WebSocketServer({ server, maxPayload: MSG_MAX_BYTES })`.

### 57. No WebSocket origin check (local or Vercel)

- **Files:** `server/index.mjs:27-31` and `api/ws.ts:35-40`
- **Bug:** Neither `connection` handler inspects `req.headers.origin`. Any web
  page can open a socket to a running room server and `create`/`join` rooms.
- **Impact:** A malicious page visited by one of the 8 friends could open
  cross-site sockets, exhaust room slots, or spam combat intents.
- **Fix:** Compare `req.headers.origin` against an allow-list
  (`location.host` on Vercel, `http://localhost:5173`/LAN in dev).

### 58. Internal sync event `reset` is broadcast to clients though it's not in the S2C union

- **File:** published at `server/game.mjs:216,301`; broadcast to local clients
  via `server/game.mjs:628-632`
- **Bug:** `pollShared` fans every outbox message — including
  `{type:'reset'}` — to all local sockets. `reset` is not part of
  `protocol.ts`'s `S2C`, so a typed client has no handler; depending on its
  dispatcher this is silently dropped or throws.
- **Fix:** Either add `reset` to `S2C` in `protocol.ts`, or exclude internal-
  only types from `broadcast` in `pollShared`.

### 59. `memoryImpl.deleteRoom` only clears `_rooms`; leaks `_inst`, `_obx`, `_cursor`

- **File:** `server/state.mjs:20-22`
- **Bug:** Every room create→delete cycle leaves behind an empty Set in
  `_inst`, an array (up to 256 events) in `_obx`, and cursor entries in
  `_cursor`. The in-memory store has no TTL.
- **Impact:** On a long-running dev/LAN server with room churn these maps grow
  without bound.
- **Fix:** In `memoryImpl.deleteRoom`, also `delete` from `_inst`, `_obx`,
  and sweep `_cursor` entries matching the code prefix.

### 60. A single connected player can keep cycling rounds indefinitely

- **File:** `server/game.mjs:156-175`
- **Bug:** `startUpgradePhase` only checks `players.length === 0`, not
  `onlineCount < ROUND.minPlayers`. If everyone but one disconnects during
  `'ended'`, that one player gets a perpetual upgrade offer → countdown →
  solo active round → endRound → repeat. `maybeStart` enforces `minPlayers`
  but the ended→upgrading→countdown loop does not.
- **Fix:** Add `if (onlineCount(room) < ROUND.minPlayers) return
  collapseToLobby(room)`.

### 61. Ring opacity pop on first update frame

- **File:** `src/game/Effects.ts:283-285`
- **Bug:** Ring fade hardcodes a `0.95` base:
  `opacity = Math.max(0, 0.95 * (1 - t))`. Several rings are created with a
  different initial opacity (slam ring2 = 0.8, throw/burst rings = 0.9), so on
  the first `update` frame their opacity jumps *up* toward 0.95 before fading.
- **Fix:** Store each ring's `opacity0` on the `Ring` record and fade as
  `opacity0 * (1 - t)`.

### 62. `startOnline` doesn't null `netRef` on failure

- **File:** `src/App.tsx:94-115`
- **Bug:** `netRef.current = net` (line 95) runs *before* the
  `await net.connect(...)`. In the `catch`, `net.disconnect()` is called but
  `netRef.current` is **not** nulled.
- **Impact:** After a failed Join/Create, `netRef.current` is non-null but
  dead; a subsequent `startSolo` calls `disconnect()` on a stale client. Self-
  heals on the next session action.
- **Fix:** Set `netRef.current = null` in the `catch` block.

### 63. Event-callback fields not cleared on `disconnect`

- **File:** `src/net/NetClient.ts:24-38,297-319`
- **Bug:** `disconnect()` clears `ws`, `players`, `id`, `offer`, `session`,
  but leaves `onWelcome`/`onPose`/`onPunched`/… pointing at the consumer
  (e.g. a disposed `Game`).
- **Impact:** Latent use-after-free-style stale reference; currently masked
  because `disconnect` also tears down the socket.
- **Fix:** Null the callback fields in `disconnect`.

### 64. `PoseMsg.v` is validated, relayed, and transmitted but never consumed

- **Files:** `src/net/protocol.ts:24`, `src/net/RemoteAvatar.ts:156-174`
  (only reads `p,q,l,f,s`), `server/message.mjs` `sanPose` clamps `v`
- **Bug:** Velocity `v` is part of every pose (3 floats × 8 players × 20 Hz)
  but the remote renderer never uses it (no extrapolation). Pure bandwidth
  waste (~1.4 KB/s per peer).
- **Fix:** Either consume `v` for extrapolation, or drop it from
  `PoseMsg`/`sanPose`.

### 65. `<title>` still a dev placeholder

- **File:** `index.html:6`
- **Bug:** `<title>Gorilla FFA — Phase 4</title>` — "Phase 4" is an internal
  milestone label.
- **Fix:** `<title>Gorilla FFA</title>`.

---

## Verification

- TypeScript/Vite production build (`vite build`) **passes** today because
  esbuild strips types — the 12+ `tsc --noEmit` errors are silently ignored.
  Fix #24 to make CI catch these.
- Runtime manual physics testing remains browser-only and should cover: mantle
  at each platform corner, wall-jump/re-grab cooldown, void fall while holding,
  dummy void fall while held, full throw charge UI, slam near a tier edge,
  **and new for this audit**: round-reset health pip for a Big Gorilla, remote
  avatar smoothness across two clients booted at different times (test for
  #4), Domain Expansion projectiles (test for #36), and a multi-round Vercel
  match (test for #11).

## Recommended fix order

The cheapest high-impact wins, in order:

1. **#1, #2** (Game.dispose + onResize) — unblocks all subsequent testing;
   without these, every session leaks.
2. **#3** (manuallyClosed) — reconnect literally doesn't work today.
3. **#4** (clock domain) — remotes don't actually interpolate today.
4. **#6** (Arena return) — jungle content is entirely absent.
5. **#7** (double cooldown tick) — DPS is doubled today.
6. **#8, #9, #10, #11** — Vercel multi-instance + reconnect + match length.
   These four together determine whether a real 8-player match can finish on
   Vercel.
7. **#24** (tsc in build) — makes every future fix verifiable.
