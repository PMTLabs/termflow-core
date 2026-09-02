/**
 * plan/025 §2.6 (Stream B) — LayoutManager wiring.
 *
 * A SOURCE-DERIVED tripwire, not a behavioural test: `LayoutManager` cannot be
 * mounted under the root Jest config for the same reason `TerminalDisplay` can't
 * (see `terminalDisplayRelocationWiring.test.ts`'s header) — it pulls in the real
 * Redux store, `StateManager`, and several untransformed CSS imports through its
 * own module graph. What THIS file pins is that the component still has the shape
 * the plan's acceptance criteria assume: the continuity banner's copy is on
 * screen, the save dialog's scope radio exists, Load actually consults the dirty
 * flag before switching, and Cancel on that gate dispatches nothing.
 *
 * Matched against source with comments stripped — three tests in this repo have
 * already been satisfied by their own explanatory prose (see `copyLinkWiring`'s
 * header), and a regex is blind to the difference between a comment naming a
 * behaviour and the behaviour itself.
 */
import * as path from 'path';
import { readSource } from '../../utils/readSource';

const code = (file: string): string =>
  readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const SOURCE = code(path.join(__dirname, '..', 'LayoutManager.tsx'));

/** The body of a top-level `const <name> = ...` in the component, up to the next
 *  one. Deliberately NOT delimited on `};` — these bodies contain object literals
 *  that end that way, and slicing on the first match silently truncates the region
 *  under test into one that trivially passes. */
const declBody = (name: string): string => {
  const lines = SOURCE.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`  const ${name} =`));
  if (start === -1) throw new Error(`declBody: no top-level declaration for ${name}`);
  const rest = lines.slice(start + 1).findIndex((l) => /^ {2}const \w+ =/.test(l));
  return lines.slice(start, rest === -1 ? lines.length : start + 1 + rest).join('\n');
};

describe('the continuity banner (Task B3 / P1a)', () => {
  it('renders permanently (not gated behind any conditional) with the exact plan copy', () => {
    expect(SOURCE).toContain('<div className="continuity-banner">');
    expect(SOURCE).toContain('Your processes keep running.');
    expect(SOURCE).toContain(
      'Loading or switching layouts only',
    );
    expect(SOURCE).toContain(
      'shells, agent CLIs and long-running commands in the',
    );
    expect(SOURCE).toContain('nothing is terminated.');
  });

  it('is not wrapped in an `{someFlag && (...)}`-style guard the way the error banner is', () => {
    const bannerAt = SOURCE.indexOf('<div className="continuity-banner">');
    expect(bannerAt).toBeGreaterThan(-1);
    // The nearest text before the banner's own opening tag must not be a JSX
    // conditional opener — that would mean the banner is INSIDE a `{flag && (`
    // block rather than rendered unconditionally.
    const immediatelyBefore = SOURCE.slice(Math.max(0, bannerAt - 40), bannerAt);
    expect(immediatelyBefore).not.toMatch(/&&\s*\(\s*$/);
  });
});

describe('the header layout (GUI pass)', () => {
  it('puts the title and close button in their own row, above the actions', () => {
    // The header was one `space-between` row holding the title and all five
    // buttons, so every action added competed with the title for width. Two
    // rows is what makes room for the sixth.
    const header = SOURCE.slice(
      SOURCE.indexOf('<div className="layout-manager-header">'),
      SOURCE.indexOf('<div className="continuity-banner">'),
    );
    expect(header).toContain('<div className="layout-manager-titlerow">');
    // The close button moved INTO the title row — it is not an action.
    const titlerowAt = header.indexOf('layout-manager-titlerow');
    const actionsAt = header.indexOf('layout-manager-actions');
    expect(titlerowAt).toBeGreaterThan(-1);
    expect(actionsAt).toBeGreaterThan(titlerowAt);
    expect(header.indexOf('btn btn-close')).toBeGreaterThan(titlerowAt);
    expect(header.indexOf('btn btn-close')).toBeLessThan(actionsAt);
  });

  it('gives Revert its own accent class rather than the shared secondary one', () => {
    // `.btn-secondary` is worn by Import/Export, Reset Layout, Update, Rename
    // and Cancel — Revert was indistinguishable from all of them despite being
    // the one header action that replaces the whole workspace.
    const revertAt = SOURCE.indexOf('onClick={handleRevert}');
    expect(revertAt).toBeGreaterThan(-1);
    const button = SOURCE.slice(SOURCE.lastIndexOf('<button', revertAt), revertAt);
    expect(button).toContain('btn btn-warning');
    expect(button).not.toContain('btn-secondary');
  });
});

describe('the save dialog scope radio (Task B5)', () => {
  const dialog = SOURCE.slice(
    SOURCE.indexOf('Save Current Layout</h3>'),
    SOURCE.indexOf('{/* Rename Dialog */}'),
  );

  it('offers two radios sharing one group name', () => {
    expect(dialog.match(/name="save-scope"/g)).toHaveLength(2);
    expect(dialog).toContain('value="workspace"');
    expect(dialog).toContain('value="tab"');
  });

  it('defaults the scope to workspace', () => {
    expect(SOURCE).toContain("useState<'workspace' | 'tab'>('workspace')");
  });

  it('shows the real active tab title in the tab option, not a placeholder', () => {
    expect(dialog).toMatch(/Only this tab \("\{activeTab\?\.title/);
  });

  it('passes the chosen scope (and tab id only for tab scope) into the save thunk', () => {
    expect(SOURCE).toMatch(/saveCurrentLayout\(\{[\s\S]*?scope:\s*saveScope,[\s\S]*?tabId:\s*saveScope === 'tab'/);
  });
});

describe('Load is guarded by the dirty check (Task B4)', () => {
  const handler = declBody('handleLoadLayout');

  /**
   * EXPECTATION CHANGED (pre-review MEDIUM). This originally required the
   * literal `scope !== 'tab' && isDirty` — i.e. that the handler read the
   * Redux `isDirty` value directly. That value is only ever recomputed when the
   * panel OPENS (`recomputeDirty` has exactly one other dispatch site and
   * nothing recomputes it on store changes), so it goes stale the moment the
   * workspace changes while the panel stays open — an API/MCP tab creation, a
   * pane-split shortcut, a terminal exiting — and the gate waved those exact
   * cases through. The handler now re-checks at click time, so what is pinned
   * here is the re-check, not the stale read.
   */
  it('re-checks dirtiness at click time rather than trusting the panel-open value', () => {
    expect(handler).toContain('dispatch(recomputeDirty())');
    expect(handler).toContain('setDirtyGateLayoutId(layoutId)');
    // The gate returns early — `performLoad` (the actual switch) must NOT run in
    // the same branch as opening the gate.
    expect(handler).toMatch(/setDirtyGateLayoutId\(layoutId\);\s*return;/);
    // The branch is taken on the FRESH value, never on the Redux field.
    expect(handler).toMatch(/if \(dirtyNow\)/);
  });

  it('falls back to the last known value if the re-check throws, never to "clean"', () => {
    // A capture failure must not silently downgrade the gate into a switch.
    expect(handler).toMatch(/let dirtyNow = isDirty;/);
  });

  it('a tab-scoped layout bypasses the gate entirely (plan/025 §2.4)', () => {
    // Returns before the dirty check is even reached.
    expect(handler).toMatch(/layout\?\.scope === 'tab'[\s\S]*?return;/);
  });

  it('a clean workspace switches immediately, with no dialog in the way', () => {
    expect(handler).toContain('performLoad(layoutId);');
  });

  it('routes a tab-scoped load through loadTabScopedLayout, not the whole-workspace loadLayout', () => {
    const performLoad = declBody('performLoad');
    expect(performLoad).toMatch(/scope === 'tab'[\s\S]*?loadTabScopedLayout\(layoutId\)/);
    expect(performLoad).toContain('dispatch(loadLayout(layoutId))');
  });
});

describe('the dirty gate dialog itself (Task B4)', () => {
  it('renders UnsavedChangesDialog wired to the three gate handlers', () => {
    expect(SOURCE).toContain('<UnsavedChangesDialog');
    expect(SOURCE).toMatch(/isOpen=\{dirtyGateLayoutId !== null\}/);
    expect(SOURCE).toContain('onSave={handleDirtyGateSave}');
    expect(SOURCE).toContain('onDiscard={handleDirtyGateDiscard}');
    expect(SOURCE).toContain('onCancel={handleDirtyGateCancel}');
  });

  it('Cancel dispatches nothing — it only closes the gate', () => {
    const at = SOURCE.indexOf('const handleDirtyGateCancel = () => {');
    expect(at).toBeGreaterThan(-1);
    const cancelBody = SOURCE.slice(at, SOURCE.indexOf('};', at));
    expect(cancelBody).toContain('setDirtyGateLayoutId(null)');
    expect(cancelBody).not.toContain('dispatch(');
  });

  it('Discard proceeds with the originally-requested load', () => {
    const at = SOURCE.indexOf('const handleDirtyGateDiscard = () => {');
    expect(at).toBeGreaterThan(-1);
    const body = SOURCE.slice(at, SOURCE.indexOf('};', at));
    expect(body).toContain('performLoad(id)');
  });

  it("Save opens the save dialog rather than saving immediately, and defaults its scope to workspace", () => {
    const at = SOURCE.indexOf('const handleDirtyGateSave = () => {');
    expect(at).toBeGreaterThan(-1);
    const body = SOURCE.slice(at, SOURCE.indexOf('};', at));
    expect(body).toContain('setPendingLoadAfterSave(id)');
    expect(body).toContain("setSaveScope('workspace')");
    expect(body).toContain('setShowSaveDialog(true)');
  });

  it('the main panel releases its own focus trap while the gate is open (exactly one dialog-a11y owner)', () => {
    const at = SOURCE.indexOf('useDialogA11y(mainRef, {');
    expect(at).toBeGreaterThan(-1);
    const mainCall = SOURCE.slice(at, SOURCE.indexOf('});', at));
    expect(mainCall).toMatch(/!showSaveDialog\s*&&\s*!showRenameDialog\s*&&\s*!dirtyGateLayoutId/);
  });
});

describe('the Undo toast (Task B4 step 3)', () => {
  it('fires a sticky toast with an inline Undo action on every successful switch', () => {
    const at = SOURCE.indexOf('const fireUndoToast = (label: string) => {');
    expect(at).toBeGreaterThan(-1);
    const body = SOURCE.slice(at, SOURCE.indexOf('};', SOURCE.indexOf('};', at) + 1));
    expect(body).toContain('registerToastAction(actionId');
    expect(body).toMatch(/sticky:\s*true/);
    expect(body).toMatch(/action:\s*\{\s*label:\s*'Undo',\s*actionId\s*\}/);
    expect(body).toContain('dispatch(revertWorkspace())');
  });

  it('performLoad fires the undo toast after closing the panel, on both load paths', () => {
    const at = SOURCE.indexOf('const performLoad = async (layoutId: string) => {');
    const body = SOURCE.slice(at, SOURCE.indexOf('};', SOURCE.indexOf('};', at) + 1));
    expect(body).toContain('fireUndoToast(');
  });

  /**
   * Round-2 external review, both reviewers (report 179/180). The test above
   * identifies "a successful switch" by the mere PRESENCE of `fireUndoToast(`
   * in `performLoad`, which cannot distinguish firing it on commit from firing
   * it unconditionally. Both load thunks RESOLVE on a load that deliberately
   * did nothing — a tab-scoped load refused because a replacement owns the
   * workspace, a workspace load superseded by a newer one — so `unwrap()` not
   * throwing is not success. The wrong implementation this pins out:
   *
   *     await dispatch(loadLayout(layoutId)).unwrap();
   *     dispatch(setShowLayoutManager(false));
   *     fireUndoToast(layout?.name ?? 'layout');   // fires for a no-op switch
   *
   * which posted 'Switched to "X" · Undo' for a switch that never happened and
   * armed the Undo against whichever snapshot was in the one-deep slot.
   */
  it('performLoad gates the close and the toast on `committed`, not merely on not-throwing', () => {
    const at = SOURCE.indexOf('const performLoad = async (layoutId: string) => {');
    const body = SOURCE.slice(at, SOURCE.indexOf('};', SOURCE.indexOf('};', at) + 1));
    // The result is destructured, and it short-circuits before the two
    // success-only effects.
    expect(body).toMatch(/const\s*\{\s*committed\s*\}\s*=/);
    expect(body).toMatch(/if\s*\(!committed\)/);
    const guardAt = body.indexOf('if (!committed)');
    expect(guardAt).toBeGreaterThan(-1);
    const closeAt = body.indexOf('setShowLayoutManager(false)');
    expect(closeAt).toBeGreaterThan(guardAt);
    expect(body.indexOf('fireUndoToast(')).toBeGreaterThan(guardAt);
    // ...and the refusal is reported rather than swallowed.
    expect(body.slice(guardAt)).toContain('addToast(');
    // The `return` is what makes the condition a GATE rather than a comment.
    // Round-3 review: asserting only that the effects come AFTER the `if` is
    // satisfied by a branch that toasts and then falls straight through into
    // them. Asserted as "a return occurs between the guard and the first
    // success-only effect", which is exactly the property a fall-through
    // breaks.
    expect(body.slice(guardAt, closeAt)).toContain('return;');
  });

  /**
   * Same class, the other refusing operation. `resetToDefaultLayout` declines
   * while a replacement owns the workspace, and it owns HALF the reset — the
   * undo slot and the identity baseline — while `resetLayoutTracking` owns the
   * Redux half. Dispatching the Redux half regardless is how the two come
   * apart: tracking torn up for a workspace that was never reset. The wrong
   * implementation is the one this branch shipped in `f422700`:
   *
   *     StateManager.resetToDefaultLayout(dispatch);   // return value dropped
   *     dispatch(resetLayoutTracking());
   */
  it('confirmReset gates its Redux half on the reset actually happening', () => {
    const at = SOURCE.indexOf('const confirmReset = () => {');
    expect(at).toBeGreaterThan(-1);
    const body = SOURCE.slice(at, SOURCE.indexOf('};', SOURCE.indexOf('};', at) + 1));
    expect(body).toMatch(/if\s*\(!StateManager\.resetToDefaultLayout\(dispatch\)\)/);
    const guardAt = body.indexOf('if (!StateManager.resetToDefaultLayout(dispatch))');
    const trackingAt = body.indexOf('resetLayoutTracking()');
    expect(trackingAt).toBeGreaterThan(guardAt);
    // Same gate/fall-through distinction as `performLoad` above.
    expect(body.slice(guardAt, trackingAt)).toContain('return;');
  });

  it('the header Revert button is enabled only while an undo snapshot exists', () => {
    const at = SOURCE.indexOf('onClick={handleRevert}');
    expect(at).toBeGreaterThan(-1);
    const nearby = SOURCE.slice(at, at + 200);
    expect(nearby).toMatch(/disabled=\{!undoSnapshot/);
  });
});

describe('at most ONE live Undo toast, mirroring the one-deep undo slot', () => {
  /**
   * `layoutUndo` holds a single snapshot. After A -> B -> C, a surviving
   * 'Switched to "B" ... Undo' toast still calls `revertWorkspace()`, which
   * restores the snapshot taken before C — returning the user to B while its
   * own text promises the workspace from before B. Retiring the previous toast
   * is what keeps the affordance honest, and it is also the only thing that
   * unregisters a handler for a toast dismissed WITHOUT clicking Undo.
   */
  it('retires the previous Undo toast before firing a new one', () => {
    const body = declBody('fireUndoToast');
    // The retire must come FIRST — after the new toast is recorded in the ref it
    // would retire the new one instead of the old.
    expect(body).toContain('retireUndoToast()');
    expect(body).toContain('addToast');
    expect(body.indexOf('retireUndoToast()')).toBeLessThan(body.indexOf('addToast'));
  });

  it('retiring both unregisters the handler and removes the toast', () => {
    const body = declBody('retireUndoToast');
    expect(body).toContain('unregisterToastAction(');
    expect(body).toContain('removeToast(');
  });

  it('passes an explicit toast id, so the toast it retires is the one it created', () => {
    const body = declBody('fireUndoToast');
    expect(body).toContain('const toastId =');
    expect(body).toContain('id: toastId');
  });

  it('retires the toast whenever the undo slot empties, not only on paths it initiated', () => {
    // The subscription is the one signal that covers a revert triggered from the
    // header button, the toast itself, or anywhere else.
    const subAt = SOURCE.indexOf('subscribeUndo(update)');
    expect(subAt).toBeGreaterThan(-1);
    const effect = SOURCE.slice(SOURCE.lastIndexOf('useEffect', subAt), subAt);
    expect(effect).toContain('if (!next) retireUndoToast();');
  });
});

describe('window.confirm is fully replaced by ConfirmDialog (Task B6)', () => {
  it('no window.confirm calls remain in the component', () => {
    expect(SOURCE).not.toContain('window.confirm');
  });

  it('delete, update and reset each render their own ConfirmDialog', () => {
    // EXPECTATION CHANGED. This asserted `toHaveLength(3)` — an exact census of
    // every ConfirmDialog in the file — and broke the moment an unrelated
    // feature added a fourth (the Restore Running CLIs confirmation). The count
    // was never the property: Task B6 requires that each of these three actions
    // has its OWN dialog rather than sharing one, which the three distinct
    // `isOpen` bindings below say exactly, without forbidding a fourth dialog
    // for something else. A total is a claim about the whole file, and it goes
    // stale every time the file grows.
    expect((SOURCE.match(/<ConfirmDialog/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // Distinct bindings is what "its own" means, and is the part a
    // shared-dialog refactor would actually break.
    expect(new Set([
      SOURCE.indexOf('isOpen={pendingDeleteId !== null}'),
      SOURCE.indexOf('isOpen={pendingUpdateId !== null}'),
      SOURCE.indexOf('isOpen={pendingReset}'),
    ]).size).toBe(3);
    expect(SOURCE).toMatch(/isOpen=\{pendingDeleteId !== null\}/);
    expect(SOURCE).toMatch(/isOpen=\{pendingUpdateId !== null\}/);
    expect(SOURCE).toMatch(/isOpen=\{pendingReset\}/);
  });

  it('preserves the original confirmation copy verbatim', () => {
    expect(SOURCE).toContain('Are you sure you want to delete this layout?');
    expect(SOURCE).toContain('Are you sure you want to update this layout with the current state?');
    expect(SOURCE).toContain(
      'Are you sure you want to reset to default layout? This will close all current tabs and create a single terminal.',
    );
  });
});
