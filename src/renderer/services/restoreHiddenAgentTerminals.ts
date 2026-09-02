/**
 * Bring hidden agent terminals back on screen (see `hiddenAgentTerminals.ts` for
 * what "hidden" means and how the set is computed).
 *
 * The whole operation is ATTACH, never spawn. Every terminal here is alive and
 * the pty-host already knows it by its `terminalId`, so the restored pane must
 * carry that id unchanged. This is the mirror image of `loadTabScopedLayout`'s
 * collision guard, and the distinction is worth stating because the two look
 * similar and want opposite things:
 *
 *   loadTabScopedLayout  a SAVED leaf whose id is already live in another tab
 *                        → re-mint, and drop `sessionKey`, because the id
 *                          belongs to someone else's running terminal.
 *   here                 a LIVE terminal that no pane is showing
 *                        → keep the id, because it IS that running terminal
 *                          and keeping the id is the entire point.
 *
 * Re-minting here would spawn a second PTY and leave the agent still stranded —
 * the exact failure the feature exists to prevent.
 */
import { Dispatch } from '@reduxjs/toolkit';
import { addTab, setActiveTab } from '../store/slices/tabsSlice';
import { addTabTree, setActiveTabId, focusPane } from '../store/slices/panesSlice';
import { generateId } from '../utils/id';
import { terminalService } from './TerminalService';
import { reattachPromptGate, markArmProbePending } from './reattachGate';
import { HiddenAgentTerminal, refreshHiddenAgentTerminals, visibleTerminalIds } from './hiddenAgentTerminals';

/** An emoji per known CLI so a restored tab is recognisable at a glance, with a
 *  neutral fallback — the detector labels ANY non-shell foreground program, so
 *  this list can never be exhaustive and must not pretend to be. */
const AGENT_ICONS: Record<string, string> = {
  claude: '✳',
  codex: '◆',
  gemini: '♦',
  copilot: '➤',
  aider: '⚑',
};

export interface RestoreResult {
  restored: HiddenAgentTerminal[];
  /** Asked for but skipped because a pane already showed them by the time the
   *  click was processed. `candidates` is captured when the caller renders, so
   *  anything that puts one of them back on screen between that render and the
   *  click lands here. (This comment used to give the reason as "the set is
   *  polled, so it can be up to 10s stale"; that stopped being the reason when
   *  the tracker began recomputing on every workspace change — the poll now
   *  only governs the BACKEND half, which is not what makes a candidate
   *  visible.) */
  skipped: HiddenAgentTerminal[];
}

/**
 * Give every terminal in `candidates` its own tab, bound to the terminal that is
 * already running.
 *
 * Re-checks visibility against the LIVE store rather than trusting the list it
 * was handed. `candidates` is a render-time snapshot, and a pane can appear
 * between that render and this call. Building a second pane for an
 * already-visible terminal is precisely the duplicate-leaf state the codebase
 * cannot represent — `findTabIdByTerminalId` returns the first match, so the
 * two panes would then fight over routing and muting.
 *
 * The re-check is cheap and unconditional on purpose: it does not depend on how
 * fresh the caller's list happens to be, so it keeps holding if the tracker's
 * update strategy changes again.
 */
export function restoreHiddenAgentTerminals(
  candidates: ReadonlyArray<HiddenAgentTerminal>,
  dispatch: Dispatch,
): RestoreResult {
  const store = (window as any).__REDUX_STORE__;
  const visible = visibleTerminalIds(store?.getState()?.panes?.treesByTabId ?? {});

  const restored: HiddenAgentTerminal[] = [];
  const skipped: HiddenAgentTerminal[] = [];
  let firstTabId: string | null = null;
  let firstPaneId: string | null = null;

  for (const candidate of candidates) {
    if (visible.has(candidate.terminalId)) {
      skipped.push(candidate);
      continue;
    }

    // Bind BEFORE the pane exists. `attachExistingTerminal` seeds the init
    // guards that `TerminalDisplay`'s mount effect reads to decide whether to
    // reuse a live PTY or create one; dispatching the tab first would let that
    // effect run against an unseeded id and spawn a duplicate — orphaning the
    // very terminal being recovered.
    terminalService.attachExistingTerminal(
      candidate.terminalId,
      candidate.processId,
      reattachPromptGate(candidate.promptHook, false),
    );
    if (candidate.promptHook === true) markArmProbePending(candidate.terminalId);
    // The PTY predates this pane, so Win32-Input-Mode has to be re-seeded — the
    // same reason `reconcileExistingTerminals` calls this on every reattach.
    terminalService.markReattachedSession(candidate.terminalId);

    const tabId = generateId('tb');
    const paneId = generateId('pn');

    // `addTab` and `addTabTree` in ONE synchronous block, never split across an
    // await: a tab that is renderable without its tree makes TerminalContainer's
    // seed effect manufacture a root with `terminalId: tab.id`, which spawns a
    // PTY under a bogus id (review 109 H2, and `populateWorkspace` carries the
    // same rule).
    dispatch(addTab({
      id: tabId,
      title: candidate.name,
      shellType: 'default',
      icon: AGENT_ICONS[candidate.agent.toLowerCase()] ?? '⟳',
      isActive: false,
    } as any));
    dispatch(addTabTree({
      tabId,
      tree: { id: paneId, type: 'terminal', terminalId: candidate.terminalId },
    }));

    visible.add(candidate.terminalId);
    if (!firstTabId) { firstTabId = tabId; firstPaneId = paneId; }
    restored.push(candidate);
  }

  // Activate the first restored tab — recovering a stranded agent and leaving it
  // off screen would only half-answer the request. Done once, after the loop, so
  // restoring five terminals does not walk the user through five activations.
  if (firstTabId) {
    dispatch(setActiveTab(firstTabId));
    dispatch(setActiveTabId(firstTabId));
    if (firstPaneId) dispatch(focusPane(firstPaneId));
  }

  // The set just changed by construction; re-poll so the badge does not keep
  // advertising terminals that are now on screen until the next interval.
  void refreshHiddenAgentTerminals();

  return { restored, skipped };
}
