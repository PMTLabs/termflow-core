/**
 * design/012 §4.2.1 + §4.2.2, §8 — §13 T14's "byte-identical to today" clause and
 * the wiring §15.8 records rev 5 getting DEAD WRONG.
 *
 * A TRIPWIRE over TerminalDisplay.tsx's source, not a behavioural test: the
 * component cannot be mounted under the root Jest config (two CSS imports with no
 * transform, @tauri-apps/api/event, the Redux store, and a real xterm
 * Terminal.open() that needs a canvas 2D context jsdom lacks). The BEHAVIOUR these
 * lines produce is covered by useSurfaceRelocation.test.tsx (T19/T20/T21/T23);
 * what this file guards is that the real component still has the shape those tests
 * assume — above all that the engine effect's cleanup uses the CAPTURED pane and
 * not `terminalRef.current`, which React has already nulled by then (099 T1-F3).
 */
import * as fs from 'fs';
import * as path from 'path';
import { readSource } from '../../../utils/readSource';

const SOURCE = readSource(path.join(__dirname, '..', 'TerminalDisplay.tsx'));

/**
 * `SOURCE` with its comments removed, for every assertion below that is STRUCTURAL.
 *
 * Raw `toContain` on source counts text inside comments, so a negative is only ever one
 * explanatory sentence away from being satisfied by the very comment that explains it — the
 * round-8 defect, found on a correction written to fix the previous instance of it. Stripping
 * once, here, is what stops each new case having to remember.
 *
 * `[^\n]*` and NO `$` anchor, deliberately. This file is CRLF, and in JavaScript `.` does not
 * match `\r` — it is a line terminator — so `.*$` never reaches end-of-string on a CRLF line and
 * the strip silently does nothing. `(^|[^:])` is what keeps a `https://` inside a string literal
 * from eating the rest of its line.
 */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/[^\n]*/, '$1'))
  .join('\n');

/**
 * The body of the `{ … }` block that opens at or after `from`, found by BRACE MATCHING.
 *
 * A fixed-size `slice` cannot do this job. `onRelocated:`'s callback outgrew the 900 characters
 * once measured for it, so `not.toContain('search.close()')` stopped covering the end of the
 * very callback it names — and the LAST statement is the natural place to add a closer. A window
 * that has to be re-measured every time the code inside it changes is not a tripwire.
 */
function blockBodyAt(from: number): string {
  const open = CODE.indexOf('{', from);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < CODE.length; i += 1) {
    if (CODE[i] === '{') depth += 1;
    else if (CODE[i] === '}') {
      depth -= 1;
      if (depth === 0) return CODE.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces from ${from}`);
}

/**
 * The whole context-menu ELEMENT whose `label:` sits at `labelAt` — from the end of the previous
 * sibling through this item's own closing brace.
 *
 * Anchoring a negative on the LABEL cannot see a gate, and that is the point of this helper.
 * A conditional spread's condition is written BEFORE the label it wraps, so
 * `...(!relocationHost ? [ { label: 'Find…', … } ] : []),` leaves every forward-looking
 * assertion green while removing the item from the canvas overlay's menu — the one surface the
 * requirement is about. Reaching back past the previous `,` is what puts such a wrapper inside
 * the region being asserted on.
 */
function menuItemRegion(labelAt: number): string {
  // Back to the `{` that opens this item, counting braces so a nested object cannot be
  // mistaken for it.
  let depth = 0;
  let open = -1;
  for (let i = labelAt; i >= 0; i -= 1) {
    if (CODE[i] === '}') depth += 1;
    else if (CODE[i] === '{') {
      if (depth === 0) { open = i; break; }
      depth -= 1;
    }
  }
  expect(open).toBeGreaterThan(-1);
  // ...and back again to the previous sibling's comma, which is where anything wrapping this
  // item has to have been written.
  const prev = CODE.lastIndexOf(',', open);
  expect(prev).toBeGreaterThan(-1);
  return CODE.slice(prev + 1, open) + blockBodyAt(open);
}

describe('TerminalDisplay relocation wiring', () => {
  // §13 T14's last clause / §4.2: the render output is LITERALLY unchanged, and
  // there is no portal anywhere. D1 killed the portal in rev 4 and reviews 089/090
  // showed the render shape is unbuildable.
  it('renders the same tree as before and uses no portal', () => {
    expect(SOURCE).toContain('<div className="terminal-display-wrapper">');
    expect(SOURCE).toContain('className="terminal-display"');
    expect(SOURCE).toContain('data-terminal-id={terminalId}');
    expect(SOURCE).toContain('onContextMenu={handleContextMenu}');
    expect(SOURCE).not.toContain('createPortal');
  });

  // §4.2.1: the engine effect stays PASSIVE with deps [terminalId] (D3). Making it
  // a layout effect is spike 004's V2 — rejected here because TerminalContainer
  // renders EVERY tab, so it would move N xterm constructions onto the pre-paint
  // critical path at app start (§15.2).
  it('keeps the engine effect passive and keyed on terminalId alone', () => {
    // The mount call is now RESULT-CHECKED (review 126): mount() returns whether
    // it mounted, and a refused mount must not reach attach()/engine.terminal.
    expect(SOURCE).toContain('if (!engine.mount(pane)) {');
    expect(SOURCE).not.toContain('useLayoutEffect(() => {\n    if (!terminalRef.current)');
    // The engine effect's dep array, unchanged.
    expect(SOURCE).toContain('}, [terminalId]);');
  });

  // The refusal BODY, not just its guard line (review 153 finding 2).
  //
  // `expect(SOURCE).toContain('if (!engine.mount(pane)) {')` above asserts that an `if`
  // statement's OPENING LINE exists. It asserts nothing about what is inside it: emptying
  // the block entirely — falling through to engineMounted() and engine.terminal on a mount
  // that wired nothing — leaves that substring, and both assertions, untouched.
  //
  // jsdom cannot mount the real component (CSS imports, @tauri-apps/api/event, a Redux
  // store, a canvas-backed Terminal.open()), so a source assertion is the ONLY mechanism
  // that can pin this file's own refusal behaviour. That is a reason to make it assert the
  // body, not a reason to accept a tripwire that a regression walks straight through.
  it('handles a refused mount in the block BODY, not just at the guard line', () => {
    // Brace-matched and comment-stripped, both by the shared helpers at the top of this file.
    // The strip is not optional (round 8 LOW): prefixing the real statements with `//` left
    // every required substring present and this test green while the refusal branch did
    // nothing at runtime.
    //
    // This still cannot prove EXECUTION (a body wrapped in `if (false)` would pass), which
    // is stated plainly rather than papered over: the real fix is an executable refusal
    // helper, recorded in `153` as the follow-up.
    const open = CODE.indexOf('if (!engine.mount(pane)) {');
    expect(open).toBeGreaterThan(-1);
    const body = blockBodyAt(open);

    // Drops the never-wired engine. Without this the next reader of
    // `engineRef.current!.terminal` hits a getter that throws.
    expect(body).toContain('engineRef.current = null');
    // And returns a cleanup that tears down nothing it never set up.
    expect(body).toContain('return () => {}');
    // Hands back the two SINGLE-USE handoffs consumed while the options object was
    // built, before mount() could refuse. Neither survives being dropped, and a
    // create-branch refusal is exactly the first-ever-mount case where they are
    // non-empty (review 153 finding 1).
    expect(body).toContain('stashPromptGate(terminalId, promptGateHandoff)');
    expect(body).toContain('markReattachedSession(terminalId)');
    // The post-mount path must not run on a refusal.
    expect(body).not.toContain('engineMounted()');
    expect(body).not.toContain('engine.terminal');
  });

  // §4.2.1: the pane is CAPTURED in the effect body and the cleanup uses the
  // capture. Rev 5 wrote `if (terminalRef.current) { engine.relocateTo(...) }`,
  // whose guard is FALSE on whole-component deletion — React detaches host refs
  // during the deletion traversal, before passive cleanup — so that cover relocated
  // NOTHING on the exact interleaving it was written for (099 T1-F3).
  it('captures the pane element and relocates home with it before unmount()', () => {
    expect(SOURCE).toContain('const pane = terminalRef.current;');
    expect(SOURCE).toMatch(/engine\.relocateTo\(pane,\s*\{\s*paneChrome:\s*true\s*\}\)/);
    // Ordering: relocate home, THEN unmount. unmount() never removes term.element
    // from the DOM (TerminalEngine.ts:3218-3276), so the reverse order strands a
    // live-painting, input-dead surface in the canvas host (hazard H11).
    const relocateAt = SOURCE.indexOf('engine.relocateTo(pane,');
    const unmountAt = SOURCE.indexOf('engine.unmount();');
    expect(relocateAt).toBeGreaterThan(-1);
    expect(unmountAt).toBeGreaterThan(-1);
    expect(relocateAt).toBeLessThan(unmountAt);
    // And the cleanup must NOT re-read the ref.
    expect(SOURCE).not.toContain('engine.relocateTo(terminalRef.current');
  });

  // §4.2.1: the generation bump is what makes relocation-at-mount reachable (H12).
  it('bumps the engine generation right after mount()', () => {
    expect(SOURCE).toContain('useSurfaceRelocation');
    expect(SOURCE).toContain('engineMounted();');
    const mountAt = SOURCE.indexOf('if (!engine.mount(pane)) {');
    const bumpAt = SOURCE.indexOf('engineMounted();');
    expect(mountAt).toBeGreaterThan(-1);
    expect(bumpAt).toBeGreaterThan(mountAt);
  });

  // §8 / §13 T17, renderer half: the overlays anchored to coordinates that stop
  // meaning anything are closed on EVERY relocation; the suggest popup's React
  // state is cleared only on the way OUT (the engine gate stops it coming back);
  // and the SEARCH BAR is deliberately left open with its state intact, because it
  // holds user-typed state and its highlights travel with the buffer.
  it('closes the coordinate-anchored overlays on relocation and leaves search alone', () => {
    const start = CODE.indexOf('onRelocated:');
    expect(start).toBeGreaterThan(-1);
    // The WHOLE callback, brace-matched. It used to be `slice(start, start + 900)`, a window
    // measured against the code of the day: the callback has since grown past it, so
    // `not.toContain('search.close()')` no longer covered its last statement — the natural
    // place to add a closer — and this tripwire would have stayed green while every relocation
    // silently discarded the user's search.
    const body = blockBodyAt(start);
    expect(body).toContain('setContextMenu(null)');
    expect(body).toContain('setPathPicker(null)');
    expect(body).toContain('setSchemaPicker(null)');
    expect(body).toContain('suggestRef.current.close()');
    // The search bar is still left alone. UPDATED DELIBERATELY for `plan/027` §1.3: the
    // state moved out of `TerminalSearchBar` into `useTerminalSearch`, so `setSearchOpen`
    // no longer exists and the old assertion could only ever pass. The closer is now
    // `search.close()` — which clears the SearchAddon's highlights AND resets the user's
    // query — so that is what must not appear here. The requirement is unchanged: a
    // relocation must not discard a search the user typed, and the highlights live on the
    // buffer and travel with `term.element`.
    expect(body).not.toContain('search.close()');
  });

  // §5.1's recovery contract: an 'aborted' return must TELL THE USER. That, not a
  // bare console.error, is what satisfies §14 criterion 2.
  it('raises a toast when a relocation aborts', () => {
    const start = SOURCE.indexOf('onAborted:');
    expect(start).toBeGreaterThan(-1);
    // PLAN CORRECTION (015 Task 13), same cause as above: the prescribed comment
    // block puts `type: 'error'` at +329, past the plan's 300-char window. The
    // onAborted callback body itself ends at +351.
    const body = SOURCE.slice(start, start + 360);
    expect(body).toContain('addToast');
    expect(body).toContain("type: 'error'");
  });
});

/**
 * `plan/020` §5 — this component now PUBLISHES its floating chrome so the Canvas overlay can
 * draw it, and the shape of that is the whole reason the feature was buildable at all.
 *
 * The render tree above stays byte-identical, which is what keeps `no portal` true and keeps the
 * pane rendering its own chrome exactly as before. Everything new is a publish, not a move.
 *
 * Same tripwire caveat as the rest of this file: the component cannot be mounted here. The
 * REGISTRY's behaviour is covered by `surfaceChrome.test.tsx` and the consumer's by
 * `nodeTerminal.test.tsx`; this guards that the producer still feeds them.
 */
describe('plan/020 §5 — publishing the surface chrome', () => {
  it('publishes to the registry, with a per-instance owner token', () => {
    expect(SOURCE).toContain('setSurfaceChrome(terminalId, chromeOwner.current, {');
    expect(SOURCE).toContain('const chromeOwner = useRef({});');
  });

  /**
   * `plan/021` R2 — the context-menu TRIGGER is published too.
   *
   * `nodeTerminal.test.tsx` proves the overlay calls `chrome.openContextMenu`, and
   * `surfaceChrome.test.tsx` proves the registry carries it. The half neither can see is that
   * this component still PUBLISHES it, and publishes something that actually opens the menu —
   * the failure is silent, because a right-click on the overlay would simply do nothing while
   * every other test stays green.
   *
   * The callback is also asserted to be STABLE. `same()` compares published callbacks by
   * identity, so a fresh arrow per render would notify every subscriber on every keystroke and
   * re-render every node on the canvas — the exact failure `surfaceChrome`'s header warns about.
   */
  /**
   * `plan/021` R2 — the menu's ITEMS are scoped to the surface, not just its trigger.
   *
   * Once the menu became reachable from the canvas overlay, the four pane-tree actions it leads
   * with became wrong in a way the text actions are not. Copy/Paste/Clear act on the engine,
   * which is the same engine wherever it is drawn; `splitPaneById` acts on a pane tree in a tab
   * that is off screen, so picking "New Pane Right" from the overlay silently re-lays-out a
   * background tab and spawns a PTY while nothing changes on the surface that was clicked.
   *
   * Keyed on the RELOCATION HOST — non-null exactly when the surface is drawn somewhere other
   * than its pane — and not on the overlay flag, which would leave these live on a focused
   * ordinary node for the same reason.
   */
  it('offers the pane-tree actions only while the surface is in its own pane', () => {
    expect(SOURCE).toContain('...(paneId && !relocationHost ? [');
    // The text actions are NOT gated: they act on the engine, so they are correct on every
    // surface. Pairing the negative with a positive is what stops an over-broad gate passing.
    const copyAt = CODE.indexOf("label: 'Copy',");
    expect(copyAt).toBeGreaterThan(CODE.indexOf('...(paneId && !relocationHost ? ['));
    expect(CODE.slice(copyAt, copyAt + 400)).toContain("label: 'Paste',");
    // The negative is anchored on the ITEM, not on its label: a conditional spread's condition
    // is written BEFORE the label, so a 400-character forward window cannot see one.
    expect(menuItemRegion(copyAt)).not.toContain('relocationHost');
    expect(menuItemRegion(copyAt)).not.toContain('...(');
  });

  it('publishes the context-menu trigger, as a stable callback that opens the menu', () => {
    expect(SOURCE).toContain('openContextMenu: openContextMenuAt,');
    expect(SOURCE).toContain('const openContextMenuAt = useCallback((x: number, y: number) => {');
    const at = SOURCE.indexOf('const openContextMenuAt = useCallback');
    // Opens the menu AT THE GIVEN POINT. Matched on the two coordinates rather than on the whole
    // literal: `setContextMenu` also carries the right-clicked link since 2026-08-21
    // (`copyLinkWiring.test.ts`), and pinning the exact object shape here made an addition to it
    // fail a test about surface chrome — which says nothing about whether the trigger still
    // works. Widened rather than deleted: "opens the menu where you clicked" is the requirement.
    expect(SOURCE.slice(at, at + 900)).toMatch(/setContextMenu\(\{\s*x,\s*y[,\s}]/);
    // Declared BEFORE the publish effect reads it — a `const` declared after would be in that
    // effect's temporal dead zone and throw on the first render.
    expect(at).toBeLessThan(SOURCE.indexOf('setSurfaceChrome(terminalId, chromeOwner.current, {'));
    // And the pane's own right-click still goes through it, so the two surfaces cannot drift
    // into opening different menus.
    expect(SOURCE).toContain('openContextMenuAt(e.clientX, e.clientY);');
  });

  /**
   * The cleanup must capture the owner, for the same reason the engine effect captures the pane
   * (099 T1-F3): a ref read inside a teardown closure is read at TEARDOWN time. Here that is
   * merely stale rather than null — but `clearSurfaceChrome` is identity-checked against it, so
   * a stale token silently turns the unregister into a no-op and leaks the registration.
   */
  it('captures the owner for the unregister rather than reading the ref late', () => {
    const at = SOURCE.indexOf('const owner = chromeOwner.current;');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(SOURCE.slice(at, at + 120)).toContain('clearSurfaceChrome(terminalId, owner)');
  });

  /**
   * The gate itself lives in `useOverlayChromeGate`, where its behaviour — above all its
   * dependency list — is tested for real against a fake engine. What is left to guard HERE is
   * that this component still feeds it the right three inputs.
   *
   * `host` is the one worth naming. It is not decoration: every change of it is a relocation,
   * and `relocateTo({ paneChrome: !host })` overwrites the very flag the gate owns. Dropping it
   * is what left a returned overlay drawing a popup the engine had stopped listening to.
   */
  it('drives the overlay gate from the overlay flag, the host and the engine generation', () => {
    expect(SOURCE).toContain('s.canvas.overlayId === terminalId');
    const at = SOURCE.indexOf('useOverlayChromeGate({');
    expect(at).toBeGreaterThanOrEqual(0);
    const call = SOURCE.slice(at, SOURCE.indexOf('});', at));
    expect(call).toContain('overlaid: overlaidOnCanvas,');
    expect(call).toContain('host: relocationHost,');
    expect(call).toContain('engineGeneration,');
    expect(call).toContain('closePopup: () => suggestRef.current.close(),');
  });

  // And the host it passes is the relocation's own, not a second subscription that could
  // disagree with it about when the surface moved.
  it('takes the host from the relocation hook itself', () => {
    expect(SOURCE).toContain(
      'const { engineMounted, engineGeneration, host: relocationHost } = useSurfaceRelocation({',
    );
  });

  // And the render tree really is unchanged: the chrome is still rendered HERE for the pane.
  // A publish that replaced the local render would blank the affordance in every ordinary tab.
  it('still renders its own chrome for the pane', () => {
    expect(SOURCE).toContain('<ScrollToBottomButton visible={!atBottom} onClick={scrollToBottomCb} />');
    expect(SOURCE).toContain('{suggest.open && (');
    expect(SOURCE).not.toContain('createPortal');
  });
});

/**
 * `plan/027` — the find bar's state is published, and the Find item is not gated.
 *
 * Both halves are invisible to every other suite. `surfaceChrome.test.tsx` proves the registry
 * carries the two new fields and `nodeTerminal.test.tsx` proves the overlay draws and triggers
 * from them, but neither can see whether THIS component still feeds them — and the failure is
 * silent: Ctrl+F on the overlay would simply do nothing while every other test stayed green.
 */
describe('plan/027 — publishing the search state', () => {
  it('lifts the state into useTerminalSearch instead of keeping it in the bar', () => {
    // The TERMINAL ID is passed too, and it is load-bearing rather than housekeeping: it is
    // what resets the bar when `TerminalPane`'s reuse path swaps the terminal under this same
    // component instance (review 098 A1). Without it the bar stays open over terminal B showing
    // A's query, still counting A's matches.
    expect(SOURCE).toContain('const search = useTerminalSearch(engineRef, terminalId);');
    // The old local state is gone. Two `TerminalSearchBar`s each owning their own copy is the
    // shape §1.3 rules out: the bar's as-you-type effect runs on mount with an empty query and
    // calls `clearSearch()`, so a second one mounting wipes the first one's live search.
    expect(SOURCE).not.toContain('const [searchOpen, setSearchOpen]');
    expect(SOURCE).not.toContain('const [searchFocusToken, setSearchFocusToken]');
  });

  /**
   * Both new fields reach the registry. `search` is the view state the overlay DRAWS; `openSearch`
   * is the trigger its Ctrl+F and both context menus CALL, and it is separate because none of
   * those callers render anything.
   */
  it('publishes the search view state and the open trigger', () => {
    const at = SOURCE.indexOf('setSurfaceChrome(terminalId, chromeOwner.current, {');
    expect(at).toBeGreaterThan(-1);
    const publish = SOURCE.slice(at, SOURCE.indexOf('});', at));
    expect(publish).toMatch(/^\s*search,\s*$/m);
    expect(publish).toContain('openSearch: search.openSearch,');
  });

  /**
   * ...and every one of them is in the effect's DEPENDENCY ARRAY.
   *
   * This is the half of the four-part contract that has no other guard. `same()` deciding a
   * field matters is worth nothing if the effect never re-runs to publish the new value: the
   * overlay would keep drawing a query the user has since changed, and — worse for the
   * callbacks — keep calling a closure from a render that is gone.
   */
  it('re-publishes when any search sub-field changes', () => {
    const at = SOURCE.indexOf('setSurfaceChrome(terminalId, chromeOwner.current, {');
    const deps = SOURCE.slice(SOURCE.indexOf('}, [', at), SOURCE.indexOf(']);', at));
    for (const field of [
      'search.open', 'search.query', 'search.caseSensitive', 'search.wholeWord', 'search.regex',
      'search.result', 'search.focusToken', 'search.setQuery', 'search.toggleCaseSensitive',
      'search.toggleWholeWord', 'search.toggleRegex', 'search.next', 'search.previous',
      'search.close', 'search.openSearch',
    ]) {
      // Matched with a trailing-identifier guard, not `toContain`. A bare substring makes
      // `search.open` satisfied by `search.openSearch` — so dropping `search.open` (the field
      // that decides whether the overlay draws a bar at all) would pass. That is the weak-oracle
      // failure this whole file exists to avoid one level down.
      expect(deps).toMatch(new RegExp(`${field.replace('.', '\\.')}(?![A-Za-z0-9_])`));
    }
  });

  // The pane still renders its own bar, unchanged and UNGATED. Gating it on `!relocationHost`
  // was considered and rejected (§1.3): the pane copy is inert in a non-painting subtree, and
  // the branch would have nothing behind it.
  it('still renders the bar for the pane, from the published state', () => {
    expect(SOURCE).toContain('{search.open && <TerminalSearchBar search={search} />}');
    expect(SOURCE).not.toContain('createPortal');
  });

  // The engine's own Ctrl+F goes through the same one trigger, so the shortcut and the two menu
  // items cannot drift into opening search two different ways.
  it('routes the engine Ctrl+F through the same trigger', () => {
    expect(SOURCE).toContain('onOpenSearch: () => search.openSearch(),');
  });
});

/**
 * `plan/027` R2 — Find… in the terminal content menu.
 *
 * The gating is the whole point of this case. Search acts on the ENGINE, which is the same
 * engine wherever its surface is drawn, so Find belongs with Copy/Paste/Clear and Mute — not
 * with the `!relocationHost` pane-tree block, whose items would silently re-lay-out an
 * off-screen tab. Joining that block would remove Find from the canvas overlay, which is the
 * one surface R1 and R2 are about.
 */
describe('plan/027 R2 — the content menu Find item', () => {
  const findAt = () => {
    const at = CODE.indexOf("label: 'Find…',");
    expect(at).toBeGreaterThan(-1);
    return at;
  };

  it('sits AFTER the pane-tree block, outside its gate', () => {
    const gateAt = CODE.indexOf('...(paneId && !relocationHost ? [');
    expect(gateAt).toBeGreaterThan(-1);
    expect(findAt()).toBeGreaterThan(gateAt);
    // Ungated, like the text actions it sits with — asserted over the ITEM, not over a window
    // that starts at its label. A conditional spread's condition is written BEFORE the label,
    // so `...(!relocationHost ? [ … ] : []),` around this item satisfied all four of this
    // describe's assertions while removing Find from the canvas overlay's menu — the one
    // surface R1 and R2 are about. `...(` is banned as well as the identifier, so a gate on
    // some OTHER flag cannot slip in either.
    //
    // The paired positive is the placement check below: an item deleted outright would also
    // contain no `relocationHost`.
    const item = menuItemRegion(findAt());
    expect(item).not.toContain('relocationHost');
    expect(item).not.toContain('...(');
  });

  it('is placed beside Select All, and opens the one search', () => {
    const selectAllAt = CODE.indexOf("label: 'Select All',");
    expect(selectAllAt).toBeGreaterThan(-1);
    expect(findAt()).toBeGreaterThan(selectAllAt);
    expect(menuItemRegion(findAt())).toContain('click: () => search.openSearch(),');
  });

  // The first accelerator in this menu with a macOS branch: plain Ctrl+F is not search on macOS,
  // so a hard-coded 'Ctrl+F' would print a shortcut that does nothing there.
  it('shows the platform accelerator', () => {
    expect(menuItemRegion(findAt())).toContain("accelerator: isMac ? 'Cmd+F' : 'Ctrl+F',");
  });
});
