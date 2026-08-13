/**
 * Arena — static geometry + climb-zone / platform data.
 *
 * buildArena() fills ARENA_PLATFORMS (standing/landing queries) and
 * CLIMB_ZONES (vertical faces). Climb-zone `normal` is the outward direction
 * (wall → air); Game.climbMetrics() uses that as the signed-distance axis.
 */
import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { ARENA, COLORS, GROUND_GROUP } from './constants'

const GROUND_MASK = 0xffffffff

// Climbable vertical surface. Faces are the four sides of a box; poles are
// tree trunks / vines you can circle all the way around.
export type ClimbZone =
  | {
      kind: 'face'
      axis: 'x' | 'z'
      plane: number
      normal: 1 | -1
      center: number
      halfLen: number
      baseY: number
      topY: number
    }
  | {
      kind: 'pole'
      cx: number
      cz: number
      radius: number
      baseY: number
      topY: number
    }

export function pushFaceZones(x0: number, z0: number, w: number, d: number, baseY: number, topY: number) {
  const cx = x0 + w / 2
  const cz = z0 + d / 2
  CLIMB_ZONES.push(
    { kind: 'face', axis: 'x', plane: x0, normal: -1, center: cz, halfLen: d / 2, baseY, topY },
    { kind: 'face', axis: 'x', plane: x0 + w, normal: 1, center: cz, halfLen: d / 2, baseY, topY },
    { kind: 'face', axis: 'z', plane: z0, normal: -1, center: cx, halfLen: w / 2, baseY, topY },
    { kind: 'face', axis: 'z', plane: z0 + d, normal: 1, center: cx, halfLen: w / 2, baseY, topY }
  )
}

export function pushPole(cx: number, cz: number, radius: number, baseY: number, topY: number) {
  CLIMB_ZONES.push({ kind: 'pole', cx, cz, radius, baseY, topY })
}

/** Remove a previously-pushed pole by cx/cz (for toppled trees). */
export function removePole(cx: number, cz: number, radius: number) {
  for (let i = CLIMB_ZONES.length - 1; i >= 0; i--) {
    const z = CLIMB_ZONES[i]
    if (z.kind === 'pole' && z.cx === cx && z.cz === cz && z.radius === radius) {
      CLIMB_ZONES.splice(i, 1)
      return
    }
  }
}

// Axis-aligned box footprint of a solid surface, for standing/landing queries.
export interface PlatformDef {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  top: number
}

export const ARENA_PLATFORMS: PlatformDef[] = []
export const CLIMB_ZONES: ClimbZone[] = []
export type TreeApis = ReturnType<typeof buildArena>

/** Highest platform top at (x, z) whose surface is at or below belowY. */
export function groundHeightAt(x: number, z: number, belowY: number): number {
  let best = -Infinity
  for (const p of ARENA_PLATFORMS) {
    if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && p.top <= belowY && p.top > best) {
      best = p.top
    }
  }
  return best
}

/**
 * First hit distance of a ray against arena boxes (platform tops + sides).
 * Used by Laser Eyes so the beam stops on walls instead of going through them.
 */
export function raycastArena(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number
): number {
  const len = Math.hypot(dx, dy, dz) || 1
  const rx = dx / len
  const ry = dy / len
  const rz = dz / len
  let best = maxDist
  for (const p of ARENA_PLATFORMS) {
    const t = rayAabb(ox, oy, oz, rx, ry, rz, p.minX, 0, p.minZ, p.maxX, p.top, p.maxZ)
    if (t !== null && t > 0.05 && t < best) best = t
  }
  // Trees and vines are pole climb-zones. Treat them as vertical cylinders so
  // laser cover matches what the player can visibly collide/climb against.
  for (const z of CLIMB_ZONES) {
    if (z.kind !== 'pole') continue
    if (oy < z.baseY || oy > z.topY) continue
    const px = ox - z.cx
    const pz = oz - z.cz
    const a = rx * rx + rz * rz
    if (a < 1e-6) continue
    const b = 2 * (px * rx + pz * rz)
    const c = px * px + pz * pz - z.radius * z.radius
    const disc = b * b - 4 * a * c
    if (disc < 0) continue
    const root = Math.sqrt(disc)
    const t0 = (-b - root) / (2 * a)
    const t1 = (-b + root) / (2 * a)
    const t = t0 > 0.05 ? t0 : t1 > 0.05 ? t1 : null
    if (t !== null && t < best) best = t
  }
  return best
}

function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number | null {
  const invX = dx !== 0 ? 1 / dx : 1e12
  const invY = dy !== 0 ? 1 / dy : 1e12
  const invZ = dz !== 0 ? 1 / dz : 1e12
  let tmin = ((dx >= 0 ? minX : maxX) - ox) * invX
  let tmax = ((dx >= 0 ? maxX : minX) - ox) * invX
  const tymin = ((dy >= 0 ? minY : maxY) - oy) * invY
  const tymax = ((dy >= 0 ? maxY : minY) - oy) * invY
  if (tmin > tymax || tymin > tmax) return null
  if (tymin > tmin) tmin = tymin
  if (tymax < tmax) tmax = tymax
  const tzmin = ((dz >= 0 ? minZ : maxZ) - oz) * invZ
  const tzmax = ((dz >= 0 ? maxZ : minZ) - oz) * invZ
  if (tmin > tzmax || tzmin > tmax) return null
  if (tzmin > tmin) tmin = tzmin
  if (tzmax < tmax) tmax = tzmax
  if (tmax < 0) return null
  return tmin >= 0 ? tmin : tmax
}

// ---- Procedural textures (no external assets) ------------------------------
function makeStoneTexture(): THREE.Texture {
  const size = 512
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!

  ctx.fillStyle = '#75824f'
  ctx.fillRect(0, 0, size, size)

  const tiles = 5
  const step = size / tiles
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const shade = 105 + Math.floor(Math.random() * 55)
      // Jungle floor: green-leaning stone with moss.
      ctx.fillStyle = `rgb(${Math.floor(shade * 0.72)},${Math.floor(shade * 0.92)},${Math.floor(
        shade * 0.6
      )})`
      const pad = 4 + Math.random() * 3
      ctx.fillRect(i * step + pad, j * step + pad, step - pad * 2, step - pad * 2)
    }
  }

  const img = ctx.getImageData(0, 0, size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * 2 - 1) * 22
    d[i] += n
    d[i + 1] += n
    d[i + 2] += n
  }
  ctx.putImageData(img, 0, 0)

  for (let k = 0; k < 60; k++) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = 12 + Math.random() * 44
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(74,128,44,0.55)')
    g.addColorStop(1, 'rgba(74,128,44,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.strokeStyle = 'rgba(40,36,28,0.35)'
  ctx.lineWidth = 1.5
  for (let k = 0; k < 16; k++) {
    ctx.beginPath()
    let x = Math.random() * size
    let y = Math.random() * size
    ctx.moveTo(x, y)
    for (let s = 0; s < 5; s++) {
      x += (Math.random() * 2 - 1) * 40
      y += (Math.random() * 2 - 1) * 40
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(2, 2)
  tex.anisotropy = 4
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeSideTexture(): THREE.Texture {
  const w = 256
  const h = 64
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!

  ctx.fillStyle = '#6f6856'
  ctx.fillRect(0, 0, w, h)

  const rows = 4
  for (let r = 0; r < rows; r++) {
    const y = r * (h / rows)
    ctx.fillStyle = `rgb(${90 + Math.random() * 30},${84 + Math.random() * 30},${
      72 + Math.random() * 26
    })`
    ctx.fillRect(0, y + 2, w, h / rows - 4)
    const off = (r % 2) * (w / 8)
    ctx.strokeStyle = 'rgba(40,36,28,0.4)'
    ctx.lineWidth = 2
    for (let bx = off; bx < w; bx += w / 4) {
      ctx.beginPath()
      ctx.moveTo(bx, y)
      ctx.lineTo(bx, y + h / rows)
      ctx.stroke()
    }
  }

  for (let k = 0; k < 32; k++) {
    const x = Math.random() * w
    const len = 8 + Math.random() * 30
    const g = ctx.createLinearGradient(x, 0, x, len)
    g.addColorStop(0, 'rgba(80,120,50,0.5)')
    g.addColorStop(1, 'rgba(80,120,50,0)')
    ctx.fillStyle = g
    ctx.fillRect(x, 0, 4, len)
  }

  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(6, 1)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function buildArena(
  scene: THREE.Scene,
  world: CANNON.World,
  materialGround: CANNON.Material
) {
  const H = ARENA.half
  const T = ARENA.thickness

  // Reset module-level layout data (guards against HMR re-mounts)
  ARENA_PLATFORMS.length = 0
  CLIMB_ZONES.length = 0

  scene.fog = new THREE.Fog(COLORS.fog, 150, 520)

  // --- Gradient sky dome ---
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      top: { value: new THREE.Color(COLORS.skyTop) },
      bottom: { value: new THREE.Color(COLORS.skyBottom) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 bottom;
      void main(){ float h = normalize(vP).y * 0.5 + 0.5;
      gl_FragColor = vec4(mix(bottom, top, smoothstep(0.0, 1.0, h)), 1.0); }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat))

  // --- Lights ---
  scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x6b5a3a, 1.0))
  const sun = new THREE.DirectionalLight(COLORS.sun, 2.1)
  sun.position.set(50, 70, 40)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.near = 1
  sun.shadow.camera.far = 170
  const sc = sun.shadow.camera as THREE.OrthographicCamera
  sc.left = -60
  sc.right = 60
  sc.top = 60
  sc.bottom = -60
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.02
  scene.add(sun)
  scene.add(new THREE.AmbientLight(0xffffff, 0.25))

  // --- Platform visuals ---
  const group = new THREE.Group()
  scene.add(group)

  const topMat = new THREE.MeshStandardMaterial({
    map: makeStoneTexture(),
    roughness: 0.95,
    metalness: 0,
  })
  const sideMat = new THREE.MeshStandardMaterial({
    map: makeSideTexture(),
    color: 0x9a907c,
    roughness: 1,
    metalness: 0,
  })

  // Base ground slab (whole footprint)
  const block = new THREE.Mesh(new THREE.BoxGeometry(H * 2, T, H * 2), sideMat)
  block.position.y = -T / 2
  block.receiveShadow = true
  block.castShadow = true
  group.add(block)

  const slab = new THREE.Mesh(new THREE.BoxGeometry(H * 2 - 0.8, 0.3, H * 2 - 0.8), topMat)
  slab.position.y = -0.14
  slab.receiveShadow = true
  group.add(slab)

  ARENA_PLATFORMS.push({ minX: -H, maxX: H, minZ: -H, maxZ: H, top: 0 })

  // Ground collider (static box, top surface at y = 0)
  const ground = new CANNON.Body({ mass: 0, material: materialGround })
  ground.addShape(new CANNON.Box(new CANNON.Vec3(H, T / 2, H)))
  ground.position.set(0, -T / 2, 0)
  ground.collisionFilterGroup = GROUND_GROUP
  ground.collisionFilterMask = GROUND_MASK
  world.addBody(ground)

  // --- Tiered platforms (each adds a collider, a platform def, and 4 climb zones) ---
  const addPlatform = (x0: number, z0: number, w: number, d: number, baseY: number, topY: number) => {
    const cx = x0 + w / 2
    const cz = z0 + d / 2
    const h = topY - baseY

    const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), sideMat)
    block.position.set(cx, baseY + h / 2, cz)
    block.castShadow = true
    block.receiveShadow = true
    group.add(block)

    const slab = new THREE.Mesh(new THREE.BoxGeometry(w - 0.6, 0.3, d - 0.6), topMat)
    slab.position.set(cx, topY - 0.14, cz)
    slab.receiveShadow = true
    group.add(slab)

    const body = new CANNON.Body({ mass: 0, material: materialGround })
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)))
    body.position.set(cx, baseY + h / 2, cz)
    body.collisionFilterGroup = GROUND_GROUP
    body.collisionFilterMask = GROUND_MASK
    world.addBody(body)

    ARENA_PLATFORMS.push({ minX: x0, maxX: x0 + w, minZ: z0, maxZ: z0 + d, top: topY })
    pushFaceZones(x0, z0, w, d, baseY, topY)
  }

  // North-east ruin-pyramid: three stacked tiers, connected by climb faces.
  // The top tier is the high ground — view of everything, great throw angles.
  addPlatform(16, -36, 18, 18, 0, 5)    // tier 1 (low)
  addPlatform(18, -33, 12, 12, 5, 11)   // tier 2 (mid)
  addPlatform(20, -30, 6, 6, 11, 17)    // tier 3 (high ground)

  // South-west cliff and south ledge — secondary routes at lower heights.
  addPlatform(-34, 22, 18, 14, 0, 7)    // west cliff
  addPlatform(-14, 30, 20, 7, 0, 3.5)   // south ledge

  // North-west hill + south-east jungle ruins spread the map out.
  addPlatform(-36, -36, 16, 16, 0, 6)   // NW hill
  addPlatform(24, 24, 16, 16, 0, 6.5)   // SE ruins

  // --- Ruins (ground flavor; keep clear of platform footprints) ---
  const ruinMatA = new THREE.MeshStandardMaterial({ color: 0x9a9484, roughness: 1, flatShading: true })
  const ruinMatB = new THREE.MeshStandardMaterial({ color: 0x87806f, roughness: 1, flatShading: true })
  const ruinMatC = new THREE.MeshStandardMaterial({ color: 0xa39c8a, roughness: 1, flatShading: true })

  const addRuin = (x: number, z: number, w: number, h: number, d: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    mesh.position.set(x, h / 2, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    const body = new CANNON.Body({ mass: 0, material: materialGround })
    body.addShape(new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)))
    body.position.set(x, h / 2, z)
    body.collisionFilterGroup = GROUND_GROUP
    body.collisionFilterMask = GROUND_MASK
    world.addBody(body)
    ARENA_PLATFORMS.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: h })
    pushFaceZones(x - w / 2, z - d / 2, w, d, 0, h)
  }

  const e = H - 1
  addRuin(e, e, 1.2, 2.6, 1.2, ruinMatA)
  addRuin(-e, e, 1.2, 1.7, 1.2, ruinMatB)
  addRuin(-e, -e, 1.2, 2.9, 1.2, ruinMatA)
  addRuin(H - 0.6, 0, 1.0, 0.9, 2.4, ruinMatC)
  addRuin(-(H - 0.6), 0, 1.0, 0.7, 2.4, ruinMatC)
  addRuin(0, H - 0.6, 2.4, 1.0, 1.0, ruinMatC)
  addRuin(0, -(H - 0.6), 2.4, 0.8, 1.0, ruinMatC)

  // Scattered jungle ruins in the interior.
  addRuin(6, 14, 1.4, 2.2, 1.4, ruinMatB)
  addRuin(-10, -14, 1.6, 1.6, 1.6, ruinMatA)
  addRuin(18, -8, 1.2, 3.0, 1.2, ruinMatC)
  addRuin(-24, -4, 1.4, 1.4, 1.4, ruinMatB)
  addRuin(2, -22, 1.8, 2.6, 1.8, ruinMatA)

  // --- Climbable jungle trees + hanging vines (playable area) ---
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4326, flatShading: true, roughness: 1 })
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f6a2e, flatShading: true, roughness: 1 })
  const vineMat = new THREE.MeshStandardMaterial({ color: 0x4a7a32, roughness: 0.85, flatShading: true })

  /**
   * Destructible tree registry. Each tree is its own record so it can be
   * toppled independently. When broken, the trunk mesh is removed and a
   * tilted stub appears in its place; after a regrow window the tree respawns
   * fully. Game calls damageTreeAt(x, z, radius) on banana impacts.
   */
  interface Tree {
    id: number
    cx: number
    cz: number
    height: number
    radius: number
    body: CANNON.Body
    trunkMesh: THREE.Mesh
    canopy1: THREE.Mesh
    canopy2: THREE.Mesh
    intact: boolean
    regrowAt: number
  }
  const trees: Tree[] = []
  const TREE_REGROW_MS = 60000

  const addTree = (cx: number, cz: number, height: number) => {
    const radius = 0.38
    const k = height / 10
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.85, radius * 1.15, height, 7),
      trunkMat
    )
    trunk.position.set(cx, height / 2, cz)
    trunk.castShadow = true
    trunk.receiveShadow = true
    group.add(trunk)
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.1 * k, 3.6 * k, 7), leafMat)
    canopy.position.set(cx, height + 0.5 * k, cz)
    canopy.castShadow = true
    group.add(canopy)
    const canopy2 = new THREE.Mesh(new THREE.ConeGeometry(1.5 * k, 2.6 * k, 7), leafMat)
    canopy2.position.set(cx, height + 1.8 * k, cz)
    group.add(canopy2)
    const body = new CANNON.Body({ mass: 0, material: materialGround })
    body.addShape(new CANNON.Cylinder(radius, radius, height, 8))
    body.position.set(cx, height / 2, cz)
    body.collisionFilterGroup = GROUND_GROUP
    body.collisionFilterMask = GROUND_MASK
    world.addBody(body)
    pushPole(cx, cz, radius, 0, height)
    trees.push({
      id: trees.length,
      cx,
      cz,
      height,
      radius,
      body,
      trunkMesh: trunk,
      canopy1: canopy,
      canopy2: canopy2,
      intact: true,
      regrowAt: 0,
    })
  }

  /**
   * Break every standing tree within `radius` of (x, z) on the XZ plane.
   * Idempotent and safe to call at 20 Hz. Returns true if at least one
   * tree was toppled.
   */
  function damageTreeAt(x: number, z: number, radius: number): boolean {
    let hit = false
    for (const t of trees) {
      if (!t.intact) continue
      const d = Math.hypot(t.cx - x, t.cz - z)
      if (d > radius + t.radius) continue
      // Topple: hide the standing meshes, remove the climb pole + collider.
      t.trunkMesh.visible = false
      t.canopy1.visible = false
      t.canopy2.visible = false
      t.intact = false
      t.regrowAt = Date.now() + TREE_REGROW_MS
      // Replace the static collider with a dynamic toppled stub that
      // projectiles + players can still collide with.
      t.body.shapes = []
      t.body.updateMassProperties()
      world.removeBody(t.body)
      const stub = new CANNON.Body({ mass: 6, material: materialGround })
      stub.addShape(new CANNON.Sphere(t.radius * 1.2))
      stub.position.set(t.cx, 0.4, t.cz)
      stub.linearDamping = 0.6
      stub.angularDamping = 0.5
      stub.collisionFilterGroup = GROUND_GROUP
      stub.collisionFilterMask = GROUND_MASK
      world.addBody(stub)
      t.body = stub
      // Drop the climb pole from raycast/climb queries too.
      removePole(t.cx, t.cz, t.radius)
      hit = true
    }
    return hit
  }

  /** Regrow any toppled trees whose timer has elapsed. */
  function regrowTrees() {
    const now = Date.now()
    for (const t of trees) {
      if (t.intact || t.regrowAt === 0 || now < t.regrowAt) continue
      world.removeBody(t.body)
      const body = new CANNON.Body({ mass: 0, material: materialGround })
      body.addShape(new CANNON.Cylinder(t.radius, t.radius, t.height, 8))
      body.position.set(t.cx, t.height / 2, t.cz)
      body.collisionFilterGroup = GROUND_GROUP
      body.collisionFilterMask = GROUND_MASK
      world.addBody(body)
      t.body = body
      t.trunkMesh.visible = true
      t.canopy1.visible = true
      t.canopy2.visible = true
      t.intact = true
      t.regrowAt = 0
      pushPole(t.cx, t.cz, t.radius, 0, t.height)
    }
  }

  return { damageTreeAt, regrowTrees }

  const addVine = (cx: number, cz: number, topY: number) => {
    const len = topY
    const vine = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, len, 6), vineMat)
    vine.position.set(cx, len / 2, cz)
    vine.castShadow = true
    group.add(vine)
    pushPole(cx, cz, 0.22, 0, topY)
  }

  // A real jungle: dense tree clusters, tall giants with vines, and ferns.
  const addBush = (x: number, z: number, s: number) => {
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.9 * s, 1.4 * s, 7), leafMat)
    b.position.set(x, 0.7 * s, z)
    b.castShadow = true
    group.add(b)
  }

  addTree(-8, -10, 9)
  addTree(6, 12, 11)
  addTree(-14, 4, 10)
  addTree(14, -4, 8)
  addTree(-4, -20, 12)
  addTree(20, -14, 13)
  addTree(-20, 14, 12)
  addTree(10, -26, 10)
  addTree(-26, -14, 14)
  addTree(26, 6, 11)
  addTree(-16, -28, 9)
  addTree(30, -6, 12)
  addTree(-30, -24, 10)
  addTree(0, 24, 13)
  addTree(-10, 24, 9)
  addTree(10, 6, 8)
  addTree(-22, 24, 10)
  addTree(22, 26, 9)
  addTree(4, -34, 12)
  addTree(-6, 34, 11)
  addTree(30, 16, 10)
  addTree(-34, 8, 9)
  addTree(12, 32, 8)
  addTree(-28, 32, 10)

  // Hanging vines — jungle routes up to the canopy.
  addVine(-8, -10, 9)
  addVine(6, 12, 11)
  addVine(-4, -20, 12)
  addVine(20, -14, 13)
  addVine(0, 24, 13)
  addVine(26, 6, 11)
  addVine(-20, 14, 12)
  addVine(30, -6, 12)
  addVine(4, -34, 12)
  addVine(-6, 34, 11)

  // Ferns / bushes under the canopy.
  addBush(0, -6, 1)
  addBush(4, 4, 0.8)
  addBush(-6, -2, 1.2)
  addBush(8, 18, 0.9)
  addBush(-12, 18, 1.1)
  addBush(16, 10, 0.8)
  addBush(-18, -6, 1)
  addBush(24, 0, 0.9)
  addBush(-24, 0, 1.1)
  addBush(6, -28, 0.9)
  addBush(-14, -20, 1)
  addBush(28, 20, 0.8)
  addBush(-30, 18, 0.9)
  addBush(-2, 28, 1)
  addBush(16, -20, 1.1)
  addBush(-20, -30, 0.8)

  // --- Distant floating islands (atmosphere only) ---
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b5840, flatShading: true, roughness: 1 })
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x4f7a36, flatShading: true, roughness: 1 })

  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + Math.random()
    const rad = 190 + Math.random() * 130
    const ig = new THREE.Group()
    ig.position.set(Math.cos(ang) * rad, -8 - Math.random() * 20, Math.sin(ang) * rad)
    const rs = 4 + Math.random() * 4
    const rock = new THREE.Mesh(new THREE.ConeGeometry(rs, 5 + Math.random() * 5, 6), rockMat)
    rock.position.y = -2
    ig.add(rock)
    const grass = new THREE.Mesh(new THREE.ConeGeometry(rs, 1.6, 6), grassMat)
    grass.position.y = 1.2
    grass.rotation.y = Math.random()
    ig.add(grass)
    if (Math.random() > 0.4) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 2.4, 6), trunkMat)
      trunk.position.y = 2.4
      ig.add(trunk)
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.4, 7), leafMat)
      leaf.position.y = 4.2
      ig.add(leaf)
      const leaf2 = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.4, 7), leafMat)
      leaf2.position.y = 5.4
      ig.add(leaf2)
    }
    ig.scale.setScalar(0.8 + Math.random() * 1.3)
    scene.add(ig)
  }
}
