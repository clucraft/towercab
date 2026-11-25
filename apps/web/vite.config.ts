import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const server = process.env.TOWERCAB_SERVER ?? 'http://localhost:8790';
const cesiumBuild = 'node_modules/cesium/Build/Cesium';

/**
 * Removes Cesium's debug-only argument checks from production builds. They sit in every matrix and vector
 * function, and Cesium's own release build takes them out the same way; importing Cesium as ES modules brings
 * them back. Blank lines are left behind so that line numbers in source maps stay right.
 */
function stripCesiumDebugChecks(): Plugin {
  const block =
    /\/\/>>includeStart\(['"]debug['"], pragmas\.debug\)[\s\S]*?\/\/>>includeEnd\(['"]debug['"]\);?/g;
  return {
    name: 'towercab:strip-cesium-debug-checks',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@?cesium[\\/]/.test(id) || !code.includes('>>includeStart(')) return null;
      const stripped = code.replace(block, (text) => text.replace(/[^\n]/g, ''));
      if (/>>include(Start|End)\(/.test(stripped)) this.error(`Unmatched Cesium debug marker in ${id}`);
      return { code: stripped, map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    stripCesiumDebugChecks(),
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
