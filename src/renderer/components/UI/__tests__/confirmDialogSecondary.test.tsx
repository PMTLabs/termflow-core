/**
 * @jest-environment jsdom
 *
 * §10.29 — `ConfirmDialog`'s optional third action.
 *
 * The dialog gained a middle button so a destructive confirm can offer the reversible option first
 * ("Switch off instead" beside "Delete"). The requirement that makes that safe is the negative one:
 * **with no secondary props the footer still renders exactly two buttons**, so not one of the
 * dozens of existing callers changes shape. Both props are required together, and passing only one
 * renders neither — a half-configured third action would be a button that does nothing.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ConfirmDialog } from '../ConfirmDialog';

describe('ConfirmDialog — the optional third action', () => {
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
    });

    const footerButtons = () =>
        [...document.querySelectorAll('.confirm-dialog-footer button')].map((b) => b.textContent);

    async function render(extra: Record<string, unknown>) {
        await act(async () => {
            root.render(
                <ConfirmDialog
                    isOpen
                    title="Delete it?"
                    message="This cannot be undone."
                    onConfirm={() => {}}
                    onCancel={() => {}}
                    confirmText="Delete"
                    cancelText="Cancel"
                    {...extra}
                />,
            );
        });
    }

    it('renders exactly two buttons when no secondary action is given', async () => {
        await render({});
        expect(footerButtons()).toEqual(['Cancel', 'Delete']);
    });

    it('renders the third button between Cancel and the primary', async () => {
        await render({ secondaryText: 'Switch off instead', onSecondary: () => {} });
        expect(footerButtons()).toEqual(['Cancel', 'Switch off instead', 'Delete']);
    });

    it('renders nothing extra when only one half of the pair is passed', async () => {
        // A label with no handler is a button that silently does nothing; a handler with no label
        // is unreachable. Neither is a state worth rendering.
        await render({ secondaryText: 'Switch off instead' });
        expect(footerButtons()).toEqual(['Cancel', 'Delete']);
        await render({ onSecondary: () => {} });
        expect(footerButtons()).toEqual(['Cancel', 'Delete']);
    });

    it('calls only the secondary handler when the third button is pressed', async () => {
        const onSecondary = jest.fn();
        const onConfirm = jest.fn();
        const onCancel = jest.fn();
        await act(async () => {
            root.render(
                <ConfirmDialog
                    isOpen
                    title="Delete it?"
                    message="This cannot be undone."
                    onConfirm={onConfirm}
                    onCancel={onCancel}
                    confirmText="Delete"
                    secondaryText="Switch off instead"
                    onSecondary={onSecondary}
                />,
            );
        });
        await act(async () => {
            [...document.querySelectorAll('.confirm-dialog-footer button')]
                .find((b) => b.textContent === 'Switch off instead')!
                .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(onSecondary).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();
    });
});
