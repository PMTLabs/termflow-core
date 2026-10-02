import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../../..');
const deletedNames = /\b(?:session_handoff|handoff_offers|HandoffOffers|HandoffTake|SessionHandoffTake|offer_session_handoff|take_session_handoff|offerSessionHandoff|takeSessionHandoff|takeOfferedSession|release_absent\w*|closed_while_creating|closedWhileCreating|releaseAbsentCreate|HANDOFF_[A-Z_]+|stash_detach_payload|take_detach_payload|stashDetachPayload|takeDetachPayload|detach_payloads|active_global_drag|GlobalDrag)\b/g;
function obsoleteNames(source: string): string[] { return [...source.matchAll(deletedNames)].map(hit => hit[0]); }
function corpus(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'target', 'dist', '.git'].includes(entry.name) ? [] : corpus(file);
    return /\.(?:rs|tsx?|md|json|js|mjs)$/.test(entry.name) && file !== __filename ? [file] : [];
  });
}

test('deleted session bridge names cannot return in code, fixtures or documentation', () => {
  const names = ['session_handoff', 'offer_session_handoff', 'take_session_handoff', 'handoff_offers', 'HandoffOffers', 'HandoffTake', 'SessionHandoffTake', 'offerSessionHandoff', 'takeSessionHandoff', 'takeOfferedSession', 'release_absent_create', 'closed_while_creating', 'closedWhileCreating', 'releaseAbsentCreate', 'HANDOFF_IDLE_DELAY_MS', 'stash_detach_payload', 'take_detach_payload', 'stashDetachPayload', 'takeDetachPayload', 'detach_payloads', 'active_global_drag', 'GlobalDrag'];
  for (const name of names) {
    expect(obsoleteNames(`api.${name}?.(leaf, pc);`)).toEqual([name]);
    expect(obsoleteNames(`// ${name} is still used`)).toEqual([name]);
  }
  expect(obsoleteNames('takePromptGateHandoff takeWin32InputModeHandoff takeKeyboardProtocolHandoff promptGateHandoff keyboardProtocolHandoff Context handoff reminder HANDOFF now offer Copy Link')).toEqual([]);
  const files = ['src', 'src-tauri/src', 'src-tauri/pty-host/src', 'src-tauri/pty-protocol/src', 'mcp-server', 'tests', 'docs', 'packages', 'agent-monitor', 'terminal-kit', 'terminal-monitor', 'scripts'].flatMap(dir => corpus(path.join(root, dir)));
  files.push(path.join(root, 'PROJECT_STRUCTURE.md'));
  for (const file of ['src/renderer/App.tsx', 'src/renderer/types/electron.d.ts', 'src-tauri/src/lib.rs', 'mcp-server/src/server.ts', 'src/renderer/components/Automation/__fixtures__/automationValidationCases.json']) {
    expect(files).toContain(path.join(root, file));
  }
  expect(files.length).toBeGreaterThan(1000);
  const hits = files.flatMap(file => {
    const names = obsoleteNames(fs.readFileSync(file, 'utf8'));
    return names.length ? [[path.relative(root, file), names]] : [];
  });
  expect(hits).toEqual([]);
  expect(fs.existsSync(path.join(root, 'src-tauri/src/session_handoff.rs'))).toBe(false);
});

test('every native broker invoke carries its caller page and transfer notices keep their receipts', () => {
  const renderer = path.join(root, 'src/renderer');
  const bridge = fs.readFileSync(path.join(renderer, 'api/tauri-bridge.ts'), 'utf8');
  for (const command of ['create_detached_window', 'begin_global_pane_drag', 'claim_global_pane_drag', 'resolve_orphan_global_drag', 'cancel_global_pane_drag', 'resolve_tab_drop']) {
    expect(bridge).toMatch(new RegExp(`invoke\\('${command}', \\{[^}]*transferPageArgs\\(\\)`));
  }
  expect(bridge).toContain("if (!page) throw new Error('transfer requires a desktop page')");
  const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8');
  expect(app).toContain('acceptsTransferNotice(p).then');
  const drag = fs.readFileSync(path.join(renderer, 'components/Panes/dnd/PaneDragController.tsx'), 'utf8');
  expect(drag).toContain('acceptsTransferNotice(notice)');
  expect(drag).toContain('await waitDetachTransfer(token)');
});
