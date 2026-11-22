import * as path from 'path';
import { readSource } from '../../../utils/readSource';

// TerminalDisplay's xterm host cannot mount under root Jest. Pin the item-building
// order here; the SSH browser tests mount the shared ContextMenu itself.
test('existing_context_menu_items_unchanged', () => {
  const source = readSource(path.join(__dirname, '..', 'TerminalDisplay.tsx'));
  const start = source.indexOf('const getContextMenuItems =');
  const end = source.indexOf('\n  };', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const items = [...source.slice(start, end).matchAll(
    /^\s*(?:label: ([^\n]+),|\{ type: 'separator' as const \},|(?:\.\.\.\(paneId && !relocationHost \? )?(broadcastMenuItems|adminTabMenuItem|\.\.\.automationMenuItems|buildCommandHistoryMenuItem|snippetsMenuItem)\()/gm,
  )].map(match => match[1] ?? match[2] ?? '|');
  expect(items).toEqual([
    'broadcastMenuItems', "'New Pane'", "'New Tab'", 'adminTabMenuItem', "'New Window'", '`Color scheme for "${agentForMenu}"`', '|',
    "contextMenu.link.kind === 'url' ? 'Copy Link' : 'Copy Path'", "'Copy'", "'Paste'",
    "selectionMode ? '✓ Selection mode (app mouse paused)' : 'Selection mode (pause app mouse)'",
    "paneMuted ? 'Unmute Pane Notifications' : 'Mute Pane Notifications'", '|',
    '...automationMenuItems', 'buildCommandHistoryMenuItem', 'snippetsMenuItem', '|',
    "'Clear'", "'Select All'", "'Find…'", '|', "'Reset Rendering'",
    "webglDisabled ? 'Re-enable WebGL (New Terminals)' : 'Disable WebGL (All Terminals)'", '|',
    "isTermDiagEnabled() ? 'Disable Diagnostics Logging' : 'Enable Diagnostics Logging'",
  ]);
});
