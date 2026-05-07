import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@shared-types': fileURLToPath(new URL('./src/shared/types', import.meta.url))
    }
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true
  }
});
