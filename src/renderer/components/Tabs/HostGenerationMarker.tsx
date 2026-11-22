import React from 'react';
import type { HostGeneration } from '../../types/electron';
import { useAnyOnPreviousHost } from '../../services/hostGeneration';

export const PREVIOUS_HOST_TITLE = 'Running on a previous version of the terminal service.';

/**
 * The "this shell is on an older terminal host" marker.
 *
 * Drawn only for `previous`. `current`, an absent value and anything unrecognised draw nothing, so
 * a terminal the backend has not described yet is never painted as old.
 */
export const HostGenerationMarker: React.FC<{ generation: HostGeneration | undefined }> = ({ generation }) => {
  if (generation !== 'previous') return null;
  return (
    <span className="tab-previous-host" title={PREVIOUS_HOST_TITLE} role="img" aria-label={PREVIOUS_HOST_TITLE}>
      ⟲
    </span>
  );
};

/**
 * The tab strip's face: marked when any terminal in the tab is on an older host. Deliberately not
 * memoised, like the other per-tab badges: the id array is rebuilt by the host on every render,
 * and the subscription's snapshot is a boolean, so a re-render is cheap and wakes nothing else.
 */
export const PreviousHostForTerminals: React.FC<{ terminalIds: readonly string[] }> = ({ terminalIds }) => (
  <HostGenerationMarker generation={useAnyOnPreviousHost(terminalIds) ? 'previous' : 'current'} />
);
