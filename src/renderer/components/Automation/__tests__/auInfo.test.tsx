/**
 * @jest-environment jsdom
 *
 * **The ⓘ beside a field label, and the panel it opens.**
 *
 * Asked for as *"use custom tooltip so we can display text with style and a medium regular font
 * size instead of the system tooltip"*. Three things follow from that and are pinned here:
 *
 * - It is **not** a `title`. A native tooltip cannot hold a heading, a list and a `<code>` run, and
 *   it appears on a delay and leaves on a timeout. So: real markup, opened by a real click.
 * - It is **portalled**. The inspector column is `overflow-y: auto` and the editor's `.au-modal` is
 *   `overflow: hidden`; a panel rendered in that flow is clipped twice, which is the same trap
 *   `AuSelect` and `AuTerminalHoverCard` each document.
 * - Its placement is a **pure function**, because jsdom lays nothing out. `infoPopPosition` is
 *   checked as arithmetic against a window whose size the test states, which is the only way any of
 *   this folder's geometry is checkable at all.
 *
 * The content itself is asserted through `CondPanel` rather than in isolation: an info panel that
 * renders perfectly and is wired to no field explains nothing to anybody.
 */
import React, { act } from 'react';
import fs from 'fs';
import path from 'path';
import { createRoot, Root } from 'react-dom/client';

import { AU_INFO_MAX_H, AU_INFO_W, AuInfo, infoPopPosition } from '../AuInfo';
import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import { blankDraft } from '../../Settings/Automations/automationTemplates';

describe('infoPopPosition', () => {
    const view = { width: 1400, height: 900 };
    /** An icon 15px square, as `.au-info` draws it. */
    const icon = (left: number, top: number) => ({ left, top, bottom: top + 15 });

    it('hangs below the icon, from its left edge', () => {
        expect(infoPopPosition(icon(300, 200), view)).toEqual({ left: 300, top: 221 });
    });

    /**
     * These labels sit in the inspector at the RIGHT of the window, so the right-edge clamp is the
     * one that actually runs in production — an unclamped panel would hang off the screen for every
     * field in the editor.
     */
    it('pulls back from the right edge rather than hanging off it', () => {
        const { left } = infoPopPosition(icon(1300, 200), view);
        expect(left).toBe(view.width - 8 - AU_INFO_W);
        expect(left + AU_INFO_W).toBeLessThanOrEqual(view.width - 8);
    });

    it('flips above only when below genuinely cannot hold it', () => {
        // Room below for the full height: stays below, so the panel does not jump sides as the
        // inspector scrolls a few pixels.
        expect(infoPopPosition(icon(300, 500), view).top).toBe(521);
        // 60px from the bottom, nowhere near 300 tall.
        const flipped = infoPopPosition(icon(300, 840), view);
        expect(flipped.top).toBe(840 - 6 - AU_INFO_MAX_H);
    });

    /** On a window smaller than the panel, the corner you read from is the one that wins. */
    it('never places the panel off the top or the left', () => {
        const tiny = { width: 200, height: 200 };
        const at = infoPopPosition(icon(10, 190), tiny);
        expect(at.left).toBe(8);
        expect(at.top).toBe(8);
    });
});

/**
 * *"A medium regular font size instead of the system tooltip"* — the stated reason for building
 * this at all, so it is a requirement and not styling.
 *
 * Asserted **against the label the icon sits in**, not against a number typed here. `.au-flabel` is
 * 0.8rem uppercase; the panel holding headings, lists and code has to read larger and plainer than
 * that, and a comparison says so in a way `font-size: 0.9rem` on its own does not.
 */
describe('the panel reads as prose, not as a label', () => {
    const CSS = fs.readFileSync(path.join(__dirname, '..', 'AutomationEditor.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');

    const body = (selector: string): string => {
        for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (m[1].trim() === selector) return m[2];
        }
        throw new Error(`no rule for ${selector}`);
    };
    const rem = (css: string): number => Number(css.match(/font-size:\s*([\d.]+)rem/)![1]);

    it('is set larger than the uppercase label it hangs off', () => {
        expect(rem(body('.au-infopop'))).toBeGreaterThan(rem(body('.au-editor .au-flabel')));
    });

    it('is regular weight and not upper-cased', () => {
        expect(body('.au-infopop')).toMatch(/font-weight:\s*400/);
        expect(body('.au-infopop')).not.toMatch(/text-transform:\s*uppercase/);
        // The icon inherits the label's casing and tracking unless it undoes them.
        expect(body('.au-editor .au-info')).toMatch(/text-transform:\s*none/);
        expect(body('.au-editor .au-info')).toMatch(/letter-spacing:\s*0/);
    });

    /** Portalled to `body`, so a selector rooted at `.au-editor` would never reach it. */
    it('is styled by an unscoped selector', () => {
        expect(CSS).toMatch(/(^|\})\s*\.au-infopop\s*\{/);
    });
});

describe('AuInfo', () => {
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

    async function show() {
        await act(async () => {
            root.render(
                <AuInfo label="Examples of each kind">
                    <p>a worked example</p>
                </AuInfo>,
            );
        });
        return container.querySelector<HTMLButtonElement>('[aria-label="Examples of each kind"]')!;
    }

    const pop = () => document.body.querySelector<HTMLElement>('.au-infopop');

    it('shows nothing until it is asked', async () => {
        const trigger = await show();
        expect(pop()).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens on a click and closes on the next one', async () => {
        const trigger = await show();
        await act(async () => { trigger.click(); });
        expect(pop()?.textContent).toContain('a worked example');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');

        await act(async () => { trigger.click(); });
        expect(pop()).toBeNull();
    });

    /** The clipping ancestors are the whole reason this is not rendered in place. */
    it('portals out of its own tree', async () => {
        const trigger = await show();
        await act(async () => { trigger.click(); });
        expect(container.querySelector('.au-infopop')).toBeNull();
        expect(pop()).not.toBeNull();
    });

    it('closes on an outside press, and not on a press inside it', async () => {
        const trigger = await show();
        await act(async () => { trigger.click(); });

        // Inside: the panel holds text people select and read.
        await act(async () => {
            pop()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(pop()).not.toBeNull();

        await act(async () => {
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(pop()).toBeNull();
    });

    /**
     * Escape must close the panel WITHOUT reaching the editor behind it. Dismissing a panel and
     * discarding an unsaved rule are not the same gesture, and the editor listens for Escape.
     */
    it('swallows the Escape that closes it', async () => {
        const trigger = await show();
        await act(async () => { trigger.click(); });

        const heard: string[] = [];
        const listener = (e: Event) => heard.push((e as KeyboardEvent).key);
        document.addEventListener('keydown', listener);
        await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        document.removeEventListener('keydown', listener);

        expect(pop()).toBeNull();
        expect(heard).not.toContain('Escape');
    });
});

/**
 * The wiring. `CondPanel`'s `finds` radio is the field this was asked for, and the examples have to
 * be reachable FROM it — an `AuInfo` that renders beautifully beside nothing is the failure this
 * half exists to catch.
 */
describe('the examples behind "What this pattern finds"', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it('opens from the field label and names an example of each kind', async () => {
        const rule = blankDraft();
        await act(async () => {
            root.render(
                <AuInspector
                    draft={{ ...draftFromRule(rule), selected: 'cond' }}
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

        const label = [...container.querySelectorAll('.au-flabel')].find((l) =>
            l.textContent?.includes('What this pattern finds'),
        );
        const trigger = label?.querySelector('button.au-info') as HTMLButtonElement | undefined;
        expect(trigger).toBeDefined();

        await act(async () => { trigger!.click(); });
        const text = document.body.querySelector('.au-infopop')?.textContent ?? '';
        // One of each kind, and the sentence that tells them apart.
        expect(text).toContain('ctx:63%');
        expect(text).toContain('FAILED 3 tests');
        expect(text).toMatch(/still.*true/is);
    });
});
