# Bot server

This example needs a Pipecat bot with the lipsync processor in its pipeline.
That server lives in the `pipecat-visemes` project and is **not vendored
here**. `setup.sh` clones [our fork](https://github.com/maxipesfix/pipecat-visemes)
of [upstream](https://github.com/jptaylor/pipecat-visemes): upstream plus
analyzer fixes measured with its seven-voice accuracy benchmark, and the
text-informed tier switched on in `bot.py`, which keeps close vowels such as
"ee" and "oo" from reading as nasal murmurs that shut the mouth.

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
