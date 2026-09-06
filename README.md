# @openhri/vrm-lipsync

A drop-in **VRM avatar** for [Pipecat](https://github.com/pipecat-ai/pipecat)
voice agents, with lipsync driven by the bot's own speech — not by its volume.

Companion to [`@pipecat-ai/voice-ui-kit`](https://github.com/pipecat-ai/voice-ui-kit);
composes with it, does not replace it.

## Why not volume-based lipsync

The usual approach reads the output audio's amplitude and opens one `aa`
blendshape by that much. The mouth flaps in time with the speech but makes the
same shape for every sound, and it hangs open through "hmm".

This package instead consumes the articulation stream from
[`pipecat-visemes`](https://github.com/maxipesfix/pipecat-visemes), a
server-side analyzer that runs formant DSP over the TTS audio and sends
playout-timed keyframes — `openness`, `width`, `rounding`, `energy`, `pitch`,
`confidence` — plus discrete `closure` / `nasal` / `silence` events. Those map
onto VRM's five vowel presets, so the avatar actually rounds its lips on /o/
and shuts them on /m/.

No audio analysis in the browser, and no dependency on provider viseme APIs.

## Install

```bash
npm i @openhri/vrm-lipsync three @pixiv/three-vrm @pixiv/three-vrm-animation
```

## Use

```tsx
import { PipecatClientProvider } from "@pipecat-ai/client-react";
import { VRMAvatar, useLipsyncFeed } from "@openhri/vrm-lipsync";

function Avatar() {
  // Subscribes to the bot's lipsync server-messages.
  const feed = useLipsyncFeed();

  return (
    <VRMAvatar
      modelUrl="/models/avatar.vrm"
      idleAnimationUrl="/animations/idle_loop.vrma"
      source={feed}
      style={{ height: 480 }}
    />
  );
}

// Must sit inside a PipecatClientProvider.
export default function App({ client }) {
  return (
    <PipecatClientProvider client={client}>
      <Avatar />
    </PipecatClientProvider>
  );
}
```

The server side needs `LipsyncProcessor` + `LipsyncMessageRelay` in the Pipecat
pipeline — see the `pipecat-visemes` README.

### Emotions

```tsx
const ref = useRef<VRMAvatarRef>(null);
ref.current?.setEmotion("happy", 0.3); // neutral | happy | angry | sad | relaxed
```

## Headless use

The transport, playback and mapping layers are importable on their own, with
**no React and no three.js**:

```ts
import { LipsyncFeed, parseLipsyncData, mapToVisemes } from "@openhri/vrm-lipsync/lipsync";

const feed = new LipsyncFeed();
client.on("serverMessage", (data) => {
  const batch = parseLipsyncData(data);
  if (batch) feed.ingest(batch);
});

// Then, per rendered frame:
const now = feed.now();
const weights = mapToVisemes(feed.sample(now), feed.activeEventKinds(now));
// -> { aa, ih, ou, ee, oh }
```

Use this to drive a 2D mouth, a different avatar system, or an engine bridge.

## Driving the avatar from something else

The renderer's whole contract is one method — give it vowel weights per frame
and it does not care where they came from. So the avatar is not tied to the
`pipecat-visemes` wire format or its articulation model:

```ts
import type { LipsyncSource } from "@openhri/vrm-lipsync";

const azureVisemes: LipsyncSource = {
  sampleVisemes: (nowMs, deltaSec) => ({ aa: 0, ih: 0.8, ou: 0, ee: 0, oh: 0 }),
};

<VRMAvatar modelUrl="/avatar.vrm" source={azureVisemes} />;
```

Passing a `LipsyncFeed` simply wraps it in the built-in `ArticulationSource`,
which owns the mapping and smoothing. Swapping to a different analyzer tier,
provider viseme events, or a volume fallback means implementing this one
method — the VRM layer is unchanged.

## How the mapping works

VRM offers five vowel blendshapes; the server sends continuous parameters. The
mapper treats the five presets as anchor points in (openness, width, rounding)
space and expresses any incoming pose as an inverse-distance blend of them, so
the signal stays smooth instead of snapping between discrete mouth shapes.

| preset | vowel | openness | width | rounding |
| ------ | ----- | -------- | ----- | -------- |
| `aa`   | /a/   | 0.95     | 0.50  | 0.05     |
| `ih`   | /i/   | 0.22     | 0.85  | 0.05     |
| `ou`   | /u/   | 0.25     | 0.15  | 0.95     |
| `ee`   | /e/   | 0.50     | 0.90  | 0.05     |
| `oh`   | /o/   | 0.75     | 0.25  | 0.75     |

Three things ride on top:

- **Events override the vowels.** A `closure` (M/B/P) or `nasal` (m/n) shuts
  the lips regardless of the vowel tract, and closes them faster than an
  ordinary release. This is what stops the avatar humming with its mouth open.
- **Confidence gates commitment.** Low-confidence frames pull toward a less
  articulated mouth rather than confidently rendering a guess.
- **Distance from rest sets the strength.** Blend weights are normalised, so a
  separate term is what actually returns the face to rest. It is deliberately
  *not* jaw opening: /i/ and /u/ are close vowels shaped by the lips with the
  jaw nearly shut, and scaling them by openness renders them invisible. The
  strength is how far the pose sits from the analyzer's rest pose across all
  three axes, so a tightly rounded /u/ reads as strongly articulated while
  genuine silence closes the mouth.

Anchors and smoothing are per-model tunable — what "fully open" means differs
between rigs:

```tsx
<VRMAvatar
  mapperConfig={{ sharpness: 3, gain: 0.85 }}
  smoothingConfig={{ attack: 0.03, release: 0.08 }}
/>
```

## Sync and the scheduling lead

The server releases each batch a fixed time *ahead* of the matching audio
(`scheduling_lead_ms`, 200 ms by default), and the client uses that to work out
where the utterance's t=0 sits on the wall clock. Get it wrong and the mouth is
consistently early or late.

The lead belongs to the server, so the right place for it is the wire: if a
batch carries a `lead` field (in seconds) it is used directly, per batch, and
nothing needs configuring. Otherwise the client assumes 200 ms — override that
only if your server tunes `scheduling_lead_ms` and does not report it:

```tsx
const feed = useLipsyncFeed({ schedulingLeadSec: 0.35 });
```

`offsetTrimMs` is a separate knob: the lead is a fact about the server, the
trim is a human nudge for jitter-buffer skew and taste.

## Compressed models

Optimized VRMs — RapidPipeline, gltfpack, gltf-transform — usually require
`KHR_draco_mesh_compression` for geometry and `KHR_texture_basisu` (KTX2) for
textures. Both are handled automatically; three fetches the decoders at
runtime from public CDNs.

If your CSP blocks those, or you need offline loads, self-host the decoders and
point at them:

```tsx
<VRMAvatar
  dracoDecoderPath="/decoders/draco/"
  ktx2TranscoderPath="/decoders/basis/"
/>
```

Compression is worth it: the bundled demo avatar is 6.5 MB rather than 14 MB,
with all 399 morph targets and every vowel blendshape intact.

## Animations

Uses [VRM Animation](https://vrm.dev/en/vrma/) (`.vrma`), which stores humanoid
bone rotations rather than a specific skeleton — one file drives any VRM, with
no retargeting. `assets/idle_loop.vrma` is bundled from pixiv's ChatVRM (MIT).

pixiv's free [VRMA_MotionPack](https://vroid.booth.pm/items/5512385) has seven
more (greeting, peace sign, spin…). It is not redistributed here — download it
and accept pixiv's terms yourself.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

### Examples

Two, in [`examples/`](./examples):

```bash
npm --prefix examples/01-synthetic install
npm --prefix examples/01-synthetic run dev
```

**[`01-synthetic`](./examples/01-synthetic)** needs no server, no API keys and
no audio — it fabricates the batches a server would send. Drag to orbit, scroll
to zoom; "Speak" cycles the five vowels with a consonant closure between words,
and the Hold buttons pin one vowel so its mouth shape can be inspected against
your own model. Live viseme weights are shown as bars. This is the one for
tuning `mapperConfig`.

**[`02-pipecat-bot`](./examples/02-pipecat-bot)** runs a real Pipecat bot and
drives the avatar from its lipsync stream inside a voice-ui-kit UI. Slower to
set up — it needs API keys — but it is the only way to judge sync against
speech you can actually hear.

## Licence

MIT — see [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
