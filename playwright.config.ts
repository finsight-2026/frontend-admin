import { defineConfig } from '@playwright/test'

const baseURL = 'http://localhost:18444'

export default defineConfig({
  testDir: './tests',
  use: { baseURL, channel: process.env.FINSIGHT_PLAYWRIGHT_CHANNEL },
  webServer: {
    command: 'npm run dev -- --port 18444',
    url: baseURL,
  },
})
