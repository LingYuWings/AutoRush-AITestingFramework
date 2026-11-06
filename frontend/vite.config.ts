import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendPort = Number(process.env.AUTORUSH_BACKEND_PORT || 8000)

// Use relative asset URLs for the packaged console and proxy backend calls during development.
export default defineConfig({
  cacheDir: process.env.AUTORUSH_VITE_CACHE_DIR || undefined,
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: `http://127.0.0.1:${backendPort}`, ws: true },
      '/health': `http://127.0.0.1:${backendPort}`,
    },
  },
})
