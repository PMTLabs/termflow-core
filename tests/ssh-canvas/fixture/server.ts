import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const outdir = path.resolve('test-results/ssh-canvas-bundle');
await mkdir(outdir, { recursive: true });
const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, 'entry.tsx')],
  outdir,
  target: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'browser-only-native-bridge',
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)tauri-bridge$/ }, () => ({ path: 'bridge', namespace: 'fixture' }));
      build.onLoad({ filter: /^bridge$/, namespace: 'fixture' }, () => ({
        contents: 'export default {}; export const getWindowsBuildNumber = () => 0;',
      }));
    },
  }],
});
if (!bundle.success) throw new Error(bundle.logs.join('\n'));
const artifacts = new Map(bundle.outputs.map(output => ['/' + path.basename(output.path), output]));
const html = Bun.file(path.join(import.meta.dir, 'index.html'));
await Bun.write(path.join(outdir, 'index.html'), html);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const route = new URL(request.url).pathname;
    const file = route === '/' ? html : artifacts.get(route);
    return file ? new Response(file) : new Response('Not found', { status: 404 });
  },
});
console.log(server.url.href);
// EOF is sent only by the Playwright setup that owns this child.
for await (const _ of Bun.stdin.stream()) { /* wait for EOF */ }
await server.stop(true);
