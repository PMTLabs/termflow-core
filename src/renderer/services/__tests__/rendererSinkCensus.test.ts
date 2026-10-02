import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const renderer = path.join(__dirname, '..', '..');
const lifecycleFiles = new Set([
  'App.tsx', 'components/Panes/TerminalPane.tsx', 'components/Tabs/TabManager.tsx',
  'components/Panes/dnd/detach.ts', 'components/Panes/dnd/PaneDragController.tsx',
  'services/TerminalService.ts', 'services/StateManager.ts', 'services/paneIncarnations.ts',
  'services/restoreHiddenAgentTerminals.ts', 'services/apiCreatedTab.ts', 'services/paneClose.ts',
]);
const lifetimeSinks = new Set([
  'addTabTree', 'removeTabTree', 'removeTab', 'removePaneFromTab', 'clearAllTabs', 'resetPanes',
  'attachExistingTerminal', 'detachTerminal', 'registerExistingTerminal', 'closeTerminal',
  'removeSourceTab', 'removeSourcePane', 'removeQualifiedSource', 'populateWorkspace',
  'restoreTabPanesInPlace', 'installTransfer', 'createTerminal', 'admit', 'bind', 'depart', 'close',
  'stash', 'cancel', 'send', 'prepare', 'reap', 'setHostWaitState', 'bindCreated',
  'setProcessId', 'setStartupFailed', 'setWaitingForHost', 'stashPromptGate', 'markReattachedSession', 'stashKeyboardProtocol',
]);
const maps = /(?:terminalInit|processes|inFlightCreates|placements|hostWaitStates|Handoff|slots|staged|rollbacks|queue|observed)/;

/** Lexical inventory, not temporal proof: counts force classification of new sinks, including
 * callbacks and synchronous helpers called from continuations. Gated tests prove qualification. */
function sinks(source: string, filename: string): Record<string, Record<string, number>> {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Record<string, Record<string, number>> = {};
  const functionName = (node: ts.Node): string => {
    const names: string[] = [];
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
      if (ts.isFunctionLike(at)) {
        if ('name' in at && at.name) names.unshift(at.name.getText(ast));
        else if (ts.isVariableDeclaration(at.parent)) names.unshift(at.parent.name.getText(ast));
        else if (ts.isPropertyAssignment(at.parent)) names.unshift(at.parent.name.getText(ast));
        else if (ts.isCallExpression(at.parent)) {
          const call = at.parent.expression;
          names.unshift(`${ts.isPropertyAccessExpression(call) ? call.name.text : call.getText(ast)} callback`);
        }
      }
    }
    return names.join(':') || '(module)';
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = ts.isNonNullExpression(node.expression) ? node.expression.expression : node.expression;
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : expression.getText(ast);
      const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression.getText(ast) : '';
      const knownFile = lifecycleFiles.has(filename);
      const backendSend = !['then', 'catch', 'capture', 'captureClose', 'isCurrent', 'isSuppressed', 'capturesForLeaf', 'includes', 'filter', 'getWindowLabel', 'stop'].includes(name)
        && /electronAPI|this\.api\(\)|this\.bridge|paneIncarnations|protocol|^api$/.test(receiver);
      const relevant = (knownFile && (name === 'dispatch' || lifetimeSinks.has(name)
        || backendSend || name === 'bridge'
        || (['set', 'delete', 'clear', 'splice', 'shift', 'push'].includes(name) && maps.test(receiver))))
        || (!knownFile && ['addTabTree', 'removeTabTree', 'removeTab', 'removePaneFromTab', 'clearAllTabs', 'resetPanes', 'attachExistingTerminal', 'detachTerminal', 'registerExistingTerminal', 'installTransfer'].includes(name));
      if (relevant) {
        const label = `${filename}:${functionName(node)}`;
        const effects = found[label] ??= {};
        effects[name] = (effects[name] ?? 0) + 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}
function sources(directory = renderer): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !['__tests__', '__testFixtures__'].includes(entry.name)) Object.assign(result, sources(filename));
    else if (entry.isFile() && /\.tsx?$/.test(filename)) result[path.relative(renderer, filename).replace(/\\/g, '/')] = fs.readFileSync(filename, 'utf8');
  }
  return result;
}
const inventory = (files: Record<string, string>) => Object.assign({}, ...Object.entries(files).map(([filename, source]) => sinks(source, filename)));

// Each inventory row has a sink mechanism in the companion classification below.
const classified: Record<string, { effects: Record<string, number>; mechanism: string }> = {};
function classify(mechanism: string, rows: Record<string, Record<string, number>>): void {
  for (const [name, effects] of Object.entries(rows)) classified[name] = { effects, mechanism };
}
classify('Global settings/current UI intent or read-only boot input; Settle uses the registered FIFO page, not a pane id.', {
  'App.tsx:App:useEffect callback:listen callback': { dispatch: 3, flushSessionAck: 1 },
  'App.tsx:App:useEffect callback': { setWindowTitle: 1 },
  'App.tsx:App:initializeApp': { getConfig: 1, takePendingOpenPath: 1, send: 1 },
  'App.tsx:App:applyConfigSettings': { dispatch: 30 },
  'App.tsx:App:loadConfigSettings': { dispatch: 1 },
  'App.tsx:App:initializeShellProfiles': { getShellProfiles: 1, dispatch: 3, getDefaultProfile: 1 },
  'App.tsx:App:createDefaultTabIfNeeded': { dispatch: 1 },
  'App.tsx:App:openFolderTab': { dispatch: 1 },
  'App.tsx:App:handleExternalActivity': { dispatch: 1 },
  'App.tsx:App:handleNewTab': { dispatch: 1 },
  'App.tsx:App:handleTerminalProcessExit': { dispatch: 1 },
  'App.tsx:App:handleSplitHorizontal': { dispatch: 1 },
  'App.tsx:App:handleSplitVertical': { dispatch: 1 },
  'App.tsx:App:handleRequestTabsData': { sendToMain: 2 },
  'App.tsx:App': { confirmCloseApp: 1 },
});
classify('Captured workspace/source tree before imports; installed pi and current workspace before delayed response/mirror; exact pc metadata.', {
  'App.tsx:App:handleAPICreateTerminalTab': { dispatch: 8, registerExistingTerminal: 2, sendToMain: 5, addTabTree: 1 },
  'App.tsx:App:handleAPICreateTerminalTab:then callback': { dispatch: 1 },
  'App.tsx:App:handleAPICreateTerminalTab:registerExistingTerminal': { registerExistingTerminal: 1 },
  'App.tsx:App:handleAPICreateTerminalTab:notifyTabCreated': { sendToMain: 1 },
});
classify('Fresh synchronous install, or current committed tree read at the synchronous reducer sink; no bridge wait.', {
  'components/Canvas/CanvasMode.tsx:CanvasMode:useCallback callback': { addTabTree: 1 },
  'components/Panes/PaneManager.tsx:PaneManager:useCallback callback:removeFromUi': { removePaneFromTab: 1 },
  'components/TabBar.tsx:TabBar:handleTabClose': { removeTab: 1 },
  'components/TerminalContainer.tsx:TerminalContainer:useEffect callback': { addTabTree: 1 },
  'components/TerminalContainer.tsx:TerminalContainer:useEffect callback:forEach callback': { removeTabTree: 1, addTabTree: 1 },
  'services/apiCreatedTab.ts:runApiCreateMode0': { registerExistingTerminal: 1, prepare: 1, dispatch: 4, addTabTree: 1 },
  'services/paneClose.ts:closePaneNonBlocking': { closeTerminal: 2 },
});
classify('Gesture captures workspace and source pi; pointer-up compares capturePaneEffect before current-tree planRegroup/removal.', {
  'components/Canvas/useCanvasDrag.ts:useCanvasDrag:useEffect callback:applyRegroup': { removePaneFromTab: 1 },
  'components/Canvas/useSidebarDrag.ts:useSidebarDrag:useEffect callback:applyRegroup': { removePaneFromTab: 1 },
});
classify('Original source member/pi/pc set plus workspace; removeQualifiedSource retains later copies/maps, and closes only a qualified emptied tab. Browser fallback is synchronous.', {
  'components/Panes/dnd/detach.ts:removeQualifiedSource': { dispatch: 4, removePaneFromTab: 1, removeTabTree: 1, removeTab: 1, detachTerminal: 1 },
  'components/Panes/dnd/detach.ts:removeSourcePane': { removeQualifiedSource: 1, delete: 5, dispatch: 2, removePaneFromTab: 1, removeTab: 1 },
  'components/Panes/dnd/detach.ts:removeSourcePane:forEach callback': { dispatch: 1, detachTerminal: 1 },
  'components/Panes/dnd/detach.ts:detachPaneToNewWindow': { removeSourcePane: 1 },
  'components/Panes/dnd/detach.ts:removeSourceTab': { removeQualifiedSource: 1, delete: 5, dispatch: 2, removeTabTree: 1, removeTab: 1 },
  'components/Panes/dnd/detach.ts:removeSourceTab:forEach callback': { dispatch: 1, detachTerminal: 1 },
  'components/Panes/dnd/detach.ts:detachTabToNewWindow': { removeSourceTab: 1 },
  'components/Panes/dnd/detach.ts:dropTabAcrossWindows': { resolveTabDrop: 1, createDetachedWindow: 1, delete: 2, removeSourceTab: 1 },
});
classify('Immutable tx; page-ended check after stash; original captures at rollback; exact rollback promise comparison. Backend tx authority remains separate from UI removal.', {
  'components/Panes/dnd/detach.ts:stageDetachPayload': { stash: 1, set: 3, waitTransfer: 1 },
  'components/Panes/dnd/detach.ts:cancelDetachTransfer': { delete: 4, cancel: 1, set: 1 },
  'components/Panes/dnd/detach.ts:openWindowWithPayload': { createDetachedWindow: 1, delete: 2 },
  'components/Panes/dnd/detach.ts:closeWindowIfEmpty': { closeCurrentWindow: 1 },
});
classify('Adopt acknowledgement then workspace check before install; each post-install bind compares the captured destination pi, never reacquires it after a prior bind wait.', {
  'components/Panes/dnd/detach.ts:installTransferredPayload': { installTransfer: 1 },
  'components/Panes/dnd/detach.ts:installTransferredPayload:installTransfer callback': { bind: 1 },
  'components/Panes/dnd/detach.ts:applyDetachPayload:forEach callback': { attachExistingTerminal: 1, dispatch: 1 },
  'components/Panes/dnd/detach.ts:applyDetachPayload': { dispatch: 4, addTabTree: 1 },
  'components/Panes/dnd/detach.ts:applyCrossWindowPayload:forEach callback': { attachExistingTerminal: 1, dispatch: 1 },
  'components/Panes/dnd/detach.ts:applyCrossWindowPayload': { dispatch: 3 },
  'components/Panes/dnd/detach.ts:seedKeyboardProtocol': { markReattachedSession: 1, stashKeyboardProtocol: 1 },
});
classify('Captured source object/tx and workspace; page receipt and take before qualified member removal; local rollback-drop reads matching source/target at sink.', {
  'components/Panes/dnd/PaneDragController.tsx:cancelSourceDrag': { cancelGlobalPaneDrag: 1 },
  'components/Panes/dnd/PaneDragController.tsx:PaneDragProvider:useEffect callback:setup:listen callback:then callback': { removeSourcePane: 1 },
  'components/Panes/dnd/PaneDragController.tsx:PaneDragProvider:useEffect callback:onTargetUp': { claimGlobalPaneDrag: 1 },
  'components/Panes/dnd/PaneDragController.tsx:PaneDragProvider:useEffect callback:handleTabHover:setTimeout callback': { dispatch: 1 },
  'components/Panes/dnd/PaneDragController.tsx:PaneDragProvider:useEffect callback:onMove:then callback': { beginGlobalPaneDrag: 1 },
  'components/Panes/dnd/PaneDragController.tsx:PaneDragProvider:useEffect callback:commitDrop': { dispatch: 3, removeTab: 1 },
  'components/Panes/dnd/PaneDragController.tsx:PaneDragProvider:useEffect callback:onUp:setTimeout callback:then callback': { resolveOrphanGlobalDrag: 1, createDetachedWindow: 1, removeSourcePane: 1 },
});
classify('Observable incarnation key; captured pi/current effect lifetime at completion/probe/restart/error sink; guard release also compares the original promise. Exit/title use exact pc.', {
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:releaseGuards': { delete: 3 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:reuse': { probeReattachPromptGate: 1, stashPromptGate: 1, setProcessId: 2 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback': { setWaitingForHost: 1, setProcessId: 1, setStartupFailed: 1, set: 3, createTerminal: 1 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:onWait': { setWaitingForHost: 1 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:then callback': { setStartupFailed: 1, setWaitingForHost: 1, takeReattachPromptHook: 1, stashPromptGate: 1, markReattachedSession: 1, setProcessId: 1, delete: 2, updateTerminalName: 1 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:catch callback': { setStartupFailed: 3, setWaitingForHost: 1, dispatch: 4, removeTab: 2, removeTabTree: 2 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:reusePending:then callback': { setProcessId: 1, setStartupFailed: 1 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:reusePending:catch callback': { setWaitingForHost: 1, setStartupFailed: 1 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useEffect callback:onExit': { dispatch: 1 },
  'components/Panes/TerminalPane.tsx:TerminalPane:useCallback callback': { createTerminal: 1, setProcessId: 1, dispatch: 6 },
  'components/Panes/TerminalPane.tsx:TerminalPane:handleNameSave': { dispatch: 1, updateTerminalName: 1 },
  'components/Panes/TerminalPane.tsx:TerminalPane': { dispatch: 1, setWaitingForHost: 1 },
});
classify('Preview is visual-only; close captures pi synchronously; confirmation compares workspace/tree; process-info continuation compares request seq; select reads current intent.', {
  'components/Tabs/TabManager.tsx:beginTabDrag:scheduleNativeMove:requestAnimationFrame callback': { moveDragPreview: 1 },
  'components/Tabs/TabManager.tsx:beginTabDrag:onMove': { showDragPreview: 1 },
  'components/Tabs/TabManager.tsx:beginTabDrag:onUp': { hideDragPreview: 1 },
  'components/Tabs/TabManager.tsx:TabManager:useCallback callback': { closeTerminal: 1, dispatch: 4, removeTab: 1, getActiveProcesses: 1 },
  'components/Tabs/TabManager.tsx:TabManager:useCallback callback:proceed': { dispatch: 1 },
});
classify('One registration allocation outstanding with stopped check; FIFO pg/seq/attempt compares before bridge and on reply. Immutable captured pi ops; synchronous compare-delete slots; stop drains without fallback.', {
  'services/paneIncarnations.ts:start:register': { bridge: 1 },
  'services/paneIncarnations.ts:drain': { splice: 1 },
  'services/paneIncarnations.ts:stop': { clear: 4 },
  'services/paneIncarnations.ts:send': { push: 1 },
  'services/paneIncarnations.ts:pump': { bridge: 1, shift: 1 },
  'services/paneIncarnations.ts:prepare:map callback': { depart: 1, set: 1, send: 1 },
  'services/paneIncarnations.ts:discardPrepared': { depart: 1 },
  'services/paneIncarnations.ts:close': { send: 1 },
  'services/paneIncarnations.ts:depart': { delete: 1, send: 1 },
  'services/paneIncarnations.ts:bind': { send: 1 },
  'services/paneIncarnations.ts:admit': { send: 1 },
  'services/paneIncarnations.ts:create': { bridge: 1 },
  'services/paneIncarnations.ts:waitTransfer': { bridge: 1 },
  'services/paneIncarnations.ts:reap': { bridge: 1 },
  'services/paneIncarnations.ts:observe': { delete: 3, depart: 1, prepare: 1 },
});
classify('Captured original slot objects/tx, current slot comparison on failed stash; cancel checks workspace/original captures/live presence; adopt checks workspace before writing slots, error departs captured pis.', {
  'services/paneIncarnations.ts:stash': { set: 2, send: 1, delete: 2 },
  'services/paneIncarnations.ts:cancel': { send: 1, delete: 2, prepare: 1, bind: 1 },
  'services/paneIncarnations.ts:cancel:forEach callback': { delete: 1 },
  'services/paneIncarnations.ts:installTransfer': { send: 2, depart: 1 },
  'services/paneIncarnations.ts:installTransfer:forEach callback': { set: 1 },
});
classify('Workspace token plus prepared pi compare and fresh visible-leaf check immediately before attach/install; invalidation departs captured pi; final activation checks token/tab.', {
  'services/restoreHiddenAgentTerminals.ts:restoreHiddenAgentTerminals': { prepare: 1, bind: 1, depart: 1, attachExistingTerminal: 1, markReattachedSession: 1, dispatch: 5, addTabTree: 1 },
});
classify('Replacement generation at each async install; prepared pi compare at bind/barrier; tab-scoped source map compare; clear is synchronous and invalidates workspace. Reap names the original full pc.', {
  'services/StateManager.ts:restoreStateInner': { dispatch: 5, listWindowSessionIds: 1, pruneTerminalHistory: 1, restoreTabPanesInPlace: 2, addTabTree: 1 },
  'services/StateManager.ts:reconcileExistingTerminals': { prepare: 1, bind: 1, attachExistingTerminal: 1, markReattachedSession: 1, reap: 1, discardPrepared: 1 },
  'services/StateManager.ts:reconcileExistingTerminals:reap callback': { closeTerminal: 1 },
  'services/StateManager.ts:loadLayoutInner': { populateWorkspace: 1 },
  'services/StateManager.ts:registerRestoringTrees': { prepare: 1, send: 1, discardPrepared: 1 },
  'services/StateManager.ts:populateWorkspace': { restoreTabPanesInPlace: 1, dispatch: 9, addTabTree: 2 },
  'services/StateManager.ts:revertWorkspaceInner': { populateWorkspace: 1 },
  'services/StateManager.ts:loadTabScopedLayout': { dispatch: 7, addTabTree: 1 },
  'services/StateManager.ts:resetToDefaultLayout': { dispatch: 1 },
  'services/StateManager.ts:clearCurrentState': { discardPrepared: 1, dispatch: 3, clearAllTabs: 1, resetPanes: 1 },
});
classify('Capture-keyed single-flight and promise/placement object compare on removal; pi/tree/suppression at publication; replacement waits raw predecessor then binds its exact pc. Close uses original process object.', {
  'services/TerminalService.ts:createTerminal': { set: 1, delete: 1 },
  'services/TerminalService.ts:setHostWaitState': { set: 1, delete: 1 },
  'services/TerminalService.ts:createTerminalWithRetry': { setHostWaitState: 7 },
  'services/TerminalService.ts:createTerminalInner': { bind: 1, admit: 1, createTerminal: 1, create: 1, set: 1, bindCreated: 1 },
  'services/TerminalService.ts:createTerminalInner:catch callback': { delete: 1 },
  'services/TerminalService.ts:capturePane': { prepare: 1 },
  'services/TerminalService.ts:authorizeExisting': { bind: 1 },
  'services/TerminalService.ts:closeTerminal:map callback': { close: 1 },
  'services/TerminalService.ts:closeTerminal': { setHostWaitState: 1, closeTerminal: 1, delete: 4, dispatch: 1 },
});
classify('Exact pc event/request or synchronous map/seed operation; async callers qualify pi/workspace first. Native guards use capture keys, browser uses leaf keys.', {
  'services/TerminalService.ts:initializeListeners': { onTerminalData: 1, onTerminalExit: 1 },
  'services/TerminalService.ts:initializeListeners:onTerminalExit callback': { delete: 4 },
  'services/TerminalService.ts:writeToTerminal': { writeToTerminal: 1 },
  'services/TerminalService.ts:resizeTerminal': { resizeTerminal: 1 },
  'services/TerminalService.ts:bindProcess': { set: 1, adoptConsoleWindow: 1 },
  'services/TerminalService.ts:attachExistingTerminal': { registerExistingTerminal: 1, set: 4 },
  'services/TerminalService.ts:stashPromptGate': { set: 1, delete: 1 },
  'services/TerminalService.ts:takePromptGateHandoff': { delete: 1 },
  'services/TerminalService.ts:takeWin32InputModeHandoff': { delete: 1 },
  'services/TerminalService.ts:stashKeyboardProtocol': { set: 1, delete: 1 },
  'services/TerminalService.ts:takeKeyboardProtocolHandoff': { delete: 1 },
  'services/TerminalService.ts:detachTerminal': { delete: 5 },
  'services/TerminalService.ts:clearInitGuards': { delete: 3 },
});

function unclassified(files: Record<string, string>): string[] {
  return Object.entries(inventory(files)).flatMap(([name, effects]) => {
    const row = classified[name];
    return row && JSON.stringify(row.effects) === JSON.stringify(effects) && row.mechanism.length
      ? [] : [`${name}: classify captured pi/workspace/token or justify synchronous/exact-process safety; effects=${JSON.stringify(effects)}`];
  });
}
test('renderer lifetime sink census requires a mechanism for changed or newly introduced sinks', () => {
  expect(unclassified(sources())).toEqual([]);
});
test('an in-memory asynchronous installer absent from the table is rejected', () => {
  expect(unclassified({ 'services/unlistedInstaller.ts': 'async function installLater(dispatch) { await bridge(); dispatch(addTabTree({ tabId: savedId, tree })); }' }))
    .toEqual([expect.stringContaining('unlistedInstaller.ts:installLater: classify captured pi/workspace/token')]);
  const code = 'async function finish() { await bridge(); terminalService.detachTerminal(leaf); }';
  expect(unclassified({ 'services/unlistedDetach.ts': code })).toEqual([expect.stringContaining('unlistedDetach.ts:finish')]);
});
