import path from 'path';
import { readSource } from '../../../utils/readSource';
import { isSnippetsViewMode } from '../settingsSlice';

/**
 * plan/029 §3.2 — the snippets setting's nine-link chain, link 8 (hydrate) in particular.
 *
 * `App.tsx`'s `applyConfigSettings` is the "#1 forgotten link": writes fine, loads fine, but
 * without a dispatch here `state.settings.snippets` reverts to `[]` on every restart. Nothing
 * throws when this link is missing — a unit test on the reducer alone cannot catch it, because
 * the reducer was never wrong. This is asserted from the App.tsx SOURCE, the same technique
 * `canvasWheelSettingWiring.test.ts` uses for the analogous canvasWheelMode link, because the
 * only other way to catch a missing dispatch here is restarting the app by hand.
 */

const src = (...p: string[]) => readSource(path.resolve(__dirname, '..', '..', '..', ...p));

const APP = src('App.tsx');
const SLICE = src('store', 'slices', 'settingsSlice.ts');

describe('the snippets setting survives a restart', () => {
  /**
   * Pin the PROPERTY, not the expression.
   *
   * The first version of this test asserted the literal
   * `state.snippets.map((s) => ({ ...s }))` — so it pinned a BUG in place: that shallow
   * copy left the nested `tags` array as a revoked Immer proxy, and correcting it would
   * have turned this test red (round-1 review B-07 / D-01). A source-derived test must
   * assert the invariant it wants, never today's spelling of it.
   */
  it('is written to the config file when it changes (link 5)', () => {
    // Exactly ONE site writes the snippets key: the helper. A reducer that hand-rolled
    // its own snapshot would add a second, and that is the defect class this guards.
    expect(SLICE.match(/setConfigValue\('snippets',/g) ?? []).toHaveLength(1);
    // Every mutating reducer reaches it through that one helper.
    expect(SLICE).toMatch(/persistSnippets\(state\.snippets\)/);
    // And the helper must take a DEEP snapshot. `current()` is what makes the payload
    // survive serialisation after Immer revokes the reducer's drafts.
    expect(SLICE).toMatch(/isDraft\(snippets\)\s*\?\s*current\(snippets\)\s*:\s*snippets/);
    // The exact regression, spelled out so it cannot come back quietly.
    expect(SLICE).not.toMatch(/setConfigValue\('snippets',\s*state\.snippets\.map/);
  });

  it('imports setSnippets in App.tsx', () => {
    expect(APP).toMatch(/\bsetSnippets\b/);
  });

  /**
   * The link that is easiest to leave out and hardest to notice: everything works until you
   * relaunch, and by then the change is several sessions old.
   */
  it('is read back at boot — config.snippets is dispatched via setSnippets', () => {
    expect(APP).toMatch(/Array\.isArray\(config\.snippets\)/);
    const hydrateSite = APP.slice(APP.indexOf('Array.isArray(config.snippets)'));
    const nextBlock = hydrateSite.slice(0, hydrateSite.indexOf('\n        }') + 20);
    expect(nextBlock).toContain('dispatch(setSnippets(');
  });

  it('validates each entry against isValidSnippet rather than trusting the array wholesale', () => {
    expect(APP).toMatch(/\bisValidSnippet\b/);
    const hydrateSite = APP.slice(APP.indexOf('Array.isArray(config.snippets)'));
    const nextBlock = hydrateSite.slice(0, hydrateSite.indexOf('\n        }') + 20);
    expect(nextBlock).toContain('isValidSnippet');
  });
});

/**
 * plan/029 §4.3 — the SECOND snippets setting, and a second full nine-link chain.
 *
 * `snippetsViewMode` is not a Settings-screen control; it is a toggle inside the flyout,
 * which is rebuilt from scratch every time the menu opens. That is exactly what makes the
 * chain load-bearing here: held in component state it would look correct in every test and
 * silently reset to the default on each open, and a break in the hydrate link would reset
 * it on each restart instead. Neither failure throws.
 */
describe('the snippets view mode survives a restart', () => {
  it('has a default, and the default is FLAT', () => {
    // The arrangement that needs nothing from the user: every snippet one click away,
    // whether or not they have ever filed anything.
    expect(SLICE).toMatch(/snippetsViewMode: 'flat',/);
    expect(SLICE).toMatch(/snippetsViewMode: SnippetsViewMode;/);
  });

  it('is written to the config file when it changes (link 5)', () => {
    expect(SLICE).toMatch(/setSnippetsViewMode: \(state, action: PayloadAction<SnippetsViewMode>\)/);
    expect(SLICE.match(/setConfigValue\('snippetsViewMode',/g) ?? []).toHaveLength(1);
  });

  it('is exported as an action (link 4) — a reducer nothing can dispatch is invisible', () => {
    const exportBlock = SLICE.slice(SLICE.lastIndexOf('export const {'));
    expect(exportBlock).toMatch(/\bsetSnippetsViewMode\b/);
  });

  it('is read back at boot, through the type guard rather than trusted (links 8 + 7)', () => {
    expect(APP).toMatch(/\bsetSnippetsViewMode\b/);
    // `isSnippetsViewMode`, not a truthiness check: config.json is hand-editable, and any
    // non-empty string would otherwise reach a union-typed field.
    expect(APP).toMatch(/if \(isSnippetsViewMode\(config\.snippetsViewMode\)\) \{/);
    const hydrateSite = APP.slice(APP.indexOf('isSnippetsViewMode(config.snippetsViewMode)'));
    expect(hydrateSite.slice(0, 200)).toContain('dispatch(setSnippetsViewMode(config.snippetsViewMode))');
  });

  it('the guard actually rejects a non-member', () => {
    // Source-derived tests above pin the WIRING; this pins the guard itself, so the
    // hydrate assertion cannot pass against a function that returns true for anything.
    expect(isSnippetsViewMode('flat')).toBe(true);
    expect(isSnippetsViewMode('folders')).toBe(true);
    expect(isSnippetsViewMode('FLAT')).toBe(false);
    expect(isSnippetsViewMode('')).toBe(false);
    expect(isSnippetsViewMode(undefined)).toBe(false);
    expect(isSnippetsViewMode(1)).toBe(false);
  });
});
