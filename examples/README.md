# Examples

| | Needs a bot? | What it demonstrates |
| --- | --- | --- |
| [`01-synthetic`](./01-synthetic) | No | The mapper and renderer, driven by a fabricated articulation stream |
| [`02-pipecat-bot`](./02-pipecat-bot) | Yes | The real thing: a Pipecat bot's lipsync stream driving the avatar |

Start with **01** to tune mouth shapes against your own VRM — it needs no
server, no API keys and no audio. Its `/probe.html` page plays real TTS
vowels beside an avatar holding the vowel that should show, from the same
fixtures as `npm run test:vowels`. Use **02** to check sync against real speech,
which is the only way to judge lipsync honestly.

Both resolve `@openhri/vrm-lipsync` to `../../src` so they track local edits to
the package, and both serve the demo avatar out of the repo's `assets/`.
