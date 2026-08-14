// Gorilla FFA — transport-agnostic room engine (local server + Vercel fn).
//
// Owns: rooms, roster, rounds, combat validation, upgrade offers.
// High-frequency pose relays stay in-memory on each instance; every
// authoritative mutation also lands in the shared store + room outbox so a
// second Vercel instance serving other sockets of the room converges.

import { sanitizeMessage, parseRaw, RateLimiter } from './message.mjs'
import { randomUUID } from 'crypto'

const MAX = 8
const PUNCH_RANGE = 3.6
const GRAB_RANGE = 3.4
// Server-side ranged tolerance: at least the longest-range projectile's full
// travel distance (banana speed*life ≈ 75) so legit long-range hits register.
const RANGED_RANGE = 34
const BANANA_RANGE = 80
const HIT_COOLDOWN = 480 // mirrors src/game/constants.ts PUNCH.cooldown
const BANANA_COOLDOWN = 700 // mirrors BANANA.cooldown
const LASER_COOLDOWN = 80
const OFFLINE_GRACE_MS = 25_000
const IDLE_ROOM_S = 45

// Mirrors src/game/constants.ts — keep in sync on tuning changes.
const MAX_HP = 100
const FALL_MAX_DAMAGE = 60
const DMG = { punch: 8, slam: 26, throwBase: 14, throwCharged: 16, banana: 14, laser: 6 }
const ROUND = { duration: 150, countdown: 5, upgradeTime: 25, endScreenTime: 5, minPlayers: 2, idleLobbyLimit: 3.5 }
const DOMAIN = { duration: 15_000, cooldown: 18_000, buffDamage: 1.6, buffResist: 0.6 } // mirrors src/game/constants.ts
const SIZE_GROUP = { big_gorilla: 'size', tiny_gorilla: 'size', banana_gun: 'ranged', laser_eyes: 'ranged' }
const ALL_UPGRADES = ['feather_fists', 'big_gorilla', 'tiny_gorilla', 'bouncy_boy', 'flight', 'banana_gun', 'laser_eyes', 'domain_expansion']
const TINTS = [0x3b3b41, 0x5b4636, 0x46464c, 0x6a5a36, 0x3d4a38, 0x4a3a4c, 0x5a4030, 0x2f3f4a]
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function createEngine(store, { instanceId }) {
  const rooms = new Map() // code -> live room (players map has objects with ws)
  const sockets = new WeakMap() // playerObj -> ws
  let nextId = 1

  function send(p, msg) {
    p.sendWs?.(msg)
  }

  function broadcast(room, msg, exceptId = null) {
    for (const p of room.players.values()) {
      if (p.id === exceptId || !p.online) continue
      send(p, msg)
    }
  }

  /** Local broadcast + publish to shared room (for other instances). */
  function emitAll(room, eventFactory, exceptId = null) {
    const msg = eventFactory()
    broadcast(room, msg, exceptId)
    if (store.shared) void publish(room, msg)
  }

  async function publish(room, msg) {
    try {
      await store.saveRoom(room.code, room)
    } catch {}
    try {
      await store.appendEvent(room.code, { from: instanceId, msg })
    } catch {}
  }

  function newCode() {
    let s = ''
    for (let i = 0; i < 4; i++) s += ABC[Math.floor(Math.random() * ABC.length)]
    return rooms.has(s) ? newCode() : s
  }

  const pub = (p) => ({
    id: p.id,
    name: p.name,
    tint: p.tint,
    hp: p.hp,
    maxHp: maxHp(p),
    ko: p.ko,
    ready: p.ready,
    wins: p.wins,
    kos: p.kos,
    dealt: p.dealt,
    upgrades: p.upgrades,
    online: p.online,
    // Exposed so remote clients can fold DOMAIN.buffKnock/buffResist into
    // their own knockback calc (only the owner simulates the actual launch).
    domainUntil: p.domainUntil || 0,
  })

  function maxHp(p) {
    return p.upgrades.includes('big_gorilla') ? MAX_HP * 3 : MAX_HP
  }
  function forceMul(p) {
    let m = 1
    if (p.upgrades.includes('big_gorilla')) m *= 3
    if (p.upgrades.includes('tiny_gorilla')) m /= 3
    return m
  }
  function bodyScale(p) {
    if (p.upgrades.includes('big_gorilla')) return 3
    if (p.upgrades.includes('tiny_gorilla')) return 0.42
    return 1
  }
  function dist(a, b) {
    if (!a || !b) return 999
    return Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2])
  }

  function setPhase(room, phase, seconds) {
    room.phase = phase
    room.endsAt = Date.now() + seconds * 1000
    emitAll(room, () => ({ type: 'phase', phase, endsAt: room.endsAt, now: Date.now() }))
  }

  function applyDamage(room, victim, amount, attacker) {
    if (room.phase !== 'active' || victim.ko || amount <= 0) return
    // Domain Expansion: the caster deals more, and takes less, while active.
    const now = Date.now()
    if (attacker && attacker.domainUntil > now) amount *= DOMAIN.buffDamage
    if (victim.domainUntil > now) amount *= DOMAIN.buffResist
    amount = Math.max(1, Math.round(amount))
    victim.hp = Math.max(0, victim.hp - amount)
    if (attacker && attacker !== victim) attacker.dealt += amount
    emitAll(room, () => ({ type: 'health', id: victim.id, hp: victim.hp, maxHp: maxHp(victim), dealt: victim.dealt }))
    if (attacker && attacker !== victim) {
      broadcast(room, { type: 'health', id: attacker.id, hp: attacker.hp, maxHp: maxHp(attacker), dealt: attacker.dealt })
    }
    if (victim.hp <= 0) knockOut(room, victim, attacker)
  }

  function knockOut(room, victim, attacker) {
    if (victim.ko) return
    victim.ko = true
    victim.hp = 0
    victim.koOrder = ++room.koCounter
    if (attacker && attacker !== victim) attacker.kos += 1
    // A KO breaks any grab the victim is part of (as grabber or grabbed).
    // Without this, a KO'd grabber server-side-pins the victim for the
    // remainder of the round because nothing else clears room.grabs.
    if (room.grabs.has(victim.id)) {
      const to = room.grabs.get(victim.id)
      room.grabs.delete(victim.id)
      broadcast(room, { type: 'released', from: victim.id, to })
    }
    for (const [from, to] of [...room.grabs.entries()]) {
      if (to === victim.id) {
        room.grabs.delete(from)
        broadcast(room, { type: 'released', from, to })
      }
    }
    emitAll(room, () => ({ type: 'ko', id: victim.id, by: attacker ? attacker.id : null }))
    checkRoundOver(room)
  }

  function checkRoundOver(room) {
    if (room.phase !== 'active') return
    const alive = [...room.players.values()].filter((p) => !p.ko && p.online)
    if (alive.length <= 1 && onlineCount(room) >= ROUND.minPlayers) endRound(room)
  }

  function endRound(room) {
    const players = [...room.players.values()]
    const alive = players.filter((p) => !p.ko && p.online)
    let winner = null
    if (alive.length === 1) winner = alive[0]
    else if (alive.length > 1) winner = alive.slice().sort((a, b) => b.hp - a.hp || b.dealt - a.dealt)[0]
    if (winner) winner.wins += 1
    room.winner = winner ? winner.id : null
    const target = room.matchTarget || 3
    // Check match victory: if a player has reached the target wins, end the
    // match instead of continuing to the upgrade phase.
    if (winner && winner.wins >= target) {
      room.matchWinner = winner.id
      emitAll(room, () => ({
        type: 'matchEnd',
        winner: winner.id,
        standings: players.map((p) => ({ id: p.id, wins: p.wins, kos: p.kos, dealt: p.dealt })),
      }))
      setPhase(room, 'ended', ROUND.endScreenTime + 5)
      // After the banner, reset all wins and collapse to lobby for a new match.
      setTimeout(() => {
        for (const p of room.players.values()) {
          p.wins = 0
          p.kos = 0
          p.dealt = 0
          p.upgrades = []
          p.maxHp = MAX_HP
          p.ko = false
          p.ready = false
        }
        room.matchWinner = null
        collapseToLobby(room)
      }, (ROUND.endScreenTime + 5) * 1000)
      return
    }
    emitAll(room, () => ({
      type: 'roundEnd',
      winner: room.winner,
      standings: players.map((p) => ({ id: p.id, hp: p.hp, dealt: p.dealt })),
    }))
    setPhase(room, 'ended', ROUND.endScreenTime)
  }

  function startUpgradePhase(room) {
    // If a match just ended, don't start upgrades — the matchEnd timer will
    // collapse to lobby.
    if (room.matchWinner) return
    const players = [...room.players.values()].filter((p) => p.online)
    if (players.length === 0) return (room.phase = 'lobby')
    // Fewer than the minimum player count left → dissolve back to lobby
    // instead of looping a single solo player through endless upgrade offers.
    if (players.length < ROUND.minPlayers) return collapseToLobby(room)
    const ranked = players.slice().sort((a, b) => {
      if (a.ko !== b.ko) return a.ko ? -1 : 1
      if (a.ko && b.ko) return a.koOrder - b.koOrder
      return a.hp - b.hp || a.dealt - b.dealt
    })
    const losers = ranked.slice(0, Math.max(1, Math.floor(players.length / 3)))
    room.pending = new Set()
    for (const p of losers) {
      const pool = masterRoll(p)
      if (!pool.length) continue
      p.offer = pool
      room.pending.add(p.id)
      send(p, { type: 'offer', options: pool })
    }
    if (room.pending.size === 0) return beginCountdown(room)
    setPhase(room, 'upgrading', ROUND.upgradeTime)
  }

  function masterRoll(p) {
    const owned = new Set(p.upgrades)
    const taken = new Set(p.upgrades.map((u) => SIZE_GROUP[u]).filter(Boolean))
    const pool = ALL_UPGRADES.filter((u) => !owned.has(u) && !(SIZE_GROUP[u] && taken.has(SIZE_GROUP[u])))
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    return pool.slice(0, Math.min(3, pool.length))
  }

  function finishUpgrades(room) {
    for (const id of [...(room.pending || new Set())]) {
      const p = room.players.get(id)
      if (p?.offer?.length) grantUpgrade(room, p, p.offer[0])
    }
    beginCountdown(room)
  }

  function grantUpgrade(room, p, upgradeId) {
    if (!p.offer || !p.offer.includes(upgradeId)) return
    p.upgrades.push(upgradeId)
    // Refresh the cached ceiling so subsequent health broadcasts and the
    // shared-room snapshot agree with maxHp(p). Without this, a big_gorilla
    // pick leaves p.maxHp at 100 while p.hp gets set to 300 next round.
    p.maxHp = maxHp(p)
    p.offer = null
    room.pending?.delete(p.id)
    emitAll(room, () => ({ type: 'granted', id: p.id, upgrade: upgradeId, upgrades: p.upgrades }))
    if (room.pending?.size === 0 && room.phase === 'upgrading') beginCountdown(room)
  }

  function beginCountdown(room) {
    room.grabs.clear()
    room.koCounter = 0
    for (const p of room.players.values()) {
      p.hp = maxHp(p)
      // Keep the cached field in sync; some reads (e.g. shared-room snapshot
      // via the stale p.maxHp path) still consult it directly.
      p.maxHp = maxHp(p)
      p.ko = false
      p.dealt = 0
      p.koOrder = 0
      p.offer = null
      broadcast(room, { type: 'health', id: p.id, hp: p.hp, maxHp: maxHp(p), dealt: 0 })
    }
    if (store.shared) void publish(room, { type: 'reset' })
    setPhase(room, 'countdown', ROUND.countdown)
  }

  function maybeStart(room) {
    if (room.phase !== 'lobby') return
    const ps = [...room.players.values()].filter((p) => p.online)
    if (ps.length >= ROUND.minPlayers && ps.every((p) => p.ready)) beginCountdown(room)
  }

  /** Fetch a room that lives in the shared store but not on this instance. */
  async function hydrateRoom(code) {
    if (!store.shared) return null
    let data = null
    try {
      data = await store.loadRoom(code)
    } catch {
      return null
    }
    if (!data || !Array.isArray(data.players)) return null
    const room = {
      code,
      players: new Map(),
      grabs: new Map(data.grabs || []),
      phase: data.phase || 'lobby',
      endsAt: data.endsAt || 0,
      winner: data.winner ?? null,
      koCounter: data.koCounter || 0,
      pending: new Set(),
      idleSince: null,
    }
    for (const sp of data.players) {
      room.players.set(sp.id, {
        id: sp.id,
        name: sp.name || 'Ape',
        tint: sp.tint ?? TINTS[0],
        room, // back-reference so markGone/finalizeLeave find the room after a rejoin
        ws: null,
        pose: null,
        lastHit: 0,
        lastRanged: 0,
        lastMsgAt: 0,
        spawned: new Map(),
        hp: sp.hp ?? MAX_HP,
        maxHp: sp.maxHp ?? MAX_HP,
        ko: !!sp.ko,
        koOrder: sp.koOrder || 0,
        ready: !!sp.ready,
        wins: sp.wins || 0,
        kos: sp.kos || 0,
        dealt: sp.dealt || 0,
        upgrades: Array.isArray(sp.upgrades) ? sp.upgrades : [],
        offer: sp.offer ?? null,
        online: false,
        offlineTimer: null,
        sendWs: null,
        domainUntil: sp.domainUntil || 0,
        lastDomain: sp.lastDomain || 0,
        secret: sp.secret || randomUUID(),
      })
    }
    rooms.set(code, room)
    return room
  }

  function onlineCount(room) {
    let n = 0
    for (const p of room.players.values()) if (p.online) n++
    return n
  }

  /** Room no longer has enough live players to sustain a round → lobby reset. */
  function collapseToLobby(room) {
    if (room.phase === 'lobby') return
    room.pending?.clear()
    for (const p of room.players.values()) {
      p.ko = false
      p.koOrder = 0
      p.hp = maxHp(p)
      p.dealt = 0
      p.ready = false
      p.offer = null
    }
    room.grabs.clear()
    room.winner = null
    setPhase(room, 'lobby', 0)
    room.endsAt = 0
    if (store.shared) void publish(room, { type: 'reset' })
  }

  function markGone(player) {
    const room = player.room
    if (!room) return
    player.online = false
    player.sendWs = null
    limiters.delete(player)
    player.offlineTimer = setTimeout(() => finalizeLeave(player), OFFLINE_GRACE_MS)
  }

  function finalizeLeave(player) {
    const room = player.room
    if (!room || player.online) return
    clearTimeout(player.offlineTimer)
    if (room.grabs.has(player.id)) {
      const to = room.grabs.get(player.id)
      room.grabs.delete(player.id)
      broadcast(room, { type: 'released', from: player.id, to })
    }
    for (const [from, to] of [...room.grabs.entries()]) {
      if (to === player.id) {
        room.grabs.delete(from)
        broadcast(room, { type: 'released', from, to })
      }
    }
    room.players.delete(player.id)
    room.pending?.delete(player.id)
    player.room = null
    emitAll(room, () => ({ type: 'left', id: player.id }))

    if (room.players.size === 0) {
      rooms.delete(room.code)
      if (store.shared) void store.deleteRoom(room.code).catch(() => {})
      return
    }
    if (onlineCount(room) === 0) {
      room.idleSince ??= Date.now()
      if (store.shared) void store.leaveInstance(room.code, instanceId).catch(() => {})
    }
    // Fewer than 2 online players → round must not continue.
    if (onlineCount(room) < ROUND.minPlayers) collapseToLobby(room)
    else checkRoundOver(room)
  }

  const limiters = new WeakMap()

  function newPlayerSocket() {
    const p = {
      id: 'p' + nextId++,
      name: 'Ape',
      tint: TINTS[0],
      room: null,
      pose: null,
      lastHit: 0,
      lastRanged: 0,
      lastMsgAt: Date.now(),
      spawned: new Map(), // banana spawnId -> expiresAt
      hp: MAX_HP,
      ko: false,
      koOrder: 0,
      ready: false,
      wins: 0,
      kos: 0,
      dealt: 0,
      upgrades: [],
      offer: null,
      online: true,
      offlineTimer: null,
      sendWs: null,
      domainUntil: 0,
      lastDomain: 0,
      // Per-session secret required on rejoin so an attacker can't claim an
      // offline player's sequential id during the 25s grace window.
      secret: randomUUID(),
    }
    limiters.set(p, new RateLimiter())
    return p
  }

  async function handleRaw(player, rawText) {
    const lim = limiters.get(player)
    if (!lim) return
    const parsed = parseRaw(rawText)
    if (parsed == null) {
      if (!lim.markBad()) player.closeWs?.(1008, 'malformed')
      return
    }
    const msg = sanitizeMessage(parsed, player.pose)
    if (!msg) {
      if (!lim.markBad()) player.closeWs?.(1008, 'invalid')
      return
    }
    if (!lim.tick(msg)) return player.closeWs?.(1008, 'rate limit')
    const room = player.room

    if (msg.type === 'create' || msg.type === 'join' || msg.type === 'rejoin') {
      if (player.room) return
      player.name = msg.name
      let r
      if (msg.type === 'create') {
        r = {
          code: newCode(),
          players: new Map(),
          grabs: new Map(),
          phase: 'lobby',
          endsAt: 0,
          winner: null,
          koCounter: 0,
          pending: new Set(),
          idleSince: null,
          matchTarget: Math.max(1, Math.min(10, msg.matchTarget || 3)),
          matchWinner: null,
        }
        rooms.set(r.code, r)
      } else if (msg.type === 'rejoin') {
        r = rooms.get(msg.room) || (await hydrateRoom(msg.room))
        const prev = r?.players.get(msg.id)
        // prev.online acts as a mutex: flip it synchronously here (before any
        // subsequent await) so a second concurrent rejoin for the same id
        // sees the player as online and is rejected.
        if (!r || !prev || prev.online) {
          return void send(player, { type: 'error', message: 'Session expired' })
        }
        prev.online = true
        // Verify the per-session secret so an attacker can't claim an offline
        // player's id during the 25s grace window. The client stored the
        // secret alongside the session in localStorage.
        if (!msg.secret || msg.secret !== prev.secret) {
          prev.online = false
          return void send(player, { type: 'error', message: 'Session expired' })
        }
        // Session resume: carry identity + authoritative state onto the fresh
        // connection record, then swap it in for the offline one.
        clearTimeout(prev.offlineTimer)
        player.id = prev.id
        player.tint = prev.tint
        player.hp = prev.hp
        player.maxHp = prev.maxHp
        player.ko = prev.ko
        player.koOrder = prev.koOrder
        player.ready = prev.ready
        player.wins = prev.wins
        player.kos = prev.kos
        player.dealt = prev.dealt
        player.upgrades = prev.upgrades
        player.offer = prev.offer
        player.pose = prev.pose
        player.domainUntil = prev.domainUntil
        player.lastDomain = prev.lastDomain || 0
        player.secret = prev.secret
        player.room = r
        r.players.delete(prev.id)
        r.players.set(player.id, player)
        send(player, {
          type: 'welcome',
          id: player.id,
          room: r.code,
          players: [...r.players.values()].map(pub),
          phase: r.phase,
          secret: player.secret,
          matchTarget: r.matchTarget || 3,
        })
        send(player, { type: 'phase', phase: r.phase, endsAt: r.endsAt, now: Date.now() })
        if (player.offer) send(player, { type: 'offer', options: player.offer })
        emitAll(r, () => ({ type: 'joined', player: pub(player) }), player.id)
        if (store.shared) void store.joinInstance(r.code, instanceId).catch(() => {})
        return
      } else {
        r = rooms.get(msg.room) || (await hydrateRoom(msg.room))
        if (!r) return void send(player, { type: 'error', message: 'Room not found' })
        if (r.players.size >= MAX) return void send(player, { type: 'error', message: 'Room is full (8)' })
      }
      player.tint = TINTS[[...r.players.values()].filter((p) => p.online).length % TINTS.length]
      player.room = r
      player.ko = r.phase === 'active' // joined mid-round: spectate as KO
      hpInit(player)
      r.players.set(player.id, player)
      r.idleSince = null
      send(player, {
        type: 'welcome',
        id: player.id,
        room: r.code,
        players: [...r.players.values()].map(pub),
        phase: r.phase,
        secret: player.secret,
        matchTarget: r.matchTarget || 3,
      })
      send(player, { type: 'phase', phase: r.phase, endsAt: r.endsAt, now: Date.now() })
      emitAll(r, () => ({ type: 'joined', player: pub(player) }), player.id)
      if (store.shared) void store.joinInstance(r.code, instanceId).catch(() => {})
      return
    }

    if (!room) return
    playerLastSeen(player)

    switch (msg.type) {
      case 'pose': {
        player.pose = msg
        msg.id = player.id
        broadcast(room, msg, player.id)
        return
      }
      // combat below — shooter is excluded from its own verb echo, since the
      // client already rendered local prediction (Game handles the net copy).
      case 'ready': {
        player.ready = !!msg.value
        emitAll(room, () => ({ type: 'ready', id: player.id, value: player.ready }))
        maybeStart(room)
        return
      }
      case 'punch': {
        if (player.ko || room.phase !== 'active') return
        const now = Date.now()
        if (now - player.lastHit < HIT_COOLDOWN) return
        const t = room.players.get(msg.target)
        if (!t || t === player || t.ko) return
        // +1.5 tolerance: client sees remotes 90ms in the past, so the
        // positions the client used to decide "in range" are slightly stale.
        if (dist(player.pose, t.pose) > PUNCH_RANGE * bodyScale(player) + 0.7 * bodyScale(t) + 1.5) return
        player.lastHit = now
        emitAll(room, () => ({ type: 'punched', from: player.id, to: t.id, dir: msg.dir }), player.id)
        applyDamage(room, t, DMG.punch, player)
        return
      }
      case 'grab': {
        if (player.ko || room.phase !== 'active') return
        const t = room.players.get(msg.target)
        if (!t || t === player || t.ko) return
        if (room.grabs.has(player.id)) return
        for (const to of room.grabs.values()) if (to === t.id) return
        // +1.5 tolerance: same interpolation lag rationale as punch.
        if (dist(player.pose, t.pose) > GRAB_RANGE * bodyScale(player) + 0.7 * bodyScale(t) + 1.5) return
        room.grabs.set(player.id, t.id)
        emitAll(room, () => ({ type: 'grabbed', from: player.id, to: t.id }))
        return
      }
      case 'release': {
        const to = room.grabs.get(player.id)
        if (!to) return
        room.grabs.delete(player.id)
        emitAll(room, () => ({ type: 'released', from: player.id, to }))
        return
      }
      case 'slam':
      case 'throw': {
        // Same authority guard every other combat verb enforces. Without it,
        // a KO'd or out-of-round grabber could still slam, broadcasting the
        // verb (and even applying damage if applyDamage's phase gate misses).
        if (player.ko || room.phase !== 'active') return
        const toId = room.grabs.get(player.id)
        if (!toId) return
        room.grabs.delete(player.id)
        const victim = room.players.get(toId)
        const mul = forceMul(player)
        if (msg.type === 'slam') {
          emitAll(room, () => ({ type: 'slammed', from: player.id, to: toId, dir: msg.dir }))
          if (victim) applyDamage(room, victim, DMG.slam * mul, player)
        } else {
          emitAll(room, () => ({ type: 'thrown', from: player.id, to: toId, dir: msg.dir, charge: msg.charge }))
          if (victim) applyDamage(room, victim, (DMG.throwBase + DMG.throwCharged * msg.charge) * mul, player)
        }
        return
      }
      case 'ranged': {
        if (player.ko || room.phase !== 'active') return
        const now = Date.now()
        // Cap stored banana spawns so the map can't grow without bound.
        if (player.spawned.size > 64) player.spawned.clear()
        if (msg.impact) {
          // Banana impact: one hit per spawn, spawn must exist + be ours.
          const exp = player.spawned.get(msg.impact)
          player.spawned.delete(msg.impact)
          if (!exp || exp < now) return
          const t = room.players.get(msg.target)
          if (!t || t === player || t.ko) return
          // Bananas travel up to ~75 units client-side; the old tolerance
          // (RANGED_RANGE+6=40) rejected legit long-range hits.
          if (dist(player.pose, t.pose) > BANANA_RANGE) return
          emitAll(room, () => ({ type: 'ranged', kind: 'banana', from: player.id, dir: [0, 0, 0], hit: t.id }), player.id)
          applyDamage(room, t, DMG.banana * forceMul(player), player)
          return
        }
        // Spawn/new bullet (or laser shot) is rate limited.
        const cd = msg.kind === 'laser' ? LASER_COOLDOWN : BANANA_COOLDOWN
        if (now - player.lastRanged < cd) return
        const needed = msg.kind === 'laser' ? 'laser_eyes' : 'banana_gun'
        if (!player.upgrades.includes(needed)) return
        player.lastRanged = now
        if (msg.kind === 'laser') {
          const t = msg.target ? room.players.get(msg.target) : null
          if (!msg.target) {
            emitAll(room, () => ({ type: 'ranged', kind: 'laser', from: player.id, dir: msg.dir, hit: null }))
            return
          }
          if (!t || t === player || t.ko) return
          if (dist(player.pose, t.pose) > RANGED_RANGE) return
          emitAll(room, () => ({ type: 'ranged', kind: 'laser', from: player.id, dir: msg.dir, hit: t.id }), player.id)
          applyDamage(room, t, DMG.laser * forceMul(player), player)
          return
        }
        // Banana spawn: the client supplies a unique spawn id; impacts may
        // reference it exactly once (per-spawn damage, no spam).
        player.spawned.set(msg.spawn, now + 4000)
        emitAll(room, () => ({ type: 'ranged', kind: 'banana', from: player.id, dir: msg.dir, hit: null }), player.id)
        return
      }
      case 'falldmg':
        // Bouncy Boy clientside multiplies fall damage by 0; enforce the same
        // serverside so a modified client can't bill itself fall damage to
        // suicide-deny an attacker's KO credit.
        if (player.upgrades.includes('bouncy_boy')) return
        applyDamage(room, player, Math.min(msg.amount, FALL_MAX_DAMAGE), null)
        return
      case 'void':
        if (room.phase === 'active') knockOut(room, player, null)
        return
      case 'trigger': {
        // F-key ability: Domain Expansion. Buff the caster for its duration.
        if (player.ko || room.phase !== 'active') return
        if (!player.upgrades.includes('domain_expansion')) return
        const now = Date.now()
        if (now - (player.lastDomain || 0) < DOMAIN.cooldown) return // server-side cooldown
        player.lastDomain = now
        player.domainUntil = now + DOMAIN.duration
        emitAll(room, () => ({ type: 'triggered', from: player.id, kind: 'domain' }))
        return
      }
      case 'pick':
        grantUpgrade(room, player, msg.upgrade)
        return
    }
  }

  function playerLastSeen(p) {
    p.lastMsgAt = Date.now()
  }

  function attach(ws, ip) {
    const player = newPlayerSocket()
    player.ip = ip || ''
    player.sendWs = (msg) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg))
    }
    player.closeWs = (...a) => ws.close(...a)
    ws.on('message', (d) => void handleRaw(player, d.toString('utf8')).catch(() => {}))
    ws.on('close', () => {
      if (player.room) markGone(player)
    })
    ws.on('error', () => {})
  }

  /** Outbox merge loop for shared (multi-instance) deployments. */
  async function pollShared() {
    if (!store.shared) return
    for (const room of rooms.values()) {
      try {
        await applySharedRoom(room)
        const { events, next } = await store.pollEvents(room.code, `${room.code}:${instanceId}`)
        await store.advanceCursor(`${room.code}:${instanceId}`, next)
        for (const ev of events) {
          if (ev.from === instanceId) continue
          applyShareEvent(room, ev.msg)
          // `reset` is an internal cross-instance sync signal — it has no
          // handler on the typed client and would just throw in dispatchers.
          if (ev.msg && ev.msg.type !== 'reset') broadcast(room, ev.msg)
        }
      } catch {}
    }
  }

  async function applySharedRoom(room) {
    const shared = await store.loadRoom(room.code)
    if (!shared?.players) return
    for (const sp of shared.players) {
      let p = room.players.get(sp.id)
      if (!p) {
        // Player exists on another instance but not yet on this one. Insert
        // a minimal placeholder so combat validation, distance checks and
        // round-over detection work for remote players too.
        p = {
          id: sp.id,
          name: sp.name || 'Ape',
          tint: sp.tint ?? TINTS[0],
          room,
          ws: null,
          pose: null,
          lastHit: 0,
          lastRanged: 0,
          lastMsgAt: 0,
          spawned: new Map(),
          hp: sp.hp ?? MAX_HP,
          maxHp: sp.maxHp ?? MAX_HP,
          ko: !!sp.ko,
          koOrder: sp.koOrder || 0,
          ready: !!sp.ready,
          wins: sp.wins || 0,
          kos: sp.kos || 0,
          dealt: sp.dealt || 0,
          upgrades: Array.isArray(sp.upgrades) ? sp.upgrades : [],
          offer: sp.offer ?? null,
          online: false,
          offlineTimer: null,
          sendWs: null,
          domainUntil: sp.domainUntil || 0,
          lastDomain: sp.lastDomain || 0,
          secret: sp.secret || null,
          remotePlaceholder: true, // not owned by this instance
        }
        room.players.set(sp.id, p)
      }
      p.hp = sp.hp
      p.maxHp = sp.maxHp
      p.ko = sp.ko
      p.upgrades = sp.upgrades
      p.ready = sp.ready
      p.wins = sp.wins
      p.kos = sp.kos
      p.dealt = sp.dealt
      // Sync online flag so checkRoundOver / onlineCount / collapseToLobby
      // agree across instances. We never flip our own locally-owned sockets
      // to offline here — only remote placeholders track the shared value.
      if (p.remotePlaceholder) p.online = !!sp.online
    }
    room.phase = shared.phase
    room.endsAt = shared.endsAt || room.endsAt
    room.grabs = new Map(shared.grabs || [])
  }

  function applyShareEvent(room, msg) {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'health': {
        const p = room.players.get(msg.id)
        if (p) {
          p.hp = msg.hp
          p.dealt = msg.dealt
          if (msg.maxHp) p.maxHp = msg.maxHp
        }
        return
      }
      case 'ko': {
        const p = room.players.get(msg.id)
        if (p) {
          p.ko = true
          p.hp = 0
        }
        return
      }
      case 'phase': {
        room.phase = msg.phase
        room.endsAt = msg.endsAt
        return
      }
      case 'reset':
        return collapseLocal(room)
      case 'left': {
        const p = room.players.get(msg.id)
        if (p && !p.online) room.players.delete(msg.id)
        return
      }
      case 'grabbed':
        room.grabs.set(msg.from, msg.to)
        return
      case 'released':
      case 'slammed':
      case 'thrown':
        room.grabs.delete(msg.from)
        return
    }
  }

  function collapseLocal(room) {
    for (const p of room.players.values()) {
      p.ko = false
      p.ready = false
      p.offer = null
      p.hp = maxHp(p)
      p.dealt = 0
    }
    room.phase = 'lobby'
    room.endsAt = 0
  }

  function hpInit(p) {
    p.maxHp = MAX_HP
  }

  // Global tick: phase timers + idle/offline cleanup. No setTimeout chains.
  setInterval(() => {
    const now = Date.now()
    for (const room of rooms.values()) {
      // Idle-empty room reclamation.
      if (onlineCount(room) === 0) {
        room.idleSince ??= now
        if (now - room.idleSince > IDLE_ROOM_S * 1000) {
          rooms.delete(room.code)
          if (store.shared) void store.deleteRoom(room.code).catch(() => {})
          continue
        }
      } else room.idleSince = null

      if (room.endsAt && now >= room.endsAt) {
        room.endsAt = 0
        if (room.phase === 'ended') startUpgradePhase(room)
        else if (room.phase === 'upgrading') finishUpgrades(room)
        else if (room.phase === 'countdown') setPhase(room, 'active', ROUND.duration)
        else if (room.phase === 'active') endRound(room)
      }
      if (store.shared) void store.heartbeatInstance(room.code, instanceId).catch(() => {})
    }
    if (store.shared && rooms.size) void pollShared().catch(() => {})
    // Off-screen disconnect grace cleanup handled by per-player timers.
  }, 250)

  return { attach, rooms, onlineCount }
}
