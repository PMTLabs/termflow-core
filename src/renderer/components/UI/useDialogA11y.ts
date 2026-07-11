import React, { useEffect, useRef } from 'react';

/**
 * Shared keyboard-accessibility primitive for modal dialogs.
 *
 * Responsibilities (single purpose: "make a dialog keyboard-operable"):
 *  - record the trigger element on open and restore focus to it on close;
 *  - set initial focus (cancel / confirm / first focusable / explicit ref);
 *  - trap Tab / Shift+Tab focus within the dialog, wrapping at the ends;
 *  - Esc → onCancel;
 *  - Enter → onEnter, but only when focus is NOT on a button/link/typing field
 *    (native activation handles those, so we never double-fire);
 *  - bare-letter mnemonics (e.g. `C`, `A`), auto-suppressed while a text field
 *    is focused and ignored when a modifier key is held.
 *
 * The real logic lives in the exported pure helpers below so it can be
 * unit-tested without a DOM testing library.
 */

export interface Mnemonic {
  /** Single character that activates `handler` (case-insensitive). */
  key: string;
  handler: () => void;
}

export type InitialFocus =
  | 'cancel'
  | 'confirm'
  | 'first'
  | React.RefObject<HTMLElement>;

export interface DialogA11yOptions {
  isOpen: boolean;
  /** Esc, and the default focus target on destructive confirms. */
  onCancel?: () => void;
  /** Enter when focus is not already on an actionable control. */
  onEnter?: () => void;
  /** Bare-letter shortcuts, auto-suppressed while typing. */
  mnemonics?: Mnemonic[];
  /** Where focus lands when the dialog opens. Defaults to 'first'. */
  initialFocus?: InitialFocus;
}

/** Input types that accept free text (so bare-letter mnemonics must suppress). */
const TEXT_INPUT_TYPES = new Set<string>([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/**
 * True if the element accepts typed text (text input / textarea / select /
 * contentEditable). Radio, checkbox, button, etc. are NOT typing targets, so a
 * focused shell radio in ShellSelector does not suppress its mnemonics.
 */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const node = el as HTMLElement;
  if (node.isContentEditable) return true;
  // Fallback for environments (e.g. jsdom) that don't compute isContentEditable.
  const ce = node.getAttribute?.('contenteditable');
  if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
  const tag = node.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    // .type normalizes to 'text' when the attribute is absent/invalid.
    const type = (node as HTMLInputElement).type.toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Ordered list of keyboard-focusable elements inside `container`. */
export function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Return the handler for a single-character key matching a mnemonic, else null. */
export function matchMnemonic(
  key: string,
  mnemonics: Mnemonic[],
): (() => void) | null {
  if (!key || key.length !== 1) return null;
  const lower = key.toLowerCase();
  for (const m of mnemonics) {
    if (m.key && m.key.toLowerCase() === lower) return m.handler;
  }
  return null;
}

function resolveInitialFocus(
  container: HTMLElement,
  initialFocus: InitialFocus,
): HTMLElement | null {
  const focusables = getFocusable(container);
  if (initialFocus && typeof initialFocus === 'object' && 'current' in initialFocus) {
    return initialFocus.current ?? focusables[0] ?? null;
  }
  if (initialFocus === 'cancel') {
    return (
      container.querySelector<HTMLElement>('[data-dialog-cancel]') ??
      focusables[0] ??
      null
    );
  }
  if (initialFocus === 'confirm') {
    return (
      container.querySelector<HTMLElement>('[data-dialog-confirm]') ??
      focusables[focusables.length - 1] ??
      null
    );
  }
  return focusables[0] ?? null;
}

export function useDialogA11y(
  containerRef: React.RefObject<HTMLElement | null>,
  options: DialogA11yOptions,
): void {
  const { isOpen } = options;
  const triggerRef = useRef<HTMLElement | null>(null);
  // Keep the latest options visible to the once-per-open keydown listener
  // without re-registering it on every render (avoids listener churn).
  const optsRef = useRef(options);
  optsRef.current = options;

  // Record trigger + set initial focus on open; restore focus on close.
  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    triggerRef.current = (document.activeElement as HTMLElement) ?? null;

    if (container) {
      const target = resolveInitialFocus(container, optsRef.current.initialFocus ?? 'first');
      (target ?? container).focus?.();
    }

    return () => {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      // Guard against the trigger having been removed (e.g. its tab was closed):
      // restore focus to it if it's still in the DOM, else fall back to the body.
      if (trigger && trigger.isConnected && typeof trigger.focus === 'function') {
        trigger.focus();
      } else {
        document.body?.focus();
      }
    };
  }, [isOpen, containerRef]);

  // Focus trap + Esc + Enter + mnemonics, scoped to the dialog container.
  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const o = optsRef.current;

      if (e.key === 'Escape') {
        if (o.onCancel) {
          e.preventDefault();
          e.stopPropagation();
          o.onCancel();
        }
        return;
      }

      if (e.key === 'Tab') {
        const focusables = getFocusable(container);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        // `active === container` covers the fallback case where focus landed on the
        // container itself (tabIndex=-1) — without it, Shift+Tab would escape the trap.
        if (e.shiftKey) {
          if (active === first || active === container || !container.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || active === container || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }

      if (e.key === 'Enter') {
        const active = document.activeElement as HTMLElement | null;
        const actionable =
          !!active &&
          (active.tagName === 'BUTTON' ||
            active.tagName === 'A' ||
            active.getAttribute('role') === 'button');
        if (!actionable && !isTypingTarget(active) && o.onEnter) {
          e.preventDefault();
          o.onEnter();
        }
        return;
      }

      // Bare-letter mnemonics: ignore with modifiers or while typing.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(document.activeElement)) return;
      const handler = matchMnemonic(e.key, o.mnemonics ?? []);
      if (handler) {
        e.preventDefault();
        e.stopPropagation();
        handler();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [isOpen, containerRef]);
}
