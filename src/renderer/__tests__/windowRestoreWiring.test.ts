/**
 * Plan 018 chain-map hops 6 and 7 — a TRIPWIRE over the boot source, not a
 * behavioural test.
 *
 * Neither `<App />` nor `bootstrapApp()` can be mounted under the root Jest
 * config (CSS imports with no transform, @tauri-apps/api, a real xterm
 * `Terminal.open()` needing a canvas 2D context jsdom lacks). The two hops this
 * guards both fail SILENTLY — no error, no console noise, just every window
 * quietly sharing slot 0's session key again:
 *
 *   hop 6 — `initWindowScope` must be awaited BEFORE the bridge and App. App's
 *           mount effect registers beforeunload/interval/visibility saves
 *           immediately, so a late id lands the first saves on the wrong key.
 *   hop 7 — `?newWindow=1` must no longer return early. The save hooks are
 *           registered for every window regardless of that branch, so a window
 *           that skipped restore still SAVED — letting a fresh window's default
 *           tab replace a session it never read.
 *
 * Assertions match the real source syntax (a `\s*` between tokens, no literal
 * newlines) so a CRLF checkout cannot make them vacuous.
 */
import * as path from 'path';
import { readSource } from '../utils/readSource';

// readSource, not fs.readFileSync: whether the checkout is CRLF is not a
// property of the commit (the e2e job has no OS label), and every `\s`-spanning
// assertion below silently stops matching under CRLF. See utils/readSource.
const read = (...parts: string[]) => readSource(path.join(__dirname, '..', ...parts));

const INDEX = read('index.tsx');
const APP = read('App.tsx');

describe('boot resolves the window scope before anything can save', () => {
  it('awaits initWindowScope in the bootstrap', () => {
    expect(INDEX).toContain("require('./services/windowScope')");
    expect(INDEX).toMatch(/await\s+initWindowScope\(invoke\)/);
  });

  it('resolves the profile first, then the window, then loads the bridge', () => {
    const profileAt = INDEX.indexOf('await initProfileScope(invoke)');
    const windowAt = INDEX.indexOf('await initWindowScope(invoke)');
    const bridgeAt = INDEX.indexOf("require('./api/tauri-bridge')");
    const appAt = INDEX.indexOf("require('./App')");

    expect(profileAt).toBeGreaterThan(-1);
    expect(windowAt).toBeGreaterThan(-1);
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(-1);

    // The window key is derived from the profile scope, so that must land first.
    expect(profileAt).toBeLessThan(windowAt);
    // Both must precede every consumer that can write a scoped key.
    expect(windowAt).toBeLessThan(bridgeAt);
    expect(windowAt).toBeLessThan(appAt);
  });
});

describe('a new window persists its own session', () => {
  it('does not short-circuit initializeApp on ?newWindow=1', () => {
    // The old shape was:
    //   if (bootParams.has('newWindow')) { ...; createDefaultTabIfNeeded(p); return; }
    // Any `return` inside a newWindow branch reintroduces a window that saves
    // but never restores.
    const branch = APP.match(/if\s*\(\s*bootParams\.has\('newWindow'\)\s*\)\s*\{[\s\S]{0,400}?\}/);
    expect(branch).toBeNull();
  });

  it('still reads ?newWindow and its ?path', () => {
    // Removing the early return must not have removed the FEATURE: an
    // "Open in TermFlow" folder window still has to root its default tab there.
    expect(APP).toContain("bootParams.has('newWindow')");
    expect(APP).toContain("bootParams.get('path')");
    expect(APP).toMatch(/pendingOpenPath\s*=\s*pendingOpenPath\s*\?\?\s*newWindowPath/);
  });

  it('reaches restoreState on the ordinary boot path', () => {
    expect(APP).toMatch(/restored\s*=\s*await\s+StateManager\.restoreState\(dispatch\)/);
  });

  it('keeps StateManager on the per-window key', () => {
    const sm = read('services', 'StateManager.ts');
    // Match the SOURCE, not the exact named-import list: the list grows, and a
    // tripwire that breaks on unrelated edits gets loosened until it is vacuous.
    expect(sm).toMatch(/import\s*\{[^}]*sessionStateKey[^}]*\}\s*from\s*'\.\/windowScope'/);
    expect(sm).toMatch(/STATE_KEY\(\)\s*:\s*string\s*\{\s*return\s+sessionStateKey\(\);/);
    // The old profile-only key must be gone from the session path, or windows
    // silently collide again.
    expect(sm).not.toMatch(/return\s+stateKey\(\);/);
  });
});
