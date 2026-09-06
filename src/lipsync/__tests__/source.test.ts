import { describe, expect, it } from "vitest";

import { LipsyncFeed } from "../feed";
import { ArticulationSource, isLipsyncSource, type LipsyncSource } from "../source";
import { DEFAULT_ANCHORS, ZERO_VISEMES, type VisemeWeights } from "../visemeMapper";

function feedHolding(vowel: keyof typeof DEFAULT_ANCHORS): LipsyncFeed {
  const feed = new LipsyncFeed();
  const a = DEFAULT_ANCHORS[vowel];
  feed.ingest({
    version: 1,
    ctx: "test",
    keyframes: Array.from({ length: 40 }, (_, i) => ({
      offset: i / 20,
      openness: a.openness,
      width: a.width,
      rounding: a.rounding,
      energy: 0.6,
      pitch: 0.5,
      confidence: 0.9,
    })),
    events: [],
    raw: null,
  });
  // Advance the playhead into the batch without waiting on the wall clock.
  feed.offsetTrimMs = -700;
  return feed;
}

const dominant = (w: VisemeWeights) =>
  (Object.keys(w) as (keyof VisemeWeights)[]).reduce((a, b) => (w[a] >= w[b] ? a : b));

describe("ArticulationSource", () => {
  it("satisfies the renderer's contract", () => {
    expect(isLipsyncSource(new ArticulationSource(new LipsyncFeed()))).toBe(true);
  });

  it("converges on the vowel the feed is holding", () => {
    const source = new ArticulationSource(feedHolding("oh"));
    let w: VisemeWeights = { ...ZERO_VISEMES };
    const now = performance.now();
    for (let i = 0; i < 120; i++) w = source.sampleVisemes(now, 1 / 60);
    expect(dominant(w)).toBe("oh");
    expect(w.oh).toBeGreaterThan(0.3);
  });

  it("returns to rest after reset", () => {
    const source = new ArticulationSource(feedHolding("aa"));
    const now = performance.now();
    for (let i = 0; i < 120; i++) source.sampleVisemes(now, 1 / 60);
    source.reset();
    // One tiny step after a reset must start from silence, not the old shape.
    const w = source.sampleVisemes(now, 1 / 600);
    expect(w.aa).toBeLessThan(0.2);
  });
});

describe("LipsyncSource", () => {
  it("lets a non-articulation source drive the renderer", () => {
    // The point of the seam: no LipsyncFeed, no wire format, no articulation
    // parameters — just vowel weights, e.g. from provider viseme events.
    const custom: LipsyncSource = {
      sampleVisemes: () => ({ ...ZERO_VISEMES, ih: 0.8 }),
    };
    expect(isLipsyncSource(custom)).toBe(true);
    expect(dominant(custom.sampleVisemes(0, 0.016))).toBe("ih");
  });

  it("rejects things that are not sources", () => {
    expect(isLipsyncSource(new LipsyncFeed())).toBe(false);
    expect(isLipsyncSource(null)).toBe(false);
    expect(isLipsyncSource({})).toBe(false);
  });
});
