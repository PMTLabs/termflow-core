import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { callArguments, closeOf, depthAt, mask, mutate, norm } from "./tsSource.js";

/**
 * Plan 055 T8: `index.ts` must wire the drain exactly one way. The census reads the real
 * file text (comments and literals masked, formatting ignored) and returns every way the
 * wiring departs from the plan; each planted mutation must produce at least one.
 */

const INDEX = readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8").replace(/\r\n/g, "\n");

const MOUNT = "app.use(createDrainMiddleware({ drain, token: ACCESS_TOKEN, now: Date.now }));";
const GATE = "app.use(createAuthGate(ACCESS_TOKEN));";
const FIRST_CALLBACK = "() => { drain.begin(Date.now()); }";
const LISTEN_STATEMENT = "const listening = startListening(app, MCP_PORT, MCP_HOST, { retryMs: 100, limitMs: 5000 });";
const LISTEN_LOG = "console.log(`[MCP] Listening on http://${MCP_HOST}:${MCP_PORT}`);";
const LISTEN_ARGS = ["app", "MCP_PORT", "MCP_HOST", "{ retryMs: 100, limitMs: 5000 }"];
const CANCEL_LINE = "        listening.cancel();\n";
const REJECT_HANDLER = "    (err) => {\n        console.error(`[MCP] Could not listen on ${MCP_HOST}:${MCP_PORT}:`, err);\n        void gracefulExit(1);\n    },\n";

interface Hit {
    at: number;
    end: number;
}

function findAll(masked: string, pattern: RegExp): Hit[] {
    const hits: Hit[] = [];
    for (const m of masked.matchAll(new RegExp(pattern.source, "g"))) hits.push({ at: m.index!, end: m.index! + m[0].length });
    return hits;
}

/**
 * Whether the code at `at` begins a statement of its own: nothing but a `;`, `{` or `}` (or the
 * start of the file) precedes it, so it is not the body of a brace-less `if`, loop or expression.
 */
function startsStatement(masked: string, at: number): boolean {
    const before = masked.slice(0, at).trimEnd();
    return before.length === 0 || ["{", ";", "}"].includes(before[before.length - 1]);
}

/** What ends a scope early: a `return`, a `throw`, or a process exit. */
const DEPARTURE = /\b(?:return|throw)\b|\bprocess\s*\.\s*exit\s*\(/;

/**
 * Why the code at `at` might not run whenever the scope whose `{` is at `scopeOpen` runs (-1: the
 * module), or null when it does: it must sit directly in that scope, begin a statement of its own
 * (not the body of a brace-less `if`, loop or expression), and follow no departure that is itself
 * a statement of that scope. The one reachability rule every positive subject of this census goes
 * through; a subject in a nested scope is checked level by level (the try, then the call in it).
 */
function whyNotLive(masked: string, at: number, scopeOpen: number): string | null {
    const depth = scopeOpen < 0 ? 0 : depthAt(masked, scopeOpen) + 1;
    if (depthAt(masked, at) !== depth) return "is nested inside another construct";
    if (!startsStatement(masked, at)) return "is not a statement of its own (it is the body of a condition or expression)";
    const leaves = findAll(masked, DEPARTURE).filter(
        (h) => h.at > scopeOpen && h.at < at && depthAt(masked, h.at) === depth && startsStatement(masked, h.at),
    );
    if (leaves.length > 0) return "follows a return, throw or exit that always runs first";
    return null;
}

/** The `[start, end)` source range of each top-level argument of the call whose `(` is at `open`. */
function argumentRanges(masked: string, open: number): Array<[number, number]> {
    const end = closeOf(masked, open);
    const ranges: Array<[number, number]> = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open + 1; i < end - 1; i++) {
        const c = masked[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === "," && depth === 0) {
            ranges.push([start, i]);
            start = i + 1;
        }
    }
    if (masked.slice(start, end - 1).trim() !== "") ranges.push([start, end - 1]); // a trailing comma adds no argument
    return ranges;
}

/** Every departure of `source` from the T8 wiring; empty when it is exactly as the plan prescribes. */
export function checkIndexWiring(source: string): string[] {
    const masked = mask(source);
    const problems: string[] = [];

    // 1. The middleware chain: exactly these `app.use` statements, at module level, in this order.
    const uses = findAll(masked, /\bapp\s*\.\s*use\s*\(/);
    const statements = uses.map((hit) => {
        const open = hit.end - 1;
        let end = closeOf(masked, open);
        while (/\s/.test(masked[end] ?? "")) end++;
        if (masked[end] === ";") end++;
        return { at: hit.at, text: norm(source.slice(hit.at, end)) };
    });
    for (const s of statements) {
        const why = whyNotLive(masked, s.at, -1);
        if (why) problems.push(`an app.use statement ${why}: ${s.text.slice(0, 60)}`);
    }
    const expected = ["app.use(cors());", "app.use(express.json());", MOUNT, GATE].map(norm);
    if (JSON.stringify(statements.map((s) => s.text)) !== JSON.stringify(expected)) {
        problems.push(`the middleware chain is not cors, express.json, the drain mount, the auth gate: ${statements.map((s) => s.text).join(" | ")}`);
    }
    const mounts = statements.filter((s) => s.text === norm(MOUNT));
    if (mounts.length !== 1) problems.push(`expected exactly one drain mount, found ${mounts.length}`);
    const gates = statements.filter((s) => s.text === norm(GATE));
    if (gates.length !== 1) problems.push(`expected exactly one auth gate, found ${gates.length}`);
    const jsonAt = statements.findIndex((s) => s.text === norm("app.use(express.json());"));
    const mountAt = statements.findIndex((s) => s.text === norm(MOUNT));
    const gateAt = statements.findIndex((s) => s.text === norm(GATE));
    if (!(jsonAt >= 0 && jsonAt < mountAt && mountAt < gateAt)) problems.push("the drain mount is not after express.json() and before the auth gate");
    for (const s of statements) {
        if (/authorization/i.test(source.slice(s.at, s.at + 400)) && s.text !== norm(GATE) && /authorization/i.test(s.text)) {
            problems.push("an app.use middleware other than the auth gate reads the authorization header");
        }
    }

    // 2. One drain state, constructed once at module level, before the mount.
    const constructions = findAll(masked, /\bnew\s+DrainState\b/);
    if (constructions.length !== 1) problems.push(`expected exactly one new DrainState, found ${constructions.length}`);
    const declarations = findAll(masked, /\bconst\s+drain\s*=\s*new\s+DrainState\s*\(\s*\)\s*;/);
    if (declarations.length !== 1) problems.push("`const drain = new DrainState();` is not present exactly once");
    else {
        const why = whyNotLive(masked, declarations[0].at, -1);
        if (why) problems.push(`\`const drain = new DrainState();\` ${why}`);
        const firstMount = statements.find((s) => s.text === norm(MOUNT));
        if (firstMount && declarations[0].at > firstMount.at) problems.push("the drain state is declared after the mount");
    }

    // 3. Nothing of the old drain survives, and nothing else answers 503.
    if (findAll(masked, /\bacceptingSessions\b/).length > 0) problems.push("an acceptingSessions identifier remains");
    if (findAll(masked, /\b503\b/).length > 0) problems.push("a 503 is sent from index.ts; only the drain middleware may send it");

    // 4. The shutdown transition.
    const beginCalls = findAll(masked, /\bdrain\s*\.\s*begin\s*\(/);
    if (beginCalls.length !== 1) problems.push(`expected exactly one drain.begin call, found ${beginCalls.length}`);
    const fn = findAll(masked, /\basync\s+function\s+gracefulExit\s*\(/)[0];
    if (!fn) {
        problems.push("gracefulExit is missing");
        return problems;
    }
    const paramsOpen = fn.end - 1;
    const bodyOpen = masked.indexOf("{", closeOf(masked, paramsOpen));
    const bodyEnd = closeOf(masked, bodyOpen);
    const body = masked.slice(0, bodyEnd);
    const bodyDepth = depthAt(masked, bodyOpen) + 1;
    const tries = findAll(masked, /\btry\s*\{/).filter((h) => h.at > bodyOpen && h.at < bodyEnd && depthAt(masked, h.at) === bodyDepth);
    if (tries.length !== 1) {
        problems.push(`expected exactly one top-level try in gracefulExit, found ${tries.length}`);
        return problems;
    }
    // The try runs whenever gracefulExit gets past its guard, and the quiesce runs whenever the try does.
    const tryWhy = whyNotLive(masked, tries[0].at, bodyOpen);
    if (tryWhy) problems.push(`gracefulExit's try ${tryWhy}`);
    const tryOpen = tries[0].end - 1;
    const tryEnd = closeOf(masked, tryOpen);
    const quiesces = findAll(body.slice(0, tryEnd), /\bawait\s+quiesce\s*\(/).filter((h) => h.at > tryOpen);
    if (quiesces.length !== 1) {
        problems.push(`expected exactly one await quiesce( in the try block, found ${quiesces.length}`);
        return problems;
    }
    const q = quiesces[0];
    const quiesceWhy = whyNotLive(masked, q.at, tryOpen);
    if (quiesceWhy) problems.push(`\`await quiesce(\` ${quiesceWhy}`);
    const args = callArguments(source, masked, q.end - 1);
    if (args.length !== 3) problems.push(`quiesce takes three arguments, found ${args.length}`);
    if (norm(args[0] ?? "") !== norm(FIRST_CALLBACK)) {
        problems.push(`the first quiesce argument is not exactly ${FIRST_CALLBACK}: ${norm(args[0] ?? "")}`);
    }

    // 5. Plan 056 T6: the listen is `startListening`, cancelled first on every exit, and `server` comes from `ready`.
    // 5a. No bare `.listen(` anywhere in index.ts.
    if (findAll(masked, /\.\s*listen\s*\(/).length > 0) problems.push("a bare .listen( call remains; the only listen is startListening");
    // 5b. Exactly one `const listening = startListening(app, MCP_PORT, MCP_HOST, ...)` at module level.
    const starts = findAll(masked, /\bstartListening\s*\(/);
    const startDecls = findAll(masked, /\bconst\s+listening\s*=\s*startListening\s*\(/);
    if (starts.length !== 1 || startDecls.length !== 1) {
        problems.push(`expected exactly one \`const listening = startListening(\`, found ${startDecls.length} of ${starts.length} startListening calls`);
    } else {
        const why = whyNotLive(masked, startDecls[0].at, -1);
        if (why) problems.push(`\`const listening = startListening(\` ${why}`);
        const startArgs = callArguments(source, masked, startDecls[0].end - 1).map(norm);
        // Every operand, the retry options included (review 317 R2): a short limit would give up on the
        // port a releasing holder is about to free.
        const expected = LISTEN_ARGS.map(norm);
        if (startArgs.length !== expected.length || startArgs.some((arg, i) => arg !== expected[i])) {
            problems.push(`startListening is not called with exactly ${LISTEN_ARGS.join(", ")}: ${startArgs.join(",")}`);
        }
    }
    // 5c. `listening.cancel()` is live in gracefulExit's try, before the quiesce.
    const cancels = findAll(masked, /\blistening\s*\.\s*cancel\s*\(\s*\)\s*;/).filter((h) => h.at > tryOpen && h.at < tryEnd);
    if (cancels.length !== 1) problems.push(`expected exactly one listening.cancel() in gracefulExit's try, found ${cancels.length}`);
    else {
        const why = whyNotLive(masked, cancels[0].at, tryOpen);
        if (why) problems.push(`listening.cancel() ${why}`);
        if (cancels[0].at > q.at) problems.push("listening.cancel() comes after the quiesce");
    }
    if (findAll(masked, /\blistening\s*\.\s*cancel\s*\(/).length !== 1) problems.push("listening.cancel() is called other than once, in gracefulExit");
    // 5d. `server` is assigned once, from `ready`'s resolution; a rejection leads to gracefulExit(1).
    const assignments = findAll(masked, /\bserver\s*=(?!=)/).filter((h) => !/\b(?:const|let|var)\s+$/.test(masked.slice(0, h.at)));
    const thens = findAll(masked, /\blistening\s*\.\s*ready\s*\.\s*then\s*\(/);
    if (thens.length !== 1) problems.push(`expected exactly one listening.ready.then(, found ${thens.length}`);
    else {
        const open = thens[0].end - 1;
        const ranges = argumentRanges(masked, open);
        const whyThen = whyNotLive(masked, thens[0].at, -1);
        if (whyThen) problems.push(`listening.ready.then( ${whyThen}`);
        if (ranges.length !== 2) problems.push(`ready.then takes a resolve and a reject handler, found ${ranges.length} arguments`);
        else {
            const [resolveArg, rejectArg] = ranges;
            const resolveText = norm(source.slice(resolveArg[0], resolveArg[1]));
            if (!/^\((\w+)\)=>\{server=\1;/.test(resolveText)) problems.push(`the resolve handler does not begin by assigning server from its parameter: ${resolveText.slice(0, 60)}`);
            const inResolve = assignments.filter((h) => h.at >= resolveArg[0] && h.at < resolveArg[1]);
            if (assignments.length !== 1 || inResolve.length !== 1) problems.push(`server must be assigned exactly once, inside the resolve handler; found ${assignments.length}`);
            else {
                const resolveBody = masked.indexOf("{", resolveArg[0]);
                const why = whyNotLive(masked, inResolve[0].at, resolveBody);
                if (why) problems.push(`the server assignment ${why}`);
            }
            // The success log: the exact statement, once, live in the resolve handler (review 318 I4).
            const logs: number[] = [];
            for (let at = source.indexOf(LISTEN_LOG); at >= 0; at = source.indexOf(LISTEN_LOG, at + 1)) logs.push(at);
            const resolveOpen = masked.indexOf("{", resolveArg[0]);
            if (logs.length !== 1) problems.push(`expected exactly one \`${LISTEN_LOG}\`, found ${logs.length}`);
            else if (!masked.startsWith("console.log(", logs[0])) problems.push("the success log is not code (a comment or a string)");
            else if (logs[0] < resolveArg[0] || logs[0] >= resolveArg[1]) problems.push("the success log is not in the resolve handler");
            else {
                const why = whyNotLive(masked, logs[0], resolveOpen);
                if (why) problems.push(`the success log ${why}`);
            }
            const rejectBody = masked.indexOf("{", rejectArg[0]);
            const exits = findAll(masked.slice(0, rejectArg[1]), /\bvoid\s+gracefulExit\s*\(\s*1\s*\)\s*;/).filter((h) => h.at > rejectBody);
            if (exits.length !== 1) problems.push(`expected exactly one \`void gracefulExit(1);\` in the reject handler, found ${exits.length}`);
            else {
                const why = whyNotLive(masked, exits[0].at, rejectBody);
                if (why) problems.push(`the reject handler's gracefulExit(1) ${why}`);
            }
        }
    }
    return problems;
}

describe("index.ts drain wiring census", () => {
    test("the real index.ts is wired exactly as the plan prescribes", () => {
        expect(checkIndexWiring(INDEX)).toEqual([]);
    });

    const QUIESCE_FIRST = "            () => { drain.begin(Date.now()); },\n";
    const CASES: [string, () => string][] = [
        ["the old gate retained before the factory", () => mutate(INDEX, GATE, `app.use((req: Request, res: Response, next) => { if (!ACCESS_TOKEN) return next(); const auth = req.header("authorization") || ""; if (auth === \`Bearer \${ACCESS_TOKEN}\`) return next(); res.status(401).json({ error: "unauthorized" }); });\n${GATE}`)],
        ["token: \"\" in the mount", () => mutate(INDEX, "token: ACCESS_TOKEN, now", 'token: "", now')],
        ["a fresh new DrainState() passed inline", () => mutate(INDEX, "createDrainMiddleware({ drain, token", "createDrainMiddleware({ drain: new DrainState(), token")],
        ["begin never called", () => mutate(INDEX, QUIESCE_FIRST, "            () => {},\n")],
        ["if (false) around begin as the first callback", () => mutate(INDEX, QUIESCE_FIRST, "            () => { if (false) { drain.begin(Date.now()); } },\n")],
        ["begin moved after the quiesce call", () => mutate(mutate(INDEX, QUIESCE_FIRST, "            () => {},\n"), "    } catch {\n        /* ignore */", "        drain.begin(Date.now());\n    } catch {\n        /* ignore */")],
        ["createAuthGate with an empty token", () => mutate(INDEX, GATE, 'app.use(createAuthGate(""));')],
        ["the gate mounted before the drain", () => mutate(mutate(INDEX, GATE, ""), MOUNT, `${GATE}\n${MOUNT}`)],
        ["the drain mounted before express.json()", () => mutate(mutate(INDEX, MOUNT, ""), "app.use(express.json());", `${MOUNT}\napp.use(express.json());`)],
        ["the mount inside if (false)", () => mutate(INDEX, MOUNT, `if (false) { ${MOUNT} }`)],
        ["the mount only in a comment", () => mutate(INDEX, MOUNT, `// ${MOUNT}`)],
        ["the mount under a brace-less if (false)", () => mutate(INDEX, MOUNT, `if (false) ${MOUNT}`)],
        ["the gate under a brace-less if (false)", () => mutate(INDEX, GATE, `if (false) ${GATE}`)],
        ["the gate mounted twice", () => mutate(INDEX, GATE, `${GATE}\n${GATE}`)],
        ["the old acceptingSessions variable back", () => mutate(INDEX, "const drain = new DrainState();", "const drain = new DrainState();\nlet acceptingSessions = true;")],
        ["another middleware answering 503", () => mutate(INDEX, GATE, `${GATE}\napp.use((_req: Request, res: Response) => { res.status(503).end(); });`)],
        ["a second DrainState", () => mutate(INDEX, "const drain = new DrainState();", "const drain = new DrainState();\nconst other = new DrainState();")],
        ["the drain state declared inside a function", () => mutate(INDEX, "const drain = new DrainState();", "function make() { return 1; }\nif (true) { var unused = 1; }\nlet drain = new DrainState();")],
        ["quiesce under an if", () => mutate(INDEX, "        await quiesce(", "        if (!exiting) await quiesce(")],
        ["quiesce inside a nested block", () => mutate(INDEX, "        await quiesce(", "        if (true) { await quiesce(").replace("            () => closeHttpServer(server),\n        );", "            () => closeHttpServer(server),\n        ); }")],
        ["begin in a string instead of a call", () => mutate(INDEX, QUIESCE_FIRST, '            () => { "drain.begin(Date.now());"; },\n')],
        ["a different clock for begin", () => mutate(INDEX, QUIESCE_FIRST, "            () => { drain.begin(0); },\n")],
        ["begin called a second time inside the callback", () => mutate(INDEX, QUIESCE_FIRST, "            () => { drain.begin(Date.now()); drain.begin(Date.now()); },\n")],
        ["a return in the try before quiesce", () => mutate(INDEX, "        await quiesce(", "        return;\n        await quiesce(")],
        ["a throw in the try before quiesce", () => mutate(INDEX, "        await quiesce(", '        throw new Error("x");\n        await quiesce(')],
        ["a return in the function body before the try", () => mutate(INDEX, "    exiting = true;\n", "    exiting = true;\n    return;\n")],
        ["the try under a brace-less if (false)", () => mutate(INDEX, "    exiting = true;\n    try {", "    exiting = true;\n    if (false) try {")],
        ["an exit in the function body before the try", () => mutate(INDEX, "    exiting = true;\n", "    exiting = true;\n    process.exit(code);\n")],
        ["a module-level throw before the drain state", () => mutate(INDEX, "const drain = new DrainState();", 'throw new Error("skip wiring");\nconst drain = new DrainState();')],
        ["a module-level throw before the mount", () => mutate(INDEX, MOUNT, `throw new Error("skip wiring");\n${MOUNT}`)],
        ["a module-level throw before the gate", () => mutate(INDEX, GATE, `throw new Error("skip wiring");\n${GATE}`)],
        // Plan 056 T6: one mutation per pin of the listen wiring.
        ["a bare app.listen back beside startListening", () => mutate(INDEX, LISTEN_STATEMENT, `${LISTEN_STATEMENT}\napp.listen(MCP_PORT, MCP_HOST);`)],
        ["app.listen instead of startListening", () => mutate(INDEX, LISTEN_STATEMENT, "const listening = app.listen(MCP_PORT, MCP_HOST);")],
        ["startListening on the wrong port", () => mutate(INDEX, "startListening(app, MCP_PORT,", "startListening(app, 0,")],
        ["startListening on the wrong host", () => mutate(INDEX, "MCP_PORT, MCP_HOST, {", 'MCP_PORT, "0.0.0.0", {')],
        ["startListening with no retry limit left", () => mutate(INDEX, "limitMs: 5000 }", "limitMs: 0 }")],
        ["startListening with a short retry limit", () => mutate(INDEX, "limitMs: 5000 }", "limitMs: 500 }")],
        ["startListening with a changed retry interval", () => mutate(INDEX, "retryMs: 100,", "retryMs: 1000,")],
        ["startListening without its options", () => mutate(INDEX, ", { retryMs: 100, limitMs: 5000 });", ");")],
        ["startListening with an extra argument", () => mutate(INDEX, "limitMs: 5000 });", "limitMs: 5000 }, 1);")],
        ["the success log under a condition", () => mutate(INDEX, LISTEN_LOG, `if (exiting) { ${LISTEN_LOG} }`)],
        ["the success log in an uncalled closure", () => mutate(INDEX, LISTEN_LOG, `const later = () => { ${LISTEN_LOG} };`)],
        ["the success log after a return", () => mutate(INDEX, "        server = listener;\n", "        server = listener;\n        return;\n")],
        ["the success log only in a comment", () => mutate(INDEX, LISTEN_LOG, `// ${LISTEN_LOG}`)],
        ["the success log only in a string", () => mutate(INDEX, LISTEN_LOG, `const note = "Listening on";`)],
        ["the success log with another address", () => mutate(INDEX, LISTEN_LOG, "console.log(`[MCP] Listening on http://127.0.0.1:${MCP_PORT}`);")],
        ["startListening under if (false)", () => mutate(INDEX, LISTEN_STATEMENT, `if (false) ${LISTEN_STATEMENT}`)],
        ["startListening only in a comment", () => mutate(INDEX, LISTEN_STATEMENT, `// ${LISTEN_STATEMENT}`)],
        ["a second startListening", () => mutate(INDEX, LISTEN_STATEMENT, `${LISTEN_STATEMENT}\nconst again = startListening(app, MCP_PORT, MCP_HOST, { retryMs: 100, limitMs: 5000 });`)],
        ["server assigned outside ready", () => mutate(INDEX, "let server: Server | undefined;", "let server: Server | undefined;\nserver = undefined;")],
        ["server assigned from something other than ready's value", () => mutate(INDEX, "server = listener;", "server = undefined;")],
        ["server assigned under if (false) in the resolve handler", () => mutate(INDEX, "        server = listener;\n", "        if (false) server = listener;\n")],
        ["server assigned after a return in the resolve handler", () => mutate(INDEX, "        server = listener;\n", "        server = listener;\n        return;\n        server = listener;\n")],
        ["the success log outside the resolve handler", () => mutate(mutate(INDEX, "        console.log(`[MCP] Listening on http://${MCP_HOST}:${MCP_PORT}`);\n", ""), "let server: Server | undefined;", "let server: Server | undefined;\nconsole.log(`[MCP] Listening on http://${MCP_HOST}:${MCP_PORT}`);")],
        ["no reject handler", () => mutate(INDEX, REJECT_HANDLER, "")],
        ["a rejection exits 0", () => mutate(INDEX, "void gracefulExit(1);\n    },\n);", "void gracefulExit(0);\n    },\n);")],
        ["a rejection only logged", () => mutate(INDEX, "        void gracefulExit(1);\n    },\n);", "    },\n);")],
        ["the rejection exit under if (false)", () => mutate(INDEX, "        void gracefulExit(1);\n    },\n);", "        if (false) void gracefulExit(1);\n    },\n);")],
        ["listening.cancel() never called", () => mutate(INDEX, CANCEL_LINE, "")],
        ["listening.cancel() after the quiesce", () => mutate(mutate(INDEX, CANCEL_LINE, ""), "    } catch {\n        /* ignore */", "        listening.cancel();\n    } catch {\n        /* ignore */")],
        ["listening.cancel() under if (false)", () => mutate(INDEX, CANCEL_LINE, "        if (false) listening.cancel();\n")],
        ["listening.cancel() in a nested block", () => mutate(INDEX, CANCEL_LINE, "        if (true) { listening.cancel(); }\n")],
        ["listening.cancel() after a return", () => mutate(INDEX, CANCEL_LINE, "        return;\n        listening.cancel();\n")],
        ["listening.cancel() called a second time", () => mutate(INDEX, CANCEL_LINE, `${CANCEL_LINE}        listening.cancel();\n`)],
    ];

    for (const [name, build] of CASES) {
        test(`kills the planted mutation: ${name}`, () => {
            const problems = checkIndexWiring(build());
            if (process.env.CENSUS_REASONS) console.log(`${name} => ${problems.join(" ; ").slice(0, 160)}`);
            expect(problems.length).toBeGreaterThan(0);
        });
    }
});
