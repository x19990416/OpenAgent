import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@shared-types': fileURLToPath(new URL('./src/shared/types', import.meta.url))
    }
  },
  build: {
    outDir: '../../dist/renderer',
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
