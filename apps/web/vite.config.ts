import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const serverTarget = process.env.RELAY_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@relay/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
      '/ws': { target: serverTarget, ws: true, changeOrigin: true },
    },
  },
});
