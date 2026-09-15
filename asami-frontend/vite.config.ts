import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      host: env.VITE_HOST || '127.0.0.1',
      proxy: {
        '/api': env.VITE_API_TARGET || 'http://localhost:3000',
        '/realtime': {
          target: env.VITE_WS_TARGET || 'ws://localhost:3000',
          ws: true,
        },
      },
    },
    build: {
      sourcemap: false,
      target: 'es2022',
    },
  }
})
