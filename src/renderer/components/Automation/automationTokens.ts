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

interface ScanSegment {
    /** The literal text since the previous token (or the start of the message). */
    lit: string;
    /** `null` on the final segment, after the last token. */
    token: Token | null;
}

/**
 * Walk the message once, yielding `(literal, token)` segments — ported from `subst.rs`'s own
 * `scan`, for the same reason it exists there: **one scanner, two consumers.** `tokensUsed` (below)
 * and `previewSubstitute` both build on this, so they cannot recognise different grammars — the
 * failure mode this module's own header warns about, one level down. See that header for the full
 * grammar table (`$$` escaping, `$x` and a trailing `$` as literals, `${12}` vs `$12`).
 */
function scan(message: string): ScanSegment[] {
    const chars = Array.from(message);
    const out: ScanSegment[] = [];
    let lit = '';
    let i = 0;
    while (i < chars.length) {
        if (chars[i] !== '$') {
            lit += chars[i];
            i += 1;
            continue;
        }
        // `$$` -> a literal dollar, and the second `$` is consumed so `$$1` is `$1` (text).
        if (i + 1 < chars.length && chars[i + 1] === '$') {
            lit += '$';
            i += 2;
            continue;
        }
        if (i + 1 < chars.length && chars[i + 1] === '{') {
            const rel = chars.slice(i + 2).indexOf('}');
            if (rel !== -1) {
                const name = chars.slice(i + 2, i + 2 + rel).join('');
                if (name.length > 0) {
                    const token: Token = isAllDigits(name)
                        ? { kind: 'group', n: Number(name), text: `$${Number(name)}` }
                        : { kind: 'named', name, text: `\${${name}}` };
                    out.push({ lit, token });
                    lit = '';
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
            out.push({ lit, token: { kind: 'group', n, text: `$${n}` } });
            lit = '';
            i += 2;
            continue;
        }
        // A `$` before anything else (or at the end of the message) is a literal `$`.
        lit += '$';
        i += 1;
    }
    out.push({ lit, token: null });
    return out;
}

/**
 * Every token the message names, in order, without duplicates removed — the validation-facing
 * counterpart to `subst::tokens_used`.
 */
export function tokensUsed(message: string): Token[] {
    const out: Token[] = [];
    for (const seg of scan(message)) {
        if (seg.token) out.push(seg.token);
    }
    return out;
}

export type PreviewResult =
    | { ok: true; text: string }
    | { ok: false; badToken: string };

/**
 * The editor's live PREVIEW of what a send would type (mockup §04) — built on the SAME `scan`
 * `tokensUsed` uses, so it can never accept a token validation would still block, and it never
 * duplicates the grammar `automationValidation.ts` already checks against.
 *
 * **This is not `subst::substitute`, and it never reaches a pty.** Only the backend ever types a
 * message into a terminal (see this module's own header); this exists solely so the EDITOR can show
 * what that send would look like before the user saves, the same way `ParsePanel`'s worked example
 * shows a match before a dry run has ever been made.
 *
 * `groups` is `automationValidation.groupsOf`'s own return shape, and `sample` stands in for a real
 * capture: keyed the way `groups` reports them — a numbered group by its number as a string
 * (`'0'`, `'1'`, …), a named one by its name. A group the pattern DECLARES but `sample` has no
 * entry for resolves to an empty string, exactly like an optional group that did not match on this
 * particular line (mockup §05); a token the pattern does not declare at all is refused, exactly
 * like the real send — reported here as the first such token, in the message's own order.
 */
export function previewSubstitute(
    message: string,
    groups: { count: number; names: Set<string> },
    sample: Record<string, string>,
): PreviewResult {
    let out = '';
    for (const seg of scan(message)) {
        out += seg.lit;
        const { token } = seg;
        if (!token) continue;
        const inRange = token.kind === 'group' ? token.n <= groups.count : groups.names.has(token.name);
        if (!inRange) return { ok: false, badToken: token.text };
        const key = token.kind === 'group' ? String(token.n) : token.name;
        out += sample[key] ?? '';
    }
    return { ok: true, text: out };
}
