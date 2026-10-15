import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { transformSync } from 'esbuild';

// Maintenance-only generator. Normal builds consume the checked-in output and
// never need a private capture, an AST compiler at runtime, or unsafe-eval.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capture = path.resolve(root, '../tools/babel-editor-rebuild/exports/2026-10-15-live');
const files = [
  [59327, '8022-bab2b789674d6122.js'], [94846, '6264-da8e30159773903a.js'],
  [60039, '6264-da8e30159773903a.js'], [99407, '9794-ba07a8aab34cd3ac.js']
];
function nodes(source, predicate) {
  const result = [];
  const visit = node => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(source);
  return result;
}
function one(source, predicate, label) {
  const matches = nodes(source, predicate);
  if (matches.length !== 1) throw new Error(`${label}: expected one AST node, got ${matches.length}`);
  return matches[0];
}
function factory(filename, id) {
  const text = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const property = one(source, node => ts.isPropertyAssignment(node) && node.name.getText(source) === String(id) && ts.isFunctionExpression(node.initializer), `factory ${id}`);
  return property.initializer.getText(source);
}
function transform(text, id) {
  const source = ts.createSourceFile(`${id}.js`, `(${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const patches = [];
  const replace = (node, value) => patches.push({ start: node.getStart(source) - 1, end: node.end - 1, value });
  const declaration = (name, kind = ts.isFunctionDeclaration) => one(source, node => kind(node) && node.name?.text === name, `${id} ${name}`);
  const method = (owner, name) => one(owner, node => ts.isMethodDeclaration(node) && node.name.getText(source) === name, `${id}.${name}`);
  const exact = (old, value) => {
    const start = text.indexOf(old);
    if (start < 0 || text.indexOf(old, start + 1) !== -1) throw new Error(`${id}: exact patch contract missing or ambiguous: ${old.slice(0, 100)}`);
    patches.push({ start, end: start + old.length, value });
  };
  if (id === 59327) {
    replace(declaration('ah', ts.isClassDeclaration), 'class ah extends __bhRender.NativeRenderPlayhead {}');
    // Bind only the captured editor's genuine slate-history API; no copied
    // history internals or discovery of guessed webpack exports at runtime.
    const slateHistory = one(declaration('a6'), node => ts.isCallExpression(node) &&
      node.expression.getText(source) === '(0, aX.VC)', 'native Slate history editor');
    replace(slateHistory, `__bhRender.bindNativeSlateHistory(${slateHistory.getText(source)},aX.MO)`);
    // Slate's callback ref depends on onDOMBeforeInput. Preserve the complete
    // native handler while keeping its identity stable across parent commits.
    const beforeInput = one(declaration('a6'), node => ts.isPropertyAssignment(node) &&
      node.name.getText(source) === 'onDOMBeforeInput' && ts.isArrowFunction(node.initializer),
      'native Slate beforeinput callback');
    replace(beforeInput.initializer, `__bhRender.useNativeSlateBeforeInput(i,${beforeInput.initializer.getText(source)})`);
    const turn = declaration('ob');
    // k2 already has the upstream word memo. Keep its native dependencies.
    for (const [name, deps] of [['A2', '[e10.issues,C2,T2]'], ['E2', '[A2,v2.metadata]'], ['R2', '[b2,e10.lowConfidenceWords]']]) {
      const variable = one(turn, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name, `turn ${name}`);
      replace(variable.initializer, `(0,i.useMemo)(()=>(${variable.initializer.getText(source)}),${deps})`);
    }
    const active = one(turn, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'S2', 'active word hook');
    replace(active.initializer, '__bhRender.useNativeActiveWord(i,e10.playhead,k2)');
    const transcript = declaration('ok');
    // Retain the native body: history lifetime, copy handler, local-edit notice,
    // editing state and every row prop stay upstream-owned.
    const opening = transcript.body.getStart(source);
    patches.push({ start: opening, end: opening, value: '\nconst __bhTranscript=__bhRender.prepareNativeTranscript(i,e10,ob,t2);' });
    for (const [name, value] of [['n10', '__bhTranscript.numbers'], ['a10', '__bhTranscript.words']]) {
      const variable = one(transcript, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name, `transcript ${name}`);
      replace(variable.initializer, value);
    }
    const ordered = one(transcript, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'sort', 'transcript order');
    replace(ordered, '__bhTranscript.ordered');
    const row = one(transcript, node => ts.isCallExpression(node) && node.arguments[0]?.getText(source) === 'ob', 'native turn element');
    replace(row.arguments[0], '__bhTranscript.Turn');
    const rowProps = row.arguments[1];
    for (const [name, value] of [['issues', '__bhTranscript.issues.get(s2.id)||__bhTranscript.empty'], ['lowConfidenceWords', '__bhTranscript.lowConfidenceWords.get(s2.id)']]) {
      const property = one(rowProps, node => ts.isPropertyAssignment(node) && node.name.getText(source) === name, `turn property ${name}`);
      replace(property.initializer, value);
    }
    patches.push({ start: row.getStart(source) - 1, end: row.getStart(source) - 1, value: '(0,r.jsx)("div",{className:"babel-helper-native-turn",children:' });
    patches.push({ start: row.end - 1, end: row.end - 1, value: '},s2.id)' });
    const activeCallback = one(source, node => ts.isArrowFunction(node) && node.body.getText(source).includes('a11(e13, t12);') && node.body.getText(source).includes('n14.style.filter = "brightness(0.8)"'), 'active region callback');
    replace(activeCallback.body, '{ a11(e13,t12); __bhRender.highlightRegion(r10()[e13]?.plugins.regions,t12); }');
    const timeupdate = one(source, node => ts.isPropertyAssignment(node) && node.name.getText(source) === 'onTimeUpdate' && node.initializer.getText(source).includes('tC2.recordTime'), 'native timeupdate');
    const regionStatement = one(timeupdate, node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'c3'), 'native timeupdate regions');
    const plugin = regionStatement.declarationList.declarations[0].initializer.getText(source);
    const excludedPrefix = one(declaration('t5'), node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'startsWith', 'overlay prefix').arguments[0].getText(source);
    replace(regionStatement, `let c3=${plugin}, m2=__bhRender.activeRegion(c3,t12,_,${excludedPrefix});`);
    exact('i10 && (f3.current.add(n13), i10.setScroll(e13), setTimeout', 'i10 && i10.getScroll() !== e13 && (f3.current.add(n13), i10.setScroll(e13), setTimeout');
    exact('a11 && (a11.scrollLeft = t12);', '__bhRender.setScroll(a11,t12);');
    exact('o2 && (o2.scrollLeft = t12);', '__bhRender.setScroll(o2,t12);');
  } else if (id === 94846) {
    const plugin = declaration('d', ts.isClassDeclaration);
    const onInit = method(plugin, 'onInit');
    const timeupdate = one(onInit, node => ts.isArrowFunction(node) && node.body.getText(source).includes('this.regions.filter'), 'region event scan');
    replace(timeupdate.body, '{ __bhRender.updateRegionEvents(this,t2); }');
    replace(method(plugin, 'virtualAppend').body, '{ __bhRender.virtualAppendRegion(this,e2,t2,n2); }');
    const region = declaration('h', ts.isClassDeclaration);
    const options = method(region, 'setOptions');
    const body = options.body.getText(source);
    replace(options.body, `{ const __bhStart=this.start,__bhEnd=this.end,__bhId=this.id; ${body.slice(1, -1)} if(this.start!==__bhStart||this.end!==__bhEnd||this.id!==__bhId) __bhRender.invalidateRegion(this); }`);
    const previous = one(onInit, node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === 'e2' && ts.isArrayLiteralExpression(item.initializer)), 'previous regions');
    replace(previous, '');
  } else if (id === 60039) {
    const plugin = declaration('a', ts.isClassDeclaration);
    const visible = method(plugin, 'updateVisibleNotches');
    if (visible.parameters.map(parameter => parameter.name.getText(source)).join(',') !== 'e2,t2,n2') throw new Error('Timeline viewport parameter bindings changed');
    replace(visible.body, '{ __bhRender.updateVisibleNotches(this,e2,t2,n2); }');
  } else if (id === 99407) {
    const renderer = declaration('b', ts.isClassDeclaration);
    replace(method(renderer, 'scrollIntoView').body, '{ __bhRender.scrollIntoView(this,t2,e2); }');
    replace(method(renderer, 'setScroll').body, '{ __bhRender.setScroll(this.scrollContainer,t2); }');
  }
  patches.sort((left, right) => right.start - left.start);
  let previous = text.length;
  for (const patch of patches) {
    if (patch.end > previous) throw new Error(`${id}: overlapping AST patches`);
    text = text.slice(0, patch.start) + patch.value + text.slice(patch.end);
    previous = patch.start;
  }
  return text;
}
const recoverySuffix = ';n.d(t,{"RecoveredPageController":function(){return oD;},"RecoveredEditorWorkbench":function(){return oE;},"RecoveredTranscriptPanel":function(){return ad;},"RecoveredTranscriptionLinter":function(){return tM;},"RecoveredHotkeyGroups":function(){return {"global":ia,"segmentControls":io,"overlay":il,"loopControls":is};}});';
function instrumentRecovery(text, conditional = false) {
  const source = ts.createSourceFile('recovery.js', `(${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const factory = source.statements[0].expression.expression;
  if (!ts.isFunctionExpression(factory) || factory.parameters.map(parameter => parameter.name.getText(source)).join(',') !== 'e,t,n') throw new Error('Recovered factory parameter bindings changed');
  for (const name of ['oD', 'oE', 'ad']) one(factory.body, node => ts.isFunctionDeclaration(node) && node.name?.text === name, `recovery function ${name}`);
  one(factory.body, node => ts.isClassDeclaration(node) && node.name?.text === 'tM', 'recovery linter');
  for (const name of ['ia', 'io', 'il', 'is']) {
    one(factory.body, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isArrayLiteralExpression(node.initializer), `recovery hotkeys ${name}`);
  }
  const offset = factory.body.end - 2;
  if (text[offset] !== '}') throw new Error('Recovered factory closing boundary changed');
  return text.slice(0, offset) + (conditional ? `if(__bhRecovered){${recoverySuffix}}` : recoverySuffix) + text.slice(offset);
}
const output = ['// Generated by scripts/generate-native-render-factories.mjs from the exact Oct15 capture.', '// Checked in intentionally: normal release builds do not read capture directories.', 'export function createNativeRenderFactories(__bhRender) {'];
for (const [id, file] of files) {
  const raw = factory(path.join(capture, 'raw', file), id);
  const pretty = factory(path.join(capture, 'pretty', file), id);
  const originals = [raw, pretty];
  if (id === 59327) {
    const fixtureFile = path.resolve(root, '../tools/babel-editor-rebuild/app/src/recovered/source/babel-owned/59327.js');
    const fixture = ts.createSourceFile(fixtureFile, fs.readFileSync(fixtureFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let expression = fixture.statements[0]?.expression;
    while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (!expression || !ts.isFunctionExpression(expression)) throw new Error('Recovered editor must be one captured factory expression');
    const fixtureText = expression.getText(fixture);
    // Compile both expressions in the same context: standalone factory source
    // and a factory nested in a chunk can print redundant IIFE parentheses and
    // Unicode escapes differently. This is maintenance-only; admitted runtime
    // variants below still retain every original byte.
    const normalized = text => transformSync(`(${text})`, { loader: 'js', charset: 'utf8', target: 'esnext', legalComments: 'none' }).code;
    if (normalized(fixtureText) !== normalized(pretty)) {
      throw new Error('Recovered editor differs semantically from the pinned Oct15 factory; do not widen the runtime matcher');
    }
    if (!originals.includes(fixtureText)) originals.push(fixtureText);
  }
  const patched = transform(pretty, id);
  if (id === 59327) {
    const recoveredOriginal = instrumentRecovery(raw);
    const fixtureRegistry = JSON.parse(fs.readFileSync(path.resolve(root, '../tools/babel-editor-rebuild/app/src/recovered/generated/moduleSources.json'), 'utf8'));
    if (fixtureRegistry[id] !== recoveredOriginal) throw new Error('Generated runtime editor is not the exact pinned factory plus verified recovery exports');
    output.push(`const makeEditorFactory = (__bhRecovered) => (${instrumentRecovery(patched, true)});`);
    output.push(`const contract${id} = { id:${id}, originals:${JSON.stringify(originals)}, recoveredOriginal:${JSON.stringify(recoveredOriginal)}, factory:makeEditorFactory(false), recoveredFactory:makeEditorFactory(true) };`);
  } else {
    output.push(`const contract${id} = { id:${id}, originals:${JSON.stringify(originals)}, factory:${patched} };`);
  }
}
output.push(`return [${files.map(([id]) => `contract${id}`).join(',')}]; }\n`);
fs.writeFileSync(path.join(root, 'src/content/native-render-factories.generated.js'), output.join('\n'));
