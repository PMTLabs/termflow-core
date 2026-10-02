import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { classificationErrors, rendererSources, shapeCensus, type SinkClassification } from '../../__testFixtures__/rendererSinkShape';

const manifest: Record<string, SinkClassification> = JSON.parse(fs.readFileSync(path.join(__dirname, 'rendererSinkManifest.json'), 'utf8'));

// Lexical containment/regression enforcement only. Mounted behavioural gates prove that
// the recorded predicates actually qualify the effect at its continuation sink.
test('renderer continuation census classifies new effects and rejects stale function rows', () => {
  expect(classificationErrors(shapeCensus(rendererSources()), manifest)).toEqual([]);
});

test.each(['splitPaneWithTab', 'addEdge', 'removePaneFromTab'])('an unlisted post-await %s dispatch is discovered outside known lifecycle modules', action => {
  const hits = shapeCensus({ 'components/UnlistedAction.tsx': `async function later(dispatch) { await bridge(); dispatch(${action}(subject)); }` });
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ boundaries: ['await'], mutations: action === 'removePaneFromTab' ? [`dispatch:${action}`, `call:${action}`] : [`dispatch:${action}`] });
  expect(classificationErrors(hits, {})).toEqual(['unclassified: components/UnlistedAction.tsx:later(1)']);
});

test('an unlisted promise-cache write inside a then continuation is discovered', () => {
  const hits = shapeCensus({ 'services/UnlistedCache.ts': 'function start() { bridge().then(() => { pending.set(leaf, promise); }); }' });
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ key: 'services/UnlistedCache.ts:start:then callback(1)', boundaries: ['then'], mutations: ['write:pending.set'] });
  expect(classificationErrors(hits, {})).toEqual(['unclassified: services/UnlistedCache.ts:start:then callback(1)']);
});

test.each([
  ['ref assignment', 'async function later() { await bridge(); slot.current = result; }', 'assign:slot.current'],
  ['module promise', 'let pending; async function later() { await bridge(); pending = work; }', 'assign:pending'],
  ['state setter', 'async function later() { await bridge(); setProcessId(pc); }', 'call:setProcessId'],
])('an unlisted post-await %s is inventoried', (_kind, source, mutation) => {
  const hits = shapeCensus({ 'services/UnlistedLifetime.ts': source });
  expect(hits).toHaveLength(1);
  expect(hits[0].mutations).toEqual([mutation]);
  expect(classificationErrors(hits, {})).toEqual(['unclassified: services/UnlistedLifetime.ts:later(1)']);
});

test('deleting a listed production function in memory produces a stale manifest error', () => {
  const files = rendererSources();
  const file = 'services/paneActions.ts';
  const ast = ts.createSourceFile(file, files[file], ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'splitPaneById')!;
  expect(manifest['services/paneActions.ts:splitPaneById(1)']).toBeDefined();
  files[file] = files[file].slice(0, fn.getFullStart()) + files[file].slice(fn.end);
  expect(classificationErrors(shapeCensus(files), manifest)).toContain('stale: services/paneActions.ts:splitPaneById(1)');
});

test('anonymous continuations have distinct function keys and a changed listed effect is rejected', () => {
  const files = { 'services/Callbacks.ts': 'function start() { bridge().then(() => { pending.set(a,b); }); bridge().then(() => { pending.delete(a); }); }' };
  const hits = shapeCensus(files);
  expect(hits.map(hit => hit.key)).toEqual(['services/Callbacks.ts:start:then callback(1)', 'services/Callbacks.ts:start:then callback(2)']);
  const rows = Object.fromEntries(hits.map(hit => [hit.key, { ...hit, mechanism: 'promise object compare', captured: 'original promise', checked: 'current cache entry' }]));
  expect(classificationErrors(hits, rows)).toEqual([]);
  const changed = shapeCensus({ 'services/Callbacks.ts': files['services/Callbacks.ts'].replace('pending.set(a,b);', 'pending.set(a,b); dispatch(addEdge(edge));') });
  expect(classificationErrors(changed, rows)).toEqual(['unclassified: services/Callbacks.ts:start:then callback(1)']);
});
