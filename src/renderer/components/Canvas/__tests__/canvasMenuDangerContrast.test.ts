/**
 * A destructive menu row must be READABLE, not merely red.
 *
 * `.canvas-menu .context-menu-item.danger` took `--danger-color` (`#e81123`), which is a fill
 * colour: it is meant to be a button's background with white text on top. As TEXT on the
 * `#2d2d30` menu it lands at 3.3:1 and reads as a dim maroon — reported on the automation
 * canvas's *Delete* row, and the Canvas Mode node menu's *Close* row shared it, because both
 * borrow this one declaration.
 *
 * The oracle is the CONTRAST RATIO, computed here, rather than the specific hex. "It is not
 * `#e81123` any more" passes for every other unreadable red, and the next person reaching for a
 * brand red would put one back; a ratio fails for all of them. Both backgrounds are checked, since
 * the danger rule deliberately keeps its colour on hover while every other row turns white — so
 * the row is read against two grounds, and only one of them was ever looked at.
 *
 * jsdom has no cascade, so the stylesheets themselves are the only place this can be asked.
 */
import fs from 'fs';
import path from 'path';

const canvasCss = fs.readFileSync(path.join(__dirname, '..', 'Canvas.css'), 'utf8');
const menuCss = fs.readFileSync(
    path.join(__dirname, '..', '..', 'Panes', 'PaneContextMenu.css'),
    'utf8',
);

/** WCAG 2.x relative luminance of an `#rrggbb`. */
function luminance(hex: string): number {
    const channel = (pair: string) => {
        const v = parseInt(pair, 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

/** The first `prop: #rrggbb` in the group whose selector is `selector`. */
function colourOf(css: string, selector: string, prop: string): string {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', css.indexOf('{', at)));
    const found = new RegExp(`${prop}:\\s*(#[0-9a-f]{6})`, 'i').exec(body);
    expect(found).not.toBeNull();
    return found![1].toLowerCase();
}

describe('a destructive row in a canvas menu', () => {
    // The menu's own ground, and the ground it takes on hover — `.context-menu-item:hover` sets a
    // background while `.danger:hover` holds the red, so the row is read against both.
    const resting = colourOf(menuCss, '.pane-context-menu', 'background-color');
    const hovered = colourOf(menuCss, '.context-menu-item:hover:not(:disabled)', 'background-color');

    it.each([
        ['.canvas-menu .context-menu-item.danger', () => resting],
        ['.canvas-menu .context-menu-item.danger:hover:not(:disabled)', () => hovered],
    ])('%s clears 4.5:1 against the ground it is drawn on', (selector, ground) => {
        const colour = colourOf(canvasCss, selector, 'color');
        expect(contrast(colour, ground())).toBeGreaterThanOrEqual(4.5);
    });

    it('does not take the fill red back from the token', () => {
        // Stated as well as measured: `var(--danger-color, #e81123)` computes to a colour this
        // file cannot resolve, so a future edit reintroducing the token would make the ratio
        // check above unreadable rather than red. Naming the shape keeps that failure loud.
        const at = canvasCss.indexOf('.canvas-menu .context-menu-item.danger {');
        const body = canvasCss.slice(at, canvasCss.indexOf('}', at));
        expect(body).not.toContain('--danger-color');
    });
});
