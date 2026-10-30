import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:41889',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
  },
  outputDir: '.test-artifacts/playwright',
  webServer: {
    command: 'node tests/ui/server.cjs',
    url: 'http://127.0.0.1:41889/api/auth/status',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
