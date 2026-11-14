import { defineConfig } from '@playwright/test'

const baseURL = 'http://localhost:18444'
const productionBuild = process.env.FINSIGHT_PLAYWRIGHT_BUILD === '1'

export default defineConfig({
  testDir: './tests',
  use: { baseURL, channel: process.env.FINSIGHT_PLAYWRIGHT_CHANNEL },
  webServer: {
    command: productionBuild ? 'npm run preview -- --port 18444' : 'npm run dev -- --port 18444',
    url: baseURL,
  },
})
