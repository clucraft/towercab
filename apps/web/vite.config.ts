import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const server = process.env.TOWERCAB_SERVER ?? 'http://localhost:8790';
const cesiumBuild = 'node_modules/cesium/Build/Cesium';

export default defineConfig({
  plugins: [
    react(),
    // CesiumJS loads its web workers, imagery and widget assets at run time from CESIUM_BASE_URL
    // (set in src/cesiumBase.ts). Copy them next to the app under /cesium.
    viteStaticCopy({
      targets: ['Workers', 'Assets', 'Widgets', 'ThirdParty'].map((dir) => ({
        src: `${cesiumBuild}/${dir}`,
        dest: 'cesium',
        // Drop `node_modules/cesium/Build/Cesium` from the copied paths: /cesium/Workers/..., and so on.
        rename: { stripBase: 4 },
      })),
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Cesium is large and is loaded on demand, only by the 3D view.
    chunkSizeWarningLimit: 6000,
  },
  server: {
    port: 5173,
    // In development the API and WebSocket live on the Node server; keep them same-origin through the proxy.
    proxy: {
      '/api': server,
      '/healthz': server,
      '/metrics': server,
      '/proxy': server,
      '/admin/api': server,
      '/go2rtc': { target: server, ws: true },
      '/ws': { target: server, ws: true },
    },
  },
});
