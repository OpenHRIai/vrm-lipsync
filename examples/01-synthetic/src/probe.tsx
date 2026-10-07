import {
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
} from "../../../tools/vowel-probe/replay";

/**
 * Vowel probe: hear a real TTS vowel and see what the avatar does with it.
 *
 * Plays the fixtures from tools/vowel-probe/capture.py — the bot's own voice,
 * analyzed by the real server analyzer — beside a second avatar holding the
 * vowel that *should* be showing. The right-hand avatar is driven by the very
 * frames `npm run test:vowels` scores, so what you see is what the test
 * judged. Vowels last 100-200ms; slow it down and scrub to actually look.
 */

const MODEL_URL = "/RikiMinami.vrm";
const FIXTURE_URL = "/vowel-probe/probes.json";
const RATES = [1, 0.5, 0.25] as const;
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

interface Scored {
  probe: Probe;
  frames: ReplayFrame[];
  scores: SegmentScore[];
}

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
            const frames = replay(probe);
            return { probe, frames, scores: probe.segments.map((s) => score(probe, s, frames)) };
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
  const activeSegment =
    current?.probe.segments.find((s) => t >= s.start - REF_RAMP_SEC && t <= s.end + REF_RAMP_SEC) ??
    (current?.probe.segments.length === 1 ? current.probe.segments[0] : null);

  if (error) return <div style={{ padding: 20, color: FAIL }}>Could not load fixtures: {error}</div>;

  const passed = scored?.flatMap((s) => s.scores).filter((s) => s.avatarOk).length ?? 0;
  const total = scored?.flatMap((s) => s.scores).length ?? 0;

  return (
    <>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #2a2e35", display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <strong>Vowel probe</strong>
          <span style={{ opacity: 0.6, fontSize: 12 }}>
            {scored ? `${passed}/${total} vowels render correctly` : "replaying fixtures…"} · A = analyzer
            sent the right pose, V = avatar visibly shows it
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {scored?.map((s, i) => (
            <button key={s.probe.id} style={i === selected ? btnPicked : btn} onClick={() => setSelected(i)}>
              {s.probe.text}
              {s.scores.map((sc, j) => (
                <span key={j}>
                  <Badge ok={sc.analyzerOk} label="A" />
                  <Badge ok={sc.avatarOk} label="V" />
                </span>
              ))}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: 0 }}>
        {[
          {
            title: "Should show",
            sub: activeSegment ? `${activeSegment.expect} — ${SOUNDS[activeSegment.expect]}` : "rest",
            source: referenceSource,
          },
          {
            title: "Pipeline renders",
            sub: "TTS audio → analyzer → feed → mapper → smoother",
            source: pipelineSource,
          },
        ].map((pane) => (
          <div key={pane.title} style={{ position: "relative", minHeight: 0, borderRight: "1px solid #2a2e35" }}>
            <VRMAvatar
              modelUrl={MODEL_URL}
              idleAnimationUrl="/idle_loop.vrma"
              source={pane.source}
              interactive
              style={{ position: "absolute", inset: 0 }}
              fallback={
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
                  loading model…
                </div>
              }
            />
            <div style={{ position: "absolute", top: 8, left: 12, pointerEvents: "none" }}>
              <div style={{ fontWeight: 600 }}>{pane.title}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{pane.sub}</div>
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
          <div style={{ fontSize: 12, lineHeight: 1.6, fontVariantNumeric: "tabular-nums" }}>
            {current?.probe.segments.map((s, i) => {
              const sc = current.scores[i];
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
