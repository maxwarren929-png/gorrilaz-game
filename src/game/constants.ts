// ============================================================================
// Gorilla FFA — Phase 3 : Central tuning file.
// All "feel" numbers live here so the physics can be iterated quickly without
// hunting through components.
// ============================================================================

export const GROUND_GROUP = 1

export const PHYS = {
  gravity: -22, // slightly floaty arcade gravity (longer, funnier airtime)
  fixedTimeStep: 1 / 60,
  maxSubSteps: 4,
  solverIterations: 24,
}

// Big jungle arena: 80x80 footprint with tiers, ruins, trees and vines.
export const ARENA = {
  half: 40,
  thickness: 2,
}

// One torso/head sphere + four stubby limbs.
export const GORILLA = {
  torsoRadius: 0.7,
  torsoMass: 9,
  limbRadius: 0.34,
  limbMass: 1.1,
  shoulderX: 0.62,
  shoulderY: 0.16,
  hipX: 0.36,
  hipY: -0.5,
  hipZ: 0.02,
  coneAngleArm: 1.25, // radians — how far arms can flop
  coneAngleLeg: 0.85,
  twistAngle: 0.4,
  jointMaxForce: 1e7,
  linearDamping: 0.02,
  angularDamping: 0.02,
}

export const MOVEMENT = {
  force: 235, // tuned for the larger jungle map
  maxSpeed: 12,
  drag: 1.15, // enough grip to stop without the torso continuing to roll
  airDrag: 0.3,
  strideRate: 8.5,
  strideLength: 0.34,
  stepLift: 0.2,
  limbSpring: 105,
  limbDamping: 11,
  limbMaxForce: 145,
  idleLimbSpring: 62,
  stanceHeight: 1.08,
  stanceSpring: 520,
  stanceDamping: 78,
  stanceMaxForce: 430,
}

export const JUMP = {
  impulse: 125,      // sqrt(3) x impulse gives roughly 3 x the previous apex
  forward: 8,        // small shove in facing direction so jumps aren't purely vertical
  cooldown: 0.28,    // prevents bunny-hop spam
  coyote: 0.16,      // grace window after leaving a ledge
  ignoreStance: 0.2, // skip the stance spring so it doesn't cancel the hop
}

// Keeps the torso readable (mostly upright, faces travel direction) while still
// letting big hits knock it into a tumble.
export const UPRIGHT = {
  speed: 34, // strong locomotion balance prevents the torso becoming a wheel
  yawGain: 42,
  angularDamp: 9,
  maxAngular: 28, // cap to avoid explosions
  lean: 0.12,
  staggerTime: 0.72, // hits temporarily disable most balance assistance
  staggerAssist: 0.12,
}

export const PUNCH = {
  cooldown: 0.48,
  activeTime: 0.34,
  windupFraction: 0.28,
  armImpulse: 9, // starts the windup; a PD drive powers the visible swing
  armDrive: 230,
  armDamping: 13,
  armMaxForce: 300,
  armReach: 1.48,
  armUp: 0.18,
  armFlare: 4.5,
  torsoRecoil: 7,
  hitRadius: 2.25,
  bodyPad: 0.9,   // extra hit slack around the victim's torso (helps Big Gorilla)
  knockback: 86,
  knockUp: 0.36,
  spin: 24,
  limbFlail: 13,
  giantReach: 2.5,       // Big Gorilla's arm target extends past a normal haymaker
  giantArmDrive: 520,    // heavy two-stage arm shove
  giantArmMaxForce: 900, // multiplied by arm mass in Gorilla
}

export const GRAB = {
  reach: 2.6,            // distance check to grab target torso
  angleCos: -0.3,        // facing check (target must be in front of player)
  escapeTime: 3.2,       // seconds before grabbed dummy struggles free
  cooldown: 0.5,         // cooldown between grab attempts
  holdDistance: 1.6,     // must exceed 2 * torsoRadius (1.4) or the hold fights collision
  constraintMaxForce: 1e6, // max force for physics hold constraint
  slamForce: 170,        // strong downward + forward impact force
  slamUp: -0.85,         // downward vector component
  slamForward: 0.4,      // forward vector component
  slamStaggerTime: 1.4,  // disable balance assist so victim bounces/tumbles hard
  limbFlail: 14,         // limb scatter impulse on slam
}

// Charged throw: hold Q to wind up (the held gorilla gets swung back), release
// to launch. Power scales with charge time between min and max.
export const THROW = {
  chargeTime: 1.15,      // seconds of holding Q to reach max power
  minForce: 95,
  maxForce: 250,
  up: 0.55,              // upward arc fraction
  minSpin: 22,
  maxSpin: 62,           // comical tumbling at full charge
  limbFlail: 24,
}

// Climbing: press E facing a wall to latch on (jump first for higher faces —
// airborne grabs are forgiving; grounded grabs require actually facing the
// wall so casual walking + E doesn't accidentally stick you to scenery).
// Stay attached with WASD; Space wall-jumps off, E lets go.
export const CLIMB = {
  speed: 6.2,              // fast vertical scramble; running is still quickest laterally
  lateralSpeed: 5.4,       // quick branch/wall traversal
  acceleration: 12,       // smooth velocity blend instead of hard velocity snapping
  surfaceSpring: 24,       // magnetic pull toward the currently held surface
  surfaceDamping: 5.5,     // prevents bouncing away from rough terrain
  maxSurfaceSpeed: 5.0,    // cap magnetic correction so it never looks like teleporting
  reachAir: 2.8,           // generous reach for a deliberate jump-then-grab
  reachGround: 1.35,       // tight reach for a grounded grab (avoids false attaches)
  groundFacingMin: 0.15,   // grounded grab needs to be roughly facing the wall
  negativeSlack: 0.65,     // allow grabbing a hair past the wall plane itself
  sidePadding: 1.0,        // grab just beyond the left/right edge of a climb face
  verticalPadding: 1.4,    // grab slightly below the face or above its lip
  stayReach: 4.8,          // once attached, stay glued even across messy terrain
  staySidePadding: 2.8,    // wide enough to reach a neighboring face / corner
  stayVerticalSlack: 1.2,  // don't drop just because a ledge overhangs briefly
  wrapSearch: 4.2,         // look this far for the next surface when a face ends
  grabBuffer: 0.6,         // E stays buffered so a near-miss still latches
  reattachCooldown: 0.35,  // brief lock-out after letting go so you can't instantly re-latch
  attachDistance: 0.85,    // how close to the wall the torso is held
  minAttachHeight: 0.35,   // clamp low grabs onto a valid part of the climb face
  topAttachClearance: 0.18,// prevent attaching above a platform lip
  mantleHeight: 0.78,      // climb this far above a lip before physically surging over it
  mantleUpSpeed: 4.4,      // upward momentum during the mantle burst
  mantleInSpeed: 5.0,      // inward momentum onto the platform (no position teleport)
  topOutEdgeInset: 0.45,  // clamp a mantle away from the platform's side corners
  armReach: 1.15,          // long gorilla reaches toward the next hold
  armSpring: 210,          // strong planted-hand pull while latched
  armMaxForce: 280,
  armStep: 0.38,           // broad alternating hand-over-hand reach
  legStep: 0.32,           // lively foot scramble
  gaitRate: 9.2,           // fast climbing cadence
  latchImpulse: 8,         // soft initial pull, not a body teleport
  exitBoost: 2.4,          // forward shove when topping out
  exitPush: 2.2,           // sideways push off the wall when letting go / falling off
  wallJumpUp: 58,          // Space while climbing: hop off the wall
  wallJumpOut: 22,         // push away from the wall on a wall-jump
}

export const DUMMY = {
  force: 70, // slow, gentle wander force
  steerEdge: 0.78, // start steering inward at this fraction of half-extent
  changeInterval: 2.2,
}

// Raised/longer lens for the big jungle arena.
export const CAMERA = {
  fov: 55,
  distance: 17,
  height: 10,
  targetHeight: 1.3,
  followK: 7, // exponential smoothing constant
  minDistance: 7,
  maxDistance: 36,
  orbitSensitivity: 0.005,
  zoomSensitivity: 0.012,
}

// Lowest point of the arena is the ground floor (y = 0); falling into the void
// below that triggers respawn.
export const RESPAWN = {
  fallY: -4,
  delay: 1.0,
  spawnY: 1.4,
}

export const COLORS = {
  fog: 0xd7ecf2,
  skyTop: 0x6fc0f5,
  skyBottom: 0xf3e6c4,
  sun: 0xfff1d2,
}

// ============================================================================
// Phase 5 — health, fall damage, rounds, comeback upgrades
// ============================================================================

export const HEALTH = {
  max: 100,
  koLimpTime: 999,   // KO ragdoll stays limp until the round ends
  barFadeDelay: 2.4, // seconds a remote health pip stays bright after a hit
}

// A punch is a chip; slams/throws are the real burst damage.
export const DAMAGE = {
  punch: 8,
  slam: 26,
  throwBase: 14,   // at zero charge
  throwCharged: 16, // added at full charge (=> 30 at max)
  banana: 14,
  laser: 12,
}

// Short hops are free; long drops hurt proportionally.
export const FALL = {
  safeDistance: 6,   // metres of drop before any damage applies
  perMetre: 6,       // damage per metre past the safe distance
  maxDamage: 60,     // cap so one fall can't always be lethal
  minTrackSpeed: 2,  // ignore micro-bounces when tracking apex
}

export const ROUND = {
  duration: 150,      // seconds before the timer decides the winner
  countdown: 5,       // pre-round countdown
  upgradeTime: 25,    // seconds the losers get to pick
  endScreenTime: 5,   // winner banner before upgrades
  minPlayers: 2,
}

// ---------------------------------------------------------------- upgrades --
// Modifier bag every gorilla carries. Upgrades mutate this; game systems read
// it. Defaults are exactly "Phase 1-4 behaviour" so an un-upgraded gorilla is
// untouched by this system.
export interface Mods {
  scale: number          // model + collider size
  forceMul: number       // punch/slam/throw force & knockback DEALT
  moveMul: number        // locomotion speed
  actionMul: number      // >1 = faster punch windup / grab / climb
  healthMul: number      // max health multiplier
  punchKnockMul: number  // Feather Fists: knockback only, damage unchanged
  fallDamageMul: number
  bounce: boolean        // Bouncy Boy
  flight: boolean        // Flight
  banana: boolean        // Banana Gun
  banana_v2: boolean
  laser: boolean         // Laser Eyes (replaces punch)
  laser_v2: boolean
  domain: boolean
  domain_v2: boolean
}

export function baseMods(): Mods {
  return {
    scale: 1,
    forceMul: 1,
    moveMul: 1,
    actionMul: 1,
    healthMul: 1,
    punchKnockMul: 1,
    fallDamageMul: 1,
    bounce: false,
    flight: false,
    banana: false,
    banana_v2: false,
    laser: false,
    laser_v2: false,
    domain: false,
    domain_v2: false,
  }
}

export const BIG = { scale: 3, force: 3, speed: 1.45, health: 3 } // huge, fast, 300 HP bruiser
export const TINY = { scale: 0.42, force: 1 / 3, speed: 2 } // still fast, but controllable
export const FEATHER = { knockMul: 7 } // heavy torso needs a big multiplier to actually launch ~3x farther

// Sprint: hold Shift for a burst of speed on the ground or in flight.
export const SPRINT = {
  moveMul: 2.6,       // dramatic ground burst
  flightMul: 2.15,    // Superman boost in the air
  speedCapMul: 2.8,   // relaxes the drag-clamp too
  fov: 68,            // camera widens while boosting
}

export const BOUNCE = {
  minSpeed: 7,     // impact speed needed to bounce at all (not every hop)
  restitution: 0.8, // fraction of impact speed returned upward
  maxSpeed: 26,     // clamp so a huge drop doesn't fling to orbit
}

// Superman-style flight: pure directional control. WASD moves along the
// facing plane, Space climbs, S descends. Nothing pushes the gorilla up on
// its own — release inputs and the flier truly holds altitude.
export const FLIGHT = {
  duration: 10,        // total flight fuel
  recharge: 10,        // full recharge after fuel runs out
  cruise: 11,          // WASD cruise speed
  climbSpeed: 8.5,     // Space rises
  diveSpeed: 8.5,      // S descends
  accel: 15,           // snappy input response
  drag: 6.5,           // idle damping when no input is held
  cooldown: 0.25,      // brief lock so the toggle doesn't flicker
}

export const BANANA = {
  speed: 34,
  gravity: -6,     // slight arc; projectiles are not straight lasers
  radius: 0.28,
  life: 2.2,       // seconds before despawn (range = speed * life)
  cooldown: 0.7,
  knockback: 52,
  knockUp: 0.35,
  spawnForward: 1.3,
}

// Laser Eyes: hold the punch input for a continuous beam. Taking damage
// staggers the head, breaking the beam.
export const LASER = {
  range: 28,
  radius: 0.55,        // tighter hit cylinder so walls actually block it
  beamTime: 0.14,      // per-tick visible slice (constantly renewed while held)
  tickRate: 12,        // damage/knockback ticks per second while beam is live
  knockback: 22,       // per tick — full-second contact roughly matches a punch
  knockUp: 0.18,
  interruptTime: 0.6,  // after a hit lands on the laser gorilla, they can't fire
  warmup: 0.05,        // brief windup after (re)pressing the fire input
}

// Domain Expansion: a fully opaque black dome + banana environment. The
// caster becomes stronger while the domain persists (more damage + knockback,
// less taken). Solid walls — projectiles collide with them.
export const DOMAIN = {
  cooldown: 18,       // seconds between casts (15s duration + 3s lockout)
  radius: 18,         // v2 scales this x1.5
  duration: 15,       // seconds the dome stays active
  damage: 40,
  knockback: 140,
  knockUp: 0.6,
  buffDamage: 1.6,    // damage dealt while inside your domain
  buffResist: 0.6,    // damage taken while inside your domain
  buffKnock: 1.5,     // knockback dealt while inside your domain
}

export type UpgradeCategory = 'passive' | 'main' | 'trigger'

export interface Upgrade {
  id: string
  name: string
  icon: string
  description: string
  category: UpgradeCategory
  /** Mutually exclusive with any other upgrade sharing this group. */
  exclusiveGroup?: string
  /** Id of the upgrade this one requires and upgrades from. */
  requires?: string
  apply(m: Mods): void
}

/**
 * The Phase 5 comeback pool. Offered only to the round's worst performers.
 * Permanent + stacking for the whole session.
 */
export const UPGRADES: Upgrade[] = [
  {
    id: 'feather_fists',
    name: 'Feather Fists',
    icon: '🥊',
    description: 'Punches launch targets far further. Damage unchanged.',
    category: 'passive',
    apply: (m) => {
      m.punchKnockMul *= FEATHER.knockMul
    },
  },
  {
    id: 'big_gorilla',
    name: 'Big Gorilla',
    icon: '🦍',
    description: '3x size, force, and health — plus a speed boost.',
    category: 'passive',
    exclusiveGroup: 'size',
    apply: (m) => {
      m.scale *= BIG.scale
      m.forceMul *= BIG.force
      m.moveMul *= BIG.speed
      m.actionMul *= BIG.speed
      m.healthMul *= BIG.health
    },
  },
  {
    id: 'tiny_gorilla',
    name: 'Tiny Gorilla',
    icon: '🐒',
    description: 'Tiny, 2x fast, and weak. Hits like a gnat, moves like one too.',
    category: 'passive',
    exclusiveGroup: 'size',
    apply: (m) => {
      m.scale *= TINY.scale
      m.forceMul *= TINY.force
      m.moveMul *= TINY.speed
      m.actionMul *= TINY.speed
    },
  },
  {
    id: 'bouncy_boy',
    name: 'Bouncy Boy',
    icon: '↑',
    description: 'No fall damage. Big landings bounce you back up.',
    category: 'passive',
    apply: (m) => {
      m.fallDamageMul = 0
      m.bounce = true
    },
  },
  {
    id: 'flight',
    name: 'Flight',
    icon: '🪽',
    description: '10 seconds of controlled flight, then 10 seconds to recharge.',
    category: 'passive',
    apply: (m) => {
      m.flight = true
    },
  },
  {
    id: 'banana_gun',
    name: 'Banana Gun',
    icon: '🍌',
    description: 'Your punch becomes a visible banana gun that fires on click.',
    category: 'main',
    exclusiveGroup: 'ranged',
    apply: (m) => {
      m.banana = true
    },
  },
  {
    id: 'banana_gun_v2',
    name: 'Banana Shotgun',
    icon: '🍌',
    description: 'Fires 3 bananas in a spread.',
    category: 'main',
    requires: 'banana_gun',
    apply: (m) => {
      m.banana_v2 = true
    },
  },
  {
    id: 'laser_eyes',
    name: 'Laser Eyes',
    icon: '👁',
    description: 'Punch fires a searing laser that stops on walls and gorillas.',
    category: 'main',
    exclusiveGroup: 'ranged',
    apply: (m) => {
      m.laser = true
    },
  },
  {
    id: 'laser_eyes_v2',
    name: 'Death Ray',
    icon: '🔥',
    description: 'Wider beam, massive damage.',
    category: 'main',
    requires: 'laser_eyes',
    apply: (m) => {
      m.laser_v2 = true
    },
  },
  {
    id: 'domain_expansion',
    name: 'Domain Expansion',
    icon: '🌌',
    description: 'Press F to expand a massive damaging dome.',
    category: 'trigger',
    apply: (m) => {
      m.domain = true
    },
  },
  {
    id: 'domain_expansion_v2',
    name: 'Infinite Void',
    icon: '🌑',
    description: 'Domain radius and damage increased.',
    category: 'trigger',
    requires: 'domain_expansion',
    apply: (m) => {
      m.domain_v2 = true
    },
  },
]

export const UPGRADE_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]))

/** Build the effective modifier bag for a list of owned upgrade ids. */
export function modsFor(ids: string[]): Mods {
  const m = baseMods()
  // Defensive exclusive-group enforcement for saved/debug upgrade lists too.
  // The server/offer pool already prevents this, but this makes Banana Gun and
  // Laser Eyes impossible to combine even in solo testing.
  const groups = new Set<string>()
  for (const id of ids) {
    const u = UPGRADE_BY_ID.get(id)
    if (!u || (u.exclusiveGroup && groups.has(u.exclusiveGroup))) continue
    u.apply(m)
    if (u.exclusiveGroup) groups.add(u.exclusiveGroup)
  }
  return m
}

/**
 * Offer candidates: drop anything already owned, and anything whose
 * exclusiveGroup is already occupied. Generic — no per-upgrade branches.
 */
export function eligibleUpgrades(owned: string[]): Upgrade[] {
  const ownedSet = new Set(owned)
  const takenGroups = new Set<string>()
  for (const id of owned) {
    const g = UPGRADE_BY_ID.get(id)?.exclusiveGroup
    if (g) takenGroups.add(g)
  }
  return UPGRADES.filter(
    (u) => !ownedSet.has(u.id) && !(u.exclusiveGroup && takenGroups.has(u.exclusiveGroup))
  )
}
