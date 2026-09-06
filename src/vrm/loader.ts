import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

export interface LoadProgress {
  loaded: number;
  total: number;
}

/**
 * Decoders for compressed models.
 *
 * Optimized VRMs — anything through RapidPipeline, gltfpack or gltf-transform —
 * typically require `KHR_draco_mesh_compression` for geometry and
 * `KHR_texture_basisu` for textures. Both need an external decoder that three
 * loads at runtime, and without them the load fails outright rather than
 * degrading. These default to public CDNs; point them at your own copies if
 * you have a strict CSP or need offline loads.
 */
export const DEFAULT_DRACO_DECODER_PATH =
  "https://www.gstatic.com/draco/versioned/decoders/1.5.6/";
export const DEFAULT_KTX2_TRANSCODER_PATH =
  "https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/basis/";

export interface LoaderOptions {
  /**
   * Required to load KTX2/basisu textures: the transcoder has to know which
   * compressed formats the GPU supports. Without it, such models fail.
   */
  renderer?: THREE.WebGLRenderer;
  dracoDecoderPath?: string;
  ktx2TranscoderPath?: string;
}

export interface LoadVRMOptions extends LoaderOptions {
  onProgress?: (progress: LoadProgress) => void;
}

interface PreparedLoader {
  loader: GLTFLoader;
  dispose: () => void;
}

function makeLoader(options: LoaderOptions = {}): PreparedLoader {
  const loader = new GLTFLoader();
  loader.crossOrigin = "anonymous";

  const draco = new DRACOLoader().setDecoderPath(
    options.dracoDecoderPath ?? DEFAULT_DRACO_DECODER_PATH,
  );
  loader.setDRACOLoader(draco);

  // KTX2 transcoding is GPU-format dependent, so it is only wired up when a
  // renderer is available to probe. Registering it without one throws.
  let ktx2: KTX2Loader | null = null;
  if (options.renderer) {
    ktx2 = new KTX2Loader()
      .setTranscoderPath(options.ktx2TranscoderPath ?? DEFAULT_KTX2_TRANSCODER_PATH)
      .detectSupport(options.renderer);
    loader.setKTX2Loader(ktx2);
  }

  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  // Both spin up worker pools; release them once the load is done.
  return {
    loader,
    dispose: () => {
      draco.dispose();
      ktx2?.dispose();
    },
  };
}

/** Load a `.vrm` model. */
export async function loadVRM(
  url: string,
  options: LoadVRMOptions = {},
): Promise<VRM> {
  const { loader, dispose } = makeLoader(options);
  let gltf;
  try {
    gltf = await loader.loadAsync(url, (e) =>
      options.onProgress?.({ loaded: e.loaded, total: e.total }),
    );
  } finally {
    dispose();
  }

  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error(`Not a VRM model: ${url}`);

  // Drop unused joints/expressions and skip frustum culling — VRM meshes are
  // skinned, so their bounding boxes go stale and limbs pop out of view.
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });

  // VRM 0.x models face +Z; VRM 1.0 faces -Z. Without this a 0.x avatar
  // renders with its back to the camera. No-op on 1.0 models.
  VRMUtils.rotateVRM0(vrm);

  return vrm;
}

/**
 * Load a `.vrma` animation and bind it to a model.
 *
 * VRM Animation is the format's own retargeting-free clip type: it stores
 * humanoid bone rotations rather than a specific skeleton, so one file drives
 * any VRM. This is what lets us drop the Mixamo FBX pipeline (and its ~200
 * lines of rig-name mapping) entirely.
 */
export async function loadVRMAnimationClip(
  url: string,
  vrm: VRM,
  options: LoaderOptions & { recenter?: boolean } = {},
): Promise<THREE.AnimationClip> {
  const { loader, dispose } = makeLoader(options);
  let gltf;
  try {
    gltf = await loader.loadAsync(url);
  } finally {
    dispose();
  }

  const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
  const animation = animations?.[0];
  if (!animation) throw new Error(`No VRM animation found in: ${url}`);

  const clip = createVRMAnimationClip(animation, vrm);
  if (options.recenter !== false) recenterRootMotion(clip);
  return clip;
}

/**
 * Remove any constant horizontal offset baked into a clip's root translation.
 *
 * Authored idle loops are often not centred on the origin — ChatVRM's
 * `idle_loop.vrma`, for instance, carries a fixed `hips.position.x` of ~0.18m.
 * For a full-body scene that is harmless, but a talking-head avatar framed on
 * the face ends up noticeably off to one side.
 *
 * Subtracting the first frame's X and Z from every frame pins the clip to the
 * origin while preserving any *relative* motion within it, so a weight shift
 * or a step still reads. Y is untouched: vertical bob is what makes an idle
 * look alive, and it does not push the avatar out of frame.
 */
function recenterRootMotion(clip: THREE.AnimationClip): void {
  for (const track of clip.tracks) {
    if (!track.name.endsWith(".position")) continue;
    const v = track.values;
    if (v.length < 3) continue;
    const baseX = v[0];
    const baseZ = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] -= baseX;
      v[i + 2] -= baseZ;
    }
  }
}
