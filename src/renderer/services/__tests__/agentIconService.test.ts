/**
 * @jest-environment jsdom
 */
import { getAgentIcon, __clearAgentIconCache } from '../agentIconService';
import { CURATED_AGENT_ICONS } from '../agentIcons';

const DATA_URL = 'data:image/png;base64,AAAA';

beforeEach(() => {
  __clearAgentIconCache();
  delete (window as any).electronAPI;
});

it('bundles a real Antigravity PNG for agy', () => {
  // Sanity: the generated curated asset is present and looks like a PNG data URL.
  expect(CURATED_AGENT_ICONS.agy).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
});

it('uses the curated icon for a known agent, bypassing native extraction', async () => {
  const getExecutableIcon = jest.fn(async () => DATA_URL);
  (window as any).electronAPI = { getExecutableIcon };
  await expect(getAgentIcon('C:\\WinGet\\Links\\agy.exe', 'agy')).resolves.toBe(
    CURATED_AGENT_ICONS.agy,
  );
  expect(getExecutableIcon).not.toHaveBeenCalled(); // curated wins → no native call
});

it('returns the curated icon even when the exe path is unknown', async () => {
  await expect(getAgentIcon(null, 'agy')).resolves.toBe(CURATED_AGENT_ICONS.agy);
});

it('matches the agent label case-insensitively', async () => {
  await expect(getAgentIcon(null, 'AGY')).resolves.toBe(CURATED_AGENT_ICONS.agy);
});

it('falls through to native extraction for a non-curated agent', async () => {
  const getExecutableIcon = jest.fn(async () => DATA_URL);
  (window as any).electronAPI = { getExecutableIcon };
  await expect(getAgentIcon('/usr/bin/codex', 'codex')).resolves.toBe(DATA_URL);
  expect(getExecutableIcon).toHaveBeenCalledWith('/usr/bin/codex');
});

it('resolves the data URL and caches it — one bridge call per unique exe', async () => {
  const getExecutableIcon = jest.fn(async () => DATA_URL);
  (window as any).electronAPI = { getExecutableIcon };

  const first = await getAgentIcon('/usr/bin/codex');
  const second = await getAgentIcon('/usr/bin/codex');

  expect(first).toBe(DATA_URL);
  expect(second).toBe(DATA_URL);
  expect(getExecutableIcon).toHaveBeenCalledTimes(1); // cached
});

it('maps a rejected bridge call (no icon / non-Windows Err) to null', async () => {
  const getExecutableIcon = jest.fn(async () => {
    throw new Error('icon extraction is only supported on Windows');
  });
  (window as any).electronAPI = { getExecutableIcon };

  await expect(getAgentIcon('/usr/bin/aider')).resolves.toBeNull();
});

it('resolves null when the bridge does not implement getExecutableIcon', async () => {
  (window as any).electronAPI = {}; // no getExecutableIcon
  await expect(getAgentIcon('/usr/bin/whatever')).resolves.toBeNull();
});

it('does not pin a transient failure — a later call retries and can succeed', async () => {
  let attempt = 0;
  const getExecutableIcon = jest.fn(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('transient failure (helper momentarily blocked)');
    return DATA_URL;
  });
  (window as any).electronAPI = { getExecutableIcon };

  // 1st: transient fail → null (and the null entry is evicted, not pinned).
  expect(await getAgentIcon('/usr/bin/codex')).toBeNull();
  // 2nd: cache miss → retried → success.
  expect(await getAgentIcon('/usr/bin/codex')).toBe(DATA_URL);
  expect(getExecutableIcon).toHaveBeenCalledTimes(2);

  // Success IS pinned — no third bridge call.
  expect(await getAgentIcon('/usr/bin/codex')).toBe(DATA_URL);
  expect(getExecutableIcon).toHaveBeenCalledTimes(2);
});

it('distinguishes different exes (separate cache entries)', async () => {
  const getExecutableIcon = jest.fn(async (p: string) =>
    p.endsWith('codex') ? DATA_URL : 'data:image/png;base64,BBBB',
  );
  (window as any).electronAPI = { getExecutableIcon };

  expect(await getAgentIcon('/usr/bin/codex')).toBe(DATA_URL);
  expect(await getAgentIcon('/usr/bin/gemini')).toBe('data:image/png;base64,BBBB');
  expect(getExecutableIcon).toHaveBeenCalledTimes(2);
});
