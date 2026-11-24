import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.TOWERCAB_SERVER ?? 'http://localhost:8790';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // In development the API and WebSocket live on the Node server; keep them same-origin through the proxy.
    proxy: {
      '/api': server,
      '/healthz': server,
      '/metrics': server,
      '/ws': { target: server, ws: true },
    },
  },
});
