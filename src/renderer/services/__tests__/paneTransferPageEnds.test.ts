/** @jest-environment jsdom */
import { PaneIncarnations, type PaneBridge, type PaneRequest } from '../paneIncarnations';
import { gatedBridge } from '../../__testFixtures__/gatedBridge';
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function pages() {
  const gates = gatedBridge();
  const requests: Record<string, PaneRequest[]> = { source: [], destination: [] };
  const client = (label: string, pg: number) => new PaneIncarnations((async (name: string, args: any) => {
    if (name === 'register_page') return { status: 'Registered', wi: pg, pg };
    requests[label].push(args.request);
    return gates.command(label)(args);
  }) as PaneBridge);
  return { gates, requests, source: client('source', 11), destination: client('destination', 22),
    ack: (label: string, index: number, result: any = { status: 'Ok' }) => gates.release(label, index, { status: 'Ack', result }) };
}
const pane = { paneId: 'pn-move', leaf: 'tm-move' };
const control = { paneId: 'pn-control', leaf: 'tm-control' };

test.each([false, true])('ending the source with taken=%s never closes the transferred pane or prevents acknowledged destination installation', async taken => {
  jest.useFakeTimers(); const h = pages();
  try {
    h.source.prepare([pane]); h.destination.prepare([control]); await flush();
    h.ack('source', 0); h.ack('destination', 0); await flush();
    const sourcePi = await h.source.capture(pane.leaf, pane.paneId)!;
    const controlPi = await h.destination.capture(control.leaf, control.paneId)!;
    const staging = h.source.stash('move', [pane], { title: 'carried' }); await flush();
    h.ack('source', 1); expect((await staging).status).toBe('Ok');
    expect((await h.source.stash('move', [pane], { title: 'duplicate' })).status).toBe('Rejected');
    expect(h.source.isSuppressed(h.source.capture(pane.leaf, pane.paneId)!)).toBe(true);
    expect(h.source.captureClose(pane.leaf, pane.paneId)).toBe(h.source.capture(pane.leaf, pane.paneId));
    expect(h.requests.source).toHaveLength(2);
    const install = jest.fn();
    const installing = h.destination.installTransfer('move', [pane], install);
    await flush(); expect(h.requests.destination[1].op).toEqual({ kind: 'take', tx: 'move' });
    if (!taken) h.source.stop();
    h.ack('destination', 1, { status: 'Taken', payload: { panes: [pane], ui: { title: 'carried' } } }); await flush();
    if (taken) h.source.stop();
    expect(h.requests.destination[2].op).toMatchObject({ kind: 'adopt', pairs: [{ pi: { pg: 22, seq: 2 } }] });
    expect(install).not.toHaveBeenCalled();
    expect(await h.source.admit(Promise.resolve(sourcePi), 'Mount')).toEqual({ status: 'Rejected', message: 'page ended' });
    h.ack('destination', 2); await installing;
    expect(install).toHaveBeenCalledTimes(1); expect(install).toHaveBeenCalledWith({ title: 'carried' });
    expect(await h.destination.capture(pane.leaf, pane.paneId)!).toEqual({ pg: 22, seq: 2 });
    expect(await h.destination.capture(control.leaf, control.paneId)!).toEqual(controlPi);
    expect(h.requests.source.map(r => r.op.kind)).toEqual(['enter', 'stash']);
    expect(h.requests.destination.map(r => r.op.kind)).toEqual(['enter', 'take', 'adopt']);
  } finally { h.source.stop(); h.destination.stop(); expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); }
});

test.each([false, true])('ending destination before delivery of an adopt acknowledgment never installs, with backend-applied=%s', async applied => {
  jest.useFakeTimers(); const h = pages();
  try {
    h.source.prepare([control]); h.destination.prepare([{ paneId: 'pn-destination-control', leaf: 'tm-destination-control' }]); await flush();
    h.ack('source', 0); h.ack('destination', 0); await flush();
    const controlPi = await h.source.capture(control.leaf, control.paneId)!;
    const install = jest.fn();
    const outcome = h.destination.installTransfer('ending', [pane], install).catch(error => error.message);
    await flush(); h.ack('destination', 1, { status: 'Taken', payload: { panes: [pane] } }); await flush();
    const adopt = h.requests.destination[2];
    expect(adopt.op).toMatchObject({ kind: 'adopt', pairs: [{ pi: { pg: 22, seq: 2 } }] });
    expect(h.requests.destination).toHaveLength(3);
    // The native gate tests exercise both sides of application. At the renderer
    // boundary neither a late successful reply nor a rejected dead-page call can install.
    h.destination.stop();
    h.ack('destination', 2, applied ? { status: 'Ok' } : { status: 'Rejected', message: 'page ended before application' });
    expect(await outcome).toBe('transfer adopt Rejected'); await flush();
    expect(install).not.toHaveBeenCalled(); expect(h.requests.destination).toHaveLength(3);
    expect(await h.source.capture(control.leaf, control.paneId)!).toEqual(controlPi);
    expect(h.requests.source).toHaveLength(1);
  } finally { h.source.stop(); h.destination.stop(); expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); }
});
