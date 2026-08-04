import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, './package.json'), 'utf-8'),
) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5273,
    proxy: {
      // AgentCore backend (Fastify). Dev-only proxy; prod aponta via VITE_AGENTCORE_URL.
      '/api': {
        target: process.env.VITE_AGENTCORE_URL || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
