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

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'TerminalDisplay.tsx'),
  'utf8',
);

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
    expect(SOURCE).toContain('engine.mount(pane);');
    expect(SOURCE).not.toContain('useLayoutEffect(() => {\n    if (!terminalRef.current)');
    // The engine effect's dep array, unchanged.
    expect(SOURCE).toContain('}, [terminalId]);');
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
    const mountAt = SOURCE.indexOf('engine.mount(pane);');
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
    const start = SOURCE.indexOf('onRelocated:');
    expect(start).toBeGreaterThan(-1);
    // PLAN CORRECTION (015 Task 13): the plan sliced 400 chars, which cannot reach
    // the calls its own Step 4 snippet places — the prescribed comment blocks put
    // `setContextMenu(null)` at +536 and `setSchemaPicker(null)` at +591. 900 still
    // ends strictly INSIDE the onRelocated callback (`onAborted:` begins at +968),
    // so the locality this tripwire exists to assert is preserved.
    const body = SOURCE.slice(start, start + 900);
    expect(body).toContain('setContextMenu(null)');
    expect(body).toContain('setPathPicker(null)');
    expect(body).toContain('setSchemaPicker(null)');
    expect(body).toContain('suggestRef.current.close()');
    expect(body).not.toContain('setSearchOpen(false)');
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
