/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AddShellProfileForm } from '../AddShellProfileForm';
import { parseArgs } from '../../../services/argParse';

describe('parseArgs', () => {
    it('splits on whitespace and keeps quoted text together', () => {
        expect(parseArgs('')).toEqual([]);
        expect(parseArgs('  --login   -i ')).toEqual(['--login', '-i']);
        expect(parseArgs('-NoLogo -Command "Get-Date -Format o"')).toEqual(['-NoLogo', '-Command', 'Get-Date -Format o']);
        expect(parseArgs('-d "" x')).toEqual(['-d', '', 'x']);
    });

    it('treats \\" as a literal quote and rejects an unclosed quote', () => {
        expect(parseArgs('-Command "Write-Host \\"hello world\\""')).toEqual(['-Command', 'Write-Host "hello world"']);
        expect(parseArgs('a\\b')).toEqual(['a\\b']);
        expect(() => parseArgs('-Command "oops')).toThrow(/unclosed/);
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
    const value = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!.value;

    it('submits the trimmed fields with parsed arguments and start directory', async () => {
        const onSubmit = jest.fn(async () => {});
        act(() => root.render(<AddShellProfileForm onSubmit={onSubmit} onCancel={() => {}} />));

        setInput('new-profile-name', '  Nushell ');
        setInput('new-profile-path', ' C:\\tools\\nu.exe ');
        setInput('new-profile-args', '--login -c "echo hi"');
        setInput('new-profile-cwd', '  C:\\work  ');
        await submit();

        expect(onSubmit).toHaveBeenCalledWith({
            name: 'Nushell',
            path: 'C:\\tools\\nu.exe',
            args: ['--login', '-c', 'echo hi'],
            cwd: 'C:\\work',
        });
    });

    it('sends no cwd when Start In Directory is blank', async () => {
        const onSubmit = jest.fn(async () => {});
        act(() => root.render(<AddShellProfileForm onSubmit={onSubmit} onCancel={() => {}} />));

        setInput('new-profile-name', 'Nu');
        setInput('new-profile-path', 'nu.exe');
        setInput('new-profile-cwd', '   ');
        await submit();

        expect(onSubmit).toHaveBeenCalledWith({ name: 'Nu', path: 'nu.exe', args: [], cwd: undefined });
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

    it('shows an unclosed-quote error instead of submitting', async () => {
        const onSubmit = jest.fn(async () => {});
        act(() => root.render(<AddShellProfileForm onSubmit={onSubmit} onCancel={() => {}} />));

        setInput('new-profile-name', 'Nu');
        setInput('new-profile-path', 'nu.exe');
        setInput('new-profile-args', '-c "oops');
        await submit();

        expect(onSubmit).not.toHaveBeenCalled();
        expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/unclosed/);
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

        expect(value('new-profile-path')).toBe('C:\\Program Files\\nu\\bin\\nu.exe');
        expect(value('new-profile-name')).toBe('nu');
    });

    it('Browse keeps a name the user already typed', async () => {
        const onBrowse = jest.fn(async () => 'C:\\Program Files\\nu\\bin\\nu.exe');
        act(() => root.render(<AddShellProfileForm onSubmit={jest.fn()} onCancel={() => {}} onBrowse={onBrowse} />));

        setInput('new-profile-name', 'My Nushell');
        await act(async () => {
            container.querySelector<HTMLButtonElement>('.browse-btn')!.click();
        });

        expect(value('new-profile-name')).toBe('My Nushell');
        expect(value('new-profile-path')).toBe('C:\\Program Files\\nu\\bin\\nu.exe');
    });
});
