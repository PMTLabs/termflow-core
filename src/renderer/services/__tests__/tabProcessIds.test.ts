/**
 * @jest-environment jsdom
 *
 * Re-review 111 finding 3. Tab-level process lookups (Copy Tab Info, rename)
 * used to resolve a SINGLE leaf via `soloRootLeafId`, falling back to `tab.id`
 * when the tree was a split. For an API-created tab `tab.id` was never a
 * terminal leaf, so once that tab was split Copy-All-Info dropped the process
 * id entirely and rename never reached ANY backend process.
 */
jest.mock('../TerminalService', () => ({
  terminalService: { getProcessIdForTerminal: jest.fn() },
}));

import { PaneNode } from '../../store/slices/panesSlice';
import { terminalService } from '../TerminalService';
import { resolveTabProcessIds, renameTabProcesses } from '../tabProcessIds';

const leaf = (id: string, tid: string): PaneNode => ({ id, type: 'terminal', terminalId: tid });
const split = (id: string, a: PaneNode, b: PaneNode): PaneNode =>
  ({ id, type: 'split', direction: 'horizontal', size: 50, children: [a, b] });

const mockLookup = terminalService.getProcessIdForTerminal as jest.Mock;

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockImplementation((terminalId: string) =>
    terminalId.startsWith('tm-') ? `proc-${terminalId}` : undefined,
  );
});

describe('resolveTabProcessIds', () => {
  it('resolves every live leaf of a SPLIT API-created tab (tab.id is not a leaf)', () => {
    const tree = split('s1', leaf('p1', 'tm-a'), leaf('p2', 'tm-b'));
    expect(resolveTabProcessIds(tree, 'tb-api1')).toEqual(['proc-tm-a', 'proc-tm-b']);
  });

  it('keeps the single-value result for a solo tab', () => {
    expect(resolveTabProcessIds(leaf('p1', 'tm-a'), 'tb-api1')).toEqual(['proc-tm-a']);
  });
});

describe('renameTabProcesses', () => {
  it('calls updateTerminalName once per live leaf of a split API tab', async () => {
    const updateTerminalName = jest.fn().mockResolvedValue(undefined);
    (window as any).electronAPI = { updateTerminalName };

    const tree = split('s1', leaf('p1', 'tm-a'), leaf('p2', 'tm-b'));
    const renamed = await renameTabProcesses(tree, 'tb-api1', 'New title');

    expect(renamed).toEqual(['proc-tm-a', 'proc-tm-b']);
    expect(updateTerminalName).toHaveBeenCalledTimes(2);
    expect(updateTerminalName).toHaveBeenCalledWith('proc-tm-a', 'New title');
    expect(updateTerminalName).toHaveBeenCalledWith('proc-tm-b', 'New title');
  });

  it('continues renaming the remaining panes when one call rejects', async () => {
    const updateTerminalName = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    (window as any).electronAPI = { updateTerminalName };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const tree = split('s1', leaf('p1', 'tm-a'), leaf('p2', 'tm-b'));
    await renameTabProcesses(tree, 'tb-api1', 'T');

    expect(updateTerminalName).toHaveBeenCalledTimes(2);
    (console.error as jest.Mock).mockRestore();
  });
});
