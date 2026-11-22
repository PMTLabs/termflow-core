import {
  dismissRemoteHint,
  isRemoteHintDismissed,
  resetRemoteHintDismissals,
  shouldShowRemoteHint,
  type RemoteHintInputs,
} from '../remoteSuggestHint';

// Plan 061 AC6: the chip shows only for a hooked local shell whose ssh host has not
// signalled a prompt. Every condition is flipped on its own, so dropping any one of
// them from the rule fails a named case.

const SHOWING: RemoteHintInputs = {
  sshForeground: true,
  mark: { seen: true, kind: 'local' },
  suggestEnabled: true,
  dismissed: false,
};

describe('shouldShowRemoteHint', () => {
  it('shows when every condition holds', () => {
    expect(shouldShowRemoteHint(SHOWING)).toBe(true);
  });

  it.each<[string, Partial<RemoteHintInputs>]>([
    ['ssh is not the foreground program', { sshForeground: false }],
    ['the setting is off', { suggestEnabled: false }],
    ['the user dismissed it', { dismissed: true }],
    ['no engine yet', { mark: null }],
    ['the local shell never proved it renders prompts (no gate to re-arm)', { mark: { seen: false, kind: 'local' } }],
    ['the host already sent a prompt mark', { mark: { seen: true, kind: 'host' } }],
  ])('hides when %s', (_name, over) => {
    expect(shouldShowRemoteHint({ ...SHOWING, ...over })).toBe(false);
  });
});

describe('dismissal store', () => {
  beforeEach(() => resetRemoteHintDismissals());

  it('is per terminal', () => {
    expect(isRemoteHintDismissed('tm-1')).toBe(false);
    dismissRemoteHint('tm-1');
    expect(isRemoteHintDismissed('tm-1')).toBe(true);
    expect(isRemoteHintDismissed('tm-2')).toBe(false);
  });
});
