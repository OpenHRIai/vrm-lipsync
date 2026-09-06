export { VRMAvatar, type VRMAvatarProps, type VRMAvatarRef } from "./vrm/VRMAvatar";
export { AvatarStage, type AvatarStageOptions } from "./vrm/AvatarStage";
export {
  ExpressionController,
  type EmotionPreset,
} from "./vrm/controllers/ExpressionController";
export {
  DEFAULT_DRACO_DECODER_PATH,
  DEFAULT_KTX2_TRANSCODER_PATH,
  loadVRM,
  loadVRMAnimationClip,
  type LoaderOptions,
  type LoadProgress,
  type LoadVRMOptions,
} from "./vrm/loader";
export { useLipsyncFeed, type UseLipsyncFeedOptions } from "./hooks/useLipsyncFeed";

// Re-exported for convenience; also available dependency-free from
// "@openhri/vrm-lipsync/lipsync".
export * from "./lipsync";
