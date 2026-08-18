import React from 'react';
import ReactDOM from 'react-dom/client';

// Tear-off drag preview window (`index.html?dragPreview=1`): render only the
// small window-shaped card and skip the entire app/store/terminal bootstrap.
const previewParams = new URLSearchParams(window.location.search);
if (previewParams.has('dragPreview')) {
  const { renderDragPreview } = require('./components/Tabs/DragPreview');
  renderDragPreview(previewParams.get('title') || 'Terminal');
} else {
  void bootstrapApp();
}

async function bootstrapApp(): Promise<void> {
// Detect environment and setup bridge BEFORE importing the rest of the app
const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;

if (isTauri) {
  // Resolve the profile FIRST — before the bridge, before App. Two instances
  // share one WebView2 user-data folder, so they share one localStorage; the
  // bridge writes the API token as soon as its config request resolves and App
  // registers unload/interval saves the moment it mounts. Either landing before
  // the scope is known writes to the DEFAULT profile's keys.
  const { invoke } = require('@tauri-apps/api/core');
  const { initProfileScope } = require('./services/profileScope');
  const profile = await initProfileScope(invoke);
  console.log('Profile:', profile.scope);

  // Then resolve WHICH WINDOW this is, for the same reason and before the same
  // consumers (plan 018). Every window of one instance shares this localStorage;
  // without an id they all write the session to one key and clobber each other.
  const { initWindowScope } = require('./services/windowScope');
  const windowId = await initWindowScope(invoke);
  console.log('Window:', windowId);

  console.log('Running in Tauri mode - loading Tauri Bridge...');
  require('./api/tauri-bridge');
} else if (!(window as any).electronAPI) {
  console.log('Running in browser mode - loading Browser Bridge...');
  require('./api/browser-bridge');
} else {
  console.log('Running in Electron mode - electronAPI already available via preload script.');
}

// Now that window.electronAPI is guaranteed to be set, require the rest
const { Provider } = require('react-redux');
const { store } = require('./store');
const { default: App } = require('./App');
const { default: BuildBadge } = require('./components/BuildBadge/BuildBadge');
const { terminalService } = require('./services/TerminalService');
require('./styles/index.css');

// Debug: Check if electronAPI is available
console.log('Renderer starting...');
console.log('electronAPI available:', !!(window as any).electronAPI);

if ((window as any).electronAPI) {
  console.log('electronAPI methods:', Object.keys((window as any).electronAPI));
}

// Make terminalService available globally for API access
(window as any).terminalService = terminalService;

// Create root element
const container = document.getElementById('root');
if (!container) {
  throw new Error('Failed to find root element');
}

const root = ReactDOM.createRoot(container);

// Render app with Redux provider
// Note: React.StrictMode removed to prevent duplicate terminal creation in development
// StrictMode causes components to mount twice which was creating duplicate terminals
root.render(
  <Provider store={store}>
    <App />
    <BuildBadge />
  </Provider>
);
}