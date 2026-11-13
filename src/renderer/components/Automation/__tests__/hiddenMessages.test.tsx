/** @jest-environment jsdom */
import React, { act, useReducer } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ActionPanel } from '../panels/ActionPanel';
import { draftFromRule, draftReducer, isDirty, ruleFromDraft } from '../automationDraft';
import { describeRule, faceFor, MASKED_MESSAGE, panelFor, ruleSummary } from '../automationDerive';
import { problems } from '../automationValidation';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';
import wire from '../__fixtures__/hiddenMessageWireCases.json';
import type { AutomationActionStep, AutomationRule } from '../../../types/electron';

jest.mock('../panels/SnippetPickerButton', () => ({
    SnippetPickerButton: ({ onInsert }: { onInsert: (s: string) => void }) => (
        <button onClick={() => onInsert('replacement snippet')}>Insert test snippet</button>
    ),
}));
const secret = 'password-876 ${secretPassword}';
const rule = (substitute = false): AutomationRule => {
    const r = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
    r.id = 'hidden';
    r.graph.action = { ...r.graph.action!, message: secret, masked: true, substitute };
    return r;
};
const ctx = { problems: [], now: 0 };

describe('hidden terminal message', () => {
    let root: Root;
    let container: HTMLDivElement;
    let current: ReturnType<typeof draftFromRule>;
    beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
    function Host({ initial }: { initial: AutomationRule }) {
        const [draft, dispatch] = useReducer(draftReducer, initial, draftFromRule);
        current = draft;
        return <ActionPanel key={draft.rule.id} draft={draft}
            model={panelFor(ruleFromDraft(draft), 'action', ctx)} dispatch={dispatch} />;
    }
    async function show(r = rule()) { await act(async () => root.render(<Host key={r.id} initial={r} />)); }
    const box = () => container.querySelector('textarea')!;
    const hide = () => [...container.querySelectorAll('label')].find((l) => l.textContent?.includes('Hide message'))!.querySelector('input')!;
    const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
    async function click(el: HTMLElement) { await act(async () => el.click()); }
    function clipboard(type: string): Event {
        const e = new Event(type, { bubbles: true, cancelable: true }); box().dispatchEvent(e); return e;
    }
    it.each([false, true])('masks derive, preview, warnings and tooltips (substitute=%s)', async (substitute) => {
        const r = rule(substitute);
        expect(JSON.stringify(faceFor(r, 'action', ctx))).not.toContain('password-876');
        expect(ruleSummary(r)).toContain(MASKED_MESSAGE);
        expect(describeRule(r).message).toBe(MASKED_MESSAGE);
        expect(JSON.stringify(problems(r))).not.toContain('secretPassword');
        await show(r);
        expect(box().value).toBe(secret);
        expect(box().classList.contains('au-finput-masked')).toBe(true);
        expect(container.querySelector('[data-testid="action-preview"]')!.textContent).toContain(MASKED_MESSAGE);
        expect([...container.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).join('')).not.toContain('secretPassword');
        expect(clipboard('copy').defaultPrevented).toBe(true);
        expect(clipboard('cut').defaultPrevented).toBe(true);
        await click(button('Reveal'));
        expect(box().classList.contains('au-finput-masked')).toBe(false);
        expect(clipboard('copy').defaultPrevented).toBe(false);
        expect(clipboard('cut').defaultPrevented).toBe(false);
        expect(container.querySelector('[data-testid="action-preview"]')!.textContent).toContain(substitute ? '${secretPassword}' : secret);
    });
    it('uses the same generic blocking diagnostic words as Rust', () => {
        const r = rule(true);
        expect(problems(r).find((p) => p.code === 'action.unknownToken')).toMatchObject({
            severity: 'blocks',
            message: 'A hidden message token has nothing to stand for. Check the pattern in Read a value.',
        });
        r.graph.action!.message = ''; r.graph.action!.messageCipher = 'v1:unreadable';
        expect(problems(r).find((p) => p.code === 'action.hiddenUnreadable')).toMatchObject({
            severity: 'blocks',
            message: "The hidden message can't be read on this machine — type it again.",
        });
    });

    it('resets Reveal on off→on and rule replacement', async () => {
        await show(); await click(button('Reveal'));
        await click(hide());
        expect(clipboard('copy').defaultPrevented).toBe(false);
        await click(hide());
        expect(box().classList.contains('au-finput-masked')).toBe(true);
        await click(button('Reveal'));
        await show({ ...rule(), id: 'replacement' });
        expect(box().classList.contains('au-finput-masked')).toBe(true);
    });
    it.each(['textarea', 'token', 'snippet'])('unreadable cannot unhide; %s replacement clears cipher', async (method) => {
        const r = rule(); r.graph.action!.message = ''; r.graph.action!.messageCipher = 'v1:unreadable';
        await show(r);
        expect(hide().disabled).toBe(true);
        expect(container.textContent).toContain('Type the message again before un-hiding it');
        if (method === 'textarea') {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), 'retyped');
                box().dispatchEvent(new Event('input', { bubbles: true }));
            });
        } else await click(method === 'token' ? container.querySelector('.au-token')! : button('Insert test snippet'));
        expect(current.rule.graph.action!.message.length).toBeGreaterThan(0);
        expect(current.rule.graph.action!.messageCipher).toBeUndefined();
        expect(hide().disabled).toBe(false);
    });
    it.each(wire.cases)('$name: renderer save and Rust refetch reopen clean', (testCase) => {
        const before = rule();
        before.graph.action = testCase.input as AutomationActionStep;
        const outgoing = ruleFromDraft(draftFromRule(before));
        const refetched = { ...outgoing, graph: { ...outgoing.graph, action: testCase.hydrated as AutomationActionStep } };
        expect(isDirty({ ...draftFromRule(refetched), rule: outgoing })).toBe(false);
        expect(isDirty(draftFromRule(refetched))).toBe(false);
    });

    it('canonicalises legacy defaults, field order, hidden round trips and unreadable saves', () => {
        const legacy = rule(); delete legacy.graph.action!.masked; delete legacy.graph.action!.substitute;
        let draft = draftFromRule(legacy);
        expect(isDirty(draft)).toBe(false);
        draft = draftReducer(draft, { type: 'action', patch: { masked: true } });
        expect(isDirty(draft)).toBe(true);
        draft = draftReducer(draft, { type: 'action', patch: { masked: false } });
        expect(isDirty(draft)).toBe(false);
        const saved = rule();
        const reordered = { ...saved, graph: { ...saved.graph, action: {
            message: secret, masked: true, sendTo: saved.graph.action!.sendTo, submit: true,
            cliType: saved.graph.action!.cliType, substitute: false,
        } } };
        expect(isDirty({ ...draftFromRule(saved), rule: reordered })).toBe(false);
        saved.graph.action!.message = ''; saved.graph.action!.messageCipher = 'v1:unreadable';
        const unrelated = draftReducer(draftFromRule(saved), { type: 'name', name: 'edited' });
        const written = ruleFromDraft(unrelated);
        expect(written.graph.action!.messageCipher).toBe('v1:unreadable');
        expect(isDirty(draftFromRule(written))).toBe(false);
    });
});
