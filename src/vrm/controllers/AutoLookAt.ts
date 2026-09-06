import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

/**
 * Points the avatar's gaze at the camera.
 *
 * Derived from pixiv's ChatVRM (MIT) — see THIRD_PARTY_NOTICES.md. Saccades
 * are handled inside three-vrm's look-at smoother; this only parents a target
 * to the camera so the eyes track the viewer.
 */
export class AutoLookAt {
  private target: THREE.Object3D;
  private camera: THREE.Object3D;

  constructor(vrm: VRM, camera: THREE.Object3D) {
    this.target = new THREE.Object3D();
    this.camera = camera;
    camera.add(this.target);
    if (vrm.lookAt) vrm.lookAt.target = this.target;
  }

  dispose(): void {
    this.camera.remove(this.target);
  }
}
