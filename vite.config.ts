import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(() => {
  const key = process.env.FINSIGHT_ADMIN_TLS_KEY
  const cert = process.env.FINSIGHT_ADMIN_TLS_CERT
  return {
    plugins: [react()],
    server: {
      host: 'localhost',
      port: 18443,
      strictPort: true,
      https: key && cert ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined,
      proxy: {
        '/api/v1/admin': process.env.FINSIGHT_ADMIN_API_TARGET ?? 'http://127.0.0.1:8080',
      },
    },
  }
})
