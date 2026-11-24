import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // The shared package ships TypeScript source, so it has to be compiled into the bundle.
  noExternal: ['@towercab/shared'],
});
