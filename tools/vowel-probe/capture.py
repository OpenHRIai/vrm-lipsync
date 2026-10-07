"""Capture vowel-probe fixtures from the real TTS voice and the real analyzer.

Each probe is one short utterance whose vowel we know. It is synthesized with
the bot's own TTS voice, run through the upstream `FormantLipsyncAnalyzer`
exactly as `LipsyncProcessor` ingests audio, and packed with the relay's own
wire encoder. The result is what a browser would receive for that utterance,
so the client-side test replays it without needing the bot, the keys, or the
network.

Writes to assets/vowel-probe/:
  probes.json   one wire message per probe, plus where its vowel nucleus sits
  audio/        every synthesized clip (warmup included): <key>.wav plus
                <key>.json with its text and the TTS word timings; the
                probes' audio also drives the visual check at
                examples/01-synthetic/probe.html

Run from the repo root (synthesis needs the bot's .env for CARTESIA_API_KEY):

  uv run --directory examples/02-pipecat-bot/server/vendor/server \
    python ../../../../../tools/vowel-probe/capture.py [--refresh]

To try another analyzer revision on the same audio, run it from that
checkout's server/ directory instead and pass --out to keep the committed
fixtures: `--out probes.next.json`, then `VOWEL_PROBES=probes.next.json npm
run test:vowels`. `--text-events` turns on the analyzer's opt-in
text-informed tier, fed the word timings recorded at synthesis exactly as
upstream's benchmark replays them.

The audio is committed, so re-running only re-analyzes it and needs no API
key — that is the loop for testing an analyzer change. Changing a probe's text
re-synthesizes that probe; --refresh re-synthesizes everything. TTS is not
deterministic, so either changes the fixtures.
"""

import argparse
import asyncio
import inspect
import json
import os
import sys
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import parselmouth

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "assets/vowel-probe"
# The analyzer under test is whichever pipecat-visemes server/ directory this
# runs from (uv run --directory ...), so revisions can be compared on the
# same audio.
sys.path.insert(0, str(Path.cwd()))

from benchmarks.common import chunks_16k_float32, synthesize  # noqa: E402
from lipsync.base_lipsync_analyzer import LipsyncAnalysisContext  # noqa: E402
from lipsync.formant_lipsync_analyzer import FormantLipsyncAnalyzer  # noqa: E402
from lipsync.frames import TTSLipsyncFrame  # noqa: E402
from lipsync.rtvi import lipsync_message_data  # noqa: E402

try:
    from benchmarks.text_timing import FixtureTextInputs  # noqa: E402
except ImportError:  # analyzer revisions before the text-informed tier
    FixtureTextInputs = None

# The bot's default voice (bot.py), overridable the same way the bot is.
VOICE = os.getenv("CARTESIA_VOICE_ID", "71a7ad14-091c-4e8e-a314-022ece01c121")
# Praat's formant ceiling for this voice (benchmarks/corpus.yaml): 5000 Hz
# for a male voice, 5500 for a female one.
PRAAT_CEILING_HZ = 5000

# The analyzer adapts its formant ranges to the voice over ~1.2 s of speech,
# and in a live session it has heard the greeting long before anyone asks for
# vowels. Probing it cold would test warmup, not mapping.
WARMUP = [
    "Hi there! It's lovely to meet you. What would you like to talk about today?",
    "The birch canoe slid on the smooth planks. Glue the sheet to the dark blue background.",
]

# VRM preset names are not the vowels they sound like: `ih` is /i/ as in
# "see", `ee` is /e/ as in "bed". `expect` is always the VRM preset.
PROBES = [
    ("ih-isolated", "ih", "Eeee."),
    ("ih-heed", "ih", "Heed."),
    ("aa-isolated", "aa", "Ahhh."),
    ("aa-hot", "aa", "Hot."),
    ("ou-isolated", "ou", "Oooo."),
    ("ou-whod", "ou", "Who'd."),
    ("ee-isolated", "ee", "Ehh."),
    ("ee-head", "ee", "Head."),
    ("oh-isolated", "oh", "Ohhh."),
    ("oh-hoed", "oh", "Hoed."),
]

# The way a user actually asks for it: one utterance, five vowels in a row.
SEQUENCE = ("sequence", ["ih", "aa", "ou", "oh", "ee"], "Ee. Ah. Oo. Oh. Eh.")

HOP_SEC = 0.02
# Speech is split into bursts at gaps quieter than this fraction of the
# utterance's peak...
GAP_FRACTION = 0.1
# ...lasting longer than this; shorter dips (stops, closures) are bridged.
MAX_BRIDGE_HOPS = 3
MIN_BURST_HOPS = 4
# Within a burst, the vowel is the part at least this loud relative to the
# burst's own peak — vowels are the loudest part of speech, and later words
# in a sentence are often quieter than earlier ones.
VOWEL_FRACTION = 0.5


AUDIO = OUT / "audio"


class Clip(SimpleNamespace):
    """One synthesized utterance, shaped like the benchmark's own `Clip`."""

    pcm: bytes
    sample_rate: int
    text_timing: dict | None
    sentence: SimpleNamespace


async def synth_cached(key: str, text: str, refresh: bool) -> Clip:
    wav, meta = AUDIO / f"{key}.wav", AUDIO / f"{key}.json"
    cached = json.loads(meta.read_text()) if meta.exists() else {}
    if wav.exists() and cached.get("text") == text and not refresh:
        with wave.open(str(wav), "rb") as w:
            pcm, rate = w.readframes(w.getnframes()), w.getframerate()
        timing = cached.get("text_timing")
    else:
        print(f"  synthesizing {key}: {text!r}")
        pcm, rate, timing = await synthesize("cartesia", VOICE, text, with_text=True)
        write_wav(wav, pcm, rate)
        meta.write_text(json.dumps({"text": text, "text_timing": timing}, indent=1) + "\n")
    return Clip(
        pcm=pcm, sample_rate=rate, text_timing=timing, sentence=SimpleNamespace(text=text)
    )


def write_wav(path: Path, pcm: bytes, rate: int):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


async def analyze(
    analyzer: FormantLipsyncAnalyzer, ctx_id: str, clip: Clip, text_events: bool = False
):
    """One utterance through a long-lived analyzer, as LipsyncProcessor does."""
    first_debug = len(analyzer.debug_features)
    ctx = LipsyncAnalysisContext(context_id=ctx_id, sample_rate=clip.sample_rate)
    # The text tier sees words as they arrived during synthesis, not up front.
    inputs = FixtureTextInputs(clip, ctx) if text_events else None
    keyframes, events = [], []
    kwargs = {"on_ingest": inputs.ingest} if inputs else {}
    async for chunk in chunks_16k_float32(clip.pcm, clip.sample_rate, **kwargs):
        result = await analyzer.analyze(chunk, ctx)
        keyframes += result.keyframes
        events += result.events
    if inputs:
        inputs.ingest(len(clip.pcm) // 2, final=True)
    result = await analyzer.flush(ctx)
    keyframes += result.keyframes
    events += result.events
    # The processor resets per-utterance state between contexts; learned
    # per-voice ranges survive, exactly as in a live session.
    await analyzer.reset()
    return keyframes, events, analyzer.debug_features[first_debug:]


def runs_above(rms: np.ndarray, threshold: float, bridge: int) -> list[tuple[int, int]]:
    """[start, end) index runs where rms >= threshold, bridging short dips."""
    runs, start, gap = [], None, 0
    for i, v in enumerate(rms >= threshold):
        if v:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap > bridge:
                runs.append((start, i - gap + 1))
                start, gap = None, 0
    if start is not None:
        runs.append((start, len(rms) - gap))
    return runs


def vowel_runs(debug) -> list[tuple[int, int]]:
    """One vowel stretch per burst of speech, as [start, end) hop indices.

    Found by energy rather than by the analyzer's own voicing decision: that
    decision is part of what is under test, and it flickers on exactly the
    vowels that go wrong.
    """
    rms = np.array([d.rms for d in debug])
    out = []
    for a, b in runs_above(rms, GAP_FRACTION * rms.max(), MAX_BRIDGE_HOPS):
        if b - a < MIN_BURST_HOPS:
            continue
        burst = rms[a:b]
        vowel = runs_above(burst, VOWEL_FRACTION * burst.max(), 1)
        s, e = max(vowel, key=lambda r: r[1] - r[0])
        out.append((a + s, a + e))
    return out


def praat_formants(pcm: bytes, rate: int) -> parselmouth.Formant:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768.0
    sound = parselmouth.Sound(samples, sampling_frequency=rate)
    return sound.to_formant_burg(
        time_step=0.01, max_number_of_formants=5, maximum_formant=PRAAT_CEILING_HZ
    )


def nucleus(debug, run: tuple[int, int], praat: parselmouth.Formant) -> dict:
    """The steady middle of a vowel, where its target is held.

    Onsets carry the consonant's transition and the tail carries the release,
    so the outer quarter at each end is not scored.
    """
    a, b = run
    n = b - a
    s, e = a + n // 4, max(b - n // 4, a + n // 4 + 1)
    hops = debug[s:e]

    def found(values):
        values = [v for v in values if v > 0 and np.isfinite(v)]
        return round(float(np.median(values)), 1) if values else None

    times = [d.offset for d in hops]

    return {
        "start": round(hops[0].offset - HOP_SEC / 2, 3),
        "end": round(hops[-1].offset + HOP_SEC / 2, 3),
        # Raw analyzer measurements, so a failure can be traced to the DSP or
        # its normalization rather than guessed at from the mapped output.
        # null means the formant was not found on any hop.
        "f1_hz": found([d.f1 for d in hops]),
        "f2_hz": found([d.f2 for d in hops]),
        "f2_found": round(sum(d.f2 > 0 for d in hops) / len(hops), 2),
        "f1_range_hz": [round(hops[-1].f1_lo, 1), round(hops[-1].f1_hi, 1)],
        "f2_range_hz": [round(hops[-1].f2_lo, 1), round(hops[-1].f2_hi, 1)],
        "confidence": round(float(np.median([d.confidence for d in hops])), 3),
        # Praat's measurement of the same stretch: ground truth for whether
        # the TTS really said this vowel, independent of our analyzer.
        "praat_f1_hz": found([praat.get_value_at_time(1, t) for t in times]),
        "praat_f2_hz": found([praat.get_value_at_time(2, t) for t in times]),
    }


def wire(ctx_id: str, keyframes, events, duration: float) -> dict:
    frame = TTSLipsyncFrame(
        context_id=ctx_id,
        window_start=0.0,
        window_end=duration,
        keyframes=keyframes,
        events=events,
    )
    # Wire version 2 stamps the remaining lead at send time; replay anchors
    # on its own clock, so the send time is irrelevant here.
    if "now_ns" in inspect.signature(lipsync_message_data).parameters:
        return lipsync_message_data(frame, now_ns=0)
    return lipsync_message_data(frame)


async def main(refresh: bool, out: str, text_events: bool):
    OUT.mkdir(parents=True, exist_ok=True)
    if text_events and FixtureTextInputs is None:
        sys.exit("--text-events: this analyzer revision has no text-informed tier")
    kwargs = {"text_events_enabled": True} if text_events else {}
    analyzer = FormantLipsyncAnalyzer(collect_debug=True, **kwargs)
    await analyzer.start(24000)

    for i, text in enumerate(WARMUP):
        clip = await synth_cached(f"warmup-{i}", text, refresh)
        await analyze(analyzer, f"warmup-{i}", clip, text_events)

    probes = []
    for probe_id, expect, text in PROBES:
        clip = await synth_cached(probe_id, text, refresh)
        pcm, rate = clip.pcm, clip.sample_rate
        keyframes, events, debug = await analyze(analyzer, probe_id, clip, text_events)
        runs = vowel_runs(debug)
        if not runs:
            print(f"  ! {probe_id}: no speech found, skipped")
            continue
        longest = max(runs, key=lambda r: r[1] - r[0])
        duration = len(pcm) / 2 / rate
        probes.append(
            {
                "id": probe_id,
                "text": text,
                "audio": f"audio/{probe_id}.wav",
                "duration": round(duration, 3),
                "segments": [{"expect": expect, **nucleus(debug, longest, praat_formants(pcm, rate))}],
                "message": wire(probe_id, keyframes, events, duration),
            }
        )

    seq_id, seq_expect, seq_text = SEQUENCE
    clip = await synth_cached(seq_id, seq_text, refresh)
    pcm, rate = clip.pcm, clip.sample_rate
    keyframes, events, debug = await analyze(analyzer, seq_id, clip, text_events)
    runs = vowel_runs(debug)
    duration = len(pcm) / 2 / rate
    if len(runs) == len(seq_expect):
        praat = praat_formants(pcm, rate)
        segments = [{"expect": v, **nucleus(debug, r, praat)} for v, r in zip(seq_expect, runs)]
    else:
        # Can't attribute vowels to stretches; keep it for the visual check only.
        print(f"  ! sequence: {len(runs)} bursts for {len(seq_expect)} vowels, not scored")
        segments = []
    probes.append(
        {
            "id": seq_id,
            "text": seq_text,
            "audio": f"audio/{seq_id}.wav",
            "duration": round(duration, 3),
            "segments": segments,
            "message": wire(seq_id, keyframes, events, duration),
        }
    )

    (OUT / out).write_text(
        json.dumps({"voice": VOICE, "text_events": text_events, "probes": probes}, indent=1)
        + "\n"
    )
    print(f"wrote {len(probes)} probes to {OUT.relative_to(REPO)}")
    for p in probes:
        for s in p["segments"]:
            print(
                f"  {p['id']:<14} expect {s['expect']}  "
                f"ours F1 {s['f1_hz']} F2 {s['f2_hz']} (found {s['f2_found']:.0%})  "
                f"praat F1 {s['praat_f1_hz']} F2 {s['praat_f2_hz']}  "
                f"ranges F1 {s['f1_range_hz']} F2 {s['f2_range_hz']}"
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true", help="re-synthesize all audio")
    parser.add_argument("--out", default="probes.json", help="fixture file name in assets/vowel-probe")
    parser.add_argument(
        "--text-events", action="store_true", help="enable the analyzer's text-informed tier"
    )
    args = parser.parse_args()
    asyncio.run(main(args.refresh, args.out, args.text_events))
