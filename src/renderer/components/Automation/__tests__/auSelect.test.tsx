/**
 * @jest-environment jsdom
 *
 * `AuSelect` exists for one reason: a native `<select>` near the bottom of the window opened
 * downward and WebView2 clipped the list at the window edge, with no scrollbar and no way to reach
 * the hidden rows. So the behaviour worth pinning is the placement, and jsdom has no layout engine
 * — the trigger's rect is stubbed, which is the only way to ask the question at all.
 *
 * The two placement cases are asserted as a PAIR. "It sets `bottom` when it flips" is satisfied by a
 * component that always flips, which would move the same bug to the top of the window.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AuSelect } from '../AuSelect';

const OPTIONS = [
    { value: 'a', label: 'Every 10 seconds' },
    { value: 'b', label: 'Every 30 seconds' },
    { value: 'c', label: 'Every minute' },
];

describe('AuSelect', () => {
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
        jest.restoreAllMocks();
    });

    /** Put the trigger at `top`, with the window 768 tall (jsdom's default). */
    async function renderAt(top: number, onChange = jest.fn()) {
        await act(async () => {
            root.render(
                <AuSelect value="a" options={OPTIONS} ariaLabel="How often to check" onChange={onChange} />,
            );
        });
        const trigger = container.querySelector<HTMLButtonElement>('[aria-label="How often to check"]')!;
        jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
            top, bottom: top + 30, left: 40, right: 240, width: 200, height: 30, x: 40, y: top,
            toJSON: () => ({}),
        } as DOMRect);
        await act(async () => { trigger.click(); });
        return { trigger, onChange };
    }

    const menu = () => document.body.querySelector<HTMLElement>('.au-selmenu')!;

    it('opens downward when there is room below', async () => {
        await renderAt(100);
        expect(menu().style.top).toBe('134px');
        expect(menu().style.bottom).toBe('');
    });

    it('flips up when the trigger is against the bottom of the window', async () => {
        // 740 of 768: 28px below the trigger's bottom, far less than a usable list.
        await renderAt(710);
        expect(menu().style.bottom).toBe('62px');
        expect(menu().style.top).toBe('');
    });

    /**
     * Reported: `does not equal` opened as `does not e…`. The list carried `width: trigger.width`,
     * which is the one width guaranteed to be too small — an option longer than the closed control
     * is exactly why the list is being opened.
     *
     * The assertion is on the BOUNDS rather than on a measured pixel, because jsdom lays nothing
     * out and a rendered width would be 0 either way. A `width` is what makes text clip, so its
     * absence is the property: `minWidth` keeps the list from being narrower than its trigger and
     * `maxWidth` keeps it inside the window, and between them the box shrink-wraps its content.
     */
    it('is never narrower than its trigger and never fixed to it', async () => {
        await renderAt(100);
        expect(menu().style.minWidth).toBe('200px');
        expect(menu().style.width).toBe('');
        // 1024 (jsdom) - 40 left - 8 edge. Room the portalled list may grow into, which for these
        // selects is the whole of the inspector column they sit at the right of.
        expect(menu().style.maxWidth).toBe('976px');
    });

    /** A trigger wider than the room beside it still gets its own width, never a negative bound. */
    it('never bounds the list below the width of its own trigger', async () => {
        await act(async () => {
            root.render(
                <AuSelect value="a" options={OPTIONS} ariaLabel="How often to check" onChange={jest.fn()} />,
            );
        });
        const trigger = container.querySelector<HTMLButtonElement>('[aria-label="How often to check"]')!;
        jest.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
            top: 100, bottom: 130, left: 1000, right: 1200, width: 200, height: 30, x: 1000, y: 100,
            toJSON: () => ({}),
        } as DOMRect);
        await act(async () => { trigger.click(); });
        expect(menu().style.maxWidth).toBe('200px');
        expect(menu().style.minWidth).toBe('200px');
    });

    it('escapes the clipping ancestors by portalling out of its own tree', async () => {
        await renderAt(100);
        expect(container.querySelector('.au-selmenu')).toBeNull();
        expect(document.body.querySelector('.au-selmenu')).not.toBeNull();
    });

    it('commits the row that was pressed', async () => {
        const { onChange } = await renderAt(100);
        const row = menu().querySelector<HTMLElement>('[data-value="c"]')!;
        await act(async () => {
            row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(onChange).toHaveBeenCalledWith('c');
    });

    it('refuses a disabled row, by pointer and by keyboard alike', async () => {
        const onChange = jest.fn();
        await act(async () => {
            root.render(
                <AuSelect
                    value=""
                    options={[
                        { value: '', label: 'choose a terminal…' },
                        { value: 'gone', label: 'tm-1 (not open)', disabled: true },
                    ]}
                    ariaLabel="Terminal to test against"
                    onChange={onChange}
                />,
            );
        });
        const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Terminal to test against"]')!;
        await act(async () => { trigger.click(); });

        const dead = document.body.querySelector<HTMLElement>('[data-value="gone"]')!;
        await act(async () => {
            dead.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(onChange).not.toHaveBeenCalled();

        // ArrowDown must not land on it either, or Enter would choose what the pointer cannot.
        await act(async () => {
            trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(onChange).not.toHaveBeenCalledWith('gone');
    });
});
