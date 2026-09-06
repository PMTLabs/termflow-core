/**
 * The `$0` / `$1` / `${name}` / `$$` grammar, scanned for validation and preview rendering — ported from the ONE scanner
 * `src-tauri/src/automation_engine/subst.rs` owns for the Rust side (`scan`, read that module's
 * doc first for the full grammar table: `$$` escaping, `$x` and a trailing `$` as literals,
 * `${12}` vs `$12`).
 *
 * **Why a second scanner exists at all, and why it must not drift from the first.** The renderer
 * has no send-side `substitute` — only the backend ever types a message into a pty — but its
 * preview resolves the same tokens a user is about to send. `automationValidation.ts`
 * uses this to decide whether a message can be SAVED, and `subst::substitute` is what decides
 * whether it can be SENT; if the two scanners ever recognised a different grammar, a message could
 * pass validation here and still be refused at send time — the exact failure `two-implementations-
 * one-fix` warns about, just one module over. `automationTokenCases.json` is read by this side and
 * by `subst.rs`, so an edit to either scanner has one grammar table to disagree with on both
 * recognised tokens and rendered output.
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

export type PreviewPart =
    | { kind: 'text'; text: string }
    /**
     * A token the pattern declares, and that is in range, but this call has NO sample value to
     * show for it — as opposed to a declared group that legitimately did not participate in a
     * real match, which resolves to an empty `text` part, not this. Only appears when `sample`
     * itself is `null`; see `previewSubstitute`'s own doc.
     */
    | { kind: 'placeholder'; token: string };

export type PreviewResult =
    | { ok: true; parts: PreviewPart[] }
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
 * `groups` is `automationValidation.groupsOf`'s own return shape. `sample` stands in for a real
 * capture, keyed the way `groups` reports them — a numbered group by its number as a string
 * (`'0'`, `'1'`, …), a named one by its name — and its two possible shapes are two different
 * facts, which plan 032 §4.4 tells apart and this function must not collapse into one:
 *
 * - **`sample` is an object** (even `{}`): a REAL match happened. A group the pattern DECLARES
 *   but the object has no entry for resolves to an empty `text` part, exactly like an optional
 *   group that legitimately did not participate on this particular line.
 * - **`sample` is `null`**: there is no match to read AT ALL (`ActionPanel.sampleFromPattern`
 *   could not derive a worked example for this pattern). Every in-range token then becomes a
 *   `{ kind: 'placeholder' }` part instead of resolving to a value, so the caller can render an
 *   honest "no example yet" marker. Collapsing this into `sample[key] ?? ''` — this function's
 *   own bug before this fix — renders "I have no sample value" identically to "the pattern
 *   declares this group but it did not participate", which is true only for a real match.
 *
 * A token the pattern does not declare at all is refused, exactly like the real send — reported
 * here as the first such token, in the message's own order.
 */
export function previewSubstitute(
    message: string,
    groups: { count: number; names: Set<string> },
    sample: Record<string, string> | null,
): PreviewResult {
    const parts: PreviewPart[] = [];
    let text = '';
    const flushText = () => {
        if (text.length > 0) {
            parts.push({ kind: 'text', text });
            text = '';
        }
    };
    for (const seg of scan(message)) {
        text += seg.lit;
        const { token } = seg;
        if (!token) continue;
        const inRange = token.kind === 'group' ? token.n <= groups.count : groups.names.has(token.name);
        if (!inRange) return { ok: false, badToken: token.text };
        if (sample === null) {
            flushText();
            parts.push({ kind: 'placeholder', token: token.text });
            continue;
        }
        const key = token.kind === 'group' ? String(token.n) : token.name;
        text += sample[key] ?? '';
    }
    flushText();
    if (parts.length === 0) parts.push({ kind: 'text', text: '' });
    return { ok: true, parts };
}
