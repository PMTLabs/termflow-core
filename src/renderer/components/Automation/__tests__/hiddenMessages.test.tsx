/** @jest-environment jsdom */
import React, { act, useReducer } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ActionPanel } from '../panels/ActionPanel';
import { canonicalJson, draftFromRule, draftReducer, isDirty, ruleFromDraft } from '../automationDraft';
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
    const hide = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => [...(i.labels ?? [])].some((l) => l.textContent?.includes('Hide message')))!;
    const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
    async function click(el: HTMLElement) { await act(async () => el.click()); }
    function clipboard(type: string): Event {
        const e = new Event(type, { bubbles: true, cancelable: true }); box().dispatchEvent(e); return e;
    }
    it('explains Hide with a styled row, an info icon and a Reveal button beside the message', async () => {
        await show();
        const row = hide().closest('.au-checkrow')!;
        expect(row).not.toBeNull();
        expect(row.textContent).toContain('Hide message (password or secret)');
        expect(row.querySelector('.au-rsub')!.textContent).toContain('The terminal still receives exactly what you typed');
        // Named by its label text only; the explanation is its description, not part of its name.
        const names = [...hide().labels!].filter((l) => l.getAttribute('aria-hidden') !== 'true').map((l) => l.textContent);
        expect(names).toEqual(['Hide message (password or secret)']);
        expect(document.getElementById(hide().getAttribute('aria-describedby')!)!.textContent)
            .toContain('The terminal still receives exactly what you typed');
        const info = row.querySelector<HTMLButtonElement>('button.au-info')!;
        expect(info.closest('label')).toBeNull(); // a button is not valid label content
        expect(info.getAttribute('aria-label')).toBe('About hiding the message');
        expect(info.getAttribute('title')).toMatch(/dots everywhere.*encrypted.*exactly what you typed/);
        const wasMasked = hide().checked;
        await click(info);
        expect(hide().checked).toBe(wasMasked);
        // The text label and the tick mark both still toggle the box.
        await click([...hide().labels!].find((l) => l.textContent === 'Hide message (password or secret)')!);
        expect(hide().checked).toBe(!wasMasked);
        await click(row.querySelector<HTMLElement>('label.au-cmark')!);
        expect(hide().checked).toBe(wasMasked);
        expect(document.body.querySelector('.au-infopop')!.textContent).toContain('system keystore');
        const reveal = button('Reveal');
        expect(reveal.classList.contains('au-mini')).toBe(true);
        expect(reveal.closest('.au-frow-message')).toBe(box().closest('.au-frow-message'));
        expect(reveal.getAttribute('aria-pressed')).toBe('false');
    });

    it.each([false, true])('masks derive, preview, warnings and tooltips (substitute=%s)', async (substitute) => {
        const r = rule(substitute);
        expect(JSON.stringify(faceFor(r, 'action', ctx))).not.toContain('password-876');
        expect(ruleSummary(r)).toBe(ruleSummary({ ...r, graph: { ...r.graph,
            action: { ...r.graph.action!, masked: false, message: MASKED_MESSAGE } } }));
        expect(describeRule(r).message).toBe(MASKED_MESSAGE);
        expect(JSON.stringify(problems(r))).not.toContain('secretPassword');
        await show(r);
        expect(box().value).toBe(secret);
        expect(box().classList.contains('au-finput-masked')).toBe(true);
        expect(container.querySelector('[data-testid="action-preview"]')!.textContent).toBe(`> ${MASKED_MESSAGE}⏎`);
        expect([...container.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).join('')).not.toContain('secretPassword');
        expect(clipboard('copy').defaultPrevented).toBe(true);
        expect(clipboard('cut').defaultPrevented).toBe(true);
        await click(button('Reveal'));
        expect(box().classList.contains('au-finput-masked')).toBe(false);
        expect(clipboard('copy').defaultPrevented).toBe(false);
        expect(clipboard('cut').defaultPrevented).toBe(false);
        expect(container.querySelector('[data-testid="action-preview"]')!.textContent).toBe(substitute
            ? 'Nothing would be sent — ${secretPassword} has nothing to stand for.' : `> ${secret}⏎`);
    });
    it('keeps edited hidden text out of body text after input event completion', async () => {
        await show();
        const edited = 'edited-password-935 ${secretPassword}';
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), edited);
            box().dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(box().value).toBe(edited);
        expect(current.rule.graph.action!.message).toBe(edited);
        expect(box().classList.contains('au-finput-masked')).toBe(true);
        expect(document.body.textContent).not.toContain('edited-password-935');
        expect(document.body.textContent).not.toContain('secretPassword');
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
        expect([...container.querySelectorAll('.au-fhelp')].map((el) => el.textContent))
            .toContain("This hidden message can't be read on this computer. Type the message again before un-hiding it.");
        if (method === 'textarea') {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), 'retyped');
                box().dispatchEvent(new Event('input', { bubbles: true }));
            });
        } else await click(method === 'token' ? container.querySelector('.au-token')! : button('Insert test snippet'));
        const expected = method === 'textarea' ? 'retyped' : method === 'token' ? '$0' : 'replacement snippet';
        expect(current.rule.graph.action!.message).toBe(expected);
        expect(box().value).toBe(expected);
        expect(box().textContent).toBe('');
        if (method !== 'token') expect(document.body.textContent).not.toContain(expected);
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

describe('canonicalJson (Test-report identity)', () => {
    it('ignores key insertion order at every depth but not values or array order', () => {
        const a = { graph: { cond: { value: 1, op: 'eq' }, action: { message: 'x', masked: true } }, ids: ['a', 'b'] };
        const b = { ids: ['a', 'b'], graph: { action: { masked: true, message: 'x' }, cond: { op: 'eq', value: 1 } } };
        expect(canonicalJson(a)).toBe(canonicalJson(b));
        expect(canonicalJson(a)).not.toBe(canonicalJson({ ...b, graph: { ...b.graph, action: { masked: false, message: 'x' } } }));
        expect(canonicalJson(a)).not.toBe(canonicalJson({ ...b, ids: ['b', 'a'] }));
    });
});
