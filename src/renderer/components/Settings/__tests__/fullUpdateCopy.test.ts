import {
  confirmTokenFor,
  fullUpdateDialogLead,
  fullUpdateDialogTitle,
  fullUpdateReasonLines,
  terminalCountCopy,
} from '../fullUpdateCopy';
import type { UpdateConfirmation } from '../../../api/tauri-bridge';

describe('terminalCountCopy', () => {
  it.each([
    [3, false, '3 terminals'],
    [1, false, '1 terminal'],
    [0, false, 'no terminals'],
    [3, true, 'at least 3 terminals'],
    [1, true, 'at least 1 terminal'],
  ])('%i terminals, unknown=%s => %s', (count, unknown, expected) => {
    expect(terminalCountCopy(count, unknown)).toBe(expected);
  });

  it('never reports 0 for a count that is only a lower bound', () => {
    const copy = terminalCountCopy(0, true);
    expect(copy).not.toMatch(/\b0\b/);
    expect(copy).not.toMatch(/\bno terminals\b/);
  });
});

describe('fullUpdateReasonLines', () => {
  it('words a release marker as a required full restart', () => {
    expect(fullUpdateReasonLines([{ kind: 'marker' }])).toEqual(['This release requires a full restart.']);
  });

  it.each([
    [{ kind: 'hostInPayload', host: 'h1' } as const],
    [{ kind: 'hostOriginUnknown', host: 'h1' } as const],
  ])('words %j as a terminal service that cannot survive', (reason) => {
    expect(fullUpdateReasonLines([reason])).toEqual(['A running terminal service cannot survive this update.']);
  });

  it('says each cause once, in the order met', () => {
    expect(
      fullUpdateReasonLines([
        { kind: 'hostInPayload', host: 'a' },
        { kind: 'marker' },
        { kind: 'hostOriginUnknown', host: 'b' },
      ]),
    ).toEqual([
      'A running terminal service cannot survive this update.',
      'This release requires a full restart.',
    ]);
  });

  it('has nothing to say about no reasons', () => {
    expect(fullUpdateReasonLines([])).toEqual([]);
  });
});

describe('dialog copy', () => {
  const base: UpdateConfirmation = { version: '9.9.9', shellCount: 3, unknown: false, reasons: [{ kind: 'marker' }] };

  it('states that ALL terminals close and how many', () => {
    expect(fullUpdateDialogLead(base)).toBe(
      'This update closes ALL terminals and everything running in them. 3 terminals will be closed.',
    );
  });

  it('words an unanswered host as a lower bound', () => {
    expect(fullUpdateDialogLead({ ...base, shellCount: 2, unknown: true })).toContain('At least 2 terminals will be closed.');
    expect(fullUpdateDialogLead({ ...base, shellCount: 0, unknown: true })).not.toMatch(/\b0\b/);
    // Nothing running and nothing unknown: it must not say it closes everything and then that none are closed.
    const none = fullUpdateDialogLead({ ...base, shellCount: 0, unknown: false });
    expect(none).toBe('This update restarts TermFlow. No terminals are running, so nothing will be lost.');
    expect(none).not.toMatch(/closes ALL/);
  });

  it('names the version being installed in the title', () => {
    expect(fullUpdateDialogTitle('9.9.9')).toContain('9.9.9');
  });
});

describe('confirmTokenFor', () => {
  it('carries every field of the confirmation under the names the backend reads, reasons unchanged', () => {
    const confirmation: UpdateConfirmation = {
      version: '9.9.9',
      shellCount: 4,
      unknown: true,
      reasons: [{ kind: 'marker' }, { kind: 'hostInPayload', host: 'h1' }],
    };
    expect(confirmTokenFor({ ...confirmation, outcome: 'needsConfirmation' } as UpdateConfirmation)).toStrictEqual({
      targetVersion: '9.9.9',
      shellCount: 4,
      unknown: true,
      reasons: [{ kind: 'marker' }, { kind: 'hostInPayload', host: 'h1' }],
    });
  });
});
