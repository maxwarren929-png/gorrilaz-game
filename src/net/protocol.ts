// Shared wire format for Gorilla FFA.
// JSON over WebSocket. Compact number arrays keep 8-player 20 Hz poses cheap.
//
// Phase 5 authority split:
//   client -> owns its ragdoll physics, reports fall damage / void deaths
//   server -> owns health, KO, round lifecycle, upgrade offers + grants

export const NET = {
  poseHz: 20,
  interpDelay: 0.09, // render remotes 90ms in the past
  maxPlayers: 8,
  punchRange: 3.4,
  grabRange: 3.2,
  rangedRange: 30, // generous: bananas/lasers are validated loosely
  defaultWs: 'ws://localhost:8787',
}

export interface PoseMsg {
  type: 'pose'
  id: string
  t: number
  p: [number, number, number]
  q: [number, number, number, number]
  v: [number, number, number]
  l: number[] // 4 * (x,y,z,qx,qy,qz,qw)
  f: [number, number]
  s: number // bit flags
}

export const FLAG = {
  climbing: 1,
  punching: 2,
  grabbed: 4,
  respawning: 8,
  ko: 16,
  flying: 32,
}

export type RoundPhase = 'lobby' | 'countdown' | 'active' | 'ended' | 'upgrading'

export interface PlayerInfo {
  id: string
  name: string
  tint: number
  hp: number
  maxHp: number
  ko: boolean
  ready: boolean
  wins: number
  kos: number
  dealt: number
  upgrades: string[]
  online?: boolean
  /** Wall-clock ms (server-aligned) when an active Domain Expansion buff ends. */
  domainUntil?: number
}

export type HitKind = 'punch' | 'slam' | 'throw' | 'banana' | 'laser'

export type C2S =
  | { type: 'join'; room: string; name: string }
  | { type: 'create'; name: string; matchTarget?: number }
  | { type: 'rejoin'; room: string; name: string; id: string; secret: string }
  | PoseMsg
  | { type: 'punch'; target: string; dir: [number, number, number] }
  | { type: 'grab'; target: string }
  | { type: 'release' }
  | { type: 'slam'; dir: [number, number, number] }
  | { type: 'throw'; dir: [number, number, number]; charge: number }
  | { type: 'falldmg'; amount: number }
  | { type: 'void' }
  | { type: 'ready'; value: boolean }
  | { type: 'pick'; upgrade: string }
  | { type: 'ranged'; kind: 'banana'; dir: [number, number, number]; spawn: string }
  | { type: 'ranged'; kind: 'banana'; impact: string; target: string }
  | { type: 'ranged'; kind: 'laser'; dir: [number, number, number]; target?: string }
  | { type: 'trigger'; kind: 'domain' }

export type S2C =
  | { type: 'welcome'; id: string; room: string; players: PlayerInfo[]; phase: RoundPhase; secret: string; matchTarget: number }
  | { type: 'joined'; player: PlayerInfo }
  | { type: 'left'; id: string }
  | { type: 'error'; message: string }
  | PoseMsg
  | { type: 'punched'; from: string; to: string; dir: [number, number, number] }
  | { type: 'grabbed'; from: string; to: string }
  | { type: 'released'; from: string; to: string }
  | { type: 'slammed'; from: string; to: string; dir: [number, number, number] }
  | { type: 'thrown'; from: string; to: string; dir: [number, number, number]; charge: number }
  | { type: 'ranged'; from: string; kind: 'banana' | 'laser'; dir: [number, number, number]; hit: string | null }
  | { type: 'triggered'; from: string; kind: 'domain' }
  | { type: 'health'; id: string; hp: number; maxHp: number; dealt: number }
  | { type: 'ko'; id: string; by: string | null }
  | { type: 'ready'; id: string; value: boolean }
  | { type: 'phase'; phase: RoundPhase; endsAt: number; now: number }
  | { type: 'roundEnd'; winner: string | null; standings: { id: string; hp: number; dealt: number }[] }
  | { type: 'matchEnd'; winner: string | null; standings: { id: string; wins: number; kos: number; dealt: number }[] }
  | { type: 'offer'; options: string[] } // only sent to a losing player
  | { type: 'granted'; id: string; upgrade: string; upgrades: string[] }
  | { type: 'reset' } // cross-instance sync only; not handled by the client

export const TINTS = [
  0x3b3b41, 0x5b4636, 0x46464c, 0x6a5a36, 0x3d4a38, 0x4a3a4c, 0x5a4030, 0x2f3f4a,
]

export function themeFromTint(tint: number) {
  const c = tint
  const dark = ((c >> 1) & 0x7f7f7f) | 0x101010
  return { body: c, bodyDark: dark, muzzle: 0xcfa074, silver: tint === 0x3b3b41 ? 0xc2c8cf : undefined }
}

export function resolveWsUrl(): string {
  // 1. Explicit override wins: ?ws=… or localStorage gffa-ws. Validate the
  //    scheme so a mistyped `ws:/attacker.com` or javascript: URL can't be
  //    injected here (the value is later fed straight to `new WebSocket`).
  const q = new URLSearchParams(window.location.search)
  const forced = q.get('ws') || localStorage.getItem('gffa-ws')
  if (forced) {
    try {
      const u = new URL(forced, window.location.href)
      if (u.protocol === 'ws:' || u.protocol === 'wss:') return u.href
    } catch {
      /* fall through to defaults */
    }
  }
  // 2. Served over TLS from a real domain → the co-deployed Vercel function.
  if (location.protocol === 'https:') return `wss://${location.host}/api/ws`
  // 3. file:// or plain local → standalone dev server.
  if (!location.hostname || location.protocol === 'file:') return NET.defaultWs
  // 4. Dev / LAN (vite --host): same host, dev-server port.
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${new URL(NET.defaultWs).port}`
}
