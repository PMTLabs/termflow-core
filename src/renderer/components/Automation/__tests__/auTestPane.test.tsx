/**
 * @jest-environment jsdom
 *
 * Milestone M1 review, Important 2: `AuTestPane`'s pill used to read `VERDICTS[report.verdict]`
 * with nothing else consulted, so a substitution refusal at send time (plan 032 §4.4 — a token
 * beyond what the pattern can supply, or no pattern at all) left the ACTION step `failed` while
 * the CONDITION that drove `verdict` was still true. The pane showed a green "Would fire" pill
 * directly above a `✕` action row saying the send was refused — two claims about the same run, on
 * one screen, in direct contradiction. This is reachable from the ordinary editing path: the Test
 * button runs the unsaved draft, and its own Run control is gated only on `running || !chosen`.
 *
 * The fix reads `report.steps` ONLY for the pill's LABEL — `verdict` and `VERDICTS` are both left
 * untouched, which is the invariant the pane's own copy documents: *"the verdict answers the
 * condition, not the arm machine."*
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuTestPane } from '../AuTestPane';
import type { DryRunReport, DryRunStep } from '../../../types/electron';

const step = (kind: DryRunStep['kind'], status: DryRunStep['status'], detail = ''): DryRunStep => ({
    kind,
    status,
    detail,
});

const baseReport = (over: Partial<DryRunReport> = {}): DryRunReport => ({
    verdict: 'would-fire',
    terminalId: 'tm-1',
    terminalName: 'claude',
    steps: [step('monitor', 'ok'), step('parse', 'ok'), step('cond', 'ok'), step('action', 'ok')],
    ...over,
});

describe('AuTestPane — the pill when a would-fire condition cannot actually be sent', () => {
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

    async function show(report: DryRunReport) {
        await act(async () => {
            root.render(
                <AuTestPane
                    report={report}
                    running={false}
                    error={null}
                    terminals={[]}
                    chosen="tm-1"
                    onChoose={() => {}}
                    onRun={() => {}}
                />,
            );
        });
        return container.querySelector('.au-pill');
    }

    it('shows the ordinary "Would fire" pill when the action step also succeeded', async () => {
        const pill = await show(baseReport());
        expect(pill?.textContent).toBe('Would fire');
        expect(pill?.className).toContain('sim');
    });

    it('says nothing would be sent when the action step failed under a would-fire verdict', async () => {
        const report = baseReport({
            steps: [
                step('monitor', 'ok'),
                step('parse', 'ok'),
                step('cond', 'ok'),
                step('action', 'failed', '$3 has nothing to stand for'),
            ],
        });
        const pill = await show(report);
        expect(pill?.textContent).toContain('Would fire');
        expect(pill?.textContent).toContain('nothing would be sent');
    });

    it('does not attach this label to a would-not-fire or unreadable verdict', async () => {
        const notFire = await show(
            baseReport({
                verdict: 'would-not-fire',
                steps: [
                    step('monitor', 'ok'),
                    step('parse', 'ok'),
                    step('cond', 'ok'),
                    step('action', 'skipped'),
                ],
            }),
        );
        expect(notFire?.textContent).toBe('Would not fire');

        const unreadable = await show(
            baseReport({
                verdict: 'unreadable',
                steps: [
                    step('monitor', 'failed'),
                    step('parse', 'skipped'),
                    step('cond', 'skipped'),
                    step('action', 'skipped'),
                ],
            }),
        );
        expect(unreadable?.textContent).toBe('Nothing could be read');
    });

    /**
     * **`unknown` is a third answer and must be drawn as one.** `MARKS` had three entries and fell
     * back to `·` — `skipped`'s own mark — for anything else, so a clause the engine evaluated and
     * could not answer would have looked exactly like a step that never ran.
     */
    it('draws an evaluated-but-unanswerable step as neither a pass nor a skip', async () => {
        await show(
            baseReport({
                verdict: 'would-not-fire',
                steps: [
                    step('monitor', 'ok'),
                    step('parse', 'ok', '`code=(\\w+)` matched on screen'),
                    step('cond', 'unknown', 'could not tell whether $1 > 60, as an event'),
                    step('action', 'skipped', 'not reached'),
                ],
            }),
        );
        const rows = [...container.querySelectorAll('.au-dstep')];
        const condRow = rows.find((r) => r.textContent?.includes('could not tell'))!;
        expect(condRow).toBeTruthy();
        expect(condRow.className).toContain('unknown');
        expect(condRow.querySelector('.au-mk')?.textContent).toBe('?');
        // Not the skipped mark, and not the pass mark.
        expect(condRow.querySelector('.au-mk')?.textContent).not.toBe('·');
        expect(condRow.querySelector('.au-mk')?.textContent).not.toBe('✓');
    });

    /**
     * A `failed` step that is NOT the action must not trigger the special label — e.g. a `parse`
     * failure cannot coexist with a `would-fire` verdict in practice, but the label is keyed
     * specifically on `kind === 'action'`, not on "any step failed", and this pins that.
     */
    it('keys the label on the ACTION step specifically, not on any failed step', async () => {
        const report = baseReport({
            steps: [
                step('monitor', 'ok'),
                step('parse', 'failed'),
                step('cond', 'skipped'),
                step('action', 'skipped'),
            ],
        });
        const pill = await show(report);
        expect(pill?.textContent).toBe('Would fire');
    });
});
