import { VRM, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { LipsyncSource } from "../lipsync/source";
import { ZERO_VISEMES } from "../lipsync/visemeMapper";
import { ExpressionController, type EmotionPreset } from "./controllers/ExpressionController";
import {
  loadVRM,
  loadVRMAnimationClip,
  type LoaderOptions,
  type LoadProgress,
} from "./loader";

export interface AvatarStageOptions {
  canvas: HTMLCanvasElement;
  modelUrl: string;
  /** Optional `.vrma` idle loop. */
  idleAnimationUrl?: string;
  /** Transparent when omitted, so the page background shows through. */
  backgroundColor?: string;
  cameraPosition?: { x: number; y: number; z: number };
  cameraTarget?: { x: number; y: number; z: number };
  /** Enable orbit/zoom camera controls. Off by default. */
  interactive?: boolean;
  /**
   * Scales the scene lights; 1 by default. Toon-shaded (MToon) skin
   * saturates toward white under strong light, so below 1 brings out the
   * face's shading, mouth included.
   */
  lightIntensity?: number;
  /** Override decoder URLs for Draco/KTX2 compressed models. */
  dracoDecoderPath?: string;
  ktx2TranscoderPath?: string;
  onProgress?: (p: LoadProgress) => void;
}

const DEFAULT_CAMERA_POSITION = { x: 0, y: 1.32, z: 1.15 };
const DEFAULT_CAMERA_TARGET = { x: 0, y: 1.32, z: 0 };

/**
 * A three.js scene rendering one VRM avatar, with its mouth driven by a
 * `LipsyncFeed`.
 *
 * Framework-agnostic on purpose — React owns nothing here beyond construction
 * and teardown. The render loop samples the feed directly each frame rather
 * than going through component state, because keyframes arrive at 15-25/s and
 * the mouth is redrawn at display rate; routing that through React would mean
 * a re-render per frame for a value no component reads.
 */
export class AvatarStage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock = new THREE.Clock();
  private options: AvatarStageOptions;

  private vrm: VRM | null = null;
  private expressions: ExpressionController | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private source: LipsyncSource | null = null;

  private controls: OrbitControls | null = null;
  private keyLight = new THREE.DirectionalLight(0xffffff);
  private ambientLight = new THREE.AmbientLight(0xffffff);
  private frameHandle = 0;
  private running = false;
  private disposed = false;

  constructor(options: AvatarStageOptions) {
    this.options = options;

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      alpha: !options.backgroundColor,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    const pos = options.cameraPosition ?? DEFAULT_CAMERA_POSITION;
    this.camera.position.set(pos.x, pos.y, pos.z);
    const target = options.cameraTarget ?? DEFAULT_CAMERA_TARGET;
    this.camera.lookAt(target.x, target.y, target.z);
    // AutoLookAt parents a gaze target to the camera, so the camera has to be
    // in the graph for its world matrix to resolve.
    this.scene.add(this.camera);

    if (options.backgroundColor) {
      this.scene.background = new THREE.Color(options.backgroundColor);
    }

    if (options.interactive) {
      this.controls = new OrbitControls(this.camera, options.canvas);
      this.controls.enableDamping = true;
      this.controls.screenSpacePanning = true;
      this.controls.target.set(target.x, target.y, target.z);
      this.controls.update();
    }

    this.keyLight.position.set(1, 1, 1).normalize();
    this.scene.add(this.keyLight);
    this.scene.add(this.ambientLight);
    this.setLightIntensity(options.lightIntensity ?? 1);
  }

  /** Scale the scene lights (see `AvatarStageOptions.lightIntensity`). */
  setLightIntensity(scale: number): void {
    this.keyLight.intensity = scale * Math.PI;
    this.ambientLight.intensity = scale * 0.4 * Math.PI;
  }

  /** Point the mouth at a viseme source, or `null` to leave it at rest. */
  setSource(source: LipsyncSource | null): void {
    this.source = source;
    source?.reset?.();
    // Without this the mouth freezes on whatever shape it last held: the
    // render loop stops sampling, but the expression controller keeps
    // re-applying its last weights every frame.
    this.expressions?.setVisemes({ ...ZERO_VISEMES });
  }

  setEmotion(preset: EmotionPreset, duration?: number): void {
    this.expressions?.setEmotion(preset, duration);
  }

  getVRM(): VRM | null {
    return this.vrm;
  }

  /**
   * Decoder wiring shared by the model and animation loads. The renderer is
   * required for KTX2: the transcoder picks an output format based on what
   * this GPU actually supports.
   */
  private loaderOptions(): LoaderOptions {
    return {
      renderer: this.renderer,
      dracoDecoderPath: this.options.dracoDecoderPath,
      ktx2TranscoderPath: this.options.ktx2TranscoderPath,
    };
  }

  async load(): Promise<VRM> {
    const vrm = await loadVRM(this.options.modelUrl, {
      ...this.loaderOptions(),
      onProgress: this.options.onProgress,
    });
    if (this.disposed) {
      VRMUtils.deepDispose(vrm.scene);
      throw new Error("AvatarStage disposed during load");
    }

    this.vrm = vrm;
    this.scene.add(vrm.scene);
    this.expressions = new ExpressionController(vrm, this.camera);
    if (!this.options.cameraPosition && !this.options.cameraTarget) {
      this.frameHead(vrm);
    }

    if (this.options.idleAnimationUrl) {
      const clip = await loadVRMAnimationClip(
        this.options.idleAnimationUrl,
        vrm,
        this.loaderOptions(),
      );
      if (!this.disposed) {
        this.mixer = new THREE.AnimationMixer(vrm.scene);
        this.mixer.clipAction(clip).play();
      }
    }
    return vrm;
  }

  /**
   * Aim the camera at the avatar's head.
   *
   * VRM models are not a standard height — a chibi model and an adult one put
   * their heads half a metre apart — so a fixed camera position frames one
   * model and decapitates the next. The humanoid rig always knows where the
   * head is, so use that and derive the distance from the field of view.
   * Skipped entirely when the caller supplies an explicit camera.
   */
  private frameHead(vrm: VRM): void {
    const head =
      vrm.humanoid?.getRawBoneNode("head") ?? vrm.humanoid?.getRawBoneNode("neck");
    if (!head) return;

    vrm.scene.updateWorldMatrix(true, true);
    const p = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);

    // Frame roughly head-and-shoulders: fit FRAME_HEIGHT metres vertically.
    const FRAME_HEIGHT = 0.62;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = FRAME_HEIGHT / 2 / Math.tan(fov / 2);

    // Aim a little below the head bone — that sits at the skull's base, so
    // centring on it puts the face in the top half of the frame.
    const y = p.y + 0.04;
    this.camera.position.set(p.x, y, p.z + distance);
    this.camera.lookAt(p.x, y, p.z);
    if (this.controls) {
      this.controls.target.set(p.x, y, p.z);
      this.controls.update();
    }
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.clock.getDelta(); // discard time spent loading
    const tick = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(tick);
      this.renderFrame();
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  private renderFrame(): void {
    const delta = this.clock.getDelta();

    if (this.source && this.expressions) {
      this.expressions.setVisemes(
        this.source.sampleVisemes(performance.now(), delta),
      );
    }

    this.controls?.update();
    this.mixer?.update(delta);
    this.expressions?.update(delta);
    // Must run after the expression and mixer writes: VRM.update applies the
    // humanoid rig and expression weights that were staged this frame.
    this.vrm?.update(delta);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.controls?.dispose();
    this.expressions?.dispose();
    this.mixer?.stopAllAction();
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.renderer.dispose();
  }
}
