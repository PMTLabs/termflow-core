// Polyfills for Electron renderer process
// Fix for "global is not defined" error

// Immediately define global at the very top
(function() {
  'use strict';
  
  // Define global variable for Node.js compatibility
  if (typeof global === 'undefined') {
    if (typeof globalThis !== 'undefined') {
      window.global = globalThis;
      globalThis.global = globalThis;
    } else {
      window.global = window;
    }
  }
  
  // Ensure global is available on globalThis as well
  if (typeof globalThis !== 'undefined' && typeof globalThis.global === 'undefined') {
    globalThis.global = globalThis;
  }
  
  // Additional polyfills for Node.js globals in renderer process
  if (typeof process === 'undefined') {
    const processPolyfill = {
      env: {},
      platform: 'browser',
      version: '',
      versions: {},
      nextTick: function(callback) {
        setTimeout(callback, 0);
      }
    };
    window.process = processPolyfill;
    if (typeof global !== 'undefined') {
      global.process = processPolyfill;
    }
  }
  
  // Buffer polyfill if needed
  if (typeof Buffer === 'undefined') {
    window.Buffer = {};
    if (typeof global !== 'undefined') {
      global.Buffer = {};
    }
  }
})();