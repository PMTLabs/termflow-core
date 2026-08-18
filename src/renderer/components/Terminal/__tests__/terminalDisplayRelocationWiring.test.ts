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
    const open = SOURCE.indexOf('if (!engine.mount(pane)) {');
    expect(open).toBeGreaterThan(-1);

    // Walk to the matching brace, so these assertions cannot silently drift into
    // code that follows the block.
    const from = SOURCE.indexOf('{', open);
    let depth = 0;
    let end = -1;
    for (let i = from; i < SOURCE.length; i += 1) {
      if (SOURCE[i] === '{') depth += 1;
      else if (SOURCE[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(from);

    // STRIP COMMENTS BEFORE MATCHING (round 8 LOW). Raw `toContain` on source counts text
    // inside comments, so prefixing the real statements with `//` left every required
    // substring present and the test green while the refusal branch did nothing at
    // runtime. That is the same "asserts presence, not behaviour" defect one level down —
    // found on the correction written to fix the previous instance of it.
    //
    // This still cannot prove EXECUTION (a body wrapped in `if (false)` would pass), which
    // is stated plainly rather than papered over: the real fix is an executable refusal
    // helper, recorded in `153` as the follow-up.
    // `[^\n]*` and NO `$` anchor, deliberately. This file is CRLF, and in JavaScript `.`
    // does not match `\r` — it is a line terminator — so `.*$` never reaches end-of-string
    // on a CRLF line and the strip silently does nothing. The first version of this fix
    // had exactly that bug and passed the mutation test it was written to fail.
    const body = SOURCE.slice(from + 1, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/(^|[^:])\/\/[^\n]*/, '$1'))
      .join('\n');

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
