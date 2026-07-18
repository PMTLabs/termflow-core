import React from 'react';

/**
 * Dev-only build badge, floated in the bottom-right corner. Shows the git tip the
 * renderer was built from — branch, short SHA, dirty flag, latest commit subject and
 * build time — so you can confirm at a glance which commit is actually running during
 * a manual / live check.
 *
 * The values are injected at build time by webpack's DefinePlugin
 * (webpack.renderer.config.js) and captured when the dev server (or build) starts.
 * Renders nothing in a production / release build (`__DEV_BUILD__` is false), and it is
 * `pointer-events: none` so it can never intercept mouse events destined for a terminal.
 *
 * NOTE: the SHA reflects the *source* tip. The app runs `packages/terminal-core/dist`,
 * which is prebuilt — after a terminal-core change you must `bun run build` and restart
 * the dev server for the running code (not just the badge's SHA) to match.
 */
export function BuildBadge(): React.ReactElement | null {
  if (!__DEV_BUILD__) return null;

  const buildTime = (() => {
    try {
      return new Date(__BUILD_TIME__).toLocaleTimeString();
    } catch {
      return __BUILD_TIME__;
    }
  })();

  return (
    <div style={styles.wrap} title={`${__GIT_BRANCH__} @ ${__GIT_SHA__} — ${__GIT_SUBJECT__}`}>
      <div style={styles.line}>
        <span style={styles.dim}>⎇ </span>
        {__GIT_BRANCH__}
        <span style={styles.dim}> @ </span>
        <span style={styles.sha}>{__GIT_SHA__}</span>
        {__GIT_DIRTY__ ? <span style={styles.dirty}> ● dirty</span> : null}
      </div>
      <div style={styles.sub}>
        {__GIT_SUBJECT__}
        <span style={styles.dim}> · built {buildTime}</span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'fixed',
    right: 8,
    bottom: 6,
    zIndex: 2147483000,
    pointerEvents: 'none',
    maxWidth: '46vw',
    padding: '3px 8px',
    borderRadius: 6,
    background: 'rgba(15, 18, 24, 0.72)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    color: 'rgba(220, 228, 240, 0.92)',
    font: '10px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    letterSpacing: '0.2px',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
    userSelect: 'none',
    textAlign: 'right',
  },
  line: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  sub: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.72 },
  dim: { opacity: 0.55 },
  sha: { color: '#7aa2f7', fontWeight: 600 },
  dirty: { color: '#e0af68' },
};

export default BuildBadge;
