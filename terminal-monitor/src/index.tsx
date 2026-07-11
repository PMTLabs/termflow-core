import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// Suppress benign ResizeObserver loop error
// This occurs when ResizeObserver callback triggers layout changes that would
// require another observation in the same frame. The notifications are delivered
// in the next frame, so this is not an actual error - just a browser warning.
// Common with xterm.js FitAddon and CSS Grid layouts.
const resizeObserverError = 'ResizeObserver loop completed with undelivered notifications';

window.addEventListener('error', (event) => {
  if (event.message?.includes(resizeObserverError)) {
    event.stopImmediatePropagation();
    event.preventDefault();
    return false;
  }
});

// Also handle unhandled promise rejections with this error
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.message?.includes(resizeObserverError)) {
    event.preventDefault();
    return false;
  }
});

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
