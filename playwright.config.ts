import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * End-to-end smoke test. The built web app is served by `vite preview`; the REST API and the WebSocket feed
 * are mocked inside the tests, so no server and no network are needed.
 *
 *   pnpm build && pnpm test:e2e
 */
export default defineConfig({
  testDir: 'apps/web/e2e',
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // WebGL runs in software here; that is slow but enough to prove the scene starts and draws.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: `pnpm --filter @towercab/web exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
