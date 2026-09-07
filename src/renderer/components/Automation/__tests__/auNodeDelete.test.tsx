/**
 * @jest-environment jsdom
 *
 * **The two gestures that take a card off the canvas** — Delete on a focused card, and the
 * right-click menu.
 *
 * Asserted through `AuCanvas` rather than on `AuNode` alone, because the reducer is already pinned
 * by `automationRemoveStep.test.ts` and what is left to go wrong is the wiring between them. A card
 * that handles Delete perfectly and is handed an `onDelete` that never reaches the editor's
 * `removeStep` is a feature that does nothing, and neither end's own test can see it.
 *
 * The MENU's label is asserted as well as its effect. `removalGroup` answers with three steps when
 * one of the reading cards is aimed at, so an item reading *Delete “Read a value”* over a gesture
 * that removes three would be the menu misdescribing what pressing it does — and a menu is read
 * before it is pressed.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuCanvas } from '../AuCanvas';
import { draftFromRule, draftReducer } from '../automationDraft';
import type { AutomationDraft } from '../automationDraft';
import { faceFor, stateFor } from '../automationDerive';
import type { NodeFace, NodeState } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { blankDraft } from '../../Settings/Automations/automationTemplates';

const NOW = 1_700_000_000_000;

describe('AuCanvas — removing a card', () => {
    let container: HTMLDivElement;
    let root: Root;
    let removed: StepKind[];
    let draft: AutomationDraft;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        removed = [];

        // Built from the palette rather than from a template, so every card this file aims at is
        // certainly on the canvas — templates carry whichever steps they happen to need.
        draft = (['monitor', 'parse', 'cond', 'timer', 'action'] as StepKind[]).reduce(
            (d, step) => draftReducer(d, { type: 'addStep', step }),
            draftFromRule(blankDraft(), 'blank'),
        );
        const rule = draft.rule;
        const ctx = { now: NOW, problems: problems(rule) };
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
                    onRemove={(step) => { removed.push(step); }}
                    onRefuse={() => {}}
                    onViewportReady={() => {}}
                />,
            );
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    const card = (step: StepKind) =>
        container.querySelector<HTMLElement>(`.au-node[data-step="${step}"]`)!;

    /** Open the card's menu the way a pointer does, and let `CanvasMenu`'s rAF gate settle. */
    async function rightClick(step: StepKind) {
        await act(async () => {
            card(step).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
        });
        return document.body.querySelector<HTMLElement>('.au-nodemenu')!;
    }

    it('removes the card the Delete key was pressed on', async () => {
        await act(async () => {
            card('timer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        });
        expect(removed).toEqual(['timer']);
    });

    /**
     * The key is aimed by FOCUS, which is the whole reason the card is a tab stop. Without it the
     * gesture would have to be a window listener reading the selection, and the selection outlives
     * the pointer — a Delete typed into the inspector's message box would then have to be told
     * apart from a Delete meaning the card.
     */
    it('makes the card focusable, so the key has something to be aimed at', () => {
        expect(card('timer').tabIndex).toBe(0);
    });

    it('leaves other keys alone', async () => {
        await act(async () => {
            card('timer').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
            card('timer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(removed).toEqual([]);
    });

    it('opens a menu on right-click and removes on the item', async () => {
        const menu = await rightClick('timer');
        expect(menu).not.toBeNull();

        const item = menu.querySelector<HTMLElement>('.context-menu-item')!;
        expect(item.textContent).toContain('Delete “Wait”');

        await act(async () => { item.click(); });
        expect(removed).toEqual(['timer']);
        expect(document.body.querySelector('.au-nodemenu')).toBeNull();
    });

    it('names every card a reading-step removal will take', async () => {
        const menu = await rightClick('parse');
        const item = menu.querySelector<HTMLElement>('.context-menu-item')!;
        // Not `Delete “Read a value”`: pressing this takes all three.
        expect(item.textContent).toContain('Delete Watch output, Read a value and Compare it');
    });

    it('portals the menu out of the canvas, which transforms and clips its own children', async () => {
        await rightClick('timer');
        expect(container.querySelector('.au-nodemenu')).toBeNull();
        expect(document.body.querySelector('.au-nodemenu')).not.toBeNull();
    });
});
