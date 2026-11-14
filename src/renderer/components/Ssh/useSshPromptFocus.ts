import { useEffect, type RefObject } from 'react';

/** Inline prompts never trap focus or interrupt a sibling pane. */
export function useSshPromptFocus(root: RefObject<HTMLDivElement | null>, cancel: () => void, selector: string, active = true) {
  useEffect(() => {
    const node = root.current;
    if (!node || !active) return;
    const scope = node.closest('.ssh-pane-shell, .ssh-test-dialog') ?? node.parentElement;
    const trigger = document.activeElement as HTMLElement | null;
    if (trigger && scope?.contains(trigger)) node.querySelector<HTMLElement>(selector)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    node.addEventListener('keydown', keydown);
    return () => {
      node.removeEventListener('keydown', keydown);
      if (node.contains(document.activeElement) && trigger?.isConnected) trigger.focus();
    };
    // Prompt identity is the component key; callbacks need not reopen focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, active, selector]);
}
