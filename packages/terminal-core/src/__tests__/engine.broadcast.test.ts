import { deliverBroadcast, setBroadcastSink } from '../broadcast';
import { terminalCache } from '../cache';
import { makeEngine, event } from '../testSupport/broadcastHarness';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

afterEach(() => { setBroadcastSink(null); for (const entry of terminalCache.values()) entry.disposables.forEach(fn => fn()); terminalCache.clear(); document.body.innerHTML = ''; });
test('plain a and Win32 Ctrl+C falling through xterm emit key units', () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  expect(term.keyHandler!(event('a'))).toBe(true);
  term._core.coreService.triggerDataEvent('a', true);
  expect(sink.mock.calls[0][1]).toMatchObject({ kind: 'key', key: { key: 'a' }, srcBytes: 'a' });
  term.csiHandlers['?h']([9001]);
  expect(term.keyHandler!(event('c', { ctrlKey: true }))).toBe(true);
  term._core.coreService.triggerDataEvent('\x03', true);
  expect(sink.mock.calls[1][1]).toMatchObject({ kind: 'key', key: { key: 'c' }, srcBytes: '\x03' });
  expect(sink).toHaveBeenCalledTimes(2);
});
test('replies and unflagged data never emit; IME emits text', () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  term.emitReply('\x1b[?1;2c'); term.emitReply('\x1b[I');
  expect(sink).not.toHaveBeenCalled();
  term._core.coreService.triggerDataEvent('日本語', true);
  expect(sink).toHaveBeenCalledWith('source', { kind: 'text', data: '日本語' });
});
test('B6 delivered paste consumes pendingUserInput before the next terminal reply', () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  deliverBroadcast('source', { kind: 'paste', text: 'hello' });
  term.emitReply('\x1b[?1;2c');
  expect(sink).not.toHaveBeenCalled();
});
test('B3 pointerdown then microtask then mousedown report is suppressed; document drag and wheel too', async () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  const element = term.element!;
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  await Promise.resolve();
  // xterm reports synchronously in its mouse-event handler, AFTER window capture.
  const report = () => term._core.coreService.triggerDataEvent('\x1b[<0;1;1M', true);
  element.addEventListener('mousedown', report);
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
  await Promise.resolve();
  for (const type of ['mousemove', 'mouseup']) {
    document.addEventListener(type, report, { once: true });
    document.dispatchEvent(new MouseEvent(type, { bubbles: true, buttons: type === 'mousemove' ? 1 : 0 }));
    await Promise.resolve();
  }
  element.addEventListener('wheel', report);
  element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
  await Promise.resolve();
  expect(sink).not.toHaveBeenCalled();
  term._core.coreService.triggerDataEvent('a', true);
  expect(sink).toHaveBeenCalledTimes(1);
});
test('native bracketed paste emits one raw paste and no text unit', async () => {
  const { term } = makeEngine(); const sink = jest.fn(); setBroadcastSink(sink);
  term.bracketedPasteMode = true;
  term.element!.addEventListener('paste', () => term.paste('x\ny'));
  const paste = new Event('paste', { bubbles: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'x\ny' } });
  term.element!.dispatchEvent(paste);
  await Promise.resolve();
  expect(sink.mock.calls).toEqual([['source', { kind: 'paste', text: 'x\ny' }]]);
});
test.each(['shift', 'cmd', 'option', 'word', 'kitty', 'win32'])('direct %s write emits exactly once', site => {
  const { term } = makeEngine('source', 'bash', site === 'cmd' || site === 'option');
  const sink = jest.fn(); setBroadcastSink(sink);
  if (site === 'kitty') term.csiHandlers['>u']([3]);
  if (site === 'win32') term.csiHandlers['?h']([9001]);
  const e = site === 'shift' ? event('Enter', { shiftKey: true })
    : site === 'cmd' ? event('ArrowLeft', { metaKey: true })
    : site === 'option' ? event('ArrowLeft', { altKey: true })
    : site === 'word' ? event('Backspace', { ctrlKey: true })
    : event('a', site === 'kitty' ? { ctrlKey: true } : {});
  expect(term.keyHandler!(e)).toBe(false);
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink.mock.calls[0][1].kind).toBe('key');
});
test('broadcast member suppresses suggestion interception and source-only history replacement', () => {
  const { engine, term, write } = makeEngine();
  (engine as any).opts.broadcastActive = () => true;
  engine.setSuggestPopupState('focused');
  expect(term.keyHandler!(event('Enter'))).toBe(true);
  engine.insertCommand('source-only history command');
  expect(write).not.toHaveBeenCalled();
});

test('missing private input hook fails closed for keys, text and paste', () => {
  const { engine, term, container } = makeEngine();
  engine.unmount();
  (term as any)._core.coreService.onUserInput = undefined;
  engine.mount(container);
  const sink = jest.fn(); setBroadcastSink(sink);
  engine.paste('x'); term.emitData('reply');
  term.keyHandler!(event('Enter', { shiftKey: true }));
  expect(terminalCache.get('source')!.broadcastAvailable).toBe(false);
  expect(sink).not.toHaveBeenCalled();
});

test('write-site census classifies every engine bridge write (CRLF normalized)', () => {
  const source = readFileSync(join(__dirname, '../TerminalEngine.ts'), 'utf8').replace(/\r\n/g, '\n');
  const ast = ts.createSourceFile('TerminalEngine.ts', source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'this.bridge.write') {
      count++;
      let block: ts.Node = node;
      while (block.parent && !ts.isBlock(block)) block = block.parent;
      let method: ts.Node = node;
      while (method.parent && !ts.isMethodDeclaration(method)) method = method.parent;
      const excluded = (ts.isMethodDeclaration(method) && method.name.getText(ast) === 'insertCommand')
        || node.arguments[1]?.getText(ast) === 'this.kbState.queryResponse()';
      const tail = source.slice(node.end, block.end);
      expect({ site: node.getText(ast), classified: excluded || /emitKeyBroadcast\(|emitBroadcast\(/.test(tail) })
        .toMatchObject({ classified: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(count).toBe(9);
});
