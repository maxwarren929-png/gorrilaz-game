import * as THREE from 'three'
import { FLAG, NET, themeFromTint, type PoseMsg } from './protocol'
import { HEALTH, modsFor } from '../game/constants'

interface Snap {
  t: number
  p: THREE.Vector3
  q: THREE.Quaternion
  limbs: { p: THREE.Vector3; q: THREE.Quaternion }[]
  facing: THREE.Vector2
  flags: number
}

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, 256, 64)
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.fillRect(28, 16, 200, 32)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 22px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text.slice(0, 16), 128, 32)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const s = new THREE.Sprite(mat)
  s.scale.set(1.8, 0.45, 1)
  s.position.set(0, 1.45, 0)
  return s
}

/** Visual-only interpolated gorilla. No physics — the owner simulates locally. */
export class RemoteAvatar {
  id: string
  name: string
  group = new THREE.Group()
  pos = new THREE.Vector3()
  facing = new THREE.Vector3(0, 0, -1)
  flags = 0
  heldLock = false
  /** Knocked out this round — rendered dimmed, no health pip. */
  ko = false
  /** Body scale from Big/Tiny Gorilla, mirrored from the owner's upgrades. */
  scale = 1
  upgrades: string[] = []
  /** Wall-clock ms when an active Domain Expansion buff ends (mirrored from owner). */
  domainUntil = 0
  private hp = HEALTH.max
  private maxHp = HEALTH.max
  private bananaGun = new THREE.Group()
  private hpFill!: THREE.Mesh
  private hpBar!: THREE.Group
  private parts: THREE.Object3D[] = []
  private snaps: Snap[] = []
  private struggle: THREE.Group
  // Client-side knockback prediction: when we see a remote get hit, apply a
  // visual velocity offset that decays over ~0.4 s. Without this, the avatar
  // appears frozen until the victim's real pose updates arrive (~200 ms).
  private hitVel = new THREE.Vector3()
  private hitTime = 0

  constructor(id: string, name: string, tint: number) {
    this.id = id
    this.name = name
    const theme = themeFromTint(tint)
    const body = new THREE.MeshStandardMaterial({ color: theme.body, roughness: 0.85, flatShading: true })
    const dark = new THREE.MeshStandardMaterial({ color: theme.bodyDark, roughness: 0.85, flatShading: true })
    const muz = new THREE.MeshStandardMaterial({ color: theme.muzzle, roughness: 0.7, flatShading: true })

    const torso = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), body)
    torso.castShadow = true
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 1), body)
    head.position.set(0, 0.42, -0.16)
    torso.add(head)
    const muzzle = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 1), muz)
    muzzle.position.set(0, 0.3, -0.36)
    torso.add(muzzle)
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.12), dark)
    brow.position.set(0, 0.46, -0.3)
    torso.add(brow)
    if (theme.silver) {
      const patch = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), new THREE.MeshStandardMaterial({ color: theme.silver, flatShading: true }))
      patch.position.set(0, 0.08, 0.34)
      patch.scale.set(1.1, 0.8, 0.45)
      torso.add(patch)
    }
    this.group.add(torso)
    this.parts.push(torso)

    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.28, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x40352a, roughness: 0.65, flatShading: true })
    )
    const gunBarrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.14, 0.56, 7),
      new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.45, flatShading: true })
    )
    gunBarrel.rotation.x = Math.PI / 2
    gunBarrel.position.z = -0.47
    this.bananaGun.add(gun, gunBarrel)
    this.bananaGun.position.set(0.42, -0.02, -0.68)
    this.bananaGun.visible = false
    torso.add(this.bananaGun)

    for (let i = 0; i < 4; i++) {
      const limb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), body)
      limb.castShadow = true
      this.group.add(limb)
      this.parts.push(limb)
    }

    this.struggle = new THREE.Group()
    this.struggle.visible = false
    const starMat = new THREE.MeshBasicMaterial({ color: 0xff3300 })
    for (let i = 0; i < 3; i++) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), starMat)
      const a = (i / 3) * Math.PI * 2
      star.position.set(Math.cos(a) * 0.3, 1.15, Math.sin(a) * 0.3)
      this.struggle.add(star)
    }
    this.group.add(this.struggle)
    this.group.add(makeLabel(name))

    // Floating health bar above the head — sized to be readable at combat range.
    this.hpBar = new THREE.Group()
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.65, depthWrite: false, depthTest: false })
    )
    this.hpFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.52, 0.14),
      new THREE.MeshBasicMaterial({ color: 0x6ee7a0, depthWrite: false, depthTest: false })
    )
    this.hpFill.position.z = 0.001
    this.hpBar.add(back, this.hpFill)
    this.hpBar.position.set(0, 1.18, 0)
    this.hpBar.renderOrder = 999
    this.group.add(this.hpBar)
  }

  /** Server-authoritative health for the pip. */
  setHealth(hp: number, max = HEALTH.max) {
    this.maxHp = Math.max(1, max)
    this.hp = Math.max(0, Math.min(this.maxHp, hp))
    const f = this.hp / this.maxHp
    this.hpFill.scale.x = Math.max(0.001, f)
    this.hpFill.position.x = -(1.52 * (1 - f)) / 2
    const mat = this.hpFill.material as THREE.MeshBasicMaterial
    mat.color.setHex(f > 0.55 ? 0x6ee7a0 : f > 0.25 ? 0xffcc55 : 0xff5566)
  }

  /** Mirror the owner's upgrades so size changes replicate. */
  setUpgrades(ids: string[]) {
    this.upgrades = ids
    this.scale = modsFor(ids).scale
    this.maxHp = HEALTH.max * modsFor(ids).healthMul
    this.bananaGun.visible = ids.includes('banana_gun')
  }

  push(msg: PoseMsg) {
    const limbs = []
    for (let i = 0; i < 4; i++) {
      const o = i * 7
      limbs.push({
        p: new THREE.Vector3(msg.l[o], msg.l[o + 1], msg.l[o + 2]),
        q: new THREE.Quaternion(msg.l[o + 3], msg.l[o + 4], msg.l[o + 5], msg.l[o + 6]),
      })
    }
    // Stale/out-of-order: a duplicate or retrograde t (possible after a
    // reconnect burst) would corrupt the interpolation window. Drop it.
    const last = this.snaps[this.snaps.length - 1]
    if (last && msg.t < last.t) return
    this.snaps.push({
      t: msg.t,
      p: new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]),
      q: new THREE.Quaternion(msg.q[0], msg.q[1], msg.q[2], msg.q[3]),
      limbs,
      facing: new THREE.Vector2(msg.f[0], msg.f[1]),
      flags: msg.s,
    })
    if (this.snaps.length > 10) this.snaps.splice(0, this.snaps.length - 10)
  }

  /** Flush the snapshot buffer — used on round reset and reconnect so a
   * stale pre-reset pose can't bleed into the next round's interpolation. */
  clearSnaps() {
    this.snaps.length = 0
    this.hitVel.set(0, 0, 0)
    this.hitTime = 0
  }

  /** Visual knockback prediction: apply an immediate velocity offset in the
   * hit direction so the avatar reacts on the attacker's screen before the
   * victim's real pose updates arrive over the network. */
  applyHitImpulse(dir: THREE.Vector3, force: number) {
    const scale = force / 86 // normalised to a baseline punch
    this.hitVel.addScaledVector(dir, scale * 4)
    this.hitVel.y += scale * 1.5 // pop up slightly
    this.hitTime = performance.now() / 1000
  }

  /** Pin this avatar in front of a local grabber so the hold reads instantly. */
  holdAt(x: number, y: number, z: number, fx: number, fz: number, distance: number) {
    this.heldLock = true
    this.pos.set(x + fx * distance, y, z + fz * distance)
    this.parts[0].position.copy(this.pos)
    this.struggle.visible = true
    this.struggle.rotation.y += 0.12
  }

  sample(now: number, camera?: THREE.Camera) {
    // Size + KO presentation apply whether or not we have fresh snapshots.
    for (const p of this.parts) p.scale.setScalar(this.scale)
    this.hpBar.visible = !this.ko
    this.hpBar.position.y = 1.18 * this.scale + (this.scale - 1) * 0.35
    if (camera) this.hpBar.quaternion.copy(camera.quaternion)
    if (this.heldLock) return
    const renderT = now - NET.interpDelay
    const snaps = this.snaps
    if (snaps.length === 0) return
    let a = snaps[0]
    let b = snaps[snaps.length - 1]
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].t <= renderT && snaps[i + 1].t >= renderT) {
        a = snaps[i]
        b = snaps[i + 1]
        break
      }
    }
    const span = Math.max(1e-4, b.t - a.t)
    const u = Math.max(0, Math.min(1, (renderT - a.t) / span))
    this.pos.lerpVectors(a.p, b.p, u)
    // Apply decaying visual knockback offset. Converges to zero as real
    // snapshots catch up, so there's no permanent desync.
    if (this.hitTime > 0) {
      const nowSec = performance.now() / 1000
      const elapsed = nowSec - this.hitTime
      if (elapsed < 0.45) {
        const dt = 1 / 60
        this.hitVel.y -= 20 * dt // gravity on the offset
        this.hitVel.multiplyScalar(0.94) // drag
        this.pos.addScaledVector(this.hitVel, dt)
      } else {
        this.hitVel.set(0, 0, 0)
        this.hitTime = 0
      }
    }
    this.parts[0].position.copy(this.pos)
    this.parts[0].quaternion.slerpQuaternions(a.q, b.q, u)
    for (let i = 0; i < 4; i++) {
      this.parts[i + 1].position.lerpVectors(a.limbs[i].p, b.limbs[i].p, u)
      this.parts[i + 1].quaternion.slerpQuaternions(a.limbs[i].q, b.limbs[i].q, u)
    }
    this.facing.set(a.facing.x + (b.facing.x - a.facing.x) * u, 0, a.facing.y + (b.facing.y - a.facing.y) * u)
    this.flags = b.flags
    this.group.visible = (this.flags & FLAG.respawning) === 0
    this.struggle.visible = !this.ko && (this.flags & FLAG.grabbed) !== 0
    if (this.struggle.visible) this.struggle.rotation.y += 0.1
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.material) {
        const mat = m.material as THREE.Material
        if ('map' in mat && (mat as THREE.MeshBasicMaterial).map) (mat as THREE.MeshBasicMaterial).map?.dispose()
        mat.dispose()
      }
    })
  }
}
