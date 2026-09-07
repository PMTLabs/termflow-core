/**
 * @jest-environment jsdom
 *
 * Webhook redaction covers the enumerated surfaces below. This is intentionally not a derived
 * registry: adding a future display surface does not make this test find it automatically.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type { AutomationLogEntry } from '../../../types/electron';
import { ActivityLogView } from '../../Settings/Automations/ActivityLogView';
import { logCopyText } from '../../Settings/Automations/activityLog';
import {
    REDACTED_WEBHOOK_URL,
    redactWebhookError,
    redactWebhookLogEntry,
} from '../webhookRedaction';

const secret = 'https://hooks.example.invalid/renderer-credential';

function entry(over: Partial<AutomationLogEntry> = {}): AutomationLogEntry {
    return {
        id: 1,
        ruleId: 'au-1',
        terminalId: 'tm-1',
        terminalName: secret,
        kind: 'failed',
        detail: `webhook failed: ${secret}`,
        at: new Date(2026, 8, 4, 9, 11, 5).getTime(),
        ...over,
    };
}

describe('webhook redaction — enumerated surfaces only', () => {
    it('redacts every serialised activity entry field, not only detail', () => {
        const source = entry({ ruleId: secret, terminalId: secret });
        const safe = redactWebhookLogEntry(source);
        expect(JSON.stringify(safe)).toBe(JSON.stringify({
            ...source,
            ruleId: REDACTED_WEBHOOK_URL,
            terminalId: REDACTED_WEBHOOK_URL,
            terminalName: REDACTED_WEBHOOK_URL,
            detail: `webhook failed: ${REDACTED_WEBHOOK_URL}`,
        }));
    });

    it('copies the actual redacted clipboard text, not merely the rendered row', () => {
        const copied = logCopyText([entry()]);
        expect(copied).toBe(
            `09:11:05\ttm-1 ${REDACTED_WEBHOOK_URL}\tfailed\twebhook failed: ${REDACTED_WEBHOOK_URL}`,
        );
        expect(copied).not.toContain(secret);
    });

    it('passes the exact redacted export text to the Activity Log Copy action', async () => {
        const writeText = jest.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);

        await act(async () => {
            root.render(
                <ActivityLogView
                    rule={null}
                    entries={[entry()]}
                    newestFirst={false}
                    error={null}
                    now={0}
                    onScopeChange={jest.fn()}
                    onSetVerbose={jest.fn()}
                    onBack={jest.fn()}
                />,
            );
        });
        await act(async () => {
            [...container.querySelectorAll('button')].find((button) => button.textContent === 'Copy')!.click();
        });

        expect(writeText).toHaveBeenCalledWith(
            `09:11:05\ttm-1 ${REDACTED_WEBHOOK_URL}\tfailed\twebhook failed: ${REDACTED_WEBHOOK_URL}`,
        );
        expect(container.textContent).not.toContain(secret);
        await act(async () => root.unmount());
        container.remove();
    });

    it('redacts the error text that save, enable, and duplicate toast paths receive', () => {
        const error = new Error(`automation store rejected the value: ${secret}`);
        expect(redactWebhookError(error)).toBe(
            `automation store rejected the value: ${REDACTED_WEBHOOK_URL}`,
        );
    });
});
