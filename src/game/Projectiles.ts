import * as THREE from 'three'
import { BANANA, LASER } from './constants'

export interface HitTarget {
  id: string
  pos: THREE.Vector3
  radius: number
}

interface Banana {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  life: number
  live: boolean
  key?: string // spawn id reported to the server on impact (one hit only)
}

interface Beam {
  group: THREE.Group
  mats: THREE.MeshBasicMaterial[]
  life: number
  maxLife: number
}

const bananaGeo = new THREE.CapsuleGeometry(BANANA.radius * 0.55, BANANA.radius * 1.4, 4, 8)
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true)
const discGeo = new THREE.CircleGeometry(1, 16)

/**
 * Banana projectiles + laser beams for the Phase 5 ranged upgrades.
 * Visuals live here; damage/authority stays in Game + the server.
 */
export class Projectiles {
  private scene: THREE.Scene
  private bananas: Banana[] = []
  private beams: Beam[] = []
  private bananaMat = new THREE.MeshStandardMaterial({
    color: 0xffd93b,
    emissive: new THREE.Color(0x6b5300),
    roughness: 0.55,
    flatShading: true,
  })

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.onBananaImpact = undefined
  }
  /** Optional hook (set by Game): runs when a banana impact is registered. */
  onBananaImpact: ((x: number, z: number) => void) | undefined

  fireBanana(origin: THREE.Vector3, dir: THREE.Vector3, live: boolean, key?: string) {
    const mesh = new THREE.Mesh(bananaGeo, this.bananaMat)
    mesh.position.copy(origin)
    mesh.castShadow = true
    this.scene.add(mesh)
    this.bananas.push({
      mesh,
      vel: dir.clone().normalize().multiplyScalar(BANANA.speed),
      life: BANANA.life,
      live,
      key,
    })
  }

  /** Instant searing beam from origin along dir, clipped to `length`. */
  fireBeam(origin: THREE.Vector3, dir: THREE.Vector3, length: number, v2 = false) {
    const d = dir.clone().normalize()
    const group = new THREE.Group()
    const mats: THREE.MeshBasicMaterial[] = []

    const addCyl = (radius: number, color: number, opacity: number) => {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      mats.push(mat)
      const mesh = new THREE.Mesh(beamGeo, mat)
      mesh.scale.set(radius, length, radius)
      group.add(mesh)
    }

    const mul = v2 ? 2.5 : 1
    addCyl(0.28 * mul, 0x3a0000, 0.55) // dark blood halo
    addCyl(0.12 * mul, 0xff1100, 0.95) // searing red
    addCyl(0.045 * mul, 0xffe8e0, 1) // white-hot core

    const impact = new THREE.Mesh(
      discGeo,
      new THREE.MeshBasicMaterial({
        color: 0xff2200,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    )
    mats.push(impact.material as THREE.MeshBasicMaterial)
    impact.scale.setScalar(0.55)
    impact.position.y = length / 2
    group.add(impact)

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.7, 18),
      new THREE.MeshBasicMaterial({
        color: 0x990000,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    )
    mats.push(ring.material as THREE.MeshBasicMaterial)
    ring.position.y = length / 2
    group.add(ring)

    group.position.copy(origin).addScaledVector(d, length / 2)
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d)
    this.scene.add(group)
    this.beams.push({ group, mats, life: LASER.beamTime, maxLife: LASER.beamTime })
  }

  update(
    dt: number,
    targets: HitTarget[],
    onHit: (id: string, at: THREE.Vector3, dir: THREE.Vector3, key?: string) => void
  ) {
    for (let i = this.bananas.length - 1; i >= 0; i--) {
      const b = this.bananas[i]
      b.life -= dt
      b.vel.y += BANANA.gravity * dt
      b.mesh.position.addScaledVector(b.vel, dt)
      b.mesh.rotation.x += dt * 14
      b.mesh.rotation.z += dt * 9

      let consumed = b.life <= 0 || b.mesh.position.y < -12

      if (!consumed && b.live) {
        for (const t of targets) {
          if (b.mesh.position.distanceTo(t.pos) <= t.radius + BANANA.radius) {
            onHit(t.id, b.mesh.position.clone(), b.vel.clone().normalize(), b.key)
            this.onBananaImpact?.(b.mesh.position.x, b.mesh.position.z)
            consumed = true
            break
          }
        }
      }

      if (consumed) {
        this.scene.remove(b.mesh)
        this.bananas.splice(i, 1)
      }
    }

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i]
      beam.life -= dt
      const fade = Math.max(0, beam.life / beam.maxLife)
      for (const mat of beam.mats) mat.opacity = fade * (mat.color.getHex() === 0xffe8e0 ? 1 : 0.9)
      if (beam.life <= 0) {
        this.scene.remove(beam.group)
        for (const mat of beam.mats) mat.dispose()
        this.beams.splice(i, 1)
      }
    }
  }

  /** Nearest gorilla intersecting the ray, ignoring hits beyond maxDist. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, targets: HitTarget[], maxDist = LASER.range): HitTarget | null {
    const d = dir.clone().normalize()
    let best: HitTarget | null = null
    let bestT = maxDist
    const rel = new THREE.Vector3()
    for (const t of targets) {
      rel.subVectors(t.pos, origin)
      const along = rel.dot(d)
      if (along < 0.05 || along > maxDist) continue
      const perp = Math.sqrt(Math.max(0, rel.lengthSq() - along * along))
      if (perp > LASER.radius + t.radius) continue
      if (along < bestT) {
        bestT = along
        best = t
      }
    }
    return best
  }

  dispose() {
    for (const b of this.bananas) this.scene.remove(b.mesh)
    for (const b of this.beams) {
      this.scene.remove(b.group)
      for (const mat of b.mats) mat.dispose()
    }
    this.bananas = []
    this.beams = []
    this.bananaMat.dispose()
  }
}
