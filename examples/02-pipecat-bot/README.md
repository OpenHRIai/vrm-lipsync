# Pipecat bot + VRM avatar

The full path: a Pipecat bot analyses its own TTS audio and ships articulation
keyframes over RTVI; this client renders them on a VRM avatar, inside a
[voice-ui-kit](https://github.com/pipecat-ai/voice-ui-kit) UI.

Unlike [`01-synthetic`](../01-synthetic), this exercises the parts that only a
real bot can: the RTVI transport, `useLipsyncFeed`, per-utterance anchoring
against live audio, interruption handling — and, most importantly, whether the
mouth actually looks right against speech you can hear.

```
bot (7860) ──RTVI server-message──▶ useLipsyncFeed ──▶ LipsyncFeed
  "bot-tts-lipsync"                                        │
                                              ArticulationSource
                                                           │
                                                    VRMAvatar
```

## Run it

Two terminals. First the bot:

```bash
cd server
./setup.sh                       # clones + installs the upstream bot
cd vendor/server
cp .env.example .env             # DEEPGRAM_API_KEY, OPENAI_API_KEY, CARTESIA_API_KEY
uv run bot.py                    # http://localhost:7860
```

Then the client:

```bash
cd client
npm install
npm run dev                      # http://localhost:5173
```

Click **Connect** and talk to it. Vite proxies `/api` to the bot, so there is
no CORS to configure.

The client renders without the bot running — you get the avatar and a Connect
button that fails — which is useful for working on layout, but proves nothing
about sync.

## What to look for

- **Closures.** Watch the lips on /m/, /b/, /p/ and on "hmm". Shutting the
  mouth on these is the thing volume-driven lipsync cannot do.
- **Rounding.** /o/ and /u/ should visibly purse, not just open wider.
- **Interruptions.** Talk over the bot. Unplayed keyframes are dropped with
  the audio they describe, so the mouth should stop with the voice rather than
  finishing a sentence on its own.
- **Sync.** Drag the **A/V trim** slider while it talks. It writes straight to
  `feed.offsetTrimMs`, so it takes effect on the next rendered frame — no
  reconnect, which matters because the bot serves one conversation per start.
  Negative moves the mouth earlier. Find the value that looks right, then set
  it once via `useLipsyncFeed({ offsetTrimMs })`.

  If you land far from zero, that is worth knowing: a consistent offset points
  at the scheduling lead or a jitter buffer rather than the mapper — see "Sync
  and the scheduling lead" in the root README.

## Swapping the model

Drop a `.vrm` into the repo's `assets/` and point `modelUrl` at it in
`src/App.tsx`. Rigs differ in how strongly their vowel blendshapes read; if
yours looks over- or under-articulated, tune `mapperConfig` — the Hold buttons
in `01-synthetic` are the fastest way to do that.
