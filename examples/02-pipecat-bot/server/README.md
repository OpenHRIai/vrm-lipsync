# Bot server

This example needs a Pipecat bot with the lipsync processor in its pipeline.
That server lives in the [`pipecat-visemes`](https://github.com/jptaylor/pipecat-visemes)
project and is **not vendored here** — run it from upstream so you always get
the analyzer the wire format was designed around.

```bash
./setup.sh        # clones pipecat-visemes into ./vendor and installs it
cd vendor/server
cp .env.example .env    # add DEEPGRAM_API_KEY, OPENAI_API_KEY, CARTESIA_API_KEY
uv run bot.py
```

The bot listens on <http://localhost:7860>, and the client connects to its
SmallWebRTC endpoint at `/api/offer`.

## What makes it emit lipsync

Two processors, either side of the output transport
(see `bot.py` in that repo):

```python
pipeline = Pipeline([
    transport.input(),
    # ... stt, llm, tts ...
    lipsync,              # LipsyncProcessor: analyses TTS audio, emits
    transport.output(),   #   playout-timed articulation keyframes
    lipsync_relay,        # LipsyncMessageRelay: ships them as an RTVI
])                        #   server-message, type "bot-tts-lipsync"
```

The processor sits *before* `transport.output()` so its batches ride the
output transport's clock queue and get discarded on interruption alongside the
audio they describe. The relay sits *after*, where every batch it sees is
already playout-timed.

Nothing in this client is coupled to that particular analyzer — see
"Driving the avatar from something else" in the root README.
