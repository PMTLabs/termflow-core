import React from 'react';
import type { CloseKind } from '../../services/closeTabs';

export interface CloseSummaryProps {
  kind: CloseKind;
  /** Affected tab ids, in display order. */
  tabIds: string[];
  /** Clicked/anchor tab title (single-close message). */
  anchorTitle: string;
  /** tabId -> display title, for the bulk list. */
  titlesById: Record<string, string>;
  /** tabId -> meaningful (non-shell) foreground process names. */
  processInfo: Map<string, string[]>;
  /** True once the live process list has been fetched and mapped. */
  loaded: boolean;
}

const ProcBadges: React.FC<{ names: string[] }> = ({ names }) => (
  <>
    {names.map((n) => (
      <code key={n} className="close-summary-proc">
        {n}
      </code>
    ))}
  </>
);

function bulkHeader(kind: CloseKind, n: number): string {
  const tabWord = n === 1 ? 'tab' : 'tabs';
  switch (kind) {
    case 'right':
      return `Close ${n} ${tabWord} to the right?`;
    case 'left':
      return `Close ${n} ${tabWord} to the left?`;
    case 'others':
      return `Close ${n} other ${tabWord}?`;
    default:
      return `Close ${n} ${tabWord}?`;
  }
}

/**
 * The body of the close confirm. For a single close it names the running
 * processes in that tab (or a plain confirm for a bare shell). For a bulk close
 * it lists each affected tab and flags the ones with running processes.
 * Falls back to a generic message until the live process list has loaded (or if
 * the fetch failed), so closing is never blocked on the API.
 */
export const CloseSummary: React.FC<CloseSummaryProps> = ({
  kind,
  tabIds,
  anchorTitle,
  titlesById,
  processInfo,
  loaded,
}) => {
  if (kind === 'single') {
    const names = processInfo.get(tabIds[0]) ?? [];
    return (
      <div className="close-summary">
        <p>
          Are you sure you want to close <strong>{anchorTitle}</strong>?
        </p>
        {!loaded ? (
          <p className="close-summary-running">Any running process will be terminated.</p>
        ) : names.length > 0 ? (
          <p className="close-summary-running">
            Running: <ProcBadges names={names} /> —{' '}
            {names.length === 1 ? 'this process' : 'these processes'} will be terminated.
          </p>
        ) : null}
      </div>
    );
  }

  const anyRunning = tabIds.some((id) => (processInfo.get(id)?.length ?? 0) > 0);

  return (
    <div className="close-summary">
      <p>{bulkHeader(kind, tabIds.length)}</p>
      <ul className="close-summary-tabs">
        {tabIds.map((id) => {
          const names = processInfo.get(id) ?? [];
          const has = names.length > 0;
          return (
            <li key={id} className={has ? 'has-running' : ''}>
              <span className="close-summary-tab-title">{titlesById[id] ?? id}</span>
              {has && (
                <span className="close-summary-running">
                  <ProcBadges names={names} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="close-summary-running">
        {!loaded
          ? 'Any running processes will be terminated.'
          : anyRunning
            ? 'Tabs marked ● have running processes that will be terminated.'
            : 'No running processes detected in these tabs.'}
      </p>
    </div>
  );
};
