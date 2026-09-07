/**
 * Every step kind must carry an accent colour, on all three surfaces that draw its glyph.
 *
 * `webhook` shipped without one. The palette, the canvas node and the inspector head each render
 * `STEP_GLYPHS[step]` inside a `.au-palico` / `.au-nico` / `.au-gi`, and the five original kinds got
 * their colour from a three-selector group in `AutomationEditor.css`. The sixth kind was added with
 * no group at all, so its glyph inherited the body colour and rendered near-black on the dark rail —
 * an icon that looked switched off.
 *
 * Asserted as a TABLE over `STEP_ORDER` rather than as one case for `webhook`, because the defect
 * was never really about webhooks: it is that the colour table and the step list could disagree
 * silently. A seventh kind added later must fail here, not slip past.
 *
 * Read out of the stylesheet, in the manner of `auNodeTwoLineValue.test.tsx`: jsdom has no cascade,
 * so the file itself is the only place this contract can be checked.
 */
import fs from 'fs';
import path from 'path';
import { STEP_ORDER } from '../automationSteps';

const CSS = fs.readFileSync(path.join(__dirname, '..', 'AutomationEditor.css'), 'utf8');

/** The declarations of the group whose LAST selector is `selector`. */
function groupBody(selector: string): string {
    const at = CSS.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    const open = CSS.indexOf('{', at);
    return CSS.slice(open + 1, CSS.indexOf('}', open));
}

describe('step accent colours', () => {
    it.each(STEP_ORDER)('%s is drawn on all three surfaces by one group', (step) => {
        // The three selectors share one body, so a kind cannot be coloured in the palette while
        // staying invisible on the canvas — which is the half-fix this test exists to refuse.
        expect(CSS).toContain(`.au-editor .au-palitem.${step} .au-palico,`);
        expect(CSS).toContain(`.au-editor .au-node.${step} .au-nico,`);

        const body = groupBody(`.au-editor .au-gi.${step}`);
        expect(body).toMatch(/color:\s*#[0-9a-f]{6}/i);
        expect(body).toMatch(/background:\s*rgba\(/i);
    });

    it('gives every kind a colour of its own, so two steps never read as the same', () => {
        const colours = STEP_ORDER.map((step) => {
            const found = /color:\s*(#[0-9a-f]{6})/i.exec(groupBody(`.au-editor .au-gi.${step}`));
            if (!found) throw new Error(`${step} has no accent colour`);
            return found[1].toLowerCase();
        });
        expect(new Set(colours).size).toBe(STEP_ORDER.length);
    });
});
