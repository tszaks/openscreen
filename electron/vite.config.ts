import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  // The 3D phone's studio HDRI (phone3d/assets/*.hdr) is imported with ?inline into the lazily loaded engine chunk.
  assetsInclude: ['**/*.hdr'],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'node',
    // root above is src/renderer — tests live outside it
    include: ['../../test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
