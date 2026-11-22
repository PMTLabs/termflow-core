import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface SinkHit { key: string; line: number; boundaries: string[]; mutations: string[] }
export function rendererSources(root = path.join(__dirname, '..')): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !['__tests__', '__testFixtures__'].includes(entry.name)) walk(file);
      else if (entry.isFile() && /(?<!\.test|\.spec)\.tsx?$/.test(file)) files[path.relative(root, file).replace(/\\/g, '/')] = fs.readFileSync(file, 'utf8');
    }
  }
  walk(root);
  return files;
}

// This intentionally over-approximates lifetime writes (including local refs/maps).
// It inventories syntax, not alias/dataflow or the correctness of a predicate.
export function shapeCensus(files: Record<string, string>): SinkHit[] {
  const hits: SinkHit[] = [];
  for (const [file, text] of Object.entries(files)) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const functions: ts.FunctionLikeDeclaration[] = [];
    const registered = new Map<string, string>();
    const moduleVariables = new Set(ast.statements.flatMap(statement => ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(declaration => declaration.name.getText(ast)) : []));
    const callName = (node: ts.CallExpression): string => {
      const e = ts.isNonNullExpression(node.expression) ? node.expression.expression : node.expression;
      return ts.isPropertyAccessExpression(e) ? e.name.text : e.getText(ast);
    };
    const boundary = (name: string): boolean => /^(then|catch|finally|setTimeout|setInterval|requestAnimationFrame|listen|addEventListener|subscribe|useEffect|useLayoutEffect)$/.test(name) || /^on[A-Z]/.test(name);
    function discover(node: ts.Node): void {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) functions.push(node as ts.FunctionLikeDeclaration);
      if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(ast)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isIdentifier(node.initializer.expression)) {
        registered.set(node.initializer.expression.text, 'JSX event');
      }
      if (ts.isCallExpression(node) && boundary(callName(node))) {
        node.arguments.forEach(arg => {
          if (ts.isIdentifier(arg)) registered.set(arg.text, callName(node));
          else if (ts.isPropertyAccessExpression(arg)) registered.set(arg.name.text, callName(node));
        });
      }
      ts.forEachChild(node, discover);
    }
    discover(ast);
    const counts = new Map<string, number>();
    for (const fn of functions) {
      const names: string[] = [];
      for (let at: ts.Node | undefined = fn; at; at = at.parent) {
        if (!ts.isFunctionLike(at)) continue;
        if ('name' in at && at.name) names.unshift(at.name.getText(ast));
        else if (ts.isVariableDeclaration(at.parent) || ts.isPropertyAssignment(at.parent) || ts.isPropertyDeclaration(at.parent)) names.unshift(at.parent.name.getText(ast));
        else if (ts.isCallExpression(at.parent)) names.unshift(`${callName(at.parent)} callback`);
        else names.unshift('inline');
      }
      const name = names.join(':');
      const index = (counts.get(name) ?? 0) + 1;
      counts.set(name, index);
      const key = `${file}:${name}(${index})`;
      const boundaries = new Set<string>();
      let firstBoundary = Infinity;
      const ownName = fn.name?.getText(ast) ?? (ts.isVariableDeclaration(fn.parent) || ts.isPropertyDeclaration(fn.parent) ? fn.parent.name.getText(ast)
        : ts.isCallExpression(fn.parent) && ts.isVariableDeclaration(fn.parent.parent) ? fn.parent.parent.name.getText(ast) : undefined);
      if (ownName && registered.has(ownName)) { boundaries.add(registered.get(ownName)!); firstBoundary = fn.pos; }
      if (ts.isJsxExpression(fn.parent) && ts.isJsxAttribute(fn.parent.parent) && /^on[A-Z]/.test(fn.parent.parent.name.getText(ast))) {
        boundaries.add('JSX event'); firstBoundary = fn.pos;
      }
      // An inline continuation (or nested helper called by it) inherits that gap.
      for (let at: ts.Node | undefined = fn; at; at = at.parent) {
        if (ts.isFunctionLike(at) && ts.isCallExpression(at.parent) && boundary(callName(at.parent))) {
          boundaries.add(callName(at.parent)); firstBoundary = fn.pos;
        }
      }
      const mutations: { pos: number; kind: string }[] = [];
      function scan(node: ts.Node): void {
        if (node !== fn && ts.isFunctionLike(node)) return;
        if (ts.isAwaitExpression(node)) { boundaries.add('await'); firstBoundary = Math.min(firstBoundary, node.pos); }
        if (ts.isCallExpression(node)) {
          const name = callName(node);
          if (['then', 'catch', 'finally'].includes(name)) { boundaries.add(name); firstBoundary = Math.min(firstBoundary, node.pos); }
          if (name === 'dispatch') mutations.push({ pos: node.pos, kind: `dispatch:${node.arguments[0] && ts.isCallExpression(node.arguments[0]) ? callName(node.arguments[0]) : 'action'}` });
          else if (/^(set|delete|clear|add|push|splice|shift)$/.test(name) && ts.isPropertyAccessExpression(node.expression)) mutations.push({ pos: node.pos, kind: `write:${node.expression.expression.getText(ast)}.${name}` });
          else if (!['removeEventListener', 'remove', 'removeChild', 'removeAllRanges', 'closest', 'createElement', 'createObjectURL', 'cancelAnimationFrame', 'stopPropagation', 'stopImmediatePropagation', 'setTimeout', 'setInterval', 'setSelectionRange'].includes(name) && /^(?:install|remove|deleteEdge|requestReorder|dropTab|reconnect|attach|detach|depart|close|stage|adopt|bind|send|prepare|stash|cancel|admit|create|apply|populate|reap|stop|set[A-Z]|releaseGuard|clearInit)/.test(name)) mutations.push({ pos: node.pos, kind: `call:${name}` });
        }
        const lifetimeWrite = (target: ts.Node): boolean => ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)
          || (ts.isIdentifier(target) && moduleVariables.has(target.text));
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && lifetimeWrite(node.left)) mutations.push({ pos: node.pos, kind: `assign:${node.left.getText(ast)}` });
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
            && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
            && lifetimeWrite(node.operand)) mutations.push({ pos: node.pos, kind: `update:${node.operand.getText(ast)}` });
        ts.forEachChild(node, scan);
      }
      scan(fn);
      const effects = mutations.filter(m => m.pos >= firstBoundary);
      if (boundaries.size && effects.length) hits.push({ key, line: ast.getLineAndCharacterOfPosition(fn.getStart(ast)).line + 1, boundaries: [...boundaries].sort(), mutations: effects.map(m => m.kind) });
    }
  }
  return hits.sort((a, b) => a.key.localeCompare(b.key));
}

export interface SinkClassification {
  mechanism: string;
  captured: string;
  checked: string;
  boundaries: string[];
  mutations: string[];
}
export function classificationErrors(hits: SinkHit[], manifest: Record<string, SinkClassification>): string[] {
  const actual = new Set(hits.map(hit => hit.key));
  return [...hits.filter(hit => {
    const row = manifest[hit.key];
    return !row?.mechanism.trim() || !row.captured.trim() || !row.checked.trim()
      || JSON.stringify(row.boundaries) !== JSON.stringify(hit.boundaries)
      || JSON.stringify(row.mutations) !== JSON.stringify(hit.mutations);
  }).map(hit => `unclassified: ${hit.key}`),
    ...Object.keys(manifest).filter(key => !actual.has(key)).map(key => `stale: ${key}`)];
}
