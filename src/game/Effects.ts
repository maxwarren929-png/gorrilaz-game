import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { DOMAIN } from './constants'

interface Particle {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  angVel: THREE.Vector3
  life: number
  maxLife: number
  scale0: number
}

interface Ring {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  maxScale: number
  /** Initial opacity — fade is computed from this so first-frame opacity matches creation. */
  opacity0: number
}

interface DomainFX {
  group: THREE.Group
  /** Solid black wall material (basic — fully opaque). */
  wallMat: THREE.MeshBasicMaterial
  /** Optional decorative shell on the same sphere (rim glow, etc.). */
  domeMat: THREE.MeshBasicMaterial
  bananas: THREE.Object3D[]
  mats: THREE.Material[]
  /** Per-domain inline geometries (dome + plant trunks/leaves) — disposed on despawn. */
  geometries: THREE.BufferGeometry[]
  life: number
  maxLife: number
  /** Visual radius (shell). The physics shell is the same so the inside is
   *  protected from projectiles passing through. */
  radius: number
  /** Optional pointer back to the physics body so Game can despawn it. */
  body?: CANNON.Body
  scene: THREE.Scene
  world: CANNON.World
  mat: CANNON.Material
}

const shardGeo = new THREE.TetrahedronGeometry(0.14)
const starGeo = new THREE.OctahedronGeometry(0.18)
const ringGeo = new THREE.RingGeometry(0.2, 0.38, 24)
// Crescent banana shape for the Domain Expansion environment.
const bananaGeo = new THREE.TorusGeometry(0.5, 0.17, 8, 14, Math.PI * 1.4)

export class Effects {
  private scene: THREE.Scene
  private particles: Particle[] = []
  private rings: Ring[] = []
  private domains: DomainFX[] = []

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  burst(pos: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.1 + Math.random() * 0.06, 0.85, 0.6),
        emissive: new THREE.Color(0xffe08a),
        emissiveIntensity: 0.6,
        flatShading: true,
        transparent: true,
        opacity: 1,
      })
      const mesh = new THREE.Mesh(shardGeo, mat)
      mesh.position.copy(pos)
      const speed = 4 + Math.random() * 7
      const v = new THREE.Vector3(
        dir.x + (Math.random() * 2 - 1) * 1.3,
        0.6 + Math.random() * 1.7,
        dir.z + (Math.random() * 2 - 1) * 1.3
      )
        .normalize()
        .multiplyScalar(speed)
      this.scene.add(mesh)
      this.particles.push({
        mesh,
        vel: v,
        angVel: new THREE.Vector3(
          (Math.random() * 2 - 1) * 10,
          (Math.random() * 2 - 1) * 10,
          (Math.random() * 2 - 1) * 10
        ),
        life: 0,
        maxLife: 0.45 + Math.random() * 0.3,
        scale0: 0.6 + Math.random() * 0.9,
      })
    }

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(pos.x, 0.06, pos.z)
    this.scene.add(ring)
    this.rings.push({ mesh: ring, life: 0, maxLife: 0.35, maxScale: 5, opacity0: 0.9 })
  }

  slam(pos: THREE.Vector3) {
    // Heavy downward slam floor impact explosion
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? 0xff4500 : 0xffaa00,
        emissive: new THREE.Color(0xff7700),
        emissiveIntensity: 0.8,
        flatShading: true,
        transparent: true,
        opacity: 1,
      })
      const mesh = new THREE.Mesh(shardGeo, mat)
      mesh.position.set(
        pos.x + (Math.random() * 2 - 1) * 0.3,
        Math.max(0.1, pos.y),
        pos.z + (Math.random() * 2 - 1) * 0.3
      )
      const ang = Math.random() * Math.PI * 2
      const spd = 6 + Math.random() * 12
      const v = new THREE.Vector3(
        Math.cos(ang) * spd,
        1.5 + Math.random() * 8,
        Math.sin(ang) * spd
      )
      this.scene.add(mesh)
      this.particles.push({
        mesh,
        vel: v,
        angVel: new THREE.Vector3(
          (Math.random() * 2 - 1) * 16,
          (Math.random() * 2 - 1) * 16,
          (Math.random() * 2 - 1) * 16
        ),
        life: 0,
        maxLife: 0.5 + Math.random() * 0.4,
        scale0: 0.9 + Math.random() * 1.2,
      })
    }

    // Double expanding ground shockwave ring
    const ringMat1 = new THREE.MeshBasicMaterial({
      color: 0xff3300,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    })
    const ring1 = new THREE.Mesh(ringGeo, ringMat1)
    ring1.rotation.x = -Math.PI / 2
    ring1.position.set(pos.x, 0.08, pos.z)
    this.scene.add(ring1)
    this.rings.push({ mesh: ring1, life: 0, maxLife: 0.45, maxScale: 8, opacity0: 0.95 })

    const ringMat2 = new THREE.MeshBasicMaterial({
      color: 0xffcc00,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    })
    const ring2 = new THREE.Mesh(ringGeo, ringMat2)
    ring2.rotation.x = -Math.PI / 2
    ring2.position.set(pos.x, 0.12, pos.z)
    this.scene.add(ring2)
    this.rings.push({ mesh: ring2, life: 0, maxLife: 0.35, maxScale: 11, opacity0: 0.8 })
  }

  throw(pos: THREE.Vector3, dir: THREE.Vector3) {
    // Directional throw trail shards
    for (let i = 0; i < 22; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x33ffff,
        emissive: new THREE.Color(0x00aaff),
        emissiveIntensity: 0.9,
        flatShading: true,
        transparent: true,
        opacity: 1,
      })
      const mesh = new THREE.Mesh(starGeo, mat)
      mesh.position.copy(pos)
      const spd = 8 + Math.random() * 14
      const v = new THREE.Vector3(
        dir.x * spd + (Math.random() * 2 - 1) * 2.5,
        dir.y * spd + (Math.random() * 2 - 1) * 2.5,
        dir.z * spd + (Math.random() * 2 - 1) * 2.5
      )
      this.scene.add(mesh)
      this.particles.push({
        mesh,
        vel: v,
        angVel: new THREE.Vector3(
          (Math.random() * 2 - 1) * 14,
          (Math.random() * 2 - 1) * 14,
          (Math.random() * 2 - 1) * 14
        ),
        life: 0,
        maxLife: 0.4 + Math.random() * 0.3,
        scale0: 0.8 + Math.random() * 0.8,
      })
    }

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x88ffff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize())
    ring.position.copy(pos)
    this.scene.add(ring)
    this.rings.push({ mesh: ring, life: 0, maxLife: 0.4, maxScale: 7, opacity0: 0.9 })
  }

  grab(pos: THREE.Vector3) {
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(pos.x, Math.max(0.1, pos.y), pos.z)
    this.scene.add(ring)
    this.rings.push({ mesh: ring, life: 0, maxLife: 0.28, maxScale: 4, opacity0: 0.95 })
  }

  escape(pos: THREE.Vector3) {
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffdd44,
        emissive: new THREE.Color(0xffff88),
        emissiveIntensity: 0.7,
        flatShading: true,
        transparent: true,
        opacity: 1,
      })
      const mesh = new THREE.Mesh(starGeo, mat)
      mesh.position.copy(pos)
      const ang = Math.random() * Math.PI * 2
      const spd = 3 + Math.random() * 5
      const v = new THREE.Vector3(Math.cos(ang) * spd, 2 + Math.random() * 4, Math.sin(ang) * spd)
      this.scene.add(mesh)
      this.particles.push({
        mesh,
        vel: v,
        angVel: new THREE.Vector3(
          (Math.random() * 2 - 1) * 12,
          (Math.random() * 2 - 1) * 12,
          (Math.random() * 2 - 1) * 12
        ),
        life: 0,
        maxLife: 0.35 + Math.random() * 0.2,
        scale0: 0.7,
      })
    }
  }

  update(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.life += dt
      p.vel.y -= 18 * dt
      p.mesh.position.addScaledVector(p.vel, dt)
      p.mesh.rotation.x += p.angVel.x * dt
      p.mesh.rotation.y += p.angVel.y * dt
      p.mesh.rotation.z += p.angVel.z * dt
      const t = p.life / p.maxLife
      p.mesh.scale.setScalar(Math.max(0.001, p.scale0 * (1 - t)))
      ;(p.mesh.material as THREE.MeshStandardMaterial).opacity = Math.max(0, 1 - t)
      if (p.life >= p.maxLife) {
        this.scene.remove(p.mesh)
        ;(p.mesh.material as THREE.Material).dispose()
        this.particles.splice(i, 1)
      }
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]
      r.life += dt
      const t = r.life / r.maxLife
      r.mesh.scale.setScalar(1 + t * r.maxScale)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, r.opacity0 * (1 - t))
      if (r.life >= r.maxLife) {
        this.scene.remove(r.mesh)
        ;(r.mesh.material as THREE.Material).dispose()
        this.rings.splice(i, 1)
      }
    }
    for (let i = this.domains.length - 1; i >= 0; i--) {
      const d = this.domains[i]
      d.life -= dt
      d.group.rotation.y += dt * 0.25
      // Bananas tumble slowly inside the void.
      for (const bm of d.bananas) bm.rotation.z += dt * 0.7
      if (d.life <= 0) {
        this.scene.remove(d.group)
        if (d.body) d.world.removeBody(d.body)
        for (const m of d.mats) m.dispose()
        for (const g of d.geometries) g.dispose()
        this.domains.splice(i, 1)
      }
    }
  }

  /**
   * Black opaque dome + small banana environment (Domain Expansion).
   * The wall is solid for projectiles (see Game.fireDomain for the body).
   */
  domain(pos: THREE.Vector3, v2: boolean, scene: THREE.Scene, world: CANNON.World, mat: CANNON.Material) {
    const radius = v2 ? DOMAIN.radius * 1.5 : DOMAIN.radius
    const group = new THREE.Group()
    group.position.copy(pos)
    const mats: THREE.Material[] = []
    const geometries: THREE.BufferGeometry[] = []

    // Fully opaque black shell with a subtle inner rim for depth.
    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.BackSide,
    })
    mats.push(wallMat)
    const domeGeo = new THREE.SphereGeometry(radius, 48, 24)
    geometries.push(domeGeo)
    const dome = new THREE.Mesh(domeGeo, wallMat)
    dome.renderOrder = 5
    group.add(dome)

    // Physics shell so projectiles (and players) cannot pass through.
    const body = new CANNON.Body({ mass: 0, material: mat })
    body.addShape(new CANNON.Sphere(radius))
    body.position.set(pos.x, pos.y, pos.z)
    body.collisionFilterGroup = 2 // GROUND_GROUP-equivalent
    body.collisionFilterMask = 0xffffffff
    world.addBody(body)

    // Banana environment: scattered bananas + a few banana plants.
    const bananaMat = new THREE.MeshStandardMaterial({
      color: 0xffd52e,
      emissive: 0x5b4700,
      roughness: 0.55,
      flatShading: true,
    })
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x2f4d20, roughness: 1, flatShading: true })
    mats.push(bananaMat, trunkMat)

    const bananas: THREE.Object3D[] = []
    const scatter = (n: number) => {
      for (let i = 0; i < n; i++) {
        const b = new THREE.Mesh(bananaGeo, bananaMat)
        const ang = Math.random() * Math.PI * 2
        const r = Math.sqrt(Math.random()) * radius * 0.72
        b.position.set(
          Math.cos(ang) * r,
          Math.random() * radius * 0.55 + 0.4,
          Math.sin(ang) * r
        )
        b.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
        b.scale.setScalar(0.7 + Math.random() * 0.7)
        group.add(b)
        bananas.push(b)
      }
    }
    scatter(18)

    // Mini banana plants inside the domain. Trunk + leaf geometries are
    // per-domain inline allocations — track them for cleanup.
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2
      const r = radius * 0.55
      const plant = new THREE.Group()
      plant.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r)
      const trunkGeo = new THREE.CylinderGeometry(0.1, 0.16, 1.6, 6)
      geometries.push(trunkGeo)
      const trunk = new THREE.Mesh(trunkGeo, trunkMat)
      trunk.position.y = 0.8
      plant.add(trunk)
      const leafGeo = new THREE.ConeGeometry(0.9, 1.6, 6)
      geometries.push(leafGeo)
      const leaf = new THREE.Mesh(leafGeo, trunkMat)
      leaf.position.y = 1.6
      plant.add(leaf)
      for (let k = 0; k < 4; k++) {
        const b = new THREE.Mesh(bananaGeo, bananaMat)
        const ka = (k / 4) * Math.PI * 2
        b.position.set(Math.cos(ka) * 0.45, 1.9, Math.sin(ka) * 0.45)
        b.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
        b.scale.setScalar(0.55)
        plant.add(b)
        bananas.push(b)
      }
      group.add(plant)
    }

    this.scene.add(group)
    this.domains.push({
      group,
      wallMat,
      domeMat: wallMat, // aliased; kept for type compatibility
      bananas,
      mats,
      geometries,
      life: DOMAIN.duration,
      maxLife: DOMAIN.duration,
      radius,
      body,
      scene,
      world,
      mat,
    })
  }

  /** Nearest active Domain Expansion shell position+radius for projectile blocking. */
  domainWalls(): { pos: THREE.Vector3; radius: number }[] {
    return this.domains.map((d) => ({ pos: d.group.position, radius: d.radius }))
  }

  dispose() {
    for (const p of this.particles) {
      this.scene.remove(p.mesh)
      ;(p.mesh.material as THREE.Material).dispose()
    }
    for (const r of this.rings) {
      this.scene.remove(r.mesh)
      ;(r.mesh.material as THREE.Material).dispose()
    }
    for (const d of this.domains) {
      this.scene.remove(d.group)
      if (d.body) d.world.removeBody(d.body)
      for (const m of d.mats) m.dispose()
      for (const g of d.geometries) g.dispose()
    }
    this.particles = []
    this.rings = []
    this.domains = []
  }
}
