/**
 * Scrollbars are styled ONCE, globally, and the rule must stay unscoped.
 *
 * Ten stylesheets had each grown their own copy, so a scrollable surface was styled if and only if
 * someone remembered it. The reported failure shows why a per-component rule is not enough on its
 * own: `.au-editor ::-webkit-scrollbar` covers everything inside the automation editor, and that
 * editor's dropdown portals to `body` precisely so a clipping ancestor cannot cut it off — which
 * puts it outside the selector, and drew a bare Win32 scrollbar in the middle of a dark modal.
 *
 * jsdom has no cascade and no scrollbars at all, so the stylesheet is the only place this can be
 * asked. The assertion that carries the weight is the SCOPE: a rule written as
 * `.something ::-webkit-scrollbar` in this file would pass a naive "is it styled" check while
 * leaving every portalled surface bare again.
 */
import fs from 'fs';
import path from 'path';

const CSS = fs.readFileSync(
    path.join(__dirname, '..', 'styles', 'index.css'),
    'utf8',
);

/**
 * Comments stripped FIRST. A block comment contains no braces, so without this every prose
 * paragraph above a rule is swallowed into that rule's "selector" — which made the scope
 * assertion below fail on the very file it was written to pass.
 */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector in the file that mentions a scrollbar pseudo-element. */
const scrollbarSelectors = [...RULES.matchAll(/([^{}]*::-webkit-scrollbar[^{}]*)\{/g)]
    .map((m) => m[1].trim());

describe('global scrollbar styling', () => {
    it('styles the track, the thumb, its hover and the corner', () => {
        for (const part of ['', '-track', '-thumb', '-corner']) {
            expect(scrollbarSelectors).toContain(`::-webkit-scrollbar${part}`);
        }
        expect(scrollbarSelectors).toContain('::-webkit-scrollbar-thumb:hover');
    });

    it('leaves every rule unscoped, so a portalled surface is covered too', () => {
        // A selector with anything before the pseudo-element is a descendant rule, and a descendant
        // rule cannot follow a `createPortal` out to `body`.
        for (const selector of scrollbarSelectors) {
            expect(selector.startsWith('::-webkit-scrollbar')).toBe(true);
        }
    });

    it('states the standard properties as well as the WebKit ones', () => {
        // WebKit ignores `scrollbar-width`/`scrollbar-color` and uses the pseudo-elements; other
        // engines do the reverse. Either alone leaves one of them on the default chrome.
        expect(CSS).toMatch(/scrollbar-width:\s*thin/);
        expect(CSS).toMatch(/scrollbar-color:\s*#[0-9a-f]{6}\s+transparent/i);
    });

    /**
     * The thumb's inset comes from a transparent border clipped to the padding box, NOT from a
     * background colour matching one panel. The editor's own copy hard-coded `#17181c` — its
     * modal's ground — and lifting that verbatim would have drawn a dark-grey halo around the
     * thumb on every surface with a different background.
     */
    it('insets the thumb without pinning one panel background app-wide', () => {
        const thumb = RULES.slice(RULES.indexOf('::-webkit-scrollbar-thumb {'));
        const body = thumb.slice(thumb.indexOf('{') + 1, thumb.indexOf('}'));
        expect(body).toMatch(/border:\s*2px solid transparent/);
        expect(body).toMatch(/background-clip:\s*padding-box/);
    });
});
