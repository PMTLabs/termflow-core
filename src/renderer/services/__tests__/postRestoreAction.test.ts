import { resolvePostRestoreAction } from '../postRestoreAction';

describe('resolvePostRestoreAction', () => {
  it('creates a default tab when nothing was restored', () => {
    expect(
      resolvePostRestoreAction({ restored: false, pendingOpenPath: undefined, tabCount: 0 }),
    ).toBe('createDefaultTab');
  });

  it('creates a default tab (rooted at the pending path) when nothing was restored, even with a pending path', () => {
    expect(
      resolvePostRestoreAction({ restored: false, pendingOpenPath: '/some/folder', tabCount: 0 }),
    ).toBe('createDefaultTab');
  });

  it('opens the pending folder as an extra tab when a session was restored and a folder is pending', () => {
    expect(
      resolvePostRestoreAction({ restored: true, pendingOpenPath: '/some/folder', tabCount: 3 }),
    ).toBe('openFolderTab');
  });

  it('opens the pending folder even when the restored session had zero tabs', () => {
    expect(
      resolvePostRestoreAction({ restored: true, pendingOpenPath: '/some/folder', tabCount: 0 }),
    ).toBe('openFolderTab');
  });

  it('creates a default tab when the session "restored" successfully but had zero tabs', () => {
    expect(
      resolvePostRestoreAction({ restored: true, pendingOpenPath: undefined, tabCount: 0 }),
    ).toBe('createDefaultTab');
  });

  it('does nothing when the restored session already has tabs and no folder is pending', () => {
    expect(
      resolvePostRestoreAction({ restored: true, pendingOpenPath: undefined, tabCount: 2 }),
    ).toBe('none');
  });
});
