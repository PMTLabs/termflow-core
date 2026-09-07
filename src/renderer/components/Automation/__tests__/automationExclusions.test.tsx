/**
 * @jest-environment jsdom
 *
 * The rule-mode exclusions panel consumes the backend preview rather than recreating targeting in
 * the renderer. The id sets below are Task 3's `resolve_target_sets` fixture: counts alone would
 * also pass if the editor removed tm-c while the engine removed tm-b.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import { problems } from '../automationValidation';
import { blankDraft } from '../../Settings/Automations/automationTemplates';
import type {
    AutomationRule,
    AutomationTargetPreview,
    WatchableTerminal,
} from '../../../types/electron';

const TERMINALS: WatchableTerminal[] = [
    { terminalId: 'tm-a', label: 'worker a', commandLines: ['node worker-a'], alive: true },
    { terminalId: 'tm-b', label: 'worker b', commandLines: ['node worker-b'], alive: true },
    { terminalId: 'tm-c', label: 'worker c', commandLines: ['node worker-c'], alive: true },
];

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
    const blank = blankDraft();
    return {
        ...blank,
        id: 'au-exclusions',
        name: 'Node workers',
        criterion: 'commandContains',
        criterionValue: 'node',
        graph: {
            ...blank.graph,
            parse: { preset: 'custom', literal: null, find: 'ready', keep: 'whole' },
            action: { ...blank.graph.action, message: 'continue' },
        },
        ...over,
    };
}

interface Api {
    previewAutomationTargets: jest.Mock;
}

function installPreview(preview: AutomationTargetPreview): Api {
    const api: Api = { previewAutomationTargets: jest.fn(() => Promise.resolve(preview)) };
    (window as unknown as { electronAPI: Api }).electronAPI = api;
    return api;
}

describe('the exclusions panel', () => {
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
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    });

    async function show(next: AutomationRule) {
        const draft = { ...draftFromRule(next), selected: 'monitor' as const };
        await act(async () => {
            root.render(
                <AuInspector
                    draft={draft}
                    problems={problems(next)}
                    now={1_700_000_000_000}
                    terminals={TERMINALS}
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
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
    }

    const exclusionLabel = () => [...container.querySelectorAll('.au-flabel')]
        .find((label) => label.textContent === 'Except these');

    it('shows the exclusions panel only in rule mode', async () => {
        installPreview({ matched: [], excluded: [], watching: [] });
        await show(rule());
        expect(exclusionLabel()).toBeDefined();
        expect(container.querySelector('[aria-label="What the exception must match"]')).not.toBeNull();

        await show(rule({ targetMode: 'pinned', targetIds: ['tm-a'] }));
        expect(exclusionLabel()).toBeUndefined();
        expect(container.querySelector('[aria-label="What the exception must match"]')).toBeNull();
    });

    it('renders matched, excluded and watching as three separate numbers', async () => {
        installPreview({
            matched: ['tm-a', 'tm-b', 'tm-c', 'tm-d'],
            excluded: ['tm-b', 'tm-d'],
            watching: ['tm-a', 'tm-c'],
        });
        await show(rule({ excludedIds: ['tm-b'] }));

        const count = container.querySelector('.au-termcount');
        expect(count?.textContent).toBe('Matching 4 - excluded 2 = watching 2');
        const numbers = count === null ? [] : [...count.querySelectorAll('.au-n')];
        expect(numbers.map((n) => n.textContent)).toEqual(['4', '2', '2']);
    });

    it('advises when the shared preview resolves no terminals to watch', async () => {
        installPreview({ matched: ['tm-a'], excluded: ['tm-a'], watching: [] });
        await show(rule({ excludedIds: ['tm-a'] }));

        expect(container.querySelector('.au-termcount')?.textContent)
            .toBe('Matching 1 - excluded 1 = watching 0 — nothing is being watched');
    });

    it('does not offer exclusions on a hand-picked target set', async () => {
        await show(rule({
            targetMode: 'pinned',
            targetIds: ['tm-a'],
            excludedIds: ['tm-b'],
            excludeCriterion: 'commandContains',
            excludeCriterionValue: 'node',
        }));

        expect(exclusionLabel()).toBeUndefined();
        expect(container.textContent).not.toContain('anything matching this exception');
        expect(container.querySelector('[aria-label="What the exception must match"]')).toBeNull();
    });

    it('previews exactly the ids the engine would watch', async () => {
        const enginePreview: AutomationTargetPreview = {
            matched: ['tm-a', 'tm-b', 'tm-c'],
            excluded: ['tm-b'],
            watching: ['tm-a', 'tm-c'],
        };
        const api = installPreview(enginePreview);
        await show(rule({ excludedIds: ['tm-b'] }));

        expect(api.previewAutomationTargets).toHaveBeenCalledWith(
            expect.objectContaining({
                targetMode: 'rule',
                criterion: 'commandContains',
                criterionValue: 'node',
                excludedIds: ['tm-b'],
            }),
            TERMINALS,
        );

        // The ID sets are the oracle. These assertions intentionally precede the count assertion:
        // excluding tm-c instead of tm-b would still produce 3 - 1 = 2.
        const preview = await api.previewAutomationTargets.mock.results[0].value;
        expect(preview.matched).toEqual(['tm-a', 'tm-b', 'tm-c']);
        expect(preview.excluded).toEqual(['tm-b']);
        expect(preview.watching).toEqual(['tm-a', 'tm-c']);

        expect(container.querySelector('.au-termcount')?.textContent)
            .toBe('Matching 3 - excluded 1 = watching 2');
    });
});
