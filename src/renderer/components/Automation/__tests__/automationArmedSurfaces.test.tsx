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
import { ContextMenu } from '../../Terminal/ContextMenu';
import type { ContextMenuFlyoutRow, ContextMenuItem } from '../../Terminal/ContextMenu';
import {
    __resetAutomationArmedForTest,
    __seedAutomationArmedForTest,
} from '../../../services/automationArmed';
// Namespace imports, so the two module-level functions the menu calls can be spied on: the CJS
// output turns those call sites into `ns.fn(...)`, which is the only shape a spy can intercept.
//
// **That is a property of the TRANSFORM, not of the code under test, and it fails silently.** If
// this suite is ever emitted as real ESM (live bindings rather than a mutable namespace object),
// `jest.spyOn` on these namespaces stops intercepting anything: the menu keeps calling the real
// `toastAutomationNotice` / `refreshAutomationArmed`, the spies record nothing, and every
// `not.toHaveBeenCalled()` below passes VACUOUSLY while the assertions that expect a call fail
// loudly. So the failure is loud on one side and green on the other — if a `toHaveBeenCalled`
// assertion here starts failing after a build-config change, suspect the spy before the feature.
import * as automationArmedModule from '../../../services/automationArmed';
import * as automationEditorHostModule from '../../../services/automationEditorHost';
import {
    __resetAutomationEditorHostForTest,
    getOpenAutomationDraft,
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

/** The submenu's rows, in the shape the flyout would ask for them with an empty query. */
function flyoutRows(item: ContextMenuItem): ContextMenuFlyoutRow[] {
    const rows = item.submenu!.rows;
    return typeof rows === 'function' ? rows('') : rows;
}

/**
 * Installs the API "Add to an existing automation" actually calls.
 *
 * `saveAutomation` is installed alongside it and is never expected to fire: it is the path this row
 * used to take, and asserting its ABSENCE is what pins that the whole-rule upsert — with the
 * clobber and the resurrection that come with it — is genuinely out of this write path rather than
 * merely unused by the happy case.
 */
function installAddApi(added: boolean = true): { add: jest.Mock; save: jest.Mock } {
    const add = jest.fn(() => Promise.resolve(added));
    const save = jest.fn(() => Promise.resolve({ id: 'r1', previousUpdatedAt: null }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        addAutomationTarget: add,
        saveAutomation: save,
    };
    return { add, save };
}

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
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
        // A net under the per-test `mockRestore()` calls below, not a replacement for them. Every
        // namespace spy here is installed on a module the WHOLE file shares, and a test that fails
        // before its own restore line leaves that spy installed for everything after it — which
        // turns one broken assertion into a page of unrelated failures pointing at the wrong code.
        // Found the hard way while mutation-checking the ordering test: one real kill, two cascades.
        jest.restoreAllMocks();
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

    it('still renders the section — with no `(0)` in its label — when nothing is armed', async () => {
        // The old cut hid the whole section at zero. Now there is always something to do (create a
        // rule, or join an existing one), so the header row must still be there, and its count must
        // read as "nothing", not as the literal digit zero.
        seedTwoRules();
        await render(<AutomationMenuSection terminalId="tm-other" onDismiss={() => {}} />);

        const header = container.querySelector('.context-menu-item') as HTMLButtonElement;
        expect(header).not.toBeNull();
        expect(header.textContent).not.toMatch(/\(0\)/);
    });

    it('renders the section for a pane with no terminal as nothing at all', async () => {
        // `terminalId === null` is the one case that still hides completely — a pane with no
        // terminal has nothing to automate, armed or not.
        await render(<AutomationMenuSection terminalId={null} onDismiss={() => {}} />);
        expect(container.querySelector('.context-menu-item')).toBeNull();
    });

    it('offers both footer actions whether or not anything is armed', async () => {
        seedTwoRules();

        await render(<AutomationMenuSection terminalId="tm-1" onDismiss={() => {}} />);
        await act(async () => {
            (container.querySelector('.context-menu-item') as HTMLButtonElement).click();
        });
        const armedActionLabels = [...container.querySelectorAll('.au-menu-action')]
            .map((el) => el.textContent);
        expect(armedActionLabels.some((t) => t?.includes('New automation for this terminal'))).toBe(true);
        expect(armedActionLabels.some((t) => t?.includes('Add to an existing automation'))).toBe(true);

        // Re-rendering with a different `terminalId` reuses the same component instance (same
        // position in the tree), so `expanded` is already `true` from the click above — clicking
        // the header again would toggle it back closed rather than opening it.
        await render(<AutomationMenuSection terminalId="tm-other" onDismiss={() => {}} />);
        const unarmedActionLabels = [...container.querySelectorAll('.au-menu-action')]
            .map((el) => el.textContent);
        expect(unarmedActionLabels.some((t) => t?.includes('New automation for this terminal'))).toBe(true);
        expect(unarmedActionLabels.some((t) => t?.includes('Add to an existing automation'))).toBe(true);
    });

    /**
     * **"…first" is an ORDER, and neither counter this used to keep could see one.**
     *
     * `dismissed === 1` plus `getOpenAutomationRuleId() === 'r2'` is satisfied by EITHER sequence,
     * so the title's claim — and the `onDismiss` prop doc's "called before the editor opens rather
     * than after" — were the only things asserting it. The order is load-bearing: neither host menu
     * closes itself when a portalled dialog appears on top of it, so an editor opened first is a
     * modal mounted underneath a menu that is still up, with that menu's outside-click and Escape
     * handlers live above it.
     *
     * So BOTH callbacks push into one array and the assertion is the SEQUENCE, which no reordering
     * satisfies. Recording the open call directly, rather than probing `getOpenAutomationRuleId()`
     * from inside `onDismiss`, is what keeps this honest in the case that matters most: an editor
     * host that REFUSES to open (a dirty-guard already registered, `automationEditorGuard`) leaves
     * that id `null` either way, so a probe would report the good order for a run in which the open
     * genuinely came first. The id rides in the recorded event too, so "the SECOND row's rule, not
     * the first and not whichever the section rendered last" — the bug a handler closing over the
     * loop variable by reference produces, which looks right — is pinned by the same equality.
     *
     * Spied through the NAMESPACE, which only intercepts while the transform emits `ns.fn(...)` at
     * the menu's call site. Per the note at this file's imports that failure is loud here rather
     * than silent: an un-intercepted call records nothing and the array comes back `['dismiss']`.
     */
    it('opens the editor for the rule that was clicked, and closes the menu first', async () => {
        seedTwoRules();
        const order: string[] = [];
        const open = jest
            .spyOn(automationEditorHostModule, 'openAutomationEditorFor')
            .mockImplementation((ruleId: string) => { order.push(`open:${ruleId}`); });
        await render(
            <AutomationMenuSection terminalId="tm-1" onDismiss={() => { order.push('dismiss'); }} />,
        );

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

        // Dismiss, THEN the second row's rule — exactly once each, in that order.
        expect(order).toEqual(['dismiss', 'open:r2']);

        open.mockRestore();
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
        // The header's own words, with the icon and the ▾ arrow — which are SPANS — left out, so
        // this can be compared for equality rather than containment. `toContain` would pass a
        // flyout parent hard-coded to "Automations" against a header reading "Automations (2)",
        // which is exactly the drift `armedMenuLabel` was extracted to prevent.
        const accordionLabel = [...container.querySelector('.context-menu-item')!.childNodes]
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent)
            .join('');

        // ONE item that opens a list, not a row per rule — the two menus now have the same shape
        // as well as the same contents.
        const items = automationMenuItems('tm-1');
        expect(items).toHaveLength(1);
        const rows = flyoutRows(items[0]);
        expect(rows.map((r) => r.label)).toEqual(inSection);
        expect(rows[0].detail).toBe('Armed · waiting');

        // …and the row that OPENS the list is worded the same in both, which is the half a
        // "same rules" assertion cannot see: `armedMenuLabel` is why one cannot be renamed alone.
        expect(items[0].label).toBe(accordionLabel);

        // And it does something: the row opens ITS rule, not the first one.
        rows[1].onSelect!();
        expect(getOpenAutomationRuleId()).toBe('r2');
    });

    it('opens on HOVER, and a row opens that rule and dismisses the menu', async () => {
        // Tam: *"we need to do the same submenu on hover on the automations item"*. Hover-opening
        // is `ContextMenu`'s own contract, but it only reaches this feature if the item handed to
        // it is really a submenu PARENT — a plain `click` item renders identically right up until
        // the pointer rests on it, which is the whole of what changed here.
        seedTwoRules();
        const onClose = jest.fn();
        await render(
            <ContextMenu x={10} y={10} items={automationMenuItems('tm-1')} onClose={onClose} />,
        );

        // Portalled to <body>, so the menu is never looked for inside `container`. The row itself
        // is what opens the panel (`onMouseEnter` on the ITEM, not on the host around it), and it
        // is drawn inside a `.context-menu-submenu-host` only because a <button> may not contain
        // the flyout's search input.
        expect(document.querySelector('.context-menu-submenu-host')).not.toBeNull();
        const parentRow = document.querySelector('.context-menu-item')!;
        expect(parentRow.querySelector('.context-menu-label')!.textContent).toBe('Automations (2)');
        expect(document.querySelector('.context-menu-flyout')).toBeNull();

        // `relatedTarget: null` reads as "the pointer arrived from outside the document", which is
        // what makes React synthesize mouseenter on the row. A `mouseover` carrying an in-tree
        // relatedTarget is a silent no-op that looks exactly like a missing handler.
        await act(async () => {
            parentRow.dispatchEvent(
                new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }),
            );
        });

        // The two footer actions ("New automation…", "Add to an existing automation") now render
        // alongside the armed rules, so only the first two rows are the rules under test here.
        const rendered = [...document.querySelectorAll('.context-menu-flyout-row')];
        expect(rendered.slice(0, 2).map((r) => r.querySelector('.context-menu-flyout-label')!.textContent))
            .toEqual(['Watch the build', 'Answer the prompt']);
        expect(rendered[0].querySelector('.context-menu-flyout-detail')!.textContent)
            .toBe('Armed · waiting');

        await act(async () => (rendered[1] as HTMLButtonElement).click());

        expect(getOpenAutomationRuleId()).toBe('r2');
        // `closeMenuOnSelect` — the editor must not open behind a menu that stayed up.
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('still offers ONE item for an unarmed terminal, with no `(0)` in its label', async () => {
        // The old cut returned `[]` here — nothing armed meant nothing to show. Now there is always
        // something behind the item (create a rule, join an existing one), so it must still be
        // offered, worded as "nothing", not as the literal count zero.
        seedTwoRules();
        const items = automationMenuItems('tm-other');
        expect(items).toHaveLength(1);
        expect(items[0].label).not.toMatch(/\(0\)/);
        expect(flyoutRows(items[0])).toEqual([]);
    });

    it('never offers anything for a pane with no terminal', async () => {
        // A parent row over an empty panel is the item that looks live and does nothing. `null`
        // means there is no terminal to automate at all, so this is the one case that still spreads
        // in as no row.
        seedTwoRules();
        expect(automationMenuItems(null)).toEqual([]);
    });

    it('the empty row distinguishes "nothing armed" from "nothing matched"', async () => {
        seedTwoRules();
        const items = automationMenuItems('tm-other');
        const emptyRowFn = items[0].submenu!.emptyRow as (q: string) => ContextMenuFlyoutRow;
        expect(emptyRowFn('').label).toBe('No automation is armed on this terminal');
        expect(emptyRowFn('nope').label).toBe("No automations match 'nope'");
    });

    it('the footer actions are present in both the armed and unarmed cases', async () => {
        seedTwoRules();
        for (const terminalId of ['tm-1', 'tm-other']) {
            const items = automationMenuItems(terminalId);
            const footer = items[0].submenu!.footerRows!;
            expect(footer.map((r) => r.label)).toEqual([
                'New automation for this terminal',
                'Add to an existing automation',
            ]);
        }
    });

    it('"New automation for this terminal" opens a draft targeting this terminal, disabled', async () => {
        seedTwoRules();
        const items = automationMenuItems('tm-9');
        const newRow = items[0].submenu!.footerRows!.find((r) => r.id === 'new-automation')!;
        newRow.onSelect!();

        const draft = getOpenAutomationDraft();
        expect(draft).not.toBeNull();
        expect(draft!.targetMode).toBe('pinned');
        expect(draft!.targetIds).toEqual(['tm-9']);
        expect(draft!.enabled).toBe(false);
    });

    it('"Add to an existing automation" lists only pinned-mode rules', async () => {
        const pinned: AutomationRule = {
            ...rule('r1', 'Pinned rule'), targetMode: 'pinned', targetIds: [],
        };
        __seedAutomationArmedForTest(
            [pinned, { ...rule('r2', 'Criterion rule'), targetMode: 'rule', targetIds: [] }],
            { rules: {} },
        );
        const { add, save } = installAddApi();

        const items = automationMenuItems('tm-9');
        const addRow = items[0].submenu!.footerRows!.find((r) => r.id === 'add-to-existing')!;
        const children = addRow.children!;
        expect(children.map((c) => c.label)).toEqual(['Pinned rule']);

        children[0].onSelect!();
        await Promise.resolve();
        await Promise.resolve();

        // The WHOLE argument list. Only ids and an origin go on the wire — no copy of the rule —
        // which is the structural half of the fix: a payload that carries no rule fields has
        // nothing to overwrite a concurrent edit WITH, so the clobber this row used to be capable
        // of is gone by construction rather than by a narrowed race window.
        expect(add.mock.calls).toEqual([[pinned.id, 'tm-9', expect.any(String)]]);
        expect(save).not.toHaveBeenCalled();
    });

    /**
     * **The STORE decides whether the rule is still there, and this row reports what it answers.**
     *
     * `save_automation` is an unconditional upsert with no version token — deliberately, per
     * `automation_commands.rs` — so writing the copy a menu captured when it opened INSERTS a rule
     * another window has since deleted. The first fix for that re-resolved the rule id against the
     * renderer's own cached list at click time, and claimed in a comment that this closed
     * resurrection outright. It did not: `automation:changed` starts a refresh nobody awaits, and
     * even a perfectly fresh cache leaves the delete free to commit between the read and the write.
     *
     * So the check moved into the transaction that writes (`AutomationStore::add_target_to_rule`,
     * whose own tests pin that a gone rule is not re-INSERTED), and what is left to assert HERE is
     * the renderer's half: a `false` is surfaced rather than swallowed. **The cache is deliberately
     * left holding the deleted rule** — the renderer is told about the delete only by the answer to
     * its own write, which is the whole race. An arrangement that empties the cache first tests a
     * renderer whose cache is already right, i.e. the one case the store-side check was not built
     * for; this one keeps the two disagreeing, which is the state a real delete in another window
     * leaves this window in until its `automation:changed` refetch lands.
     */
    it('says so when the store reports the rule was already deleted', async () => {
        __seedAutomationArmedForTest(
            [{ ...rule('r1', 'Pinned rule'), targetMode: 'pinned', targetIds: [] }],
            { rules: {} },
        );
        const { add, save } = installAddApi(false);
        // Spying through the NAMESPACE only works while the transform emits `ns.fn(...)` at the
        // menu's call site — see the note at this file's imports. The two assertions below fail in
        // opposite directions if it ever stops: the `toast` one goes red, the `refresh` one goes
        // vacuously green.
        const toast = jest
            .spyOn(automationEditorHostModule, 'toastAutomationNotice')
            .mockResolvedValue(undefined);
        const refresh = jest
            .spyOn(automationArmedModule, 'refreshAutomationArmed')
            .mockImplementation(() => {});

        const items = automationMenuItems('tm-9');
        const addRow = items[0].submenu!.footerRows!.find((r) => r.id === 'add-to-existing')!;
        expect(addRow.children!.map((c) => c.label)).toEqual(['Pinned rule']);

        addRow.children![0].onSelect!();
        await Promise.resolve();
        await Promise.resolve();

        // The write was still ATTEMPTED — a renderer that pre-filtered on its own stale cache would
        // skip the call and be right only by luck, and wrong the moment its cache is the stale one.
        expect(add).toHaveBeenCalledTimes(1);
        // Nothing resurrection-shaped went anywhere near the store: the whole-rule upsert this row
        // used to take is the ONE call that could re-INSERT the deleted rule, and it did not run.
        expect(save).not.toHaveBeenCalled();
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls[0][0]).toMatch(/no longer exists/i);
        // Named, so the notice is about the thing the user just clicked.
        expect(toast.mock.calls[0][0]).toContain('Pinned rule');
        // And no re-index, because nothing was committed for one to read — the header's reasoning
        // for keeping the refetch on the written path only, asserted rather than merely written.
        expect(refresh).not.toHaveBeenCalled();

        toast.mockRestore();
        refresh.mockRestore();
    });

    /**
     * …and an edit made elsewhere cannot be CLOBBERED, because nothing stale is sent.
     *
     * This used to assert that the rule was re-resolved from the cache and saved whole, so that a
     * rename in another window rode through instead of being reverted. That was the best a
     * whole-rule upsert allowed, and it was still only a narrower window: whatever the menu resolved
     * could go stale before the write landed. The command carries ids, so the payload does not
     * describe the rule at all and there is nothing in it that CAN be stale — which is a stronger
     * property than "resolved late", and asserted as such: the arguments are identical whether the
     * rule was edited or not.
     */
    it('sends nothing that could revert an edit made in another window', async () => {
        __seedAutomationArmedForTest(
            [{ ...rule('r1', 'Pinned rule'), targetMode: 'pinned', targetIds: [] }],
            { rules: {} },
        );
        const { add, save } = installAddApi();

        const items = automationMenuItems('tm-9');
        const addRow = items[0].submenu!.footerRows!.find((r) => r.id === 'add-to-existing')!;

        // Another window renames the rule, switches it off and rewrites the message it sends.
        const edited: AutomationRule = {
            ...rule('r1', 'Renamed elsewhere'),
            targetMode: 'pinned',
            targetIds: [],
            enabled: false,
            graph: {
                parse: { find: 'y', literal: null },
                cond: { kind: 'text', op: null, threshold: null },
                action: { message: 'edited elsewhere', submit: false },
            },
        } as unknown as AutomationRule;
        __seedAutomationArmedForTest([edited], { rules: {} });

        addRow.children![0].onSelect!();
        await Promise.resolve();
        await Promise.resolve();

        expect(add.mock.calls).toEqual([['r1', 'tm-9', expect.any(String)]]);
        // Not one field of the rule crossed the wire, under any spelling — so `enabled`, `graph`
        // and `name` are exactly as the other window left them.
        const wire = JSON.stringify(add.mock.calls[0]);
        expect(wire).not.toContain('Pinned rule');
        expect(wire).not.toContain('edited elsewhere');
        expect(save).not.toHaveBeenCalled();
    });

    /**
     * **The addable list is LIVE on an unarmed terminal** — the case the section exists for.
     *
     * `useArmedAutomations`' snapshot for a terminal with nothing armed on it is
     * `automationArmed`'s module constant `EMPTY`, whose identity is stable by design, so a
     * `reindex()` → `emit()` re-renders this component through that hook exactly never. A list read
     * bare from `getAutomationRules()` during render therefore froze at the render that opened the
     * menu: a rule created, deleted or retargeted in another window stayed invisible for as long as
     * the menu was up. The re-seed below emits on the same store and changes nothing else.
     */
    it('follows rules created and deleted elsewhere while the menu is open', async () => {
        __seedAutomationArmedForTest(
            [{ ...rule('r1', 'First rule'), targetMode: 'pinned', targetIds: [] }],
            { rules: {} },
        );
        await render(<AutomationMenuSection terminalId="tm-9" onDismiss={() => {}} />);
        await act(async () => {
            (container.querySelector('.context-menu-item') as HTMLButtonElement).click();
        });
        const addToggle = [...container.querySelectorAll('.au-menu-action')]
            .find((el) => el.textContent?.includes('Add to an existing automation')) as HTMLButtonElement;
        await act(async () => addToggle.click());
        // Nothing is armed on `tm-9`, so every `.au-menu-rule-name` on screen is an addable row.
        expect([...container.querySelectorAll('.au-menu-rule-name')].map((n) => n.textContent))
            .toEqual(['First rule']);

        await act(async () => {
            __seedAutomationArmedForTest(
                [{ ...rule('r2', 'Second rule'), targetMode: 'pinned', targetIds: [] }],
                { rules: {} },
            );
        });

        expect([...container.querySelectorAll('.au-menu-rule-name')].map((n) => n.textContent))
            .toEqual(['Second rule']);
    });

    /**
     * **A refused write must be heard.** Both call sites invoke `addTerminalToRule` as
     * `void addTerminalToRule(…)` from a row that dismisses its own menu, so before this guard a
     * rejected write had nowhere at all to land: the user clicked "Add to <rule>", the menu closed,
     * and the terminal was simply never watched. The command genuinely refuses — the store's own
     * docs call a `SQLITE_BUSY` against the 30 s scrollback flush routine, and
     * `add_target_to_rule` re-applies the save gate to an already-enabled rule.
     *
     * Distinct from the `false` case above, and they fail apart: `false` is an ordinary race with
     * a settled outcome, a rejection is a failure with none. Both halves are asserted, because a
     * toast with a stale re-index still tells the pane badge a write happened that did not.
     */
    it('says so when the write is refused, and does not report it as done', async () => {
        __seedAutomationArmedForTest(
            [{ ...rule('r1', 'Pinned rule'), targetMode: 'pinned', targetIds: [] }],
            { rules: {} },
        );
        const addAutomationTarget = jest.fn(() => Promise.reject(new Error('database is locked')));
        (window as unknown as { electronAPI: unknown }).electronAPI = { addAutomationTarget };
        const toast = jest
            .spyOn(automationEditorHostModule, 'toastAutomationNotice')
            .mockResolvedValue(undefined);
        const refresh = jest
            .spyOn(automationArmedModule, 'refreshAutomationArmed')
            .mockImplementation(() => {});

        const items = automationMenuItems('tm-9');
        const addRow = items[0].submenu!.footerRows!.find((r) => r.id === 'add-to-existing')!;
        addRow.children![0].onSelect!();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(toast).toHaveBeenCalledTimes(1);
        // The rule is named, so the message is about a thing the user just clicked rather than a
        // generic failure they cannot place.
        expect(toast.mock.calls[0][0]).toContain('Pinned rule');
        expect(toast.mock.calls[0][0]).toContain('database is locked');
        expect(refresh).not.toHaveBeenCalled();

        toast.mockRestore();
        refresh.mockRestore();
    });

    /** ...and the success path stays silent, so the toast means something when it appears. */
    it('says nothing when the write succeeds, and re-indexes once', async () => {
        __seedAutomationArmedForTest(
            [{ ...rule('r1', 'Pinned rule'), targetMode: 'pinned', targetIds: [] }],
            { rules: {} },
        );
        installAddApi();
        const toast = jest
            .spyOn(automationEditorHostModule, 'toastAutomationNotice')
            .mockResolvedValue(undefined);
        const refresh = jest
            .spyOn(automationArmedModule, 'refreshAutomationArmed')
            .mockImplementation(() => {});

        const items = automationMenuItems('tm-9');
        const addRow = items[0].submenu!.footerRows!.find((r) => r.id === 'add-to-existing')!;
        addRow.children![0].onSelect!();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(toast).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(1);

        toast.mockRestore();
        refresh.mockRestore();
    });

    it('skips a pinned rule that already watches this terminal', async () => {
        __seedAutomationArmedForTest(
            [
                { ...rule('r1', 'Already watching'), targetMode: 'pinned', targetIds: ['tm-9'] },
                { ...rule('r2', 'Not yet watching'), targetMode: 'pinned', targetIds: [] },
            ],
            { rules: {} },
        );
        const items = automationMenuItems('tm-9');
        const addRow = items[0].submenu!.footerRows!.find((r) => r.id === 'add-to-existing')!;
        expect(addRow.children!.map((c) => c.label)).toEqual(['Not yet watching']);
    });

    it('names the reason when no rule can be added to', async () => {
        __seedAutomationArmedForTest(
            [{ ...rule('r2', 'Criterion rule'), targetMode: 'rule', targetIds: [] }],
            { rules: {} },
        );
        const items = automationMenuItems('tm-9');
        const addRow = items[0].submenu!.footerRows!.find((r) => r.id === 'add-to-existing')!;
        expect(addRow.children).toHaveLength(1);
        expect(addRow.children![0].disabled).toBe(true);
        expect(addRow.children![0].label).toMatch(/criterion/i);
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
