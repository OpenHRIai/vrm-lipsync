import type { VRM, VRMExpressionPresetName } from "@pixiv/three-vrm";
import * as THREE from "three";

import type { VisemeWeights } from "../../lipsync/visemeMapper";
import { ZERO_VISEMES } from "../../lipsync/visemeMapper";
import { AutoBlink } from "./AutoBlink";
import { AutoLookAt } from "./AutoLookAt";

/** Emotion presets a caller may set, excluding the mouth and eye presets. */
export type EmotionPreset = "neutral" | "happy" | "angry" | "sad" | "relaxed";

const VOWEL_PRESETS = ["aa", "ih", "ou", "ee", "oh"] as const;

/**
 * Damping on vowel weights while a non-neutral emotion is showing.
 *
 * Emotion presets on most VRM models move the mouth too. Driving the vowels at
 * full strength on top of, say, `happy` overshoots into a rictus, so the mouth
 * gets quieter while an emotion is active. Inherited from ChatVRM's approach,
 * though there it also halved the neutral case; here neutral runs at full
 * strength, since the server's articulation signal is worth rendering fully.
 */
const EMOTION_LIPSYNC_DAMPING = 0.5;

/**
 * Owns every expression channel on the VRM: blinking, gaze, emotion, and the
 * five vowel weights.
 *
 * This replaces ChatVRM's single-preset `lipSync(preset, value)`, which held
 * one vowel at a time and zeroed the previous one. That is fine for a
 * volume-driven mouth with a single `aa`, but it structurally cannot render a
 * blend of vowels — which is exactly what the articulation mapper produces.
 */
export class ExpressionController {
  private vrm: VRM;
  private autoBlink?: AutoBlink;
  private autoLookAt?: AutoLookAt;
  private currentEmotion: EmotionPreset = "neutral";
  private visemes: VisemeWeights = { ...ZERO_VISEMES };
  private emotionTransition: {
    from: EmotionPreset;
    to: EmotionPreset;
    elapsed: number;
    duration: number;
    delay: number;
  } | null = null;

  constructor(vrm: VRM, camera: THREE.Object3D) {
    this.vrm = vrm;
    this.autoLookAt = new AutoLookAt(vrm, camera);
    if (vrm.expressionManager) {
      this.autoBlink = new AutoBlink(vrm.expressionManager);
    }
  }

  /** Cross-fade to an emotion preset over `duration` seconds. */
  setEmotion(preset: EmotionPreset, duration = 0.25): void {
    if (preset === this.currentEmotion && !this.emotionTransition) return;
    // Blinking is suppressed for non-neutral emotions, and applying the
    // emotion mid-blink looks wrong — so wait for the eyes to reopen.
    const delay = this.autoBlink?.setEnabled(preset === "neutral") ?? 0;
    this.emotionTransition = {
      from: this.currentEmotion,
      to: preset,
      elapsed: 0,
      duration: Math.max(duration, 1e-3),
      delay,
    };
    this.currentEmotion = preset;
  }

  /** Set the five vowel weights for this frame. */
  setVisemes(weights: VisemeWeights): void {
    this.visemes = weights;
  }

  get emotion(): EmotionPreset {
    return this.currentEmotion;
  }

  update(delta: number): void {
    const manager = this.vrm.expressionManager;
    if (!manager) return;

    this.autoBlink?.update(delta);

    if (this.emotionTransition) {
      const t = this.emotionTransition;
      if (t.delay > 0) {
        t.delay -= delta;
      } else {
        t.elapsed += delta;
        const weight = Math.min(1, t.elapsed / t.duration);
        if (t.from !== t.to) {
          manager.setValue(t.from as VRMExpressionPresetName, 1 - weight);
        }
        manager.setValue(t.to as VRMExpressionPresetName, weight);
        if (weight >= 1) this.emotionTransition = null;
      }
    }

    const damping =
      this.currentEmotion === "neutral" ? 1 : EMOTION_LIPSYNC_DAMPING;
    for (const preset of VOWEL_PRESETS) {
      manager.setValue(preset, this.visemes[preset] * damping);
    }
  }

  dispose(): void {
    this.autoLookAt?.dispose();
    const manager = this.vrm.expressionManager;
    if (!manager) return;
    for (const preset of VOWEL_PRESETS) manager.setValue(preset, 0);
  }
}
