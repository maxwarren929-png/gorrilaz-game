import { resolveWsUrl, type C2S, type S2C, type PlayerInfo, type RoundPhase } from './protocol'

interface Session {
  room: string
  id: string
  name: string
  secret: string
}

const SESSION_KEY = 'gffa-session'

export class NetClient {
  ws: WebSocket | null = null
  id = ''
  room = ''
  players = new Map<string, PlayerInfo>()
  phase: RoundPhase = 'lobby'
  phaseEndsAt = 0
  clockSkew = 0
  offer: string[] | null = null
  lastWinner: string | null = null
  matchTarget = 3
  matchWinner: string | null = null
  matchStandings: { id: string; wins: number; kos: number; dealt: number }[] = []
  status: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'error' = 'idle'
  lastError = ''

  onWelcome?: (room: string, players: PlayerInfo[]) => void
  onJoined?: (p: PlayerInfo) => void
  onLeft?: (id: string) => void
  onPose?: (msg: Extract<S2C, { type: 'pose' }>) => void
  onPunched?: (from: string, to: string, dir: [number, number, number]) => void
  onGrabbed?: (from: string, to: string) => void
  onReleased?: (from: string, to: string) => void
  onSlammed?: (from: string, to: string, dir: [number, number, number]) => void
  onThrown?: (from: string, to: string, dir: [number, number, number], charge: number) => void
  onRanged?: (from: string, kind: 'banana' | 'laser', dir: [number, number, number], hit: string | null) => void
  onTriggered?: (from: string, kind: 'domain') => void
  onKo?: (id: string, by: string | null) => void
  onPhase?: (phase: RoundPhase) => void
  onGranted?: (id: string, upgrades: string[]) => void
  onStatus?: () => void

  private session: Session | null = null
  private reconnects = 0
  private reconnectTimer: number | undefined
  private manuallyClosed = false
  private outboxQueue: string[] = []

  connect(kind: 'create' | 'join', name: string, room?: string, matchTarget?: number): Promise<void> {
    this.disconnect(true)
    // Reconnect is gated on `manuallyClosed`. The disconnect() above sets it;
    // we must clear it again so a future dropped-socket reconnect can fire.
    this.manuallyClosed = false
    this.status = 'connecting'
    this.onStatus?.()
    this.session = null
    return new Promise((resolve, reject) => {
      let resolved = false
      const onFail = () => reject(new Error(`Can't reach ${resolveWsUrl()}`))
      const initMsg: C2S =
        kind === 'create'
          ? { type: 'create', name: name || 'Ape', matchTarget }
          : { type: 'join', name: name || 'Ape', room: (room || '').toUpperCase() }
      this.openSocket(
        initMsg,
        (ws) => {
          ws.onmessage = (ev) => {
            const msg = safeParse(ev)
            if (!msg) return
            if (msg.type === 'error') {
              this.status = 'error'
              this.lastError = msg.message
              this.onStatus?.()
              reject(new Error(msg.message))
              return
            }
            if (msg.type === 'welcome') {
              resolved = true
              this.acceptWelcome(msg, name)
              resolve()
              return
            }
            this.dispatch(msg)
          }
        },
        () => {
          if (resolved) return
          onFail()
        }
      )
    })
  }

  get me(): PlayerInfo | undefined {
    return this.players.get(this.id)
  }

  /**
   * Server-aligned wall clock in ms. Poses are stamped with this on send and
   * consumed on receive so interpolation lines up across clients regardless of
   * each peer's local boot time. The skew is recomputed on every `phase`
   * message (every few seconds during active play).
   */
  netClock(): number {
    return Date.now() + this.clockSkew
  }

  phaseRemaining(): number {
    if (!this.phaseEndsAt) return 0
    return Math.max(0, (this.phaseEndsAt - (Date.now() + this.clockSkew)) / 1000)
  }

  private acceptWelcome(msg: Extract<S2C, { type: 'welcome' }>, name: string) {
    this.id = msg.id
    this.room = msg.room
    this.phase = msg.phase
    this.players.clear()
    for (const p of msg.players) this.players.set(p.id, p)
    this.matchTarget = msg.matchTarget || 3
    this.status = 'online'
    this.reconnects = 0
    this.session = { room: msg.room, id: msg.id, name, secret: msg.secret }
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(this.session))
    } catch {}
    this.onStatus?.()
    this.onWelcome?.(msg.room, msg.players)
    // Flush anything queued while reconnecting.
    const pending = this.outboxQueue
    this.outboxQueue = []
    for (const data of pending) this.ws?.send(data)
  }

  /** Reconnect with backoff and try to rejoin the same room/player id. */
  private scheduleReconnect() {
    if (this.manuallyClosed || !this.session) return
    if (this.status !== 'reconnecting') {
      this.status = 'reconnecting'
      this.onStatus?.()
    }
    const delay = Math.min(4000, 400 * 2 ** this.reconnects)
    this.reconnects++
      this.reconnectTimer = window.setTimeout(() => {
        const s = this.session
        if (!s) return
        this.openSocket(
          { type: 'rejoin', room: s.room, name: s.name, id: s.id, secret: s.secret },
        (ws) => {
          ws.onmessage = (ev) => {
            const msg = safeParse(ev)
            if (!msg) return
            if (msg.type === 'error') {
              this.lastError = msg.message
              if (this.reconnects > 6) {
                this.status = 'error'
                this.onStatus?.()
                return
              }
              // Session expired server-side — give up and surface the error.
              if (/expired/i.test(msg.message)) {
                this.status = 'error'
                this.onStatus?.()
                this.session = null
                try {
                  localStorage.removeItem(SESSION_KEY)
                } catch {}
                return
              }
              this.detachSocket(ws)
              this.scheduleReconnect()
              return
            }
            if (msg.type === 'welcome') {
              this.acceptWelcome(msg, s.name)
              for (const p of this.players.values()) {
                if (p.id !== this.id) this.onJoined?.(p)
              }
              return
            }
            this.dispatch(msg)
          }
        },
        () => this.scheduleReconnect()
      )
    }, delay)
  }

  /** Tear down a single socket without disturbing the NetClient's bookkeeping. */
  private detachSocket(ws: WebSocket) {
    ws.onclose = null
    ws.onerror = null
    ws.onopen = null
    ws.onmessage = null
    try {
      ws.close()
    } catch {}
    if (this.ws === ws) this.ws = null
  }

  private openSocket(payload: C2S, onAttach: (ws: WebSocket) => void, onFail: () => void) {
    let settled = false
    const ws = new WebSocket(resolveWsUrl())
    this.ws = ws
    ws.onerror = () => {
      if (!settled) {
        settled = true
        onFail()
      }
    }
    ws.onclose = () => {
      if (!settled) {
        settled = true
        onFail()
        return
      }
      // Post-online drop → schedule a reconnect (gated by manuallyClosed).
      if (this.status === 'online') {
        this.scheduleReconnect()
      } else if (this.status === 'connecting') {
        // Socket closed post-handshake but pre-welcome: caller's promise would
        // otherwise hang forever. Surface it as a failure so the UI can retry.
        onFail()
      }
    }
    ws.onopen = () => {
      settled = true
      onAttach(ws)
      ws.send(JSON.stringify(payload))
    }
  }

  private dispatch(msg: S2C) {
    switch (msg.type) {
      case 'joined':
        this.players.set(msg.player.id, msg.player)
        this.onJoined?.(msg.player)
        this.onStatus?.()
        break
      case 'left':
        this.players.delete(msg.id)
        this.onLeft?.(msg.id)
        this.onStatus?.()
        break
      case 'pose':
        this.onPose?.(msg)
        break
      case 'punched':
        this.onPunched?.(msg.from, msg.to, msg.dir)
        break
      case 'grabbed':
        this.onGrabbed?.(msg.from, msg.to)
        break
      case 'released':
        this.onReleased?.(msg.from, msg.to)
        break
      case 'slammed':
        this.onSlammed?.(msg.from, msg.to, msg.dir)
        break
      case 'thrown':
        this.onThrown?.(msg.from, msg.to, msg.dir, msg.charge)
        break
      case 'ranged':
        this.onRanged?.(msg.from, msg.kind, msg.dir, msg.hit ?? null)
        break
      case 'triggered':
        this.onTriggered?.(msg.from, msg.kind)
        break
      case 'health': {
        const p = this.players.get(msg.id)
        if (p) {
          p.hp = msg.hp
          p.maxHp = msg.maxHp
          p.dealt = msg.dealt
        }
        this.onStatus?.()
        break
      }
      case 'ko': {
        const p = this.players.get(msg.id)
        if (p) {
          p.ko = true
          p.hp = 0
        }
        if (msg.by) {
          const k = this.players.get(msg.by)
          if (k) k.kos += 1
        }
        this.onKo?.(msg.id, msg.by)
        this.onStatus?.()
        break
      }
      case 'ready': {
        const p = this.players.get(msg.id)
        if (p) p.ready = msg.value
        this.onStatus?.()
        break
      }
      case 'phase':
        this.clockSkew = msg.now - Date.now()
        this.phase = msg.phase
        this.phaseEndsAt = msg.endsAt
        if (msg.phase === 'countdown' || msg.phase === 'active') this.offer = null
        this.onPhase?.(msg.phase)
        this.onStatus?.()
        break
      case 'roundEnd': {
        this.lastWinner = msg.winner
        this.matchWinner = null
        const w = msg.winner ? this.players.get(msg.winner) : null
        if (w) w.wins += 1
        for (const s of msg.standings) {
          const p = this.players.get(s.id)
          if (p) {
            p.hp = s.hp
            p.dealt = s.dealt
          }
        }
        this.onStatus?.()
        break
      }
      case 'matchEnd': {
        this.matchWinner = msg.winner
        this.matchStandings = msg.standings
        // Reflect final wins in the local PlayerInfo mirror.
        for (const s of msg.standings) {
          const p = this.players.get(s.id)
          if (p) {
            p.wins = s.wins
            p.kos = s.kos
            p.dealt = s.dealt
          }
        }
        this.onStatus?.()
        break
      }
      case 'offer':
        this.offer = msg.options
        this.onStatus?.()
        break
      case 'granted': {
        const p = this.players.get(msg.id)
        if (p) p.upgrades = msg.upgrades
        if (msg.id === this.id) this.offer = null
        this.onGranted?.(msg.id, msg.upgrades)
        this.onStatus?.()
        break
      }
    }
  }

  send(msg: C2S) {
    const data = JSON.stringify(msg)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data)
    else if (this.status === 'reconnecting') {
      // Queue only the most recent pose while sockets are down.
      this.outboxQueue = msg.type === 'pose' ? [data] : this.outboxQueue.slice(-19).concat([data])
    }
  }

  disconnect(manual = true) {
    this.manuallyClosed = manual
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onopen = null
      this.ws.onmessage = null
      try {
        this.ws.close()
      } catch {}
    }
    this.ws = null
    this.status = 'idle'
    this.id = ''
    this.room = ''
    this.offer = null
    this.lastWinner = null
    this.matchWinner = null
    this.players.clear()
    this.outboxQueue = []
    // Detach consumer callbacks so a stray status emit can't reach a disposed
    // Game (the consumer should also null these, but this is defense in depth
    // against use-after-free-style references).
    if (manual) {
      this.onWelcome = undefined
      this.onJoined = undefined
      this.onLeft = undefined
      this.onPose = undefined
      this.onPunched = undefined
      this.onGrabbed = undefined
      this.onReleased = undefined
      this.onSlammed = undefined
      this.onThrown = undefined
      this.onRanged = undefined
      this.onTriggered = undefined
      this.onKo = undefined
      this.onPhase = undefined
      this.onGranted = undefined
      this.session = null
      try {
        localStorage.removeItem(SESSION_KEY)
      } catch {}
    }
  }
}

function safeParse(ev: MessageEvent): S2C | null {
  try {
    return JSON.parse(String(ev.data)) as S2C
  } catch {
    return null
  }
}
