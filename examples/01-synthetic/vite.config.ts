import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Serve the repo's assets/ (model + idle animation) as static files.
  publicDir: r("../../assets"),
  resolve: {
    alias: {
      // Point at source so the example exercises what you edit, not a stale build.
      "@openhri/vrm-lipsync": r("../../src/index.ts"),
      react: r("./node_modules/react"),
      "react-dom": r("./node_modules/react-dom"),
      three: r("./node_modules/three"),
    },
  },
});
