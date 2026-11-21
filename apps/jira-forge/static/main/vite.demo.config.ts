import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the public demo (in-memory backend, sample data) into static/demo/dist for GitHub Pages.
 * Relative asset paths let it work under any Pages sub-path, e.g. /<repository>/.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../demo', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
