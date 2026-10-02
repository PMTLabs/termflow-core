import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../..');
function callers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/\.\s*(offerSessionHandoff|takeSessionHandoff)\s*(?:\?\.)?\s*\(|invoke(?:<[^>]+>)?\(\s*['"](offer_session_handoff|take_session_handoff)['"]/g)].map(hit => hit[1] ?? hit[2]);
}
function corpus(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith('__') ? [] : corpus(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [file] : [];
  });
}

test('native transfer plumbing adds no session offer callers and every broker invoke carries its caller page', () => {
  expect(callers('api.offerSessionHandoff?.(leaf, pc);')).toEqual(['offerSessionHandoff']);
  expect(callers("invoke('take_session_handoff', args);")).toEqual(['take_session_handoff']);
  expect(callers("invoke<boolean>('offer_session_handoff', args);")).toEqual(['offer_session_handoff']);
  expect(callers('// api.takeSessionHandoff(leaf);')).toEqual([]);
  const files = corpus(root);
  expect(files.length).toBeGreaterThan(250);
  for (const file of ['App.tsx', 'api/tauri-bridge.ts', 'api/browser-bridge.ts', 'services/TerminalService.ts', 'components/Panes/dnd/detach.ts']) {
    expect(files).toContain(path.join(root, file));
  }
  const hits = files.flatMap(file => {
    const calls = callers(fs.readFileSync(file, 'utf8'));
    return calls.length ? [[path.relative(root, file).replace(/\\/g, '/'), calls]] : [];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  expect(hits).toEqual([
    ['api/tauri-bridge.ts', ['offer_session_handoff', 'take_session_handoff']],
    ['services/TerminalService.ts', ['takeSessionHandoff', 'offerSessionHandoff']],
  ]);
  const service = fs.readFileSync(path.join(root, 'services/TerminalService.ts'), 'utf8');
  expect(service).toContain('isHostSessionContended(error) && !this.incarnations().enabled');
  expect(service).toContain('if (this.incarnations().enabled || this.incarnations().ended) return;');
  const bridge = fs.readFileSync(path.join(root, 'api/tauri-bridge.ts'), 'utf8');
  for (const command of ['create_detached_window', 'begin_global_pane_drag', 'claim_global_pane_drag', 'resolve_orphan_global_drag', 'cancel_global_pane_drag', 'resolve_tab_drop']) {
    expect(bridge).toMatch(new RegExp(`invoke\\('${command}', \\{[^}]*transferPageArgs\\(\\)`));
  }
  const app = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
  expect(app).toContain('acceptsTransferNotice(p).then');
  const drag = fs.readFileSync(path.join(root, 'components/Panes/dnd/PaneDragController.tsx'), 'utf8');
  expect(drag).toContain('acceptsTransferNotice(typeof notice');
  expect(drag).toContain('await waitDetachTransfer(token)');
});
