/**
 * @jest-environment jsdom
 *
 * Two overlaps in the inspector's chrome, both reported against the running build, both of the same
 * shape: **an element positioned over or beside another, with the spacing owed to it granted at one
 * call site out of two.**
 *
 * 1. The collapse button is absolutely positioned over the panel's top-left corner. The gutter that
 *    keeps text clear of it was written as `.au-ihead` — the header a SELECTED step renders — so
 *    the empty state (`.au-inspect-none`, a different element) drew `Nothing selected` underneath
 *    the button.
 * 2. *Re-arm now* follows the state pill with no whitespace text node between them, JSX siblings
 *    producing none, so the two inline-flex boxes were drawn touching.
 *
 * Asserted against the stylesheet, because jsdom has no layout: `getComputedStyle` would return the
 * declared value at best and nothing useful at worst. What makes these worth writing anyway is that
 * **both bounds are derived from the geometry they have to clear**, not restated. Move the button's
 * `left` or `width` and the gutter test fails, which is the class of change that caused #1.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import fs from 'fs';
import path from 'path';

import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import type { StepKind } from '../automationSteps';
import { blankDraft } from '../../Settings/Automations/automationTemplates';

const CSS = fs.readFileSync(
    path.join(__dirname, '..', 'AutomationEditor.css'),
    'utf8',
);

/** Comments stripped first: a block comment holds no braces, so its prose would otherwise be
 *  swallowed into the following rule's selector. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector matches, or `null`. */
function ruleBody(selector: string): string | null {
    for (const m of RULES.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (m[1].trim() === selector) return m[2];
    }
    return null;
}

const px = (body: string | null, prop: string): number | null => {
    const m = body?.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
    return m ? Number(m[1]) : null;
};

describe('the collapse button clears whatever is at the top of the panel', () => {
    const button = ruleBody('.au-editor .au-icollapse');

    it('reserves at least the button\'s own extent, derived from the button', () => {
        const right = px(button, 'right');
        const width = px(button, 'width');
        expect(right).not.toBeNull();
        expect(width).not.toBeNull();

        const gutter = px(ruleBody('.au-editor .au-idock .au-inspect > :first-child'), 'padding-right');
        expect(gutter).not.toBeNull();
        // `+ 2` for the button's 1px border on each side. Anything less and text runs under it.
        expect(gutter!).toBeGreaterThanOrEqual(right! + width! + 2);
    });

    /**
     * The button and the gutter must name the SAME edge. Moving one and not the other leaves a
     * panel that reserves space where nothing sits and draws text under the button anyway — which
     * is not a visibly broken stylesheet, just a wrong one.
     */
    it('reserves the edge the button is actually on', () => {
        const first = ruleBody('.au-editor .au-idock .au-inspect > :first-child')!;
        const onRight = px(button, 'right') !== null;
        expect(px(first, 'padding-right') !== null).toBe(onRight);
        expect(px(first, 'padding-left') !== null).toBe(!onRight);
    });

    /**
     * `.au-inspect` scrolls, and its scrollbar runs down the right edge — the same edge the button
     * now sits on. Inset past it, or the top of the scrollbar is unreachable. 10px is what
     * `index.css` sets app-wide.
     */
    it('clears the scrollbar it now shares an edge with', () => {
        expect(px(button, 'right')!).toBeGreaterThanOrEqual(10);
    });

    /**
     * Except in the collapsed rail, which has no scrollbar and is only 30px wide — the inset plus
     * the button would not fit inside it.
     */
    it('drops the inset in the rail, where it would not fit', () => {
        const rail = px(ruleBody('.au-editor .au-idock.collapsed .au-icollapse'), 'right');
        const width = px(button, 'width')!;
        expect(rail).not.toBeNull();
        // AU_INSPECT_RAIL is 30.
        expect(rail! + width + 2).toBeLessThanOrEqual(30);
    });

    /**
     * The rule that made this a bug twice over. A gutter keyed to one state's own class covers that
     * state and no other; keyed to the panel's first child it covers every state there is, and the
     * next one too.
     */
    it('is keyed to the panel\'s first child, not to one state\'s class', () => {
        expect(ruleBody('.au-editor .au-idock .au-inspect > :first-child')).not.toBeNull();
        expect(ruleBody('.au-editor .au-idock .au-ihead')).toBeNull();
    });
});

/**
 * The other half of the same claim, and the half the stylesheet cannot make: that
 * `.au-inspect > :first-child` actually lands on what the user reads at the top of the panel. The
 * CSS test above passes on a rule pointing at nothing.
 */
describe('what the gutter rule lands on', () => {
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

    async function show(selected: StepKind | null) {
        const rule = blankDraft();
        const draft = { ...draftFromRule(rule), selected };
        await act(async () => {
            root.render(
                <AuInspector
                    draft={draft}
                    problems={[]}
                    now={1_700_000_000_000}
                    terminals={[]}
                    terminalsError={null}
                    terminalsLoading={false}
                    report={null}
                    onRearm={null}
                    onTest={() => {}}
                    onFocusStep={() => {}}
                    dispatch={() => {}}
                />,
            );
        });
        return container.querySelector('.au-inspect')!.firstElementChild;
    }

    /** The reported one: `Nothing selected` was drawn under the button. */
    it('covers the empty state, whose top row is not a header at all', async () => {
        const top = await show(null);
        expect(top?.textContent).toContain('Nothing selected');
    });

    it('covers a selected step, whose top row is its header', async () => {
        const top = await show('monitor');
        expect(top?.classList.contains('au-ihead')).toBe(true);
    });
});

/**
 * Two complaints about this pair, one cause: as inline-flex boxes with no whitespace node between
 * them they were drawn touching, and being different heights and font sizes they were aligned on a
 * baseline they do not share, so the button rode high. A flex row answers both without either
 * answer depending on font metrics — which is why it is asserted as a row and not as two lengths.
 */
describe('the state pill and its re-arm button', () => {
    const row = ruleBody('.au-editor .au-nowrow');

    it('sit on one row, centred on each other and held apart', () => {
        expect(row).toMatch(/display:\s*flex/);
        expect(row).toMatch(/align-items:\s*center/);
        expect(px(row, 'gap')).toBeGreaterThan(0);
    });

    /** The panel resizes down to 300px, where a long pill plus a button is two lines. */
    it('wrap rather than overflow a narrow panel', () => {
        expect(row).toMatch(/flex-wrap:\s*wrap/);
    });
});

/**
 * A third instance of the same family, and the one that gives the family its name: **an
 * inline-block's baseline is its LAST line box.**
 *
 * A `<button>` is inline-block by default, so a problem long enough to wrap gave its `li` one line
 * box whose baseline sat on the second line — and an outside list marker is placed on that
 * baseline. The bullet drew beside `webhook destination.` with the words it belonged to sitting
 * above it, unmarked. Only the longer of the two problems showed it.
 *
 * jsdom cannot lay this out, so the fix was checked by rendering the real stylesheet's own
 * `.au-problems` rules in headless Edge, before and after, at a width that forces the wrap. What
 * is asserted here is the declaration that makes it true — a block-level button has its first line
 * as the item's first line, and the marker has nowhere else to go.
 */
describe('a problem long enough to wrap', () => {
    it('keeps its bullet on the first line, the button being block-level', () => {
        expect(ruleBody('.au-editor .au-problems li button')).toMatch(/display:\s*block/);
    });
});

/**
 * The same alignment problem in the other place it appeared: a 15px icon beside 0.8rem uppercase
 * text, aligned on a baseline neither shares. The label centres its items rather than picking a
 * `vertical-align` length that can only be right for one font size.
 */
describe('an info icon in a field label', () => {
    it('is centred against the label rather than hung off its baseline', () => {
        const label = ruleBody('.au-editor .au-flabel');
        expect(label).toMatch(/display:\s*flex/);
        expect(label).toMatch(/align-items:\s*center/);
        expect(ruleBody('.au-editor .au-info')).not.toMatch(/vertical-align/);
    });
});
