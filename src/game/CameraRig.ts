import * as THREE from 'three'
import { clamp } from './utils'
import { CAMERA } from './constants'

/**
 * CameraRig — 3rd-person follow.
 * Position and look-target are exponentially smoothed (frame-rate independent).
 * forwardX/Z + rightX/Z are the ground-plane basis Game uses for WASD.
 */
export class CameraRig {
  camera: THREE.PerspectiveCamera
  yaw = 0
  distance = CAMERA.distance

  private shake = 0
  private curPos = new THREE.Vector3(0, CAMERA.height, CAMERA.distance)
  private curLook = new THREE.Vector3()
  private desired = new THREE.Vector3()
  private lookTarget = new THREE.Vector3()

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, 0.1, 1000)
    this.camera.position.copy(this.curPos)
  }

  applyOrbit(dx: number) {
    this.yaw -= dx * CAMERA.orbitSensitivity
  }

  applyZoom(dz: number) {
    this.distance = clamp(
      this.distance + dz * CAMERA.zoomSensitivity,
      CAMERA.minDistance,
      CAMERA.maxDistance
    )
  }

  addShake(s: number) {
    this.shake = Math.max(this.shake, s)
  }

  // Camera-relative basis (used for movement), projected on the ground plane.
  forwardX(): number {
    return -Math.sin(this.yaw)
  }
  forwardZ(): number {
    return -Math.cos(this.yaw)
  }
  rightX(): number {
    return Math.cos(this.yaw)
  }
  rightZ(): number {
    return -Math.sin(this.yaw)
  }

  update(tx: number, ty: number, tz: number, dt: number) {
    const d = this.distance
    this.desired.set(
      tx + Math.sin(this.yaw) * d,
      ty + CAMERA.height,
      tz + Math.cos(this.yaw) * d
    )
    this.lookTarget.set(tx, ty + CAMERA.targetHeight, tz)

    const k = 1 - Math.exp(-CAMERA.followK * dt)
    this.curPos.lerp(this.desired, k)
    this.curLook.lerp(this.lookTarget, k)

    const s = this.shake
    this.camera.position.set(
      this.curPos.x + (Math.random() * 2 - 1) * s,
      this.curPos.y + (Math.random() * 2 - 1) * s,
      this.curPos.z + (Math.random() * 2 - 1) * s
    )
    this.camera.lookAt(
      this.curLook.x + (Math.random() * 2 - 1) * s * 0.5,
      this.curLook.y,
      this.curLook.z + (Math.random() * 2 - 1) * s * 0.5
    )
    this.shake = Math.max(0, this.shake - dt * 2.5)
  }

  resize(aspect: number) {
    this.camera.aspect = aspect
    this.camera.updateProjectionMatrix()
  }
}
