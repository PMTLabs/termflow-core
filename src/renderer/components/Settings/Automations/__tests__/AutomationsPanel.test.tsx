/**
 * @jest-environment jsdom
 *
 * §10.28 — the list panel.
 *
 * The empty state, one row per rule, `aria-checked` tracking `enabled`, and **Duplicate calling the
 * bridge exactly once with the id and issuing no `saveAutomation`**. That last one is the assertion
 * that keeps the copy's rules in the backend: the id mint, the sort order that puts the copy
 * directly under its original, and decision 12's "does not inherit" column list all live in
 * `duplicate_automation`, and a renderer that re-implemented them would drift the first time a
 * column was added.
 *
 * jsdom implements no layout, so nothing here says anything about whether the panel LOOKS right —
 * that is what the GUI checklist is for. These are contracts, not appearances.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

jest.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));

// eslint-disable-next-line import/first
import { AutomationsPanel } from '../AutomationsPanel';
// eslint-disable-next-line import/first
import { JUST_FIRED_MS } from '../automationState';
// eslint-disable-next-line import/first
import type { AutomationRule } from '../../../../types/electron';

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
    return {
        id: 'au-1',
        name: 'Context handoff reminder',
        enabled: true,
        runsOnce: false,
        targetMode: 'rule',
        criterion: 'commandContains',
        criterionValue: 'claude',
        followNew: true,
        targetIds: ['tm-a'],
        completedAt: null,
        verboseUntil: null,
        sortOrder: 0,
        schemaVersion: 1,
        graph: {
            monitor: { read: 'newOutput', cadence: 'timer', everyMs: 30000 },
            parse: { preset: 'percentage', literal: null, find: 'ctx:(\\d+)%', keep: 'brackets' },
            cond: { kind: 'number', op: 'gt', threshold: 25 },
            action: {
                message: 'prepare to do context-hand-off',
                sendTo: 'matched',
                submit: true,
                cliType: 'default',
            },
        },
        createdAt: 0,
        updatedAt: 0,
        ...over,
    };
}

interface Api {
    listAutomations: jest.Mock;
    getAutomationRuntime: jest.Mock;
    loadAutomationLog: jest.Mock;
    duplicateAutomation: jest.Mock;
    setAutomationEnabled: jest.Mock;
    deleteAutomation: jest.Mock;
    resetAutomation: jest.Mock;
    saveAutomation: jest.Mock;
}

function installApi(rules: AutomationRule[]): Api {
    const api: Api = {
        listAutomations: jest.fn(() => Promise.resolve(rules)),
        getAutomationRuntime: jest.fn(() => Promise.resolve({ rules: {} })),
        loadAutomationLog: jest.fn(() => Promise.resolve([])),
        duplicateAutomation: jest.fn(() => Promise.resolve(rules[0])),
        setAutomationEnabled: jest.fn(() => Promise.resolve()),
        deleteAutomation: jest.fn(() => Promise.resolve(true)),
        resetAutomation: jest.fn(() => Promise.resolve()),
        saveAutomation: jest.fn(() => Promise.resolve(null)),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    return api;
}

describe('AutomationsPanel', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        document.querySelectorAll('.confirm-dialog-overlay').forEach((n) => n.remove());
        jest.clearAllMocks();
    });

    async function mount() {
        await act(async () => {
            root.render(<AutomationsPanel />);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }

    it('draws the empty state when there are no rules, and offers the templates', async () => {
        installApi([]);
        await mount();
        const empty = container.querySelector('.au-empty');
        expect(empty?.textContent).toContain('No automations yet');
        expect(container.querySelectorAll('.au-row')).toHaveLength(0);
    });

    it('renders one row per rule and tracks enabled through aria-checked', async () => {
        installApi([rule(), rule({ id: 'au-2', name: 'Build failure nudge', enabled: false })]);
        await mount();

        const rows = container.querySelectorAll('.au-row');
        expect(rows).toHaveLength(2);
        const switches = container.querySelectorAll('[role="switch"]');
        expect([...switches].map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'false']);
        // The off row is dimmed as well as pilled — one of two different signals, never colour alone.
        expect(rows[1].className).toContain('au-off');
        expect(rows[1].querySelector('.au-pill')?.textContent).toContain('Off');
    });

    it('Duplicate calls the bridge exactly once with the id, and saves nothing', async () => {
        const api = installApi([rule()]);
        await mount();

        const duplicate = container.querySelector<HTMLButtonElement>(
            '[aria-label="Duplicate Context handoff reminder"]',
        );
        expect(duplicate).not.toBeNull();
        await act(async () => {
            duplicate!.click();
        });

        expect(api.duplicateAutomation).toHaveBeenCalledTimes(1);
        expect(api.duplicateAutomation).toHaveBeenCalledWith('au-1', 'main');
        // The backend owns the id mint, the sort order and the "does not inherit" list. A renderer
        // copy would have to re-implement decision 12's exclusions.
        expect(api.saveAutomation).not.toHaveBeenCalled();
    });

    it("a completed rule's switch is inert and gains Reset", async () => {
        const api = installApi([rule({ runsOnce: true, completedAt: 1000 })]);
        await mount();

        const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
        expect(toggle?.disabled).toBe(true);
        const reset = [...container.querySelectorAll('button')].find(
            (b) => b.textContent === 'Reset',
        );
        expect(reset).toBeDefined();
        await act(async () => {
            reset!.click();
        });
        expect(api.resetAutomation).toHaveBeenCalledWith('au-1', 'main');
        expect(api.setAutomationEnabled).not.toHaveBeenCalled();
    });

    it('offers the reversible option before deleting an enabled rule', async () => {
        const api = installApi([rule()]);
        await mount();

        await act(async () => {
            container
                .querySelector<HTMLButtonElement>('[aria-label="Delete Context handoff reminder"]')!
                .click();
        });

        const footer = document.querySelector('.confirm-dialog-footer');
        expect([...footer!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
            'Cancel',
            'Switch off instead',
            'Delete',
        ]);

        await act(async () => {
            [...footer!.querySelectorAll('button')]
                .find((b) => b.textContent === 'Switch off instead')!
                .click();
        });
        expect(api.setAutomationEnabled).toHaveBeenCalledWith('au-1', false, 'main');
        expect(api.deleteAutomation).not.toHaveBeenCalled();
    });

    it('a filter that hides everything says so differently from having nothing', async () => {
        // A paused rule must not read as a lost one: the empty state is an invitation, the
        // filtered-out state is a reminder that the rules are still there.
        installApi([rule({ enabled: false })]);
        await mount();

        await act(async () => {
            [...container.querySelectorAll('button')]
                .find((b) => b.textContent === 'Active')!
                .click();
        });
        const empty = container.querySelector('.au-empty');
        expect(empty?.textContent).toContain('No automations match this filter');
        expect(empty?.textContent).not.toContain('No automations yet');
    });

    it('a store that REFUSES is not drawn as a store with nothing in it', async () => {
        // §7.8 assigns this explicitly: `Err(Disabled)` rendered as an empty list is
        // indistinguishable from "you have no rules", and invites a user to recreate rules that
        // already exist. The first version guarded the empty state on `rules.length === 0` alone,
        // so a failed read drew an alert line AND the full "No automations yet" invitation under it.
        const api = installApi([]);
        api.listAutomations.mockRejectedValue(new Error('the rule store is disabled'));
        await mount();

        expect(container.querySelector('[role="alert"]')?.textContent).toContain('disabled');
        // Over the WHOLE panel, not the first `.au-empty`. The defect being pinned is that the
        // invitation renders BELOW the error, and `querySelector` returns the first match — so an
        // oracle reading one element passed while both were on screen, which is the bug. Mutation
        // found that: reverting the guard left this test green.
        const panel = container.textContent ?? '';
        expect(panel).toContain('could not be read');
        expect(panel).toContain('have not been deleted');
        expect(panel).not.toContain('No automations yet');
        expect(container.querySelectorAll('.au-empty')).toHaveLength(1);
    });

    it('the log view says a read FAILED rather than that nothing has happened', async () => {
        const api = installApi([rule()]);
        api.loadAutomationLog.mockRejectedValue(new Error('the rule store is disabled'));
        await mount();
        await act(async () => {
            container
                .querySelector<HTMLButtonElement>('[aria-label="Activity log for Context handoff reminder"]')!
                .click();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const rows = container.querySelector('.au-logrows');
        expect(rows?.textContent).toContain('could not be read');
        // The confident copy must not also be on screen — the log view REPLACES the list, so this
        // is the only thing the user can see.
        expect(rows?.textContent).not.toContain('Nothing logged yet');
    });

    it('the log bar can turn the verbose gate on, which nothing else in the app could', async () => {
        // Without this control `verbose_until` had no writer anywhere, so the store dropped every
        // `Check`-class entry forever and two of the five row kinds §06 draws could never appear.
        const api = installApi([rule()]);
        await mount();
        await act(async () => {
            container
                .querySelector<HTMLButtonElement>('[aria-label="Activity log for Context handoff reminder"]')!
                .click();
        });

        const toggle = container.querySelector<HTMLButtonElement>(
            '[aria-label="Log every check for Context handoff reminder"]',
        );
        expect(toggle).not.toBeNull();
        expect(toggle!.getAttribute('aria-checked')).toBe('false');

        await act(async () => toggle!.click());
        expect(api.saveAutomation).toHaveBeenCalledTimes(1);
        const [saved] = api.saveAutomation.mock.calls[0];
        // A DEADLINE, not a flag: the store's gate compares each entry's timestamp against it, and
        // an always-on verbose log evicts everything worth keeping from a 200-entry buffer.
        expect(saved.verboseUntil).toBeGreaterThan(Date.now());
        expect(saved.id).toBe('au-1');
    });

    it('reads an EXPIRED verbose window as off, not as on', async () => {
        // `verbose_until` is a deadline, so the control has to compare it with the clock. Reading it
        // as "is it set" leaves the toggle showing on for a window that closed hours ago — and the
        // backend NULLs stale deadlines at startup, so the two would then disagree as well.
        const past = rule({ verboseUntil: Date.now() - 60_000 });
        installApi([past]);
        await mount();
        await act(async () => {
            container
                .querySelector<HTMLButtonElement>('[aria-label="Activity log for Context handoff reminder"]')!
                .click();
        });
        expect(
            container
                .querySelector('[aria-label="Log every check for Context handoff reminder"]')
                ?.getAttribute('aria-checked'),
        ).toBe('false');

    });

    it('reads a LIVE verbose window as on', async () => {
        // The positive half of the pair, in its own mount: the negative above is only meaningful if
        // the control is capable of reading `true` at all.
        installApi([rule({ verboseUntil: Date.now() + 60_000 })]);
        await mount();
        await act(async () => {
            container
                .querySelector<HTMLButtonElement>('[aria-label="Activity log for Context handoff reminder"]')!
                .click();
        });
        expect(
            container
                .querySelector('[aria-label="Log every check for Context handoff reminder"]')
                ?.getAttribute('aria-checked'),
        ).toBe('true');
    });

    it('offers Forget it only when there is something it could forget', async () => {
        // `missing` is `watched_set \\ live`, and for a criterion rule with `followNew: false` the
        // watched set is a frozen match list with no relationship to `targetIds` — which is empty
        // for such a rule. The button filtered nothing, saved an unchanged rule, wrote a `saved`
        // log line claiming to have replaced a version, and left the row identical. Forever.
        const frozen = rule({ id: 'au-frozen', targetMode: 'rule', followNew: false, targetIds: [] });
        const pinned = rule({ id: 'au-pinned', targetMode: 'pinned', targetIds: ['tm-gone'] });
        const api = installApi([frozen, pinned]);
        api.getAutomationRuntime.mockResolvedValue({
            rules: {
                'au-frozen': { 'tm-gone': { state: 'armed', lastFiredAt: null, firedCount: 0, missing: true } },
                'au-pinned': { 'tm-gone': { state: 'armed', lastFiredAt: null, firedCount: 0, missing: true } },
            },
        });
        await mount();

        const forgets = [...container.querySelectorAll('button')].filter(
            (b) => b.textContent === 'Forget it',
        );
        expect(forgets).toHaveLength(1);

        await act(async () => forgets[0].click());
        expect(api.saveAutomation).toHaveBeenCalledTimes(1);
        expect(api.saveAutomation.mock.calls[0][0].id).toBe('au-pinned');
        expect(api.saveAutomation.mock.calls[0][0].targetIds).toEqual([]);
    });

    it('lets Just fired expire on its own, with no further events', async () => {
        // The one row state that ends by itself. `automation:state` is emitted on TRANSITIONS, so a
        // rule that fires on a terminal which then goes quiet produces exactly one — and nothing
        // would re-render the panel to let the receipt settle. It stayed "Just fired" indefinitely.
        jest.useFakeTimers();
        try {
            const api = installApi([rule()]);
            api.getAutomationRuntime.mockResolvedValue({
                rules: {
                    'au-1': {
                        'tm-a': {
                            state: 'fired',
                            lastFiredAt: Date.now() - 1000,
                            firedCount: 1,
                            missing: false,
                        },
                    },
                },
            });
            await act(async () => {
                root.render(<AutomationsPanel />);
            });
            await act(async () => {
                await Promise.resolve();
            });
            expect(container.querySelector('.au-pill')?.textContent).toContain('Just fired');

            await act(async () => {
                jest.advanceTimersByTime(JUST_FIRED_MS);
            });
            expect(container.querySelector('.au-pill')?.textContent)
                .toContain('waiting to re-arm');
        } finally {
            jest.useRealTimers();
        }
    });

    it('the template gallery shows the six templates plus a blank card', async () => {
        installApi([]);
        await mount();

        await act(async () => {
            [...container.querySelectorAll('button')]
                .find((b) => b.textContent?.includes('New automation'))!
                .click();
        });
        expect(container.querySelectorAll('.au-tplcard')).toHaveLength(7);
        expect(container.querySelectorAll('.au-tplcard.blank')).toHaveLength(1);
    });
});
