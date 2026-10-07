/**
 * End-to-end vowel check: real TTS speech, real analyzer, real client path.
 *
 * Each fixture is a vowel spoken by the bot's own TTS voice, analyzed by the
 * upstream `FormantLipsyncAnalyzer` and encoded exactly as it goes over the
 * wire (see tools/vowel-probe/capture.py). Replaying it here asks the
 * question a viewer asks: while the bot is saying "ee", does the avatar's
 * mouth make the `ih` shape?
 *
 * Two layers, so a failure says where it comes from:
 *
 * - **analyzer**: the articulation the server sends (openness, width,
 *   rounding) lands nearest the right vowel. If this fails, the mouth was
 *   never told the right shape and no client tuning will fix it.
 * - **avatar**: what the renderer actually receives — after events, mapping
 *   and smoothing — shows that vowel, visibly. If only this fails, the fault
 *   is client-side.
 *
 * Run with `npm run test:vowels`. Watch and hear the same clips on the
 * avatar at examples/01-synthetic/probe.html. To score another analyzer
 * revision on the same audio, capture it with `--out <file>` and set
 * VOWEL_PROBES=<file>.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MIN_VISIBLE,
  replay,
  score,
  SOUNDS,
  VISEMES,
  type Probe,
  type ProbeFixture,
  type ReplayFrame,
} from "../../../tools/vowel-probe/replay";

const FIXTURE = new URL(
  `../../../assets/vowel-probe/${process.env.VOWEL_PROBES ?? "probes.json"}`,
  import.meta.url,
);
const probes = (JSON.parse(readFileSync(FIXTURE, "utf8")) as ProbeFixture).probes;
const fmt = (n: number) => n.toFixed(2);
const hz = (n: number | null) => (n === null ? "none" : `${Math.round(n)}Hz`);

const cases = probes.flatMap((probe) =>
  probe.segments.map((segment, i) => ({
    probe,
    segment,
    name: `${probe.id}${probe.segments.length > 1 ? ` #${i + 1}` : ""} ${JSON.stringify(probe.text)}`,
  })),
);

const replays = new Map<string, ReplayFrame[]>();
const framesOf = (probe: Probe) => {
  if (!replays.has(probe.id)) replays.set(probe.id, replay(probe));
  return replays.get(probe.id)!;
};

describe("vowel probes: analyzer", () => {
  it.each(cases)("$name sends the $segment.expect pose", ({ probe, segment }) => {
    const { pose, sentAs } = score(probe, segment, framesOf(probe));
    expect(
      sentAs,
      `${SOUNDS[segment.expect]} was sent as open=${fmt(pose.openness)} ` +
        `width=${fmt(pose.width)} round=${fmt(pose.rounding)}, nearest ${sentAs}. ` +
        `Analyzer measured F1=${hz(segment.f1_hz)} F2=${hz(segment.f2_hz)} ` +
        `(F2 found on ${Math.round(segment.f2_found * 100)}% of hops); ` +
        `Praat measured F1=${hz(segment.praat_f1_hz)} F2=${hz(segment.praat_f2_hz)}`,
    ).toBe(segment.expect);
  });
});

describe("vowel probes: avatar", () => {
  it.each(cases)("$name shows $segment.expect", ({ probe, segment }) => {
    const { shown, shownAs, events } = score(probe, segment, framesOf(probe));
    const detail =
      `${SOUNDS[segment.expect]} rendered as ` +
      VISEMES.map((v) => `${v}=${fmt(shown[v])}`).join(" ") +
      (events.length ? `; events ${events.join(", ")}` : "");

    expect(shownAs, detail).toBe(segment.expect);
    expect(shown[segment.expect], `${detail} — too faint to read`).toBeGreaterThanOrEqual(
      MIN_VISIBLE,
    );
  });
});
