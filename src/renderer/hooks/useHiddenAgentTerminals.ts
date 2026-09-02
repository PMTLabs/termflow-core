/**
 * Subscribe to the set of agent terminals this workspace is not showing.
 *
 * One hook rather than a `useState`/`useEffect` pair in each consumer, because
 * there are two consumers in different parts of the tree (the title-bar
 * indicator and the Layout Manager's restore button) and they must never
 * disagree about the count. Duplicating a selector pair across two components is
 * the shape that has already cost this codebase a review round twice — the mute
 * flag and the clean-reference lifecycle.
 *
 * The tracker polls only while at least one subscriber is mounted, so mounting
 * this hook is what turns the poll on and unmounting the last one turns it off.
 */
import { useEffect, useState } from 'react';
import {
  hiddenAgentTerminals,
  HiddenAgentTerminal,
} from '../services/hiddenAgentTerminals';

export function useHiddenAgentTerminals(): HiddenAgentTerminal[] {
  // Seeded from the tracker's current value rather than `[]`: a second consumer
  // mounting after the first has already polled would otherwise flash an empty
  // badge for up to a full interval.
  const [hidden, setHidden] = useState<HiddenAgentTerminal[]>(() => hiddenAgentTerminals.current);

  useEffect(() => {
    // Re-sync on mount as well as subscribing — between the `useState`
    // initialiser and this effect the tracker may have published.
    setHidden(hiddenAgentTerminals.current);
    return hiddenAgentTerminals.subscribe(setHidden);
  }, []);

  return hidden;
}
