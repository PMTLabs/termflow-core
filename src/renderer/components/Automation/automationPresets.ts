/**
 * The five presets, and the plain-words paraphrase (plan 028 §6.4b, mockup §04).
 *
 * R2 promises *"five presets mean a percentage rule needs no pattern typed at all, and the pattern
 * is paraphrased in plain words"*. Both halves live here, frozen the way `automationTemplates.ts` is
 * frozen: **the set, their order and the `keep` default are the approved spec; the starter patterns
 * are the plan's choice**, and they live in exactly one module so a second copy cannot appear beside
 * the panel that renders them.
 *
 * Three behaviours the presets carry, not just a string each:
 *
 * 1. **`Exact words` escapes.** The user types `Do you want to proceed?` and the stored pattern is
 *    `Do you want to proceed\?`. The draft keeps **both** — `parse.literal` (what was typed) and
 *    `parse.find` (what runs) — so re-opening the rule shows the literal, not the escaped form.
 *    Without that field the editor redisplays `\?` and the user "fixes" it.
 * 2. **The paraphrase is DERIVED, never stored**, so it cannot disagree with what will actually run.
 * 3. **Choosing a preset sets `keep`; editing the pattern by hand does not change the preset back.**
 *    The preset is a remembered starting point, not a mode that re-derives the pattern on every
 *    keystroke.
 */
import type {
    AutomationKeep,
    AutomationParsePreset,
    AutomationParseStep,
} from '../../types/electron';

export interface AutomationPreset {
    id: AutomationParsePreset;
    /** The token's own words, from the mockup. */
    label: string;
    /** What the field is filled with when this preset is chosen. `exactWords` builds its own. */
    find: string;
    keep: AutomationKeep;
    /** One line under the token row, explaining what it is for. */
    hint: string;
}

/**
 * Five, in the mockup's order. The order is part of the spec: *A percentage* is first because it is
 * the canonical rule's own shape, and *Write my own* is last because it is the escape hatch.
 */
export const AUTOMATION_PRESETS: readonly AutomationPreset[] = Object.freeze([
    {
        id: 'percentage',
        label: 'A percentage',
        find: '(\\d+)%',
        keep: 'brackets',
        hint: 'Any number followed by a per-cent sign, like the context meter.',
    },
    {
        id: 'number',
        label: 'Any number',
        find: '(\\d+(?:\\.\\d+)?)',
        keep: 'brackets',
        hint: 'A whole number or a decimal, wherever it appears in the line.',
    },
    {
        id: 'errorCode',
        label: 'An error code',
        find: '\\b([45]\\d\\d)\\b',
        keep: 'brackets',
        hint: 'A three-digit 4xx or 5xx status, on its own rather than inside a longer number.',
    },
    {
        id: 'exactWords',
        label: 'Exact words',
        // Filled from what the user types, escaped. The empty starter is what an untouched
        // `Exact words` preset holds, and validation reports it like any other empty pattern.
        find: '',
        keep: 'whole',
        hint: 'Type the words exactly as they appear. Punctuation is handled for you.',
    },
    {
        id: 'custom',
        label: 'Write my own',
        find: '',
        keep: 'whole',
        hint: 'A regular expression, if you already know what you want.',
    },
]);

export function presetById(id: AutomationParsePreset): AutomationPreset {
    return AUTOMATION_PRESETS.find((p) => p.id === id) ?? AUTOMATION_PRESETS[4];
}

/**
 * Turn typed text into a pattern that matches exactly that text.
 *
 * The escaped set is the JS one, which is a **subset** of what Rust's `regex` accepts as an escape,
 * so the result compiles in both engines. That direction matters: this string is written to the
 * store and run by Rust, and previewed here.
 */
export function escapeLiteral(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply a preset to a parse step.
 *
 * `exactWords` keeps whatever literal the step already carried, so switching away to *Write my own*
 * and back does not lose what the user typed. Every other preset clears `literal`, because a
 * literal that outlived its preset would come back the next time `exactWords` was chosen and quietly
 * replace a pattern the user had since written by hand.
 */
export function applyPreset(
    parse: AutomationParseStep,
    id: AutomationParsePreset,
): AutomationParseStep {
    const preset = presetById(id);
    if (id === 'exactWords') {
        const literal = parse.literal ?? '';
        return { preset: id, literal, find: escapeLiteral(literal), keep: preset.keep };
    }
    return { preset: id, literal: null, find: preset.find, keep: preset.keep };
}

/** The user typing into the *Exact words* field: the literal is the truth, the pattern follows. */
export function setLiteral(parse: AutomationParseStep, literal: string): AutomationParseStep {
    return { ...parse, literal, find: escapeLiteral(literal) };
}

/**
 * The user typing into the pattern field directly.
 *
 * The preset is **not** reset — §6.4b — but `literal` is dropped, because the two would then
 * disagree about what the rule looks for and the editor shows the literal.
 */
export function setFind(parse: AutomationParseStep, find: string): AutomationParseStep {
    return { ...parse, find, literal: null };
}

/** What the parse field displays: the literal when there is one, else the pattern itself. */
export function displayedPattern(parse: AutomationParseStep): string {
    return parse.preset === 'exactWords' && parse.literal !== null && parse.literal !== undefined
        ? parse.literal
        : parse.find;
}

// =================================================================================================
// The plain-words paraphrase
// =================================================================================================

export type SayingSegment =
    | { t: 'text'; text: string }
    | { t: 'code'; text: string };

export interface PatternSaying {
    /** *find `ctx:` followed by a number and a `%` — and keep the number*, ready to render. */
    words: SayingSegment[];
    /**
     * A line this pattern actually matches, or `null`.
     *
     * **Built from the same tokens and then checked against the real pattern**, so it is either a
     * true example or absent. An example that does not match is worse than none: it teaches the user
     * a shape their rule will not find.
     */
    example: string | null;
}

/** One recognised piece of a pattern. Anything not on this list makes the whole paraphrase bail. */
type Tok =
    | { t: 'lit'; text: string; sample: string }
    | { t: 'num'; sample: string }
    | { t: 'word'; sample: string }
    | { t: 'space'; sample: string }
    | { t: 'any'; sample: string }
    /** `name` is the group's own, when it has one — the engine prefers a group called `value`. */
    | { t: 'open'; name: string | null }
    | { t: 'close' };

/** A token that carries text — everything except the bracket markers. */
type FlatTok = Extract<Tok, { sample: string }>;

/** Digits and simple digit ranges — `[45]`, `[0-9]`. Anything else is not a "number" we can word. */
function digitClass(body: string): string | null {
    if (body.length === 0) return null;
    let i = 0;
    let first: string | null = null;
    while (i < body.length) {
        const a = body[i];
        if (body[i + 1] === '-' && i + 2 < body.length) {
            const b = body[i + 2];
            if (a < '0' || a > '9' || b < '0' || b > '9') return null;
            first = first ?? a;
            i += 3;
            continue;
        }
        if (a < '0' || a > '9') return null;
        first = first ?? a;
        i += 1;
    }
    return first;
}

/**
 * Split a pattern into the small vocabulary above, or `null` when it uses anything else.
 *
 * The bail is the whole design. This is a *best-effort renderer of the common shapes*, not a regex
 * parser, and the shapes it does not know — alternation, anchors, repetition counts, lookaround,
 * optional literals — are exactly the ones a wrong paraphrase would misdescribe. `sayPattern`
 * returns null and the panel shows the raw pattern, which is honest.
 */
function tokenize(find: string): Tok[] | null {
    const out: Tok[] = [];
    let i = 0;

    /**
     * A `+` immediately after the current atom, consumed and reported.
     *
     * **`*` is not one of them, and the caller bails on it.** It used to be treated as identical to
     * `+`, so `ctx:\s*(\d+)%` — which matches `ctx:50%` perfectly well — was paraphrased as *"find
     * `ctx:` followed by a space followed by a number"*, telling the user a space is REQUIRED. A
     * zero-or-more atom is not a thing this vocabulary can word, and `)` already bails on `*` for
     * the same reason one atom further out.
     */
    const takesMany = (): boolean => {
        if (find[i] === '+') {
            i += 1;
            return true;
        }
        return false;
    };

    /** `*` after an atom this function just emitted — the whole paraphrase gives up. */
    const optional = (): boolean => find[i] === '*';

    while (i < find.length) {
        const c = find[i];

        if (c === '\\') {
            const next = find[i + 1];
            if (next === undefined) return null;
            i += 2;
            // A word boundary at the pattern's EDGE — `\b([45]\d\d)\b`, the *HTTP error code*
            // preset — is decoration on "the whole match stands alone", and is dropped rather than
            // worded, exactly as the optional decimal tail of *Any number* is. In the MIDDLE it
            // constrains something the words do not mention, and `\B` inverts even that: `\B(\d+)`
            // read *"find a number"*, which is the one reading it rules out.
            if (next === 'b') {
                if (i === 2 || i === find.length) continue;
                return null;
            }
            if (next === 'B') return null;
            if (next === 'd') {
                if (optional()) return null;
                out.push({ t: 'num', sample: takesMany() ? '63' : '7' });
                continue;
            }
            if (next === 'w') {
                if (optional()) return null;
                out.push({ t: 'word', sample: takesMany() ? 'abc' : 'a' });
                continue;
            }
            if (next === 's') {
                if (optional()) return null;
                takesMany();
                out.push({ t: 'space', sample: ' ' });
                continue;
            }
            if (/[.*+?^${}()|[\]\\/-]/.test(next)) {
                if (find[i] === '?' || find[i] === '+' || find[i] === '*') return null;
                // Merged into the run before it, exactly as a plain character is. An escaped
                // literal that started its own token split `Do you want to proceed\?` into two
                // parts, and the paraphrase read "find `Do you want to proceed` and a `?`" — the
                // single-literal phrasing (*"find the words …"*) never fired for the one preset
                // whose whole purpose is literal words.
                const run = out[out.length - 1];
                if (run && run.t === 'lit') {
                    run.text += next;
                    run.sample += next;
                } else {
                    out.push({ t: 'lit', text: next, sample: next });
                }
                continue;
            }
            return null;
        }

        if (c === '(') {
            if (find.startsWith('(?:', i)) {
                const end = matchingParen(find, i);
                if (end < 0) return null;
                // An OPTIONAL non-capturing group is only understood when it is decoration on a
                // number — `(?:\.\d+)?`, the decimal tail of *Any number*. "A number" already covers
                // 63 and 63.5, so it is dropped rather than worded. Everything else bails.
                if (find[end + 1] !== '?') return null;
                const inner = tokenize(find.slice(i + 3, end));
                if (!inner || !inner.every((t) => t.t === 'num' || (t.t === 'lit' && /^[.,]$/.test(t.text)))) {
                    return null;
                }
                i = end + 2;
                continue;
            }
            const named = /^\(\?<([A-Za-z][A-Za-z0-9]*)>/.exec(find.slice(i));
            i += named ? named[0].length : 1;
            // The NAME is kept, because the engine keeps the group called `value` in preference to
            // the first one, and a paraphrase that cannot tell them apart says the wrong thing
            // about which value gets compared.
            out.push({ t: 'open', name: named ? named[1] : null });
            continue;
        }

        if (c === ')') {
            i += 1;
            if (find[i] === '?' || find[i] === '+' || find[i] === '*') return null;
            out.push({ t: 'close' });
            continue;
        }

        if (c === '[') {
            const end = find.indexOf(']', i + 1);
            if (end < 0) return null;
            const sample = digitClass(find.slice(i + 1, end));
            if (sample === null) return null;
            i = end + 1;
            if (optional()) return null;
            out.push({ t: 'num', sample: takesMany() ? `${sample}3` : sample });
            continue;
        }

        if (c === '.') {
            i += 1;
            if (optional()) return null;
            out.push({ t: 'any', sample: takesMany() ? 'something' : 'x' });
            continue;
        }

        // Anchors, alternation and repetition counts have no plain-words rendering that is short
        // enough to be worth trusting.
        if (c === '|' || c === '^' || c === '$' || c === '{' || c === '?' || c === '+' || c === '*') {
            return null;
        }

        i += 1;
        const last = out[out.length - 1];
        if (find[i] === '?' || find[i] === '+' || find[i] === '*') return null;
        if (last && last.t === 'lit') {
            last.text += c;
            last.sample += c;
        } else {
            out.push({ t: 'lit', text: c, sample: c });
        }
    }
    return splitEdgeSpace(out);
}

/**
 * Whitespace at the EDGE of a literal run becomes its own word; whitespace inside one stays put.
 *
 * `sayToken` used to `.trim()` the run instead, and a deleted space is a deleted requirement:
 * `ctx: (\d+)%` and `ctx:(\d+)%` rendered the identical sentence, so a user reading it would expect
 * `ctx:63%` to match the rule that needs `ctx: 63%`. Saying *"followed by"* does not answer the
 * question either — it is silent about whether a space belongs between the two.
 *
 * The split is only at the edges because interior whitespace is part of a phrase: `k tokens left` is
 * three words the user typed, and *"`k` followed by a space followed by `tokens`"* describes the
 * same thing far worse. A run that is ALL whitespace becomes one space token, which is also what
 * stops `sayToken` ever needing to decline.
 */
function splitEdgeSpace(toks: Tok[]): Tok[] {
    const out: Tok[] = [];
    for (const tok of toks) {
        if (tok.t !== 'lit') {
            out.push(tok);
            continue;
        }
        const lead = /^\s*/.exec(tok.text)?.[0] ?? '';
        const core = tok.text.slice(lead.length).replace(/\s*$/, '');
        const tail = tok.text.slice(lead.length + core.length);
        if (lead) out.push({ t: 'space', sample: lead });
        if (core) out.push({ t: 'lit', text: core, sample: core });
        if (tail) out.push({ t: 'space', sample: tail });
    }
    return out;
}

function matchingParen(s: string, open: number): number {
    let depth = 0;
    for (let i = open; i < s.length; i += 1) {
        if (s[i] === '\\') {
            i += 1;
            continue;
        }
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * `a number` / `` `ctx:` `` — one token's words. Adjacent numbers have already been merged.
 *
 * **Total over the tokens a paraphrase can contain**, which is what killed *"find the words a
 * number"*: it used to return `null` for a whitespace-only literal and the caller skipped those
 * silently, so the flat token list and the worded list could end up different lengths — and the
 * "one literal, say *the words*" branch then tested the wrong array's first element. A function
 * that cannot decline cannot desynchronise them.
 */
function sayToken(tok: FlatTok): SayingSegment[] {
    switch (tok.t) {
        case 'num':
            return [{ t: 'text', text: 'a number' }];
        case 'word':
            return [{ t: 'text', text: 'a word' }];
        case 'space':
            return [{ t: 'text', text: tok.sample.length > 1 ? 'spaces' : 'a space' }];
        case 'any':
            return [{ t: 'text', text: 'anything' }];
        case 'lit':
        default:
            return tok.text.length === 1 && !/[A-Za-z0-9]/.test(tok.text)
                ? [{ t: 'text', text: 'a ' }, { t: 'code', text: tok.text }]
                : [{ t: 'code', text: tok.text }];
    }
}

/**
 * *"find `ctx:` followed by a number and a `%` — and keep the number"*, derived from the pattern.
 *
 * Returns `null` for anything the vocabulary above does not cover; the panel then shows the raw
 * pattern, which §6.4b explicitly allows. A best-effort paraphrase that guesses is worse than no
 * paraphrase, because a user who believes it stops reading the pattern.
 */
export function sayPattern(find: string, keep: AutomationKeep): PatternSaying | null {
    if (find.trim().length === 0) return null;
    let re: RegExp;
    try {
        re = new RegExp(find);
    } catch {
        return null;
    }

    const toks = tokenize(find);
    if (!toks) return null;

    // What each bracketed group contains, so the keep clause can name the value the ENGINE takes.
    //
    // `eval.rs`: `caps.name("value").or_else(|| caps.get(1))` — the group called `value`, else group
    // ONE. This used to be a single flag set by any digit inside ANY group, so `(\w+):(\d+)` was
    // paraphrased *"and keep the number"* directly under the same panel's `parse.manyGroups`
    // warning — *"This pattern has more than one bracketed group. The first one is used"* — while
    // the first one is the word. Two surfaces, one rule, contradictory, eight pixels apart: the
    // failure `automationDerive` exists to prevent, at the one displayed string that does not go
    // through `stepValues`.
    const inside: FlatTok[][] = [];
    const names: (string | null)[] = [];
    const stack: number[] = [];
    const flat: FlatTok[] = [];
    for (const tok of toks) {
        if (tok.t === 'open') {
            names.push(tok.name);
            inside.push([]);
            stack.push(inside.length - 1);
            continue;
        }
        if (tok.t === 'close') {
            stack.pop();
            continue;
        }
        for (const g of stack) inside[g].push(tok);
        const last = flat[flat.length - 1];
        // `[45]\d\d` is three tokens and one idea.
        if (last && last.t === 'num' && tok.t === 'num') {
            last.sample += tok.sample;
            continue;
        }
        flat.push(tok);
    }

    const named = names.indexOf('value');
    const keptGroup = named >= 0 ? named : 0;
    const kept = inside[keptGroup] ?? [];
    // ONLY a group that is entirely digits is "the number". `(\d+px)` captures `63px`, which is not
    // a number and does not coerce to one; `(\w+)` captures a word; `(\s)` captures a space.
    const capturedIsNumber = kept.length > 0 && kept.every((t) => t.t === 'num');
    const sawCapture = inside.length > 0;

    const parts: SayingSegment[][] = flat.map(sayToken);
    if (parts.length === 0) return null;

    const words: SayingSegment[] = [{ t: 'text', text: 'find ' }];
    if (flat.length === 1 && flat[0].t === 'lit') {
        words.push({ t: 'text', text: 'the words ' }, ...parts[0]);
    } else {
        parts.forEach((part, index) => {
            if (index > 0) {
                words.push({ t: 'text', text: index === parts.length - 1 ? ' and ' : ' followed by ' });
            }
            words.push(...part);
        });
    }

    if (keep === 'brackets' && sawCapture) {
        words.push({
            t: 'text',
            text: capturedIsNumber ? ' — and keep the number' : ' — and keep the part in brackets',
        });
    } else if (keep === 'whole' && parts.length > 1) {
        words.push({ t: 'text', text: ' — and keep the whole match' });
    }

    const example = flat.map((t) => t.sample).join('');
    // Both halves of this guard are currently UNREACHABLE, and that is worth writing down because a
    // mutation sweep keeps reporting `re.test(example)` as a survivor. Every construct that could
    // make the concatenated sample miss its own pattern — a counted quantifier, an anchor,
    // alternation, a lookaround, a backreference — makes the tokenizer bail and this function return
    // null well before here; and a pattern with no tokens returns null at `parts.length === 0`
    // above. Probed over 36 patterns. So removing either half is an EQUIVALENT mutant, not a gap.
    //
    // It stays because it is the invariant, not the implementation: a tokenizer that later learns
    // `{n}` or `|` without teaching `sample` to satisfy them would start offering examples the rule
    // can never find, and an example that does not match is worse than none. Pinned as a property
    // over the whole supported grammar by *"never offers an example that its own pattern would not
    // find"*.
    return { words, example: example.length > 0 && re.test(example) ? example : null };
}

/** The paraphrase as one flat string — for a `title`, and for tests that do not care about markup. */
export function sayingText(saying: PatternSaying): string {
    return saying.words.map((s) => (s.t === 'code' ? `\`${s.text}\`` : s.text)).join('');
}
