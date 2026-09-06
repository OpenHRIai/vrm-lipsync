import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Headless layer: no React, no three.js. Importable on its own so a
    // non-VRM renderer (2D mouth, engine bridge) can consume the same stream.
    lipsync: "src/lipsync/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  clean: true,
  treeshake: true,
  sourcemap: true,
  outDir: "dist",
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "three",
    "@pixiv/three-vrm",
    "@pixiv/three-vrm-animation",
    "@pipecat-ai/client-js",
    "@pipecat-ai/client-react",
  ],
});
