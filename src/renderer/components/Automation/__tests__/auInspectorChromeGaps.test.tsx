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
        const left = px(button, 'left');
        const width = px(button, 'width');
        expect(left).not.toBeNull();
        expect(width).not.toBeNull();

        const gutter = px(ruleBody('.au-editor .au-idock .au-inspect > :first-child'), 'padding-left');
        expect(gutter).not.toBeNull();
        // `+ 2` for the button's 1px border on each side. Anything less and text runs under it.
        expect(gutter!).toBeGreaterThanOrEqual(left! + width! + 2);
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

describe('the state pill and its re-arm button', () => {
    it('are held apart, since no whitespace node separates them', () => {
        expect(px(ruleBody('.au-editor .au-pill + .au-btn'), 'margin-left')).toBeGreaterThan(0);
    });
});
