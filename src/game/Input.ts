/**
 * Input — edge-triggered action queues + held movement flags.
 *
 * Bindings: WASD move · Space jump (wall-jump while climbing) · Click punch
 * (slam while holding) · E grab dummy / latch or release a wall · Hold Q
 * charge throw (release to launch) · Drag orbit · Scroll zoom.
 *
 * consume*() methods are one-shot: Game must call them once per frame.
 */
export class Input {
  forward = false
  back = false
  left = false
  right = false
  jumpHeld = false
  sprintHeld = false
  /** True while the primary attack input is held (for continuous laser). */
  punchHeld = false
  pointerX = 0
  pointerY = 0

  private punchQueued = false
  private slamQueued = false
  private grabQueued = false
  private jumpQueued = false
  private upgradeQueued = false
  private triggerQueued = false
  private throwPressedQueued = false
  private throwReleasedQueued = false

  private orbitAccum = 0
  private zoomAccum = 0

  private pointerDown = false
  private pointerMoved = false
  private lastX = 0
  private el: HTMLElement

  constructor(el: HTMLElement) {
    this.el = el
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('contextmenu', this.onContextMenu)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('blur', this.onBlur)
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.forward = true
        break
      case 'KeyS':
      case 'ArrowDown':
        this.back = true
        break
      case 'KeyA':
      case 'ArrowLeft':
        this.left = true
        break
      case 'KeyD':
      case 'ArrowRight':
        this.right = true
        break
      case 'Space':
        this.jumpHeld = true
        if (!e.repeat) this.jumpQueued = true
        e.preventDefault()
        break
      case 'KeyE':
        if (!e.repeat) this.grabQueued = true
        e.preventDefault()
        break
      case 'KeyF':
        if (!e.repeat) this.triggerQueued = true
        e.preventDefault()
        break
      case 'KeyQ':
        if (!e.repeat) this.throwPressedQueued = true
        e.preventDefault()
        break
      case 'ShiftLeft':
      case 'ShiftRight':
        this.sprintHeld = true
        break
      case 'KeyU':
        if (!e.repeat) this.upgradeQueued = true
        e.preventDefault()
        break
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.forward = false
        break
      case 'KeyS':
      case 'ArrowDown':
        this.back = false
        break
      case 'KeyA':
      case 'ArrowLeft':
        this.left = false
        break
      case 'KeyD':
      case 'ArrowRight':
        this.right = false
        break
      case 'KeyQ':
        this.throwReleasedQueued = true
        break
      case 'Space':
        this.jumpHeld = false
        break
      case 'ShiftLeft':
      case 'ShiftRight':
        this.sprintHeld = false
        break
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointerDown = true
    this.pointerMoved = false
    this.lastX = e.clientX
    if (e.button === 0) this.punchHeld = true
  }

  private onPointerMove = (e: PointerEvent) => {
    this.pointerX = (e.clientX / window.innerWidth) * 2 - 1
    this.pointerY = -(e.clientY / window.innerHeight) * 2 + 1
    if (!this.pointerDown) return
    const dx = e.clientX - this.lastX
    this.lastX = e.clientX
    if (Math.abs(dx) > 1.0) {
      this.pointerMoved = true
      this.punchHeld = false // orbit drag must never sustain a laser
    }
    this.orbitAccum += dx // any-button drag orbits
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.pointerDown && !this.pointerMoved) {
      if (e.button === 0) {
        this.punchQueued = true
        this.slamQueued = true
      }
    }
    this.pointerDown = false
    if (e.button === 0) this.punchHeld = false
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.zoomAccum += e.deltaY
  }

  private onBlur = () => {
    this.forward = this.back = this.left = this.right = false
    this.jumpHeld = false
    this.sprintHeld = false
    this.punchHeld = false
    this.pointerDown = false
  }

  consumePunch(): boolean {
    const p = this.punchQueued
    this.punchQueued = false
    return p
  }
  consumeGrab(): boolean {
    const g = this.grabQueued
    this.grabQueued = false
    return g
  }
  consumeSlam(): boolean {
    const s = this.slamQueued
    this.slamQueued = false
    return s
  }
  consumeJump(): boolean {
    const j = this.jumpQueued
    this.jumpQueued = false
    return j
  }
  consumeTrigger(): boolean {
    const t = this.triggerQueued
    this.triggerQueued = false
    return t
  }
  consumeUpgrade(): boolean {
    const u = this.upgradeQueued
    this.upgradeQueued = false
    return u
  }
  consumeThrowPressed(): boolean {
    const t = this.throwPressedQueued
    this.throwPressedQueued = false
    return t
  }
  consumeThrowReleased(): boolean {
    const t = this.throwReleasedQueued
    this.throwReleasedQueued = false
    return t
  }
  consumeOrbit(): number {
    const o = this.orbitAccum
    this.orbitAccum = 0
    return o
  }
  consumeZoom(): number {
    const z = this.zoomAccum
    this.zoomAccum = 0
    return z
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.el.removeEventListener('pointerdown', this.onPointerDown)
    this.el.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.el.removeEventListener('contextmenu', this.onContextMenu)
    this.el.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('blur', this.onBlur)
  }
}
