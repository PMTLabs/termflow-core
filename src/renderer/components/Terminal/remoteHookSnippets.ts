// Plan 061: one-line prompt hooks a user pastes into an ssh session so the remote
// shell emits OSC 133;A (semantic-prompt "prompt start") before every prompt. The
// terminal engine treats that mark as "a shell prompt rendered", which re-arms the
// command-suggest gate that Enter disarmed when the ssh command was submitted.
// A remote agent CLI (claude, codex) renders no shell prompt, so it never sends the
// mark and stays suppressed.
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
// An installed hook is recognised by exact token (`;__tf_pm;` in the string form, an
// element equal to __tf_pm in the array form), never by substring.
const BASH =
  `__tf_pm() { local s=$?; printf '\\033]133;A\\007'; return $s; }; ` +
  `case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in ` +
  `"declare -a"*) __tf_has=0; for __tf_c in "\${PROMPT_COMMAND[@]}"; do [ "$__tf_c" = __tf_pm ] && __tf_has=1; done; ` +
  `[ $__tf_has = 1 ] || PROMPT_COMMAND=(__tf_pm "\${PROMPT_COMMAND[@]}"); unset __tf_has __tf_c;; ` +
  `*) case ";\${PROMPT_COMMAND};" in *";__tf_pm;"*) ;; ` +
  `*) PROMPT_COMMAND="__tf_pm\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac;; esac`;

// zsh: add-zsh-hook registers the function once however often it is pasted.
const ZSH =
  `autoload -Uz add-zsh-hook; __tf_pm() { print -n '\\033]133;A\\007'; }; add-zsh-hook precmd __tf_pm`;

// fish: a named handler on the fish_prompt event; redefining it replaces it.
const FISH = `function __tf_pm --on-event fish_prompt; printf '\\033]133;A\\007'; end`;

export const REMOTE_HOOK_SNIPPETS: Record<RemoteHookShell, string> = {
  bash: BASH,
  zsh: ZSH,
  fish: FISH,
};
