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

/**
 * How long a consonant event holds the lips shut, in seconds.
 *
 * Matched to real closures: measured over an utterance they averaged 45ms and
 * never exceeded 120ms. The feed's own default is a 250ms *display* floor for
 * UI badges, which if used here would shut the mouth for roughly two-thirds of
 * running speech.
 */
export const DEFAULT_EVENT_HOLD_SEC = 0.05;

/**
 * How far ahead of the playhead to sample, in seconds.
 *
 * Exponential smoothing reaches a *small* target almost immediately but takes
 * several time constants to reach a large one. Measured on real speech, the
 * average alignment was only one frame out, yet reaching a wide-open mouth
 * lagged its target by a median of 167ms — which is what reads as "the
 * visuals are behind", since onset is what the eye actually tracks.
 *
 * Rather than shortening the smoothing and reintroducing jitter, we sample
 * slightly into the future and let the smoother spend that budget catching
 * up. It is free: the server releases keyframes ~200ms ahead of playout, so
 * this window is already buffered.
 *
 * Sized to the attack it compensates: with a 30ms attack, 20ms lands onset
 * error at zero on real speech. Overshooting here is worse than undershooting
 * — visuals leading audio is noticed sooner than visuals trailing it.
 */
export const DEFAULT_LOOKAHEAD_SEC = 0.02;

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
  private eventHoldSec: number;
  private lookaheadSec: number;

  constructor(
    feed: LipsyncFeed,
    options: {
      mapperConfig?: Partial<VisemeMapperConfig>;
      smoothingConfig?: Partial<SmoothingConfig>;
      /**
       * Minimum time the lips stay shut for a consonant event, in seconds.
       * Zero-duration markers (nasals, silences) need *some* span to register
       * at frame rate, but real closures last 40-120ms — hold them much
       * longer and the mouth spends the utterance closed.
       */
      eventHoldSec?: number;
      /**
       * Seconds to sample ahead of the playhead, compensating the smoother's
       * own delay. Set to 0 to disable.
       */
      lookaheadSec?: number;
    } = {},
  ) {
    this.feed = feed;
    this.mapperConfig = options.mapperConfig;
    this.eventHoldSec = options.eventHoldSec ?? DEFAULT_EVENT_HOLD_SEC;
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC;
    this.smoother = new VisemeSmoother(options.smoothingConfig);
  }

  sampleVisemes(nowMs: number, deltaSec: number): VisemeWeights {
    const at = nowMs + this.lookaheadSec * 1000;
    const sample = this.feed.sample(at);
    const events = this.feed.activeEventKinds(at, this.eventHoldSec);
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
