/**
 * Game — frame orchestrator for Gorilla FFA.
 *
 * One RAF loop owns input → intent → preStep assists → cannon-es step →
 * combat resolution → respawn → render. Subsystems (Gorilla, Arena, Input,
 * CameraRig, Effects) stay independently testable; this file is the only
 * place that wires them together.
 *
 * Combat verbs: punch (click), grab (E), slam (click while holding),
 * charged throw (hold Q), jump (Space), climb (E on a wall).
 */
import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import {
  PHYS,
  ARENA,
  RESPAWN,
  PUNCH,
  GRAB,
  CLIMB,
  THROW,
  HEALTH,
  FALL,
  BANANA,
  LASER,
  SPRINT,
  GORILLA,
  DOMAIN,
  DAMAGE,
  modsFor,
  UPGRADE_BY_ID,
} from './constants'
import { buildArena, CLIMB_ZONES, groundHeightAt, raycastArena, type ClimbZone } from './Arena'
import { Gorilla, GorillaTheme } from './Gorilla'
import { CameraRig } from './CameraRig'
import { Effects } from './Effects'
import { Input } from './Input'
import { Projectiles, type HitTarget } from './Projectiles'
import { clamp } from './utils'
import { FLAG, NET } from '../net/protocol'
import type { NetClient } from '../net/NetClient'
import { RemoteAvatar } from '../net/RemoteAvatar'

export interface GameConfig {
  online?: boolean
  net?: NetClient
}

export interface GameStats {
  respawns: number
  hits: number
  slams: number
  throws: number
  holding: boolean
  charge: number
  climbing: boolean
  climbReady: boolean
  fps: number
  room: string
  peers: number
  hp: number
  maxHp: number
  ko: boolean
  flying: boolean
  flightLeft: number
  flightRecharge: number
  practicePicker: boolean
  practiceUpgrades: string[]
}

export class Game {
  private container: HTMLElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private cameraRig: CameraRig
  private world: CANNON.World
  private input: Input
  private effects: Effects
  private clock = new THREE.Clock()
  private raf = 0
  private running = false

  private player!: Gorilla
  private dummies: Gorilla[] = []
  private gorillas: Gorilla[] = []

  private materialGround: CANNON.Material
  private materialGorilla: CANNON.Material
  private highlight!: THREE.Mesh
  private grabConstraint: CANNON.Constraint | null = null

  private respawns = 0
  private hits = 0
  private slams = 0
  private throws = 0
  private statTimer = 0
  private throwCharge = 0
  private chargingThrow = false
  private wallGrabBuffer = 0
  private online = false
  private net: NetClient | null = null
  private remotes = new Map<string, RemoteAvatar>()
  private heldRemote: RemoteAvatar | null = null
  private grabConfirmTimer = 0
  private heldById: string | null = null
  private poseAcc = 0
  // ---- Phase 5 ----
  private projectiles!: Projectiles
  private treeApis: ReturnType<typeof buildArena> | null = null
  private treeRegrowTimer = 0
  private bananaCd = 0
  private bananaSeq = 0
  private laserCd = 0
  private laserNeedsRelease = false
  private domainCd = 0
  private domainTimer = 0
  private domainActive = false
  private localHp = HEALTH.max
  private roundLive = true // practice mode is always "live"
  private practicePicker = false
  private practiceUpgrades: string[] = []
  onStats?: (s: GameStats) => void

  constructor(container: HTMLElement, config: GameConfig = {}) {
    this.container = container
    this.online = !!config.online
    this.net = config.net || null

    // ---- renderer ----
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    const el = this.renderer.domElement
    el.style.display = 'block'
    el.style.touchAction = 'none'
    container.appendChild(el)

    // ---- scene + camera ----
    this.scene = new THREE.Scene()
    this.cameraRig = new CameraRig(container.clientWidth / container.clientHeight)

    // ---- physics world ----
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, PHYS.gravity, 0) })
    this.world.broadphase = new CANNON.SAPBroadphase(this.world)
    const solver = new CANNON.GSSolver()
    solver.iterations = PHYS.solverIterations
    this.world.solver = solver
    this.world.allowSleep = false

    this.materialGround = new CANNON.Material('ground')
    this.materialGorilla = new CANNON.Material('gorilla')
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.materialGround, this.materialGorilla, { friction: 0.5, restitution: 0.12 })
    )
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.materialGorilla, this.materialGorilla, { friction: 0.25, restitution: 0.4 })
    )

    // ---- entities ----
    this.input = new Input(el)
    this.effects = new Effects(this.scene)
    this.projectiles = new Projectiles(this.scene)
    this.projectiles.onBananaImpact = (x, z) => this.treeApis?.damageTreeAt(x, z, 1.4)
    const treeApis = buildArena(this.scene, this.world, this.materialGround)
    this.treeApis = treeApis
    this.spawnGorillas()
    if (this.online && this.net) this.bindNet()

    // ground highlight under the player so it's obvious which gorilla is "you"
    this.highlight = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.18, 44),
      new THREE.MeshBasicMaterial({
        color: 0xffc857,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    this.highlight.rotation.x = -Math.PI / 2
    this.highlight.position.y = 0.04
    this.scene.add(this.highlight)

    window.addEventListener('resize', this.onResize)
    this.running = true
    this.clock.start()
    this.loop()
  }

  private onResize = () => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    this.cameraRig.resize(w / h)
  }

  /**
   * Tear down everything the constructor allocated: RAF loop, DOM/Window
   * listeners, the Input set, the WebGLRenderer, the Effects/Projectiles
   * pools, every Gorilla's bodies+constraints+materials, every RemoteAvatar,
   * and all net callbacks. After this the instance is inert and safe to GC.
   */
  dispose() {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.raf)

    window.removeEventListener('resize', this.onResize)

    // Detach net callbacks first so a late message can't touch a disposed Game.
    const net = this.net
    if (net) {
      net.onWelcome = undefined
      net.onJoined = undefined
      net.onLeft = undefined
      net.onPose = undefined
      net.onPunched = undefined
      net.onGrabbed = undefined
      net.onReleased = undefined
      net.onSlammed = undefined
      net.onThrown = undefined
      net.onRanged = undefined
      net.onTriggered = undefined
      net.onKo = undefined
      net.onPhase = undefined
      net.onGranted = undefined
    }

    this.input.dispose()
    this.effects.dispose()
    this.projectiles.dispose()
    for (const av of this.remotes.values()) {
      this.scene.remove(av.group)
      av.dispose()
    }
    this.remotes.clear()
    for (const g of this.gorillas) {
      this.scene.remove(g.group)
      g.dispose()
    }
    this.gorillas = []
    this.dummies = []
    this.heldRemote = null
    this.heldById = null
    this.grabConstraint = null

    this.scene.remove(this.highlight)
    ;(this.highlight.geometry as THREE.BufferGeometry).dispose()
    ;(this.highlight.material as THREE.Material).dispose()

    // Release the renderer + its DOM element from the container.
    const canvas = this.renderer.domElement
    if (canvas.parentElement === this.container) this.container.removeChild(canvas)
    this.renderer.dispose()
  }

  private spawnGorillas() {
    const dummyCount = this.online ? 0 : 3
    const total = 1 + dummyCount
    const playerTheme: GorillaTheme = { body: 0x3b3b41, bodyDark: 0x2a2a2f, muzzle: 0xcfa074, silver: 0xc2c8cf }
    const dummyThemes: GorillaTheme[] = [
      { body: 0x5b4636, bodyDark: 0x3f2f22, muzzle: 0xd9b48a },
      { body: 0x46464c, bodyDark: 0x32323a, muzzle: 0xc3a07d },
      { body: 0x6a5a36, bodyDark: 0x4d4024, muzzle: 0xd6b279 },
    ]

    this.player = new Gorilla(this.world, this.materialGorilla, playerTheme, true, 0, total, new CANNON.Vec3(0, RESPAWN.spawnY, 0))
    this.gorillas.push(this.player)
    this.scene.add(this.player.group)

    for (let i = 0; i < dummyCount; i++) {
      const ang = (i / 3) * Math.PI * 2 + 0.6
      const r = ARENA.half * 0.55
      const sp = new CANNON.Vec3(Math.cos(ang) * r, RESPAWN.spawnY, Math.sin(ang) * r)
      const g = new Gorilla(this.world, this.materialGorilla, dummyThemes[i], false, i + 1, total, sp)
      this.dummies.push(g)
      this.gorillas.push(g)
      this.scene.add(g.group)
    }

    for (const g of this.gorillas) g.setGroundResolver(groundHeightAt)
  }

  private bindNet() {
    const net = this.net
    if (!net) return
    // Seed round-liveness from the phase the welcome already established —
    // onPhase only fires on transitions, so without this a client that joins
    // mid-lobby thinks the round is live and starts sending falldmg/void/fire.
    this.roundLive = net.phase === 'active'
    net.onWelcome = () => {
      // Session resume (NetClient reconnect) re-fires onWelcome with the full
      // roster: rebuild all remote avatars so stale doppelgangers never linger,
      // and flush snapshot buffers so pre-disconnect poses don't bleed in.
      for (const av of this.remotes.values()) {
        this.scene.remove(av.group)
        av.dispose()
      }
      this.remotes.clear()
      if (this.heldRemote) this.heldRemote = null
      if (this.heldById) {
        this.heldById = null
        this.player.isGrabbed = false
        this.player.holdPoint = null
      }
      for (const p of this.net!.players.values()) {
        if (p.id !== this.net!.id) this.addRemote(p.id, p.name, p.tint)
      }
    }
    for (const p of net.players.values()) {
      if (p.id !== net.id) this.addRemote(p.id, p.name, p.tint)
    }
    net.onJoined = (p) => this.addRemote(p.id, p.name, p.tint)
    net.onLeft = (id) => this.removeRemote(id)
    net.onPose = (msg) => this.remotes.get(msg.id)?.push(msg)
    net.onPunched = (_from, to, dir) => {
      const d = new CANNON.Vec3(dir[0], dir[1], dir[2])
      const atk = net.players.get(_from)
      const am = atk ? modsFor(atk.upgrades) : null
      const atkDomain = atk && atk.domainUntil && atk.domainUntil > Date.now() + this.net!.clockSkew ? DOMAIN.buffKnock : 1
      const vicDomain = this.domainActive ? DOMAIN.buffResist : 1
      const mul = (am ? am.forceMul * am.punchKnockMul : 1) * atkDomain * vicDomain
      if (to === net.id) this.player.takeHit(d, mul)
      const who = this.remotes.get(to)
      const pos = who ? who.pos : this.player.torso.position
      this.effects.burst(new THREE.Vector3(pos.x, pos.y + 0.5, pos.z), new THREE.Vector3(d.x, 0.4, d.z))
      this.cameraRig.addShake(to === net.id ? 0.55 : 0.28)
      // Visual knockback prediction on remote avatars
      if (who) {
        const f3 = new THREE.Vector3(d.x, 0, d.z).normalize()
        who.applyHitImpulse(f3, PUNCH.knockback * mul)
        this.effects.damageNumber(who.pos.clone(), DAMAGE.punch)
      }
    }
    net.onGrabbed = (from, to) => {
      if (to === net.id) {
        this.heldById = from
        this.player.isGrabbed = true
        if (this.player.climbing) this.exitClimb(false, 0, 0)
      }
      if (from === net.id) {
        const r = this.remotes.get(to)
        if (r) {
          this.heldRemote = r
          r.heldLock = true
        }
        // Server confirmed our grab — cancel the rollback timeout
        this.grabConfirmTimer = 0
      }
      const vic = this.remotes.get(to)
      if (vic) this.effects.grab(vic.pos.clone())
    }
    net.onReleased = (from, to) => {
      if (to === net.id) {
        this.heldById = null
        this.player.isGrabbed = false
        this.player.holdPoint = null
      }
      if (from === net.id && this.heldRemote) {
        this.heldRemote.heldLock = false
        this.heldRemote = null
      }
    }
    net.onSlammed = (from, to, dir) => {
      const d = new CANNON.Vec3(dir[0], dir[1], dir[2])
      const atk = net.players.get(from)
      const sm = modsFor(atk?.upgrades || [])
      const atkDomain = atk && atk.domainUntil && atk.domainUntil > Date.now() + this.net!.clockSkew ? DOMAIN.buffKnock : 1
      const vicDomain = this.domainActive ? DOMAIN.buffResist : 1
      const mul = sm.forceMul * atkDomain * vicDomain
      if (to === net.id)
        this.player.applyLaunch(d, GRAB.slamForce * mul, 0.2, 32, GRAB.limbFlail, GRAB.slamStaggerTime)
      const victim = this.remotes.get(to)
      const pos = victim?.pos || this.player.torso.position
      this.effects.slam(new THREE.Vector3(pos.x, pos.y, pos.z))
      this.cameraRig.addShake(0.7)
      if (victim) {
        const f3 = new THREE.Vector3(d.x, d.y, d.z)
        if (f3.lengthSq() > 1e-4) f3.normalize()
        victim.applyHitImpulse(f3, GRAB.slamForce * mul)
        this.effects.damageNumber(victim.pos.clone(), DAMAGE.slam, true)
      }
      if (from === net.id) this.slams++
    }
    net.onThrown = (from, to, dir, charge) => {
      const d = new CANNON.Vec3(dir[0], dir[1], dir[2])
      const atk = net.players.get(from)
      const tm = modsFor(atk?.upgrades || [])
      const atkDomain = atk && atk.domainUntil && atk.domainUntil > Date.now() + this.net!.clockSkew ? DOMAIN.buffKnock : 1
      const vicDomain = this.domainActive ? DOMAIN.buffResist : 1
      const force = (THROW.minForce + (THROW.maxForce - THROW.minForce) * charge) * tm.forceMul * atkDomain * vicDomain
      const up = THROW.up
      const spin = THROW.minSpin + (THROW.maxSpin - THROW.minSpin) * charge
      if (to === net.id) this.player.applyLaunch(d, force, up, spin, THROW.limbFlail, 1.5)
      const victim = this.remotes.get(to)
      const pos = victim?.pos || this.player.torso.position
      this.effects.throw(new THREE.Vector3(pos.x, pos.y, pos.z), new THREE.Vector3(d.x, d.y, d.z))
      this.cameraRig.addShake(0.55 + charge * 0.4)
      if (victim) {
        const f3 = new THREE.Vector3(d.x, d.y, d.z)
        if (f3.lengthSq() > 1e-4) f3.normalize()
        victim.applyHitImpulse(f3, force)
        this.effects.damageNumber(victim.pos.clone(), DAMAGE.throwBase + DAMAGE.throwCharged * charge, true)
      }
      if (from === net.id) this.throws++
    }

    // ---- Phase 5 ----
    net.onRanged = (from, kind, dir, hit) => {
      const d = new THREE.Vector3(dir[0], dir[1], dir[2])
      const shooter = from === net.id ? null : this.remotes.get(from)
      const origin = shooter
        ? shooter.pos.clone().setY(shooter.pos.y + 0.4)
        : new THREE.Vector3(
            this.player.torso.position.x,
            this.player.torso.position.y + 0.4,
            this.player.torso.position.z
          )
      // The shooter already spawned its own predicted visual.
      if (from !== net.id) {
        if (kind === 'banana') this.projectiles.fireBanana(origin, d, false)
        else {
          const wall = raycastArena(origin.x, origin.y, origin.z, d.x, d.y, d.z, LASER.range)
          this.projectiles.fireBeam(origin, d, wall)
        }
      }
      if (hit) {
        const knock = kind === 'banana' ? BANANA.knockback : LASER.knockback
        const up = kind === 'banana' ? BANANA.knockUp : LASER.knockUp
        if (hit === net.id) {
          this.player.applyLaunch(new CANNON.Vec3(d.x, 0, d.z), knock, up, 18, 10, 0.8)
          this.cameraRig.addShake(0.5)
        }
        const vp = this.remotes.get(hit)
        const at = vp ? vp.pos.clone() : new THREE.Vector3().copy(this.player.torso.position as never)
        this.effects.burst(at.setY(at.y + 0.4), new THREE.Vector3(d.x, 0.4, d.z))
        if (vp) {
          vp.applyHitImpulse(d.clone().setY(0).normalize(), knock)
          this.effects.damageNumber(vp.pos.clone(), kind === 'banana' ? DAMAGE.banana : DAMAGE.laser)
        }
      }
    }

    net.onTriggered = (from) => {
      const av = this.remotes.get(from)
      if (av) this.effects.domain(new THREE.Vector3(av.pos.x, av.pos.y, av.pos.z), false, this.scene, this.world, this.materialGround)
    }

    net.onKo = (id) => {
      if (id === net.id) {
        this.player.knockOut()
        this.releaseGrab()
        this.cameraRig.addShake(0.9)
      }
      const av = this.remotes.get(id)
      if (av) {
        av.ko = true
        this.effects.slam(av.pos.clone())
      }
    }

    net.onPhase = (phase) => {
      this.roundLive = phase === 'active'
      if (phase === 'countdown') this.resetForRound()
    }

    net.onGranted = (id, upgrades) => {
      if (id === net.id) this.applyLocalUpgrades(upgrades)
      const av = this.remotes.get(id)
      if (av) av.setUpgrades(upgrades)
    }
  }

  /** Rebuild the local gorilla's modifier bag from its owned upgrade ids. */
  private applyLocalUpgrades(ids: string[]) {
    this.player.setMods(modsFor(ids))
    const max = HEALTH.max * this.player.mods.healthMul
    this.localHp = Math.min(max, Math.max(this.localHp, this.online ? 0 : max))
  }

  /** Practice-only: click an upgrade to toggle it. Exclusive groups replace. */
  togglePracticeUpgrade(id: string) {
    if (this.online) return
    const u = UPGRADE_BY_ID.get(id)
    if (!u) return
    const owned = this.practiceUpgrades.includes(id)
    if (owned) {
      // If we remove v1, we must also remove v2
      this.practiceUpgrades = this.practiceUpgrades.filter((x) => x !== id && UPGRADE_BY_ID.get(x)?.requires !== id)
    } else {
      if (u.requires && !this.practiceUpgrades.includes(u.requires)) return // can't add v2 without v1
      if (u.category === 'main' && !u.requires) {
        this.practiceUpgrades = this.practiceUpgrades.filter((x) => UPGRADE_BY_ID.get(x)?.category !== 'main')
      }
      if (u.category === 'trigger' && !u.requires) {
        this.practiceUpgrades = this.practiceUpgrades.filter((x) => UPGRADE_BY_ID.get(x)?.category !== 'trigger')
      }
      if (u.exclusiveGroup) {
        this.practiceUpgrades = this.practiceUpgrades.filter((x) => UPGRADE_BY_ID.get(x)?.exclusiveGroup !== u.exclusiveGroup)
      }
      this.practiceUpgrades = [...this.practiceUpgrades, id]
    }
    this.applyLocalUpgrades(this.practiceUpgrades)
    this.flushStats()
  }

  private flushStats() {
    const climbReady =
      this.player.canClimb() &&
      this.player.grabbedTarget === null &&
      this.findClimbZone(this.player.isGrounded() ? 'ground' : 'air') !== null
    this.onStats?.({
      respawns: this.respawns,
      hits: this.hits,
      slams: this.slams,
      throws: this.throws,
      holding: this.player.grabbedTarget !== null || this.heldRemote !== null,
      charge: this.chargingThrow ? this.throwCharge : 0,
      climbing: this.player.climbing,
      climbReady,
      fps: 0,
      room: this.net?.room || '',
      peers: this.remotes.size + (this.online ? 1 : 0),
      hp: this.online ? this.localHp : HEALTH.max * this.player.mods.healthMul,
      maxHp: HEALTH.max * this.player.mods.healthMul,
      ko: this.player.ko,
      flying: this.player.flying,
      flightLeft: this.player.flightTimer,
      flightRecharge: this.player.flightCooldown,
      practicePicker: this.practicePicker,
      practiceUpgrades: this.practiceUpgrades,
    })
  }

  /** Fresh round: heal, clear KO, respawn at a spread-out spot. */
  private resetForRound() {
    const net = this.net
    this.localHp = HEALTH.max * this.player.mods.healthMul
    const idx = net ? [...net.players.keys()].sort().indexOf(net.id) : 0
    const n = net ? Math.max(1, net.players.size) : 1
    const ang = (Math.max(0, idx) / n) * Math.PI * 2
    const r = ARENA.half * 0.6
    this.player.revive(new CANNON.Vec3(Math.cos(ang) * r, RESPAWN.spawnY + 0.5, Math.sin(ang) * r))
    // Flush remote snapshot buffers so the previous round's final pose can't
    // bleed into the new round's first interpolation window.
    for (const av of this.remotes.values()) {
      av.ko = false
      av.clearSnaps()
    }
    this.releaseGrab()
    this.bananaCd = 0
    this.laserCd = 0
  }

  /** Candidate victims for projectiles/lasers (remote gorillas only). */
  private rangedTargets(): HitTarget[] {
    const out: HitTarget[] = []
    for (const [id, av] of this.remotes) {
      if (av.ko || av.flags & FLAG.respawning) continue
      out.push({ id, pos: av.pos, radius: GORILLA.torsoRadius * av.scale + 0.25 })
    }
    this.dummies.forEach((d, i) => {
      if (d.respawning || d.ko) return
      out.push({
        id: `dummy:${i}`,
        pos: new THREE.Vector3(d.torso.position.x, d.torso.position.y, d.torso.position.z),
        radius: GORILLA.torsoRadius * d.mods.scale + 0.25,
      })
    })
    return out
  }

  /** Banana Gun: lob a projectile; impact is resolved locally then reported. */
  private getMouseFacing(): CANNON.Vec3 | null {
    const cam = this.cameraRig.camera
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(this.input.pointerX, this.input.pointerY), cam)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), this.player.torso.position.y)
    const target = new THREE.Vector3()
    if (raycaster.ray.intersectPlane(plane, target)) {
      const dx = target.x - this.player.torso.position.x
      const dz = target.z - this.player.torso.position.z
      const len = Math.hypot(dx, dz)
      if (len > 0.1) return new CANNON.Vec3(dx / len, 0, dz / len)
    }
    return null
  }

  private fireBanana() {
    if (this.bananaCd > 0 || this.player.ko) return
    this.bananaCd = BANANA.cooldown / this.player.mods.actionMul
    const aim = this.getMouseFacing()
    if (aim) this.player.facing.copy(aim)
    const pf = this.player.facing
    const origin = new THREE.Vector3(
      this.player.torso.position.x + pf.x * BANANA.spawnForward,
      this.player.torso.position.y + 0.35,
      this.player.torso.position.z + pf.z * BANANA.spawnForward
    )
    
    const count = this.player.mods.banana_v2 ? 3 : 1
    for (let i = 0; i < count; i++) {
      const key = `p${this.net?.id ?? 'x'}b${++this.bananaSeq}`
      const dir = new THREE.Vector3(pf.x, 0.12, pf.z).normalize()
      if (count === 3) {
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (i - 1) * 0.25)
      }
      this.projectiles.fireBanana(origin, dir, true, key)
      this.net?.send({ type: 'ranged', kind: 'banana', dir: [dir.x, dir.y, dir.z], spawn: key })
    }
  }

  /** Laser Eyes: instant hitscan replacing the punch entirely. */
  private fireLaser() {
    if (this.laserCd > 0 || this.player.ko || this.player.laserInterrupt > 0) return
    // Continuous beam: this is the per-tick pace, not a per-press cooldown.
    this.laserCd = 1 / LASER.tickRate
    const aim = this.getMouseFacing()
    if (aim) this.player.facing.copy(aim)
    const pf = this.player.facing
    const dir = new THREE.Vector3(pf.x, 0, pf.z).normalize()
    const origin = new THREE.Vector3(
      this.player.torso.position.x,
      this.player.torso.position.y + 0.45 * this.player.mods.scale,
      this.player.torso.position.z
    )
    const wallDist = raycastArena(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, LASER.range)
    // Active Domain Expansion shells also clip the beam — they're solid
    // physics bodies for gorillas but the laser raycast ignored them.
    let domainClip = wallDist
    for (const w of this.effects.domainWalls()) {
      const cx = w.pos.x - origin.x
      const cy = w.pos.y - origin.y
      const cz = w.pos.z - origin.z
      const along = cx * dir.x + cy * dir.y + cz * dir.z
      if (along < 0) continue
      const perp2 = cx * cx + cy * cy + cz * cz - along * along
      if (perp2 > w.radius * w.radius) continue
      const back = Math.sqrt(Math.max(0, w.radius * w.radius - perp2))
      const t = along - back
      if (t > 0.05 && t < domainClip) domainClip = t
    }
    const hit = this.projectiles.raycast(origin, dir, this.rangedTargets(), domainClip)
    const length = hit
      ? origin.distanceTo(hit.pos)
      : domainClip
    this.projectiles.fireBeam(origin, dir, Math.max(0.4, length), this.player.mods.laser_v2)
    this.cameraRig.addShake(hit ? 0.28 : 0.16)
    if (hit?.id.startsWith('dummy:')) this.hitDummyRanged(hit.id, dir, 'laser')
    // Visual knockback prediction on remote players hit by our laser
    if (hit && !hit.id.startsWith('dummy:')) {
      const av = this.remotes.get(hit.id)
      if (av) {
        av.applyHitImpulse(dir.clone().setY(0).normalize(), LASER.knockback)
        this.effects.damageNumber(av.pos.clone(), DAMAGE.laser * this.domainBuff())
      }
    }
    this.net?.send({
      type: 'ranged',
      kind: 'laser',
      target: hit && !hit.id.startsWith('dummy:') ? hit.id : '',
      dir: [dir.x, dir.y, dir.z],
    })
  }

  private hitDummyRanged(id: string, dir: THREE.Vector3, kind: 'banana' | 'laser') {
    const idx = Number(id.slice(6))
    const dummy = this.dummies[idx]
    if (!dummy || dummy.respawning) return
    let knock = kind === 'banana' ? BANANA.knockback : LASER.knockback
    if (kind === 'laser' && this.player.mods.laser_v2) knock *= 2
    const up = kind === 'banana' ? BANANA.knockUp : LASER.knockUp
    dummy.applyLaunch(
      new CANNON.Vec3(dir.x, 0, dir.z),
      knock * this.player.mods.forceMul * this.domainBuff(),
      up,
      18,
      10,
      0.8
    )
    const dmg = (kind === 'banana' ? DAMAGE.banana : DAMAGE.laser) * this.domainBuff()
    const dp = dummy.torso.position
    this.effects.damageNumber(new THREE.Vector3(dp.x, dp.y + 0.8, dp.z), dmg)
  }

  private fireDomain() {
    this.domainCd = DOMAIN.cooldown
    this.domainTimer = DOMAIN.duration
    this.domainActive = true
    const v2 = this.player.mods.domain_v2
    const pos = new THREE.Vector3(this.player.torso.position.x, this.player.torso.position.y, this.player.torso.position.z)
    this.effects.domain(pos, v2, this.scene, this.world, this.materialGround)
    this.cameraRig.addShake(1.5)
    this.net?.send({ type: 'trigger', kind: 'domain' })

    const radius = (v2 ? DOMAIN.radius * 1.5 : DOMAIN.radius)
    for (const enemy of this.dummies) {
      if (enemy.ko || enemy.respawning) continue
      const d = enemy.torso.position.distanceTo(this.player.torso.position)
      if (d <= radius) {
        const dx = enemy.torso.position.x - this.player.torso.position.x
        const dz = enemy.torso.position.z - this.player.torso.position.z
        const dir = new CANNON.Vec3(dx, 0, dz)
        dir.normalize()
        enemy.applyLaunch(dir, DOMAIN.knockback * DOMAIN.buffKnock, DOMAIN.knockUp, 45, 18, 1.8)
      }
    }
  }

  /** Strength buff: the caster is stronger while their domain is active. */
  private domainBuff(): number {
    return this.domainActive ? DOMAIN.buffKnock : 1
  }

  /** Landing: bounce (upgrade) or bill fall damage to the server. */
  private resolveLanding() {
    const fall = this.player.pendingFall
    if (!fall) return
    this.player.pendingFall = null
    if (this.player.tryBounce(fall.speed)) {
      this.effects.grab(
        new THREE.Vector3(
          this.player.torso.position.x,
          this.player.torso.position.y - 0.5,
          this.player.torso.position.z
        )
      )
      return
    }
    const over = fall.drop - FALL.safeDistance
    if (over <= 0) return
    const dmg = Math.min(FALL.maxDamage, over * FALL.perMetre) * this.player.mods.fallDamageMul
    if (dmg < 1) return
    this.cameraRig.addShake(Math.min(0.6, dmg / 80))
    if (this.net && this.roundLive) this.net.send({ type: 'falldmg', amount: dmg })
  }

  private addRemote(id: string, name: string, tint: number) {
    if (this.remotes.has(id)) return
    const av = new RemoteAvatar(id, name, tint)
    this.remotes.set(id, av)
    this.scene.add(av.group)
  }

  private removeRemote(id: string) {
    const av = this.remotes.get(id)
    if (!av) return
    if (this.heldRemote === av) this.heldRemote = null
    if (this.heldById === id) {
      this.heldById = null
      this.player.isGrabbed = false
      this.player.holdPoint = null
    }
    this.scene.remove(av.group)
    av.dispose()
    this.remotes.delete(id)
  }

  private computeMoveDir(): CANNON.Vec3 | null {
    let f = 0
    let b = 0
    let r = 0
    let l = 0
    if (this.input.forward) f++
    if (this.input.back) b++
    if (this.input.right) r++
    if (this.input.left) l++
    if (f === 0 && b === 0 && r === 0 && l === 0) return null

    const dx = this.cameraRig.forwardX() * (f - b) + this.cameraRig.rightX() * (r - l)
    const dz = this.cameraRig.forwardZ() * (f - b) + this.cameraRig.rightZ() * (r - l)
    const len = Math.hypot(dx, dz)
    if (len < 1e-4) return null
    return new CANNON.Vec3(dx / len, 0, dz / len)
  }

  /** While flying, S is exclusively descend — never backward movement. */
  private computeFlightDir(): CANNON.Vec3 | null {
    const f = this.input.forward ? 1 : 0
    const side = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0)
    if (f === 0 && side === 0) return null
    const dx = this.cameraRig.forwardX() * f + this.cameraRig.rightX() * side
    const dz = this.cameraRig.forwardZ() * f + this.cameraRig.rightZ() * side
    const len = Math.hypot(dx, dz)
    return len > 1e-4 ? new CANNON.Vec3(dx / len, 0, dz / len) : null
  }

  private handlePunch() {
    if (!this.player.isPunchLive() || this.player.grabbedTarget !== null || this.player.climbing) return
    const arm = this.player.limbs[this.player.activeArm]
    const ap = arm.position
    const pf = this.player.facing
    // Big Gorilla's arm is far from the torso and the target is much larger,
    // so the hit window must scale with both attacker and victim size —
    // otherwise a 3x ape swings straight through everything.
    const myScale = this.player.mods.scale
    const punchReach = (PUNCH.hitRadius + PUNCH.bodyPad) * myScale
    for (const enemy of this.dummies) {
      if (enemy.respawning || enemy.ko || this.player.hitSet.has(enemy)) continue
      const ex = enemy.torso.position.x
      const ey = enemy.torso.position.y
      const ez = enemy.torso.position.z
      const victimR = GORILLA.torsoRadius * enemy.mods.scale
      const dist = Math.sqrt((ex - ap.x) ** 2 + (ey - ap.y) ** 2 + (ez - ap.z) ** 2)
      if (dist > punchReach + victimR) continue

      const tox = ex - this.player.torso.position.x
      const toz = ez - this.player.torso.position.z
      if (tox * pf.x + toz * pf.z < -0.3) continue

      const dir = new CANNON.Vec3(tox, 0, toz)
      const dl = dir.length()
      if (dl > 1e-3) dir.scale(1 / dl, dir)
      else dir.set(pf.x, 0, pf.z)

      enemy.takeHit(dir, this.player.mods.forceMul * this.player.mods.punchKnockMul * this.domainBuff())
      this.player.hitSet.add(enemy)
      this.hits++
      this.cameraRig.addShake(0.5)
      this.effects.burst(new THREE.Vector3(ex, ey + 0.5, ez), new THREE.Vector3(dir.x, 0.4, dir.z))
      this.effects.damageNumber(new THREE.Vector3(ex, ey + 0.8, ez), DAMAGE.punch * this.domainBuff())
    }

    if (this.online && this.net) {
      for (const [id, av] of this.remotes) {
        if (this.player.hitSet.has(av as unknown as Gorilla)) continue
        if (av.ko || av.flags & FLAG.respawning) continue
        const dx = av.pos.x - this.player.torso.position.x
        const dz = av.pos.z - this.player.torso.position.z
        const victimR = GORILLA.torsoRadius * av.scale
        const ad = Math.sqrt((av.pos.x - ap.x) ** 2 + (av.pos.y - ap.y) ** 2 + (av.pos.z - ap.z) ** 2)
        if (ad > punchReach + victimR) continue
        if (dx * pf.x + dz * pf.z < -0.3) continue
        const dir = new CANNON.Vec3(dx, 0, dz)
        const dl = dir.length()
        if (dl > 1e-3) dir.scale(1 / dl, dir)
        else dir.set(pf.x, 0, pf.z)
        this.player.hitSet.add(av as unknown as Gorilla)
        this.hits++
        this.net.send({ type: 'punch', target: id, dir: [dir.x, dir.y, dir.z] })
        this.effects.burst(new THREE.Vector3(av.pos.x, av.pos.y + 0.5, av.pos.z), new THREE.Vector3(dir.x, 0.4, dir.z))
        this.cameraRig.addShake(0.4)
        // Immediate visual knockback — the server excludes us from the
        // punched broadcast, so without this the remote wouldn't react on
        // our screen until the victim's real poses arrive ~200 ms later.
        const mul = this.player.mods.forceMul * this.player.mods.punchKnockMul * this.domainBuff()
        av.applyHitImpulse(new THREE.Vector3(dir.x, 0, dir.z), PUNCH.knockback * mul)
        this.effects.damageNumber(av.pos.clone(), DAMAGE.punch * this.domainBuff())
      }
    }
  }

  // ---------------------------------------------------------------- grab ----
  private tryGrab(): boolean {
    if (this.player.ko) return false
    if (this.player.respawning || this.player.climbing || this.player.grabCooldown > 0 || this.heldById) return false

    if (this.player.grabbedTarget !== null || this.heldRemote) {
      this.releaseGrab()
      return true
    }

    const px = this.player.torso.position.x
    const py = this.player.torso.position.y
    const pz = this.player.torso.position.z
    const pf = this.player.facing

    const grabReach = GRAB.reach * this.player.mods.scale
    let bestTarget: Gorilla | null = null
    let bestDist = grabReach

    for (const enemy of this.dummies) {
      if (enemy.respawning || enemy.isGrabbed) continue
      const ex = enemy.torso.position.x
      const ey = enemy.torso.position.y
      const ez = enemy.torso.position.z
      const dx = ex - px
      const dy = ey - py
      const dz = ez - pz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist > grabReach + GORILLA.torsoRadius * enemy.mods.scale) continue

      const dot = (dx * pf.x + dz * pf.z) / (Math.hypot(dx, dz) || 1)
      if (dot < GRAB.angleCos) continue

      if (dist < bestDist) {
        bestDist = dist
        bestTarget = enemy
      }
    }

    if (bestTarget) {
      this.lockDummyGrab(bestTarget)
      return true
    }

    if (this.online && this.net) {
      let best: RemoteAvatar | null = null
      let bestR = grabReach
      for (const av of this.remotes.values()) {
        if (av.flags & FLAG.respawning) continue
        const dx = av.pos.x - px
        const dz = av.pos.z - pz
        const dist = Math.sqrt(dx * dx + (av.pos.y - py) ** 2 + dz * dz)
        if (dist > grabReach + GORILLA.torsoRadius * av.scale) continue
        const dot = (dx * pf.x + dz * pf.z) / (Math.hypot(dx, dz) || 1)
        if (dot < GRAB.angleCos) continue
        if (dist < bestR) {
          bestR = dist
          best = av
        }
      }
      if (best) {
        this.player.startGrabReach(this.player.facing)
        this.heldRemote = best
        best.heldLock = true
        this.net.send({ type: 'grab', target: best.id })
        this.effects.grab(best.pos.clone())
        this.cameraRig.addShake(0.3)
        // Server confirmation timeout: if the server hasn't confirmed the grab
        // within 300ms (rejected due to range/pose desync), roll back so the
        // player doesn't think they're holding someone who's actually free.
        this.grabConfirmTimer = 0.3
        return true
      }
    }
    return false
  }

  private lockDummyGrab(bestTarget: Gorilla) {
    this.player.startGrabReach(this.player.facing)
    this.player.grabbedTarget = bestTarget
    bestTarget.grabbedBy = this.player
    bestTarget.isGrabbed = true
    bestTarget.grabTimer = 0
    // Hold distance scales with the *sum* of torso radii so a Big Gorilla
    // (scale 3) grabs cleanly without the constraint fighting sphere
    // collision. sqrt-scale placed the held body inside the colliders.
    const hold = GORILLA.torsoRadius * (this.player.mods.scale + bestTarget.mods.scale) + 0.2
    this.grabConstraint = new CANNON.PointToPointConstraint(
      this.player.torso,
      new CANNON.Vec3(0, 0, -hold),
      bestTarget.torso,
      new CANNON.Vec3(0, 0, 0),
      GRAB.constraintMaxForce
    )
    this.world.addConstraint(this.grabConstraint)
    this.effects.grab(new THREE.Vector3(bestTarget.torso.position.x, bestTarget.torso.position.y, bestTarget.torso.position.z))
    this.cameraRig.addShake(0.3)
  }

  /**
   * Single cleanup path for a grab. Safe to call anytime: removes the physics
   * constraint (if any) and clears grab flags on BOTH gorillas. This must run
   * when either party starts falling — tickRespawn used to null pointers
   * without removing the constraint, which permanently welded a dummy to the
   * player (or left the dummy isGrabbed forever so it stopped wandering).
   */
  private releaseGrab() {
    if (this.grabConstraint) {
      this.world.removeConstraint(this.grabConstraint)
      this.grabConstraint = null
    }
    const target = this.player.grabbedTarget
    if (target) {
      target.isGrabbed = false
      target.grabbedBy = null
      target.grabTimer = 0
    }
    // Pointers may already have been cleared by a respawn; sweep anyway.
    for (const d of this.dummies) {
      if (d.grabbedBy === this.player || d.isGrabbed) {
        d.isGrabbed = false
        d.grabbedBy = null
        d.grabTimer = 0
      }
    }
    this.player.grabbedTarget = null
    this.player.grabCooldown = GRAB.cooldown
    this.chargingThrow = false
    this.throwCharge = 0
    // Also clear the victim-side bookkeeping: if the local player was the one
    // being held (e.g. a KO cleared the grab mid-hold), don't leave heldById
    // pointing at a possibly-leaving holder.
    this.heldById = null
    this.player.isGrabbed = false
    this.player.holdPoint = null
    if (this.heldRemote) {
      this.heldRemote.heldLock = false
      this.heldRemote = null
      this.net?.send({ type: 'release' })
    }
  }

  /** Drop the grab the moment either body starts a void-fall. */
  private syncGrabState() {
    const target = this.player.grabbedTarget
    if (this.grabConstraint && (!target || target.respawning || this.player.respawning)) {
      this.releaseGrab()
    } else if (target && (target.respawning || this.player.respawning)) {
      this.releaseGrab()
    }
  }

  private performSlam() {
    if (this.heldRemote && this.net) {
      const pf = this.player.facing
      const slamDir = new CANNON.Vec3(pf.x * GRAB.slamForward, GRAB.slamUp, pf.z * GRAB.slamForward)
      const len = slamDir.length()
      if (len > 1e-3) slamDir.scale(1 / len, slamDir)
      this.net.send({ type: 'slam', dir: [slamDir.x, slamDir.y, slamDir.z] })
      this.player.torso.applyImpulse(new CANNON.Vec3(-pf.x * 12, 4, -pf.z * 12))
      // Visual knockback prediction on the held remote (server excludes us).
      const mul = this.player.mods.forceMul * this.domainBuff()
      const f3 = new THREE.Vector3(slamDir.x, slamDir.y, slamDir.z)
      const victimPos = this.heldRemote.pos.clone()
      this.heldRemote.applyHitImpulse(f3, GRAB.slamForce * mul)
      this.effects.slam(victimPos)
      this.effects.damageNumber(victimPos, DAMAGE.slam, true)
      this.cameraRig.addShake(0.85)
      this.releaseGrab()
      return
    }
    const target = this.player.grabbedTarget
    if (!target) return

    const targetPos = new THREE.Vector3(target.torso.position.x, target.torso.position.y, target.torso.position.z)
    this.releaseGrab()

    const pf = this.player.facing
    const slamDir = new CANNON.Vec3(pf.x * GRAB.slamForward, GRAB.slamUp, pf.z * GRAB.slamForward)
    const len = slamDir.length()
    if (len > 1e-3) slamDir.scale(1 / len, slamDir)

    const slamForce = GRAB.slamForce * this.player.mods.forceMul
    target.torso.applyImpulse(
      new CANNON.Vec3(slamDir.x * slamForce, slamDir.y * slamForce, slamDir.z * slamForce),
      new CANNON.Vec3(0, 0.4, 0)
    )

    target.torso.angularVelocity.set(
      (Math.random() - 0.5) * 35,
      (Math.random() - 0.5) * 35,
      (Math.random() - 0.5) * 35
    )
    for (const limb of target.limbs) {
      limb.applyImpulse(
        new CANNON.Vec3(
          (Math.random() * 2 - 1) * GRAB.limbFlail,
          Math.random() * GRAB.limbFlail * 1.4,
          (Math.random() * 2 - 1) * GRAB.limbFlail
        )
      )
    }

    target.staggerTimer = GRAB.slamStaggerTime

    // Player recoil
    this.player.torso.applyImpulse(new CANNON.Vec3(-pf.x * 12, 4, -pf.z * 12))

    this.slams++
    this.cameraRig.addShake(0.85)
    this.effects.slam(targetPos)
  }

  private performThrow(charge01: number) {
    // Remote player throw: send to server + visual prediction (no local physics).
    if (this.heldRemote && this.net) {
      const pf = this.player.facing
      const h = Math.hypot(pf.x, pf.z) || 1
      const hx = pf.x / h
      const hz = pf.z / h
      const dir: [number, number, number] = [hx, 0, hz]
      this.net.send({ type: 'throw', dir, charge: charge01 })
      const base = THROW.minForce + (THROW.maxForce - THROW.minForce) * charge01
      const force = base * this.player.mods.forceMul
      const victimPos = this.heldRemote.pos.clone()
      this.heldRemote.applyHitImpulse(new THREE.Vector3(hx, 0.6, hz), force)
      this.effects.throw(victimPos, new THREE.Vector3(hx, 0, hz))
      this.effects.damageNumber(victimPos, DAMAGE.throwBase + DAMAGE.throwCharged * charge01, true)
      this.player.torso.applyImpulse(
        new CANNON.Vec3(-pf.x * 18 * (0.5 + charge01), 3, -pf.z * 18 * (0.5 + charge01))
      )
      this.throws++
      this.cameraRig.addShake(0.6 + charge01 * 0.5)
      this.releaseGrab()
      return
    }

    const target = this.player.grabbedTarget
    if (!target) return

    const targetPos = new THREE.Vector3(target.torso.position.x, target.torso.position.y, target.torso.position.z)
    this.releaseGrab()

    const pf = this.player.facing
    // Throw along the facing plane. forceMul scales the HORIZONTAL launch (so
    // a giant hurls the victim 3x farther), while the vertical pop stays at
    // base value — otherwise a 3x throw would launch straight up.
    const h = Math.hypot(pf.x, pf.z) || 1
    const hx = pf.x / h
    const hz = pf.z / h
    const base = THROW.minForce + (THROW.maxForce - THROW.minForce) * charge01
    const force = base * this.player.mods.forceMul
    const upImpulse = base * THROW.up
    const spin = THROW.minSpin + (THROW.maxSpin - THROW.minSpin) * charge01

    target.torso.applyImpulse(
      new CANNON.Vec3(hx * force, upImpulse, hz * force),
      new CANNON.Vec3(0, 0.3, 0)
    )

    target.torso.angularVelocity.set(
      (Math.random() - 0.5) * spin,
      (Math.random() - 0.5) * spin,
      (Math.random() - 0.5) * spin
    )

    for (const limb of target.limbs) {
      limb.applyImpulse(
        new CANNON.Vec3(
          (Math.random() * 2 - 1) * THROW.limbFlail,
          Math.random() * THROW.limbFlail * 1.5,
          (Math.random() * 2 - 1) * THROW.limbFlail
        )
      )
    }

    target.staggerTimer = 1.5

    // Player recoil scales with charge
    this.player.torso.applyImpulse(
      new CANNON.Vec3(-pf.x * 18 * (0.5 + charge01), 3, -pf.z * 18 * (0.5 + charge01))
    )

    this.throws++
    this.cameraRig.addShake(0.6 + charge01 * 0.5)
    this.effects.throw(targetPos, new THREE.Vector3(hx, 0, hz))
  }

  // -------------------------------------------------------------- climb ----
  // nx/nz is the surface's OUTWARD normal (surface → climber). d is signed
  // distance from the surface. along is unused for poles (full 360°).
  private climbMetrics(z: ClimbZone) {
    const t = this.player.torso
    if (z.kind === 'pole') {
      const dx = t.position.x - z.cx
      const dz = t.position.z - z.cz
      const len = Math.hypot(dx, dz) || 0.0001
      return { nx: dx / len, nz: dz / len, d: len - z.radius, along: 0, offSide: false }
    }
    const nx = z.axis === 'x' ? z.normal : 0
    const nz = z.axis === 'z' ? z.normal : 0
    const d = z.axis === 'x' ? (t.position.x - z.plane) * z.normal : (t.position.z - z.plane) * z.normal
    const along = z.axis === 'x' ? t.position.z : t.position.x
    const offSide = Math.abs(along - z.center) > z.halfLen + CLIMB.sidePadding
    return { nx, nz, d, along, offSide }
  }

  private findClimbZone(
    mode: 'ground' | 'air',
    reachOverride?: number,
    exclude?: ClimbZone
  ): ClimbZone | null {
    const t = this.player.torso
    const reach = reachOverride ?? (mode === 'air' ? CLIMB.reachAir : CLIMB.reachGround)
    let best: ClimbZone | null = null
    let bestD = reach
    for (const z of CLIMB_ZONES) {
      if (z === exclude) continue
      if (t.position.y < z.baseY - CLIMB.verticalPadding || t.position.y > z.topY + CLIMB.verticalPadding) continue
      const { nx, nz, d, offSide } = this.climbMetrics(z)
      if (d < -CLIMB.negativeSlack || d > reach) continue
      if (offSide) continue
      if (mode === 'ground') {
        const faceDot = this.player.facing.x * -nx + this.player.facing.z * -nz
        if (faceDot < CLIMB.groundFacingMin) continue
      }
      if (d < bestD) {
        bestD = d
        best = z
      }
    }
    return best
  }

  private updateClimb() {
    const z = this.player.climbZone
    if (!z) {
      this.exitClimb(false, 0, 0)
      return
    }
    const t = this.player.torso
    const { nx, nz, d, offSide } = this.climbMetrics(z)
    const upIn = this.input.forward ? 1 : this.input.back ? -1 : 0
    const latIn = this.input.left ? 1 : this.input.right ? -1 : 0

    const leaving =
      d > CLIMB.stayReach ||
      offSide ||
      t.position.y < z.baseY - CLIMB.stayVerticalSlack

    // Reached a face edge, overhang, or stacked ledge: glue onto the next
    // nearby surface instead of dropping. This is what lets a gorilla crawl
    // around corners and keep going up messy terrain.
    if (leaving || (upIn > 0 && t.position.y >= z.topY - 0.2)) {
      const next = this.findClimbZone('air', CLIMB.wrapSearch, z)
      if (next) {
        this.attachWall(next, true)
        return
      }
    }

    if (leaving) {
      this.exitClimb(false, nx, nz)
      return
    }

    // Keep climbing above the lip before releasing into a physical inward
    // mantle. This avoids the old position teleport and clears the collider.
    if (t.position.y >= z.topY + CLIMB.mantleHeight) {
      this.exitClimb(true, nx, nz)
      return
    }

    // Pressing down at the bottom of this surface → drop off.
    if (upIn < 0 && t.position.y <= z.baseY + 0.3) {
      this.exitClimb(false, nx, nz)
      return
    }

    this.player.facing.set(-nx, 0, -nz)
    const normalVelocity = t.velocity.x * nx + t.velocity.z * nz
    const inward = clamp(
      (CLIMB.attachDistance - d) * CLIMB.surfaceSpring - normalVelocity * CLIMB.surfaceDamping,
      -CLIMB.maxSurfaceSpeed,
      CLIMB.maxSurfaceSpeed
    )
    // Climb speed is an "action", so Big/Tiny scale it too.
    const act = this.player.mods.actionMul
    const vel = new CANNON.Vec3(
      nx * inward - nz * (latIn * CLIMB.lateralSpeed * act),
      upIn * CLIMB.speed * act,
      nz * inward + nx * (latIn * CLIMB.lateralSpeed * act)
    )
    this.player.controlClimb(vel)
  }

  private attachWall(zone: ClimbZone, silent = false) {
    const t = this.player.torso
    const { nx, nz } = this.climbMetrics(zone)
    // No position or velocity snap: a short inward impulse catches the body,
    // then the spring controller reels it smoothly toward attachDistance.
    t.applyImpulse(new CANNON.Vec3(-nx * CLIMB.latchImpulse, 2.5, -nz * CLIMB.latchImpulse))
    this.player.startClimb(zone)
    this.wallGrabBuffer = 0
    if (!silent) {
      this.effects.grab(new THREE.Vector3(t.position.x, t.position.y, t.position.z))
      this.cameraRig.addShake(0.25)
    }
  }

  private wallNormal(): { x: number; z: number } {
    const z = this.player.climbZone
    if (!z) return { x: 0, z: 0 }
    const m = this.climbMetrics(z)
    return { x: m.nx, z: m.nz }
  }

  private wallJump() {
    const n = this.wallNormal()
    const t = this.player.torso
    this.exitClimb(false, n.x, n.z)
    t.applyImpulse(new CANNON.Vec3(n.x * CLIMB.wallJumpOut, CLIMB.wallJumpUp, n.z * CLIMB.wallJumpOut))
    this.player.markJumped()
    this.cameraRig.addShake(0.18)
  }

  private exitClimb(popUp: boolean, nx: number, nz: number) {
    const p = this.player
    if (!p.climbing) return
    const zone = p.climbZone
    p.climbing = false
    p.climbZone = null
    p.climbVel.set(0, 0, 0)
    p.markClimbExit() // brief re-attach lock-out so letting go can't instantly re-latch
    if (popUp) {
      // Physical mantle: preserve lateral momentum and surge up + inward.
      // The torso already climbed above the lip, so no teleport is necessary.
      const t = p.torso
      const direction = zone?.kind === 'pole' ? 1 : -1
      t.velocity.x += nx * CLIMB.mantleInSpeed * direction
      t.velocity.z += nz * CLIMB.mantleInSpeed * direction
      t.velocity.y = Math.max(t.velocity.y, CLIMB.mantleUpSpeed)
      p.markJumped()
    } else {
      // Push off the wall so the torso clears the attach threshold cleanly
      p.torso.velocity.x += nx * CLIMB.exitPush
      p.torso.velocity.z += nz * CLIMB.exitPush
    }
  }

  // ----------------------------------------------------------------- loop ---
  private loop = () => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    let dt = this.clock.getDelta()
    // Capture the raw frame delta before clamping so the HUD FPS counter
    // reflects real hitches (otherwise it never drops below 20 = 1/0.05).
    const rawDt = dt
    if (dt > 0.05) dt = 0.05

    // Drop a grab the instant either body is falling into the void, BEFORE
    // input/physics run, so a constraint can never pull someone off the map.
    this.syncGrabState()

    // Input processing
    const move = this.player.flying ? this.computeFlightDir() : this.computeMoveDir()
    this.player.controlMove(move)
    this.player.sprinting = this.input.sprintHeld

    const wantsGrab = this.input.consumeGrab()
    const wantsSlam = this.input.consumeSlam()
    const wantsPunch = this.input.consumePunch()
    const wantsJump = this.input.consumeJump()
    if (!this.online && this.input.consumeUpgrade()) {
      this.practicePicker = !this.practicePicker
      this.flushStats()
    }
    const throwPressed = this.input.consumeThrowPressed()
    const throwReleased = this.input.consumeThrowReleased()
    this.wallGrabBuffer = Math.max(0, this.wallGrabBuffer - dt)
    if (wantsGrab && !this.player.climbing && !this.player.isGrounded()) {
      this.wallGrabBuffer = CLIMB.grabBuffer
    }

    // Knocked out: limp ragdoll, no verbs at all until the round resets.
    if (this.player.ko) {
      this.chargingThrow = false
      this.throwCharge = 0
    } else if (this.player.grabbedTarget !== null || this.heldRemote) {
      if (!this.chargingThrow && throwPressed) {
        this.chargingThrow = true
        this.throwCharge = 0
      }
      if (this.chargingThrow) {
        this.throwCharge = Math.min(1, this.throwCharge + dt / THROW.chargeTime)
        if (this.player.grabbedTarget) {
          // Windup: tug the held gorilla back and up
          const pf = this.player.facing
          this.player.grabbedTarget.torso.applyForce(new CANNON.Vec3(-pf.x * 42, 26, -pf.z * 42))
        }
        this.cameraRig.addShake(0.04)
      }
      if (this.chargingThrow && throwReleased) {
        this.performThrow(this.throwCharge)
        this.chargingThrow = false
        this.throwCharge = 0
      } else if (wantsSlam) {
        this.performSlam()
        this.chargingThrow = false
        this.throwCharge = 0
      } else if (wantsGrab) {
        this.releaseGrab()
        this.chargingThrow = false
        this.throwCharge = 0
      } else if (wantsJump && !this.chargingThrow) {
        this.player.tryJump()
      }
    } else {
      if (throwPressed || throwReleased) {
        this.chargingThrow = false // discard stale throw inputs
        this.throwCharge = 0
      }
      if (this.player.climbing) {
        if (wantsJump) this.wallJump()
        else if (wantsGrab) this.exitClimb(false, this.wallNormal().x, this.wallNormal().z)
      } else if (!this.heldById) {
        // Flight upgrade: a second jump press while airborne toggles flight.
        if (wantsJump) {
          if (!this.player.tryJump() && this.player.mods.flight) this.player.toggleFlight()
        }
        if (wantsGrab) {
          // E: grounded dummies take priority. Otherwise grab a wall — tight
          // reach + facing check when grounded (avoids accidental latches
          // while just walking around), generous reach when airborne (a jump
          // at a wall is already a deliberate act).
          if (this.player.isGrounded()) {
            const dummyGrabbed = this.tryGrab()
            if (!dummyGrabbed && this.player.canClimb()) {
              const zone = this.findClimbZone('ground')
              if (zone) this.attachWall(zone)
            }
          } else if (this.player.canClimb()) {
            const zone = this.findClimbZone('air')
            if (zone) this.attachWall(zone)
            else this.wallGrabBuffer = CLIMB.grabBuffer // latch when the jump reaches the wall
          }
        } else if (wantsPunch) {
          // Both ranged upgrades replace the primary attack. Laser firing is
          // handled by the held-input path below; Banana Gun fires per click.
          if (this.player.mods.banana) this.fireBanana()
          else if (!this.player.mods.laser) this.player.startPunch(this.player.facing)
        }
      }
    }

    // Apply held flight controls after jump processing. A jump press that
    // *activates* flight is deliberately not a rise command: release Space
    // once, then hold it when you actually want to climb.
    this.player.setFlightControls(this.input.jumpHeld, this.input.back)

    this.bananaCd = Math.max(0, this.bananaCd - dt)
    this.laserCd = Math.max(0, this.laserCd - dt)
    this.domainCd = Math.max(0, this.domainCd - dt)
    this.domainTimer = Math.max(0, this.domainTimer - dt)
    this.domainActive = this.domainTimer > 0

    // Grab confirmation timeout: if the server didn't confirm within the
    // window, the grab was rejected (range/pose desync). Roll back so the
    // player doesn't think they're holding someone who's actually free.
    if (this.grabConfirmTimer > 0) {
      this.grabConfirmTimer -= dt
      if (this.grabConfirmTimer <= 0 && this.heldRemote && !this.player.grabbedTarget) {
        this.heldRemote.heldLock = false
        this.heldRemote = null
      }
    }

    if (this.player.laserInterrupt > 0 && this.input.punchHeld) this.laserNeedsRelease = true
    if (!this.input.punchHeld) this.laserNeedsRelease = false
    const canLaser =
      this.player.mods.laser &&
      !this.player.ko &&
      !this.player.climbing &&
      !this.player.isGrabbed &&
      this.player.grabbedTarget === null &&
      !this.chargingThrow &&
      !this.laserNeedsRelease
    if (this.input.punchHeld && canLaser) {
      const aim = this.getMouseFacing()
      if (aim) this.player.facing.copy(aim)
      this.fireLaser()
    }

    const wantsTrigger = this.input.consumeTrigger()
    if (wantsTrigger && this.player.mods.domain && this.domainCd <= 0 && !this.player.ko && this.roundLive) {
      this.fireDomain()
    }

    // Sprint/flight boost gets a visual kick in addition to raw speed.
    const targetFov = this.input.sprintHeld ? SPRINT.fov : 55
    this.cameraRig.camera.fov += (targetFov - this.cameraRig.camera.fov) * (1 - Math.exp(-8 * dt))
    this.cameraRig.camera.updateProjectionMatrix()

    // --- Climbing (stay attached + move along the wall) ---
    if (this.player.climbing) {
      if (this.player.respawning || this.player.grabbedTarget !== null) this.exitClimb(false, 0, 0)
      else this.updateClimb()
    } else if (
      this.wallGrabBuffer > 0 &&
      !this.player.respawning &&
      this.player.grabbedTarget === null &&
      this.player.canClimb()
    ) {
      const zone = this.findClimbZone('air')
      if (zone) this.attachWall(zone)
    }

    for (const d of this.dummies) d.controlWander(dt)

    // Escape / Struggle timer — dummy breaks free after GRAB.escapeTime.
    // Respawn-triggered drops are handled by syncGrabState (no fake "escape" hit).
    if (this.player.grabbedTarget !== null) {
      const target = this.player.grabbedTarget
      target.grabTimer += dt
      if (target.grabTimer >= GRAB.escapeTime) {
        const tPos = new THREE.Vector3(target.torso.position.x, target.torso.position.y, target.torso.position.z)
        this.releaseGrab()
        target.takeHit(new CANNON.Vec3(-this.player.facing.x, 0.2, -this.player.facing.z))
        this.effects.escape(tPos)
      }
    }

    // Per-gorilla assist (drag, clamp, upright, facing, climb physics)
    for (const g of this.gorillas) g.preStep(dt)

    // Physics step
    this.world.step(PHYS.fixedTimeStep, dt, PHYS.maxSubSteps)

    // Resolve punch hits
    this.handlePunch()

    // Respawn bookkeeping. tickRespawn may START a fall this frame (teleport
    // the body to y=-1000); sync grab/climb immediately so the next physics
    // step never solves a constraint stretched into the void.
    // Falling out of the world is an instant KO in a live round, regardless
    // of remaining health.
    if (
      this.online &&
      this.roundLive &&
      !this.player.ko &&
      !this.player.respawning &&
      this.player.torso.position.y < RESPAWN.fallY
    ) {
      this.net?.send({ type: 'void' })
    }
    for (const g of this.gorillas) {
      if (g.tickRespawn(dt)) this.respawns++
    }
    this.syncGrabState()
    if (this.player.respawning && this.player.climbing) {
      this.exitClimb(false, 0, 0)
    }

    // Update in-range visual prompts
    this.updateGrabPrompts()

    // Phase 5: bill the landing (bounce or fall damage) once per touchdown.
    this.resolveLanding()

    // Destructible trees: regrow any whose timer elapsed.
    this.treeRegrowTimer += dt
    if (this.treeRegrowTimer > 0.5) {
      this.treeRegrowTimer = 0
      this.treeApis?.regrowTrees()
    }

    // Visuals sync
    for (const g of this.gorillas) g.sync()
    if (this.online) {
      if (this.heldById) {
        const holder = this.remotes.get(this.heldById)
        if (holder) {
          this.player.holdPoint = {
            x: holder.pos.x + holder.facing.x * GRAB.holdDistance,
            y: holder.pos.y,
            z: holder.pos.z + holder.facing.z * GRAB.holdDistance,
          }
        }
      }
      if (this.heldRemote) {
        this.heldRemote.holdAt(
          this.player.torso.position.x,
          this.player.torso.position.y,
          this.player.torso.position.z,
          this.player.facing.x,
          this.player.facing.z,
          GRAB.holdDistance
        )
      }
      // Shared wall-clock (Date.now() + clockSkew) so peers that booted at
      // different times see the same interpolation window.
      const now = this.net ? this.net.netClock() : Date.now()
      for (const [id, av] of this.remotes) {
        const info = this.net?.players.get(id)
        if (info) {
          av.setHealth(info.hp, info.maxHp)
          av.ko = info.ko
          av.domainUntil = info.domainUntil || 0
          if (info.upgrades.length !== av.upgrades.length) av.setUpgrades(info.upgrades)
        }
        av.sample(now, this.cameraRig.camera)
      }
      const me = this.net?.id ? this.net.players.get(this.net.id) : null
      if (me) {
        this.localHp = me.hp
        if (me.ko && !this.player.ko) this.player.knockOut()
      }
      this.poseAcc += dt
      if (this.poseAcc >= 1 / NET.poseHz && this.net && this.net.id) {
        this.poseAcc = 0
        const flags =
          (this.player.climbing ? FLAG.climbing : 0) |
          (this.player.punching ? FLAG.punching : 0) |
          (this.player.isGrabbed ? FLAG.grabbed : 0) |
          (this.player.respawning ? FLAG.respawning : 0) |
          (this.player.ko ? FLAG.ko : 0) |
          (this.player.flying ? FLAG.flying : 0)
        const pose = this.player.snapshot(now, flags)
        pose.id = this.net.id
        this.net.send(pose)
      }
    }

    // Projectiles
    this.effects.update(dt)
    this.projectiles.update(
      dt,
      this.rangedTargets(),
      (id, at, dir, key) => {
        this.effects.burst(at, new THREE.Vector3(dir.x, 0.4, dir.z))
        this.cameraRig.addShake(0.25)
        if (id.startsWith('dummy:')) this.hitDummyRanged(id, dir, 'banana')
        else if (key) {
          this.net?.send({ type: 'ranged', kind: 'banana', impact: key, target: id })
          // Immediate visual feedback (server excludes us from the echo)
          const av = this.remotes.get(id)
          if (av) {
            av.applyHitImpulse(dir.clone().setY(0).normalize(), BANANA.knockback)
            this.effects.damageNumber(av.pos.clone(), DAMAGE.banana)
          }
        }
      },
      this.effects.domainWalls()
    )

    // Camera
    const ep = this.player.effectivePosition()
    this.highlight.visible = !this.player.respawning && !this.player.ko
    this.highlight.position.x = ep.x
    this.highlight.position.z = ep.z
    const gh = groundHeightAt(ep.x, ep.z, ep.y)
    this.highlight.position.y = (gh > -100 ? gh : 0) + 0.05
    const pulse = 1 + 0.06 * Math.sin(this.clock.elapsedTime * 4)
    this.highlight.scale.setScalar(pulse)
    this.cameraRig.applyOrbit(this.input.consumeOrbit())
    this.cameraRig.applyZoom(this.input.consumeZoom())
    this.cameraRig.update(ep.x, ep.y, ep.z, dt)

    this.renderer.render(this.scene, this.cameraRig.camera)

    this.statTimer += dt
    const climbReady =
      this.player.canClimb() &&
      this.player.grabbedTarget === null &&
      this.findClimbZone(this.player.isGrounded() ? 'ground' : 'air') !== null
    if (
      this.chargingThrow ||
      this.player.climbing ||
      this.domainActive ||
      this.practicePicker ||
      this.statTimer > 0.2
    ) {
      this.statTimer = 0
      this.onStats?.({
        respawns: this.respawns,
        hits: this.hits,
        slams: this.slams,
        throws: this.throws,
        holding: this.player.grabbedTarget !== null || this.heldRemote !== null,
        charge: this.chargingThrow ? this.throwCharge : 0,
        climbing: this.player.climbing,
        climbReady,
        fps: Math.round(1 / Math.max(rawDt, 1e-4)),
        room: this.net?.room || '',
        peers: this.remotes.size + (this.online ? 1 : 0),
        hp: this.localHp,
        maxHp: HEALTH.max * this.player.mods.healthMul,
        ko: this.player.ko,
        flying: this.player.flying,
        flightLeft: this.player.flightTimer,
        flightRecharge: this.player.flightCooldown,
        practicePicker: this.practicePicker,
        practiceUpgrades: this.practiceUpgrades,
      })
    }
  }

  private updateGrabPrompts() {
    const px = this.player.torso.position.x
    const py = this.player.torso.position.y
    const pz = this.player.torso.position.z
    const pf = this.player.facing
    const grabReach = GRAB.reach * this.player.mods.scale

    for (const enemy of this.dummies) {
      if (this.player.grabbedTarget === enemy || this.player.climbing) {
        enemy.setInGrabRange(false)
        continue
      }
      const ex = enemy.torso.position.x
      const ey = enemy.torso.position.y
      const ez = enemy.torso.position.z
      const dx = ex - px
      const dy = ey - py
      const dz = ez - pz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const dot = (dx * pf.x + dz * pf.z) / (Math.hypot(dx, dz) || 1)

      const inRange =
        !this.player.respawning &&
        this.player.grabbedTarget === null &&
        dist <= grabReach &&
        dot >= GRAB.angleCos

      enemy.setInGrabRange(inRange)
    }
  }
}