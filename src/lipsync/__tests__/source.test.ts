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
    lead: null,
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

describe("scheduling lead", () => {
  function batchAt(offset: number, lead: number | null) {
    return {
      version: 1,
      ctx: "lead-test",
      keyframes: [
        {
          offset,
          openness: 0.9,
          width: 0.5,
          rounding: 0.05,
          energy: 0.6,
          pitch: 0.5,
          confidence: 0.9,
        },
      ],
      events: [],
      lead,
      raw: null,
    };
  }

  it("defaults to the server's documented 200ms lead", () => {
    const feed = new LipsyncFeed();
    const now = feed.now();
    feed.ingest(batchAt(0, null));
    // Anchor sits 200ms ahead, so the playhead is 200ms before t=0.
    expect(feed.relTime(now)! * 1000).toBeCloseTo(-200, 0);
  });

  it("honours a configured lead when the server does not state one", () => {
    const feed = new LipsyncFeed({ schedulingLeadSec: 0.5 });
    const now = feed.now();
    feed.ingest(batchAt(0, null));
    expect(feed.relTime(now)! * 1000).toBeCloseTo(-500, 0);
  });

  it("prefers the lead the server declares over the configured one", () => {
    // The server knows its own setting; a stale client config must not win.
    const feed = new LipsyncFeed({ schedulingLeadSec: 0.5 });
    const now = feed.now();
    feed.ingest(batchAt(0, 0.35));
    expect(feed.relTime(now)! * 1000).toBeCloseTo(-350, 0);
  });
});

describe("consonant events must not swallow the utterance", () => {
  // LipsyncFeed.activeEvents applies a 250ms floor so UI badges flash long
  // enough to see. Driving the mouth from that floor held the lips shut for
  // 67% of a measured utterance — real closures average 45ms and never
  // exceeded 120ms — which reads as "barely moving, with occasional jumps".
  function feedWithEvent(duration: number) {
    const feed = new LipsyncFeed();
    feed.ingest({
      version: 1,
      ctx: "hold",
      keyframes: [0, 0.5].map((offset) => ({
        offset,
        openness: 0.9,
        width: 0.5,
        rounding: 0.05,
        energy: 0.6,
        pitch: 0.5,
        confidence: 0.3,
      })),
      events: [{ offset: 0, kind: "closure", duration, confidence: 0.9 }],
      lead: null,
      raw: null,
    });
    return feed;
  }

  it("keeps the UI display floor for badges", () => {
    const feed = feedWithEvent(0.04);
    feed.offsetTrimMs = -300; // 100ms past the real closure, inside the floor
    expect(feed.activeEventKinds(feed.now()).has("closure")).toBe(true);
  });

  it("releases the lips on the real duration when driving articulation", () => {
    const feed = feedWithEvent(0.04);
    feed.offsetTrimMs = -300;
    expect(feed.activeEventKinds(feed.now(), 0.05).has("closure")).toBe(false);
  });

  it("still holds the lips shut for the length of the closure", () => {
    const feed = feedWithEvent(0.04);
    feed.offsetTrimMs = -220; // 20ms in, mid-closure
    expect(feed.activeEventKinds(feed.now(), 0.05).has("closure")).toBe(true);
  });
});

describe("the mouth closes promptly after speech ends", () => {
  // Measured against a real utterance: the tail close was dominated by the
  // feed's rest hold and ease, not by the smoother — dropping the smoother's
  // release from 90ms to 35ms moved it by under 70ms. Hold and ease are the
  // knobs that matter, so keep them honest.
  function tailCloseMs(opts: { restHoldSec?: number; restEaseSec?: number }) {
    const feed = new LipsyncFeed(opts);
    let now = 0;
    feed.now = () => now;
    feed.ingest({
      version: 1,
      ctx: "tail",
      keyframes: [0, 0.1].map((offset) => ({
        offset,
        openness: 0.95,
        width: 0.5,
        rounding: 0.05,
        energy: 0.8,
        pitch: 0.5,
        confidence: 0.4,
      })),
      events: [],
      lead: 0,
      raw: null,
    });
    const src = new ArticulationSource(feed);
    const dt = 1 / 60;
    const LAST = 0.1;
    for (let t = 0; t <= 3; t += dt) {
      now = t * 1000;
      const w = src.sampleVisemes(now, dt);
      const total = Object.values(w).reduce((a, b) => a + b, 0);
      if (t > LAST && total < 0.1) return Math.round((t - LAST) * 1000);
    }
    return Infinity;
  }

  it("shuts within a few hundred ms of the last keyframe", () => {
    // Worst case: the utterance ends on a fully open /a/. Real speech tails
    // off through a closure or a decaying vowel and measured ~270ms; this
    // bound is the pathological end of that range, not the typical one.
    expect(tailCloseMs({})).toBeLessThan(500);
  });

  it("holds longer when configured to, for jitter-prone links", () => {
    expect(tailCloseMs({ restHoldSec: 0.25, restEaseSec: 0.3 })).toBeGreaterThan(
      tailCloseMs({}),
    );
  });
});

describe("lookahead compensates the smoother's onset delay", () => {
  // Exponential smoothing reaches a small target at once but takes several
  // time constants to reach a large one, so wide openings arrived ~83ms late
  // even though average alignment was within a frame. Sampling ahead spends
  // the smoother's budget in advance; the window is already buffered because
  // the server releases keyframes ~200ms ahead of playout.
  function firstReachMs(lookaheadSec: number, level: number) {
    const feed = new LipsyncFeed();
    let now = 0;
    feed.now = () => now;
    feed.ingest({
      version: 1,
      ctx: "onset",
      // Shut, then abruptly wide open at t=0.5s.
      keyframes: [
        { offset: 0, openness: 0.15, width: 0.35, rounding: 0.1, energy: 0, pitch: 0, confidence: 0.4 },
        { offset: 0.49, openness: 0.15, width: 0.35, rounding: 0.1, energy: 0, pitch: 0, confidence: 0.4 },
        { offset: 0.5, openness: 0.95, width: 0.5, rounding: 0.05, energy: 0.9, pitch: 0.5, confidence: 0.4 },
        { offset: 1.5, openness: 0.95, width: 0.5, rounding: 0.05, energy: 0.9, pitch: 0.5, confidence: 0.4 },
      ],
      events: [],
      lead: 0,
      raw: null,
    });
    const src = new ArticulationSource(feed, { lookaheadSec });
    const dt = 1 / 60;
    for (let t = 0; t <= 2; t += dt) {
      now = t * 1000;
      const total = Object.values(src.sampleVisemes(now, dt)).reduce((a, b) => a + b, 0);
      if (total >= level) return Math.round((t - 0.5) * 1000);
    }
    return Infinity;
  }

  it("reaches a wide opening sooner than with no lookahead", () => {
    expect(firstReachMs(0.05, 0.6)).toBeLessThan(firstReachMs(0, 0.6));
  });

  it("does not run ahead of the audio by a perceptible margin", () => {
    // Visual leading audio is tolerated less than lagging, so the default
    // must not overshoot into the mouth moving before the sound.
    expect(firstReachMs(0.05, 0.6)).toBeGreaterThan(-40);
  });
});
