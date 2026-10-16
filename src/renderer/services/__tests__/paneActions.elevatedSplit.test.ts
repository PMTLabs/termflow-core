/**
 * @jest-environment jsdom
 *
 * Plan 058 review: splitting an elevated pane is the user asking for another elevated shell,
 * so it must reset the UAC-cancel latch the way Open Admin Tab and Restart do. Otherwise one
 * cancelled prompt makes every later split of an elevated pane fail without a prompt.
 */
const beginUserElevatedAttempt = jest.fn();
const dispatch = jest.fn();
let leaf: any;

jest.mock('../TerminalService', () => ({
  terminalService: { beginUserElevatedAttempt: (...a: any[]) => beginUserElevatedAttempt(...a), getProcessId: () => undefined },
}));
jest.mock('../../store', () => ({
  store: { getState: () => ({ settings: { defaultProfile: 'default' }, panes: { treesByTabId: { 'tb-1': leaf }, paneTree: null } }), dispatch: (...a: any[]) => dispatch(...a) },
}));
jest.mock('../paneEffect', () => ({ capturePaneEffect: () => () => true }));
jest.mock('../cwdSnapshot', () => ({ getCwdSnapshot: () => undefined }));

import { splitPaneById } from '../paneActions';

beforeEach(() => {
  beginUserElevatedAttempt.mockClear();
  dispatch.mockClear();
});

it('resets the UAC-cancel latch when the pane being split is elevated', async () => {
  leaf = { type: 'terminal', id: 'pn-1', terminalId: 'tm-1', elevated: true };
  await splitPaneById('pn-1', 'horizontal');
  expect(beginUserElevatedAttempt).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it('leaves the latch alone when the pane is not elevated', async () => {
  leaf = { type: 'terminal', id: 'pn-1', terminalId: 'tm-1' };
  await splitPaneById('pn-1', 'horizontal');
  expect(beginUserElevatedAttempt).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledTimes(1);
});
