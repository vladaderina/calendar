import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 0.0.0.0 — доступен из Windows-браузера через localhost
    port: 5173,
    strictPort: false,
  },
})
