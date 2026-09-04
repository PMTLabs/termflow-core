/**
 * @jest-environment jsdom
 *
 * Item D's surfaces: the badge, the context-menu section, and the promise that all four hosts use
 * the SAME two components.
 *
 * Tam asked for "good shared code" across the tab header, the pane title, the right-click menu and
 * Canvas Mode. That is a claim no rendered assertion can hold on its own — a private copy of the
 * badge inside `TabManager` would render identically and pass every DOM test in this file, then
 * drift the first time one of them is changed. So the render half pins what the shared components
 * DO, and the wiring half pins that the hosts actually mount them.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import path from 'path';

// `openAutomationEditorFor` reaches the Redux store to toast its refusal, and `store/index` pulls
// in `tauri-bridge`, which calls `listen()` at module scope. The same two mocks
// `automationEditorLifecycle.test.tsx` uses, for the same reason.
jest.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));

import { readSource } from '../../../utils/readSource';
import {
    AutomationArmedForTerminal,
    AutomationArmedForTerminals,
} from '../AutomationArmedBadge';
import { AutomationMenuSection, automationMenuItems } from '../AutomationMenuSection';
import {
    __resetAutomationArmedForTest,
    __seedAutomationArmedForTest,
} from '../../../services/automationArmed';
import {
    __resetAutomationEditorHostForTest,
    getOpenAutomationRuleId,
    openAutomationEditorFor,
} from '../../../services/automationEditorHost';
import {
    clearAutomationEditorGuard,
    registerAutomationEditorGuard,
} from '../../../services/automationEditorGuard';
import type { AutomationRule } from '../../../types/electron';
import type { AutomationRuntimePairState } from '../../../services/automationEvents';

const SRC = path.join(__dirname, '..', '..', '..');

function rule(id: string, name: string, sortOrder = 0): AutomationRule {
    return {
        id,
        name,
        enabled: true,
        runsOnce: false,
        targetMode: 'pinned',
        criterion: 'allTerminals',
        criterionValue: '',
        followNew: true,
        targetIds: [],
        completedAt: null,
        sortOrder,
        schemaVersion: 1,
        graph: {
            parse: { find: 'x', literal: null },
            cond: { kind: 'text', op: null, threshold: null },
            action: { message: 'go', submit: true },
        },
        createdAt: 0,
        updatedAt: 0,
    } as unknown as AutomationRule;
}

const PAIR: AutomationRuntimePairState = {
    state: 'armed', lastFiredAt: null, firedCount: 0, missing: false,
};

describe('the shared indicator and menu section', () => {
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
        __resetAutomationArmedForTest();
        __resetAutomationEditorHostForTest();
        clearAutomationEditorGuard();
    });

    const render = async (node: React.ReactNode) => {
        await act(async () => root.render(<>{node}</>));
    };

    const seedTwoRules = () => __seedAutomationArmedForTest(
        [rule('r1', 'Watch the build', 1), rule('r2', 'Answer the prompt', 2)],
        { rules: { r1: { 'tm-1': PAIR }, r2: { 'tm-1': PAIR } } },
    );

    it('names the first rule and offers the rest as +N', async () => {
        seedTwoRules();
        await render(<AutomationArmedForTerminal terminalId="tm-1" compact={false} />);

        expect(container.querySelector('.au-armed-label')!.textContent).toBe('Watch the build');
        expect(container.querySelector('.au-armed-more')!.textContent).toBe('+1');
    });

    it('drops the NAME when compact but keeps the +N', async () => {
        // The `+N` surviving `compact` is the half a "hide everything but the glyph" implementation
        // gets wrong, and it is the half Tam asked for by name — the tightest surface is the one
        // that most needs to say there is more than one rule.
        seedTwoRules();
        await render(<AutomationArmedForTerminal terminalId="tm-1" compact />);

        expect(container.querySelector('.au-armed-label')).toBeNull();
        expect(container.querySelector('.au-armed-glyph')).not.toBeNull();
        expect(container.querySelector('.au-armed-more')!.textContent).toBe('+1');
    });

    it('renders nothing at all for a terminal with no rules on it', async () => {
        seedTwoRules();
        await render(<AutomationArmedForTerminal terminalId="tm-other" compact={false} />);

        expect(container.querySelector('.au-armed')).toBeNull();
    });

    it('counts a tab by DISTINCT rules and disappears at zero', async () => {
        __seedAutomationArmedForTest(
            [rule('r1', 'One'), rule('r2', 'Two')],
            { rules: { r1: { 'tm-1': PAIR, 'tm-2': PAIR }, r2: { 'tm-2': PAIR } } },
        );

        await render(<AutomationArmedForTerminals terminalIds={['tm-1', 'tm-2']} />);
        expect(container.querySelector('.au-armed-more')!.textContent).toBe('+1');

        await render(<AutomationArmedForTerminals terminalIds={['tm-9']} />);
        expect(container.querySelector('.au-armed')).toBeNull();
    });

    it('hides the menu section entirely when nothing is armed', async () => {
        seedTwoRules();
        await render(<AutomationMenuSection terminalId="tm-other" onDismiss={() => {}} />);

        expect(container.querySelector('.context-menu-item')).toBeNull();
    });

    it('opens the editor for the rule that was clicked, and closes the menu first', async () => {
        seedTwoRules();
        let dismissed = 0;
        await render(<AutomationMenuSection terminalId="tm-1" onDismiss={() => { dismissed += 1; }} />);

        // Collapsed until asked — the section is one row in a menu that already has a dozen.
        expect(container.querySelectorAll('.au-menu-rule')).toHaveLength(0);
        await act(async () => {
            (container.querySelector('.context-menu-item') as HTMLButtonElement).click();
        });

        const rows = [...container.querySelectorAll('.au-menu-rule')];
        expect(rows.map((r) => r.querySelector('.au-menu-rule-name')!.textContent))
            .toEqual(['Watch the build', 'Answer the prompt']);
        expect(rows[0].querySelector('.au-menu-rule-state')!.textContent).toBe('Armed · waiting');

        await act(async () => (rows[1] as HTMLButtonElement).click());

        // The SECOND row's id, not the first and not the rule the section happened to render last:
        // a handler built over the loop variable by reference gets this wrong and looks right.
        expect(getOpenAutomationRuleId()).toBe('r2');
        expect(dismissed).toBe(1);
    });

    it('offers the SAME rules, in the same order, to the terminal-area menu', async () => {
        // Tam's follow-up: the terminal's own content menu must carry what the pane title's does.
        // It renders from an item ARRAY and cannot host the accordion component, so it is the one
        // host that takes data — and this is the assertion that keeps the two from drifting: one
        // seed, two surfaces, the same rules in the same order.
        seedTwoRules();
        await render(<AutomationMenuSection terminalId="tm-1" onDismiss={() => {}} />);
        await act(async () => {
            (container.querySelector('.context-menu-item') as HTMLButtonElement).click();
        });
        const inSection = [...container.querySelectorAll('.au-menu-rule-name')]
            .map((n) => n.textContent);

        const items = automationMenuItems('tm-1');
        expect(items.map((i) => i.label))
            .toEqual(inSection.map((name) => `Automation: ${name}`));
        expect(items[0].title).toContain('Armed · waiting');

        // And it does something: the row opens ITS rule, not the first one.
        items[1].click();
        expect(getOpenAutomationRuleId()).toBe('r2');
    });

    it('offers the terminal-area menu nothing for a terminal with no rules', async () => {
        seedTwoRules();
        expect(automationMenuItems('tm-other')).toEqual([]);
        expect(automationMenuItems(null)).toEqual([]);
    });

    it('refuses to open a second editor while one is already mounted', async () => {
        // One dirty-guard slot exists. A second editor would take it over silently, leaving the
        // first one's unsaved draft with nothing to answer for it — see `automationEditorGuard`.
        registerAutomationEditorGuard({
            isDirty: () => true,
            save: () => Promise.resolve(true),
            discard: () => {},
        });

        openAutomationEditorFor('r1');

        expect(getOpenAutomationRuleId()).toBeNull();
    });
});

describe('every surface mounts the SHARED components', () => {
    const cases: Array<{ file: string; mounts: string; from: string }> = [
        {
            file: 'components/Tabs/TabManager.tsx',
            mounts: '<AutomationArmedForTerminals',
            from: "from '../Automation/AutomationArmedBadge'",
        },
        {
            file: 'components/Panes/TerminalPane.tsx',
            mounts: '<AutomationArmedForTerminal ',
            from: "from '../Automation/AutomationArmedBadge'",
        },
        {
            file: 'components/Canvas/CanvasNode.tsx',
            mounts: '<AutomationArmedForTerminal ',
            from: "from '../Automation/AutomationArmedBadge'",
        },
        {
            file: 'components/Canvas/CanvasGroupFrame.tsx',
            mounts: '<AutomationArmedForTerminals',
            from: "from '../Automation/AutomationArmedBadge'",
        },
        {
            file: 'components/Panes/PaneContextMenu.tsx',
            mounts: '<AutomationMenuSection',
            from: "from '../Automation/AutomationMenuSection'",
        },
        {
            file: 'components/Canvas/CanvasNodeMenu.tsx',
            mounts: '<AutomationMenuSection',
            from: "from '../Automation/AutomationMenuSection'",
        },
        {
            // The terminal-area menu renders from an item array, so it takes the builder rather
            // than the component — but from the same module, and over the same entries.
            file: 'components/Terminal/TerminalDisplay.tsx',
            mounts: 'automationMenuItems(terminalId)',
            from: "from '../Automation/AutomationMenuSection'",
        },
    ];

    it.each(cases)('$file mounts $mounts', ({ file, mounts, from }) => {
        const src = readSource(path.join(SRC, file));
        expect(src).toContain(mounts);
        expect(src).toContain(from);
    });

    it('leaves `.au-armed`\'s metrics with exactly one owner', () => {
        // Round 1's toggle knob ended up 31px into a 32px track because two stylesheets moved it
        // with DIFFERENT properties — `left` and `transform` — so they composed instead of
        // competing, and no amount of specificity could have fixed it. The badge is handed to four
        // hosts with four different type scales, which is the same invitation. Hosts set
        // `--au-armed-size`; only the owner turns that into a `font-size`.
        const owner = 'components/Automation/automationSurfaces.css';
        const stylesheets = [
            owner,
            'components/Tabs/TabManager.css',
            'components/Panes/TerminalPane.css',
            'components/Panes/PaneContextMenu.css',
            'components/Canvas/Canvas.css',
            'components/Settings/Automations/AutomationsPanel.css',
            'components/Automation/AutomationEditor.css',
        ];

        for (const sheet of stylesheets) {
            const src = readSource(path.join(SRC, sheet));
            for (const block of src.split('}')) {
                if (!block.includes('.au-armed')) continue;
                if (sheet === owner) continue;
                expect(block).not.toMatch(/(^|[^-])font-size\s*:/);
            }
        }

        // …and the owner really does declare it, so the loop above is not vacuously green over a
        // property nobody sets anywhere.
        expect(readSource(path.join(SRC, owner))).toMatch(/font-size:\s*var\(--au-armed-size/);
    });
});
