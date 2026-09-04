/**
 * The shared differ behind every "renderer-only knowledge the backend needs, keyed by the
 * `tm-` leaf" sync.
 *
 * Two of these exist: `paneOwnership` pushes which tab owns a leaf, and `terminalLabelSync`
 * pushes the leaf's tab/pane title. They are the same problem — derive a leaf -> value map
 * from the store, compare it against what was last pushed, and invoke only for what actually
 * changed — and the reasoning for deriving from state rather than from a lifecycle hook is
 * stated once, in `paneOwnership.ts`'s header: a moved pane already has a mapping and takes
 * `TerminalPane`'s reuse path, so it never re-binds and a hook never fires for it.
 *
 * WHY THE FIRST SIGHT OF A LEAF IS A PARAMETER, NOT A RULE
 * It is the one thing the two callers genuinely disagree about, and getting it wrong is a
 * silent, permanent data loss rather than a visible error:
 *
 *   - `paneOwnership` SUPPRESSES the first push for a leaf with no live process, because a
 *     freshly split pane enters the tree before `TerminalPane` spawns its PTY and the spawn
 *     itself carries the right owner as an explicit `create_terminal` parameter. Pushing
 *     anyway would be a harmless backend no-op, but it would also fire one invoke per pane at
 *     every startup for nothing.
 *   - `terminalLabelSync` ALWAYS pushes it, because labels are NOT a spawn parameter. A user
 *     who opens a brand-new solo terminal and never splits or renames anything would otherwise
 *     get `before === undefined`, no live process yet, the push suppressed — and that
 *     terminal's label would never be pushed at all, leaving every log line and every picker
 *     row for it blank forever. That is most first terminals.
 */

/** renderer leaf id -> the value this window believes the backend should hold. */
export type LeafValues<V> = Map<string, V>;

export interface LeafChange<V> {
  rendererTerminalId: string;
  value: V;
}

/**
 * The pushes this window owes the backend: every leaf whose value changed, plus every leaf
 * seen for the first time that `firstSightNeedsPush` accepts.
 *
 * A leaf that disappeared from `next` produces nothing — the backend forgets it when the
 * terminal is torn down, and a push for a leaf that no longer exists would be a no-op that
 * costs an invoke.
 *
 * **So a caller must never spell "this value was cleared" as absence.** Absence here means "not
 * mine any more", the two are indistinguishable from inside this function, and the clear is the
 * one of the pair that must reach the backend. Map the cleared state to a VALUE and let
 * `firstSightNeedsPush` decide whether a leaf that arrives already cleared is worth an invoke.
 */
export function diffLeafValues<V>(
  previous: LeafValues<V> | null,
  next: LeafValues<V>,
  firstSightNeedsPush: (rendererTerminalId: string) => boolean,
): Array<LeafChange<V>> {
  const changes: Array<LeafChange<V>> = [];
  for (const [rendererTerminalId, value] of next) {
    const before = previous?.get(rendererTerminalId);
    const seenBefore = previous?.has(rendererTerminalId) ?? false;
    if (seenBefore && before === value) continue;
    if (seenBefore || firstSightNeedsPush(rendererTerminalId)) {
      changes.push({ rendererTerminalId, value });
    }
  }
  return changes;
}
