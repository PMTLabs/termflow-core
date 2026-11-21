import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { readSource } from '../../../utils/readSource';

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function unwrap(value: ts.Expression): ts.Expression {
  while (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isParenthesizedExpression(value)
    || ts.isSatisfiesExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
  return value;
}

function paneType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isUnionTypeNode(type)) return type.types.some(paneType);
  if (ts.isParenthesizedTypeNode(type)) return paneType(type.type);
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'PaneNode';
}

function typedObject(node: ts.ObjectLiteralExpression): boolean {
  // A typed return/assertion/declaration is still a factory if it is written
  // entirely with spread or a renamed discriminator. Don't match function names.
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isTypeAssertionExpression(parent)) {
      if (paneType(parent.type)) return true;
    } else if (ts.isVariableDeclaration(parent)) return paneType(parent.type);
    else if (ts.isReturnStatement(parent)) {
      for (let scope: ts.Node | undefined = parent.parent; scope; scope = scope.parent) {
        if (ts.isFunctionLike(scope)) return paneType(scope.type);
      }
      return false;
    } else if (ts.isArrowFunction(parent)) return paneType(parent.type);
    else if (!ts.isParenthesizedExpression(parent) && !ts.isConditionalExpression(parent)) return false;
  }
  return false;
}

function detect(source: string, filename = 'fixture.tsx'): string[] {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const families: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map(node.properties.flatMap(property => {
        const name = propertyName(property.name);
        return name ? [[name, property] as const] : [];
      }));
      const type = fields.get('type');
      const value = type && ts.isPropertyAssignment(type) ? unwrap(type.initializer) : undefined;
      const kind = value && ts.isStringLiteralLike(value) ? value.text : undefined;
      if (fields.has('id') && ['terminal', 'split'].includes(kind ?? '')) families.push(kind!);
      else if (fields.has('id') && fields.has('type') && (fields.has('terminalId') || fields.has('direction') && fields.has('children'))) {
        families.push('node whitelist');
      } else if (typedObject(node)) families.push('typed node');
      const envelope = ['paneTree', 'tabPanes', 'treesByTabId'].filter(field => fields.has(field));
      if (envelope.length) families.push(envelope.join('+'));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'type') {
      const value = unwrap(node.right);
      if (ts.isStringLiteralLike(value) && ['terminal', 'split'].includes(value.text)) families.push(`becomes ${value.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return families.sort();
}

test('pane_factory_detector_finds_unfamiliar_factories_and_whitelists_not_comments_or_types', () => {
  const cases = `
    // function ignored() { return { id, type: 'terminal', terminalId }; }
    type Model = { id: string; type: 'split'; paneTree: unknown };
    const unrelated = { type: 'terminal', status: 'ok' };
    const widget = <div data-pane-id={id} />;
    export const makeWithoutKnownFactoryName = () => ({ id,
      'type': ('terminal' as const), terminalId });
    const arbitrary = { 'id': id, type, terminalId };
    const rebuilt: PaneNode | null = c ? { ...old } : null;
    const writer = { ['unrelated']: 1, 'paneTree': arbitrary, tabPanes };
    old.type = 'split';
  `;
  expect(detect(cases)).toEqual(['becomes split', 'node whitelist', 'paneTree+tabPanes', 'terminal', 'typed node']);
  expect(detect(cases.replace(/\n/g, '\r\n'))).toEqual(detect(cases));
});

// Each entry names the disposition tested in the T9 suite nearest the owner.
// Counts matter: a new whitelist in an ALREADY known file still requires a test.
const tested: Record<string, string[]> = {
  'App.tsx': ['terminal', 'split', 'tabPanes'], // REST pane info (descriptive only); local API mode 0 input
  'store/index.ts': ['paneTree'], // diagnostic projection, not persistence
  'store/slices/paneTreeOps.ts': ['split', 'typed node'], // insert/move/swap
  'store/slices/panesSlice.ts': ['paneTree+treesByTabId', 'terminal', 'terminal', 'terminal', 'terminal', 'terminal', 'becomes split', 'becomes split'],
  'components/Panes/dnd/PaneDragController.tsx': ['terminal'], // current drag identity or cancel
  'components/Panes/dnd/detach.ts': ['paneTree', 'paneTree', 'paneTree', 'typed node'], // opaque tree plus pruned authority
  'components/Canvas/canvasSpawn.ts': ['terminal'], // ordinary profile factory, deliberately local
  'services/apiCreatedTab.ts': ['terminal', 'terminal', 'paneTree'], // mode 0 and fallback, both local
  'services/folderTab.ts': ['terminal'], // local even with tagged neighbors
  'services/layoutUndo.ts': ['paneTree+tabPanes+treesByTabId'], // one-deep, window-scoped undo ingress
  'services/restoreHiddenAgentTerminals.ts': ['terminal'], // local (no saved intent)
  'services/sshLaunch.ts': ['terminal'], // sole factory for saved SSH intent
  'services/sshPanePersistence.ts': ['typed node', 'typed node'], // typed returns preserve non-SSH fields
  'services/tabTreeSeed.ts': ['terminal'], // local seed when mirror absent
  'services/StateManager.ts': [
    'paneTree+tabPanes', 'paneTree+treesByTabId', 'paneTree+treesByTabId', 'tabPanes',
    'paneTree', 'paneTree+tabPanes+treesByTabId', 'paneTree',
  ], // session, layout scopes, reconcile, cap registration, import, legacy remap
  'services/workspaceSnapshot.ts': ['paneTree+tabPanes+treesByTabId', 'paneTree+tabPanes+treesByTabId', 'paneTree+treesByTabId'],
};

test('source_derived_pane_census_requires_a_disposition_for_every_factory_and_serializer', () => {
  const root = path.resolve(__dirname, '../../..');
  const actual: Record<string, string[]> = {};
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['__tests__', '__testFixtures__'].includes(entry.name)) scan(file);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
        const relative = path.relative(root, file).replace(/\\/g, '/');
        const shapes = detect(readSource(file), relative);
        if (shapes.length) actual[relative] = shapes;
      }
    }
  }
  scan(root);
  expect(actual).toEqual(Object.fromEntries(Object.entries(tested).map(([file, shapes]) => [file, [...shapes].sort()])));
});

test('api_pane_info_is_descriptive_and_all_public_create_routes_remain_local', () => {
  const root = path.resolve(__dirname, '../../..');
  const app = readSource(path.join(root, 'App.tsx'));
  const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true);
  const splitCalls: ts.ObjectLiteralExpression[] = [];
  const infoReturns: string[][] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'splitPaneInTab') {
      if (node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) splitCalls.push(node.arguments[0]);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'extractPaneInfo'
        && node.initializer && ts.isArrowFunction(node.initializer)) {
      function describe(child: ts.Node) {
        if (ts.isReturnStatement(child) && child.expression && ts.isObjectLiteralExpression(child.expression)) {
          infoReturns.push(child.expression.properties.map(property => propertyName(property.name) ?? '<spread>'));
        }
        ts.forEachChild(child, describe);
      }
      describe(node.initializer.body);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(infoReturns).toEqual([['id', 'type', 'terminalId', 'name'], ['id', 'type', 'direction', 'children']]);
  expect(splitCalls.map(call => call.properties.map(property => propertyName(property.name)))).toEqual([
    ['tabId', 'paneId', 'direction', 'shellType', 'name', 'terminalId', 'apiCreated', 'titleColor'],
    ['tabId', 'direction', 'shellType', 'name', 'terminalId', 'apiCreated', 'titleColor'],
    ['tabId', 'paneId', 'direction', 'shellType', 'name', 'terminalId', 'apiCreated', 'titleColor'],
  ]);
  expect(app).toMatch(/\bconst\s+paneTree\s*=\s*buildApiFallbackPane\(/);
  const rust = readSource(path.resolve(root, '../../src-tauri/src/api_server/terminals/mod.rs'));
  expect(rust).toMatch(/\bSpawnRequest\s*\{[^{}]*ssh_launch_connection_id:\s*None,/);
});
