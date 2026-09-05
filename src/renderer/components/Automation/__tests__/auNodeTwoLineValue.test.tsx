/**
 * @jest-environment jsdom
 *
 * **A card that names a terminal set it cannot show.**
 *
 * `AU_NODE_W` is 244 and `.au-nval` was `white-space: nowrap; text-overflow: ellipsis`, so the
 * monitor face's `Watch` row — the criterion sentence, `command contains "claude" · 3 now`, the
 * longest string any face draws — clipped on every real rule. It clipped *inside the quotes*, which
 * is the worst place for it: the card said which KIND of match the rule uses and hid what it
 * matches, which is the only part that differs between two rules.
 *
 * The fix is a two-line clamp, and a clamp is a thing CSS does, not a thing a component does. So
 * this file asserts both halves of it:
 *
 * **The CSS contract**, read out of the stylesheet, because jsdom has no layout engine and there is
 * no other way to see it. `-webkit-line-clamp` is inert without the `display: -webkit-box` /
 * `-webkit-box-orient: vertical` pair beside it, so all three are asserted; a build carrying only
 * the clamp property renders exactly the one-line ellipsis this test exists to forbid.
 *
 * **The DOM half**, because the class the clamp is attached to has to actually be the class the
 * value is rendered with, and the `title` carrying the untruncated text has to survive: two lines
 * truncate too, just later, so removing the title in the belief that the clamp made it redundant
 * would put the card back where it started for a long enough folder path.
 *
 * **And the HEIGHT**, which is the product-visible half of this change and the half that had no
 * coverage at all: the card grows so that Watch, Read and Check still fit once a value takes two
 * lines. Every reader of `AU_NODE_H` uses it symbolically (`pos.y + AU_NODE_H / 2`), so the
 * constant could be reverted to its old value and nothing anywhere would fail. The check below
 * DERIVES what the face needs from the stylesheet and from the face as rendered — restating 180
 * would be the same magic number written twice, which pins nothing.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuCanvas } from '../AuCanvas';
import { AU_NODE_H, AU_NODE_W, DEFAULT_LAYOUT, draftFromRule } from '../automationDraft';
import { faceFor, stateFor } from '../automationDerive';
import type { NodeFace, NodeState } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';
import type { AutomationRule } from '../../../types/electron';

const CSS = fs.readFileSync(
    path.join(__dirname, '..', 'AutomationEditor.css'),
    'utf8',
);

/** The declarations of one rule, by its selector — everything between its `{` and the next `}`. */
function ruleBody(selector: string): string {
    const at = CSS.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    const open = CSS.indexOf('{', at);
    const close = CSS.indexOf('}', open);
    return CSS.slice(open + 1, close);
}

/** One rule's declarations as a map, so a property can be asked for by its exact name. Reading
 *  `padding` out of a body with a substring search finds `padding-top` just as happily. */
function decls(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of ruleBody(selector).split(';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
    return out;
}

/**
 * No stylesheet in this app sets a root `font-size`, so `rem` is the UA's 16px. Asserted rather
 * than assumed would mean grepping every stylesheet from here; stated is honest, and a change to it
 * would move every `rem` in the editor, not just this arithmetic.
 */
const REM = 16;

/** One CSS length, in px. `0` is a length too, and it is written without a unit. */
function len(token: string): number {
    const t = token.trim();
    if (/^-?0(\.0+)?$/.test(t)) return 0;
    const asPx = /^(-?[\d.]+)px$/.exec(t);
    if (asPx) return parseFloat(asPx[1]);
    const asRem = /^(-?[\d.]+)rem$/.exec(t);
    if (asRem) return parseFloat(asRem[1]) * REM;
    throw new Error(`not a length this test can read: "${token}"`);
}

/** The first length of a multi-value declaration — `border: 1px solid #33353c` is 1px of box. */
const firstLen = (value: string): number => len(value.trim().split(/\s+/)[0]);

/** A `padding`/`margin` shorthand, expanded the way CSS expands it. */
function edges(shorthand: string): { top: number; right: number; bottom: number; left: number } {
    const [a, b = a, c = a, d = b] = shorthand.trim().split(/\s+/).map(len);
    return { top: a, right: b, bottom: c, left: d };
}

const NODE = decls('.au-editor .au-node');
const HEAD = decls('.au-editor .au-nhead');
const ICON = decls('.au-editor .au-nico');
const BODY = decls('.au-editor .au-nbody');
const ROW = decls('.au-editor .au-nrow');
const LABEL = decls('.au-editor .au-nlabel');
const VAL = decls('.au-editor .au-nval');
const FOOT = decls('.au-editor .au-nfoot');
const BADGE = decls('.au-editor .au-nbadge');

/** The one number `AU_NODE_H`'s budget multiplies by the number of text lines. */
const LINE_H = len(VAL['line-height']);
/** The clamp is what turns "how many rows" into "how many LINES": a row is one or two, never three. */
const CLAMP = parseInt(VAL['-webkit-line-clamp'], 10);

/**
 * How many characters of a value fit on one line of the card.
 *
 * jsdom has no layout engine, so wrapping cannot be measured — it has to be estimated, and the
 * estimate is one stated assumption: an average glyph in a proportional UI face runs about half its
 * font-size. That is deliberately on the generous side of the 0.48–0.52em such faces actually
 * measure, and generous is the safe direction here: fewer characters per line means MORE lines
 * counted, which makes the height check below stricter rather than vacuous.
 */
const AVG_GLYPH_EM = 0.5;
const BODY_PAD = edges(BODY.padding);
/** `flex: 0 0 56px` — the basis, which is what the label column actually costs the value column. */
const LABEL_W = len(LABEL.flex.trim().split(/\s+/)[2]);
const VALUE_COL_PX =
    AU_NODE_W - 2 * firstLen(NODE.border) - BODY_PAD.left - BODY_PAD.right - LABEL_W - len(ROW.gap);
const CHARS_PER_LINE = Math.floor(VALUE_COL_PX / (len(ROW['font-size']) * AVG_GLYPH_EM));

/** What one row's value costs in text lines, clamped the way the stylesheet clamps it. */
const linesFor = (text: string): number =>
    Math.min(CLAMP, Math.max(1, Math.ceil(text.length / CHARS_PER_LINE)));

/**
 * The height a face needs, from the parts — the arithmetic `AU_NODE_H`'s own comment writes out,
 * read back out of the stylesheet so that neither side can move without the other noticing.
 *
 * Every term but one comes from a stated CSS length. The exception is the badge's own text line:
 * `.au-nbadge` is set in the UA's `normal` line-height, which is not a number any stylesheet here
 * states. `normal` is never below ~1.15 for a Latin UI face, so 1.2 is a floor — and a floor is
 * exactly what a `>=` assertion needs. The head's other `normal`-set text (`.au-ntitle`, 0.9rem)
 * needs no such term: it is shorter than the 19px icon it sits beside, which sets that row's height.
 */
const NORMAL_LINE_FLOOR = 1.2;
function requiredNodeHeight(values: string[]): number {
    const textLines = values.reduce((n, text) => n + linesFor(text), 0);
    const headPad = edges(HEAD.padding);
    const bodyPad = BODY_PAD;
    const footPad = edges(FOOT.padding);
    const badgePad = edges(BADGE.padding);

    const head = len(ICON.height) + headPad.top + headPad.bottom + firstLen(HEAD['border-bottom']);
    const body =
        bodyPad.top + bodyPad.bottom + len(BODY.gap) * (values.length - 1) + LINE_H * textLines;
    const foot =
        footPad.top + footPad.bottom + badgePad.top + badgePad.bottom
        + 2 * firstLen(BADGE.border) + len(BADGE['font-size']) * NORMAL_LINE_FLOOR;

    return 2 * firstLen(NODE.border) + head + body + foot;
}

describe('a node value wraps to two lines instead of ellipsing at one', () => {
    /**
     * Matched against the SELECTOR AS WRITTEN. `.au-nval` alone appears in this stylesheet three
     * times (the rule, its `.warn` modifier and a comment pointing at it), and a substring search
     * would happily read the modifier's body and find no clamp in it.
     */
    const nval = () => ruleBody('.au-editor .au-nval');

    it('clamps at two lines — and carries the two properties that make the clamp work at all', () => {
        expect(nval()).toMatch(/-webkit-line-clamp:\s*2\s*;/);
        // Without these the clamp property is silently ignored and the value renders as an ordinary
        // wrapping block: no ellipsis, and no limit on how far it overflows the fixed-height card.
        expect(nval()).toMatch(/display:\s*-webkit-box\s*;/);
        expect(nval()).toMatch(/-webkit-box-orient:\s*vertical\s*;/);
    });

    it('does not lock the value to a single line', () => {
        // The one declaration that makes every other part of this unreachable. `nowrap` here is the
        // whole defect, not a leftover.
        expect(nval()).not.toMatch(/white-space:\s*nowrap/);
    });

    it('states its line-height as the exact number the card height is derived from', () => {
        // `automationDraft.ts` sizes `AU_NODE_H` against a stated line-height. Left at the UA's
        // `normal`, the text lines the monitor face draws are a different number of pixels on every
        // platform, and the card that fits on this one overflows on the next.
        expect(nval()).toMatch(/line-height:\s*\d+px\s*;/);
        // …and the VALUE, not just the unit. `\d+px` alone passes for `line-height: 24px`, which
        // adds 28px to a card whose whole remaining slack is about twelve — the card would overflow
        // with every test in this file still green. `LINE_H` is the same parsed number the height
        // check below multiplies out, so the stylesheet and the budget cannot drift apart.
        expect(LINE_H).toBe(17);
    });

    describe('the rendered card', () => {
        let container: HTMLDivElement;
        let root: Root;

        beforeAll(() => {
            (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        });

        beforeEach(() => {
            container = document.createElement('div');
            document.body.appendChild(container);
            root = createRoot(container);
        });

        afterEach(async () => {
            await act(async () => root.unmount());
            container.remove();
        });

        async function renderCanvas(rule: AutomationRule) {
            const draft = { ...draftFromRule(rule), layout: DEFAULT_LAYOUT };
            const ctx = { now: 1_700_000_000_000, problems: problems(rule) };
            const faces = {} as Record<StepKind, NodeFace>;
            const states = {} as Record<StepKind, NodeState>;
            for (const step of STEP_ORDER) {
                faces[step] = faceFor(rule, step, ctx);
                states[step] = stateFor(rule, step, ctx);
            }
            await act(async () => {
                root.render(
                    <AuCanvas
                        draft={draft}
                        faces={faces}
                        states={states}
                        chips={{}}
                        onSelect={() => {}}
                        onMove={() => {}}
                        onConnect={() => {}}
                        onDisconnect={() => {}}
                        onRefuse={() => {}}
                        onViewportReady={() => {}}
                    />,
                );
            });
        }

        /** The monitor card's first row — `Watch`, the criterion sentence. */
        const watchRow = () => {
            const rows = container.querySelectorAll('.au-node.monitor .au-nrow');
            expect(rows.length).toBeGreaterThan(0);
            return rows[0] as HTMLElement;
        };

        /**
         * A criterion long enough that one line at 244px could never hold it — which is the
         * ordinary case, not a contrived one: this is a real repository path.
         */
        const longRule = (): AutomationRule => ({
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            targetMode: 'rule',
            criterion: 'workingFolderUnder',
            criterionValue: 'D:/sources/work/termflow/termflow-core/src/renderer/components',
        });

        it('renders the Watch value with the clamped class and the untruncated title', async () => {
            const rule = longRule();
            await renderCanvas(rule);

            expect(watchRow().querySelector('.au-nlabel')!.textContent).toBe('Watch');

            // Selected by POSITION — the row's second span — and not by the class it is then
            // asserted to have. `querySelector('.au-nval')` followed by `toContain('au-nval')` is a
            // check with no mutant: it cannot fail. The mutant that matters is a value rendered
            // under some other class, which is a value with no clamp on it, and this catches it.
            const value = watchRow().children[1] as HTMLElement;
            expect(value).not.toBeUndefined();
            // The class is the whole mechanism: the clamp lives on `.au-nval` and nowhere else.
            expect(value.className.split(/\s+/)).toContain('au-nval');

            const full = `working folder under ${rule.criterionValue}`;
            expect(value.textContent).toBe(full);
            // Two lines still truncate — later. The title is what the user reaches for when they do,
            // and it must carry the WHOLE value, not the visible part of it.
            expect(value.getAttribute('title')).toBe(full);
        });

        /**
         * **The number this whole change is for, and the one nothing was watching.**
         *
         * `AU_NODE_H` is read symbolically everywhere (`pos.y + AU_NODE_H / 2`), so the card could
         * be shrunk back to a height that cannot hold a wrapped Watch row and every other test here
         * — the clamp, the class, the title — would still pass while the face spilled out of its
         * box onto the card below it (`.au-node` is `overflow: visible`).
         *
         * So the requirement is DERIVED: the rows come from the rendered monitor face, how many
         * lines each takes comes from its own text against the value column's width, and every box
         * term comes from the stylesheet. Restating 180 here would be the same magic number written
         * a second time — it would agree with the constant by construction and pin nothing.
         */
        it('is tall enough for every line the monitor face actually draws', async () => {
            await renderCanvas(longRule());

            const rows = [...container.querySelectorAll('.au-node.monitor .au-nrow')];
            expect(rows.length).toBeGreaterThan(0);
            const values = rows.map((row) => row.children[1].textContent ?? '');

            // The derivation must not be degenerate: if it counted one line per row it would be
            // asserting the height of the card BEFORE the clamp, which is the state this change
            // exists to leave behind. Two of the three monitor rows wrap — the criterion sentence,
            // and `Read`, whose phrases are 24 and 26 characters against a ~23-character line.
            // Shortening those phrases is a legitimate change; it just also moves the budget in
            // `automationDraft.ts`, which is why it has to come past this line.
            const textLines = values.reduce((n, text) => n + linesFor(text), 0);
            expect(textLines).toBeGreaterThanOrEqual(values.length + 2);

            expect(AU_NODE_H).toBeGreaterThanOrEqual(requiredNodeHeight(values));
        });
    });
});
