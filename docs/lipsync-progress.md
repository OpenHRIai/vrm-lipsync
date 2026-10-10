# Lipsync progress: vowel shapes, sync and the live bot

October 2026. This covers work in two repositories:

- **[OpenHRIai/vrm-lipsync](https://github.com/OpenHRIai/vrm-lipsync)**: the client (VRM avatar, feed, mapper) and the examples.
- **[maxipesfix/pipecat-visemes](https://github.com/maxipesfix/pipecat-visemes)**: our fork of
  [jptaylor/pipecat-visemes](https://github.com/jptaylor/pipecat-visemes), the server-side analyzer that
  turns TTS audio into mouth parameters. The fork's `main` is upstream `9c85db4` plus 10 commits
  (`4524b59`), and `examples/02-pipecat-bot/server/setup.sh` now clones it. Its own write-up is
  `plans/vowel-rounding-results.md` there.

No upstream PRs have been opened.

## The problem

When the bot was asked to say the VRM vowels ("ee, ah, oo, oh, eh"), it pronounced them, but the
avatar's mouth didn't match. Three things were wrong, in different places:

1. **"ee" rendered as a closed "oo", with the mouth fluttering.** The analyzer never found F2 for
   this voice's /i/ (F2 ≈ 3000 Hz, above its 2600 Hz search band). It treated the missing F2 as
   evidence of a nasal murmur and kept shutting the lips.
2. **"oo" and "oh" rendered as spread lips (`ih`/`ee`).** This Cartesia voice says /u o/ with
   F2 ≈ 1600–2100 Hz, as far forward as /i e/. The analyzer measures that correctly (it agrees with
   Praat), but it derives lip rounding from F2 alone, so these vowels look spread. Sound alone
   can't fix this; the words can.
3. **The text that could fix it was almost never used live.** Word timestamps arrive after the
   audio is analyzed, and every multi-sentence bot turn was rejected outright by the text tier.

## Headline results

| What | Unit · better is | Before | After |
|---|---|---|---|
| "two" in a live-style counting turn: lip width / rounding | mouth parameters, 0–1 (width 1 = spread, rounding 1 = fully rounded) · "oo" wants **low width, high rounding** | 0.87 / 0.01 (spread) | **0.25 / 0.70 (rounded)** |
| False nasal events in that counting turn | count of events, each shutting the lips ≥ 50 ms · **lower** | 2 | **0** |
| Rounded vs spread separation as delivered to the client, streamed turns¹ | AUC: chance a rounded-vowel moment shows more rounding than a spread-vowel moment; 0.5 = none, 1 = perfect · **higher** | 0.66 | **0.78** |
| Rounding on "oo" words, as delivered¹ | mean rounding, 0–1 (the text hint targets ≥ 0.7) · **higher** | 0.26 | **0.54** |
| "ee" vowel moments latched as nasal, bot voice² | % of 20 ms analysis steps with lips forced shut · **lower** | 19% | **1%** |
| "oo" vowel moments latched as nasal, bot voice² | % of 20 ms steps · **lower** | 51% | **33%** |
| Real hums detected, range across 7 voices² | % of 20 ms steps in "Hmm" clips with the nasal flag on · **higher** | 0–76% | **74–98%** |
| Upstream accuracy composite, 7 voices (text tier on)³ | upstream's weighted score, 0–100 (formant error, track correlation, event checks) · **higher** | 84.4 | **84.7** |
| Upstream nasal checks / closure checks³ | per-clip expectations passed / total · **higher** | 100/112, 55/56 (sound only) | **111/112, 54/56** |
| "two" after a long comma pause ("Of course! One, two, three.")⁴ | width / rounding, as above | 1.00 / 0.00 (spread) | **0.25 / 0.70 (rounded)** |
| Vowel probe test, original fixtures (`npm run test:vowels`) | checks passed / 30 (15 vowels × analyzer pose + avatar shape) · **higher** | 7/30 | **12/30** |
| Vowel probe, avatar visibly shows the right vowel⁵ | vowels / 25 (single words, the same words mid-sentence, a 5-word sequence) · **higher** | 7/25 (analyzer fed the audio directly) | **14/25 (as the live bot delivers, with the correction buffer)** |

¹ Eval recording replayed in real time through the bot's output path (19 utterances, bot voice).
"Before" is the text tier as shipped with only 8 of 19 utterances split into sentences. In live use
nearly every turn is multi-sentence, so the live "before" was closer to sound alone (0.58).
² Seven Cartesia voices, single-vowel dictionary words.
³ Upstream's accuracy benchmark on our fixtures (7 voices × 13 sentences × 2 takes = 182 clips).
⁴ Headless repro: real Cartesia TTS through the bot's output path, three streamed turns. See
"The comma-pause fix" below.
⁵ Re-recorded probe fixtures (October 9). Both columns are the same audio; see "Vowel probe, with
the correction buffer" below.
With the text tier off, analyzer output is **identical** to upstream on all 182 clips at every step.

## How it was measured

Every change was judged by measurement, not by eye, and two changes were rejected because of it.

- **Upstream's accuracy benchmark** (`benchmarks/accuracy.py`) on all seven Cartesia voices,
  compared to a run of unmodified upstream on the same audio. TTS isn't deterministic, so
  upstream's committed baseline (86.0) was scored on different audio. Our fixtures read 84.1 on
  the same upstream code.
- **New: a vowel-identity metric** in that benchmark, the AUC of rendered rounding (and width) on
  rounded vs spread dictionary vowels, per voice. The existing metrics couldn't see rounding at all.
- **Upstream's eval recorder** (`benchmarks/record.py`), which plays real TTS through the bot's
  actual output path in real time and logs when each batch reaches the client. Replays reuse the
  same audio and arrival timings. A copy with each utterance split into sentence anchors reproduces
  how the live bot delivers turns.
- **New: a client-side vowel probe** in vrm-lipsync. Real TTS vowels go through the real analyzer
  and the real client feed, mapper and smoother, and are scored at two layers: the pose the
  analyzer sent, and the shape the avatar showed.

## What was done on top of pipecat-visemes (fork commits)

| Commit | Change | Measured effect |
|---|---|---|
| `fa5fe13` | **Benchmark: vowel-identity metric** plus a "Joe rode the old boat…" corpus sentence (the corpus had almost no /o/) | Baseline: rounding AUC 0.72 pooled, **0.63 on the bot voice** (worst of 7); width AUC 0.72 |
| `0e21a32` | **F3 rounding cue, off by default** (upstream review item ROUND-1, kept as an experiment) | Rejected: rounding AUC 0.72 → 0.67 (`max`) / 0.68 (`mean`). It rounds /i e a/ even more than /u o/ |
| `cdfef1b` | **Nasal: a missing F2 no longer counts as nasal where trusted text covers the hop.** Hums come from the text instead. Without text, output is unchanged | Nasal checks 110 → 111/112. "ee" latched 19% → 1%, "oo" 51% → 33% (bot voice) |
| `8219e54` | **Bot: text-informed tier on** (`LipsyncParams(text_events_enabled=True)`) | Composite 84.1 → 84.4, nasal checks 100 → 110/112 |
| `bb745af` + `e7a2d6c` | **Word times anchored on the utterance's speech onset.** Cartesia word times landed ~0.1 s early, enough to put a word's mouth shape on the previous word | Composite 84.4 → 84.7, closure checks 53 → 54/56 |
| `e7a2d6c` | **Revise held keyframes when word timings arrive.** Shapes still in the delivery queue get the text tier's "oo/oh" rounding hint, placed on the word's loud core, with guard keyframes so it doesn't bleed into neighbors. No extra latency | Delivered rounding AUC 0.58 → 0.785; "oo" words 0.26 → 0.54 |
| `744640c` | **Streamed turns:** sentences are aligned by their first word's timestamp instead of being rejected. **Held events revised:** a nasal far from any m/n/ng, or a closure in a sentence with no b/p/m, is dropped before release | Streamed AUC 0.657 → 0.783 (= single-sentence 0.785). Closures 103 → 98 and nasals 44 → 27; every b/p/m closure and every hum kept |
| `20e74e2` | Eval corpus: a counting turn ("Sure! One, two, three. Four, five, six.") | "two": width 0.87 → 0.25, rounding 0.01 → 0.70, nasal events 2 → 0 |
| `3e81d9e` | **A word before a long pause keeps its timing.** A word's interval runs to the next word's timestamp, so a comma pause after "two," pushed it past 0.35 s per phone, and the whole word was dropped: no rounding hint. Phones are now capped at 0.35 s and the rest of the gap is left untimed | "two" in "Of course! One, two, three.": 1.00 / 0.00 → 0.25 / 0.70. Benchmark output identical on all 182 clips; streamed replay AUC unchanged |

The fork changes 13 files (+896/−45) in its commits. Analyzer tests went from 92 to 111 (one
regression test for the pause fix), all passing.

### The comma-pause fix

Live, "two" in "count one two three" rounded the first time and was spread ("ee"-like) on later
turns. It wasn't the turn number but the bot's wording, through the length of the pause after
"two,". Reproduced headlessly with real Cartesia audio:

| Turn | "two" → "three" | Per phone (T, UW) | "two" before the fix: width / rounding |
|---|---|---|---|
| "Sure! One, two, three." | 0.61 s | 0.30 s, kept | 0.25 / 0.70 |
| "Of course! One, two, three." | 0.86 s | 0.43 s, **dropped** | 1.00 / 0.00 |

The "good" turns sat just under the 0.35 s limit, which is why it looked random live. An
interruption between turns made no difference. After the fix all three turns render 0.25 / 0.70.
Neither eval recording has a pause long enough to trigger it, so the benchmarks don't move.

### Tried and rejected

| Experiment | Result |
|---|---|
| F3 rounding cue (`max` / `mean` with F2) | Rounding AUC −0.04 on 7 voices |
| Widen F2/F3 bands to 3200/4000 Hz (for /i/) | Composite **−2.8**, F2 error +21 Hz, width correlation −0.05 |
| 2–4 kHz energy as a murmur-vs-vowel cue | Doesn't transfer across voices; the bot voice's /u/ is darker than its own hums |
| Closure veto at phone level (held events) | Dropped real /m/ closures (7 → 4 on "Mama made more…"); replaced by a sentence-level veto |

## What was done in vrm-lipsync (client)

| Commit | Change |
|---|---|
| `a0338a8` | **Wire v2:** anchor on each batch's `ws`/`lead` (exact up to network transit) instead of an assumed 200 ms lead. **`feed.cut()` on bot-stopped-speaking** for barge-in. **Stall resume:** a mid-turn LLM pause no longer freezes the mouth for the rest of the turn (seen live). |
| `a72e1d2` | The mouth is **no longer scaled by analyzer confidence** (upstream: it tracks loudness, mean ~0.15). Opt back in with `minCommit < 1`. |
| `aca0500` | **Vowel probe test** (`npm run test:vowels`), fixtures in `assets/vowel-probe/`, capture tool `tools/vowel-probe/capture.py` (also scores candidate analyzers with `--out` / `VOWEL_PROBES`), and **`probe.html`**: the expected-vowel avatar beside the pipeline avatar, with slow motion and a scrubber. |
| `141702b` | Docs: v2 sync, barge-in cuts, confidence, the vowel check, and the corrected lookahead default (README said 20 ms; it's 0). |
| `ec17934` | Deterministic scheduling-lead tests (a rare 0.5 ms flake). **Also contains** the switch to the fork (`setup.sh`, server README, text-tier fixtures); its message doesn't say so. |
| `8089c8e` | Probes use **real words** ("He. Ha. Who. Hoe. Heh."), since spellings like "Oo." switch the text tier off for the whole sentence. 9/30 → 12/30; probe nasal events 4 → 0. |
| `b69d7f5` | **Connect button stays on screen** in windows under ~620 px tall. The avatar's `min-h-0` class didn't exist in voice-ui-kit's prebuilt CSS. |
| `1dbee6b` | **Analyzer-only mouth pane** on `probe.html`: the analyzer's openness/width/rounding drawn as a 2D mouth with the target pose dashed, to tell analyzer errors from VRM-layer errors. |
| `af8b6bf` | **Vowel probe: in-sentence words and the correction-buffer view.** `capture.py` now records every clip through the bot's output path (keeping when each audio chunk and word timestamp arrived), and replays it in real time through `LipsyncProcessor` to store what the live bot delivers (`buffered`) next to the direct analysis (`message`). Ten new probes put each word fourth in "Okay, now say ___, please." `probe.html` gets a fourth pane, "Live bot sends", and `npm run test:vowels` scores both views (100 checks). All probe audio was re-synthesized. |
| `7715004` | **`lightIntensity` prop on `VRMAvatar`** (default 1, the old look), adjustable without reloading the model. Toon-shaded skin washed out to near white at full light, hiding mouth shapes. `probe.html` uses 0.5 and has a light slider. |
| `af8b6bf` | `probe.html?probes=<file>` shows another capture, like the test's `VOWEL_PROBES`. |

Client tests: 31 → 37, all passing.

### Vowel probe over time (`npm run test:vowels`, 30 checks)

| State | Passed | Notes |
|---|---|---|
| Original analyzer, spelled vowels | 7 | Avatar showed 2/15 vowels correctly |
| Upstream pulled (same audio) | 12 | F1 tracking fixed upstream; /a/ now right |
| Fixtures re-synthesized | 9 | TTS variation; new baseline |
| + nasal fix, text tier (spellings) | 9 | Spellings aren't dictionary words, so the tier stays off |
| Real words | **12** | All /i/ and /a/ pass, no false nasals; /u o e/ still fail |
| Comma-pause fix, same audio | 12 | One keyframe changed (see "Still open": Hoe → Heh bleed) |

The table above is the old 15-vowel probe, which replayed the analyzer without the delivery queue.

### Vowel probe, with the correction buffer

Live, analyzed keyframes wait in the delivery queue until shortly before playout, and word timings
that arrive meanwhile revise them (the "correction buffer"). The probe now shows both:

- **direct**: the analyzer fed the audio as it arrives, with nothing held back. A word timing that
  arrives after its vowel was analyzed is too late for it.
- **with the buffer**: the real `LipsyncProcessor` replaying the recorded arrival timeline in real
  time. This is what a browser receives from the live bot.

Avatar visibly shows the right vowel (V), October 9 fixtures:

| Group | Direct | With the buffer |
|---|---|---|
| Word alone ("Who.") (10) | 3 | 5 |
| Mid-sentence ("Okay, now say who, please.") (10) | 2 | 5 |
| Sequence "He. Ha. Who. Hoe. Heh." (5) | 2 | 4 |
| **Total** | **7/25** | **14/25** |

- Fixed by the buffer: "Who" and "Hoe" in the sequence (rounding 0.07 → 0.70, `ih` → `ou`;
  `aa` → `oh`), "who'd" and "hoe" mid-sentence, "Who'd." and "Hose." alone.
- Mid-sentence "who" still fails, though the buffer does round it: the rounding starts at 1.27 s and
  the vowel runs 1.18–1.28 s. Cartesia stamped "who," late, and the onset shift moves it later
  still (see "Still open").
- "eh" words fail in both views: the TTS's own "eh" drifts toward "ee" or "ah".
- Re-synthesizing moved the direct baseline (TTS isn't deterministic): 3 of 10 single words now
  pass, against 4 before. The old fixtures are in git history.
- The comma after the target word is there so the TTS pauses after it: Cartesia's word timestamps
  were 0.1–0.25 s off, enough to score "now" instead of "who'd" when the sentence ran on.

## Still open

- **First word of each answer:** its timing arrives ~0.1 s after its batch is sent (0/27 in time),
  so it's never revised.
- **"oo/oh" from sound alone:** still unsolved for this voice. Everything above relies on the text.
  Next step: predict each vowel from the TTS input text as its loud burst begins (counting bursts
  against the dictionary's vowel sequence), instead of waiting for word timestamps.
- **"eh"** varies in the TTS itself, from near-"ee" to near-"ah".
- **Bleed across shared timestamps:** e.g. "help" before "you" still picks up rounding.
- **Word-timing alignment:** word times are shifted by one amount per utterance, to put the first
  word on its speech onset. Cartesia's error isn't constant, so later words can land late:
  mid-sentence "who" gets its rounding after its vowel, and in the probe sequence "Hoe"'s /o/ is
  placed up to 3.09 s, into "Heh" (both before and after the comma-pause fix).
- **A/V trim:** −50 ms (mouth earlier) looked best live on one setup. Worth measuring before
  changing the default.
- **Live demo lighting:** the bot client still renders at full light; only `probe.html` uses 0.5.
- **Delivered-AUC scorer:** the script behind the "as delivered" AUC figures isn't in the repo. A
  stand-in (RMS voicing instead of Praat) reads higher (0.84 vs 0.78) but ranks runs the same.
- **Spellings and digits** ("oo", "1, 2, 3") switch the text tier off for that sentence.
- **History labels:** `ec17934` (vrm-lipsync) and `bb745af` (fork) carry changes their messages
  don't fully describe; correcting that needs a force-push.
- **Upstream:** none of the fork's work has been offered to jptaylor/pipecat-visemes.

## Running it

| Demo | Command | URL |
|---|---|---|
| Live bot | `cd examples/02-pipecat-bot/server/vendor/server && uv run bot.py`, then `npm --prefix examples/02-pipecat-bot/client run dev` | http://localhost:5173 |
| Vowel probe | `npm --prefix examples/01-synthetic run dev -- --port 5174` | http://localhost:5174/probe.html (4 panes: should show, analyzer, direct render, live bot with buffer; light slider) |
| Re-capture probes | `uv run --directory examples/02-pipecat-bot/server/vendor/server python ../../../../../tools/vowel-probe/capture.py --text-events` (cached audio: no API calls, about a minute of real-time replay) | n/a |
| Vowel test | `npm run test:vowels` | n/a |
| Seven-voice benchmark | in the fork's `server/`: `uv run python -m benchmarks.accuracy --offline --text-events` | n/a |
| Real-time replay | in the fork's `server/`: `uv run python -m benchmarks.record --reanalyze --text-events` | n/a |
