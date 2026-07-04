import { defineConfig } from '@playwright/test';

// Config for the assert pass over generated specs in tests/.
// No webServer: recorded specs carry absolute URLs (and storageState paths)
// for the app they were recorded against. For playground/demo flows, start
// the form server first: `node server.mjs` (serves ./public on :5188).
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    headless: process.env.HEADLESS !== '0',
    trace: 'on-first-retry',
  },
});
