import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

let devProxyServer = "http://localhost:8787";
if (process.env.DEV_PROXY_SERVER && process.env.DEV_PROXY_SERVER.length > 0) {
  console.log("Use devProxyServer from environment: ", process.env.DEV_PROXY_SERVER);
  devProxyServer = process.env.DEV_PROXY_SERVER;
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3001,
    proxy: {
      "^/api/v1/sse": {
        target: devProxyServer,
        xfwd: true,
        // SSE requires no response buffering and longer timeout.
        timeout: 0,
      },
      "^/api": {
        target: devProxyServer,
        xfwd: true,
      },
      "^/memos.api.v1": {
        target: devProxyServer,
        xfwd: true,
      },
      "^/file": {
        target: devProxyServer,
        xfwd: true,
      },
    },
  },
  resolve: {
    alias: {
      "@/": `${resolve(__dirname, "src")}/`,
      "@bufbuild/protobuf/codegenv2": resolve(__dirname, "src/shims/protobuf-codegenv2.ts"),
      "@bufbuild/protobuf/wkt": resolve(__dirname, "src/shims/protobuf-wkt.ts"),
      "@bufbuild/protobuf": resolve(__dirname, "src/shims/protobuf.ts"),
      "@connectrpc/connect-web": resolve(__dirname, "src/shims/connect-web.ts"),
      "@connectrpc/connect": resolve(__dirname, "src/shims/connect.ts"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "router-vendor": ["react-router-dom"],
          "utils-vendor": ["dayjs", "lodash-es"],
          "leaflet-vendor": ["leaflet", "react-leaflet"],
        },
      },
    },
  },
});
