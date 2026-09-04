/**
 * The six built-in templates (mockup §02), frozen in the renderer — the `COLOR_SCHEMAS` precedent.
 *
 * **A template never reaches the engine until the user switches it on.** It lands as an unsaved
 * draft with `enabled: false`, and that — not validation — is the safety property: nothing a
 * template does can happen without one deliberate act.
 *
 * Every template ships `targetIds: []` and targets by **criterion**, which is a complete choice
 * rather than a gap: *Context handoff reminder* watches every terminal whose command contains
 * `claude`, exactly as mockup §04's first panel draws it. So a fresh template is **valid and
 * enableable straight away**, and what the user changes is the threshold or the message.
 *
 * *(This comment used to say a fresh template "always has exactly one problem left to fix", and so
 * did the gallery's own note and plan §10.19. It is not true of any of the six: only a **pinned**
 * rule can be empty in a way validation can see, and none of these are pinned. M5's own validation
 * test is what made the claim testable, and it failed on all six.)*
 *
 * They ship with the app and update with it. No import, no export, no sharing — each of those is a
 * file format and a trust boundary, and **Duplicate** already covers "start from one of mine".
 */
import type { AutomationRule } from '../../../types/electron';

/** Which of the four steps a template is really about — the gallery card's icon colour. */
export type TemplateAccent = 'monitor' | 'parse' | 'cond' | 'action';

export interface AutomationTemplate {
    id: string;
    title: string;
    accent: TemplateAccent;
    /** Why you would want this one, in the card's own voice. Editorial, so it is stored. */
    why: string;
    /**
     * The fields you will change, named up front so picking a card is a decision you can make from
     * the gallery without opening it first (mockup §02).
     */
    youllChange: string[];
    /** Everything the draft carries. The sentence on the card is DERIVED from this, never stored. */
    rule: TemplateRule;
}

/**
 * A template's rule, minus everything only a saved row has. `id`, `createdAt`, `updatedAt`,
 * `sortOrder` and `schemaVersion` belong to the store, and a template that carried them would be
 * claiming to be a row it is not.
 */
export type TemplateRule = Omit<
    AutomationRule,
    'id' | 'createdAt' | 'updatedAt' | 'sortOrder' | 'schemaVersion' | 'completedAt' | 'verboseUntil'
>;

/** The 30-second check the mockup's rows use wherever a template is time-based rather than output-based. */
const EVERY_30S = 30000;

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = Object.freeze([
    {
        id: 'ctx',
        title: 'Context handoff reminder',
        accent: 'monitor',
        why:
            'Nudges an agent to hand off before its context runs out. Fires once per crossing, so a '
            + 'long session gets one reminder, not forty.',
        youllChange: ['threshold', 'message'],
        rule: {
            name: 'Context handoff reminder',
            enabled: false,
            runsOnce: false,
            targetMode: 'rule',
            criterion: 'commandContains',
            criterionValue: 'claude',
            followNew: true,
            targetIds: [],
            graph: {
                monitor: { read: 'newOutput', cadence: 'timer', everyMs: EVERY_30S },
                parse: { preset: 'percentage', literal: null, find: 'ctx:(\\d+)%', keep: 'brackets' },
                cond: { kind: 'number', op: 'gt', threshold: 25 },
                action: {
                    message: 'prepare to do context-hand-off',
                    sendTo: 'matched',
                    submit: true,
                    cliType: 'default',
                },
            },
        },
    },
    {
        id: 'ratelimit',
        title: 'Rate-limit backoff',
        accent: 'cond',
        why:
            'Catches a provider throttling an agent mid-run and tells it to back off, instead of '
            + "leaving it to burn retries while you're in another tab.",
        youllChange: ['message'],
        rule: {
            name: 'Rate-limit backoff',
            enabled: false,
            runsOnce: false,
            targetMode: 'rule',
            criterion: 'commandContains',
            criterionValue: 'claude',
            followNew: true,
            targetIds: [],
            graph: {
                monitor: { read: 'newOutput', cadence: 'onOutput', everyMs: EVERY_30S },
                parse: {
                    preset: 'exactWords',
                    literal: '429 Too Many',
                    find: '429 Too Many',
                    keep: 'whole',
                },
                cond: { kind: 'text', op: null, threshold: null },
                action: {
                    message: '/wait 60',
                    sendTo: 'matched',
                    submit: true,
                    cliType: 'default',
                },
            },
        },
    },
    {
        id: 'build',
        title: 'Build failure nudge',
        accent: 'parse',
        why:
            'Fires the moment a suite goes red and stays quiet while it stays red. Change the '
            + 'pattern if your runner words it differently.',
        youllChange: ['pattern', 'message'],
        rule: {
            name: 'Build failure nudge',
            enabled: false,
            runsOnce: false,
            targetMode: 'rule',
            criterion: 'allTerminals',
            criterionValue: '',
            followNew: true,
            targetIds: [],
            graph: {
                monitor: { read: 'newOutput', cadence: 'onOutput', everyMs: EVERY_30S },
                parse: { preset: 'custom', literal: null, find: 'FAILED \\d+ test', keep: 'whole' },
                cond: { kind: 'text', op: null, threshold: null },
                action: {
                    message: 'read the failing step first',
                    sendTo: 'matched',
                    submit: true,
                    cliType: 'default',
                },
            },
        },
    },
    {
        id: 'prompt',
        title: 'Answer a confirmation — without sending it',
        accent: 'action',
        why:
            'Puts the answer on the prompt and stops. You still press Enter. The one template that '
            + 'deliberately does not complete its own action.',
        youllChange: ['question', 'answer'],
        rule: {
            name: 'Answer a confirmation',
            enabled: false,
            runsOnce: false,
            targetMode: 'rule',
            criterion: 'commandContains',
            criterionValue: 'claude',
            followNew: true,
            targetIds: [],
            graph: {
                monitor: { read: 'onScreen', cadence: 'onOutput', everyMs: EVERY_30S },
                // `literal` is what the user typed; `find` is that text regex-escaped. Re-opening
                // the rule shows the literal back, not `proceed\?`, which the user would then
                // helpfully "fix" (§6.4b).
                parse: {
                    preset: 'exactWords',
                    literal: 'Do you want to proceed?',
                    find: 'Do you want to proceed\\?',
                    keep: 'whole',
                },
                cond: { kind: 'text', op: null, threshold: null },
                action: {
                    message: '1',
                    sendTo: 'matched',
                    // The whole point of this template: the text lands in the composer unsubmitted.
                    submit: false,
                    cliType: 'default',
                },
            },
        },
    },
    {
        id: 'disk',
        title: 'Disk space guard',
        accent: 'cond',
        why:
            'Reads the number out of a status line you already print. Shows the falls-below '
            + 'direction, which re-arms on the way back up.',
        youllChange: ['threshold'],
        rule: {
            name: 'Disk space guard',
            enabled: false,
            runsOnce: false,
            targetMode: 'rule',
            criterion: 'allTerminals',
            criterionValue: '',
            followNew: true,
            targetIds: [],
            graph: {
                monitor: { read: 'newOutput', cadence: 'timer', everyMs: 300000 },
                parse: {
                    preset: 'number',
                    literal: null,
                    find: '(\\d+(?:\\.\\d+)?)G(?:i?B)? free',
                    keep: 'brackets',
                },
                cond: { kind: 'number', op: 'lt', threshold: 5 },
                action: { message: 'df -h', sendTo: 'matched', submit: true, cliType: 'default' },
            },
        },
    },
    {
        id: 'tokens',
        title: 'Token budget warning',
        accent: 'monitor',
        why:
            'The same shape as the context reminder, pointed at the other number agents print. A '
            + 'good one to duplicate per agent.',
        youllChange: ['threshold', 'message'],
        rule: {
            name: 'Token budget warning',
            enabled: false,
            runsOnce: false,
            targetMode: 'rule',
            criterion: 'commandContains',
            criterionValue: 'claude',
            followNew: true,
            targetIds: [],
            graph: {
                monitor: { read: 'newOutput', cadence: 'timer', everyMs: EVERY_30S },
                parse: {
                    preset: 'number',
                    literal: null,
                    find: '(\\d+)k tokens left',
                    keep: 'brackets',
                },
                cond: { kind: 'number', op: 'lt', threshold: 20 },
                action: { message: '/compact', sendTo: 'matched', submit: true, cliType: 'default' },
            },
        },
    },
]);

/**
 * A template as an unsaved draft.
 *
 * `id` is empty because a rule id is the store's to mint, and `sortOrder` is 0 because where a new
 * rule lands is the store's decision too — the renderer supplying either would be inventing a fact
 * about a row that does not exist yet. `targetIds` is empty **by construction**, not by omission:
 * every template returns a draft with exactly one problem left.
 */
export function draftFromTemplate(template: AutomationTemplate): AutomationRule {
    return {
        ...structuredCloneRule(template.rule),
        id: '',
        completedAt: null,
        verboseUntil: null,
        sortOrder: 0,
        schemaVersion: 1,
        createdAt: 0,
        updatedAt: 0,
    };
}

/**
 * A blank draft — the gallery's seventh card.
 *
 * Not a seventh template: it has no starter pattern, no message and no criterion, so the six-item
 * table above stays a table of *rules that already work*.
 */
export function blankDraft(): AutomationRule {
    return {
        id: '',
        name: 'Untitled automation',
        enabled: false,
        runsOnce: false,
        targetMode: 'rule',
        criterion: 'allTerminals',
        criterionValue: '',
        followNew: true,
        targetIds: [],
        completedAt: null,
        verboseUntil: null,
        sortOrder: 0,
        schemaVersion: 1,
        graph: {
            monitor: { read: 'newOutput', cadence: 'onOutput', everyMs: EVERY_30S },
            parse: { preset: 'custom', literal: null, find: '', keep: 'whole' },
            cond: { kind: 'text', op: null, threshold: null },
            action: { message: '', sendTo: 'matched', submit: true, cliType: 'default' },
        },
        createdAt: 0,
        updatedAt: 0,
    };
}

/**
 * A deep copy of the frozen template, so an editor that mutates its draft cannot reach back into
 * the module and change what every later user of that template gets. `structuredClone` is not
 * available in every environment this bundle runs in, and the shape is small and known.
 */
function structuredCloneRule(rule: TemplateRule): TemplateRule {
    return {
        ...rule,
        targetIds: [...rule.targetIds],
        graph: {
            monitor: { ...rule.graph.monitor },
            parse: { ...rule.graph.parse },
            cond: { ...rule.graph.cond },
            action: { ...rule.graph.action },
        },
    };
}
