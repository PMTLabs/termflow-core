import { resolveActivation } from '../notificationRouting';

const tabs = [{ id: 'tb-1' }, { id: 'tb-2' }];

describe('resolveActivation', () => {
  it('ignores an activation addressed to a different window', () => {
    // Multi-window: every window receives the emit, only the owner may react. A
    // non-owner must not even steal focus.
    expect(resolveActivation({ windowLabel: 'other', tabId: 'tb-1' }, 'main', tabs))
      .toEqual({ kind: 'ignore', reason: 'window-mismatch' });
  });

  it('activates the tab when the payload names a live tab in this window', () => {
    expect(resolveActivation({ windowLabel: 'main', tabId: 'tb-2' }, 'main', tabs))
      .toEqual({ kind: 'activate', tabId: 'tb-2' });
  });

  it('focuses without navigating when the tab has since been closed', () => {
    // macOS notifications sit in Notification Center indefinitely, so a click can
    // arrive long after its tab is gone. Navigating there would blank the UI:
    // setActiveTab does not validate its payload.
    expect(resolveActivation({ windowLabel: 'main', tabId: 'tb-gone' }, 'main', tabs))
      .toEqual({ kind: 'focus-only', reason: 'tab-closed' });
  });

  it('focuses without navigating when this window has no tabs at all', () => {
    expect(resolveActivation({ windowLabel: 'main', tabId: 'tb-1' }, 'main', []))
      .toEqual({ kind: 'focus-only', reason: 'tab-closed' });
  });

  it('focuses without navigating on a payload carrying no tab id', () => {
    expect(resolveActivation({ windowLabel: 'main', tabId: '' }, 'main', tabs))
      .toEqual({ kind: 'focus-only', reason: 'no-tab-id' });
  });
});
