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

interface Hit {
    at: number;
    end: number;
}

function findAll(masked: string, pattern: RegExp): Hit[] {
    const hits: Hit[] = [];
    for (const m of masked.matchAll(new RegExp(pattern.source, "g"))) hits.push({ at: m.index!, end: m.index! + m[0].length });
    return hits;
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
        return { at: hit.at, depth: depthAt(masked, hit.at), text: norm(source.slice(hit.at, end)) };
    });
    for (const s of statements) {
        if (s.depth !== 0) problems.push(`an app.use statement is not at module level: ${s.text.slice(0, 60)}`);
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
        if (depthAt(masked, declarations[0].at) !== 0) problems.push("`const drain = new DrainState();` is not at module level");
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
    const tryOpen = tries[0].end - 1;
    const tryEnd = closeOf(masked, tryOpen);
    const quiesces = findAll(body.slice(0, tryEnd), /\bawait\s+quiesce\s*\(/).filter((h) => h.at > tryOpen);
    if (quiesces.length !== 1) {
        problems.push(`expected exactly one await quiesce( in the try block, found ${quiesces.length}`);
        return problems;
    }
    const q = quiesces[0];
    if (depthAt(masked, q.at) !== bodyDepth + 1) problems.push("`await quiesce(` is nested inside another construct");
    const before = masked.slice(tryOpen, q.at).trimEnd();
    const lastToken = before[before.length - 1];
    if (!(lastToken === "{" || lastToken === ";" || lastToken === "}")) {
        problems.push("`await quiesce(` is the body of a condition or expression, not an unconditional statement");
    }
    // Reachable: no `return`/`throw` that is itself a statement (not the body of an `if`) of the
    // function body before the try, or of the try block before the call.
    const leaves = findAll(masked, /\b(return|throw)\b/).filter((h) => {
        const depth = depthAt(masked, h.at);
        const inBody = h.at > bodyOpen && h.at < tryOpen && depth === bodyDepth;
        const inTry = h.at > tryOpen && h.at < q.at && depth === bodyDepth + 1;
        const prev = masked.slice(0, h.at).trimEnd();
        return (inBody || inTry) && ["{", ";", "}"].includes(prev[prev.length - 1]);
    });
    if (leaves.length > 0) problems.push("`await quiesce(` follows a return or throw that always runs first");
    const args = callArguments(source, masked, q.end - 1);
    if (args.length !== 3) problems.push(`quiesce takes three arguments, found ${args.length}`);
    if (norm(args[0] ?? "") !== norm(FIRST_CALLBACK)) {
        problems.push(`the first quiesce argument is not exactly ${FIRST_CALLBACK}: ${norm(args[0] ?? "")}`);
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
    ];

    for (const [name, build] of CASES) {
        test(`kills the planted mutation: ${name}`, () => {
            const problems = checkIndexWiring(build());
            if (process.env.CENSUS_REASONS) console.log(`${name} => ${problems.join(" ; ").slice(0, 160)}`);
            expect(problems.length).toBeGreaterThan(0);
        });
    }
});
