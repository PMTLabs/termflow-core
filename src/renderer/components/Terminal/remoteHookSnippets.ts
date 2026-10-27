// Plan 061: one-line prompt hooks a user pastes into an ssh session so the remote
// shell emits OSC 133;A (semantic-prompt "prompt start") before every prompt. The
// terminal engine treats that mark as "a shell prompt rendered", which re-arms the
// command-suggest gate that Enter disarmed when the ssh command was submitted.
// A remote agent CLI (claude, codex) renders no shell prompt and does not normally
// send the mark, so it stays suppressed. The engine trusts any 133;A producer, so a
// full-screen program that does emit it would re-arm capture (plan 061 accepts this).
//
// Each snippet must: emit the mark on EVERY prompt, be safe to paste twice, run
// before the user's existing prompt hooks, and leave `$?` as those hooks expect it.
// remoteHookSnippets.test.ts runs them in the real shells; termflow-docs copies the
// same strings (see the docs page for the persistent rc-file form).

export type RemoteHookShell = 'bash' | 'zsh' | 'fish';

export const REMOTE_HOOK_SHELLS: readonly RemoteHookShell[] = ['bash', 'zsh', 'fish'];

/** The escape sequence every snippet writes: ESC ] 133 ; A BEL. */
export const PROMPT_MARK = '\x1b]133;A\x07';

// bash: PROMPT_COMMAND is a string, unset, or (bash 5.1+) an array. The helper
// captures `$?` and returns it so hooks that run after it still see the real status.
// The hook is always PREPENDED, so an installed hook is recognised only at the very
// start of the string form (`__tf_pm` alone, or `__tf_pm;` first) or as an array
// element equal to __tf_pm. It is never found by searching the middle of the string,
// where the same text can be quoted data in the user's own command.
const BASH =
  `__tf_pm() { local s=$?; printf '\\033]133;A\\007'; return $s; }; ` +
  `case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in ` +
  `"declare -a"*) __tf_has=0; for __tf_c in "\${PROMPT_COMMAND[@]}"; do [ "$__tf_c" = __tf_pm ] && __tf_has=1; done; ` +
  `[ $__tf_has = 1 ] || PROMPT_COMMAND=(__tf_pm "\${PROMPT_COMMAND[@]}"); unset __tf_has __tf_c;; ` +
  `*) case "\${PROMPT_COMMAND}" in __tf_pm|"__tf_pm;"*) ;; ` +
  `*) PROMPT_COMMAND="__tf_pm\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac;; esac`;

// zsh runs a `precmd` function before every `precmd_functions` entry, so registering
// with add-zsh-hook would land behind it. Instead `precmd` becomes a wrapper that
// writes the mark, then calls the user's original `precmd` (kept as __tf_o, or a no-op)
// with `$?` restored. The `__tf_o` guard makes a second paste do nothing.
const ZSH =
  `__tf_pm() { print -n '\\033]133;A\\007'; }; ` +
  `if (( ! $+functions[__tf_o] )); then ` +
  `if (( $+functions[precmd] )); then functions[__tf_o]=$functions[precmd]; else __tf_o() { :; }; fi; ` +
  `precmd() { local s=$?; __tf_pm; (exit $s); __tf_o; }; fi`;

// fish: a named handler on the fish_prompt event; redefining it replaces it.
const FISH = `function __tf_pm --on-event fish_prompt; printf '\\033]133;A\\007'; end`;

export const REMOTE_HOOK_SNIPPETS: Record<RemoteHookShell, string> = {
  bash: BASH,
  zsh: ZSH,
  fish: FISH,
};
