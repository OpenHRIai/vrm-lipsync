import { describe, expect, it } from "vitest";

import { REST_POSE, type ArticulationSample } from "../feed";
import {
  DEFAULT_ANCHORS,
  mapToVisemes,
  VisemeSmoother,
  type VisemeWeights,
} from "../visemeMapper";

function sample(over: Partial<ArticulationSample> = {}): ArticulationSample {
  return {
    openness: 0.5,
    width: 0.5,
    rounding: 0.5,
    energy: 0.5,
    pitch: 0.5,
    confidence: 1,
    live: true,
    relTime: 0,
    ...over,
  };
}

function dominant(w: VisemeWeights): keyof VisemeWeights {
  return (Object.keys(w) as (keyof VisemeWeights)[]).reduce((a, b) =>
    w[a] >= w[b] ? a : b,
  );
}

function sum(w: VisemeWeights): number {
  return w.aa + w.ih + w.ou + w.ee + w.oh;
}

describe("mapToVisemes", () => {
  it("maps each anchor pose to its own viseme", () => {
    for (const [name, anchor] of Object.entries(DEFAULT_ANCHORS)) {
      const w = mapToVisemes(sample(anchor));
      expect(dominant(w), `anchor ${name}`).toBe(name);
    }
  });

  it("blends between neighbouring vowels rather than snapping", () => {
    // Halfway between /a/ and /o/: both should be present, neither dominant
    // by a landslide.
    const between = {
      openness: (DEFAULT_ANCHORS.aa.openness + DEFAULT_ANCHORS.oh.openness) / 2,
      width: (DEFAULT_ANCHORS.aa.width + DEFAULT_ANCHORS.oh.width) / 2,
      rounding: (DEFAULT_ANCHORS.aa.rounding + DEFAULT_ANCHORS.oh.rounding) / 2,
    };
    const w = mapToVisemes(sample(between));
    expect(w.aa).toBeGreaterThan(0.05);
    expect(w.oh).toBeGreaterThan(0.05);
    expect(Math.abs(w.aa - w.oh)).toBeLessThan(0.15);
  });

  it("closes the mouth on closure, nasal and silence events", () => {
    const open = sample(DEFAULT_ANCHORS.aa);
    expect(sum(mapToVisemes(open))).toBeGreaterThan(0.5);
    for (const kind of ["closure", "nasal", "silence"] as const) {
      expect(sum(mapToVisemes(open, [kind])), kind).toBe(0);
    }
  });

  it("closes the mouth at the analyzer's rest pose", () => {
    expect(sum(mapToVisemes(sample(REST_POSE)))).toBe(0);
  });

  it("gives close vowels real strength, not just open ones", () => {
    // /i/ and /u/ are articulated with the lips while the jaw stays nearly
    // shut. Driving strength off jaw opening alone rendered them at ~0.07,
    // effectively invisible; they should be within reach of the open vowels.
    const strength = (name: keyof typeof DEFAULT_ANCHORS) =>
      sum(mapToVisemes(sample(DEFAULT_ANCHORS[name])));

    const open = strength("aa");
    for (const close of ["ih", "ou"] as const) {
      expect(strength(close), close).toBeGreaterThan(0.3 * open);
    }
    // /u/ has a very distinct lip shape and should read at least as strongly
    // as the mid vowel /e/.
    expect(strength("ou")).toBeGreaterThan(strength("ee") * 0.9);
  });

  it("produces nothing when the feed is not live", () => {
    expect(sum(mapToVisemes(sample({ ...DEFAULT_ANCHORS.aa, live: false })))).toBe(0);
  });

  it("commits less when the analyzer is unconfident", () => {
    const confident = mapToVisemes(sample({ ...DEFAULT_ANCHORS.aa, confidence: 1 }));
    const unsure = mapToVisemes(sample({ ...DEFAULT_ANCHORS.aa, confidence: 0 }));
    expect(sum(unsure)).toBeLessThan(sum(confident));
    // ...but still moves, rather than freezing the face mid-utterance.
    expect(sum(unsure)).toBeGreaterThan(0);
  });

  it("keeps every weight inside 0..1", () => {
    for (let o = 0; o <= 1; o += 0.1) {
      for (let wd = 0; wd <= 1; wd += 0.25) {
        for (let r = 0; r <= 1; r += 0.25) {
          const w = mapToVisemes(sample({ openness: o, width: wd, rounding: r }));
          for (const v of Object.values(w)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe("VisemeSmoother", () => {
  const target = mapToVisemes(sample(DEFAULT_ANCHORS.aa));

  it("approaches the target without overshooting", () => {
    const s = new VisemeSmoother();
    let last = 0;
    for (let i = 0; i < 200; i++) {
      const w = s.update(target, 1 / 60);
      expect(w.aa).toBeGreaterThanOrEqual(last - 1e-9);
      expect(w.aa).toBeLessThanOrEqual(target.aa + 1e-9);
      last = w.aa;
    }
    expect(last).toBeCloseTo(target.aa, 4);
  });

  it("is frame-rate independent", () => {
    const fast = new VisemeSmoother();
    const slow = new VisemeSmoother();
    for (let i = 0; i < 120; i++) fast.update(target, 1 / 120);
    for (let i = 0; i < 30; i++) slow.update(target, 1 / 30);
    // Same elapsed second, very different step counts.
    expect(fast.value.aa).toBeCloseTo(slow.value.aa, 2);
  });

  it("closes faster on a closure than on an ordinary release", () => {
    const normal = new VisemeSmoother();
    const closing = new VisemeSmoother();
    for (let i = 0; i < 200; i++) {
      normal.update(target, 1 / 60);
      closing.update(target, 1 / 60);
    }
    const zero = mapToVisemes(sample(DEFAULT_ANCHORS.aa), ["closure"]);
    for (let i = 0; i < 3; i++) {
      normal.update(zero, 1 / 60);
      closing.update(zero, 1 / 60, { fastClose: true });
    }
    expect(closing.value.aa).toBeLessThan(normal.value.aa);
  });
});
