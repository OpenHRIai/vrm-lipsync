/**
 * Replays vowel-probe fixtures through the client exactly as the renderer
 * would see them, and scores what comes out.
 *
 * Shared by the test (src/lipsync/__tests__/vowelProbe.test.ts) and the
 * visual check (examples/01-synthetic/probe.html), so the page and the test
 * cannot disagree about what a probe rendered as.
 */
import { LipsyncFeed } from "../../src/lipsync/feed";
import { parseLipsyncData, type LipsyncEventKind } from "../../src/lipsync/protocol";
import { ArticulationSource, DEFAULT_EVENT_HOLD_SEC } from "../../src/lipsync/source";
import {
  DEFAULT_MAPPER_CONFIG,
  ZERO_VISEMES,
  type VisemeWeights,
} from "../../src/lipsync/visemeMapper";

export type Viseme = keyof VisemeWeights;
export const VISEMES: readonly Viseme[] = ["aa", "ih", "ou", "ee", "oh"];

/** VRM preset names are not the vowels they sound like. */
export const SOUNDS: Record<Viseme, string> = {
  ih: '/i/ "ee"',
  aa: '/a/ "ah"',
  ou: '/u/ "oo"',
  ee: '/e/ "eh"',
  oh: '/o/ "oh"',
};

/**
 * Mean weight the expected blendshape must reach over the vowel. Below this
 * the shape may be "right" but too faint to read on screen.
 */
export const MIN_VISIBLE = 0.25;

/** One vowel within a probe; times are seconds from utterance start. */
export interface ProbeSegment {
  expect: Viseme;
  start: number;
  end: number;
  f1_hz: number | null;
  f2_hz: number | null;
  f2_found: number;
  praat_f1_hz: number | null;
  praat_f2_hz: number | null;
  confidence: number;
}

export interface Probe {
  id: string;
  text: string;
  audio: string;
  duration: number;
  segments: ProbeSegment[];
  /**
   * The RTVI server-message data for the analyzer fed the audio directly:
   * word timings that arrive after a vowel was analyzed are too late for it.
   */
  message: ProbeMessage;
  /**
   * Everything the live bot's LipsyncProcessor delivered, as one message: its
   * keyframes wait in the delivery queue until just before playout, and word
   * timings arriving meanwhile revise them (the correction buffer).
   */
  buffered?: ProbeMessage;
}

export interface ProbeMessage {
  kf: number[][];
  ev: [number, string, number, number][];
}

/** The probe as the live bot delivers it, if the fixture has that view. */
export function withBuffer(probe: Probe): Probe | null {
  return probe.buffered ? { ...probe, message: probe.buffered } : null;
}

export interface ProbeFixture {
  voice: string;
  probes: Probe[];
}

/** A feed on a clock the caller controls, instead of the wall clock. */
export class ReplayFeed extends LipsyncFeed {
  clockMs = 0;
  /** Clock time at which utterance t=0 plays. */
  readonly zeroMs: number;

  constructor(probe: Probe) {
    super();
    const batch = parseLipsyncData(probe.message);
    if (!batch) throw new Error(`${probe.id}: fixture is not a lipsync message`);
    this.ingest(batch);
    this.zeroMs = -(this.relTime(0) ?? 0) * 1000;
  }

  override now(): number {
    return this.clockMs;
  }

  /** Clock time for an utterance-relative time in seconds. */
  at(relSec: number): number {
    return this.zeroMs + relSec * 1000;
  }
}

export interface ReplayFrame {
  rel: number;
  /** The analyzer's articulation as the feed interpolates it, before mapping. */
  openness: number;
  width: number;
  rounding: number;
  /** Consonant events in force, as the renderer applies them (lips shut). */
  events: LipsyncEventKind[];
  /** VRM blendshape weights after mapping and smoothing. */
  weights: VisemeWeights;
}

export const FRAME_SEC = 1 / 60;

/** Plays one probe through feed, mapper and smoother at 60fps. */
export function replay(probe: Probe): ReplayFrame[] {
  const feed = new ReplayFeed(probe);
  const source = new ArticulationSource(feed);
  const frames: ReplayFrame[] = [];
  for (let rel = 0; rel <= probe.duration; rel += FRAME_SEC) {
    const nowMs = feed.at(rel);
    feed.clockMs = nowMs;
    const s = feed.sample(nowMs);
    frames.push({
      rel,
      openness: s.openness,
      width: s.width,
      rounding: s.rounding,
      events: [...feed.activeEventKinds(nowMs, DEFAULT_EVENT_HOLD_SEC)],
      weights: { ...source.sampleVisemes(nowMs, FRAME_SEC) },
    });
  }
  return frames;
}

export interface SegmentScore {
  /** Mean articulation the analyzer sent over the vowel. */
  pose: { openness: number; width: number; rounding: number };
  /** The anchor that pose sits nearest, by the mapper's own metric. */
  sentAs: Viseme;
  /** Mean blendshape weights the renderer applied over the vowel. */
  shown: VisemeWeights;
  /** The blendshape that dominated on screen. */
  shownAs: Viseme;
  /** Consonant events overlapping the vowel, e.g. "nasal@0.15s". */
  events: string[];
  analyzerOk: boolean;
  avatarOk: boolean;
}

export function score(probe: Probe, segment: ProbeSegment, frames: ReplayFrame[]): SegmentScore {
  const inside = frames.filter((f) => f.rel >= segment.start && f.rel <= segment.end);
  if (inside.length === 0) throw new Error(`${probe.id}: no frames in vowel nucleus`);
  const mean = (pick: (f: ReplayFrame) => number) =>
    inside.reduce((acc, f) => acc + pick(f), 0) / inside.length;

  const pose = {
    openness: mean((f) => f.openness),
    width: mean((f) => f.width),
    rounding: mean((f) => f.rounding),
  };
  const sentAs = nearestAnchor(pose);
  const shown = { ...ZERO_VISEMES };
  for (const v of VISEMES) shown[v] = mean((f) => f.weights[v]);
  const shownAs = VISEMES.reduce((a, b) => (shown[a] >= shown[b] ? a : b));
  const events = probe.message.ev
    .filter(([t]) => t >= segment.start - 0.1 && t <= segment.end)
    .map(([t, kind]) => `${kind}@${t}s`);

  return {
    pose,
    sentAs,
    shown,
    shownAs,
    events,
    analyzerOk: sentAs === segment.expect,
    avatarOk: shownAs === segment.expect && shown[segment.expect] >= MIN_VISIBLE,
  };
}

function nearestAnchor(pose: SegmentScore["pose"]): Viseme {
  const { anchors, axisWeights: w } = DEFAULT_MAPPER_CONFIG;
  let best: Viseme = "aa";
  let bestD = Infinity;
  for (const v of VISEMES) {
    const a = anchors[v];
    const d =
      ((pose.openness - a.openness) * w.openness) ** 2 +
      ((pose.width - a.width) * w.width) ** 2 +
      ((pose.rounding - a.rounding) * w.rounding) ** 2;
    if (d < bestD) [best, bestD] = [v, d];
  }
  return best;
}
