/**
 * Gorilla — spherical ragdoll (1 torso sphere + 4 limb spheres) with
 * ConeTwist joints. Visuals (head/face/hands) are parented to those bodies.
 *
 * Locomotion is force-based on the torso plus a PD "gait" that aims the
 * limbs. Hits temporarily disable the upright assist so the body tumbles.
 * Climbing, grabbing, and punching are flags consumed by Game; this class
 * does not own the grab constraint or climb-zone search.
 */
import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import {
  GROUND_GROUP,
  GORILLA,
  MOVEMENT,
  UPRIGHT,
  RESPAWN,
  ARENA,
  PUNCH,
  DUMMY,
  PHYS,
  JUMP,
  CLIMB,
  FALL,
  FLIGHT,
  BOUNCE,
  SPRINT,
  baseMods,
  type Mods,
} from './constants'
import type { ClimbZone } from './Arena'
import { clamp } from './utils'

export interface GorillaTheme {
  body: number
  bodyDark: number
  muzzle: number
  silver?: number
}

const UP = new CANNON.Vec3(0, 1, 0)
const FWD = new CANNON.Vec3(0, 0, -1) // local forward (the face points this way)

// Shared, reused geometry across all gorillas.
const GEO = {
  torso: new THREE.IcosahedronGeometry(GORILLA.torsoRadius, 1),
  limb: new THREE.IcosahedronGeometry(GORILLA.limbRadius, 1),
  head: new THREE.IcosahedronGeometry(0.36, 1),
  crest: new THREE.BoxGeometry(0.34, 0.16, 0.34),
  brow: new THREE.BoxGeometry(0.4, 0.1, 0.12),
  muzzle: new THREE.IcosahedronGeometry(0.24, 1),
  eye: new THREE.SphereGeometry(0.085, 12, 10),
  pupil: new THREE.SphereGeometry(0.045, 8, 6),
  ear: new THREE.IcosahedronGeometry(0.16, 0),
  patch: new THREE.IcosahedronGeometry(0.34, 1),
  hand: new THREE.IcosahedronGeometry(0.2, 0),
  foot: new THREE.BoxGeometry(0.26, 0.16, 0.34),
  star: new THREE.OctahedronGeometry(0.14, 0),
  prompt: new THREE.ConeGeometry(0.2, 0.35, 4),
}

export class Gorilla {
  group = new THREE.Group()
  torso: CANNON.Body
  limbs: CANNON.Body[] = []
  allBodies: CANNON.Body[] = []

  facing = new CANNON.Vec3(0, 0, -1)
  theme: GorillaTheme
  isPlayer: boolean
  spawn: CANNON.Vec3

  // respawn state
  respawning = false
  respawnTimer = 0

  // punch state
  punching = false
  punchTimer = 0
  punchCooldown = 0
  activeArm = 0
  private nextArm = 0
  private grabReachTimer = 0
  hitSet = new Set<Gorilla>()

  // grab state (Phase 2)
  isGrabbed = false
  grabbedTarget: Gorilla | null = null
  grabbedBy: Gorilla | null = null
  grabTimer = 0
  grabCooldown = 0

  staggerTimer = 0
  /** World-space point a net grabber wants this torso sprung toward. */
  holdPoint: { x: number; y: number; z: number } | null = null

  // ---- Phase 5: upgrades / health / flight ----
  mods: Mods = baseMods()
  /** Knocked out: ragdoll goes limp and stops acting until the round ends. */
  ko = false
  flightTimer = 0
  flightCooldown = 0
  flying = false
  flyRise = false
  flySink = false
  /** Flight activation requires releasing Space once before Space can rise. */
  private flightRiseArmed = true
  /** Pure horizontal cruise unit vector supplied by Game each frame. */
  flyDir = { x: 0, z: 0 }
  sprinting = false
  /** Set by takeHit; while > 0 the laser can't fire (interrupts a held beam). */
  laserInterrupt = 0
  /** Highest point reached since leaving the ground, for fall damage. */
  private apexY = 0
  private airborne = false
  /** Set on landing: {drop, speed}. Game consumes it to bill fall damage. */
  pendingFall: { drop: number; speed: number } | null = null
  private constraints: CANNON.ConeTwistConstraint[] = []
  private basePivots: CANNON.Vec3[] = []
  private appliedScale = 1

  // climb state (Phase 3)
  climbing = false
  climbZone: ClimbZone | null = null
  climbVel = new CANNON.Vec3()
  private groundResolver: (x: number, z: number, belowY: number) => number = () => 0
  private jumpCooldown = 0
  private jumpIgnoreStance = 0
  private coyote = 0
  private climbCooldown = 0

  // Locomotion intent is consumed by the physics gait in preStep.
  private moveIntent: CANNON.Vec3 | null = null
  private gaitTime = 0

  // wander state (dummies)
  private wanderTimer = 0
  private wanderDir = new CANNON.Vec3(0, 0, -1)

  // visual feedback objects
  private struggleGroup = new THREE.Group()
  private promptMesh!: THREE.Mesh
  private bananaGun = new THREE.Group()
  private meshLinks: { mesh: THREE.Object3D; body: CANNON.Body; baseScale: THREE.Vector3 }[] = []
  private materials: THREE.Material[] = []
  private collisionGroup: number
  private collisionMask: number
  private material: CANNON.Material

  constructor(
    world: CANNON.World,
    material: CANNON.Material,
    theme: GorillaTheme,
    isPlayer: boolean,
    index: number,
    total: number,
    spawn: CANNON.Vec3
  ) {
    this.theme = theme
    this.isPlayer = isPlayer
    this.spawn = spawn.clone()
    this.material = material

    // Per-instance collision group: own parts never collide with each other
    // (kills self-jitter), but do collide with the ground and every other gorilla.
    this.collisionGroup = 1 << (index + 1)
    this.collisionMask = GROUND_GROUP
    for (let j = 0; j < total; j++) if (j !== index) this.collisionMask |= 1 << (j + 1)

    this.torso = this.addBody(world, new CANNON.Sphere(GORILLA.torsoRadius), spawn.clone(), GORILLA.torsoMass)

    const r = GORILLA.limbRadius
    const armL = this.addBody(world, new CANNON.Sphere(r), spawn.clone().vadd(new CANNON.Vec3(-GORILLA.shoulderX, -0.05, 0)), GORILLA.limbMass)
    const armR = this.addBody(world, new CANNON.Sphere(r), spawn.clone().vadd(new CANNON.Vec3(GORILLA.shoulderX, -0.05, 0)), GORILLA.limbMass)
    const legL = this.addBody(world, new CANNON.Sphere(r), spawn.clone().vadd(new CANNON.Vec3(-GORILLA.hipX, -0.72, GORILLA.hipZ)), GORILLA.limbMass)
    const legR = this.addBody(world, new CANNON.Sphere(r), spawn.clone().vadd(new CANNON.Vec3(GORILLA.hipX, -0.72, GORILLA.hipZ)), GORILLA.limbMass)
    this.limbs = [armL, armR, legL, legR]

    this.link(world, armL, new CANNON.Vec3(-GORILLA.shoulderX, GORILLA.shoulderY, 0), GORILLA.coneAngleArm)
    this.link(world, armR, new CANNON.Vec3(GORILLA.shoulderX, GORILLA.shoulderY, 0), GORILLA.coneAngleArm)
    this.link(world, legL, new CANNON.Vec3(-GORILLA.hipX, GORILLA.hipY, GORILLA.hipZ), GORILLA.coneAngleLeg)
    this.link(world, legR, new CANNON.Vec3(GORILLA.hipX, GORILLA.hipY, GORILLA.hipZ), GORILLA.coneAngleLeg)

    this.buildVisuals()
    this.resetPose(spawn.clone())
  }

  private addBody(world: CANNON.World, shape: CANNON.Shape, pos: CANNON.Vec3, mass: number): CANNON.Body {
    const b = new CANNON.Body({
      mass,
      position: pos,
      material: this.material,
      linearDamping: GORILLA.linearDamping,
      angularDamping: GORILLA.angularDamping,
    })
    b.addShape(shape)
    b.collisionFilterGroup = this.collisionGroup
    b.collisionFilterMask = this.collisionMask
    b.allowSleep = false
    world.addBody(b)
    this.allBodies.push(b)
    return b
  }

  private link(world: CANNON.World, limb: CANNON.Body, pivotA: CANNON.Vec3, angle: number) {
    const c = new CANNON.ConeTwistConstraint(this.torso as CANNON.Body, limb, {
      pivotA,
      pivotB: new CANNON.Vec3(0, GORILLA.limbRadius * 0.55, 0),
      axisA: new CANNON.Vec3(0, 1, 0),
      axisB: new CANNON.Vec3(0, 1, 0),
      angle,
      twistAngle: GORILLA.twistAngle,
      maxForce: GORILLA.jointMaxForce,
      collideConnected: false,
    })
    world.addConstraint(c)
    this.constraints.push(c)
    this.basePivots.push(pivotA.clone())
  }

  // ---------------------------------------------------------------- visuals --
  private mkMat(color: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true })
    this.materials.push(m)
    return m
  }

  private buildVisuals() {
    const matBody = this.mkMat(this.theme.body)
    const matBodyDark = this.mkMat(this.theme.bodyDark)
    const matMuzzle = this.mkMat(this.theme.muzzle)
    const matEye = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.5, flatShading: true })
    const matPupil = new THREE.MeshStandardMaterial({ color: 0x14130f, roughness: 0.4, flatShading: true })
    this.materials.push(matEye, matPupil)

    const torso = new THREE.Mesh(GEO.torso, matBody)
    torso.castShadow = true
    torso.receiveShadow = true

    const head = new THREE.Mesh(GEO.head, matBody)
    head.position.set(0, 0.42, -0.16)
    head.castShadow = true
    torso.add(head)
    const crest = new THREE.Mesh(GEO.crest, matBodyDark)
    crest.position.set(0, 0.62, -0.1)
    crest.rotation.x = -0.2
    torso.add(crest)
    const brow = new THREE.Mesh(GEO.brow, matBodyDark)
    brow.position.set(0, 0.46, -0.3)
    torso.add(brow)
    const muzzle = new THREE.Mesh(GEO.muzzle, matMuzzle)
    muzzle.position.set(0, 0.3, -0.36)
    muzzle.scale.set(1.05, 0.85, 1.0)
    torso.add(muzzle)
    const eyeL = new THREE.Mesh(GEO.eye, matEye)
    eyeL.position.set(-0.14, 0.5, -0.34)
    torso.add(eyeL)
    const eyeR = new THREE.Mesh(GEO.eye, matEye)
    eyeR.position.set(0.14, 0.5, -0.34)
    torso.add(eyeR)
    const pupL = new THREE.Mesh(GEO.pupil, matPupil)
    pupL.position.set(-0.14, 0.5, -0.41)
    torso.add(pupL)
    const pupR = new THREE.Mesh(GEO.pupil, matPupil)
    pupR.position.set(0.14, 0.5, -0.41)
    torso.add(pupR)
    const earL = new THREE.Mesh(GEO.ear, matBodyDark)
    earL.position.set(-0.34, 0.46, -0.04)
    earL.scale.set(0.6, 1, 0.5)
    torso.add(earL)
    const earR = new THREE.Mesh(GEO.ear, matBodyDark)
    earR.position.set(0.34, 0.46, -0.04)
    earR.scale.set(0.6, 1, 0.5)
    torso.add(earR)

    if (this.theme.silver !== undefined) {
      const patch = new THREE.Mesh(GEO.patch, this.mkMat(this.theme.silver))
      patch.position.set(0, 0.08, 0.34)
      patch.scale.set(1.1, 0.8, 0.45)
      torso.add(patch)
    }

    // Visible Banana Gun. It replaces the punch when equipped and is mounted
    // on the torso so it follows every ragdoll rotation and size upgrade.
    const gunBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.28, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x3f3428, roughness: 0.7, flatShading: true })
    )
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.14, 0.6, 7),
      new THREE.MeshStandardMaterial({ color: 0x1d2025, roughness: 0.42, flatShading: true })
    )
    barrel.rotation.x = Math.PI / 2
    barrel.position.z = -0.5
    const magazine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xffd52e, emissive: 0x604500, roughness: 0.5, flatShading: true })
    )
    magazine.rotation.z = Math.PI / 2
    magazine.position.y = -0.13
    this.bananaGun.add(gunBody, barrel, magazine)
    this.bananaGun.position.set(0.42, -0.02, -0.7)
    this.bananaGun.rotation.x = -0.12
    this.bananaGun.visible = false
    torso.add(this.bananaGun)

    // --- Struggle visual indicator (floating star halo above head when grabbed) ---
    const matStar = new THREE.MeshBasicMaterial({ color: 0xff3300 })
    this.materials.push(matStar)
    this.struggleGroup.position.set(0, 1.15, -0.1)
    for (let i = 0; i < 3; i++) {
      const star = new THREE.Mesh(GEO.star, matStar)
      const ang = (i / 3) * Math.PI * 2
      star.position.set(Math.cos(ang) * 0.32, 0, Math.sin(ang) * 0.32)
      this.struggleGroup.add(star)
    }
    this.struggleGroup.visible = false
    torso.add(this.struggleGroup)

    // --- In-grab-range prompt chevron mesh ---
    const matPrompt = new THREE.MeshBasicMaterial({ color: 0xffd700, wireframe: true })
    this.materials.push(matPrompt)
    this.promptMesh = new THREE.Mesh(GEO.prompt, matPrompt)
    this.promptMesh.position.set(0, 1.35, -0.1)
    this.promptMesh.rotation.x = Math.PI
    this.promptMesh.visible = false
    torso.add(this.promptMesh)

    this.group.add(torso)
    this.meshLinks.push({ mesh: torso, body: this.torso, baseScale: new THREE.Vector3(1, 1, 1) })

    const caps: { scale: [number, number, number]; cap: 'hand' | 'foot'; pos: [number, number, number] }[] = [
      { scale: [1, 1.35, 1], cap: 'hand', pos: [0, -0.34, 0] },
      { scale: [1, 1.35, 1], cap: 'hand', pos: [0, -0.34, 0] },
      { scale: [1, 1.2, 1], cap: 'foot', pos: [0, -0.3, 0.08] },
      { scale: [1, 1.2, 1], cap: 'foot', pos: [0, -0.3, 0.08] },
    ]
    for (let i = 0; i < this.limbs.length; i++) {
      const m = new THREE.Mesh(GEO.limb, matBody)
      m.scale.set(caps[i].scale[0], caps[i].scale[1], caps[i].scale[2])
      m.castShadow = true
      m.receiveShadow = true
      if (caps[i].cap === 'hand') {
        const hand = new THREE.Mesh(GEO.hand, matBodyDark)
        hand.position.set(caps[i].pos[0], caps[i].pos[1], caps[i].pos[2])
        m.add(hand)
      } else {
        const foot = new THREE.Mesh(GEO.foot, matBodyDark)
        foot.position.set(caps[i].pos[0], caps[i].pos[1], caps[i].pos[2])
        m.add(foot)
      }
      this.group.add(m)
      this.meshLinks.push({
        mesh: m,
        body: this.limbs[i],
        baseScale: new THREE.Vector3(caps[i].scale[0], caps[i].scale[1], caps[i].scale[2]),
      })
    }
  }

  setInGrabRange(inRange: boolean) {
    this.promptMesh.visible = inRange && !this.isGrabbed && !this.respawning
  }

  setGroundResolver(fn: (x: number, z: number, belowY: number) => number) {
    this.groundResolver = fn
  }

  startClimb(zone: ClimbZone) {
    this.climbing = true
    this.climbZone = zone
    this.moveIntent = null
    // Preserve approach momentum. Game supplies a desired climb velocity on
    // the next frame and preStep eases toward it rather than hard-snapping.
    this.climbVel.copy(this.torso.velocity)

    // Both hands snap toward the surface. Poles use the current body offset
    // as the outward normal so the grab works from any side of a tree/vine.
    let nx = 0
    let nz = 0
    if (zone.kind === 'face') {
      nx = zone.axis === 'x' ? zone.normal : 0
      nz = zone.axis === 'z' ? zone.normal : 0
    } else {
      nx = this.torso.position.x - zone.cx
      nz = this.torso.position.z - zone.cz
      const len = Math.hypot(nx, nz) || 1
      nx /= len
      nz /= len
    }
    for (let i = 0; i < 2; i++) {
      this.limbs[i].applyImpulse(
        new CANNON.Vec3(-nx * CLIMB.latchImpulse, 4, -nz * CLIMB.latchImpulse)
      )
    }
  }

  controlClimb(vel: CANNON.Vec3) {
    if (this.climbing) this.climbVel.copy(vel)
  }

  /** True when this gorilla is free to latch onto a new wall right now. */
  canClimb(): boolean {
    return !this.respawning && !this.climbing && this.climbCooldown <= 0
  }

  /** Call whenever a climb ends so the same wall can't be instantly re-grabbed. */
  markClimbExit() {
    this.climbCooldown = CLIMB.reattachCooldown
  }

  isGrounded(): boolean {
    const t = this.torso
    const gy = this.groundResolver(t.position.x, t.position.z, t.position.y - 0.1)
    if (gy <= -100) return false
    return t.position.y <= gy + MOVEMENT.stanceHeight * this.mods.scale + 0.55 && t.velocity.y < 3.2
  }

  canJump(): boolean {
    return !this.respawning && !this.ko && this.jumpCooldown <= 0 && (this.isGrounded() || this.coyote > 0)
  }

  tryJump(): boolean {
    if (!this.canJump()) return false
    const t = this.torso
    // Impulse scales with mass so jump height is size-independent.
    const im = this.mods.scale * this.mods.scale * this.mods.scale
    t.applyImpulse(
      new CANNON.Vec3(this.facing.x * JUMP.forward * im, JUMP.impulse * im, this.facing.z * JUMP.forward * im)
    )
    this.markJumped()
    return true
  }

  markJumped() {
    this.jumpCooldown = JUMP.cooldown
    this.jumpIgnoreStance = JUMP.ignoreStance
    this.coyote = 0
  }

  // ------------------------------------------------------ Phase 5: upgrades --
  /** Apply an upgrade modifier bag; rescales the body if size changed. */
  setMods(m: Mods) {
    this.mods = m
    this.bananaGun.visible = m.banana
    if (m.flight && this.flightTimer <= 0 && this.flightCooldown <= 0) this.flightTimer = FLIGHT.duration
    if (Math.abs(m.scale - this.appliedScale) > 1e-3) this.setScale(m.scale)
  }

  /**
   * Resize colliders, masses, joint pivots and meshes in place. Cheaper and
   * smoother than rebuilding the ragdoll, and keeps existing constraints.
   */
  setScale(s: number) {
    this.appliedScale = s
    const torsoShape = this.torso.shapes[0] as CANNON.Sphere
    torsoShape.radius = GORILLA.torsoRadius * s
    torsoShape.updateBoundingSphereRadius()
    this.torso.mass = GORILLA.torsoMass * s * s * s
    this.torso.updateMassProperties()
    this.torso.updateBoundingRadius()

    for (const limb of this.limbs) {
      const sh = limb.shapes[0] as CANNON.Sphere
      sh.radius = GORILLA.limbRadius * s
      sh.updateBoundingSphereRadius()
      limb.mass = GORILLA.limbMass * s * s * s
      limb.updateMassProperties()
      limb.updateBoundingRadius()
    }

    for (let i = 0; i < this.constraints.length; i++) {
      const c = this.constraints[i]
      const base = this.basePivots[i]
      c.pivotA.set(base.x * s, base.y * s, base.z * s)
      c.pivotB.set(0, GORILLA.limbRadius * 0.55 * s, 0)
    }

    // Keep limb proportions (stubby arms/legs) instead of turning them into
    // uniformly-scaled spheres — that's what made Tiny Gorilla look broken.
    for (const { mesh, baseScale } of this.meshLinks) {
      mesh.scale.set(baseScale.x * s, baseScale.y * s, baseScale.z * s)
    }
  }

  /** Knock out: limp ragdoll, no assists, no actions until reset. */
  knockOut() {
    this.ko = true
    this.punching = false
    this.climbing = false
    this.climbZone = null
    this.flying = false
    this.flightTimer = 0
    this.isGrabbed = false
    this.holdPoint = null
    this.moveIntent = null
  }

  revive(pos: CANNON.Vec3) {
    this.ko = false
    this.resetPose(pos)
    this.flying = false
    this.flightCooldown = 0
    this.flightTimer = this.mods.flight ? FLIGHT.duration : 0
    this.group.visible = true
    this.respawning = false
    this.apexY = pos.y
    this.airborne = false
    this.pendingFall = null
  }

  /** Flight: second jump in mid-air enters a lasting hover. Jump again to drop. */
  toggleFlight(): boolean {
    if (!this.mods.flight || this.ko) return false
    if (this.flying) {
      this.flying = false
      this.flightCooldown = FLIGHT.cooldown
      return true
    }
    if (this.flightCooldown > 0 || this.flightTimer <= 0 || this.isGrounded()) return false
    this.flying = true
    this.flightRiseArmed = false
    this.flyRise = false
    this.climbing = false
    this.climbZone = null
    return true
  }

  /** Apply held flight input after action processing. */
  setFlightControls(spaceHeld: boolean, sinkHeld: boolean) {
    if (!spaceHeld) this.flightRiseArmed = true
    this.flyRise = this.flying && spaceHeld && this.flightRiseArmed
    this.flySink = this.flying && sinkHeld
  }

  /**
   * Superman flight: full manual control on all three axes. Never applies
   * force unless the player asks for it — release everything and momentum
   * bleeds off to a true stop.
   */
  private updateFlight(dt: number, dir: CANNON.Vec3 | null) {
    const t = this.torso
    t.applyForce(new CANNON.Vec3(0, t.mass * -PHYS.gravity, 0))
    const blend = 1 - Math.exp(-FLIGHT.accel * dt)
    const decay = 1 - Math.exp(-FLIGHT.drag * dt)
    const sprint = this.sprinting ? SPRINT.flightMul : 1
    const cruise = FLIGHT.cruise * this.mods.moveMul * sprint

    const hasHoriz = dir !== null && dir.lengthSquared() > 1e-4
    if (hasHoriz) {
      t.velocity.x += (dir!.x * cruise - t.velocity.x) * blend
      t.velocity.z += (dir!.z * cruise - t.velocity.z) * blend
    } else {
      t.velocity.x += (0 - t.velocity.x) * decay
      t.velocity.z += (0 - t.velocity.z) * decay
    }

    if (this.flyRise && !this.flySink) {
      t.velocity.y += (FLIGHT.climbSpeed * sprint - t.velocity.y) * blend
    } else if (this.flySink && !this.flyRise) {
      t.velocity.y += (-FLIGHT.diveSpeed * sprint - t.velocity.y) * blend
    } else {
      t.velocity.y += (0 - t.velocity.y) * decay
    }
  }

  /** Track apex while airborne so landings can be billed as fall damage. */
  private trackFall() {
    const grounded = this.isGrounded()
    const y = this.torso.position.y
    if (!grounded && !this.climbing && !this.flying) {
      if (!this.airborne) {
        this.airborne = true
        this.apexY = y
      } else if (y > this.apexY) {
        this.apexY = y
      }
    } else if (this.airborne) {
      this.airborne = false
      const drop = this.apexY - y
      const speed = Math.abs(this.torso.velocity.y)
      if (drop > 0.2 && speed > FALL.minTrackSpeed) this.pendingFall = { drop, speed }
      this.apexY = y
    } else if (this.climbing || this.flying) {
      this.apexY = y
    }
  }

  /** Bouncy Boy: convert a hard landing into upward momentum. */
  tryBounce(impactSpeed: number) {
    if (!this.mods.bounce || impactSpeed < BOUNCE.minSpeed) return false
    const up = Math.min(impactSpeed * BOUNCE.restitution, BOUNCE.maxSpeed)
    this.torso.velocity.y = up
    this.airborne = true
    this.apexY = this.torso.position.y
    return true
  }

  sync() {
    for (const { mesh, body } of this.meshLinks) {
      mesh.position.set(body.position.x, body.position.y, body.position.z)
      mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w)
    }

    if (this.isGrabbed) {
      this.struggleGroup.visible = true
      this.struggleGroup.rotation.y += 0.12
      const p = 1 + 0.2 * Math.sin(Date.now() * 0.015)
      this.struggleGroup.scale.setScalar(p)
    } else {
      this.struggleGroup.visible = false
    }

    if (this.promptMesh.visible) {
      this.promptMesh.rotation.y += 0.08
      this.promptMesh.position.y = 1.35 + 0.08 * Math.sin(Date.now() * 0.008)
    }
  }

  // --------------------------------------------------------------- control --
  controlMove(dir: CANNON.Vec3 | null) {
    this.moveIntent = dir
    if (this.ko) {
      this.moveIntent = null
      return
    }
    if (this.respawning || this.climbing || this.isGrabbed || !dir) return
    if (dir.lengthSquared() > 1e-4) {
      this.facing.set(dir.x, 0, dir.z)
      this.facing.normalize()
      if (this.flying) return
      const sprint = this.sprinting ? SPRINT.moveMul : 1
      const f = MOVEMENT.force * this.mods.moveMul * this.mods.scale * sprint
      this.torso.applyForce(new CANNON.Vec3(dir.x * f, 0, dir.z * f))
    }
  }

  controlWander(dt: number) {
    if (this.respawning || this.isGrabbed) return
    this.wanderTimer -= dt
    if (this.wanderTimer <= 0) {
      const a = Math.random() * Math.PI * 2
      this.wanderDir.set(Math.cos(a), 0, Math.sin(a))
      this.wanderTimer = DUMMY.changeInterval * (0.6 + Math.random())
    }
    const p = this.torso.position
    const limit = ARENA.half * DUMMY.steerEdge
    if (Math.abs(p.x) > limit || Math.abs(p.z) > limit) {
      this.wanderDir.set(-Math.sign(p.x || 1), 0, -Math.sign(p.z || 1))
      this.wanderDir.scale(Math.random() * 0.5 + 0.5, this.wanderDir)
      this.wanderDir.normalize()
    }
    this.torso.applyForce(new CANNON.Vec3(this.wanderDir.x * DUMMY.force, 0, this.wanderDir.z * DUMMY.force))
    this.facing.copy(this.wanderDir)
    this.moveIntent = this.wanderDir
  }

  private driveLimb(limb: CANNON.Body, target: CANNON.Vec3, spring: number, damping: number, maxForce: number) {
    const fx = (target.x - limb.position.x) * spring - (limb.velocity.x - this.torso.velocity.x) * damping
    const fy = (target.y - limb.position.y) * spring - (limb.velocity.y - this.torso.velocity.y) * damping
    const fz = (target.z - limb.position.z) * spring - (limb.velocity.z - this.torso.velocity.z) * damping
    const force = new CANNON.Vec3(fx, fy, fz)
    const length = force.length()
    if (length > maxForce) force.scale(maxForce / length, force)
    limb.applyForce(force)
    this.torso.applyForce(new CANNON.Vec3(-force.x, -force.y, -force.z))
  }

  private driveGait(dt: number) {
    if (this.isGrabbed) return
    const sc = this.mods.scale
    const moving = this.moveIntent !== null && this.moveIntent.lengthSquared() > 1e-4
    const speed = Math.hypot(this.torso.velocity.x, this.torso.velocity.z)
    if (moving) this.gaitTime += dt * MOVEMENT.strideRate * (0.65 + Math.min(speed / MOVEMENT.maxSpeed, 1) * 0.55)

    const rightX = -this.facing.z
    const rightZ = this.facing.x
    const phases = [0, Math.PI, Math.PI, 0]
    const massScale = sc * sc * sc
    for (let i = 0; i < this.limbs.length; i++) {
      if (this.punching && i === this.activeArm) continue
      const isArm = i < 2
      const side = i % 2 === 0 ? -1 : 1
      const wave = moving ? Math.sin(this.gaitTime + phases[i]) : 0
      const lift = moving ? Math.max(0, Math.cos(this.gaitTime + phases[i])) * MOVEMENT.stepLift * sc : 0
      const stride = wave * MOVEMENT.strideLength * sc
      const sideOffset = (isArm ? 0.69 : 0.38) * side * sc
      const foreOffset = ((isArm ? 0.12 : -0.12) + stride)
      const downOffset = (isArm ? -0.37 : -0.69) * sc
      const target = new CANNON.Vec3(
        this.torso.position.x + rightX * sideOffset + this.facing.x * foreOffset,
        this.torso.position.y + downOffset + lift,
        this.torso.position.z + rightZ * sideOffset + this.facing.z * foreOffset
      )
      this.driveLimb(
        this.limbs[i],
        target,
        moving ? MOVEMENT.limbSpring : MOVEMENT.idleLimbSpring,
        MOVEMENT.limbDamping,
        MOVEMENT.limbMaxForce * massScale
      )
    }
  }

  private drivePunchArm() {
    if (!this.punching) return
    const duration = PUNCH.activeTime / this.mods.actionMul
    const progress = 1 - this.punchTimer / duration
    const windingUp = progress < PUNCH.windupFraction
    const side = this.activeArm === 0 ? -1 : 1
    const rightX = -this.facing.z
    const rightZ = this.facing.x
    const sc = this.mods.scale
    const giant = sc >= 2
    const reach = (windingUp ? -0.52 : giant ? PUNCH.giantReach : PUNCH.armReach) * sc
    const flare = (windingUp ? 0.78 : 0.3) * sc
    const target = new CANNON.Vec3(
      this.torso.position.x + this.facing.x * reach + rightX * side * flare,
      this.torso.position.y + (windingUp ? 0.34 : PUNCH.armUp) * sc,
      this.torso.position.z + this.facing.z * reach + rightZ * side * flare
    )
    const massScale = sc * sc * sc
    this.driveLimb(
      this.limbs[this.activeArm],
      target,
      giant ? PUNCH.giantArmDrive : PUNCH.armDrive,
      PUNCH.armDamping,
      (giant ? PUNCH.giantArmMaxForce : PUNCH.armMaxForce) * massScale
    )
  }

  /** A heavy, visible two-arm reach used before a grab constraint takes over. */
  startGrabReach(facing: CANNON.Vec3) {
    if (this.ko || this.respawning) return
    const giant = this.mods.scale >= 2
    this.grabReachTimer = (giant ? 0.55 : 0.34) / this.mods.actionMul
    const im = this.mods.scale * this.mods.scale * this.mods.scale
    for (const arm of this.limbs.slice(0, 2)) {
      const shove = giant ? 20 : 10
      // Launch the arm forward AND up so it visibly rises to clasp the victim.
      arm.applyImpulse(new CANNON.Vec3(facing.x * shove * im, (giant ? 9 : 4) * im, facing.z * shove * im))
    }
  }

  private driveGrabReach(dt: number) {
    if (this.grabReachTimer <= 0) return
    this.grabReachTimer = Math.max(0, this.grabReachTimer - dt)
    const sc = this.mods.scale
    const giant = sc >= 2
    const rightX = -this.facing.z
    const rightZ = this.facing.x
    const massScale = sc * sc * sc
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1
      // Reach forward and up to a shoulder/head-height clasp, arcing the arms
      // in toward the body — this reads as actually grabbing, not poking.
      const target = new CANNON.Vec3(
        this.torso.position.x + this.facing.x * 1.85 * sc + rightX * side * 0.6 * sc,
        this.torso.position.y + (giant ? 0.75 : 0.5) * sc,
        this.torso.position.z + this.facing.z * 1.85 * sc + rightZ * side * 0.6 * sc
      )
      this.driveLimb(this.limbs[i], target, giant ? 560 : 320, 14, (giant ? 1100 : 560) * massScale)
    }
  }

  preStep(dt: number) {
    if (this.respawning) return
    // Knocked out: no balance, no gait, no actions — a pure limp ragdoll that
    // just falls and tumbles until the round resets it.
    if (this.ko) {
      this.flying = false
      return
    }
    this.trackFall()
    // Safety net: a climb without a zone must never persist (it would block
    // movement force and leave the gorilla stuck).
    if (this.climbing && !this.climbZone) {
      this.climbing = false
    }
    const wasCooling = this.flightCooldown > 0
    this.flightCooldown = Math.max(0, this.flightCooldown - dt)
    if (wasCooling && this.flightCooldown <= 0 && this.mods.flight && this.flightTimer <= 0) {
      this.flightTimer = FLIGHT.duration
    }
    if (this.flying) {
      this.flightTimer = Math.max(0, this.flightTimer - dt)
      if (this.flightTimer <= 0) {
        this.flying = false
        this.flightCooldown = FLIGHT.recharge
      } else {
        this.updateFlight(dt, this.moveIntent)
      }
    }
    this.punchCooldown = Math.max(0, this.punchCooldown - dt)
    this.grabCooldown = Math.max(0, this.grabCooldown - dt)
    this.staggerTimer = Math.max(0, this.staggerTimer - dt)
    this.laserInterrupt = Math.max(0, this.laserInterrupt - dt)
    this.driveGrabReach(dt)
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt)
    this.jumpIgnoreStance = Math.max(0, this.jumpIgnoreStance - dt)
    this.climbCooldown = Math.max(0, this.climbCooldown - dt)
    if (this.isGrounded()) this.coyote = JUMP.coyote
    else this.coyote = Math.max(0, this.coyote - dt)

    if (this.punching) {
      this.punchTimer -= dt
      if (this.punchTimer <= 0) {
        this.punching = false
        this.hitSet.clear()
      }
    }

    const t = this.torso

    // --- Climb state: gravity off, exact climb velocity, body pressed to wall ---
    if (this.climbing && this.climbZone) {
      const z = this.climbZone
      t.applyForce(new CANNON.Vec3(0, t.mass * -PHYS.gravity, 0)) // cancel gravity

      // Muscle-driven velocity controller. This keeps incoming jump momentum,
      // accelerates into user input, and lets the ragdoll wobble around the
      // target instead of pinning the torso to an exact velocity every frame.
      const blend = 1 - Math.exp(-CLIMB.acceleration * dt)
      t.velocity.x += (this.climbVel.x - t.velocity.x) * blend
      t.velocity.y += (this.climbVel.y - t.velocity.y) * blend
      t.velocity.z += (this.climbVel.z - t.velocity.z) * blend

      let nx = 0
      let nz = 0
      if (z.kind === 'face') {
        nx = z.axis === 'x' ? z.normal : 0
        nz = z.axis === 'z' ? z.normal : 0
      } else {
        nx = t.position.x - z.cx
        nz = t.position.z - z.cz
        const len = Math.hypot(nx, nz) || 1
        nx /= len
        nz /= len
      }

      // Keep the torso upright and facing the wall
      const up = new CANNON.Vec3()
      t.quaternion.vmult(UP, up)
      const corr = new CANNON.Vec3()
      up.cross(UP, corr)
      const sl = corr.length()
      if (sl > 1e-4) {
        corr.scale(1 / sl, corr)
        const add = 22 * Math.acos(clamp(up.y, -1, 1)) * dt
        t.angularVelocity.x += corr.x * add
        t.angularVelocity.y += corr.y * add
        t.angularVelocity.z += corr.z * add
      }
      const fwd = new CANNON.Vec3()
      t.quaternion.vmult(FWD, fwd)
      fwd.y = 0
      if (fwd.lengthSquared() > 1e-4) fwd.normalize()
      const C = fwd.x * nz - fwd.z * nx
      t.angularVelocity.y += -30 * C * dt
      t.angularVelocity.scale(Math.max(0, 1 - 7 * dt), t.angularVelocity)

      // Arms stay visibly planted on the wall while legs scramble below them.
      // These remain physics forces rather than an animation, so impacts can
      // still shake the character loose in a readable way.
      this.gaitTime += dt * CLIMB.gaitRate
      const g = this.gaitTime
      for (let i = 0; i < this.limbs.length; i++) {
        const isArm = i < 2
        const side = i % 2 === 0 ? -1 : 1
        const sc = this.mods.scale
        const lift = isArm
          ? Math.sin(g + i * Math.PI) * CLIMB.armStep * sc
          : Math.sin(g + i * 1.9) * CLIMB.legStep * sc
        const off = (isArm ? side * 0.55 : side * 0.32) * sc
        const wallReach = (isArm ? CLIMB.armReach : 0.48) * sc
        const sideX = -nz
        const sideZ = nx
        const target = new CANNON.Vec3(
          t.position.x - nx * wallReach + sideX * off,
          t.position.y + (isArm ? 0.2 : -0.42) * sc + lift,
          t.position.z - nz * wallReach + sideZ * off
        )
        this.driveLimb(
          this.limbs[i],
          target,
          isArm ? CLIMB.armSpring : 78,
          isArm ? 12 : 7,
          isArm ? CLIMB.armMaxForce : 115
        )
      }
      return
    }

    // --- If grabbed, struggle flail limbs randomly and disable upright balance ---
    if (this.isGrabbed) {
      for (const limb of this.limbs) {
        limb.applyImpulse(
          new CANNON.Vec3(
            (Math.random() * 2 - 1) * 3.5,
            (Math.random() * 2 - 1) * 3.5,
            (Math.random() * 2 - 1) * 3.5
          )
        )
      }
      return
    }

    const v = t.velocity
    const df = Math.max(0, 1 - MOVEMENT.drag * dt)
    v.x *= df
    v.z *= df
    const sp = Math.hypot(v.x, v.z)
    const sprintCap = this.sprinting ? SPRINT.speedCapMul : 1
    const capSpeed = MOVEMENT.maxSpeed * this.mods.moveMul * sprintCap
    if (sp > capSpeed) {
      const s = capSpeed / sp
      v.x *= s
      v.z *= s
    }
    if (this.flying) return // flight owns velocity; skip gait/stance/upright

    this.driveGait(dt)
    this.drivePunchArm()

    // Suspension keeps the torso carried by its limbs instead of rolling on its
    // spherical collider. Uses the nearest platform top below the gorilla so
    // standing + landing works on every tier.
    const groundY = this.groundResolver(t.position.x, t.position.z, t.position.y - 0.15)
    // Stance height and support force both scale with body size/mass so a Big
    // Gorilla still stands up and a Tiny one isn't launched.
    const sc = this.mods.scale
    const massScale = sc * sc * sc
    const stance = MOVEMENT.stanceHeight * sc
    if (this.jumpIgnoreStance <= 0 && groundY > -100 && t.position.y < groundY + stance + 0.6) {
      const support = clamp(
        ((groundY + stance - t.position.y) * MOVEMENT.stanceSpring - v.y * MOVEMENT.stanceDamping + 260) * massScale,
        0,
        MOVEMENT.stanceMaxForce * massScale
      )
      t.applyForce(new CANNON.Vec3(0, support, 0))
    }

    const assist = this.staggerTimer > 0 ? UPRIGHT.staggerAssist : 1

    // upright (tilt) correction
    const up = new CANNON.Vec3()
    t.quaternion.vmult(UP, up)
    const tu = new CANNON.Vec3(-this.facing.x * UPRIGHT.lean, 1, -this.facing.z * UPRIGHT.lean)
    const tul = tu.length()
    if (tul > 1e-4) tu.scale(1 / tul, tu)
    const corr = new CANNON.Vec3()
    up.cross(tu, corr)
    const sl = corr.length()
    if (sl > 1e-4) {
      corr.scale(1 / sl, corr)
      const dot = clamp(up.dot(tu), -1, 1)
      const tilt = Math.acos(dot)
      const add = UPRIGHT.speed * assist * tilt * dt
      t.angularVelocity.x += corr.x * add
      t.angularVelocity.y += corr.y * add
      t.angularVelocity.z += corr.z * add
    }

    // global angular damping
    const af = Math.max(0, 1 - UPRIGHT.angularDamp * assist * dt)
    t.angularVelocity.scale(af, t.angularVelocity)

    // yaw toward travel direction
    const fwd = new CANNON.Vec3()
    t.quaternion.vmult(FWD, fwd)
    fwd.y = 0
    if (fwd.lengthSquared() > 1e-4) fwd.normalize()
    const fd = this.facing
    const C = fwd.x * fd.z - fwd.z * fd.x
    t.angularVelocity.y += -UPRIGHT.yawGain * assist * C * dt

    const av = t.angularVelocity
    const al = Math.hypot(av.x, av.y, av.z)
    if (al > UPRIGHT.maxAngular) av.scale(UPRIGHT.maxAngular / al, av)
  }

  startPunch(facing: CANNON.Vec3): boolean {
    if (this.respawning || this.ko || this.punching || this.punchCooldown > 0 || this.grabbedTarget !== null)
      return false
    this.punching = true
    // Action speed: >1 = faster windup + shorter cooldown (Tiny), <1 = slower (Big).
    const act = this.mods.actionMul
    this.punchTimer = PUNCH.activeTime / act
    this.punchCooldown = PUNCH.cooldown / act
    this.activeArm = this.nextArm
    this.hitSet.clear()

    const arm = this.limbs[this.activeArm]
    const side = this.activeArm === 0 ? -1 : 1
    const im = this.mods.scale * this.mods.scale * this.mods.scale
    arm.applyImpulse(
      new CANNON.Vec3(-facing.x * PUNCH.armImpulse * im, PUNCH.armImpulse * 0.3 * im, -facing.z * PUNCH.armImpulse * im)
    )
    const rightX = -facing.z
    const rightZ = facing.x
    arm.applyImpulse(new CANNON.Vec3(rightX * side * PUNCH.armFlare * im, 0, rightZ * side * PUNCH.armFlare * im))
    this.torso.applyImpulse(new CANNON.Vec3(-facing.x * PUNCH.torsoRecoil * im, 0, -facing.z * PUNCH.torsoRecoil * im))

    this.nextArm = this.nextArm === 0 ? 1 : 0
    return true
  }

  isPunchLive(): boolean {
    if (!this.punching) return false
    const duration = PUNCH.activeTime / this.mods.actionMul
    return 1 - this.punchTimer / duration >= PUNCH.windupFraction
  }

  snapshot(now: number, flags: number) {
    const t = this.torso
    const l: number[] = []
    for (const b of this.limbs) {
      l.push(b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w)
    }
    return {
      type: 'pose' as const,
      id: '',
      t: now,
      p: [t.position.x, t.position.y, t.position.z] as [number, number, number],
      q: [t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w] as [number, number, number, number],
      v: [t.velocity.x, t.velocity.y, t.velocity.z] as [number, number, number],
      l,
      f: [this.facing.x, this.facing.z] as [number, number],
      s: flags,
    }
  }

  applyLaunch(dir: CANNON.Vec3, force: number, up: number, spin: number, flail: number, stagger: number) {
    this.isGrabbed = false
    this.holdPoint = null
    this.grabbedBy = null
    this.staggerTimer = stagger
    this.laserInterrupt = Math.max(this.laserInterrupt, 0.6)
    this.torso.applyImpulse(new CANNON.Vec3(dir.x * force, force * up, dir.z * force), new CANNON.Vec3(0, 0.35, 0))
    this.torso.angularVelocity.set((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin)
    for (const limb of this.limbs) {
      limb.applyImpulse(
        new CANNON.Vec3((Math.random() * 2 - 1) * flail, Math.random() * flail * 1.4, (Math.random() * 2 - 1) * flail)
      )
    }
  }

  /** knockMul lets Feather Fists / Big / Tiny scale the launch they deliver. */
  takeHit(dir: CANNON.Vec3, knockMul = 1) {
    const t = this.torso
    this.staggerTimer = UPRIGHT.staggerTime
    this.laserInterrupt = 0.5 // any real hit breaks a held laser beam
    const kb = PUNCH.knockback * knockMul
    // Heavy horizontal launch; the vertical component tapers off as knockMul
    // grows so Feather Fists sends the target across the arena instead of up.
    const upFactor = PUNCH.knockUp / Math.max(1, Math.sqrt(knockMul))
    t.applyImpulse(
      new CANNON.Vec3(dir.x * kb, kb * upFactor, dir.z * kb),
      new CANNON.Vec3(-dir.z * 0.32, 0.45, dir.x * 0.32)
    )
    t.angularVelocity.x += (Math.random() * 2 - 1) * PUNCH.spin
    t.angularVelocity.y += (Math.random() * 2 - 1) * PUNCH.spin
    t.angularVelocity.z += (Math.random() * 2 - 1) * PUNCH.spin
    for (const limb of this.limbs) {
      limb.applyImpulse(
        new CANNON.Vec3(
          (Math.random() * 2 - 1) * PUNCH.limbFlail,
          Math.random() * PUNCH.limbFlail * 1.4,
          (Math.random() * 2 - 1) * PUNCH.limbFlail
        )
      )
    }
  }

  /**
   * Void-fall / respawn. Returns true on the frame the body is placed back
   * at spawn. Grab-constraint cleanup is Game's job (see Game.syncGrabState)
   * — this method only hides the body and parks the physics parts off-map.
   */
  tickRespawn(dt: number): boolean {
    if (this.respawning) {
      this.respawnTimer -= dt
      if (this.respawnTimer <= 0) {
        this.resetPose(this.spawn.clone())
        this.group.visible = true
        this.respawning = false
        this.facing.set(0, 0, -1)
        return true
      }
      return false
    }
    if (this.torso.position.y < RESPAWN.fallY) {
      this.respawning = true
      this.respawnTimer = RESPAWN.delay
      this.group.visible = false
      this.punching = false
      this.moveIntent = null
      this.isGrabbed = false
      this.grabbedTarget = null
      this.grabbedBy = null
      this.climbing = false
      this.climbZone = null
      this.climbCooldown = 0
      for (const b of this.allBodies) {
        b.velocity.set(0, 0, 0)
        b.angularVelocity.set(0, 0, 0)
        b.position.set(0, -1000 - Math.random() * 10, 0)
      }
    }
    return false
  }

  private resetPose(pos: CANNON.Vec3) {
    const id = new CANNON.Quaternion()
    this.torso.position.copy(pos)
    this.torso.velocity.set(0, 0, 0)
    this.torso.angularVelocity.set(0, 0, 0)
    this.torso.quaternion.copy(id)
    this.staggerTimer = 0
    this.gaitTime = 0
    this.isGrabbed = false
    this.grabbedTarget = null
    this.grabbedBy = null
    this.climbing = false
    this.climbZone = null
    this.jumpCooldown = 0
    this.jumpIgnoreStance = 0
    this.coyote = 0
    this.climbCooldown = 0

    const offs: CANNON.Vec3[] = [
      new CANNON.Vec3(-GORILLA.shoulderX, -0.05, 0),
      new CANNON.Vec3(GORILLA.shoulderX, -0.05, 0),
      new CANNON.Vec3(-GORILLA.hipX, -0.72, GORILLA.hipZ),
      new CANNON.Vec3(GORILLA.hipX, -0.72, GORILLA.hipZ),
    ]
    for (let i = 0; i < this.limbs.length; i++) {
      const b = this.limbs[i]
      b.position.copy(pos).vadd(offs[i], b.position)
      b.velocity.set(0, 0, 0)
      b.angularVelocity.set(0, 0, 0)
      b.quaternion.copy(id)
    }
  }

  effectivePosition(): CANNON.Vec3 {
    return this.respawning ? this.spawn : this.torso.position
  }

  dispose() {
    for (const m of this.materials) m.dispose()
  }
}
