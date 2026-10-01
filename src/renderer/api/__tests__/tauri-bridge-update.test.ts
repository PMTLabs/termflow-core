/**
 * @jest-environment jsdom
 *
 * The update commands cross the bridge with shapes the backend serialises and
 * deserialises: what `update_available` answers, what `update_and_restart`
 * answers, and the agreement that goes back with the second call.
 */
import path from 'path';
import { readSource } from '../../utils/readSource';

const invokeMock = jest.fn((_cmd: string, _args?: any) => Promise.resolve(undefined as unknown));

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...(args as [string, any])),
}));

jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn(() => Promise.resolve(() => {})),
}));

jest.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: jest.fn(() => ({ label: 'main' })),
}));

Object.defineProperty(global, 'localStorage', {
  value: { getItem: jest.fn(() => null), setItem: jest.fn() },
  writable: true,
});

// Import AFTER mocks are set up
import tauriBridge from '../tauri-bridge';
import { confirmTokenFor } from '../../components/Settings/fullUpdateCopy';

const REASONS = [{ kind: 'marker' }, { kind: 'hostInPayload', host: 'host-1' }] as const;

beforeEach(() => {
  invokeMock.mockReset();
});

describe('updateAvailable', () => {
  it('hands the mode and the reasons through untouched', async () => {
    const answer = { mode: 'full', reasons: [...REASONS] };
    invokeMock.mockResolvedValueOnce(answer);
    await expect(tauriBridge.updateAvailable()).resolves.toStrictEqual(answer);
    expect(invokeMock).toHaveBeenCalledWith('update_available');
  });

  it('keeps rejecting with the refusal text', async () => {
    invokeMock.mockRejectedValueOnce('another TermFlow instance is running');
    await expect(tauriBridge.updateAvailable()).rejects.toBe('another TermFlow instance is running');
  });
});

describe('updateAndRestart', () => {
  it('sends no agreement on the first call', async () => {
    invokeMock.mockResolvedValueOnce({ outcome: 'started' });
    await expect(tauriBridge.updateAndRestart()).resolves.toStrictEqual({ outcome: 'started' });
    expect(invokeMock).toHaveBeenCalledWith('update_and_restart', { confirm: null });
  });

  it('sends the agreement with every field, under the names the backend reads', async () => {
    const token = { targetVersion: '9.9.9', shellCount: 3, unknown: true, reasons: [...REASONS] };
    invokeMock.mockResolvedValueOnce({ outcome: 'started' });
    await tauriBridge.updateAndRestart(token);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]).toStrictEqual(['update_and_restart', { confirm: token }]);
  });

  it('hands a needs-confirmation answer through with all of its fields', async () => {
    const answer = { outcome: 'needsConfirmation', version: '9.9.9', shellCount: 3, unknown: false, reasons: [...REASONS] };
    invokeMock.mockResolvedValueOnce(answer);
    await expect(tauriBridge.updateAndRestart()).resolves.toStrictEqual(answer);
  });
});

describe('the agreement matches what the backend deserialises', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
  const RUST = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'state', 'update_full.rs'));

  const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const fieldsOf = (struct: string): string[] => {
    const start = RUST.indexOf(`pub struct ${struct} {`);
    expect(start).toBeGreaterThan(-1);
    const body = RUST.slice(start, RUST.indexOf('\n}', start));
    return [...body.matchAll(/^\s+pub (\w+):/gm)].map((m) => camel(m[1])).sort();
  };

  it('has exactly the fields of the backend token, so a dropped or renamed one is caught', () => {
    const token = confirmTokenFor({ version: 'v', shellCount: 1, unknown: false, reasons: [] });
    expect(Object.keys(token).sort()).toEqual(fieldsOf('ConfirmToken'));
  });

  it('is built from the fields of the backend confirmation', () => {
    // Everything but the version keeps its name; the version is `targetVersion` in the token.
    expect(fieldsOf('Confirmation').map((f) => (f === 'version' ? 'targetVersion' : f)).sort()).toEqual(
      fieldsOf('ConfirmToken'),
    );
  });
});
