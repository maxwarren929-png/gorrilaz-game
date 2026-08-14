import { useEffect, useRef, useState } from 'react'
import { Game, type GameStats } from './game/Game'
import { NetClient } from './net/NetClient'
import { resolveWsUrl, type PlayerInfo, type RoundPhase } from './net/protocol'
import { HEALTH, UPGRADE_BY_ID, UPGRADES } from './game/constants'

const ZERO: GameStats = {
  respawns: 0,
  hits: 0,
  slams: 0,
  throws: 0,
  holding: false,
  charge: 0,
  climbing: false,
  climbReady: false,
  fps: 0,
  room: '',
  peers: 0,
  hp: HEALTH.max,
  maxHp: HEALTH.max,
  ko: false,
  flying: false,
  flightLeft: 0,
  flightRecharge: 0,
  practicePicker: false,
  practiceUpgrades: [],
}

type Screen = 'menu' | 'play'

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Game | null>(null)
  const netRef = useRef<NetClient | null>(null)
  const [screen, setScreen] = useState<Screen>('menu')
  const [stats, setStats] = useState<GameStats>(ZERO)
  const [name, setName] = useState(() => localStorage.getItem('gffa-name') || 'Ape')
  const [roomIn, setRoomIn] = useState(() => new URLSearchParams(location.search).get('room') || '')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  // Mirror of net state for rendering.
  const [players, setPlayers] = useState<PlayerInfo[]>([])
  const [phase, setPhase] = useState<RoundPhase>('lobby')
  const [offer, setOffer] = useState<string[] | null>(null)
  const [winner, setWinner] = useState<string | null>(null)
  const [secs, setSecs] = useState(0)
  const [myId, setMyId] = useState('')
  const [conn, setConn] = useState<NetClient['status']>('idle')

  useEffect(() => {
    return () => {
      gameRef.current?.dispose()
      netRef.current?.disconnect()
    }
  }, [])

  // Poll the phase clock (cheap, once a second) so the timer ticks down.
  useEffect(() => {
    const t = setInterval(() => {
      const net = netRef.current
      if (net) setSecs(Math.ceil(net.phaseRemaining()))
    }, 250)
    return () => clearInterval(t)
  }, [])

  const syncNet = () => {
    const net = netRef.current
    if (!net) return
    setPlayers([...net.players.values()])
    setPhase(net.phase)
    setOffer(net.offer)
    setWinner(net.lastWinner)
    setMyId(net.id)
    setConn(net.status)
  }

  const startSolo = () => {
    if (!containerRef.current) return
    gameRef.current?.dispose()
    netRef.current?.disconnect()
    netRef.current = null
    const game = new Game(containerRef.current)
    game.onStats = setStats
    gameRef.current = game
    setPlayers([])
    setPhase('lobby')
    setScreen('play')
  }

  const startOnline = async (kind: 'create' | 'join') => {
    setErr('')
    setBusy(kind === 'create' ? 'Opening room…' : 'Joining…')
    localStorage.setItem('gffa-name', name.trim() || 'Ape')
    const net = new NetClient()
    netRef.current = net
    net.onStatus = syncNet
    try {
      await net.connect(kind, name.trim() || 'Ape', roomIn)
      if (!containerRef.current) return
      gameRef.current?.dispose()
      const game = new Game(containerRef.current, { online: true, net })
      game.onStats = setStats
      gameRef.current = game
      setConn(net.status)
      const url = new URL(location.href)
      url.searchParams.set('room', net.room)
      history.replaceState(null, '', url.toString())
      syncNet()
      setScreen('play')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to connect')
      net.disconnect()
      // Drop the dead NetClient ref so a subsequent startSolo doesn't try to
      // disconnect() an already-disconnected stale instance.
      if (netRef.current === net) netRef.current = null
    } finally {
      setBusy('')
    }
  }

  const leave = () => {
    gameRef.current?.dispose()
    gameRef.current = null
    netRef.current?.disconnect()
    netRef.current = null
    setStats(ZERO)
    setPlayers([])
    setOffer(null)
    setScreen('menu')
  }

  const me = players.find((p) => p.id === myId)
  const online = players.length > 0
  const mode = stats.holding ? 'hold' : stats.climbing ? 'climb' : stats.climbReady ? 'ready' : 'idle'

  const toggleReady = () => {
    const net = netRef.current
    if (!net || !me) return
    net.send({ type: 'ready', value: !me.ready })
  }

  const pick = (id: string) => {
    netRef.current?.send({ type: 'pick', upgrade: id })
    setOffer(null)
  }

  const copyLink = () => {
    const url = new URL(location.href)
    if (stats.room) url.searchParams.set('room', stats.room)
    void navigator.clipboard.writeText(url.toString())
  }

  const hpFrac = Math.max(0, Math.min(1, stats.hp / stats.maxHp))

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0b1020] font-sans text-white select-none">
      <div ref={containerRef} className={`absolute inset-0 ${screen === 'menu' ? 'opacity-0 pointer-events-none' : ''}`} />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at center, transparent 48%, rgba(0,0,0,0.54) 100%)' }}
      />

      {screen === 'menu' && (
        <section className="absolute inset-0 z-20 flex items-center justify-center p-6">
          <div className="w-full max-w-md border border-white/15 bg-black/55 p-6 backdrop-blur-md">
            <div className="border-l-2 border-amber-300 pl-3">
              <h1 className="text-2xl font-black uppercase tracking-[0.2em]">Gorilla FFA</h1>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.32em] text-amber-300/90">
                Phase 5 / Rounds &amp; Upgrades
              </p>
            </div>
            <p className="mt-4 text-sm text-white/60">
              Practice the ragdoll alone, or open a room and send friends the code. Up to 8 apes, health, rounds, and
              comeback upgrades for whoever's losing.
            </p>
            <label className="mt-5 block text-[10px] font-bold uppercase tracking-[0.2em] text-white/45">Name</label>
            <input
              className="mt-1 w-full border border-white/20 bg-black/40 px-3 py-2 text-sm outline-none focus:border-amber-300"
              value={name}
              maxLength={16}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              className="mt-4 w-full border border-amber-300/60 bg-amber-300/10 py-2 text-xs font-black uppercase tracking-[0.22em] text-amber-200 hover:bg-amber-300/20"
              onClick={startSolo}
            >
              Practice Solo
            </button>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                className="border border-white/20 py-2 text-[11px] font-bold uppercase tracking-[0.16em] hover:border-white/50"
                disabled={!!busy}
                onClick={() => void startOnline('create')}
              >
                Create Room
              </button>
              <div className="flex gap-1">
                <input
                  className="min-w-0 flex-1 border border-white/20 bg-black/40 px-2 py-2 text-center text-sm uppercase tracking-[0.2em] outline-none"
                  placeholder="CODE"
                  value={roomIn}
                  maxLength={4}
                  onChange={(e) => setRoomIn(e.target.value.toUpperCase())}
                />
                <button
                  className="border border-cyan-300/50 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-cyan-200 hover:bg-cyan-300/10"
                  disabled={!!busy || roomIn.length < 4}
                  onClick={() => void startOnline('join')}
                >
                  Join
                </button>
              </div>
            </div>
            {busy && <p className="mt-3 text-xs text-white/50">{busy}</p>}
            {err && <p className="mt-3 text-xs text-rose-300">{err}</p>}
            <p className="mt-5 text-[10px] leading-relaxed text-white/35">
              Server: {resolveWsUrl()}. Run <span className="text-white/55">server/</span> locally or pass{' '}
              <span className="text-white/55">?ws=wss://your-host</span>.
            </p>
          </div>
        </section>
      )}

      {screen === 'play' && (
        <>
          <header className="pointer-events-none absolute left-5 right-5 top-5 flex items-start justify-between gap-6">
            <div className="border-l-2 border-amber-300 pl-3 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]">
              <h1 className="text-xl font-black uppercase tracking-[0.22em] leading-none">Gorilla FFA</h1>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.34em] text-amber-300/90">
                {stats.room ? `Room ${stats.room} · ${stats.peers}/8` : 'Practice'}
              </p>
            </div>
            <div className="flex items-start gap-4 text-right text-[10px] font-bold uppercase tracking-[0.16em] text-white/55">
              {online && <Metric label={phaseLabel(phase)} value={secs} tone="text-white" />}
              <Metric label="Punch" value={stats.hits} tone="text-amber-300" />
              <Metric label="Slam" value={stats.slams} tone="text-orange-300" />
              <Metric label="Throw" value={stats.throws} tone="text-cyan-300" />
              <Metric label="FPS" value={stats.fps} tone="text-emerald-300" />
            </div>
          </header>

          {/* Local health + owned upgrades */}
          <div className="pointer-events-none absolute bottom-20 left-5 w-64">
            <div className="mb-1 flex items-end justify-between text-[10px] font-bold uppercase tracking-[0.18em] text-white/60">
              <span>{stats.ko ? 'Knocked Out' : 'Health'}</span>
              <span className="tabular-nums text-white/80">{Math.round(stats.hp)}</span>
            </div>
            <div className="h-2.5 w-full border border-white/25 bg-black/50">
              <div
                className="h-full transition-[width] duration-150"
                style={{
                  width: `${hpFrac * 100}%`,
                  background: stats.ko
                    ? '#555'
                    : hpFrac > 0.55
                      ? '#6ee7a0'
                      : hpFrac > 0.25
                        ? '#ffcc55'
                        : '#ff5566',
                }}
              />
            </div>
            {stats.flying && (
              <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-sky-300">
                Flight fuel {stats.flightLeft.toFixed(1)}s · Space rise · S sink
              </div>
            )}
            {!stats.flying && stats.flightRecharge > 0 && (
              <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-sky-300/70">
                Flight recharging {stats.flightRecharge.toFixed(1)}s
              </div>
            )}
            {(me?.upgrades.length || stats.practiceUpgrades.length) > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {(me?.upgrades ?? stats.practiceUpgrades).map((u) => (
                  <span
                    key={u}
                    title={UPGRADE_BY_ID.get(u)?.name}
                    className="border border-amber-300/40 bg-black/50 px-1.5 py-0.5 text-xs"
                  >
                    {UPGRADE_BY_ID.get(u)?.icon ?? '?'}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Scoreboard */}
          {online && (
            <div className="pointer-events-none absolute right-5 top-24 w-56 border border-white/10 bg-black/45 p-2 text-[10px] backdrop-blur-sm">
              {players
                .slice()
                .sort((a, b) => b.wins - a.wins || b.dealt - a.dealt)
                .map((p) => (
                  <div
                    key={p.id}
                    className={`flex items-center justify-between gap-2 py-0.5 ${p.ko ? 'text-white/30' : 'text-white/80'}`}
                  >
                    <span className="truncate">
                      {p.id === myId ? '▸ ' : ''}
                      {p.name}
                      {p.ready && phase === 'lobby' ? ' ✓' : ''}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {p.upgrades.map((u) => (
                        <span key={u}>{UPGRADE_BY_ID.get(u)?.icon ?? '?'}</span>
                      ))}
                      <span className="ml-1 tabular-nums text-amber-300">{p.wins}W</span>
                    </span>
                  </div>
                ))}
            </div>
          )}

          <div className="absolute right-5 top-16 z-10 flex gap-2">
            {online && phase === 'lobby' && (
              <button
                className={`border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] ${
                  me?.ready ? 'border-emerald-300 text-emerald-200' : 'border-white/30 text-white/70'
                }`}
                onClick={toggleReady}
              >
                {me?.ready ? 'Ready ✓' : 'Ready up'}
              </button>
            )}
            {stats.room && (
              <button
                className="border border-white/20 bg-black/40 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white/70 hover:text-white"
                onClick={copyLink}
              >
                Copy invite
              </button>
            )}
            <button
              className="border border-white/20 bg-black/40 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-rose-200/80 hover:text-rose-100"
              onClick={leave}
            >
              {stats.room ? 'Leave' : 'Menu'}
            </button>
          </div>

          {/* Connection lost overlay — NetClient auto-reconnects in background */}
          {online && (conn === 'reconnecting' || conn === 'error') && (
            <div className="pointer-events-none absolute left-1/2 top-32 z-40 -translate-x-1/2">
              <div className="border border-amber-300/60 bg-black/85 px-5 py-2 text-center text-[11px] font-black uppercase tracking-[0.18em] text-amber-200 backdrop-blur-sm">
                {conn === 'reconnecting' ? 'Connection lost — reconnecting…' : netRef.current?.lastError || 'Disconnected'}
              </div>
            </div>
          )}

          {/* Round banners */}
          {online && phase === 'lobby' && (
            <Banner title="Waiting for apes" detail={`Ready up — needs 2+ players (${players.filter((p) => p.ready).length}/${players.length} ready)`} />
          )}
          {online && phase === 'countdown' && <Banner title={`Round starts in ${secs}`} detail="Get to high ground" />}
          {online && phase === 'ended' && (
            <Banner
              title={winner ? `${players.find((p) => p.id === winner)?.name ?? 'Someone'} wins the round` : 'Round over'}
              detail="Comeback upgrades next…"
            />
          )}
          {online && phase === 'upgrading' && !offer && (
            <Banner title="Upgrade phase" detail={`Waiting on the losing apes… ${secs}s`} />
          )}

          {/* Upgrade picker — only shown to players the server offered */}
          {stats.practicePicker && !online && (
            <section className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
              <div className="w-full max-w-4xl">
                <h2 className="text-center text-lg font-black uppercase tracking-[0.24em] text-amber-300">
                  Practice Upgrades
                </h2>
                <p className="mt-1 text-center text-xs text-white/55">
                  Click to toggle. Press U again to close. Exclusive pairs replace each other.
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {UPGRADES.map((u) => {
                    const on = stats.practiceUpgrades.includes(u.id)
                    return (
                      <button
                        key={u.id}
                        onClick={() => gameRef.current?.togglePracticeUpgrade(u.id)}
                        className={`group border p-4 text-left transition ${
                          on
                            ? 'border-amber-300 bg-amber-300/15'
                            : 'border-white/20 bg-black/60 hover:border-amber-300/60 hover:bg-amber-300/10'
                        }`}
                      >
                        <div className="text-3xl">{u.icon}</div>
                        <div className="mt-2 text-sm font-black uppercase tracking-[0.14em] text-amber-200">{u.name}</div>
                        <div className="mt-1 text-[11px] leading-snug text-white/60">{u.description}</div>
                        <div className="mt-2 text-[9px] font-bold uppercase tracking-[0.2em] text-white/30">
                          {on ? 'equipped' : u.category}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </section>
          )}

          {offer && offer.length > 0 && (
            <section className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
              <div className="w-full max-w-3xl">
                <h2 className="text-center text-lg font-black uppercase tracking-[0.24em] text-amber-300">
                  Comeback Upgrade
                </h2>
                <p className="mt-1 text-center text-xs text-white/55">
                  You had a rough round. Pick one — it's permanent. ({secs}s)
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  {offer.map((id) => {
                    const u = UPGRADE_BY_ID.get(id)
                    if (!u) return null
                    return (
                      <button
                        key={id}
                        onClick={() => pick(id)}
                        className="group border border-white/20 bg-black/60 p-4 text-left transition hover:border-amber-300 hover:bg-amber-300/10"
                      >
                        <div className="text-3xl">{u.icon}</div>
                        <div className="mt-2 text-sm font-black uppercase tracking-[0.14em] text-amber-200">
                          {u.name}
                        </div>
                        <div className="mt-1 text-[11px] leading-snug text-white/60">{u.description}</div>
                        <div className="mt-2 text-[9px] font-bold uppercase tracking-[0.2em] text-white/30">
                          {u.category}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            </section>
          )}

          <ContextPrompt mode={mode} charge={stats.charge} />

          <footer className="pointer-events-none absolute bottom-5 left-5 right-5 flex flex-col gap-2 text-[10px] font-bold uppercase tracking-[0.15em] text-white/65 drop-shadow-[0_1px_4px_rgba(0,0,0,0.85)]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Control keys="WASD" label="Move" />
              <Control keys="SPACE / S" label="Fly up / down" />
              <Control keys="CLICK" label="Attack" />
              <Control keys="E" label="Grab / Climb" />
              <Control keys="HOLD Q" label="Throw" />
              <Control keys="SHIFT" label="Sprint" />
              {!online && <Control keys="U" label="Try upgrades" />}
            </div>
          </footer>
        </>
      )}
    </main>
  )
}

function phaseLabel(p: RoundPhase): string {
  switch (p) {
    case 'active':
      return 'Round'
    case 'countdown':
      return 'Starts'
    case 'upgrading':
      return 'Upgrade'
    case 'ended':
      return 'Next'
    default:
      return 'Lobby'
  }
}

function Banner({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/3 w-[min(90vw,460px)] -translate-x-1/2 text-center drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
      <div className="border-y border-amber-300/60 bg-black/45 py-3">
        <div className="text-base font-black uppercase tracking-[0.2em] text-amber-200">{title}</div>
        <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-white/65">{detail}</div>
      </div>
    </div>
  )
}

function ContextPrompt({ mode, charge }: { mode: 'hold' | 'climb' | 'ready' | 'idle'; charge: number }) {
  if (mode === 'idle') return null
  const content = {
    ready: { title: 'Wall In Reach', detail: 'Press E to latch', tone: 'border-emerald-300/75 text-emerald-200' },
    climb: {
      title: 'Climbing',
      detail: 'W/S up/down   A/D traverse   Space wall-jump   E drop',
      tone: 'border-emerald-300 text-emerald-100',
    },
    hold: {
      title: charge > 0 ? 'Throw Charging' : 'Gorilla Held',
      detail: charge > 0 ? 'Release Q to launch' : 'Click slam   Hold Q throw   E release',
      tone: charge > 0 ? 'border-cyan-300 text-cyan-100' : 'border-amber-300 text-amber-100',
    },
  }[mode]
  return (
    <div className="pointer-events-none absolute left-1/2 top-20 w-[min(90vw,360px)] -translate-x-1/2 text-center drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
      <div className={`border-b pb-2 ${content.tone} ${mode === 'ready' ? 'animate-pulse' : ''}`}>
        <div className="text-xs font-black uppercase tracking-[0.26em]">{content.title}</div>
        <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.13em] text-white/75">{content.detail}</div>
        {mode === 'hold' && charge > 0 && (
          <div className="mt-2 h-1 w-full overflow-hidden bg-white/20">
            <div className="h-full bg-gradient-to-r from-cyan-300 to-amber-300" style={{ width: `${Math.round(charge * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div>
      <span className={`mr-1.5 text-sm tabular-nums ${tone}`}>{value}</span>
      <span>{label}</span>
    </div>
  )
}

function Control({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <kbd className="mr-1 rounded border border-white/25 bg-black/30 px-1.5 py-0.5 text-white/90">{keys}</kbd>
      {label}
    </span>
  )
}
