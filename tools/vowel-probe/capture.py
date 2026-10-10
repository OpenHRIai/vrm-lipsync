"""Capture vowel-probe fixtures from the real TTS voice and the real analyzer.

Each probe is one short utterance whose vowel we know: a word on its own, the
same word inside a sentence, or a sequence of words. It is synthesized with
the bot's own TTS voice through the bot's output path, which records when
each audio chunk and word timestamp arrived, and analyzed two ways:

- `message`: the upstream `FormantLipsyncAnalyzer` fed the audio exactly as
  `LipsyncProcessor` ingests it, with nothing held back. Word timings that
  arrive after a vowel was analyzed are too late for it.
- `buffered`: the real `LipsyncProcessor` replaying the recorded arrivals in
  real time, then everything it delivered. Analyzed keyframes wait in its
  delivery queue until shortly before playout, and word timings that arrive
  meanwhile revise them (the "correction buffer") — what the live bot sends.

Both are packed with the relay's own wire encoder, so the client-side test
replays them without needing the bot, the keys, or the network.

Writes to assets/vowel-probe/:
  probes.json   both wire messages per probe, plus where its vowel nucleus sits
  audio/        every synthesized clip (warmup included): <key>.wav plus
                <key>.json with its text, the TTS word timings and the arrival
                timeline; the probes' audio also drives the visual check at
                examples/01-synthetic/probe.html

Run from the repo root (synthesis needs the bot's .env for CARTESIA_API_KEY):

  uv run --directory examples/02-pipecat-bot/server/vendor/server \
    python ../../../../../tools/vowel-probe/capture.py [--refresh]

To try another analyzer revision on the same audio, run it from that
checkout's server/ directory instead and pass --out to keep the committed
fixtures: `--out probes.next.json`, then `VOWEL_PROBES=probes.next.json npm
run test:vowels`. `--text-events` turns on the analyzer's opt-in
text-informed tier, fed the word timings recorded at synthesis exactly as
upstream's benchmark replays them. The bot runs with it on, so the committed
fixtures are captured with it too.

The audio is committed, so re-running only re-analyzes it and needs no API
key — that is the loop for testing an analyzer change (the buffered replay
runs in real time, about a minute). Changing a probe's text re-synthesizes
that probe, as does a clip recorded without its arrival timeline; --refresh
re-synthesizes everything. TTS is not deterministic, so either changes the
fixtures.
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

from benchmarks.common import chunks_16k_float32, make_tts  # noqa: E402
from benchmarks.record import Example, _run_examples, _Source, _strip_gaps  # noqa: E402
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
#
# Real dictionary words, not spellings like "Eeee." or "Oo.": the bot speaks
# words, and the analyzer's text tier only engages when every word of a
# sentence is in its pronouncing dictionary — one unknown word ("oo") leaves
# the whole sentence to the DSP alone. Each word carries one vowel after an
# /h/ (or before a light coda), with no lip-closing or nasal consonants to
# blur the mouth shape under test.
PROBES = [
    ("ih-he", "ih", "He."),
    ("ih-heed", "ih", "Heed."),
    ("aa-ha", "aa", "Ha."),
    ("aa-hot", "aa", "Hot."),
    ("ou-who", "ou", "Who."),
    ("ou-whod", "ou", "Who'd."),
    ("ee-heh", "ee", "Heh."),
    ("ee-head", "ee", "Head."),
    ("oh-hoe", "oh", "Hoe."),
    ("oh-hose", "oh", "Hose."),
]

# The same words inside a sentence, a few words in. A word's timestamp
# arrives after its audio, so a word that starts the utterance is analyzed
# before the analyzer knows it (with or without the correction buffer); later
# words are what the buffer can fix. The comma after the target makes the TTS
# pause there, so its vowel is the last of its stretch of speech: the TTS word
# timestamps are too loose (0.1-0.25 s early) to find it by time alone.
IN_SENTENCE = [
    (f"{probe_id}-mid", expect, f"Okay, now say {text.rstrip('.').lower()}, please.", text.rstrip("."))
    for probe_id, expect, text in PROBES
]

# The way a user actually asks for it: one utterance, five vowels in a row.
SEQUENCE = ("sequence", ["ih", "aa", "ou", "oh", "ee"], "He. Ha. Who. Hoe. Heh.")

# The bot's output sample rate; recordings are replayed at it bit-exact.
SAMPLE_RATE = 24000

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
    # When each audio chunk and text frame reached the lipsync processor
    # (benchmarks.record's arrival timeline), for the buffered replay.
    arrival: dict


def load_cached(key: str, text: str) -> Clip | None:
    wav, meta = AUDIO / f"{key}.wav", AUDIO / f"{key}.json"
    if not (wav.exists() and meta.exists()):
        return None
    cached = json.loads(meta.read_text())
    if cached.get("text") != text or "arrival" not in cached:
        return None
    with wave.open(str(wav), "rb") as w:
        pcm, rate = w.readframes(w.getnframes()), w.getframerate()
    return Clip(
        pcm=pcm,
        sample_rate=rate,
        text_timing=cached["text_timing"],
        sentence=SimpleNamespace(text=text),
        arrival=cached["arrival"],
    )


def text_timing(arrival: dict) -> dict:
    """The arrival timeline as `benchmarks.common.synthesize` reports text timing.

    Times relative to the first audio chunk's receipt (where the TTS starts
    its word clock), plus the audio received when each frame arrived.
    """
    rate, chunks = arrival["sample_rate"], arrival["chunks"]
    first = chunks[0][0]

    def received(t: float) -> float:
        return round(sum(size for at, size in chunks if at <= t) / 2 / rate, 6)

    def rows(entries):
        return [
            [text, None if pts is None else round(pts - first, 6), received(t)]
            for t, pts, text in entries
        ]

    return {
        "version": 1,
        "origin": "first-audio-receipt",
        "anchors": rows(arrival["anchors"]),
        "words": rows(arrival["words"]),
    }


async def synth_all(wanted: list[tuple[str, str]], refresh: bool) -> dict[str, Clip]:
    """Every clip, synthesizing the missing ones through the bot's output path.

    Missing clips are spoken in one session by the bot's TTS, through
    LipsyncProcessor and a real-time playout transport, so their arrival
    timelines are the live bot's.
    """
    clips = {key: clip for key, text in wanted if not refresh and (clip := load_cached(key, text))}
    missing = [(key, text) for key, text in wanted if key not in clips]
    if not missing:
        return clips
    print(f"synthesizing {len(missing)} clips through the bot's output path:")
    takes, _ = await _run_examples(
        [Example(key, text, [], "") for key, text in missing],
        _Source(tts=make_tts("cartesia", VOICE)),
        SAMPLE_RATE,
    )
    for take in takes:
        key, text, arrival = take.example.id, take.example.text, take.arrival
        size = sum(n for _, n in arrival["chunks"])
        pcm = _strip_gaps(take.pcm, arrival["gaps"], size)
        timing = text_timing(arrival)
        write_wav(AUDIO / f"{key}.wav", pcm, SAMPLE_RATE)
        (AUDIO / f"{key}.json").write_text(
            json.dumps({"text": text, "text_timing": timing, "arrival": arrival}, indent=1) + "\n"
        )
        clips[key] = Clip(
            pcm=pcm,
            sample_rate=SAMPLE_RATE,
            text_timing=timing,
            sentence=SimpleNamespace(text=text),
            arrival=arrival,
        )
    if failed := [key for key, _ in missing if key not in clips]:
        sys.exit(f"synthesis failed for: {', '.join(failed)}")
    return clips


async def buffered_messages(
    clips: dict[str, Clip], order: list[str], text_events: bool
) -> dict[str, list[dict]]:
    """What the live bot delivers for each clip, correction buffer included.

    Replays the recorded arrivals in real time through LipsyncProcessor, the
    output transport and the relay, in one session (so the analyzer warms up
    on the first clips as it does live), and keeps every lipsync message.
    """
    print("replaying through LipsyncProcessor (real time):")
    takes, _ = await _run_examples(
        [Example(key, clips[key].sentence.text, [], "") for key in order],
        _Source(
            arrivals={key: clips[key].arrival for key in order},
            pcm={key: clips[key].pcm for key in order},
        ),
        SAMPLE_RATE,
        text_events=text_events,
    )
    return {take.example.id: [m["data"] for m in take.messages] for take in takes}


def merged(message: dict, delivered: list[dict]) -> dict:
    """The delivered batches as one wire message, anchored like ``message``."""
    return {
        **message,
        "kf": sorted((row for data in delivered for row in data["kf"]), key=lambda r: r[0]),
        "ev": sorted((row for data in delivered for row in data["ev"]), key=lambda r: r[0]),
    }


def target_run(debug, clip: Clip, word: str, duration: float) -> tuple[int, int] | None:
    """The vowel stretch of ``word``, which ends a stretch of speech (IN_SENTENCE).

    A sentence spoken without pauses is one burst, so the per-burst vowel of
    `vowel_runs` would be the burst's loudest vowel, not this word's. The
    word's burst is the one overlapping its timed interval (to the next
    word's timestamp, the pause included) most; its vowel is that burst's last.
    """
    words = clip.text_timing["words"]
    norm = [w.strip(".,!?").lower() for w, _, _ in words]
    i = norm.index(word.lower())
    start = words[i][1]
    end = words[i + 1][1] if i + 1 < len(words) else duration
    rms = np.array([d.rms for d in debug])
    bursts = [
        (a, b)
        for a, b in runs_above(rms, GAP_FRACTION * rms.max(), MAX_BRIDGE_HOPS)
        if b - a >= MIN_BURST_HOPS
    ]
    if not bursts:
        return None
    a, b = max(
        bursts, key=lambda r: min(debug[r[1] - 1].offset, end) - max(debug[r[0]].offset, start)
    )
    burst = rms[a:b]
    s, e = runs_above(burst, VOWEL_FRACTION * burst.max(), 1)[-1]
    return a + s, a + e


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
    seq_id, seq_expect, seq_text = SEQUENCE
    warmups = [(f"warmup-{i}", text) for i, text in enumerate(WARMUP)]
    singles = [(probe_id, expect, text, None) for probe_id, expect, text in PROBES]
    targets = singles + IN_SENTENCE
    clips = await synth_all(
        warmups + [(probe_id, text) for probe_id, _, text, _ in targets] + [(seq_id, seq_text)],
        refresh,
    )

    kwargs = {"text_events_enabled": True} if text_events else {}
    analyzer = FormantLipsyncAnalyzer(collect_debug=True, **kwargs)
    await analyzer.start(SAMPLE_RATE)
    for key, _ in warmups:
        await analyze(analyzer, key, clips[key], text_events)

    probes = []
    for probe_id, expect, text, word in targets:
        clip = clips[probe_id]
        pcm, rate = clip.pcm, clip.sample_rate
        keyframes, events, debug = await analyze(analyzer, probe_id, clip, text_events)
        runs = vowel_runs(debug)
        if not runs:
            print(f"  ! {probe_id}: no speech found, skipped")
            continue
        duration = len(pcm) / 2 / rate
        run = (
            target_run(debug, clip, word, duration)
            if word
            else max(runs, key=lambda r: r[1] - r[0])
        )
        if run is None:
            print(f"  ! {probe_id}: {word!r} not found in its timed interval, skipped")
            continue
        probes.append(
            {
                "id": probe_id,
                "text": text,
                "audio": f"audio/{probe_id}.wav",
                "duration": round(duration, 3),
                "segments": [{"expect": expect, **nucleus(debug, run, praat_formants(pcm, rate))}],
                "message": wire(probe_id, keyframes, events, duration),
            }
        )

    clip = clips[seq_id]
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

    delivered = await buffered_messages(
        clips, [key for key, _ in warmups] + [p["id"] for p in probes], text_events
    )
    for probe in probes:
        if probe["id"] in delivered:
            probe["buffered"] = merged(probe["message"], delivered[probe["id"]])
        else:
            print(f"  ! {probe['id']}: buffered replay failed, no buffered view")

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
