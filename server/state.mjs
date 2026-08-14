// Shared room state for Gorilla FFA.
//
// Default is an in-memory store (local dev / LAN / single instance). When
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set — e.g. on Vercel —
// a REST-backed store is returned instead, letting different Function
// instances participate in the same room via a room-outbox event feed.
//
// Poses never hit Redis. Only room rosters, health, KOs, upgrades, phases,
// grabs and combat verbs do.

const memoryImpl = {
  async saveRoom(code, room) {
    this._rooms = this._rooms || new Map()
    this._rooms.set(code, JSON.parse(JSON.stringify(publicRoom(room))))
  },
  async loadRoom(code) {
    const j = this._rooms?.get(code)
    return j ? JSON.parse(JSON.stringify(j)) : null
  },
  async deleteRoom(code) {
    this._rooms?.delete(code)
    this._inst?.delete(code)
    this._obx?.delete(code)
    if (this._cursor) {
      for (const k of [...this._cursor.keys()]) {
        if (k.startsWith(code + ':') || k === code) this._cursor.delete(k)
      }
    }
  },
  async joinInstance(code, iid) {
    this._inst = this._inst || new Map()
    const s = this._inst.get(code) || new Set()
    s.add(iid)
    this._inst.set(code, s)
  },
  async leaveInstance(code, iid) {
    this._inst?.get(code)?.delete(iid)
  },
  heartbeatInstance: async () => {},
  async instanceCount(code) {
    return this._inst?.get(code)?.size || 0
  },
  async appendEvent(code, ev) {
    this._obx = this._obx || new Map()
    const a = this._obx.get(code) || []
    a.push(ev)
    if (a.length > 256) a.splice(0, a.length - 256)
    this._obx.set(code, a)
  },
  async pollEvents(code, cursorKey) {
    this._cursor = this._cursor || new Map()
    const a = this._obx?.get(code) || []
    const c = this._cursor.get(cursorKey) || 0
    const events = a.slice(c)
    return { events, next: a.length }
  },
  advanceCursor(cursorKey, n) {
    this._cursor.set(cursorKey, n)
  },
}

let redisClient = null

async function redis() {
  if (redisClient) return redisClient
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('redis env vars missing')
  const mod = await import('@upstash/redis')
  redisClient = new mod.Redis({ url, token })
  return redisClient
}

const ROOM_TTL_S = 60 * 60 * 6
const rKey = (code) => `gffa:room:${code}`
const instKey = (code) => `gffa:insts:${code}`
const instTTLKey = (code, iid) => `gffa:inst:${code}:${iid}`
const obxKey = (code) => `gffa:obx:${code}`
const cursorKey = (code, iid) => `gffa:cur:${code}:${iid}`

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    endsAt: room.endsAt,
    winner: room.winner ?? null,
    koCounter: room.koCounter,
    grabs: [...room.grabs.entries()],
    // Parallel map for the grab auto-escape sweep (grabber id -> start ms).
    grabStartAt: [...(room.grabStartAt?.entries() || [])],
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      tint: p.tint,
      hp: p.hp,
      // Recompute from upgrades so big_gorilla persists the right ceiling
      // even if the cached p.maxHp field was stale at grant time.
      maxHp: p.upgrades.includes('big_gorilla') ? 300 : 100,
      ko: p.ko,
      koOrder: p.koOrder,
      ready: p.ready,
      wins: p.wins,
      kos: p.kos,
      dealt: p.dealt,
      upgrades: p.upgrades,
      online: p.online,
      offer: p.offer,
      spawned: p.spawned,
      // Domain buff window must survive cross-instance sync and rejoin.
      domainUntil: p.domainUntil || 0,
      lastDomain: p.lastDomain || 0,
      secret: p.secret,
    })),
  }
}

const redisImpl = {
  async saveRoom(code, room) {
    const r = await redis()
    await r.set(rKey(code), publicRoom(room), { ex: ROOM_TTL_S })
  },
  async loadRoom(code) {
    const r = await redis()
    return (await r.get(rKey(code))) || null
  },
  async deleteRoom(code) {
    const r = await redis()
    await Promise.all([r.del(rKey(code)), r.del(obxKey(code)), r.del(instKey(code))])
  },
  async joinInstance(code, iid) {
    const r = await redis()
    await r.sadd(instKey(code), iid)
    await r.expire(instKey(code), ROOM_TTL_S)
    await r.set(instTTLKey(code, iid), 1, { ex: 8 })
  },
  async leaveInstance(code, iid) {
    const r = await redis()
    await r.srem(instKey(code), iid)
    await r.del(instTTLKey(code, iid))
  },
  async heartbeatInstance(code, iid) {
    const r = await redis()
    await r.set(instTTLKey(code, iid), 1, { ex: 8 })
  },
  async instanceCount(code) {
    const r = await redis()
    // Only count instances with a live heartbeat key (TTL-driven).
    const members = await r.smembers(instKey(code))
    if (!members.length) return 0
    const checks = await Promise.all(members.map((m) => r.get(instTTLKey(code, m))))
    return checks.filter((v) => v != null).length
  },
  async appendEvent(code, ev) {
    const r = await redis()
    await r.rpush(obxKey(code), JSON.stringify(ev))
    await r.ltrim(obxKey(code), -256, -1)
    await r.expire(obxKey(code), ROOM_TTL_S)
  },
  async pollEvents(code, curKey) {
    const r = await redis()
    const at = Number(await r.get(cursorKeyFor(curKey))) || 0
    const len = await r.llen(obxKey(code))
    if (len <= at) return { events: [], next: at }
    const start = Math.max(at, len - 256)
    const raw = await r.lrange(obxKey(code), start, -1)
    return { events: raw.map((j) => (typeof j === 'string' ? JSON.parse(j) : j)), next: len }
  },
  async advanceCursor(curKey, n) {
    const r = await redis()
    await r.set(cursorKeyFor(curKey), n, { ex: ROOM_TTL_S })
  },
}

const cursorKeyFor = (k) => k

export function makeStore() {
  const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  return useRedis ? { ...redisImpl, shared: true } : { ...memoryImpl, shared: false }
}
