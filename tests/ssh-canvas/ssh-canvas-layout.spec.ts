import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { SshCanvasHooks } from './fixture/entry';

const SSH = 'tm-ssh';
const LOCAL = 'tm-local';
const MATCHED = 'tm-matched';
const node = (page: Page, id = SSH) => page.locator(`.canvas-node[data-terminal-id="${id}"]`);
const sample = (page: Page, id = SSH) => page.evaluate(id => window.__sshCanvas.read(id), id);
type Sample = Awaited<ReturnType<typeof sample>>;
type Viewport = Parameters<SshCanvasHooks['viewport']>[0];

// Include ResizeObserver delivery, paint, and the engine's 120ms trailing PTY debounce.
// The enclosing Playwright test also bounds this barrier if the page stops drawing.
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => {
  const start = performance.now();
  let frames = 0;
  const frame = () => {
    if (++frames >= 4 && performance.now() - start >= 200) resolve();
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}));

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function start(page: Page, shape = 'wide', overflow = false) {
  await page.goto(new URL(`?shape=${shape}${overflow ? '&overflow' : ''}`, process.env.SSH_CANVAS_URL).href);
  await expect(page.locator('[data-source="tm-ssh"] .ssh-file-rows').getByText('fixture.txt')).toBeVisible();
  await expect(page.locator('[data-source="tm-ssh"] .ssh-status')).toBeVisible();
  for (const id of [SSH, LOCAL, MATCHED]) {
    await expect.poll(async () => {
      const s = await sample(page, id);
      return !!s.actual && s.actual.cols > 2 && s.actual.rows > 1 &&
        s.actual.cols === s.proposal?.cols && s.actual.rows === s.proposal?.rows;
    }).toBe(true);
    await page.evaluate(id => window.__sshCanvas.write(id, 'Layout fixture output'), id);
    await expect.poll(async () => (await sample(page, id)).text).toBe('Layout fixture output');
    await expect(page.locator(`[data-source="${id}"] .xterm-screen`)).toBeVisible();
  }
  await settle(page);
}

function unchanged(actual: Sample, expected: Sample) {
  expect(actual.actual).toEqual(expected.actual);
  expect(actual.proposal).toEqual(expected.actual);
  expect(actual.content).toEqual(expected.content);
  expect(actual.resizes).toEqual(expected.resizes);
}

async function collapse(page: Page, collapsed: boolean, before: Sample) {
  await page.evaluate(value => window.__sshCanvas.collapse(value), collapsed);
  const scope = (await page.evaluate(() => window.__sshCanvas.camera().active))
    ? node(page) : page.locator('[data-source="tm-ssh"]');
  await expect(scope.locator('.ssh-browser-toggle')).toHaveAttribute('aria-expanded', String(!collapsed));
  await expect.poll(async () => (await sample(page)).resizes.length).toBe(before.resizes.length + 1);
  await settle(page);
  const after = await sample(page);
  expect(after.resizes.slice(before.resizes.length)).toEqual([after.actual]);
  expect(after.proposal).toEqual(after.actual);
  expect(after.actual!.rows).toBe(before.actual!.rows);
  expect(after.content!.h).toBe(before.content!.h);
  if (collapsed) {
    expect(after.content!.w).toBeGreaterThan(before.content!.w);
    expect(after.actual!.cols).toBeGreaterThan(before.actual!.cols);
  } else {
    expect(after.content!.w).toBeLessThan(before.content!.w);
    expect(after.actual!.cols).toBeLessThan(before.actual!.cols);
  }
  return after;
}

async function enter(page: Page) {
  await page.evaluate(() => window.__sshCanvas.enter());
  for (const id of [SSH, LOCAL, MATCHED]) await expect.poll(async () => (await sample(page, id)).registered).toBe(true);
  await settle(page);
}

const readViewport = (page: Page) => page.evaluate(() => {
  const { x, y, z } = window.__sshCanvas.camera();
  return { x, y, z };
});

test('sshCanvas_browserWheelReachesScroller_withoutViewportChange', async ({ page }) => {
  await start(page, 'wide', true);
  await enter(page);
  const ssh = node(page);
  const browser = ssh.locator('.ssh-browser');
  const scroll = () => browser.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight }));
  const wheel = async (delta: number) => {
    await page.mouse.wheel(0, delta);
    await settle(page);
  };
  const reset = async () => {
    await page.evaluate(() => window.__sshCanvas.viewport({ x: 0, y: 0, z: 1 }));
    await settle(page);
  };
  for (const mode of ['zoom', 'scroll'] as const) await test.step(mode, async () => {
    await reset();
    await page.evaluate(mode => window.__sshCanvas.wheelMode(mode), mode);
    await ssh.locator('.ssh-terminal-host').hover();
    const controlBefore = await readViewport(page);
    await wheel(80);
    const controlAfter = await readViewport(page);
    console.log(JSON.stringify({ mode, controlBefore, controlAfter }));
    const axis = mode === 'zoom' ? 'z' : 'y';
    expect(controlAfter[axis]).not.toBe(controlBefore[axis]);

    await reset();
    await ssh.locator('.ssh-file-rows').getByRole('button', { name: 'fixture-1.txt', exact: true }).hover();
    const before = await scroll();
    const viewport = await readViewport(page);
    expect(viewport.z).toBe(1);
    expect(before.top).toBe(0);
    expect(before.total).toBeGreaterThan(before.height);
    const terminals = await samplePair(page);
    await wheel(80);
    const down = await scroll();
    const afterDown = await readViewport(page);
    console.log(JSON.stringify({ mode, before, down, viewport, afterDown }));
    expect(afterDown).toEqual(viewport);
    expect(down.top).toBeGreaterThan(before.top);
    const checkTerminals = async () => {
      const after = await samplePair(page);
      unchanged(after.ssh, terminals.ssh);
      unchanged(after.local, terminals.local);
    };
    await checkTerminals();
    await wheel(-80);
    const up = await scroll();
    const afterUp = await readViewport(page);
    console.log(JSON.stringify({ mode, up, afterUp }));
    expect(afterUp).toEqual(viewport);
    expect(up.top).toBeLessThan(down.top);
    await checkTerminals();
    await browser.evaluate(el => { el.scrollTop = 0; });
    await wheel(-80);
    console.log(JSON.stringify({ mode, edge: await scroll(), edgeViewport: await readViewport(page) }));
  });
});

const allocationBoxes = (scope: Locator) => scope.evaluate(root => {
  const size = (selector: string, axis: 'width' | 'height') =>
    parseFloat(getComputedStyle(root.querySelector(selector)!)[axis]);
  return {
    browser: size('.ssh-browser', 'width'), status: size('.ssh-status', 'height'),
    chrome: size('.ssh-pane-chrome', 'height'), terminal: {
      width: size('.terminal-display', 'width'), height: size('.terminal-display', 'height'),
    },
  };
});

test('sshCanvasLayout_usesDeclaredCssAllocations', async ({ page }) => {
  const pane = page.locator('[data-source="tm-ssh"]');
  const scene = async (collapsed: boolean, css?: string) => {
    await start(page);
    if (collapsed) await collapse(page, true, await sample(page));
    if (css) await page.addStyleTag({ content: css });
    await settle(page);
    return allocationBoxes(pane);
  };
  const checkEntry = async (label: string, source: Awaited<ReturnType<typeof scene>>) => {
    const baseline = await sample(page);
    await page.evaluate(id => window.__sshCanvas.watchFits(id), SSH);
    await enter(page);
    const canvas = await allocationBoxes(node(page));
    const current = await sample(page);
    const fits = await page.evaluate(() => window.__sshCanvas.fitCalls());
    const resizes = await page.evaluate(() => window.__sshCanvas.resizeCalls());
    const evidence = JSON.stringify({ label, pane: source, canvas, fits, resizes, sends: current.resizes.slice(baseline.resizes.length) });
    console.log(evidence);
    test.info().annotations.push({ type: 'entry fit', description: evidence });
    expect(canvas.terminal).toEqual(source.terminal);
    expect(canvas.browser).toBe(source.browser);
    // Plan 070 §4.1 B: the relocation fit RUNS and finds nothing to do. Liveness: it must run at all
    // (else the box equality above is never exercised by xterm); safety: it never resizes xterm.
    expect(fits, `${label}: entry fit calls`).toBeGreaterThan(0);
    expect(resizes, `${label}: entry Terminal.resize calls`).toBe(0);
    unchanged(current, baseline);
  };
  const expanded = await scene(false);
  await checkEntry('baseline expanded', expanded);
  const rail = await scene(true);
  await checkEntry('baseline collapsed', rail);
  for (const { label, collapsed, css, delta } of [
    { label: 'status', collapsed: false, css: '.ssh-status { height: 32px }', delta: 6 },
    { label: 'browser', collapsed: false, css: '.ssh-browser:not(.collapsed) { width: 240px; flex-basis: 240px }', delta: -20 },
    { label: 'rail', collapsed: true, css: '.ssh-browser.collapsed { width: 42px; flex-basis: 42px; max-width: min(42px, 40%) }', delta: 12 },
  ]) await test.step(label, async () => {
    const baseline = collapsed ? rail : expanded;
    const source = await scene(collapsed, css);
    expect(source).toEqual({
      browser: baseline.browser + (label === 'status' ? 0 : delta),
      status: baseline.status + (label === 'status' ? delta : 0),
      chrome: baseline.chrome,
      terminal: {
        width: baseline.terminal.width - (label === 'status' ? 0 : delta),
        height: baseline.terminal.height - (label === 'status' ? delta : 0),
      },
    });
    await checkEntry(label, source);
  });
});

const samplePair = (page: Page) => page.evaluate(() => ({
  ssh: window.__sshCanvas.read('tm-ssh'),
  local: window.__sshCanvas.read('tm-local'),
  matched: window.__sshCanvas.read('tm-matched'),
}));

// D61 / backlog 028: the single fit (terminal-core/src/renderPolicy.ts:70) uses
// the old grid's rounded DOM metrics (@xterm/xterm DomRenderer.ts:114–127).
// Only a real renderer swap qualifies.
const KNOWN_RENDER_POLICY_DEMOTION = 'NOT RUN (grid): pre-existing render-policy demotion';
// TerminalEngine.ts:131 BACKEND_RESIZE_DEBOUNCE_MS; armed by scheduleBackendResize at :4046.
const BACKEND_RESIZE_DEBOUNCE_MS = 120;
const sweepNodes = ['ssh', 'local', 'matched'] as const;
const STABILITY_MS = 1000;

type Pair = Awaited<ReturnType<typeof samplePair>>;
function swappedRenderer(before: Sample, after: Sample) {
  return (before.policy === 'gpu' && after.policy === 'dom') ||
    (before.policy === 'dom' && after.policy === 'gpu');
}

function matchedParity(current: Pair, previous = current, evidence?: string) {
  expect(current.ssh.content, evidence).toEqual(current.matched.content);
  expect(current.ssh.actual, evidence).toEqual(current.matched.actual);
  expect(current.ssh.proposal, evidence).toEqual(current.matched.proposal);
  expect(current.ssh.policy, evidence).toBe(current.matched.policy);
  expect(current.ssh.resizes.slice(previous.ssh.resizes.length), evidence)
    .toEqual(current.matched.resizes.slice(previous.matched.resizes.length));
}

function watchStability(page: Page, expected: Pair) {
  return page.evaluate(({ expected, duration }) => new Promise<unknown>(resolve => {
    const start = performance.now();
    const deadline = setTimeout(() => resolve('stability frame polling timed out'), duration + 1000);
    const check = () => {
      for (const [key, id] of [['ssh', 'tm-ssh'], ['local', 'tm-local'], ['matched', 'tm-matched']] as const) {
        const sample = window.__sshCanvas.read(id);
        const before = expected[key];
        if (sample.resizes.length !== before.resizes.length ||
            sample.actual?.cols !== before.actual?.cols || sample.actual?.rows !== before.actual?.rows) {
          clearTimeout(deadline);
          resolve({ id, sample });
          return;
        }
      }
      if (performance.now() - start >= duration) {
        clearTimeout(deadline);
        resolve(null);
      } else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }), { expected, duration: STABILITY_MS });
}

function renderPolicySweep(page: Page, entry: Pair) {
  let previous = entry;
  const residue: Partial<Record<(typeof sweepNodes)[number], Sample>> = {};
  matchedParity(entry);
  for (const s of Object.values(entry)) {
    expect(s.policy).toBe('gpu');
    expect(s.actual).not.toBeNull();
    expect(s.proposal).toEqual(s.actual);
    expect(s.cellHeight).not.toBeNull();
  }
  return async (step: string, dpr: number, z: number) => {
    const initial = await samplePair(page);
    let current = initial;
    const transitioned = sweepNodes.filter(id => swappedRenderer(previous[id], initial[id]));
    const key = ({ cols, rows }: NonNullable<Sample['actual']>) => `${cols}×${rows}`;
    const detailsFor = (pair: Pair) => sweepNodes.map(id => {
      const before = previous[id];
      const after = pair[id];
      const payloads = after.resizes.slice(before.resizes.length);
      return { id, from: before.policy, to: after.policy, transition: transitioned.includes(id),
        visibility: after.visibility,
        entryGrid: key(entry[id].actual!), beforeGrid: key(before.actual!), grid: key(after.actual!), proposal: after.proposal,
        beforeHost: before.content, host: after.content,
        beforeCellHeight: before.cellHeight, cellHeight: after.cellHeight,
        resizeCount: payloads.length, payloads };
    });
    const describe = (pair: Pair) => JSON.stringify({ step, dpr, z, nodes: detailsFor(pair) });
    if (transitioned.length) {
      let lastCounts = '';
      let quietSince = performance.now();
      try {
        await expect.poll(async () => {
          current = await samplePair(page);
          const counts = sweepNodes.map(id => current[id].resizes.length).join(',');
          const now = performance.now();
          if (counts !== lastCounts) {
            lastCounts = counts;
            quietSince = now;
          }
          const sawEachSend = transitioned.every(id => current[id].resizes.length > previous[id].resizes.length);
          return sawEachSend && now - quietSince >= BACKEND_RESIZE_DEBOUNCE_MS;
        }, { timeout: 2500, intervals: [25, 50], message: `PTY debounce did not settle: ${step} (DPR ${dpr})` }).toBe(true);
      } finally {
        const evidence = describe(current);
        test.info().annotations.push({ type: KNOWN_RENDER_POLICY_DEMOTION, description: evidence });
        console.log(evidence);
      }
      const evidence = describe(current);
      expect(await watchStability(page, current), evidence).toBeNull();
    }
    const evidence = describe(current);
    matchedParity(current, previous, evidence);
    const carried: { id: (typeof sweepNodes)[number]; actual: Sample['actual']; proposal: Sample['proposal']; cellHeight: Sample['cellHeight'] }[] = [];
    for (const { id, transition } of detailsFor(current)) {
      const s = current[id];
      const unchangedGrid = s.actual?.cols === previous[id].actual?.cols && s.actual?.rows === previous[id].actual?.rows;
      if (transition || !unchangedGrid || s.resizes.length !== previous[id].resizes.length) delete residue[id];
      expect(s.registered, evidence).toBe(true);
      expect(s.hostId, evidence).toBe(entry[id].hostId);
      expect(s.content, evidence).toEqual(entry[id].content);
      expect(s.policy, evidence).toBe(initial[id].policy);
      expect(s.actual, evidence).toEqual(initial[id].actual);
      expect(s.resizes, evidence).toEqual(transition ? [...previous[id].resizes, s.actual] : previous[id].resizes);
      if (!transition) {
        const baseline = residue[id];
        expect(s.actual, evidence).toEqual((baseline ?? previous[id]).actual);
        expect(s.cellHeight, evidence).toBe((baseline ?? previous[id]).cellHeight);
        expect(s.proposal, evidence).toEqual(baseline ? baseline.proposal : s.actual);
        if (baseline) carried.push({ id, actual: s.actual, proposal: s.proposal, cellHeight: s.cellHeight });
      } else {
        expect(s.proposal, evidence).not.toBeNull();
        expect(s.cellHeight, evidence).not.toBeNull();
        expect(Math.abs(s.proposal!.cols - s.actual!.cols), evidence).toBeLessThanOrEqual(1);
        expect(Math.abs(s.proposal!.rows - s.actual!.rows), evidence).toBeLessThanOrEqual(1);
        expect(Math.abs(s.cellHeight! - previous[id].cellHeight!), evidence).toBeLessThan(1 / s.actual!.rows);
        // SSH and its matched control have already proved the fallback via parity.
        if (s.policy === 'gpu' && id === 'local') expect(s.actual, evidence).toEqual(entry[id].actual);
        // Carry only an already-validated D61 discrepancy, not a new proposal change.
        if (s.proposal!.cols !== s.actual!.cols || s.proposal!.rows !== s.actual!.rows) residue[id] = s;
      }
    }
    if (carried.length) {
      const { x, y } = await page.evaluate(() => window.__sshCanvas.camera());
      const description = JSON.stringify({ step, dpr, z, pan: { x, y }, nodes: carried });
      test.info().annotations.push({ type: 'carried residue', description });
      console.log(`carried residue ${description}`);
    }
    previous = current;
  };
}

async function sweep(page: Page, check: ReturnType<typeof renderPolicySweep>) {
  const { zMin, zMax } = await page.evaluate(() => window.__sshCanvas.camera());
  const dpr = await page.evaluate(() => devicePixelRatio);
  const raster = new Set<number>();
  const tiers = new Set<string>();
  const steps: Viewport[] = [
    { x: 31.25, y: 36.5, z: 1 }, { x: 31.25, y: 36.5, z: zMin },
    { x: 36, y: 41, z: 0.19 }, { x: -900, y: 41, z: 0.55 }, { x: 31, y: 41, z: 0.55 },
    { x: 31, y: 41, z: 1 }, { x: 31, y: 41, z: 1.51 }, { x: 31, y: 41, z: 2.03 },
    { x: 31, y: 41, z: zMax }, { x: 0, y: 0, z: 1 },
  ];
  for (const vp of steps) await test.step(`viewport ${JSON.stringify(vp)}`, async () => {
    await page.evaluate(vp => window.__sshCanvas.viewport(vp), vp);
    const r = Math.max(1, Math.ceil(vp.z / dpr));
    const layer = page.locator('.canvas-raster');
    await expect(layer).toHaveCSS('--canvas-raster-r', String(r));
    await expect(layer).toHaveCSS('--canvas-raster-inv', String(1 / r));
    await expect.poll(() => layer.evaluate(el => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el.parentElement!).transform);
      return [m.e, m.f];
    })).toEqual([vp.x, vp.y]);
    await settle(page);
    raster.add(r);
    tiers.add((await node(page).getAttribute('data-lod'))!);
    await check(`viewport ${JSON.stringify(vp)}`, dpr, vp.z);
  });
  expect(raster.size).toBeGreaterThan(1);
  expect([...tiers].sort()).toEqual(['chip', 'gpu', 'group', 'live', 'snapshot']);
  for (const id of [SSH, LOCAL, null]) {
    await page.evaluate(id => window.__sshCanvas.overlay(id), id);
    if (id) await expect(node(page, id)).toHaveClass(/\boverlaid\b/);
    else await expect(page.locator('.canvas-node.overlaid')).toHaveCount(0);
    await settle(page);
    await check(`overlay ${id ?? 'closed'}`, dpr, 1);
  }
}

async function leave(page: Page) {
  await page.evaluate(() => window.__sshCanvas.leave());
  await expect(page.locator('.canvas-viewport')).toHaveCount(0);
  await settle(page);
}

async function cornersInside(box: Locator, body: Locator) {
  await expect(box).toBeVisible();
  const [a, b] = await Promise.all([box.boundingBox(), body.boundingBox()]);
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.x).toBeGreaterThanOrEqual(b!.x - 0.5);
  expect(a!.y).toBeGreaterThanOrEqual(b!.y - 0.5);
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x + b!.width + 0.5);
  expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + b!.height + 0.5);
}

test('sshCanvasLayout_entryPanZoomLodOverlay_doNotResizeRealXterm', async ({ browser }, info) => {
  for (const dpr of [1, 1.25, 2]) await test.step(`DPR ${dpr}`, async () => {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    try {
      await start(page);
      expect(await page.evaluate(() => devicePixelRatio)).toBe(dpr);
      const source = await sample(page);
      expect(Number.isInteger(source.box!.w)).toBe(false);
      const collapsed = await collapse(page, true, source);
      const baseline = await collapse(page, false, collapsed);
      expect(baseline.actual).toEqual(source.actual);
      await enter(page);
      await screenshot(page, info, `entry-dpr-${dpr}`);
      const entry = await samplePair(page);
      unchanged(entry.ssh, baseline);
      await sweep(page, renderPolicySweep(page, entry));
      const beforeLeave = await samplePair(page);
      await leave(page);
      const returned = await samplePair(page);
      matchedParity(returned, beforeLeave);
      expect(returned.ssh.hostId).toBe(source.hostId);
      unchanged(returned.ssh, { ...baseline, resizes: beforeLeave.ssh.resizes });
    } catch (error) {
      await screenshot(page, info, `failure-dpr-${dpr}`);
      throw error;
    } finally {
      await context.close();
    }
  });
});

test('sshCanvasLayout_toggleResizesOnlyA_andKeepsStatusToolbarVisible', async ({ page }, info) => {
  for (const shape of ['portrait', 'wide']) await test.step(shape, async () => {
    await start(page, shape);
    await enter(page);
    const before = await sample(page);
    const local = await sample(page, LOCAL);
    const body = node(page).locator('.canvas-node-body');
    await screenshot(page, info, `${shape}-expanded`);
    await cornersInside(node(page).locator('.ssh-file-toolbar'), body);
    await cornersInside(node(page).locator('.ssh-status'), body);
    const allocation = () => node(page).locator('.ssh-browser').evaluate(el => parseFloat(getComputedStyle(el).width));
    const expandedWidth = await allocation();
    const after = await collapse(page, true, before);
    expect(after.content!.w + await allocation()).toBe(before.content!.w + expandedWidth);
    unchanged(await sample(page, LOCAL), local);
    await cornersInside(node(page).locator('.ssh-browser-toggle'), body);
    await cornersInside(node(page).locator('.ssh-status'), body);
    await screenshot(page, info, `${shape}-collapsed`);
    const restored = await collapse(page, false, after);
    expect(restored.actual).toEqual(before.actual);
    expect(restored.content).toEqual(before.content);
    await cornersInside(node(page).locator('.ssh-file-toolbar'), body);
    unchanged(await sample(page, LOCAL), local);
  });
});

test('sshCanvasLayout_localNodeRemainsUnchanged', async ({ page }, info) => {
  await start(page);
  const source = await sample(page, LOCAL);
  await page.evaluate(() => window.__sshCanvas.localWidth(510.53125));
  await expect.poll(async () => (await sample(page, LOCAL)).resizes.length).toBe(source.resizes.length + 1);
  const narrow = await sample(page, LOCAL);
  expect(narrow.actual!.cols).toBeLessThan(source.actual!.cols);
  expect(narrow.actual!.rows).toBe(source.actual!.rows);
  await page.evaluate(() => window.__sshCanvas.localWidth(null));
  await expect.poll(async () => (await sample(page, LOCAL)).resizes.length).toBe(narrow.resizes.length + 1);
  await settle(page);
  const baseline = await sample(page, LOCAL);
  expect(baseline.actual).toEqual(source.actual);
  await enter(page);
  await screenshot(page, info, 'local-node');
  const canvas = await sample(page, LOCAL);
  const check = async () => {
    const s = await sample(page, LOCAL);
    expect(s.registered).toBe(true);
    expect(s.hostId).toBe(canvas.hostId);
    unchanged(s, baseline);
  };
  await check();
  const collapsed = await collapse(page, true, await sample(page));
  await check();
  await collapse(page, false, collapsed);
  await check();
  await sweep(page, renderPolicySweep(page, await samplePair(page)));
  const beforeLeave = await sample(page, LOCAL);
  await leave(page);
  unchanged(await sample(page, LOCAL), { ...baseline, resizes: beforeLeave.resizes });
});

test('sshCanvasLayout_stackingAndStripBand', async ({ page }, info) => {
  await start(page);
  await enter(page);
  const collapsed = await collapse(page, true, await sample(page));
  const baseline = await collapse(page, false, collapsed);
  const launch = node(page).locator('.ssh-launch-notice');
  await expect(launch).toContainText('SSH is running');
  const setNotice = (kind: 'prompt' | 'reconnect' | 'plain') => page.evaluate(kind => window.__sshCanvas.notice(kind), kind);
  await setNotice('prompt');
  const prompt = launch.locator('.ssh-prompt');
  await expect(prompt).toBeVisible();
  await screenshot(page, info, 'host-key-prompt');
  await expect(launch).toHaveCSS('z-index', '6');
  await expect(node(page).locator('.ssh-pane-chrome')).toHaveCSS('z-index', '5');
  expect(await prompt.evaluate(el => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  expect(await launch.evaluate(el => {
    const strip = el.querySelector('.ssh-launch-strip')!;
    const wrapper = el.parentElement!;
    const terminal = wrapper.querySelector<HTMLElement>(':scope > .terminal-display')!;
    return { strip: getComputedStyle(strip).height, band: getComputedStyle(wrapper).paddingTop,
      stripOffset: (strip as HTMLElement).offsetTop, terminalOffset: terminal.offsetTop };
  })).toEqual({ strip: '36px', band: '36px', stripOffset: 0, terminalOffset: 36 });
  await settle(page);
  unchanged(await sample(page), baseline);
  await page.evaluate(id => window.__sshCanvas.overlay(id), SSH);
  await expect(node(page)).toHaveClass(/\boverlaid\b/);
  await expect(prompt).toBeVisible();
  await settle(page);
  unchanged(await sample(page), baseline);
  await setNotice('reconnect');
  await expect(launch.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(prompt).toHaveCount(0);
  await screenshot(page, info, 'reconnect-overlay');
  await settle(page);
  unchanged(await sample(page), baseline);
  await page.evaluate(() => window.__sshCanvas.overlay(null));
  await setNotice('plain');
  await expect(launch).toContainText('SSH is running');
  await settle(page);
  unchanged(await sample(page), baseline);
});
