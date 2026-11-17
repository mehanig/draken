import { defineConfig } from '@playwright/test';

// Synthetic coverage, including an ephemeral backend with a fake native worker.
// Build the server first. All browser API requests are intercepted; no live Draken.
export default defineConfig({
  testDir: '.',
  testMatch: ['preparation-preview.spec.ts', 'independent-preview-review.spec.ts'],
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:41891', browserName: 'chromium' },
  outputDir: '/tmp/draken-082-preview-tests',
  webServer: {
    command: 'cd ../../client && npm exec vite -- --host 127.0.0.1 --port 41891 --strictPort',
    url: 'http://127.0.0.1:41891',
    reuseExistingServer: false,
  },
});
