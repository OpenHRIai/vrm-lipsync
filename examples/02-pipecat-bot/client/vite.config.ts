import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Serves the repo's demo avatar and idle animation.
  publicDir: r("../../../assets"),
  server: {
    proxy: {
      // The bot's SmallWebRTC signalling endpoint. Proxied so the browser
      // sees one origin and there is no CORS to configure.
      "/api": { target: "http://localhost:7860", changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      // Point at source so the example tracks local edits to the package.
      "@openhri/vrm-lipsync": r("../../../src/index.ts"),
      react: r("./node_modules/react"),
      "react-dom": r("./node_modules/react-dom"),
      three: r("./node_modules/three"),
    },
  },
});
