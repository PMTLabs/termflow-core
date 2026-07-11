import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, target: 'es2019',
  clean: true, sourcemap: true,
  external: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-unicode11', '@xterm/addon-webgl'],
});
