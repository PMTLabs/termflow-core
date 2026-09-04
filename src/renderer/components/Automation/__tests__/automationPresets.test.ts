/**
 * §10.26b — the five presets and the derived paraphrase.
 *
 * Every starter pattern is asserted to compile under `RegExp` **and** to appear in the shared
 * validation fixture, so the Rust `regex` build is proved too: a preset that only the browser can
 * compile would fill the field with a pattern the engine refuses at load.
 */
import fixture from '../__fixtures__/automationValidationCases.json';
import {
    AUTOMATION_PRESETS,
    applyPreset,
    displayedPattern,
    escapeLiteral,
    presetById,
    sayPattern,
    sayingText,
    setFind,
    setLiteral,
} from '../automationPresets';
import { problems } from '../automationValidation';
import type { AutomationParseStep, AutomationRule } from '../../../types/electron';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';

const cases = (fixture as unknown as { cases: Array<{ rule: AutomationRule }> }).cases;

const parse = (over: Partial<AutomationParseStep> = {}): AutomationParseStep => ({
    preset: 'custom',
    literal: null,
    find: '',
    keep: 'whole',
    ...over,
});

describe('the five presets', () => {
    it('are exactly five, in the mockup order', () => {
        expect(AUTOMATION_PRESETS.map((p) => p.label)).toEqual([
            'A percentage',
            'Any number',
            'An error code',
            'Exact words',
            'Write my own',
        ]);
    });

    it('each compile under RegExp', () => {
        for (const preset of AUTOMATION_PRESETS) {
            if (preset.find.length === 0) continue;
            expect(() => new RegExp(preset.find)).not.toThrow();
        }
    });

    it("each of the three starter patterns matches what it claims to be about", () => {
        // Compiling is not the same as working. A preset that compiles and matches nothing is a
        // field the user fills in and a rule that never fires.
        expect(new RegExp(presetById('percentage').find).exec('ctx:63%')?.[1]).toBe('63');
        expect(new RegExp(presetById('number').find).exec('4.25 GB free')?.[1]).toBe('4.25');
        expect(new RegExp(presetById('errorCode').find).exec('HTTP 429 received')?.[1]).toBe('429');
        // And the error code is anchored on word boundaries, so it does not find three digits
        // inside a longer number.
        expect(new RegExp(presetById('errorCode').find).test('id 14290')).toBe(false);
    });

    it('appear in the SHARED fixture, so the Rust regex build is proved too', () => {
        // JS regex syntax is a superset of Rust's. A preset only this side can compile would fill
        // the field with a pattern `reload` refuses — a rule that saves, enables, and never runs.
        const inFixture = new Set(cases.map((c) => c.rule.graph.parse.find));
        for (const preset of AUTOMATION_PRESETS) {
            if (preset.find.length === 0) continue;
            expect([...inFixture]).toContain(preset.find);
        }
    });

    it('set `keep` when chosen', () => {
        expect(applyPreset(parse({ keep: 'whole' }), 'percentage').keep).toBe('brackets');
        expect(applyPreset(parse({ keep: 'brackets' }), 'custom').keep).toBe('whole');
    });

    it('are NOT reset by hand-editing the pattern', () => {
        // §6.4b: the preset is a remembered starting point, not a mode that re-derives the pattern
        // on every keystroke. Resetting it to `custom` here would make the token row jump under the
        // user's hands the first time they adjusted a starter.
        const chosen = applyPreset(parse(), 'percentage');
        const edited = setFind(chosen, 'ctx:(\\d+)% left');
        expect(edited.preset).toBe('percentage');
        expect(edited.find).toBe('ctx:(\\d+)% left');
        expect(edited.literal).toBeNull();
    });
});

describe('Exact words', () => {
    it('escapes what the user typed', () => {
        expect(escapeLiteral('Do you want to proceed?')).toBe('Do you want to proceed\\?');
        expect(escapeLiteral('cost: $5 (approx.)')).toBe('cost: \\$5 \\(approx\\.\\)');
    });

    it('produces a pattern that matches the literal it came from', () => {
        for (const text of ['Do you want to proceed?', '429 Too Many', 'a+b', '[warn] x*']) {
            expect(new RegExp(escapeLiteral(text)).test(text)).toBe(true);
        }
    });

    it('shows the LITERAL back, not the escaped form', () => {
        // Without this the editor redisplays `proceed\?` and the user helpfully "fixes" it.
        const typed = setLiteral(applyPreset(parse(), 'exactWords'), 'Do you want to proceed?');
        expect(typed.find).toBe('Do you want to proceed\\?');
        expect(displayedPattern(typed)).toBe('Do you want to proceed?');
        // And the template that ships this exact pair round-trips the same way.
        const template = AUTOMATION_TEMPLATES.find((t) => t.id === 'prompt')!;
        expect(displayedPattern(draftFromTemplate(template).graph.parse))
            .toBe('Do you want to proceed?');
    });

    it('keeps the literal across a trip through another preset and back', () => {
        const typed = setLiteral(applyPreset(parse(), 'exactWords'), 'Do you want to proceed?');
        const away = applyPreset(typed, 'percentage');
        expect(away.literal).toBeNull();
        // Coming back re-escapes from whatever literal the step now holds — which is none, so the
        // field is empty rather than carrying a stale phrase the user has since replaced.
        expect(applyPreset(away, 'exactWords').find).toBe('');
    });

    it('an untouched Exact words preset reports the ordinary empty-pattern problem', () => {
        const rule = { ...cases[0].rule };
        const empty: AutomationRule = {
            ...rule,
            graph: { ...rule.graph, parse: applyPreset(parse(), 'exactWords') },
        };
        expect(problems(empty).map((p) => p.code)).toContain('parse.empty');
    });
});

describe('sayPattern — the plain-words paraphrase', () => {
    const say = (find: string, keep: 'brackets' | 'whole' = 'brackets') => {
        const result = sayPattern(find, keep);
        return result ? sayingText(result) : null;
    };

    it("produces the mockup's own sentence", () => {
        expect(say('ctx:(\\d+)%')).toBe('find `ctx:` followed by a number and a `%` — and keep the number');
    });

    it('handles each preset and each template pattern, or bails honestly', () => {
        // "Best-effort renderer of the common shapes ... falls back to showing the raw pattern."
        // The fallback is a design decision, so it is asserted rather than tolerated: a paraphrase
        // that guessed would be worse than none, because a user who believes it stops reading the
        // pattern.
        expect(say(presetById('percentage').find)).toBe('find a number and a `%` — and keep the number');
        expect(say(presetById('number').find)).toBe('find a number — and keep the number');
        expect(say(presetById('errorCode').find)).toBe('find a number — and keep the number');
        expect(say('(\\d+)k tokens left')).toBe('find a number and `k tokens left` — and keep the number');
        // The two spaces are WORDS now, not silently trimmed: `FAILED \d+ test` really does need
        // them, and this sentence used to read as though `FAILED12test` would match.
        expect(say('FAILED \\d+ test', 'whole')).toBe('find `FAILED` followed by a space followed by a number followed by a space and `test` — and keep the whole match');
        expect(say('Do you want to proceed\\?', 'whole')).toBe('find the words `Do you want to proceed?`');

        // The disk template uses an optional group this vocabulary does not cover.
        expect(say('(\\d+(?:\\.\\d+)?)G(?:i?B)? free')).toBeNull();
    });

    /**
     * **The paraphrase must name the value the ENGINE keeps.**
     *
     * `eval.rs`: `caps.name("value").or_else(|| caps.get(1))` — the group called `value`, else group
     * ONE. The flag was set by any digit inside ANY group, so the first row below said *"keep the
     * number"* directly under the same panel's `parse.manyGroups` warning: *"This pattern has more
     * than one bracketed group. The first one is used."* Two surfaces, one rule, contradictory,
     * eight pixels apart.
     */
    it('says which value is kept by asking the group the engine would take', () => {
        // Group 1 is the WORD. Not "the number", whatever else is in brackets.
        expect(say('(\\w+):(\\d+)')).toBe('find a word followed by a `:` and a number — and keep the part in brackets');
        // A named `value` group beats group 1 — and here it is a word, so still not "the number".
        expect(say('(\\d+):(?<value>\\w+)')).toBe('find a number followed by a `:` and a word — and keep the part in brackets');
        // …and when the named group IS the number, it says so even though group 1 is not.
        expect(say('(\\w+):(?<value>\\d+)')).toBe('find a word followed by a `:` and a number — and keep the number');
        // `63px` is not a number and does not coerce to one.
        expect(say('(\\d+px)')).toBe('find a number and `px` — and keep the part in brackets');
        expect(say('(\\s)(\\d+)')).toBe('find a space and a number — and keep the part in brackets');
    });

    /**
     * `*` is zero-or-more, and there is no wording for it in this vocabulary that a user could act
     * on. It used to be consumed by the same branch as `+`, so `ctx:\s*(\d+)%` — which matches
     * `ctx:50%` perfectly well — announced that a space is required.
     */
    it('bails on a zero-or-more atom rather than describing it as required', () => {
        for (const find of ['ctx:\\s*(\\d+)%', 'ctx:(\\d*)%', '(\\w*)', '.*x', '[0-9]*']) {
            expect(sayPattern(find, 'brackets')).toBeNull();
        }
        // The paired positive: `+` is one-or-more and stays wordable.
        expect(say('ctx:\\s+(\\d+)%')).toBe('find `ctx:` followed by a space followed by a number and a `%` — and keep the number');
    });

    /**
     * A word boundary at the pattern's edge is decoration on "the whole match stands alone" and is
     * dropped, exactly as the optional decimal tail of *Any number* is. In the middle it constrains
     * something the words never mention, and `\B` inverts even that.
     */
    it('drops an edge word boundary and bails on one that carries meaning', () => {
        expect(say('\\b([45]\\d\\d)\\b')).toBe('find a number — and keep the number');
        expect(sayPattern('\\B(\\d+)', 'brackets')).toBeNull();
        expect(sayPattern('a\\bb', 'whole')).toBeNull();
    });

    /**
     * Edge whitespace is a word, not something to trim away.
     *
     * These two patterns match different text. Trimming the literal made them render one sentence —
     * and the one it rendered was the sentence for the pattern WITHOUT the space.
     */
    it('tells two patterns apart when the only difference is a space', () => {
        expect(say('ctx: (\\d+)%')).not.toBe(say('ctx:(\\d+)%'));
        expect(say('ctx: (\\d+)%')).toBe('find `ctx:` followed by a space followed by a number and a `%` — and keep the number');
        // And a run that is nothing but whitespace is still a word rather than a silent skip: this
        // used to read "find the words a number", because the skipped token left the flat list and
        // the worded list at different lengths and the "one literal" branch tested the wrong one.
        expect(say(' (\\d+)')).toBe('find a space and a number — and keep the number');
        expect(say('  ERROR', 'whole')).toBe('find spaces and `ERROR` — and keep the whole match');
    });

    it('bails on every construct it cannot word', () => {
        for (const find of ['^ctx', 'ctx$', 'a|b', 'a{2,3}', '(?=x)y', 'ab?']) {
            expect(sayPattern(find, 'whole')).toBeNull();
        }
    });

    it('bails on an empty or uncompilable pattern rather than describing nothing', () => {
        expect(sayPattern('', 'whole')).toBeNull();
        expect(sayPattern('   ', 'whole')).toBeNull();
        expect(sayPattern('ctx:(\\d+%', 'brackets')).toBeNull();
    });

    it('offers an example ONLY when the pattern actually matches it', () => {
        // The example is built from the same tokens and then checked against the real pattern, so
        // it is either true or absent. An example that does not match teaches a shape the rule will
        // never find.
        for (const find of ['ctx:(\\d+)%', '(\\d+)%', '\\b([45]\\d\\d)\\b', 'FAILED \\d+ test']) {
            const said = sayPattern(find, 'brackets');
            expect(said).not.toBeNull();
            expect(said!.example).not.toBeNull();
            expect(new RegExp(find).test(said!.example!)).toBe(true);
        }
    });

    /**
     * The invariant behind that guard, over the whole supported grammar rather than four patterns.
     *
     * A mutation sweep flagged `re.test(example)` as a survivor, and the obvious reading — "add the
     * paired negative, a pattern whose example does NOT match" — turns out to be impossible: 36
     * patterns were probed across counted quantifiers, anchors, alternation, lookarounds,
     * backreferences, non-capturing and nested groups, and every construct that could make the
     * concatenated sample miss makes `sayPattern` return null for the WHOLE saying first. So the
     * guard is unreachable today and the mutant is EQUIVALENT, not surviving.
     *
     * It is still worth keeping, and worth pinning like this: it is the thing that would catch a
     * later tokenizer that learns `{n}` or `|` and starts synthesising samples that do not satisfy
     * their own pattern. This asserts the property rather than a mutant — whenever an example is
     * offered, it matches — so extending the grammar without extending `sample` fails here.
     */
    it('never offers an example that its own pattern would not find, across the grammar', () => {
        const grammar = [
            'ctx:(\\d+)%', '(\\d+)%', '\\b([45]\\d\\d)\\b', 'FAILED \\d+ test',
            '(\\d+)k tokens left', '(\\d+) (\\d+)', '\\d+x\\d+', '[45]\\d\\d error',
            '\\w+@\\w+', '\\d+%', '\\bctx\\b', '((\\d+))', 'a.b', 'a.+b', '\\.\\d+',
            '\\d+\\s+\\d+', '[45]', '[0-9]+', '(\\d+)\\)', '\\(\\d+\\)', '\\d+ \\d+ \\d+',
            '\\w\\w\\w', '\\s\\d+',
        ];
        const offered: string[] = [];
        for (const find of grammar) {
            const said = sayPattern(find, 'brackets');
            if (said === null || said.example === null) continue;
            offered.push(find);
            expect(new RegExp(find).test(said.example)).toBe(true);
        }
        // A vacuous pass is the failure mode here — if the grammar stopped producing examples this
        // would still be "green" without having checked anything.
        expect(offered.length).toBe(grammar.length);
    });

    it('marks the pattern text as code, not as prose', () => {
        // The panel renders these as <code>. A flat string would have to be re-split by the
        // component, and whatever a component has to re-derive it will eventually re-derive
        // differently.
        const said = sayPattern('ctx:(\\d+)%', 'brackets')!;
        expect(said.words.filter((w) => w.t === 'code').map((w) => w.text)).toEqual(['ctx:', '%']);
    });
});
