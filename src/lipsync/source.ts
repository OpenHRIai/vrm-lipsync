/**
 * The seam between "where mouth shapes come from" and "what renders them".
 *
 * The renderer needs one thing per frame: a set of VRM vowel weights. Making
 * that the contract — rather than a concrete `LipsyncFeed` — means the avatar
 * is not tied to the `pipecat-visemes` wire format or its articulation model.
 * Anything that can produce vowel weights on demand can drive it: a different
 * analyzer tier, provider viseme events, or a plain volume fallback.
 */

import type { LipsyncFeed } from "./feed";
import {
  mapToVisemes,
  VisemeSmoother,
  type SmoothingConfig,
  type VisemeMapperConfig,
  type VisemeWeights,
} from "./visemeMapper";

export interface LipsyncSource {
  /**
   * Vowel weights for this instant.
   *
   * @param nowMs wall clock, from `performance.now()`
   * @param deltaSec seconds since the previous call, for time-based smoothing
   */
  sampleVisemes(nowMs: number, deltaSec: number): VisemeWeights;
  /** Drop any accumulated state, e.g. on disconnect. */
  reset?(): void;
}

/**
 * Drives visemes from a `pipecat-visemes` articulation feed.
 *
 * Owns the mapping and smoothing so the renderer holds neither: it samples the
 * feed's articulation parameters, maps them onto VRM's five vowels, and eases
 * the result. Consonant closures bypass the normal release, because a lip that
 * shuts late reads as a lip-sync error while one that opens late does not.
 */
export class ArticulationSource implements LipsyncSource {
  private feed: LipsyncFeed;
  private smoother: VisemeSmoother;
  private mapperConfig?: Partial<VisemeMapperConfig>;

  constructor(
    feed: LipsyncFeed,
    options: {
      mapperConfig?: Partial<VisemeMapperConfig>;
      smoothingConfig?: Partial<SmoothingConfig>;
    } = {},
  ) {
    this.feed = feed;
    this.mapperConfig = options.mapperConfig;
    this.smoother = new VisemeSmoother(options.smoothingConfig);
  }

  sampleVisemes(nowMs: number, deltaSec: number): VisemeWeights {
    const sample = this.feed.sample(nowMs);
    const events = this.feed.activeEventKinds(nowMs);
    const target = mapToVisemes(sample, events, this.mapperConfig);
    const fastClose = events.has("closure") || events.has("nasal");
    return this.smoother.update(target, deltaSec, { fastClose });
  }

  reset(): void {
    this.smoother.reset();
  }
}

/** True for anything already satisfying the renderer's contract. */
export function isLipsyncSource(value: unknown): value is LipsyncSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LipsyncSource).sampleVisemes === "function"
  );
}
