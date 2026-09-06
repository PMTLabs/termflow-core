/**
 * The `$0` / `$1` / `${name}` / `$$` grammar, scan-only — ported from the ONE scanner
 * `src-tauri/src/automation_engine/subst.rs` owns for the Rust side (`scan`, read that module's
 * doc first for the full grammar table: `$$` escaping, `$x` and a trailing `$` as literals,
 * `${12}` vs `$12`).
 *
 * **Why a second scanner exists at all, and why it must not drift from the first.** The renderer
 * has no `substitute` — only the backend ever types a message into a pty — so this side only
 * needs to know WHICH tokens a message names, never to resolve them. But `automationValidation.ts`
 * uses this to decide whether a message can be SAVED, and `subst::substitute` is what decides
 * whether it can be SENT; if the two scanners ever recognised a different grammar, a message could
 * pass validation here and still be refused at send time — the exact failure `two-implementations-
 * one-fix` warns about, just one module over. There is no shared-fixture mechanism for the scanner
 * itself (unlike the `Problem` list), so the discipline is: port `scan` faithfully, and pin it with
 * the SAME grammar table `subst.rs`'s tests use, in `automationTokens.test.ts`.
 *
 * **One simplification from the Rust `Token` enum: no separate `Whole` variant.** Rust keeps `$0`
 * (`Token::Whole`) and `${0}` (`Token::Group(0)`) as distinct enum cases only because `substitute`
 * needs its own match arm for `Whole` (`caps.group(0)`, unconditionally). But `Token::Group(n)`'s
 * own `Display` is `${n}`, so `Group(0)` prints `"$0"` too — identically to `Whole`. And every
 * consumer here treats "group 0" as always resolvable (it is the whole match, always present once
 * a pattern compiles), so `n > count` is never true for `n === 0` regardless of which spelling
 * produced it. With no observable difference in text or behaviour, this port represents both
 * spellings as `{ kind: 'group', n: 0 }`.
 */

export type Token =
    | { kind: 'group'; n: number; text: string }
    | { kind: 'named'; name: string; text: string };

const isAllDigits = (s: string): boolean => s.length > 0 && /^[0-9]+$/.test(s);

/**
 * Every token the message names, in order, without duplicates removed — the validation-facing
 * counterpart to `subst::tokens_used`.
 *
 * Walks the message once, exactly as `subst.rs`'s `scan` does: `$$` is consumed as a literal `$`
 * (so `$$1` is `$1` of TEXT, never a token — `awk '{print $1}'` keeps working with `substitute`
 * on only because the grammar treats an unescaped `$1` and an escaped `$$1` differently); `${name}`
 * is a named lookup unless `name` is all digits, in which case it is `Group(n)`; a bare digit after
 * `$` is one-digit `Group(n)` (`$12` is `Group(1)` followed by the literal `2` — braces are what
 * `${12}` is for); and a `$` before anything else, or at the end of the string, is a literal `$`.
 */
export function tokensUsed(message: string): Token[] {
    const chars = Array.from(message);
    const out: Token[] = [];
    let i = 0;
    while (i < chars.length) {
        if (chars[i] !== '$') {
            i += 1;
            continue;
        }
        // `$$` -> a literal dollar, and the second `$` is consumed so `$$1` is `$1` (text).
        if (i + 1 < chars.length && chars[i + 1] === '$') {
            i += 2;
            continue;
        }
        if (i + 1 < chars.length && chars[i + 1] === '{') {
            const rel = chars.slice(i + 2).indexOf('}');
            if (rel !== -1) {
                const name = chars.slice(i + 2, i + 2 + rel).join('');
                if (name.length > 0) {
                    if (isAllDigits(name)) {
                        const n = Number(name);
                        out.push({ kind: 'group', n, text: `$${n}` });
                    } else {
                        out.push({ kind: 'named', name, text: `\${${name}}` });
                    }
                    i += 3 + rel;
                    continue;
                }
                // `${}` names nothing: literal text, same as `$x` below. Falls through rather
                // than consuming `{`/`}`, so both are re-scanned as their own literal characters.
            }
        }
        if (i + 1 < chars.length && /[0-9]/.test(chars[i + 1])) {
            // ONE digit. `$12` is group 1 then a literal `2`; `${12}` is group 12.
            const n = Number(chars[i + 1]);
            out.push({ kind: 'group', n, text: `$${n}` });
            i += 2;
            continue;
        }
        // A `$` before anything else (or at the end of the message) is a literal `$`.
        i += 1;
    }
    return out;
}
