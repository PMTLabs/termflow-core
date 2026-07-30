import { resolveActivation } from '../notificationRouting';

const tabs = [{ id: 'tb-1' }, { id: 'tb-2' }];

describe('resolveActivation', () => {
  it('ignores an activation for another window naming a tab we do not have', () => {
    // Multi-window: every window receives the emit. A window that neither originated
    // the notification nor holds the tab must not react at all — not even steal focus.
    expect(resolveActivation({ windowLabel: 'other', tabId: 'tb-elsewhere' }, 'main', tabs))
      .toEqual({ kind: 'ignore', reason: 'window-mismatch' });
  });

  it('activates a tab this window holds even when another window raised the notification', () => {
    // The tab is the durable identity; the window label is only where it lived when the
    // notification was raised. If the tab was detached into this window in between, this
    // window is the one that can actually serve the click — the originating window would
    // otherwise focus itself and show nothing.
    expect(resolveActivation({ windowLabel: 'other', tabId: 'tb-2' }, 'main', tabs))
      .toEqual({ kind: 'activate', tabId: 'tb-2' });
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
