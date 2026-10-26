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

// zsh and fish are rarely installed on a Windows dev box but usually are in WSL, so
// on win32 they run there. A pty is required: neither shell runs its prompt hooks
// on piped stdin, so `script` supplies one.
const viaWsl = process.platform === 'win32';
function ptyAvailable(shell: string): boolean {
  const r = viaWsl
    ? spawnSync('wsl', ['--', shell, '--version'], { encoding: 'utf8' })
    : spawnSync(shell, ['--version'], { encoding: 'utf8' });
  const ok = !r.error && r.status === 0;
  if (!ok) console.warn(`remoteHookSnippets: ${shell} not found${viaWsl ? ' (native or WSL)' : ''}; its behavioural tests are SKIPPED`);
  return ok;
}

function runPty(shellCommand: string, lines: string[]): string {
  const script = ['script', '-qec', shellCommand, '/dev/null'];
  const r = viaWsl
    ? spawnSync('wsl', ['--', ...script], { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 30000 })
    : spawnSync(script[0], script.slice(1), { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 30000 });
  if (r.error) throw r.error;
  return r.stdout;
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

// bash is the one shell CI must have; a missing bash must not turn the suite green.
if (process.env.CI) {
  test('bash is available in CI', () => {
    expect(available('bash')).toBe(true);
  });
}

describe('bash', () => {
  const run = available('bash') ? describe : describe.skip;
  run('against the real shell', () => {
    const setups: Array<[string, string, boolean]> = [
      ['unset PROMPT_COMMAND', "PS1='<<P''>>'; unset PROMPT_COMMAND", false],
      ['string PROMPT_COMMAND', "PS1='<<P''>>'; PROMPT_COMMAND='echo EXISTING:$?'", true],
      ['multi-command string', "PS1='<<P''>>'; PROMPT_COMMAND='echo EXISTING:$?;echo SECOND'", true],
      ['hook text quoted inside the existing command is not mistaken for the hook', "PS1='<<P''>>'; PROMPT_COMMAND='echo EXISTING:$?; printf %s \";__tf_pm;\" >/dev/null'", true],
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

describe('zsh', () => {
  const run = ptyAvailable('zsh') ? describe : describe.skip;
  run('against the real shell', () => {
    // Sentinel prompt `<<P>>` is typed as <<P''>> so the echoed input never matches.
    const setup = (existing: string[]) => ["PS1='<<P''>>'", ...existing];
    const sentinel = /<<P>>/g;

    test('mark comes before an existing precmd function and precmd_functions hook, both still see $?', () => {
      const out = runPty('zsh -f -i', [
        ...setup(['precmd() { echo EXISTING:$? }', 'precmd_functions+=(late); late() { echo LATE:$? }']),
        ...cycle('zsh'),
        'exit',
      ]);
      // Sentinel prompts: before precmd def, late def, paste, paste, A, exit 7, B, exit = 8.
      expect(count(out, sentinel)).toBe(8);
      // Marks: every prompt after the first paste, exactly once despite the second paste.
      expect(count(out, MARK_RE)).toBe(5);
      expect(count(out, /EXISTING:7/g)).toBe(1);
      expect(count(out, /LATE:7/g)).toBe(1);
      expect(out).toMatch(new RegExp(`${MARK_RE.source}EXISTING:7`));
    });

    test('mark is emitted when no precmd exists', () => {
      const out = runPty('zsh -f -i', [...setup([]), ...cycle('zsh'), 'exit']);
      expect(count(out, sentinel)).toBe(6);
      expect(count(out, MARK_RE)).toBe(5);
    });
  });
});

describe('fish', () => {
  const run = ptyAvailable('fish') ? describe : describe.skip;
  run('against the real shell', () => {
    test('one mark per prompt, the user prompt and its $status survive, pasted twice', () => {
      const out = runPty('fish --no-config -i', [
        'function fish_prompt; echo -n "<<P:$status>>"; end',
        ...cycle('fish').slice(0, 2),
        'echo A',
        'false',
        'echo B',
        'exit',
      ]);
      // Sentinel prompts: before paste, paste, echo A, false, echo B, exit = 6.
      expect(count(out, /<<P:\d+>>/g)).toBe(6);
      expect(count(out, MARK_RE)).toBe(5);
      // The prompt still reads the failing command's status.
      expect(count(out, /<<P:1>>/g)).toBe(1);
    });
  });
});
