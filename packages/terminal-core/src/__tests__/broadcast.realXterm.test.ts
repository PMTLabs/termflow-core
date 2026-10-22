import { subscribeUserInput } from '../broadcast';
import { join } from 'path';

test('real xterm 6 user input fires before data, replies do not fire user input', () => {
  // Absolute bundle path deliberately bypasses the workspace's xterm mock mapper.
  const { Terminal } = require(join(process.cwd(), '../../node_modules/@xterm/xterm/lib/xterm.js'));
  const term = new Terminal();
  const order: string[] = [];
  const sub = subscribeUserInput(term, () => order.push('user'));
  expect(sub).not.toBeNull();
  term.onData(() => order.push('data'));
  term.input('x', true);
  expect(order).toEqual(['user', 'data']);
  order.length = 0;
  term.input('reply', false);
  expect(order).toEqual(['data']);
  sub!.dispose(); term.dispose();
});
