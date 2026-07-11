import React from 'react';
import ReactDOM from 'react-dom/client';

// Tear-off drag preview window (`index.html?dragPreview=1`): render only the
// small window-shaped card and skip the entire app/store/terminal bootstrap.
const previewParams = new URLSearchParams(window.location.search);
if (previewParams.has('dragPreview')) {
  const { renderDragPreview } = require('./components/Tabs/DragPreview');
  renderDragPreview(previewParams.get('title') || 'Terminal');
} else {
  bootstrapApp();
}

function bootstrapApp(): void {
// Detect environment and setup bridge BEFORE importing the rest of the app
const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;

if (isTauri) {
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
  </Provider>
);
}