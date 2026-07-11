/**
 * @jest-environment jsdom
 *
 * Spec §17 R2: the MainBridge must drive electronAPI by the backend `processId`
 * and filter the global pty:data/pty:exit window events by that same id. These
 * tests assert "the right id is used" on every seam.
 *
 * jsdom provides `window` + `CustomEvent`; `window.electronAPI` is mocked per-test.
 */
import { createMainBridge } from './MainBridge';
import type { ElectronAPI } from '../../types/electron';

function mockElectronAPI(overrides: Partial<ElectronAPI> = {}): ElectronAPI {
  return {
    writeToTerminal: jest.fn(() => Promise.resolve()),
    resizeTerminal: jest.fn(() => Promise.resolve()),
    getTerminalOutput: jest.fn(() => Promise.resolve({ totalLines: 0, offset: 0, raw: '' })),
    ...overrides,
  } as unknown as ElectronAPI;
}

afterEach(() => {
  // Drop the per-test mock so a later test can assert its absence.
  delete (window as any).electronAPI;
});

describe('createMainBridge', () => {
  it('write(processId, data) delegates to electronAPI.writeToTerminal with exactly (processId, data)', () => {
    const api = mockElectronAPI();
    (window as any).electronAPI = api;

    createMainBridge().write('proc-1', 'hello');

    expect(api.writeToTerminal).toHaveBeenCalledTimes(1);
    expect(api.writeToTerminal).toHaveBeenCalledWith('proc-1', 'hello');
  });

  it('resize(processId, cols, rows) delegates to electronAPI.resizeTerminal with (processId, cols, rows)', () => {
    const api = mockElectronAPI();
    (window as any).electronAPI = api;

    createMainBridge().resize('proc-2', 120, 40);

    expect(api.resizeTerminal).toHaveBeenCalledTimes(1);
    expect(api.resizeTerminal).toHaveBeenCalledWith('proc-2', 120, 40);
  });

  describe('onData', () => {
    it('invokes cb only for a matching processId and exposes the data', () => {
      (window as any).electronAPI = mockElectronAPI();
      const cb = jest.fn();

      createMainBridge().onData('proc-A', cb);

      window.dispatchEvent(
        new CustomEvent('pty:data', { detail: { processId: 'proc-B', data: 'nope' } })
      );
      window.dispatchEvent(
        new CustomEvent('pty:data', { detail: { processId: 'proc-A', data: 'yes' } })
      );

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith('yes');
    });

    it('dispose() removes the listener so a later matching event does not call cb', () => {
      (window as any).electronAPI = mockElectronAPI();
      const cb = jest.fn();

      const disposable = createMainBridge().onData('proc-A', cb);
      disposable.dispose();

      window.dispatchEvent(
        new CustomEvent('pty:data', { detail: { processId: 'proc-A', data: 'after-dispose' } })
      );

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onExit', () => {
    it('invokes cb only for a matching processId and exposes the exit code', () => {
      (window as any).electronAPI = mockElectronAPI();
      const cb = jest.fn();

      createMainBridge().onExit('proc-A', cb);

      window.dispatchEvent(
        new CustomEvent('pty:exit', { detail: { processId: 'proc-B', exitCode: 1 } })
      );
      window.dispatchEvent(
        new CustomEvent('pty:exit', { detail: { processId: 'proc-A', exitCode: 0 } })
      );

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(0);
    });

    it('dispose() removes the listener so a later matching event does not call cb', () => {
      (window as any).electronAPI = mockElectronAPI();
      const cb = jest.fn();

      const disposable = createMainBridge().onExit('proc-A', cb);
      disposable.dispose();

      window.dispatchEvent(
        new CustomEvent('pty:exit', { detail: { processId: 'proc-A', exitCode: 0 } })
      );

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('getSnapshot', () => {
    it('is undefined when electronAPI.getTerminalSnapshot is absent', () => {
      (window as any).electronAPI = mockElectronAPI();

      expect(createMainBridge().getSnapshot).toBeUndefined();
    });

    it('is a function delegating to electronAPI.getTerminalSnapshot with (processId, cols, rows) when present', async () => {
      const snapshot = { snapshot: 'SCREEN', rows: 24, cols: 80 };
      const getTerminalSnapshot = jest.fn(() => Promise.resolve(snapshot));
      (window as any).electronAPI = mockElectronAPI({ getTerminalSnapshot });

      const bridge = createMainBridge();

      expect(typeof bridge.getSnapshot).toBe('function');
      await expect(bridge.getSnapshot!('proc-S', 80, 24)).resolves.toEqual(snapshot);
      expect(getTerminalSnapshot).toHaveBeenCalledWith('proc-S', 80, 24);
    });
  });
});
