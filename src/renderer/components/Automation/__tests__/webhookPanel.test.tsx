/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import { problems } from '../automationValidation';
import payloadFixture from '../__fixtures__/webhookPayloadCases.json';
import { previewWebhookPayload } from '../panels/WebhookPanel';
import type { AutomationRule, AutomationWebhookProvider } from '../../../types/electron';
import { blankDraft } from '../../Settings/Automations/automationTemplates';

const SECRET_A = 'https://hooks.example.invalid/secret-a';
const SECRET_B = 'https://hooks.example.invalid/secret-b';

interface PayloadCase {
    provider: AutomationWebhookProvider;
    message: string;
    expected: string;
}

const payloadCases = (payloadFixture as unknown as { cases: PayloadCase[] }).cases;

function ruleWithWebhook(
    id: string,
    provider: AutomationWebhookProvider = 'discord',
    body = 'build failed',
): AutomationRule {
    const blank = blankDraft();
    const { action: _action, ...graph } = blank.graph;
    return {
        ...blank,
        id,
        graph: {
            ...graph,
            webhook: { provider, url: id === 'au-b' ? SECRET_B : SECRET_A, body },
        },
    };
}

describe('the webhook inspector', () => {
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

    async function show(rule: AutomationRule) {
        const draft = { ...draftFromRule(rule), selected: 'webhook' as const };
        await act(async () => {
            root.render(
                <AuInspector
                    draft={draft}
                    problems={problems(rule)}
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
    }

    const urlInput = () => container.querySelector<HTMLInputElement>('[aria-label="Webhook URL"]')!;
    const preview = () => container.querySelector<HTMLElement>('[data-testid="webhook-preview"]')!;

    it('masks the URL until Reveal is pressed', async () => {
        await show(ruleWithWebhook('au-a'));
        expect(urlInput().type).toBe('password');
        expect(container.textContent).not.toContain(SECRET_A);

        await act(async () => {
            [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reveal')!.click();
        });
        expect(urlInput().type).toBe('text');

        // A different saved rule replaces the panel, so its credential cannot inherit Reveal.
        await show(ruleWithWebhook('au-b'));
        expect(urlInput().type).toBe('password');
        expect(container.textContent).not.toContain(SECRET_A);
        expect(container.textContent).not.toContain(SECRET_B);
    });

    it('never renders the URL in the preview', async () => {
        for (const payloadCase of payloadCases) {
            await show(ruleWithWebhook('au-a', payloadCase.provider, payloadCase.message));
            expect(preview().textContent).toBe(payloadCase.expected);
            expect(preview().textContent).not.toContain(SECRET_A);
            expect(container.textContent).not.toContain(SECRET_A);
            for (const element of container.querySelectorAll<HTMLElement>('[title], [aria-label]')) {
                expect(element.getAttribute('title') ?? '').not.toContain(SECRET_A);
                expect(element.getAttribute('aria-label') ?? '').not.toContain(SECRET_A);
            }
            expect([...container.querySelectorAll('button')].some((button) => /copy/i.test(button.textContent ?? ''))).toBe(false);
        }
    });

    it('previewWebhookPayload matches the shared fixture', () => {
        expect(payloadCases).toHaveLength(7);
        for (const payloadCase of payloadCases) {
            expect(previewWebhookPayload(payloadCase.provider, payloadCase.message))
                .toBe(payloadCase.expected);
        }
    });

    it('refuses a capture token the pattern cannot supply', async () => {
        const rule = ruleWithWebhook('au-a');
        const withPattern: AutomationRule = {
            ...rule,
            graph: {
                ...rule.graph,
                parse: { preset: 'custom', literal: null, find: 'FAILED (\\d+)', keep: 'brackets' },
                webhook: { ...rule.graph.webhook!, body: 'post $2', substitute: true },
            },
        };
        expect(problems(withPattern)).toContainEqual(expect.objectContaining({
            field: 'webhook',
            code: 'action.unknownToken',
        }));

        await show(withPattern);
        expect(container.textContent).toContain('$2 has nothing to stand for.');
    });
});
