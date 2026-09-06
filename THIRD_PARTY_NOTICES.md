# Third-party notices

This project is MIT licensed. It contains, or ships alongside, material from
the projects below. Their notices are reproduced here as required.

---

## pixiv ChatVRM — MIT

<https://github.com/pixiv/ChatVRM>

Portions of the expression system are derived from ChatVRM:

- `src/vrm/controllers/AutoBlink.ts`
- `src/vrm/controllers/AutoLookAt.ts`
- `src/vrm/controllers/ExpressionController.ts` (emotion cross-fade and the
  approach of damping mouth weights while an emotion is active; the vowel
  handling is new)

The bundled idle animation `assets/idle_loop.vrma` is taken unmodified from
ChatVRM's `public/` directory.

```
MIT License

Copyright (c) 2023 pixiv Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## pipecat-visemes — wire protocol and playback feed

<https://github.com/maxipesfix/pipecat-visemes>

`src/lipsync/protocol.ts` and `src/lipsync/feed.ts` are ported from the
reference client of the `pipecat-visemes` server, which defines the wire
format this package consumes.

---

## Avatar model

`assets/` does not include a VRM model. `RikiMinami.vrm`, used by the example
app, is © susuROBO — see the example app's README for its terms. Any VRM model
carries its own embedded licence metadata (`VRMC_vrm.meta` / `VRM.meta`);
check a model's terms before shipping it.

---

## Runtime dependencies

`@pixiv/three-vrm` and `@pixiv/three-vrm-animation` (MIT, © 2020 pixiv Inc.)
and `three` (MIT, © 2010 three.js authors) are peer dependencies and are not
redistributed here.
