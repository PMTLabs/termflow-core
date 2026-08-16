/**
 * DEV-ONLY verification bridge for Canvas Mode's human-only gates
 * (`plan/013` Task 9 Step 7b, guide `005`).
 *
 * Those checks are unprovable in CI — the xterm mocks make `dispose()`, `activate()` and
 * the WebGL addon no-ops, so nothing automated has ever observed a real GPU context being
 * released or a renderer actually swapping. They therefore have to be run by a human, and
 * the first pass at that asked the tester to hand-assemble console expressions against
 * internals they had no reference for. Every one of them came back untested.
 *
 * So this module turns each into ONE command that prints a verdict:
 *
 *     tf.help()      list everything
 *     tf.all()       run every automatable check and print a table
 *     tf.check13()   ...or run them one at a time
 *
 * Registered on `window.tf` only when `NODE_ENV === 'development'`, so it cannot reach a
 * production bundle. It reads live state and, where a check genuinely requires it, makes a
 * brief reversible change (check 14 toggles `display` for one synchronous measurement,
 * check 16 forces a real context loss). Each says so in its own docblock.
 */
import {
  terminalCache,
  countActiveWebGLAddons,
  getTerminalRenderPolicy,
  getCanvasWebGLBudget,
} from '@termflow/terminal-core';
import { store } from '../store';
import { setCanvasEnabled } from '../store/slices/canvasSlice';

export interface CheckResult {
  check: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  detail: string;
  data?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every cached terminal, as [id, entry] pairs. */
function entries(): Array<[string, ReturnType<typeof terminalCache.get> & object]> {
  const out: Array<[string, any]> = [];
  for (const id of terminalCache.keys()) {
    const e = terminalCache.get(id);
    if (e) out.push([id, e]);
  }
  return out as Array<[string, any]>;
}

/** How many fresh WebGL contexts the page can still create. Probes are released again. */
function contextCensus(): number {
  const held: WebGLRenderingContext[] = [];
  let n = 0;
  try {
    for (;;) {
      const el = document.createElement('canvas');
      const gl = (el.getContext('webgl2') || el.getContext('webgl')) as WebGLRenderingContext | null;
      if (!gl) break;
      held.push(gl);
      n++;
      if (n > 40) break;
    }
  } catch { /* the ceiling can throw rather than return null */ }
  held.forEach((gl) => gl.getExtension('WEBGL_lose_context')?.loseContext());
  return n;
}

/** Enter and leave Canvas Mode `times` times, letting each settle. */
async function cycleCanvas(times: number, settleMs = 400): Promise<void> {
  for (let i = 0; i < times; i++) {
    store.dispatch(setCanvasEnabled(true));
    await sleep(settleMs);
    store.dispatch(setCanvasEnabled(false));
    await sleep(settleMs);
  }
}

/**
 * Check 6 — ten toggles, then look for the damage the old borrowing mechanism caused:
 * a terminal whose element is detached, or two `.xterm` elements for one terminal.
 */
export async function check6(): Promise<CheckResult> {
  const before = entries().length;
  await cycleCanvas(10);
  const after = entries();

  const detached = after.filter(([, e]) => !e.terminal.element?.isConnected).map(([id]) => id);
  const duplicated = after
    .filter(([, e]) => (e.terminal.element?.parentElement?.querySelectorAll('.xterm').length ?? 0) > 1)
    .map(([id]) => id);

  const ok = after.length === before && !detached.length && !duplicated.length;
  return {
    check: '6 — ten toggles',
    verdict: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `${after.length} terminals, all still attached, none duplicated.`
      : `terminals ${before} -> ${after.length}; detached: [${detached}]; duplicated: [${duplicated}]`,
    data: { before, after: after.length, detached, duplicated },
  };
}

/**
 * Check 13 — a released GPU context is actually released.
 * Census, ten canvas entries/exits, census again. The two must match.
 */
export async function check13(): Promise<CheckResult> {
  const before = contextCensus();
  await cycleCanvas(10);
  const after = contextCensus();
  return {
    check: '13 — GPU contexts released',
    verdict: after === before ? 'PASS' : 'FAIL',
    detail: after === before
      ? `${before} contexts available before and after — nothing leaked.`
      : `${before} before, ${after} after. A decline is a context LEAK.`,
    data: { before, after },
  };
}

/**
 * Check 14 — does `proposeDimensions()` really return a bogus grid under `display:none`,
 * rather than erroring?
 *
 * This condition is NOT reachable by switching tabs: inactive tabs use `visibility:hidden`
 * (TerminalContainer.css), which keeps a layout box. So the check has to create it — it sets
 * `display:none` on the host's parent for ONE synchronous measurement and restores it in a
 * `finally`. It never calls `fit()`, so the PTY is never resized.
 */
export function check14(): CheckResult {
  const found = entries().find(([, e]) => e.terminal.element?.parentElement);
  if (!found) {
    return { check: '14 — display:none grid', verdict: 'INCONCLUSIVE', detail: 'no mounted terminal found' };
  }
  const [id, entry] = found;
  const host = entry.terminal.element!.parentElement as HTMLElement;
  const holder = host.parentElement as HTMLElement | null;
  if (!holder) {
    return { check: '14 — display:none grid', verdict: 'INCONCLUSIVE', detail: 'host has no parent to hide' };
  }

  const prev = holder.style.display;
  let value: unknown;
  try {
    holder.style.display = 'none';
    value = entry.fitAddon.proposeDimensions();
  } finally {
    holder.style.display = prev;
  }

  const bogus = !!value && typeof value === 'object';
  return {
    check: '14 — display:none grid',
    verdict: bogus ? 'PASS' : 'INCONCLUSIVE',
    detail: bogus
      ? `returned ${JSON.stringify(value)} rather than undefined — the LB guard is justified.`
      : `returned ${String(value)}. NOT the measured behaviour: the guard's rationale changes, tell design/013.`,
    data: { terminalId: id, returned: value },
  };
}

/**
 * Check 15 — the renderer actually swapped. A WebGL terminal must have a canvas in its
 * screen element; a DOM one must have none.
 */
export function check15(): CheckResult {
  const rows = entries().map(([id, e]) => ({
    id,
    policy: getTerminalRenderPolicy(id),
    canvases: e.terminal.element?.querySelectorAll('canvas').length ?? 0,
  }));
  const wrong = rows.filter((r) =>
    (r.policy === 'webgl' && r.canvases === 0) || (r.policy === 'dom' && r.canvases > 0));
  return {
    check: '15 — renderer swapped',
    verdict: rows.length ? (wrong.length ? 'FAIL' : 'PASS') : 'INCONCLUSIVE',
    detail: wrong.length
      ? `policy disagrees with the DOM for: ${wrong.map((w) => `${w.id}(${w.policy}/${w.canvases})`).join(', ')}`
      : `${rows.length} terminals, policy matches the DOM for every one. Now confirm text is LEGIBLE in both states.`,
    data: { rows },
  };
}

/**
 * Check 16 — `onContextLoss` behaves the same however the terminal was promoted.
 *
 * Forces a REAL context loss on one promoted terminal, then checks it fell back to `'dom'`,
 * is still rendering, and kept its scrollback. The terminal recovers on the DOM renderer;
 * nothing is destroyed.
 */
export async function check16(): Promise<CheckResult> {
  const promoted = entries().find(([id]) => getTerminalRenderPolicy(id) === 'webgl');
  if (!promoted) {
    return {
      check: '16 — onContextLoss',
      verdict: 'INCONCLUSIVE',
      detail: 'no terminal is on WebGL. Enter Canvas Mode first so something gets promoted.',
    };
  }
  const [id, entry] = promoted;
  const canvas = entry.terminal.element?.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    return { check: '16 — onContextLoss', verdict: 'FAIL', detail: `${id} reports webgl but has no canvas` };
  }

  const linesBefore = entry.terminal.buffer.active.length;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  await sleep(600);

  const policy = getTerminalRenderPolicy(id);
  const linesAfter = terminalCache.get(id)?.terminal.buffer.active.length ?? 0;
  const ok = policy === 'dom' && linesAfter >= linesBefore;
  return {
    check: '16 — onContextLoss',
    verdict: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `${id} fell back to dom, scrollback intact (${linesAfter} lines). Confirm by eye that it still redraws.`
      : `${id}: policy=${policy} (want dom), lines ${linesBefore} -> ${linesAfter}`,
    data: { terminalId: id, policy, linesBefore, linesAfter },
  };
}

/**
 * Check 17 — is `MAX_GPU = 12` right for THIS machine? Compares the live WebGL count
 * against the armed budget, and the budget against the browser's own ceiling.
 */
export function check17(): CheckResult {
  const active = countActiveWebGLAddons();
  const budget = getCanvasWebGLBudget();
  const ceiling = contextCensus() + active;
  const overBudget = budget !== null && active > budget;
  const tooClose = budget !== null && ceiling < budget + 2;
  return {
    check: '17 — MAX_GPU fits this machine',
    verdict: overBudget || tooClose ? 'FAIL' : budget === null ? 'INCONCLUSIVE' : 'PASS',
    detail: budget === null
      ? 'no canvas session active — enter Canvas Mode, then run this again.'
      : overBudget
        ? `${active} contexts held against a budget of ${budget}.`
        : tooClose
          ? `this machine tops out near ${ceiling} contexts; a budget of ${budget} is too close. Tell design/010.`
          : `${active}/${budget} held; machine ceiling ~${ceiling}. Also confirm no "Too many active WebGL contexts" warning above.`,
    data: { active, budget, ceiling },
  };
}

/**
 * Check 18 — a relocation and a policy swap in flight over the same surface at once, which
 * is the case that has historically wiped scrollback. Enters Canvas Mode and forces a policy
 * change on the same tick, then compares the buffer.
 *
 * Run it with a live codex/ratatui pane for the case that actually matters.
 */
export async function check18(terminalId?: string): Promise<CheckResult> {
  const pick = terminalId ?? entries()[0]?.[0];
  const entry = pick ? terminalCache.get(pick) : null;
  if (!entry) {
    return { check: '18 — relocation + policy swap', verdict: 'INCONCLUSIVE', detail: 'no terminal to test' };
  }
  const before = entry.terminal.buffer.active.length;

  store.dispatch(setCanvasEnabled(true));
  // Same tick as the relocation the line above triggers.
  const { setTerminalRenderPolicy } = await import('@termflow/terminal-core');
  setTerminalRenderPolicy(pick!, getTerminalRenderPolicy(pick!) === 'webgl' ? 'dom' : 'webgl');
  await sleep(1200);
  store.dispatch(setCanvasEnabled(false));
  await sleep(600);

  const after = terminalCache.get(pick!)?.terminal.buffer.active.length ?? 0;
  const ok = after >= before;
  return {
    check: '18 — relocation + policy swap',
    verdict: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `scrollback survived (${before} -> ${after} lines).`
      : `SCROLLBACK LOST: ${before} -> ${after} lines on ${pick}.`,
    data: { terminalId: pick, before, after },
  };
}

/**
 * Check 19 — a failed activation must not strand a canvas.
 *
 * Cannot force a driver failure from here, so this is a LEAK DETECTOR rather than the forced
 * -failure test: it counts stranded canvases across ten canvas entries. A growing count is a
 * real defect; a flat count does not prove the failure path is clean, only that the happy
 * path is. Forcing the failure still needs the addon patched locally.
 */
export async function check19(): Promise<CheckResult> {
  const count = () => document.querySelectorAll('.xterm-screen canvas').length;
  const before = count();
  const censusBefore = contextCensus();
  await cycleCanvas(10);
  const after = count();
  const censusAfter = contextCensus();
  const ok = after <= before && censusAfter >= censusBefore;
  return {
    check: '19 — no stranded canvases',
    verdict: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `stranded canvases ${before} -> ${after}, contexts ${censusBefore} -> ${censusAfter}. Happy path is clean; the FORCED-failure half still needs a patched addon.`
      : `canvases ${before} -> ${after}, contexts ${censusBefore} -> ${censusAfter}.`,
    data: { before, after, censusBefore, censusAfter },
  };
}

/** Run everything automatable, in an order that leaves the app as it found it. */
export async function all(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(check14());
  results.push(await check6());
  results.push(await check13());
  results.push(await check19());
  store.dispatch(setCanvasEnabled(true));
  await sleep(800);
  results.push(check15());
  results.push(check17());
  results.push(await check16());
  store.dispatch(setCanvasEnabled(false));
  await sleep(400);
  results.push(await check18());

  // eslint-disable-next-line no-console
  console.table(results.map((r) => ({ check: r.check, verdict: r.verdict, detail: r.detail })));
  return results;
}

function help(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      'TermFlow Canvas Mode verification (guide 005)',
      '',
      '  await tf.all()        run every automatable check, print a table  (~1 min)',
      '',
      '  await tf.check6()     ten toggles: nothing detached or duplicated',
      '  await tf.check13()    GPU contexts released across ten entries',
      '        tf.check14()    proposeDimensions() under display:none',
      '        tf.check15()    renderer policy matches the DOM',
      '  await tf.check16()    forced context loss falls back to dom',
      '        tf.check17()    MAX_GPU vs this machine  (enter Canvas Mode first)',
      '  await tf.check18(id?) relocation + policy swap, scrollback survives',
      '  await tf.check19()    stranded-canvas leak detector',
      '',
      '  tf.cache()            live terminals, policy and canvas count',
      '',
      'Checks 15 and 17 read the CURRENT state, so enter Canvas Mode before running them',
      '(tf.all() handles that for you).',
    ].join('\n'),
  );
}

function cache(): void {
  // eslint-disable-next-line no-console
  console.table(entries().map(([id, e]) => ({
    id,
    policy: getTerminalRenderPolicy(id),
    canvases: e.terminal.element?.querySelectorAll('canvas').length ?? 0,
    attached: !!e.terminal.element?.isConnected,
    lines: e.terminal.buffer.active.length,
  })));
}

/** Registered from `index.tsx`, dev builds only. */
export function installDevDiagnostics(): void {
  const api = {
    help, all, cache,
    check6, check13, check14, check15, check16, check17, check18, check19,
    contextCensus,
  };
  (window as unknown as { tf: typeof api }).tf = api;
  // eslint-disable-next-line no-console
  console.log('%cTermFlow diagnostics ready — type tf.help()', 'color:#3aa6ff;font-weight:bold');
}
