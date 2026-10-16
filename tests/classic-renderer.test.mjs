import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/classic/runtime.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { createClassicViewBoundary, readClassicHostNonce, classicAutocomplete, classicOrderedRows, assertClassicTranscript } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

const vocabulary = { bracketTypes: [{ open: '[', close: ']' }], tags: new Set(['new-project-tag']), styleTags: new Set(['current-style', 'foreign']) };
const tagOptions = { bracket: [{ name: 'new-project-tag', group: 'Current group' }], style: [{ name: 'current-style', group: 'Tags' }, { name: 'foreign', group: 'French', foreign: { code: 'FR', format: 'marker' } }], curly: [{ name: 'PRON: ', group: 'Tags' }] };

test('Classic autocomplete follows handed current project vocabulary, groups and foreign formatting', () => {
  const value = classicAutocomplete({ vocabulary, tagOptions, isRTL: true });
  assert.deepEqual(value.bracketTags, ['new-project-tag']);
  assert.deepEqual(value.bracketTagGroups, [{ name: 'Current group', tags: ['new-project-tag'] }]);
  assert.deepEqual(value.curlyTags, ['PRON: ']);
  assert.equal(value.foreignStyleTag, 'foreign');
  assert.equal(value.foreignTagFormat, 'marker');
  assert.deepEqual(classicAutocomplete({ vocabulary, tagOptions: { ...tagOptions, curly: [] } }).curlyTags, []);
  assert.throws(() => classicAutocomplete({ vocabulary: { ...vocabulary, tags: [] }, tagOptions }), /current transcript vocabulary/);
});

test('Classic interleaves native ghost objects without renumbering or cloning live turns', () => {
  const first = { id: 'first', startTimeInSeconds: 5 }, second = { id: 'second', startTimeInSeconds: 10 };
  const ghost = { segmentInfo: { annotationId: 'deleted', startTimeInSeconds: 7 }, wordDiffs: [] };
  const turns = [first, second], ghosts = [ghost];
  const rows = classicOrderedRows(turns, ghosts);
  assert.equal(rows[0].turn, first);
  assert.equal(rows[1].ghost, ghost);
  assert.equal(rows[2].turn, second);
  assert.equal(rows[2].index, 1);
  assert.deepEqual(turns, [first, second]);
});

function nodes(element, predicate, result = []) {
  if (!element || typeof element !== 'object') return result;
  if (predicate(element)) result.push(element);
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) nodes(child, predicate, result);
  return result;
}


test('unsupported current transcript contracts fail before mounting captured inputs', () => {
  assert.throws(() => assertClassicTranscript({ turns: [], ghosts: [], handlers: {} }), /contract changed/);
});


test('Classic view failures render an explicit alert and report once without replacing healthy children', () => {
  const reports = [], element = (type, props) => ({ type, props });
  class Component { constructor(props) { this.props = props; } }
  const Boundary = createClassicViewBoundary({ Component }, { jsx: element, jsxs: element }, error => reports.push(error));
  const child = { type: 'captured-table', props: {} }, boundary = new Boundary({ children: child });
  assert.equal(boundary.render(), child);
  const failure = new Error('Live ReactDOM portal contract changed');
  boundary.state = Boundary.getDerivedStateFromError(failure);
  boundary.componentDidCatch(failure);
  boundary.componentDidCatch(failure);
  assert.deepEqual(reports, [failure]);
  const alert = boundary.render();
  assert.equal(alert.props.role, 'alert');
  assert.equal(alert.props.children[1].props.children, failure.message);
  assert.equal(nodes(alert, node => node.type === 'button').length, 0);
  boundary.state = Boundary.getDerivedStateFromError(null);
  assert.equal(boundary.render().props.role, 'alert');
});

test('Classic nonce follows only the live loader own descriptor without proxy property probes', () => {
  const target = () => {};
  const loader = new Proxy(target, { get() { throw new Error('Unowned webpack member probe'); } });
  assert.equal(readClassicHostNonce(loader), undefined);
  Object.defineProperty(target, 'nc', { configurable: true, value: undefined });
  assert.equal(readClassicHostNonce(loader), undefined);
  Object.defineProperty(target, 'nc', { configurable: true, value: 'real-current-nonce' });
  assert.equal(readClassicHostNonce(loader), 'real-current-nonce');
  let current = 'accessor-current-nonce';
  Object.defineProperty(target, 'nc', { configurable: true, get() { assert.equal(this, loader); return current; } });
  assert.equal(readClassicHostNonce(loader), current);
  current = 'new-current-nonce';
  assert.equal(readClassicHostNonce(loader), current);
});
