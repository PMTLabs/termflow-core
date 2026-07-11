import { pickCopyText } from '../TerminalEngine';

// Under mouse-tracking mode xterm clears the live selection on the very pty input
// (mouse move / the right-click that opens the menu) that precedes a copy, so the
// context menu must fall back to a selection retained during the drag. pickCopyText
// encodes that choice; pure so it is unit-testable without an xterm instance.
describe('pickCopyText', () => {
  it('prefers the live selection when present', () => {
    expect(pickCopyText('live', 'retained', true)).toBe('live');
    expect(pickCopyText('live', 'retained', false)).toBe('live');
  });
  it('falls back to the retained selection while mouse tracking is active', () => {
    expect(pickCopyText('', 'retained', true)).toBe('retained');
  });
  it('ignores the retained selection in a normal shell (no mouse tracking)', () => {
    // Retaining there would leave a stale value enabling Copy after the user moved
    // on; the live selection is authoritative in normal mode.
    expect(pickCopyText('', 'retained', false)).toBe('');
  });
  it('returns empty when there is nothing to copy', () => {
    expect(pickCopyText('', '', true)).toBe('');
  });
});
