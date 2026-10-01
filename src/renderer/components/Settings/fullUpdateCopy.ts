import type { FullUpdateReason, UpdateConfirmation, UpdateConfirmToken } from '../../api/tauri-bridge';

/**
 * Wording for the update that closes every terminal. The panel notice and the
 * confirmation dialog both read from here so they cannot describe it differently.
 */

/**
 * How many terminals the update closes. An unanswered host makes the count a
 * lower bound, so it is never worded as an exact figure, and a lower bound of
 * zero says nothing about how many there are.
 */
export const terminalCountCopy = (shellCount: number, unknown: boolean): string => {
  const noun = shellCount === 1 ? 'terminal' : 'terminals';
  if (!unknown) return shellCount === 0 ? 'no terminals' : `${shellCount} ${noun}`;
  return shellCount === 0 ? 'an unknown number of terminals' : `at least ${shellCount} ${noun}`;
};

const REASON_COPY: Record<FullUpdateReason['kind'], string> = {
  marker: 'This release requires a full restart.',
  hostInPayload: 'A running terminal service cannot survive this update.',
  hostOriginUnknown: 'A running terminal service cannot survive this update.',
};

/**
 * One plain-language sentence per distinct cause. Two hosts that cannot survive
 * read the same to the user, so they are one line.
 */
export const fullUpdateReasonLines = (reasons: FullUpdateReason[]): string[] => [
  ...new Set(reasons.map((r) => REASON_COPY[r.kind])),
];

export const fullUpdateDialogTitle = (version: string): string =>
  `Update to ${version} and close all terminals?`;

/** The sentence that says what the user is agreeing to, with the count. */
export const fullUpdateDialogLead = ({ shellCount, unknown }: UpdateConfirmation): string => {
  const count = terminalCountCopy(shellCount, unknown);
  const sentence = `${count.charAt(0).toUpperCase()}${count.slice(1)}`;
  return `This update closes ALL terminals and everything running in them. ${sentence} will be closed.`;
};

/** The agreement for exactly what was shown: every field copied, nothing recomputed. */
export const confirmTokenFor = (c: UpdateConfirmation): UpdateConfirmToken => ({
  targetVersion: c.version,
  shellCount: c.shellCount,
  unknown: c.unknown,
  reasons: c.reasons,
});
