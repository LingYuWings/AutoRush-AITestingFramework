import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backendPort = Number(process.env.AUTORUSH_BACKEND_PORT || 8000)

export default defineConfig({
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
