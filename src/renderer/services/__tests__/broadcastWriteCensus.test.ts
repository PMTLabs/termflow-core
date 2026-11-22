import fs from 'fs';
import path from 'path';

// Each production write path has an explicit policy. Counts force a new caller,
// even in a previously classified file, to be reviewed rather than grandfathered.
const policies: Record<string, { count: number; reason: string }> = {
  'api/browser-bridge.ts': { count: 2, reason: 'transport implementation and API execute command: not user input' },
  'api/tauri-bridge.ts': { count: 1, reason: 'transport implementation: engine owns classification' },
  'components/Terminal/MainBridge.ts': { count: 1, reason: 'engine transport: user/reply classification is above this layer' },
  'components/Panes/TerminalPane.tsx': { count: 1, reason: 'vestigial onData prop: TerminalDisplay never calls it' },
  'services/TerminalService.ts': { count: 2, reason: 'transport method and IPC forward: callers own classification' },
  'services/insertTextIntoTerminal.ts': { count: 1, reason: 'cache paste broadcasts; raw fallback is an unmounted source' },
  'services/inputBroadcast.ts': { count: 1, reason: 'broadcast target fallback: no source re-emission' },
  'services/InputHandler.ts': { count: 2, reason: 'clear-terminal explicitly fans out while active; single source while off' },
};
test('renderer write census classifies every writeToTerminal caller', () => {
  const root = path.join(__dirname, '../..'); const found: Record<string, number> = {};
  const wiring: Record<string, string[]> = { installInputBroadcast: [], setBroadcastSink: [], broadcastMenuItems: [] };
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('__') || entry.name === 'node_modules') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(file)) {
        const source = fs.readFileSync(file, 'utf8');
        const relative = path.relative(root, file).replace(/\\/g, '/');
        const count = [...source.matchAll(/\bwriteToTerminal\s*(?:\(|:\s*async\s*\()/g)].length;
        if (count) found[relative] = count;
        // A commented-out call is not wiring. Stripping `//` to end of line can only drop
        // a real call that shares a line with a URL, which fails this census loudly.
        const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        for (const name of Object.keys(wiring)) {
          // Exclude the function declaration itself, but count each production call.
          const calls = [...code.matchAll(new RegExp(`(?<!function )\\b${name}\\s*\\(`, 'g'))].length;
          for (let i = 0; i < calls; i++) wiring[name].push(relative);
        }
      }
    }
  }
  walk(root);
  expect(found).toEqual(Object.fromEntries(Object.entries(policies).map(([file, policy]) => [file, policy.count])));
  expect(wiring).toEqual({
    installInputBroadcast: ['App.tsx'],
    setBroadcastSink: ['services/inputBroadcast.ts', 'services/inputBroadcast.ts'],
    broadcastMenuItems: ['components/Panes/PaneContextMenu.tsx', 'components/Terminal/TerminalDisplay.tsx'],
  });
});
