import path from 'path';
import { offloadRetentionCopy } from '../offloadRetentionCopy';
import { readSource } from '../../../utils/readSource';

const SETTINGS = readSource(path.resolve(__dirname, '..', 'SettingsPage.tsx'));
const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const UPDATE_COMMANDS = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'commands', 'update.rs'));
const TAURI_BRIDGE = readSource(path.resolve(ROOT, 'src', 'renderer', 'api', 'tauri-bridge.ts'));
const PANEL_START = SETTINGS.indexOf('<label className="setting-label">Offload &amp; rebuild');
const DIALOG_START = SETTINGS.indexOf('<ConfirmDialog', PANEL_START);
const DIALOG_END = SETTINGS.indexOf('/>', DIALOG_START);
const PANEL = SETTINGS.slice(PANEL_START, DIALOG_START);
const DIALOG = SETTINGS.slice(DIALOG_START, DIALOG_END);

describe('Offload & Close retention copy (plan 036 item 1.5)', () => {
  it('gets policy from the connected client, not a mutable discovery record', () => {
    const command = UPDATE_COMMANDS.slice(
      UPDATE_COMMANDS.indexOf('pub fn connected_host_retention'),
      UPDATE_COMMANDS.indexOf('\n}', UPDATE_COMMANDS.indexOf('pub fn connected_host_retention')) + 2,
    );

    expect(command).toContain('pty_host_clone()');
    expect(command).toContain('client.host_retention()');
    expect(command).not.toContain('read_host_record');
    expect(TAURI_BRIDGE).toContain("invoke<ConnectedHostRetention>('connected_host_retention')");
  });

  it('derives a bounded host grace period from activeSecs in both surfaces', () => {
    const copy = offloadRetentionCopy({ state: 'bounded', activeSecs: 300 });

    expect(copy).toContain('5 minutes');
    expect(copy).toContain('within that grace period to reclaim everything');
    expect(copy).toContain('after it, the shells are closed');
    expect(copy).toContain('MCP/API clients drop');
    expect(copy).toContain('may need to reconnect or reinitialize');
    expect(PANEL).toContain('offloadRetentionCopy(hostRetention)');
    expect(DIALOG).toContain('message={offloadRetentionCopy(hostRetention)}');
  });

  it('reports an unknown host honestly, without inventing a number, in both surfaces', () => {
    const copy = offloadRetentionCopy({ state: 'unknown' });

    expect(copy).toContain('retention policy is unavailable (legacy host) — no bound promised');
    expect(copy).not.toMatch(/\d/);
    expect(copy).not.toContain('no time limit');
    expect(PANEL).toContain('offloadRetentionCopy(hostRetention)');
    expect(DIALOG).toContain('message={offloadRetentionCopy(hostRetention)}');
  });

  it('does not turn an indefinite host promise into a promise that TermFlow remains available', () => {
    const copy = offloadRetentionCopy({ state: 'indefinite' });

    expect(copy).toContain('promises no time limit');
    expect(copy).toContain('does not mean TermFlow will still be there');
    expect(copy).toContain('MCP/API clients drop');
    expect(copy).toContain('may need to reconnect or reinitialize');
  });
});
