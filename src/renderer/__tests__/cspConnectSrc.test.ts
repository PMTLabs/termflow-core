import * as fs from 'fs';
import * as path from 'path';

// Regression guard for the "scrollback never restores" bug: the renderer's CSP had
// no connect-src, so it fell back to `default-src 'self'` and the webview blocked
// fetch()/WebSocket to the API server on its different localhost PORT
// ("TypeError: Failed to fetch"). That silently broke /snapshot hydration. The CSP
// MUST allow the local API/WS server on any localhost port.
describe('renderer index.html CSP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const csp = (html.match(/Content-Security-Policy"\s+content="([^"]+)"/) || [])[1] || '';
  const connectSrc = (csp.match(/connect-src([^;]*)/) || [])[1] || '';

  test('declares a connect-src directive', () => {
    expect(csp).toContain('connect-src');
  });

  test('connect-src allows the local API server (http + ws, any localhost port)', () => {
    expect(connectSrc).toMatch(/http:\/\/localhost:\*/);
    expect(connectSrc).toMatch(/ws:\/\/localhost:\*/);
  });
});
