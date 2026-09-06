/**
 * Maps the server's continuous articulation stream onto VRM's five vowel
 * expression presets.
 *
 * The wire format is deliberately *not* discrete visemes — the analyzer emits
 * `openness` / `width` / `rounding` because "misestimation of a float drifts;
 * misclassification of an ID snaps". VRM, however, only offers five vowel
 * blendshapes (aa/ih/ou/ee/oh). This module is the bridge: it treats those
 * five presets as anchor points in the articulation cube and expresses any
 * incoming pose as a weighted blend of the nearest anchors, so the drift the
 * server was designed to produce stays smooth instead of snapping between
 * discrete mouth shapes.
 *
 * Everything here is pure: no React, no three.js, no DOM. `mapToVisemes()` is
 * a function of the sample alone; `VisemeSmoother` holds the only state.
 */

import { REST_POSE, type ArticulationSample } from "./feed";
import type { LipsyncEventKind } from "./protocol";

/** The five VRM vowel expression presets, as weights in 0..1. */
export interface VisemeWeights {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
}

export const ZERO_VISEMES: Readonly<VisemeWeights> = Object.freeze({
  aa: 0,
  ih: 0,
  ou: 0,
  ee: 0,
  oh: 0,
});

type VisemeKey = keyof VisemeWeights;
const VISEME_KEYS: readonly VisemeKey[] = ["aa", "ih", "ou", "ee", "oh"];

/**
 * Anchor pose for each preset in (openness, width, rounding) space.
 *
 * These are articulatory positions, not measured formant data: /a/ is open and
 * unrounded, /i/ is close and spread, /u/ is close and tightly rounded, and so
 * on. They are the tuning surface — adjust them per-model, since what "fully
 * open" means differs between VRM rigs.
 */
export interface VowelAnchor {
  openness: number;
  width: number;
  rounding: number;
}

export const DEFAULT_ANCHORS: Readonly<Record<VisemeKey, VowelAnchor>> =
  Object.freeze({
    /* /a/ — open, jaw down, lips neutral */
    aa: { openness: 0.95, width: 0.5, rounding: 0.05 },
    /* /i/ — close, lips spread wide */
    ih: { openness: 0.22, width: 0.85, rounding: 0.05 },
    /* /u/ — close, lips tightly rounded and protruded */
    ou: { openness: 0.25, width: 0.15, rounding: 0.95 },
    /* /e/ — mid-open, lips spread */
    ee: { openness: 0.5, width: 0.9, rounding: 0.05 },
    /* /o/ — open, lips rounded */
    oh: { openness: 0.75, width: 0.25, rounding: 0.75 },
  });

export interface VisemeMapperConfig {
  anchors: Record<VisemeKey, VowelAnchor>;
  /**
   * Blend sharpness. Higher commits harder to the single nearest anchor;
   * lower produces a mushier average of all five. 2 is a good middle.
   */
  sharpness: number;
  /** Relative pull of each axis on the distance metric. */
  axisWeights: { openness: number; width: number; rounding: number };
  /**
   * Distance from the rest pose at which articulation reads as fully
   * committed. Smaller values make the mouth reach full strength sooner.
   */
  activationDistance: number;
  /** Overall scale on the final weights; trims models with strong blendshapes. */
  gain: number;
  /**
   * Floor on how much of the mapped shape survives at zero confidence. At 0
   * an unconfident frame collapses to a closed mouth; at 1 confidence is
   * ignored. The server's contract is "uncertain -> neutral", so we keep a
   * little movement rather than freezing the face mid-utterance.
   */
  minCommit: number;
  /**
   * Confidence treated as fully certain.
   *
   * The analyzer's confidence is not distributed over 0..1: measured across a
   * real utterance it runs a median of 0.07 and never exceeded 0.5, because
   * it is a composite that penalises ordinary formant ambiguity. Reading it
   * as a 0..1 gain therefore scales the whole mouth down to a fraction of its
   * intended range. Normalising against a realistic ceiling keeps confidence
   * discriminating between clear and unclear frames without flattening
   * everything.
   */
  confidenceRef: number;
}

export const DEFAULT_MAPPER_CONFIG: VisemeMapperConfig = {
  anchors: DEFAULT_ANCHORS,
  sharpness: 2,
  axisWeights: { openness: 1, width: 0.7, rounding: 1.1 },
  activationDistance: 0.5,
  gain: 1,
  minCommit: 0.75,
  confidenceRef: 0.35,
};

/**
 * How strongly to apply the blend, independent of which vowel it is.
 *
 * The blend weights below are normalised to sum to 1, which on its own would
 * leave the mouth stuck in some vowel forever. This term is what returns it to
 * rest — and it is deliberately *not* driven by `openness` alone.
 *
 * Jaw opening is the intuitive choice and it is wrong: /i/ and /u/ are close
 * vowels, articulated with the lips while the jaw stays nearly shut. Scaling
 * by openness would render them at near-zero strength, even though VRM's `ih`
 * and `ou` blendshapes already encode exactly that closed-but-shaped mouth.
 *
 * So strength is the distance from the analyzer's rest pose across all three
 * axes: a tightly rounded /u/ is far from rest in `rounding` and reads as
 * strongly articulated, while genuine silence sits at rest on every axis and
 * closes the mouth. Energy adds a little emphasis on top.
 */
function amplitudeOf(sample: ArticulationSample, cfg: VisemeMapperConfig): number {
  const aw = cfg.axisWeights;
  const dO = (sample.openness - REST_POSE.openness) * aw.openness;
  const dW = (sample.width - REST_POSE.width) * aw.width;
  const dR = (sample.rounding - REST_POSE.rounding) * aw.rounding;
  const distance = Math.sqrt(dO * dO + dW * dW + dR * dR);

  const effort = clamp01(distance / Math.max(cfg.activationDistance, 1e-6));
  const emphasis = 0.85 + 0.15 * clamp01(sample.energy);
  return clamp01(effort * emphasis);
}

/**
 * Map one articulation sample to VRM vowel weights.
 *
 * `activeEvents` overrides the continuous signal: a closure (M/B/P) or a nasal
 * (m/n, "hmm") means the lips are shut regardless of what the vowel tract is
 * doing, and silence means rest. Without this the avatar hums with its mouth
 * hanging open — the single worst-looking failure mode, and the reason the
 * server bothers to detect these events at all.
 */
export function mapToVisemes(
  sample: ArticulationSample,
  activeEvents: Iterable<LipsyncEventKind> = [],
  config: Partial<VisemeMapperConfig> = {},
): VisemeWeights {
  const cfg = { ...DEFAULT_MAPPER_CONFIG, ...config };

  for (const kind of activeEvents) {
    if (kind === "closure" || kind === "nasal" || kind === "silence") {
      return { ...ZERO_VISEMES };
    }
  }
  if (!sample.live) return { ...ZERO_VISEMES };

  const amplitude = amplitudeOf(sample, cfg);
  if (amplitude <= 0) return { ...ZERO_VISEMES };

  // Inverse-distance blend over the anchors. Squared distance is enough —
  // we never need the true metric, only the ordering and relative falloff.
  const aw = cfg.axisWeights;
  const raw: Record<VisemeKey, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  let total = 0;

  for (const key of VISEME_KEYS) {
    const a = cfg.anchors[key];
    const dO = (sample.openness - a.openness) * aw.openness;
    const dW = (sample.width - a.width) * aw.width;
    const dR = (sample.rounding - a.rounding) * aw.rounding;
    const d2 = dO * dO + dW * dW + dR * dR;

    // Landing exactly on an anchor is a singularity for 1/d; snap to it.
    if (d2 < 1e-6) {
      const only = { ...ZERO_VISEMES } as VisemeWeights;
      only[key] = amplitude * cfg.gain * commitOf(sample, cfg);
      return only;
    }
    const w = 1 / Math.pow(d2, cfg.sharpness / 2);
    raw[key] = w;
    total += w;
  }

  const scale = (amplitude * cfg.gain * commitOf(sample, cfg)) / total;
  return {
    aa: raw.aa * scale,
    ih: raw.ih * scale,
    ou: raw.ou * scale,
    ee: raw.ee * scale,
    oh: raw.oh * scale,
  };
}

/**
 * How far to commit to the mapped shape given the analyzer's confidence.
 * Low-confidence frames pull toward a neutral, less articulated mouth rather
 * than confidently rendering a guess.
 */
function commitOf(sample: ArticulationSample, cfg: VisemeMapperConfig): number {
  const normalized = clamp01(sample.confidence / Math.max(cfg.confidenceRef, 1e-6));
  return cfg.minCommit + (1 - cfg.minCommit) * normalized;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface SmoothingConfig {
  /** Time constant (seconds) for weights rising. Mouths open fast. */
  attack: number;
  /** Time constant (seconds) for weights falling. Closing is a touch slower... */
  release: number;
  /** ...except on a closure/nasal, where the lips must snap shut on time. */
  closureRelease: number;
}

export const DEFAULT_SMOOTHING: SmoothingConfig = {
  // Tuned against a real utterance: at 0.035/0.06 the mouth moved by up to a
  // quarter of its range in a single frame at the 95th percentile, which
  // reads as jitter. These time constants sit well inside a syllable
  // (~150-250ms), so they take the edge off without blurring articulation.
  attack: 0.06,
  release: 0.09,
  // Kept short deliberately: a lip that shuts late reads as a lip-sync error.
  closureRelease: 0.03,
};

/**
 * Frame-rate-independent exponential smoothing over the mapped weights.
 *
 * The feed already interpolates between keyframes, but keyframes are emitted
 * on a dead-band (only when a parameter moves >0.04, or every 240ms), so the
 * raw signal still has visible corners. This rounds them off, and gives the
 * asymmetry real mouths have: opening is fast, closing is slower — but a
 * consonant closure overrides that, because a late-closing lip reads as a
 * lip-sync error while a late-opening one does not.
 */
export class VisemeSmoother {
  private current: VisemeWeights = { ...ZERO_VISEMES };
  private config: SmoothingConfig;

  constructor(config: Partial<SmoothingConfig> = {}) {
    this.config = { ...DEFAULT_SMOOTHING, ...config };
  }

  /** @param delta seconds since the previous call. */
  update(
    target: VisemeWeights,
    delta: number,
    opts: { fastClose?: boolean } = {},
  ): VisemeWeights {
    if (!(delta > 0)) return this.current;
    const { attack, release, closureRelease } = this.config;
    const fallTau = opts.fastClose ? closureRelease : release;

    for (const key of VISEME_KEYS) {
      const from = this.current[key];
      const to = target[key];
      const tau = to > from ? attack : fallTau;
      // 1 - e^(-dt/tau): the same easing regardless of frame rate.
      const alpha = tau <= 0 ? 1 : 1 - Math.exp(-delta / tau);
      this.current[key] = from + (to - from) * alpha;
    }
    return this.current;
  }

  get value(): Readonly<VisemeWeights> {
    return this.current;
  }

  reset(): void {
    this.current = { ...ZERO_VISEMES };
  }
}
