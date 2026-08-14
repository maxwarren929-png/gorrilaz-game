// Centralized wire validation + rate limiting for Gorilla FFA.
// Every inbound message passes through sanitizeMessage() before game logic
// sees it. Malformed input is rejected (never throws), vectors are clamped,
// and positions are confined to a generous arena bound.

const ARENA_BOUND = 40 // positions beyond this are clamped; arena is ±12
const MSG_MAX_BYTES = 6144
// Anti-teleport: cap per-pose displacement. Movement tops out around
// MOVEMENT.maxSpeed (~9 u/s sprint); a 20 Hz pose tick is 50 ms, so even a
// 3× sprint+knockback burst can't exceed ~1.5 u/tick. 4 is generous but
// actually catches macro-scale teleports (vs the old 35 which was bigger
// than the entire arena diagonal).
const POSE_MAX_DELTA = 4 // units per pose tick (anti speed/teleport abuse)

const isNum = (n) => typeof n === 'number' && Number.isFinite(n)

/** Validate + clamp a direction vector; result is unit-length or null. */
function dir3(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return null
  const [x, y, z] = v
  const len = Math.hypot(x, y, z)
  if (len < 1e-6) return null // reject zero vectors: knockback must have a real direction
  const s = 1 / len
  return [x * s, y * s, z * s]
}

/** Loose 3-vector for velocities/positions: clamp magnitude, no normalization. */
function vec3(v, clampLen = 1.5) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return null
  const [x, y, z] = v
  const len = Math.hypot(x, y, z)
  if (len > clampLen && len > 1e-6) {
    const s = clampLen / len
    return [x * s, y * s, z * s]
  }
  return [x, y, z]
}

function clampNum(n, min, max, fallback = 0) {
  if (!isNum(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function name0(v) {
  return String(v ?? 'Ape').slice(0, 16).replace(/[\n\r]/g, ' ').trim() || 'Ape'
}

function roomCode(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

/** Normalize a pose message. Positions/velocities are force-clamped. */
function sanPose(msg, prevPose) {
  const pOK = Array.isArray(msg.p) && msg.p.length === 3 && msg.p.every(isNum)
  const qOK = Array.isArray(msg.q) && msg.q.length === 4 && msg.q.every(isNum)
  const vOK = Array.isArray(msg.v) && msg.v.length === 3 && msg.v.every(isNum)
  const fOK = Array.isArray(msg.f) && msg.f.length === 2 && msg.f.every(isNum)
  const lOK = Array.isArray(msg.l) && msg.l.length === 28 && msg.l.every(isNum)
  if (!pOK || !qOK || !vOK || !fOK || !lOK || !isNum(msg.t) || !isNum(msg.s)) return null

  let [px, py, pz] = msg.p
  px = clampNum(px, -ARENA_BOUND, ARENA_BOUND)
  py = clampNum(py, -70, 130)
  pz = clampNum(pz, -ARENA_BOUND, ARENA_BOUND)

  // Anti-teleport: cap per-tick displacement relative to the previous pose.
  // Horizontal motion is always clamped (movement tops out well below
  // POSE_MAX_DELTA); vertical is exempt only below the void line so a legal
  // fall-into-void is never rejected but a cheater can't drift horizontally
  // while hiding under the floor.
  if (prevPose) {
    const dx = px - prevPose.p[0]
    const dz = pz - prevPose.p[2]
    const hd = Math.hypot(dx, dz)
    if (hd > POSE_MAX_DELTA) {
      const s = POSE_MAX_DELTA / hd
      px = prevPose.p[0] + dx * s
      pz = prevPose.p[2] + dz * s
    }
    if (py > -10) {
      const dy = py - prevPose.p[1]
      if (Math.abs(dy) > POSE_MAX_DELTA) {
        py = prevPose.p[1] + Math.sign(dy) * POSE_MAX_DELTA
      }
    }
  }

  const [vx, vy, vz] = msg.v
  const vlen = Math.hypot(vx, vy, vz)
  const vcap = vlen > 60 ? 60 / vlen : 1

  // Quaternion: clamp components then renormalize to unit length so a
  // peer can't ship a non-rotational [1,1,1,1] that renders garbage on
  // interpolated ghosts.
  let qx = clampNum(msg.q[0], -1, 1)
  let qy = clampNum(msg.q[1], -1, 1)
  let qz = clampNum(msg.q[2], -1, 1)
  let qw = clampNum(msg.q[3], -1, 1)
  const qlen = Math.hypot(qx, qy, qz, qw)
  if (qlen > 1e-6) {
    qx /= qlen
    qy /= qlen
    qz /= qlen
    qw /= qlen
  } else {
    qx = 0
    qy = 0
    qz = 0
    qw = 1
  }

  return {
    type: 'pose',
    id: '',
    t: clampNum(msg.t, 0, 1e9),
    p: [px, py, pz],
    q: [qx, qy, qz, qw],
    v: [vx * vcap, vy * vcap, vz * vcap],
    l: msg.l.map((n) => clampNum(n, -1e6, 1e6)),
    f: [clampNum(msg.f[0], -1, 1), clampNum(msg.f[1], -1, 1)],
    s: clampNum(msg.s, 0, 255) | 0,
  }
}

const ID_RE = /^[a-z0-9_-]{1,24}$/i
const target0 = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null)

/**
 * Returns {msg} on success, {error} on hard failure. `prevPose` may be null.
 * Anything not on the known list returns null → caller drops it quietly.
 */
export function sanitizeMessage(raw, prevPose = null) {
  if (raw == null || typeof raw !== 'object') return null
  const type = raw.type
  switch (type) {
    case 'create':
      return { type: 'create', name: name0(raw.name), matchTarget: clampNum(Number(raw.matchTarget), 1, 10) || 3 }
    case 'join':
      return { type: 'join', room: roomCode(raw.room), name: name0(raw.name) }
    case 'rejoin': {
      const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null
      // Secret is required — server cross-checks it against the prev session.
      const secret = typeof raw.secret === 'string' && raw.secret.length <= 64 ? raw.secret : null
      return id && secret ? { type: 'rejoin', room: roomCode(raw.room), name: name0(raw.name), id, secret } : null
    }
    case 'pose':
      return sanPose(raw, prevPose)
    case 'punch': {
      const target = target0(raw.target)
      const dir = dir3(raw.dir)
      return target && dir ? { type: 'punch', target, dir } : null
    }
    case 'grab': {
      const target = target0(raw.target)
      return target ? { type: 'grab', target } : null
    }
    case 'release':
      return { type: 'release' }
    case 'slam': {
      const dir = dir3(raw.dir)
      return dir ? { type: 'slam', dir } : null
    }
    case 'throw': {
      const dir = dir3(raw.dir)
      if (!dir) return null
      return { type: 'throw', dir, charge: clampNum(Number(raw.charge), 0, 1) }
    }
    case 'ready':
      return { type: 'ready', value: !!raw.value }
    case 'pick':
      return typeof raw.upgrade === 'string' && /^[a-z_]{2,20}$/.test(raw.upgrade)
        ? { type: 'pick', upgrade: raw.upgrade }
        : null
    case 'falldmg':
      // Client's FALL.maxDamage is 60; keep server the lower of the two so a
      // modified client can't inflate self-damage to deny an attacker's KO.
      // Bouncy Boy immunity is enforced in game.mjs (it sees upgrades).
      return { type: 'falldmg', amount: clampNum(Number(raw.amount), 0, 60) }
    case 'void':
      return { type: 'void' }
    case 'trigger':
      // Domain Expansion and future F-key abilities.
      return raw.kind === 'domain' ? { type: 'trigger', kind: 'domain' } : null
    case 'ranged': {
      const kind = raw.kind === 'laser' ? 'laser' : raw.kind === 'banana' ? 'banana' : null
      if (!kind) return null
      // `impact` carries a spawn id so one banana can only ever damage once.
      if (raw.impact) {
        const spawn = typeof raw.impact === 'string' && ID_RE.test(raw.impact) ? raw.impact : null
        const target = target0(raw.target)
        return spawn && target ? { type: 'ranged', kind: 'banana', impact: spawn, target } : null
      }
      if (kind === 'banana' && typeof raw.spawn === 'string' && ID_RE.test(raw.spawn)) {
        const dir = dir3(raw.dir)
        return dir ? { type: 'ranged', kind: 'banana', dir, spawn: raw.spawn } : null
      }
      const dir = dir3(raw.dir)
      if (!dir) return null
      if (kind === 'laser' && raw.target != null) {
        // A present-but-invalid target is a probe attempt — reject rather
        // than silently downgrade to a blind laser the client didn't send.
        const target = target0(raw.target)
        return target ? { type: 'ranged', kind: 'laser', dir, target } : null
      }
      return { type: 'ranged', kind, dir }
    }
    default:
      return null
  }
}

/** Per-connection abuse gates. */
export class RateLimiter {
  constructor() {
    this.windowStart = Date.now()
    this.total = 0
    this.bad = 0
    this.buckets = new Map()
  }
  /** Returns false when the connection should be dropped. */
  tick(msg) {
    const now = Date.now()
    if (now - this.windowStart > 1000) {
      this.windowStart = now
      this.total = 0
      // Reset the bad-message counter too, so a brief protocol-mismatch burst
      // doesn't accumulate against the player across the whole connection.
      this.bad = 0
      for (const b of this.buckets.values()) b.n = 0
    }
    this.total++
    if (this.total > 240) return false
    const caps = { pose: 34, punch: 8, grab: 8, release: 8, slam: 8, throw: 8, ranged: 16, falldmg: 5, void: 5, ready: 8, pick: 4 }
    const cap = caps[msg.type] ?? 30
    let b = this.buckets.get(msg.type)
    if (!b) {
      b = { n: 0 }
      this.buckets.set(msg.type, b)
    }
    b.n++
    return b.n <= cap
  }
  markBad() {
    this.bad++
    return this.bad < 60 // false → too much garbage; caller should close
  }
}

export function parseRaw(raw) {
  if (typeof raw === 'string' && raw.length > MSG_MAX_BYTES) return null
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

export { ARENA_BOUND, POSE_MAX_DELTA }
