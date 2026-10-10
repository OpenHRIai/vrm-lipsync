import {
  DEFAULT_ANCHORS,
  VRMAvatar,
  ZERO_VISEMES,
  type LipsyncSource,
  type VisemeWeights,
} from "@openhri/vrm-lipsync";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  FRAME_SEC,
  replay,
  score,
  SOUNDS,
  VISEMES,
  type Probe,
  type ProbeFixture,
  type ReplayFrame,
  type SegmentScore,
  type Viseme,
  withBuffer,
} from "../../../tools/vowel-probe/replay";

/**
 * Vowel probe: hear a real TTS vowel and see what the avatar does with it.
 *
 * Plays the fixtures from tools/vowel-probe/capture.py — the bot's own voice,
 * analyzed by the real server analyzer — beside a second avatar holding the
 * vowel that *should* be showing. The right-hand avatar is driven by the very
 * frames `npm run test:vowels` scores, so what you see is what the test
 * judged. Vowels last 100-200ms; slow it down and scrub to actually look.
 *
 * Between them, a plain 2D mouth draws the analyzer's own output (openness,
 * width, rounding) before any VRM mapping or smoothing, with the expected
 * vowel's target pose dashed behind it — so a wrong shape can be pinned on
 * the analyzer or on what the VRM layer does with it.
 *
 * The fourth pane is what the live bot sends for the same audio: its
 * keyframes wait in a delivery queue until just before playout, and word
 * timings arriving meanwhile correct them (the correction buffer). The panes
 * before it show the analyzer fed the audio directly, without that chance.
 *
 * `?probes=probes.next.json` shows another capture (`capture.py --out`), the
 * page's counterpart of the test's VOWEL_PROBES.
 */

const MODEL_URL = "/RikiMinami.vrm";
const FIXTURE_URL = `/vowel-probe/${
  new URLSearchParams(window.location.search).get("probes")?.replace(/[^\w.-]/g, "") ||
  "probes.json"
}`;
const RATES = [1, 0.5, 0.25] as const;
// Scene light scale for the avatars. Full light washes the toon-shaded face
// out to near white, which hides the mouth's shape.
const DEFAULT_LIGHT = 0.5;
// Ramp for the reference avatar between vowels of a multi-vowel probe.
const REF_RAMP_SEC = 0.04;

const btn: React.CSSProperties = {
  padding: "5px 10px",
  background: "#22262e",
  color: "#e6e8eb",
  border: "1px solid #363b45",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};
const btnOn: React.CSSProperties = { ...btn, background: "#3b82f6", borderColor: "#3b82f6" };
// Selected probe: outlined rather than filled, so its pass/fail marks stay legible.
const btnPicked: React.CSSProperties = { ...btn, background: "#1e293b", borderColor: "#3b82f6" };
const PASS = "#22c55e";
const FAIL = "#ef4444";

interface View {
  probe: Probe;
  frames: ReplayFrame[];
  scores: SegmentScore[];
}

interface Scored extends View {
  /** The same probe as the live bot delivers it, with the correction buffer. */
  buffered: View | null;
}

function scoreView(probe: Probe): View {
  const frames = replay(probe);
  return { probe, frames, scores: probe.segments.map((s) => score(probe, s, frames)) };
}

const inSentence = (probe: Probe) => probe.id.endsWith("-mid");
const GROUPS = [
  {
    label: "word alone",
    title: "The word is the whole utterance, so it is also the first word",
    has: (p: Probe) => p.segments.length === 1 && !inSentence(p),
    short: (p: Probe) => p.text,
  },
  {
    label: "in a sentence",
    title: 'The word fourth in "Okay, now say …, please."',
    has: inSentence,
    short: (p: Probe) => `…${/say (.+?),/.exec(p.text)?.[1] ?? p.text}…`,
  },
  {
    label: "sequence",
    title: "Five vowels in one utterance",
    has: (p: Probe) => p.segments.length !== 1,
    short: (p: Probe) => p.text,
  },
];

function frameAt(frames: ReplayFrame[], t: number): VisemeWeights {
  if (frames.length === 0) return { ...ZERO_VISEMES };
  const i = Math.min(frames.length - 1, Math.max(0, Math.round(t / FRAME_SEC)));
  return { ...frames[i].weights };
}

/** What the mouth should be doing at `t`: the expected vowel, fully. */
function referenceAt(probe: Probe | null, t: number): VisemeWeights {
  const w = { ...ZERO_VISEMES };
  if (!probe || probe.segments.length === 0) return w;
  // One vowel: hold it, so it can be compared at leisure while scrubbing.
  if (probe.segments.length === 1) {
    w[probe.segments[0].expect] = 1;
    return w;
  }
  for (const s of probe.segments) {
    const into = Math.min(t - (s.start - REF_RAMP_SEC), s.end + REF_RAMP_SEC - t);
    if (into > 0) w[s.expect] = Math.max(w[s.expect], Math.min(1, into / REF_RAMP_SEC));
  }
  return w;
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      title={`${label}: ${ok ? "pass" : "fail"}`}
      style={{ color: ok ? PASS : FAIL, fontSize: 11, marginLeft: 4 }}
    >
      {label[0]}
      {ok ? "✓" : "✗"}
    </span>
  );
}

/**
 * Mouth outline for one articulation pose, after the reference client in
 * pipecat-visemes (client/src/components/Mouth.tsx): openness sets the
 * vertical aperture, width spreads the corners, rounding puckers (narrower,
 * taller, rounder).
 */
function mouthGeometry(openness: number, width: number, rounding: number) {
  const cx = 200;
  const cy = 130;
  const halfW = (44 + 62 * width) * (1 - 0.42 * rounding);
  const h = (6 + 118 * openness) * (1 + 0.32 * rounding);
  const yCorner = cy - Math.max(0, width - 0.4) * 14;
  const cxOff = halfW * 0.52;
  const yTop = cy - h * 0.54;
  const yBot = cy + h * 0.66;
  const [xL, xR] = [cx - halfW, cx + halfW];
  const f = (n: number) => n.toFixed(1);
  const path =
    `M ${f(xL)} ${f(yCorner)} ` +
    `C ${f(cx - cxOff)} ${f(yTop)}, ${f(cx + cxOff)} ${f(yTop)}, ${f(xR)} ${f(yCorner)} ` +
    `C ${f(cx + cxOff)} ${f(yBot)}, ${f(cx - cxOff)} ${f(yBot)}, ${f(xL)} ${f(yCorner)} Z`;
  return { path, cx, cy, halfW, h, yTop };
}

function AnalyzerMouth({ frame, expect }: { frame: ReplayFrame | null; expect: Viseme | null }) {
  // Before any frame: the client's rest pose.
  const pose: Pick<ReplayFrame, "openness" | "width" | "rounding" | "events"> = frame ?? {
    openness: 0.15,
    width: 0.35,
    rounding: 0.1,
    events: [],
  };
  const g = mouthGeometry(pose.openness, pose.width, pose.rounding);
  const target = expect ? DEFAULT_ANCHORS[expect] : null;
  const t = target && mouthGeometry(target.openness, target.width, target.rounding);
  const shut = pose.events.some((e) => e === "closure" || e === "nasal");
  return (
    <div style={{ position: "relative", minHeight: 0, display: "grid", placeItems: "center" }}>
      <svg viewBox="0 0 400 260" style={{ width: "92%", maxHeight: "70%" }}>
        <defs>
          <clipPath id="analyzer-mouth">
            <path d={g.path} />
          </clipPath>
        </defs>
        <path d={g.path} fill="#4a1520" />
        <g clipPath="url(#analyzer-mouth)">
          {g.h > 26 && pose.rounding < 0.55 && (
            <rect x={g.cx - g.halfW * 0.78} y={g.yTop + 2} width={g.halfW * 1.56} height={Math.min(16, g.h * 0.3)} rx={3} fill="#f1efe8" opacity={0.9} />
          )}
          {g.h > 42 && <ellipse cx={g.cx} cy={g.cy + g.h * 0.34} rx={g.halfW * 0.58} ry={g.h * 0.26} fill="#c2566a" opacity={0.85} />}
        </g>
        <path
          d={g.path}
          fill="none"
          stroke="#e07a8a"
          strokeWidth={9.5 - 3 * pose.openness + 3 * pose.rounding}
          strokeLinejoin="round"
        />
        {/* On top, so a small target (a puckered /u/) is not hidden by the mouth. */}
        {t && <path d={t.path} fill="none" stroke="#60a5fa" strokeWidth={2.5} strokeDasharray="7 5" />}
      </svg>
      <div style={{ position: "absolute", bottom: 10, left: 0, right: 0, textAlign: "center", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
        open {pose.openness.toFixed(2)} · width {pose.width.toFixed(2)} · round {pose.rounding.toFixed(2)}
        {shut && (
          <span style={{ marginLeft: 8, padding: "1px 6px", borderRadius: 4, background: "#7c2d12", color: "#fed7aa" }}>
            {pose.events.includes("nasal") ? "NASAL" : "CLOSURE"}: VRM lips shut
          </span>
        )}
        {t && <div style={{ opacity: 0.6, marginTop: 2 }}>dashed: {expect} target pose</div>}
      </div>
    </div>
  );
}

function Bars({ weights, highlight }: { weights: VisemeWeights; highlight: Viseme | null }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", height: 50 }}>
      {VISEMES.map((v) => {
        const w = weights[v];
        return (
          <div key={v} style={{ textAlign: "center", width: 46 }}>
            <div style={{ height: 30, display: "flex", alignItems: "flex-end" }}>
              <div
                style={{
                  width: "100%",
                  height: `${Math.round(Math.min(1, w) * 100)}%`,
                  background: v === highlight ? "#3b82f6" : "#4b5563",
                  borderRadius: "3px 3px 0 0",
                }}
              />
            </div>
            <div style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>
              {v} {w.toFixed(2)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [scored, setScored] = useState<Scored[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [rate, setRate] = useState<(typeof RATES)[number]>(0.5);
  const [loop, setLoop] = useState(true);
  const [light, setLight] = useState(DEFAULT_LIGHT);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);

  const timeRef = useRef(0);
  const currentRef = useRef<Scored | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch(FIXTURE_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${FIXTURE_URL}: ${r.status}`);
        return r.json() as Promise<ProbeFixture>;
      })
      .then((fixture) =>
        setScored(
          fixture.probes.map((probe) => {
            const buffered = withBuffer(probe);
            return { ...scoreView(probe), buffered: buffered && scoreView(buffered) };
          }),
        ),
      )
      .catch((e: Error) => setError(e.message));
  }, []);

  const current = scored?.[selected] ?? null;
  currentRef.current = current;

  // Both avatars read the shared playhead, so they cannot drift apart.
  const [pipelineSource] = useState<LipsyncSource>(() => ({
    sampleVisemes: () => frameAt(currentRef.current?.frames ?? [], timeRef.current),
  }));
  const [bufferedSource] = useState<LipsyncSource>(() => ({
    sampleVisemes: () => frameAt(currentRef.current?.buffered?.frames ?? [], timeRef.current),
  }));
  const [referenceSource] = useState<LipsyncSource>(() => ({
    sampleVisemes: () => referenceAt(currentRef.current?.probe ?? null, timeRef.current),
  }));

  // One audio element per probe; the playhead follows its clock.
  useEffect(() => {
    if (!current) return;
    const audio = new Audio(`/vowel-probe/${current.probe.audio}`);
    audioRef.current = audio;
    timeRef.current = 0;
    setT(0);
    return () => {
      audio.pause();
      audioRef.current = null;
      setPlaying(false);
    };
  }, [current]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, current]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let restart = 0;
    const onEnded = () => {
      if (!loop) return setPlaying(false);
      restart = window.setTimeout(() => {
        audio.currentTime = 0;
        void audio.play();
      }, 500);
    };
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("ended", onEnded);
      clearTimeout(restart);
    };
  }, [loop, current]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        timeRef.current = audio.currentTime;
        setT(audio.currentTime);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const play = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (audio.ended || audio.currentTime >= audio.duration - 0.01) audio.currentTime = 0;
      audio.playbackRate = rate;
      void audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const scrub = (value: number) => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = value;
    }
    setPlaying(false);
    timeRef.current = value;
    setT(value);
  };

  const shown = useMemo(() => frameAt(current?.frames ?? [], t), [current, t]);
  const rawFrame = useMemo(() => {
    const frames = current?.frames ?? [];
    if (frames.length === 0) return null;
    return frames[Math.min(frames.length - 1, Math.max(0, Math.round(t / FRAME_SEC)))];
  }, [current, t]);
  const activeSegment =
    current?.probe.segments.find((s) => t >= s.start - REF_RAMP_SEC && t <= s.end + REF_RAMP_SEC) ??
    (current?.probe.segments.length === 1 ? current.probe.segments[0] : null);

  if (error) return <div style={{ padding: 20, color: FAIL }}>Could not load fixtures: {error}</div>;

  const passed = scored?.flatMap((s) => s.scores).filter((s) => s.avatarOk).length ?? 0;
  const total = scored?.flatMap((s) => s.scores).length ?? 0;
  const bufferedScores = scored?.flatMap((s) => s.buffered?.scores ?? []) ?? [];
  const bufferedPassed = bufferedScores.filter((s) => s.avatarOk).length;
  const bufferedFrame =
    current?.buffered?.frames[
      Math.min(current.buffered.frames.length - 1, Math.max(0, Math.round(t / FRAME_SEC)))
    ] ?? null;

  return (
    <>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #2a2e35", display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <strong>Vowel probe</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {scored
              ? `${passed}/${total} vowels render correctly` +
                (bufferedScores.length ? `, ${bufferedPassed}/${bufferedScores.length} with the correction buffer` : "")
              : "replaying fixtures…"}{" "}
            · A = analyzer sent the right pose, V = avatar visibly shows it, B = live bot (with the correction
            buffer) visibly shows it
          </span>
        </div>
        {GROUPS.map((group) => {
          const members = scored?.map((s, i) => ({ s, i })).filter(({ s }) => group.has(s.probe)) ?? [];
          if (members.length === 0) return null;
          return (
            <div key={group.label} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, opacity: 0.6, width: 92 }} title={group.title}>
                {group.label}
              </span>
              {members.map(({ s, i }) => (
                <button
                  key={s.probe.id}
                  title={s.probe.text}
                  style={i === selected ? btnPicked : btn}
                  onClick={() => setSelected(i)}
                >
                  {group.short(s.probe)}
                  {s.scores.map((sc, j) => (
                    <span key={j}>
                      <Badge ok={sc.analyzerOk} label="Analyzer" />
                      <Badge ok={sc.avatarOk} label="Visible" />
                      {s.buffered && <Badge ok={s.buffered.scores[j].avatarOk} label="Buffered" />}
                    </span>
                  ))}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", minHeight: 0 }}>
        {[
          {
            key: "reference",
            title: "Should show",
            sub: activeSegment ? `${activeSegment.expect} — ${SOUNDS[activeSegment.expect]}` : "rest",
            source: referenceSource as LipsyncSource | null,
          },
          {
            key: "analyzer",
            title: "Analyzer output (no VRM)",
            sub: "what the server sent, before mapping and smoothing",
            source: null,
          },
          {
            key: "pipeline",
            title: "Pipeline renders",
            sub: "TTS audio → analyzer → feed → mapper → smoother",
            source: pipelineSource as LipsyncSource | null,
          },
          {
            key: "buffered",
            title: "Live bot sends",
            sub: current?.buffered
              ? "same, after the correction buffer: word timings revise queued keyframes"
              : "no buffered view in this fixture (re-run capture.py)",
            source: current?.buffered ? (bufferedSource as LipsyncSource | null) : null,
            pose: bufferedFrame,
          },
        ].map((pane) => (
          <div key={pane.key} style={{ position: "relative", minHeight: 0, borderRight: "1px solid #2a2e35" }}>
            {pane.key === "buffered" && !pane.source ? null : pane.source ? (
              <VRMAvatar
                modelUrl={MODEL_URL}
                idleAnimationUrl="/idle_loop.vrma"
                source={pane.source}
                interactive
                lightIntensity={light}
                style={{ position: "absolute", inset: 0 }}
                fallback={
                  <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                    loading model…
                  </div>
                }
              />
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "grid" }}>
                <AnalyzerMouth frame={rawFrame} expect={activeSegment?.expect ?? null} />
              </div>
            )}
            <div style={{ position: "absolute", top: 8, left: 12, right: 12, pointerEvents: "none" }}>
              <div style={{ fontWeight: 600 }}>{pane.title}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{pane.sub}</div>
              {"pose" in pane && pane.pose && (
                <div style={{ fontSize: 12, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                  sent open {pane.pose.openness.toFixed(2)} · width {pane.pose.width.toFixed(2)} · round{" "}
                  {pane.pose.rounding.toFixed(2)}
                </div>
              )}
            </div>

          </div>
        ))}
      </div>

      <div style={{ padding: 12, borderTop: "1px solid #2a2e35", display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style={playing ? btnOn : btn} onClick={play} disabled={!current}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          {RATES.map((r) => (
            <button key={r} style={rate === r ? btnOn : btn} onClick={() => setRate(r)}>
              {r}×
            </button>
          ))}
          <label style={{ fontSize: 13, display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", marginLeft: 8 }}>
            light
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={light}
              onChange={(e) => setLight(Number(e.target.value))}
              style={{ width: 90 }}
            />
            <code style={{ fontSize: 12, opacity: 0.7 }}>{light.toFixed(2)}</code>
          </label>
          <code style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>
            {t.toFixed(3)}s / {current?.probe.duration.toFixed(2) ?? "–"}s
          </code>
          <span style={{ fontSize: 12, opacity: 0.5, marginLeft: "auto" }}>
            drag to orbit · scroll to zoom
          </span>
        </div>

        {current && (
          <div style={{ position: "relative" }}>
            {/* The scored stretch of each vowel, under the scrubber. */}
            {current.probe.segments.map((s, i) => (
              <div
                key={i}
                title={`${s.expect} scored here`}
                style={{
                  position: "absolute",
                  top: 2,
                  bottom: 2,
                  left: `${(s.start / current.probe.duration) * 100}%`,
                  width: `${((s.end - s.start) / current.probe.duration) * 100}%`,
                  background: current.scores[i].avatarOk ? "#22c55e44" : "#ef444444",
                  borderRadius: 3,
                  pointerEvents: "none",
                }}
              />
            ))}
            <input
              type="range"
              min={0}
              max={current.probe.duration}
              step={0.005}
              value={t}
              onChange={(e) => scrub(Number(e.target.value))}
              style={{ width: "100%", position: "relative" }}
            />
          </div>
        )}

        <div style={{ display: "flex", gap: 24, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Bars weights={shown} highlight={activeSegment?.expect ?? null} />
          <div style={{ fontSize: 12, lineHeight: 1.6, fontVariantNumeric: "tabular-nums", maxHeight: 84, overflowY: "auto" }}>
            {current?.probe.segments.map((s, i) => {
              const sc = current.scores[i];
              const bsc = current.buffered?.scores[i];
              const hz = (v: number | null) => (v === null ? "—" : Math.round(v));
              return (
                <div key={i} style={{ opacity: s === activeSegment ? 1 : 0.55 }}>
                  <span style={{ color: sc.avatarOk ? PASS : FAIL }}>
                    {s.expect} {SOUNDS[s.expect]}
                  </span>{" "}
                  · sent open {sc.pose.openness.toFixed(2)} width {sc.pose.width.toFixed(2)} round{" "}
                  {sc.pose.rounding.toFixed(2)} (≈{sc.sentAs}) · shown as {sc.shownAs}{" "}
                  {sc.shown[sc.shownAs].toFixed(2)}
                  {sc.events.length > 0 && <> · {sc.events.join(" ")}</>} · F1/F2 ours {hz(s.f1_hz)}/
                  {hz(s.f2_hz)} Praat {hz(s.praat_f1_hz)}/{hz(s.praat_f2_hz)} Hz
                  {bsc && (
                    <div>
                      <span style={{ color: bsc.avatarOk ? PASS : FAIL }}>with correction buffer</span> · sent
                      open {bsc.pose.openness.toFixed(2)} width {bsc.pose.width.toFixed(2)} round{" "}
                      {bsc.pose.rounding.toFixed(2)} (≈{bsc.sentAs}) · shown as {bsc.shownAs}{" "}
                      {bsc.shown[bsc.shownAs].toFixed(2)}
                    </div>
                  )}
                </div>
              );
            })}
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
