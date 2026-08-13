# Phase 4 — networking notes

## Design

This is a 5–8 friend arena, not a competitive shooter. The expensive part of
the game is the local ragdoll (joints, gait, climb spring). Replicating that
authoritatively for eight bodies would add a full frame of input delay and a
much heavier server.

So:

1. **You own your gorilla.** Movement, climb, jump, and your own flopping
   ragdoll run locally at 60 Hz, exactly like practice mode.
2. **Everyone else is a ghost.** 20 Hz pose snapshots (torso + 4 limbs),
   interpolated 90 ms behind. Limbs still read as floppy because the *owner*
   simulated them.
3. **The server is a referee, not a physics engine.** Punch / grab / slam /
   throw are proposed by the attacker. The server checks “same room, in
   range, cooldown, grab pair exists” and broadcasts the result. The **victim
   applies the impulse on their own sim**, then their next poses show the
   tumble to everyone else.

A punch therefore feels instant on the attacker (local VFX) and arrives on
the victim in one RTT — fine for a comedy brawler.

Grabs do not use a shared Cannon constraint (those do not survive two
worlds). The grabber pins the remote mesh in front of them; the victim is
sprung toward the grabber’s last pose until slam/throw/release.

## Practice mode

The menu **Practice Solo** still boots the original dummy-filled arena with
zero networking.

## Run

```
# terminal 1
cd server && npm install && npm start

# terminal 2
npm run dev
```

Create a room, send friends `http://<your-lan-ip>:5173/?room=ABCD`.
They must reach `ws://<your-lan-ip>:8787` — set `?ws=` if needed.

## Phase 5 — health, rounds, upgrades

The split widened slightly, because "did I survive?" is exactly the kind of
question a client must not answer for itself:

| Owned by | What |
| --- | --- |
| **Server** | health, damage, knockouts, round phase/timer, win + KO tallies, which players get an upgrade offer, and which upgrade they actually receive |
| **Client** | its own ragdoll, all knockback, fall-distance measurement, projectile flight, local VFX |

Damage flows through the same validated combat events as Phase 4. When the
server accepts a `punch` / `slam` / `throw` / `ranged`, it subtracts health
itself and broadcasts `health` + (if it hits 0) `ko`. Fall damage is the one
number the client reports (`falldmg`) since only the owner simulates the
fall — it's clamped server-side, and falling out of the world sends `void`,
which is an unconditional KO.

Round loop: `lobby → countdown → active → ended → upgrading → countdown …`

Upgrades are granted by the server and broadcast to everyone, so each client
can rebuild any player's modifier bag with `modsFor(ids)` — that's how a Big
Gorilla looks 3x on every screen and how victims know to scale the knockback
an attacker deals. Exclusivity (Big/Tiny, Banana/Laser) is enforced from the
`exclusiveGroup` data on both sides.

Practice mode has no rounds, no health drain, and no upgrades — it's still
the clean single-player physics sandbox.
