/**
 * Where a terminal's rendered SURFACE currently belongs (design 012 §4.1).
 *
 * A subscribable `rendererTerminalId -> HTMLElement` map. `null` means "belongs in
 * the pane": the pane never registers, it is the implicit fallback in
 * `host ?? terminalRef.current` (see useSurfaceRelocation). Canvas Mode registers
 * a node's host div by callback ref and lets React 19's ref-cleanup closure
 * unregister it.
 *
 * KEY CONTRACT (design 012 §9 C3): the key is the renderer LEAF id — the same key
 * `terminalCache` and the ended-region tracker registry use. That leaf id has two
 * FORMS, naming who minted it and NOT the pane's shape: `tb-*` for a
 * renderer-created tab root, `tm-*` for split panes AND for every API-created
 * terminal, including a solo root. Root/solo/split comes only from the pane tree,
 * never from the prefix. The OWNING TAB id must never key a surface, or two split
 * panes alias and one terminal shows in two places.
 *
 * SINGLE OWNER PER KEY, and that is load-bearing. Spike 004 Q5 measured that with
 * two owners of one id-keyed slot, whichever unmounts FIRST clears the registry
 * while the other is still displaying that exact element — an identity-checked
 * pointer is insufficient for that shape and it would need a refcount. If Canvas
 * Mode ever adds a second registrant for the same terminalId (a minimap preview, a
 * detached inspector), this module must change first (design 012 §10.2 row 8).
 *
 * Both writers are NO-OPS when they would not change the map, and only a real
 * change notifies — otherwise every render of a canvas node schedules a
 * useSyncExternalStore re-render for nothing.
 */
import { useCallback, useSyncExternalStore } from 'react';

const hosts = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Register `el` as the surface host for `terminalId`.
 *
 * NOTE the signature takes a NON-NULLABLE HTMLElement. `| null` cannot clear here,
 * because `null` carries no identity to check against (review 094 B3) — use
 * `clearSurfaceHost` with the element you registered.
 */
export function setSurfaceHost(terminalId: string, el: HTMLElement): void {
  if (hosts.get(terminalId) === el) return;
  hosts.set(terminalId, el);
  emit();
}

/**
 * Unregister `expected` from `terminalId` — IDENTITY-CHECKED, so a stale cleanup
 * cannot wipe a slot something else has since overwritten with a different element
 * (spike 004 Q5 exercises 1-3).
 */
export function clearSurfaceHost(terminalId: string, expected: HTMLElement): void {
  if (hosts.get(terminalId) !== expected) return;
  hosts.delete(terminalId);
  emit();
}

/** Subscribe to any registry change. Returns the unsubscribe. */
export function subscribeSurfaceHosts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The host this terminal's surface belongs in, or `null` for "its own pane".
 *
 * `useSyncExternalStore` rather than a context or a Redux slice: the value is a
 * live DOM node, it changes outside React's data flow, and every consumer is
 * keyed independently.
 */
export function useSurfaceHost(terminalId: string): HTMLElement | null {
  const getSnapshot = useCallback(() => hosts.get(terminalId) ?? null, [terminalId]);
  return useSyncExternalStore(subscribeSurfaceHosts, getSnapshot, getSnapshot);
}

/** Test-only: read a registration without a React render. Added for Canvas Mode's
 *  `NodeTerminal` tests (`plan/013` Task 9), which need to assert WHICH element is
 *  registered — the alternative was reaching into this module's private Map from
 *  another file's test. */
export function __getSurfaceHostForTest(terminalId: string): HTMLElement | null {
  return hosts.get(terminalId) ?? null;
}

/** Test-only: drop all registrations and subscribers between cases. */
export function __resetSurfaceHostsForTest(): void {
  hosts.clear();
  listeners.clear();
}
