import path from 'path';
import { readSource } from '../../../utils/readSource';

/**
 * Plan 047: the "bypass the system proxy for localhost" toggle must be REACHABLE from the
 * MCP Server card, and its two wiring hops must be the real ones. The slice test proves the
 * reducer; the Rust tests prove the spawn paths; neither proves a user can flip it.
 *
 * Source-derived for the same reason as `shortcutsScreenWiring.test.ts`: `SettingsPage` is
 * the app's largest component and pulls in Tauri plugins at module load.
 */

const SETTINGS = readSource(path.resolve(__dirname, '..', 'SettingsPage.tsx'));
const APP = readSource(path.resolve(__dirname, '..', '..', '..', 'App.tsx'));
const TAURI_BRIDGE = readSource(path.resolve(__dirname, '..', '..', '..', 'api', 'tauri-bridge.ts'));

describe('loopback proxy exemption toggle (Plan 047)', () => {
  it('is rendered inside the MCP Server card and dispatches the slice action', () => {
    const card = SETTINGS.indexOf('{/* MCP Server */}');
    const network = SETTINGS.indexOf('{/* Network access */}');
    expect(card).toBeGreaterThan(-1);
    expect(network).toBeGreaterThan(card);
    const mcpCard = SETTINGS.slice(card, network);
    expect(mcpCard).toContain('checked={settings.exemptLoopbackFromProxy}');
    expect(mcpCard).toContain('dispatch(setExemptLoopbackFromProxy(e.target.checked))');
    // The help text must say it only applies to NEW terminals — env is spawn-time.
    expect(mcpCard).toContain('Applies to terminals opened');
  });

  it('is hydrated from the saved config at boot so the toggle shows the persisted value', () => {
    expect(APP).toContain('if (config.exemptLoopbackFromProxy !== undefined) {');
    expect(APP).toContain('dispatch(setExemptLoopbackFromProxy(config.exemptLoopbackFromProxy))');
  });

  it('reaches the Rust command that owns persistence', () => {
    expect(TAURI_BRIDGE).toContain("invoke('set_exempt_loopback_from_proxy', { enabled })");
  });
});
