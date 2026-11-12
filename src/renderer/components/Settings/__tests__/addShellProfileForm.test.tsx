/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AddShellProfileForm, parseArgs } from '../AddShellProfileForm';

describe('parseArgs', () => {
    it('splits on whitespace and keeps quoted text together', () => {
        expect(parseArgs('')).toEqual([]);
        expect(parseArgs('  --login   -i ')).toEqual(['--login', '-i']);
        expect(parseArgs('-NoLogo -Command "Get-Date -Format o"')).toEqual(['-NoLogo', '-Command', 'Get-Date -Format o']);
        expect(parseArgs('-d "" x')).toEqual(['-d', '', 'x']);
    });
});

describe('AddShellProfileForm', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const setInput = (id: string, value: string) => {
        const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const submit = async () => {
        await act(async () => {
            container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
    };

    it('submits the trimmed fields with parsed arguments', async () => {
        const onSubmit = jest.fn(async () => {});
        act(() => root.render(<AddShellProfileForm onSubmit={onSubmit} onCancel={() => {}} />));

        setInput('new-profile-name', '  Nushell ');
        setInput('new-profile-path', ' C:\\tools\\nu.exe ');
        setInput('new-profile-args', '--login -c "echo hi"');
        await submit();

        expect(onSubmit).toHaveBeenCalledWith({
            name: 'Nushell',
            path: 'C:\\tools\\nu.exe',
            args: ['--login', '-c', 'echo hi'],
            cwd: undefined,
        });
    });

    it('refuses to submit without a name or path and shows why', async () => {
        const onSubmit = jest.fn(async () => {});
        act(() => root.render(<AddShellProfileForm onSubmit={onSubmit} onCancel={() => {}} />));

        await submit();
        expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/name/i);

        setInput('new-profile-name', 'Nu');
        await submit();
        expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/executable/i);
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('shows the backend error when saving fails', async () => {
        const onSubmit = jest.fn(async () => { throw new Error('disk full'); });
        act(() => root.render(<AddShellProfileForm onSubmit={onSubmit} onCancel={() => {}} />));

        setInput('new-profile-name', 'Nu');
        setInput('new-profile-path', 'nu.exe');
        await submit();

        expect(container.querySelector('[role="alert"]')!.textContent).toBe('disk full');
    });

    it('Browse fills the path and derives a name when none was typed', async () => {
        const onBrowse = jest.fn(async () => 'C:\\Program Files\\nu\\bin\\nu.exe');
        act(() => root.render(<AddShellProfileForm onSubmit={jest.fn()} onCancel={() => {}} onBrowse={onBrowse} />));

        await act(async () => {
            container.querySelector<HTMLButtonElement>('.browse-btn')!.click();
        });

        expect(container.querySelector<HTMLInputElement>('#new-profile-path')!.value).toBe('C:\\Program Files\\nu\\bin\\nu.exe');
        expect(container.querySelector<HTMLInputElement>('#new-profile-name')!.value).toBe('nu');
    });
});
