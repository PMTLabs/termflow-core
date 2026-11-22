const { createProxyMiddleware } = require('http-proxy-middleware');

// termflow-core's API rejects any request whose Origin isn't the real Tauri
// app (see src-tauri/src/api_server/auth.rs origin_allowed) — this monitor's
// :3000 origin is deliberately not on that list. Strip Origin/Referer on the
// way through so the proxied request looks provenance-less, same as curl,
// which the loopback API already treats as trusted (design "D1").
const stripBrowserOrigin = (proxyReq) => {
  proxyReq.removeHeader('origin');
  proxyReq.removeHeader('referer');
};

// Dev-only stand-in for POST /api/auth/token. On a normal loopback instance
// termflow-core never checks the bearer token (auth.rs auth_required), so any
// value works — and the real endpoint currently panics in the shipped build
// (jsonwebtoken 10 needs the `rust_crypto` feature; encode() aborts without
// it). Shaped like a JWT only so authService.debugToken() can decode it.
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const placeholderToken = () => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'none', typ: 'JWT' }),
    b64url({ sub: 'terminal-monitor', permissions: ['*'], iat: now, exp: now + 86400 }),
    'unsigned',
  ].join('.');
};
const stubAuth = (_req, res) => {
  res.json({ token: placeholderToken(), expiresIn: '24h', permissions: ['*'] });
};

module.exports = function (app) {
  // Registered before the proxy so these never reach termflow-core.
  app.post('/api/auth/token', stubAuth);
  app.post('/api/auth/refresh', stubAuth);

  // Mounted at the root and filtered via `pathFilter`, NOT `app.use('/api', ...)`
  // — Express strips the mount prefix from req.url before the proxy sees it, so
  // a path-mounted proxy would forward /api/auth/token as bare /auth/token and
  // 404 against termflow-core. pathFilter matches without stripping anything.
  //
  // Filter is '/api' only (which includes /api/ws) — NOT bare /ws, which
  // webpack-dev-server itself uses by default for its own HMR socket. Proxying
  // /ws too hijacks the dev server's live-reload connection into termflow-core's
  // WS handler instead, producing "Invalid frame header" on both sockets.
  app.use(
    createProxyMiddleware({
      target: 'http://localhost:42031',
      changeOrigin: true,
      ws: true,
      pathFilter: '/api',
      on: {
        proxyReq: stripBrowserOrigin,
        proxyReqWs: stripBrowserOrigin,
      },
    })
  );
};
