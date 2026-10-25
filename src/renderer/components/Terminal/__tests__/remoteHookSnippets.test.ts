/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import {
  PROMPT_MARK,
  REMOTE_HOOK_SHELLS,
  REMOTE_HOOK_SNIPPETS,
  type RemoteHookShell,
} from '../remoteHookSnippets';

// Plan 061 AC7: the pasted hook must emit the prompt mark on EVERY prompt cycle,
// survive being pasted twice, and not disturb the user's existing prompt hooks or
// the `$?` they read. Strings alone prove none of that, so these run the real shell
// with piped stdin: an interactive shell still runs its prompt hook before each
// prompt, and the prompt itself (a sentinel PS1) goes to stderr, so it counts the
// cycles independently of the hook under test.

function available(shell: string): boolean {
  const r = spawnSync(shell, ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function bashAtLeast51(): boolean {
  const r = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return false;
  const [major, minor] = r.stdout.trim().split(' ').map(Number);
  return major > 5 || (major === 5 && minor >= 1);
}

const MARK_RE = new RegExp(PROMPT_MARK.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'g');
const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

interface Run { out: string; prompts: number }

function runBash(lines: string[]): Run {
  const r = spawnSync('bash', ['--norc', '--noprofile', '-i'], {
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, HOME: process.cwd(), HISTFILE: '' },
    timeout: 20000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout, prompts: count(r.stderr, /<<P>>/g) };
}

/** Lines after setup: paste twice, then three commands (one failing with status 7). */
function cycle(shell: RemoteHookShell): string[] {
  const s = REMOTE_HOOK_SNIPPETS[shell];
  return [s, s, 'echo A', '(exit 7)', 'echo B'];
}

describe('snippet shape', () => {
  test.each(REMOTE_HOOK_SHELLS)('%s: one paste-safe line that writes the prompt mark', (shell) => {
    const s = REMOTE_HOOK_SNIPPETS[shell];
    expect(s).not.toMatch(/[\r\n]/);
    // ESC ] 133 ; A BEL spelled as octal escapes inside the shell command.
    expect(s).toContain('\\033]133;A\\007');
    expect(PROMPT_MARK).toBe('\x1b]133;A\x07');
  });
});

describe('bash', () => {
  const run = available('bash') ? describe : describe.skip;
  run('against the real shell', () => {
    const setups: Array<[string, string, boolean]> = [
      ['unset PROMPT_COMMAND', "PS1='<<P''>>'; unset PROMPT_COMMAND", false],
      ['string PROMPT_COMMAND', "PS1='<<P''>>'; PROMPT_COMMAND='echo EXISTING:$?'", true],
      ['multi-command string', "PS1='<<P''>>'; PROMPT_COMMAND='echo EXISTING:$?;echo SECOND'", true],
      ['lookalike token is not mistaken for the hook', "PS1='<<P''>>'; PROMPT_COMMAND='echo EXISTING:$?; : not__tf_pm_really'", true],
    ];
    if (bashAtLeast51()) {
      setups.push(['indexed-array PROMPT_COMMAND', "PS1='<<P''>>'; PROMPT_COMMAND=('echo EXISTING:$?' 'echo SECOND')", true]);
    }

    test.each(setups)('%s: one mark per prompt after install, pasted twice', (_name, setup, hasExisting) => {
      const { out, prompts } = runBash([setup, ...cycle('bash')]);
      // Prompts after the setup line: before each of the five lines below it, plus the
      // one before EOF. The very first prompt (before install) carries no mark.
      expect(prompts).toBe(6);
      expect(count(out, MARK_RE)).toBe(prompts - 1); // exactly once per cycle, not twice
      if (hasExisting) {
        // The user's own hook ran on every prompt, including the first (pre-install) one.
        expect(count(out, /EXISTING:/g)).toBe(prompts);
        // ...and still saw the real exit status of the command before it.
        expect(count(out, /EXISTING:7/g)).toBe(1);
        // The mark comes first within a cycle, so the existing hook's output follows it.
        expect(out).toMatch(new RegExp(`${MARK_RE.source}EXISTING:7`));
      }
    });

    test('the mark is written by the prompt hook, not once at paste time', () => {
      const { out } = runBash(["PS1='<<P''>>'; unset PROMPT_COMMAND", REMOTE_HOOK_SNIPPETS.bash]);
      // Install line + EOF: one cycle after the paste, so exactly one mark.
      expect(count(out, MARK_RE)).toBe(1);
    });
  });
});

// zsh and fish are not installed everywhere (including this repo's dev machine, where
// these have never been run). They are skipped with a visible reason rather than
// silently passing; run them wherever the shell exists.
describe('zsh', () => {
  const run = available('zsh') ? describe : describe.skip;
  run('against the real shell', () => {
    test('one mark per prompt, pasted twice, existing precmd still runs with $?', () => {
      const lines = [
        "PS1='<<P''>>'",
        'precmd() { echo EXISTING:$? }',
        ...cycle('zsh'),
      ];
      const r = spawnSync('zsh', ['-f', '-i'], { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 20000 });
      if (r.error) throw r.error;
      const prompts = count(r.stderr + r.stdout, /<<P>>/g);
      expect(count(r.stdout, MARK_RE)).toBe(prompts - 1);
      expect(count(r.stdout, /EXISTING:7/g)).toBe(1);
    });
  });
});

describe('fish', () => {
  const run = available('fish') ? describe : describe.skip;
  run('against the real shell', () => {
    test('a defined handler emits one mark per prompt event, pasted twice', () => {
      const s = REMOTE_HOOK_SNIPPETS.fish;
      const script = [s, s, 'emit fish_prompt', 'emit fish_prompt'].join('\n');
      const r = spawnSync('fish', ['--no-config', '-c', script], { encoding: 'utf8', timeout: 20000 });
      if (r.error) throw r.error;
      expect(count(r.stdout, MARK_RE)).toBe(2);
    });
  });
});
