/**
 * @jest-environment jsdom
 *
 * Guards the InputHandler bail-out rule: native editing shortcuts (Ctrl+V etc.)
 * must work in ordinary form fields, while the terminal keeps owning its own
 * input. Pure helper → no InputHandler dependency graph needed.
 */
import { isEditableNonTerminalTarget } from '../inputTargets';

describe('isEditableNonTerminalTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true for a plain text input (so native paste wins)', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    expect(isEditableNonTerminalTarget(input)).toBe(true);
  });

  it('returns true for textarea, select, and contenteditable', () => {
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    // jsdom doesn't derive `isContentEditable` from the attribute (real browsers
    // do); set the property so we exercise the same check production relies on.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.append(textarea, select, editable);

    expect(isEditableNonTerminalTarget(textarea)).toBe(true);
    expect(isEditableNonTerminalTarget(select)).toBe(true);
    expect(isEditableNonTerminalTarget(editable)).toBe(true);
  });

  it('returns false for the terminal xterm helper textarea (terminal keeps the key)', () => {
    const term = document.createElement('div');
    term.className = 'xterm';
    const helper = document.createElement('textarea');
    helper.className = 'xterm-helper-textarea';
    term.appendChild(helper);
    document.body.appendChild(term);

    expect(isEditableNonTerminalTarget(helper)).toBe(false);
  });

  it('returns false for an editable field nested in .terminal-display', () => {
    const display = document.createElement('div');
    display.className = 'terminal-display';
    const inner = document.createElement('textarea');
    display.appendChild(inner);
    document.body.appendChild(display);

    expect(isEditableNonTerminalTarget(inner)).toBe(false);
  });

  it('returns false for non-editable elements and null', () => {
    const div = document.createElement('div');
    const button = document.createElement('button');
    document.body.append(div, button);

    expect(isEditableNonTerminalTarget(div)).toBe(false);
    expect(isEditableNonTerminalTarget(button)).toBe(false);
    expect(isEditableNonTerminalTarget(null)).toBe(false);
  });
});
