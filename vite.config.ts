import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./apps/desktop/src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/desktop/src/renderer', import.meta.url)),
      '@shared-types': fileURLToPath(new URL('./packages/shared-types/src', import.meta.url)),
      '@openagent/shared-types': fileURLToPath(new URL('./packages/shared-types/src/index.ts', import.meta.url)),
      '@openagent/ui': fileURLToPath(new URL('./packages/ui/src', import.meta.url))
    }
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom)[\\/]/,
              priority: 30
            },
            {
              name: 'markdown-vendor',
              test: /node_modules[\\/](react-markdown|remark-gfm|unified|micromark|mdast-util-|hast-util-|remark-|rehype-)[\\/]/,
              priority: 20
            },
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](lucide-react|clsx|tailwind-merge)[\\/]/,
              priority: 10
            }
          ]
        }
      }
    }
  }
});
