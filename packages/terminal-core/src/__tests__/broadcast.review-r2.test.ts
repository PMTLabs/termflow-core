import { describe, deliverBroadcast, queueBroadcastTargetWrite, setBroadcastSink } from '../broadcast';
import { terminalCache } from '../cache';
import { makeEngine, event } from '../testSupport/broadcastHarness';

afterEach(() => { setBroadcastSink(null); for (const entry of terminalCache.values()) entry.disposables.forEach(fn => fn()); terminalCache.clear(); document.body.innerHTML = ''; });

// xterm's mousedown calls focus() before sending the report; the textarea focus
// blurs the previously focused element synchronously, inside that same dispatch.
test('R2.1 an element blur during mousedown focus() does not open the guard before the mouse report', () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  const other = document.createElement('input'); document.body.appendChild(other); other.focus();
  term.element!.addEventListener('mousedown', () => {
    other.blur();
    term._core.coreService.triggerDataEvent('\x1b[<0;10;5M', true);
  }, { once: true });
  term.element!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
  expect(sink).not.toHaveBeenCalled();
});

test('R2.2 a restored keypress that emits nothing expires instead of tagging the next IME commit', async () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  term.keyHandler!(event('A', { shiftKey: true })); await Promise.resolve();
  term.keyHandler!(event('A', { type: 'keypress', shiftKey: true }));
  await Promise.resolve();
  term._core.coreService.triggerDataEvent('漢', true);
  expect(sink.mock.calls).toEqual([['source', { kind: 'text', data: '漢' }]]);
});

test('R2.2 a keypress after an already-broadcast keydown cannot restore it a second time', () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  term.keyHandler!(event('a'));
  term._core.coreService.triggerDataEvent('a', true);
  term.keyHandler!(event('a', { type: 'keypress' }));
  term._core.coreService.triggerDataEvent('x', true);
  expect(sink.mock.calls).toEqual([
    ['source', { kind: 'key', key: expect.objectContaining({ key: 'a' }), srcBytes: 'a' }],
    ['source', { kind: 'text', data: 'x' }],
  ]);
});

test('R2.2 a non-matching keypress never inherits the keydown descriptor', () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  term.keyHandler!(event('e'));
  term.keyHandler!(event('é', { type: 'keypress' }));
  term._core.coreService.triggerDataEvent('é', true);
  expect(sink.mock.calls).toEqual([['source', { kind: 'text', data: 'é' }]]);
});

test.each(['plain', 'win32'])('R2.4 the Ctrl+-/_ zoom shortcut is swallowed and never broadcast (%s source)', mode => {
  const { term, write } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  if (mode === 'win32') term.csiHandlers['?h']([9001]);
  for (const key of ['-', '_']) {
    expect(term.keyHandler!(event(key, { ctrlKey: true, shiftKey: key === '_', code: 'Minus', keyCode: 189 }))).toBe(false);
  }
  expect(write).not.toHaveBeenCalled();
  expect(sink).not.toHaveBeenCalled();
});

test('R2.5 a submit delivered to an unmounted target drops its stale capture mark with the gate', () => {
  const { engine } = makeEngine('target');
  engine.unmount();
  const entry = terminalCache.get('target')!;
  entry.promptGate = { seen: true, armed: true };
  entry.captureMark = { row: 3, col: 2 };
  deliverBroadcast('target', { kind: 'key', key: describe(event('Enter')), srcBytes: '\r' });
  expect(entry.promptGate).toEqual({ seen: true, armed: false });
  expect(entry.captureMark).toBeNull();
});

test('R2.5 unmount freezes target options instead of keeping live getters on the engine', () => {
  const { engine } = makeEngine('target', 'pwsh');
  let shell = 'pwsh';
  (engine as any).opts.shellType = () => shell;
  engine.unmount();
  shell = 'bash';
  expect(terminalCache.get('target')!.getBroadcastOptions!().shellType).toBe('pwsh');
});

test('R2.6 a terminal-id queue keeps order across the target mounting mid-flight', async () => {
  const order: string[] = [];
  let release!: () => void;
  const fallback = jest.fn((_id: string, data: string) => {
    order.push(data);
    return data === 'first' ? new Promise<void>(resolve => { release = resolve; }) : undefined;
  });
  queueBroadcastTargetWrite(fallback, 'tm-1', 'first');
  const raw = jest.fn((_pid: string, data: string) => { order.push(data); });
  queueBroadcastTargetWrite(raw, 'pid-1', 'second', 'tm-1');
  expect(order).toEqual(['first']);
  release();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(order).toEqual(['first', 'second']);
  expect(raw).toHaveBeenCalledWith('pid-1', 'second');
});
