import {
  LipsyncFeed,
  VRMAvatar,
  mapToVisemes,
  type LipsyncBatch,
  type VRMAvatarRef,
} from "@openhri/vrm-lipsync";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * Inspector for the VRM lipsync pipeline.
 *
 * Fabricates the batches a `pipecat-visemes` server would send, so the avatar
 * and the mapper can be exercised without a bot running. "Speak" cycles the
 * five vowels with a consonant closure between words; the Hold buttons pin one
 * vowel so its mouth shape can be inspected at leisure.
 */
const VOWELS = [
  { name: "aa", openness: 0.95, width: 0.5, rounding: 0.05 },
  { name: "ih", openness: 0.22, width: 0.85, rounding: 0.05 },
  { name: "ou", openness: 0.25, width: 0.15, rounding: 0.95 },
  { name: "ee", openness: 0.5, width: 0.9, rounding: 0.05 },
  { name: "oh", openness: 0.75, width: 0.25, rounding: 0.75 },
];

const MODEL_URL = "/RikiMinami.vrm";

const KF_HZ = 20;
const VOWEL_SEC = 0.25;
const LOOKAHEAD_SEC = 2.0;
const TICK_MS = 400;

function keyframe(offset: number, v: (typeof VOWELS)[number]) {
  return {
    offset,
    openness: v.openness,
    width: v.width,
    rounding: v.rounding,
    energy: 0.6,
    pitch: 0.5,
    confidence: 0.9,
  };
}

/**
 * Enqueue keyframes from `from` up to `until` seconds of utterance time.
 *
 * Driven by the playhead rather than a step counter: a background tab
 * throttles setInterval to ~1Hz, and a fixed-rate producer would fall behind
 * real time until the feed ran dry.
 */
function makeBatch(
  ctx: string,
  from: number,
  until: number,
  hold: string | null,
): LipsyncBatch {
  const kf: LipsyncBatch["keyframes"] = [];
  const events: LipsyncBatch["events"] = [];
  const held = hold ? VOWELS.find((v) => v.name === hold) : null;

  for (let t = from; t < until; t += 1 / KF_HZ) {
    kf.push(keyframe(t, held ?? VOWELS[Math.floor(t / VOWEL_SEC) % VOWELS.length]));
    // A consonant closure between "words" — skipped while holding a vowel.
    if (!held && Math.floor(t) !== Math.floor(t - 1 / KF_HZ)) {
      events.push({ offset: t, kind: "closure", duration: 0.1, confidence: 0.8 });
    }
  }
  return { version: 1, ctx, keyframes: kf, events, windowStart: null, playoutShift: 0, lead: null, raw: null };
}

const btn: React.CSSProperties = {
  padding: "6px 12px",
  background: "#22262e",
  color: "#e6e8eb",
  border: "1px solid #363b45",
  borderRadius: 6,
  cursor: "pointer",
};
const btnOn: React.CSSProperties = {
  ...btn,
  background: "#3b82f6",
  borderColor: "#3b82f6",
  color: "#fff",
};

function App() {
  const [feed] = useState(() => new LipsyncFeed());
  const [speaking, setSpeaking] = useState(true);
  const [hold, setHold] = useState<string | null>(null);
  const [status, setStatus] = useState("loading model…");
  const [loaded, setLoaded] = useState(false);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const avatarRef = useRef<VRMAvatarRef>(null);

  if (import.meta.env.DEV) {
    Object.assign(window, {
      lipsyncFeed: feed,
      mapToVisemes,
      getVRM: () => avatarRef.current?.getVRM() ?? null,
      getStage: () => avatarRef.current?.getStage() ?? null,
    });
  }

  // Gated on `loaded`: parsing a multi-megabyte VRM blocks the main thread,
  // which starves setInterval and would let the playhead outrun the queue.
  useEffect(() => {
    if (!speaking || !loaded) return;
    const ctx = `utt-${Date.now()}-${hold ?? "cycle"}`;
    let nextOffset = 0;
    const push = () => {
      const rel = feed.relTime(feed.now()) ?? 0;
      const until = Math.max(rel, 0) + LOOKAHEAD_SEC;
      if (nextOffset >= until) return;
      feed.ingest(makeBatch(ctx, nextOffset, until, hold));
      nextOffset = until;
    };
    push();
    const id = setInterval(push, TICK_MS);
    return () => {
      clearInterval(id);
      feed.reset();
    };
  }, [feed, speaking, loaded, hold]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = feed.now();
      setWeights(mapToVisemes(feed.sample(now), feed.activeEventKinds(now)));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [feed]);

  return (
    <>
      <VRMAvatar
        ref={avatarRef}
        modelUrl={MODEL_URL}
        idleAnimationUrl="/idle_loop.vrma"
        source={speaking ? feed : null}
        interactive
        onLoad={() => {
          setStatus("loaded");
          setLoaded(true);
        }}
        onError={(e) => setStatus(`error: ${e.message}`)}
        onProgress={(p) =>
          setStatus(`loading ${Math.round((p.loaded / (p.total || 1)) * 100)}%`)
        }
        fallback={
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            {status}
          </div>
        }
      />

      <div style={{ padding: 12, borderTop: "1px solid #2a2e35", display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={speaking ? btnOn : btn} onClick={() => setSpeaking((s) => !s)}>
            {speaking ? "◼ Stop" : "▶ Speak"}
          </button>
          <span style={{ opacity: 0.5 }}>|</span>
          <span style={{ opacity: 0.6, fontSize: 12 }}>Hold vowel:</span>
          {VOWELS.map((v) => (
            <button
              key={v.name}
              style={hold === v.name ? btnOn : btn}
              onClick={() => setHold(hold === v.name ? null : v.name)}
            >
              {v.name}
            </button>
          ))}
          <span style={{ opacity: 0.5 }}>|</span>
          <span style={{ opacity: 0.6, fontSize: 12 }}>Emotion:</span>
          {(["neutral", "happy", "angry", "sad", "relaxed"] as const).map((e) => (
            <button key={e} style={btn} onClick={() => avatarRef.current?.setEmotion(e, 0.3)}>
              {e}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code id="status" style={{ opacity: 0.6, fontSize: 12 }}>{status}</code>
        </div>

        {/* Live viseme weights as bars, so the blend is readable at a glance. */}
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end", height: 56 }}>
          {VOWELS.map((v) => {
            const w = weights[v.name as keyof typeof weights] ?? 0;
            return (
              <div key={v.name} style={{ textAlign: "center", width: 58 }}>
                <div style={{ height: 34, display: "flex", alignItems: "flex-end" }}>
                  <div
                    style={{
                      width: "100%",
                      height: `${Math.round(w * 100)}%`,
                      background: w > 0.5 ? "#3b82f6" : "#4b5563",
                      borderRadius: "3px 3px 0 0",
                      transition: "height 60ms linear",
                    }}
                  />
                </div>
                <div style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>
                  {v.name} {w.toFixed(2)}
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 12, opacity: 0.5, alignSelf: "center", marginLeft: 12 }}>
            drag to orbit · scroll to zoom
          </div>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
