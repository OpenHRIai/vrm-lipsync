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
      // Everything below must resolve to ONE copy.
      //
      // Loading the package from source means its imports resolve against
      // ../../../node_modules, while the app's resolve here. For plain
      // libraries that is merely wasteful; for anything carrying React
      // context it is fatal — two copies of client-react are two distinct
      // context objects, so useRTVIClientEvent subscribes to a context whose
      // provider lives in the other copy and silently never fires.
      //
      // Installing from npm makes this a non-issue: peer dependencies
      // dedupe to a single copy.
      react: r("./node_modules/react"),
      "react-dom": r("./node_modules/react-dom"),
      three: r("./node_modules/three"),
      "@pipecat-ai/client-js": r("./node_modules/@pipecat-ai/client-js"),
      "@pipecat-ai/client-react": r("./node_modules/@pipecat-ai/client-react"),
    },
  },
});
