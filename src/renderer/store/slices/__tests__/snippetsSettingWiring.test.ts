import path from 'path';
import { readSource } from '../../../utils/readSource';

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
