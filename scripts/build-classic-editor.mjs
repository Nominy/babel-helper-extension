import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capture = path.resolve(repo, '../tools/babel-editor-rebuild/exports/2026-09-05-live');
const readable = path.resolve(capture, '../2026-10-13-live/comparison/editor-old-73681.pretty.js');
const hosts = new Set(['24289', '92827', '91284']);
const hash = text => createHash('sha256').update(text).digest('hex');
const printer = ts.createPrinter({ removeComments: false });
function parse(source) {
  const file = ts.createSourceFile('capture.js', `(${source.replace(/^\s*\(/, '').replace(/\);?\s*$/, '')})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error('Captured factory is not valid static JavaScript');
  const factory = file.statements[0].expression.expression;
  if (!ts.isFunctionExpression(factory)) throw new Error('Captured factory must be a function');
  const options = { allowJs: true, noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === 'capture.js' ? file : undefined;
  const checker = ts.createProgram(['capture.js'], options, host).getTypeChecker();
  const symbols = new Map(), names = new Map();
  for (const statement of factory.body.statements) {
    const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations :
      ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? [statement] : [];
    for (const declaration of declarations) if (declaration.name && ts.isIdentifier(declaration.name)) {
      symbols.set(checker.getSymbolAtLocation(declaration.name), declaration);
      names.set(declaration.name.text, declaration);
    }
  }
  const refs = node => {
    const found = new Set();
    const visit = child => { if (ts.isIdentifier(child)) { const declaration = symbols.get(checker.getSymbolAtLocation(child)); if (declaration) found.add(declaration); } ts.forEachChild(child, visit); };
    visit(node);
    return found;
  };
  return { file, factory, checker, names, refs };
}
function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function print(node, file) { return printer.printNode(ts.EmitHint.Unspecified, node, file); }
function patches(source, edits) {
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + value + source.slice(end);
  return source;
}
function select(source, roots, exportNames) {
  const model = parse(source), { file, factory, names, refs } = model;
  const selected = new Set(roots.map(name => { const node = names.get(name); if (!node) throw new Error(`Missing captured declaration ${name}`); return node; }));
  for (const node of selected) for (const dependency of refs(node)) selected.add(dependency);
  const body = [];
  for (const statement of factory.body.statements) {
    if (ts.isVariableStatement(statement)) {
      const kept = statement.declarationList.declarations.filter(declaration => selected.has(declaration));
      if (kept.length) body.push(print(ts.factory.updateVariableStatement(statement, statement.modifiers, ts.factory.updateVariableDeclarationList(statement.declarationList, kept)), file));
    } else if (selected.has(statement)) body.push(print(statement, file));
    else if (ts.isExpressionStatement(statement)) {
      // Retain initialization of retained declarations (e.g. Radix displayName),
      // never the unrelated schema constructors or old page export registration.
      const expression = statement.expression;
      if (ts.isStringLiteral(expression)) body.push(print(statement, file));
      else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && [...refs(expression.left)].some(node => selected.has(node))) body.push(print(statement, file));
    }
  }
  const requireName = factory.parameters[2].name.text, exportsName = factory.parameters[1].name.text;
  body.push(`${requireName}.d(${exportsName},{${Object.entries(exportNames).map(([key, value]) => `${JSON.stringify(key)}:()=>${value}`).join(',')}});`);
  return `function(${factory.parameters.map(parameter => parameter.name.text).join(',')}){${body.join('\n')}}`;
}
function instrumentRow(source) {
  const { file, names } = parse(source), edits = [];
  const replace = (node, value) => edits.push([node.getStart(file), node.end, value]);
  for (const name of ['nX', 'nZ', 'nS', 'nN', 'nD', 'nj', 'tf', 'nq', 'nY', 'nL']) {
    const fn = names.get(name);
    if (!fn) throw new Error(`Captured view ${name} is unavailable`);
    walk(fn.body, node => {
      if (name === 'nL' && ts.isPropertyAssignment(node) && node.name.getText(file) === 'role' && node.initializer.getText(file) === '"presentation"') {
        // Keep the group slot so native highlightedIndex still addresses DOM children.
        edits.push([node.parent.getStart(file) + 1, node.parent.getStart(file) + 1, 'hidden:e11.label==="Tags",']);
      }
      if (name === 'nX' && ts.isCallExpression(node) && node.expression.getText(file) === 'nq') edits.push([node.end - 1, node.end - 1, ',e11.foreignOptions']);
      if (name === 'nY' && ts.isPropertyAccessExpression(node) && node.getText(file) === 'L.v') replace(node, 'arguments[4]');
      if (name === 'nq' && ts.isPropertyAccessExpression(node) && node.getText(file) === 'L.v') replace(node, 'classicForeignOptions');
      if (name === 'nq' && ts.isCallExpression(node) && node.expression.getText(file) === 'nY') edits.push([node.end - 1, node.end - 1, node.arguments.length === 3 ? ',\"attribute\",classicForeignOptions' : ',classicForeignOptions']);
      if (name === 'nX' && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.name.getText(file) === '{ data: eb2 }') replace(node, 'eb2 = e10.classicAutocomplete');
      if (name === 'nX' && ts.isCallExpression(node) && node.expression.getText(file) === '(0, a.useMemo)' && node.getText(file).includes('(0, M.ze)')) replace(node, 'e10.classicAutocomplete');
      if (name === 'nX' && ts.isVariableDeclaration(node) && node.name.getText(file) === 'i3' && node.initializer?.getText(file).includes('["MIS: ", "PRO: "]')) replace(node.initializer, 'e10.classicAutocomplete.curlyTags');
      if (name === 'nZ' && ts.isVariableDeclaration(node) && node.name.getText(file) === 'x2') replace(node.initializer, 'n.classic.useAutocomplete()');
      if ((name === 'nS' || name === 'nN') && ts.isPropertyAssignment(node) && node.name.getText(file) === 'onDoubleClick') replace(node.initializer, `e10.readOnly ? undefined : ${node.initializer.getText(file)}`);
      if (name === 'nX' && ts.isCallExpression(node) && node.expression.getText(file) === 'T2' && node.arguments.map(argument => argument.getText(file)).join(',') === 'e11,t11') replace(node, 'classicRowControl.canCommitDraft() && T2(e11,t11)');
      if (name === 'nX' && ts.isVariableDeclaration(node) && node.name.getText(file) === 'eD2') {
        replace(node.initializer, '(0,a.useCallback)(()=>{classicRowControl.requestFocus();eg2(true);},[X2])');
      }
      if (name === 'nX' && ts.isCallExpression(node) && node.expression.getText(file) === 'em2' && node.arguments[0]?.getText(file) === 'ev2') replace(node, 'classicRowControl.canSyncModelText() && em2(ev2)');
      if (name === 'nS' && ts.isCallExpression(node) && node.arguments[0]?.getText(file) === 'tp.pj') {
        const props = node.arguments[1];
        edits.push([props.getStart(file) + 1, props.getStart(file) + 1, '"data-babel-classic-speaker":"true",']);
      }
      if (name === 'nD' && ts.isCallExpression(node) && ['(0, r.jsx)', '(0, r.jsxs)'].includes(node.expression.getText(file)) && node.arguments[0]?.getText(file) === '"button"') {
        const props = node.arguments[1], onClick = props.properties.find(property => property.name?.getText(file) === 'onClick');
        const marker = props.properties.some(property => property.name?.getText(file) === '"aria-label"') ? '"data-babel-classic-lint-status":true,' : '';
        const disabled = marker || onClick?.getText(file).includes('w2(') ? '' : 'disabled:e10.readOnly,';
        if (marker && onClick) replace(onClick.initializer, `e10.readOnly ? event => event.stopPropagation() : ${onClick.initializer.getText(file)}`);
        edits.push([props.getStart(file) + 1, props.getStart(file) + 1, marker + disabled]);
      }
      if (name === 'nD' && ts.isCallExpression(node) && node.expression.getText(file) === '(0, a.useEffect)') {
        const body = node.arguments[0].body;
        edits.push([body.getStart(file) + 1, body.getStart(file) + 1, 'if(e10.readOnly)return;']);
      }
      if (name === 'tf' && ts.isPropertyAssignment(node) && node.name.getText(file) === 'children' && ts.isArrayLiteralExpression(node.initializer) && node.initializer.elements.length === 7) {
        const cells = node.initializer.elements;
        edits.push([cells[4].getStart(file), cells[4].getStart(file), 'e10.showReviewers && (0,r.jsx)(tp.pj,{}),']);
        replace(cells[6], `!e10.hideActions && ${cells[6].getText(file)}`);
      }
      if (name === 'nX' && ts.isCallExpression(node) && ['(0, r.jsx)', '(0, r.jsxs)'].includes(node.expression.getText(file))) {
        const type = node.arguments[0]?.getText(file), props = node.arguments[1];
        if (!props || !ts.isObjectLiteralExpression(props)) return;
        const extra = type === 'tp.SC' ? '"data-annotation-id":g2.id,"data-babel-classic-row":"true","data-babel-classic-active":b2?"true":"false",' : type === 't5.g' ? 'readOnly:X2,' : ['nS', 'nN', 'nD'].includes(type) ? 'readOnly:X2,' : '';
        if (extra) edits.push([props.getStart(file) + 1, props.getStart(file) + 1, extra]);
        if (type === 'nj') replace(node, `X2 || !e10.classicActions ? null : ${node.getText(file)}`);
      }
      if (name === 'tf' && ts.isCallExpression(node) && node.arguments[0]?.getText(file) === 'tp.SC') {
        const props = node.arguments[1];
        edits.push([props.getStart(file) + 1, props.getStart(file) + 1, '"data-babel-classic-ghost":true,']);
      }
    });
    const result = fn.body.statements.find(statement => ts.isReturnStatement(statement));
    if (name === 'nq') edits.push([fn.body.getStart(file) + 1, fn.body.getStart(file) + 1, 'const classicForeignOptions=arguments[5];']);
    if (name === 'nX') edits.push([result.getStart(file), result.getStart(file), 'const classicRowControl = n.classic.useRow({annotation:g2,readOnly:X2,rootRef:ed2,inputRef:ec2,text:eu2,setText:em2,change:eL2,flush:()=>ex2.flush(),cancel:()=>ex2.cancel(),enterEdit:eD2,autocomplete:ew2,isRTL:O2});\n']);
    if (name === 'nZ') edits.push([result.getStart(file), result.getStart(file), 'n.classic.useSlate({editor:u2,readOnly:s2,onValueChange:S2,flush:N2,transforms:nM.YR,editorApi:nM.ML,historyEditor:nP.HistoryEditor,autocomplete:{state:p2,setHighlightedIndex:index=>f2(previous=>({...previous,highlightedIndex:index})),selectSuggestion:w2,dismiss:y2}});\n']);
  }
  return patches(file.text, edits);
}
function bindReactNamespace(source, moduleId) {
  const { file, factory, checker } = parse(source), requireSymbol = checker.getSymbolAtLocation(factory.parameters[2].name);
  const edits = [];
  walk(factory.body, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 't' ||
        checker.getSymbolAtLocation(node.expression.expression) !== requireSymbol) return;
    const [namespace, mode] = node.arguments;
    const declaration = namespace && ts.isIdentifier(namespace) ? checker.getSymbolAtLocation(namespace)?.valueDeclaration : null;
    const imported = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : null;
    if (node.arguments.length !== 2 || !mode || !ts.isNumericLiteral(mode) || mode.text !== '2' ||
        !imported || !ts.isCallExpression(imported) || checker.getSymbolAtLocation(imported.expression) !== requireSymbol ||
        imported.arguments.length !== 1 || imported.arguments[0].text !== '24289') throw new Error(`Captured React namespace contract changed in ${moduleId}`);
    // These three Radix factories read only named React hooks. Their webpack
    // mode-2 namespace wrapper adds no behavior to the genuine host exports.
    edits.push([node.getStart(file), node.end, namespace.getText(file)]);
  });
  if (edits.length !== 1) throw new Error(`Captured React namespace wrapper changed in ${moduleId}`);
  return patches(file.text, edits);
}
function exposeHistoryEditor(source) {
  const { file, factory, names, refs } = parse(source), history = names.get('u'), withHistory = names.get('c');
  const initializer = history && ts.isVariableDeclaration(history) ? history.initializer : null;
  const required = ['isHistoryEditor', 'withNewBatch', 'withMerging', 'withoutMerging', 'withoutSaving'];
  if (!initializer || !ts.isObjectLiteralExpression(initializer) || !required.every(name => initializer.properties.some(property => property.name?.getText(file) === name)) ||
      !withHistory || !refs(withHistory).has(history)) throw new Error('Captured Slate HistoryEditor contract changed');
  const requireName = factory.parameters[2].name.text, exportsName = factory.parameters[1].name.text;
  const statement = `;${requireName}.d(${exportsName},{HistoryEditor:()=>${history.name.text}});`;
  return patches(file.text, [[factory.body.end - 1, factory.body.end - 1, statement]]);
}
function dependencies(source, moduleId) {
  let model;
  try { model = parse(source); }
  catch (error) { throw new Error(`Cannot inspect captured dependencies in module ${moduleId}: ${error.message}`); }
  const { file, factory, checker } = model, symbol = factory.parameters[2] ? checker.getSymbolAtLocation(factory.parameters[2].name) : null, ids = new Set();
  walk(factory.body, node => {
    if (symbol && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression) === symbol) {
      if (node.arguments.length !== 1 || !ts.isNumericLiteral(node.arguments[0])) throw new Error(`Dynamic captured module import is not permitted in ${moduleId}`);
      ids.add(node.arguments[0].text);
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && ['eval', 'Function'].includes(node.expression.text)) throw new Error(`Executable string compilation is not permitted in Classic module ${moduleId}`);
    if (symbol && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression) === symbol && !['d', 'n', 'o', 'r', 'g', 'nc', 'classic'].includes(node.name.text)) throw new Error(`Unsupported captured require helper ${node.name.text} in module ${moduleId}`);
  });
  return ids;
}
function scopeCss(source) {
  const scope = ':where([data-babel-classic-surface],[data-babel-classic-portals])';
  // Balanced scanner: commas within :is(), attribute strings, and data URLs
  // are not selector/rule boundaries. Keyframe steps remain unprefixed.
  const split = text => {
    const parts = []; let start = 0, depth = 0, quote = '';
    for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '\\') { i++; continue; } if (quote) { if (c === quote) quote = ''; continue; } if (c === '"' || c === "'") quote = c; else if ('(['.includes(c)) depth++; else if (')]'.includes(c)) depth--; else if (c === ',' && !depth) { parts.push(text.slice(start, i)); start = i + 1; } }
    parts.push(text.slice(start)); return parts;
  };
  function rules(text, keyframes = false) {
    let out = '', start = 0, quote = '', parens = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(' || c === '[') parens++; else if (c === ')' || c === ']') parens--;
      if (c !== '{' || parens) continue;
      const header = text.slice(start, i).trim(); let depth = 1, end = i + 1, innerQuote = '';
      for (; end < text.length && depth; end++) { const q = text[end]; if (q === '\\') { end++; continue; } if (innerQuote) { if (q === innerQuote) innerQuote = ''; continue; } if (q === '"' || q === "'") innerQuote = q; else if (q === '{') depth++; else if (q === '}') depth--; }
      if (depth) throw new Error('Unclosed captured CSS rule');
      const body = text.slice(i + 1, end - 1);
      if (/^@(media|supports|layer|container)\b/.test(header)) out += `${header}{${rules(body)}}`;
      else if (/^@(?:-webkit-)?keyframes\b/.test(header)) out += `${header}{${rules(body, true)}}`;
      else if (/^@font-face\b/.test(header) || keyframes) out += `${header}{${body}}`;
      else if (!header.startsWith('@')) out += `${split(header).map(selector => {
        const clean = selector.trim();
        if (/^(?::root|html|body)(?=$|[\s.:#>\[])/.test(clean)) return clean.replace(/^(?::root|html|body)/, scope).replace(/\s+body\b/g, '');
        return `${scope} ${clean}`;
      }).join(',')}{${body}}`;
      i = end - 1; start = end;
    }
    return out;
  }
  return rules(source.replace(/\/\*[\s\S]*?\*\//g, ''));
}
export async function buildClassicEditor() {
  const destination = path.join(repo, 'src/classic/classic-editor.generated.ts');
  const assets = path.join(repo, 'assets/classic');
  const manifestPath = path.join(assets, 'capture-integrity.json');
  let modules;
  try { modules = JSON.parse(await fs.readFile(path.join(capture, 'modules.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Isolated staging consumes the already compiled static package. It must
    // match the generator-written integrity record, never silently regenerate.
    const integrity = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (hash(await fs.readFile(destination)) !== integrity.generated) throw new Error('Classic static package integrity mismatch');
    for (const [name, digest] of Object.entries(integrity.assets)) if (hash(await fs.readFile(path.join(assets, name))) !== digest) throw new Error(`Classic asset integrity mismatch: ${name}`);
    return;
  }
  const readableSource = await fs.readFile(readable, 'utf8');
  const root = select(instrumentRow(readableSource), ['nX', 'tf', 'tp', 'tt'], { Row: 'nX', GhostRow: 'tf', Table: 'tp', TooltipProvider: 'tt' });
  const factories = new Map([['73681', root]]), queue = new Set(dependencies(root, '73681'));
  // The row needs only warning keys and literal text fixes, not the schema
  // constructors/old project policies bundled into these shared namespaces.
  const specialized = {
    8946: select(modules[8946], ['E', '_'], { xA: 'E', xp: '_.xp' }),
    92113: select(modules[92113], ['i', 'r'], { C1: 'i', xp: 'r' })
  };
  queue.add('92113');
  const reactNamespaceModules = { 26239: true, 56490: true, 98873: true };
  for (const id of queue) {
    if (hosts.has(id)) continue;
    let source = specialized[id] || modules[id];
    if (!source) throw new Error(`Missing captured dependency ${id}`);
    if (id === '63682') {
      const model = parse(source), edits = [];
      walk(model.factory, node => { if (ts.isCallExpression(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(model.file) === 'Function' && node.expression.arguments[0]?.text === 'return this') edits.push([node.getStart(model.file), node.end, 'globalThis']); });
      source = patches(model.file.text, edits);
    }
    if (reactNamespaceModules[id]) source = bindReactNamespace(source, id);
    if (id === '66333') source = exposeHistoryEditor(source);
    factories.set(id, source);
    for (const dependency of dependencies(source, id)) queue.add(dependency);
  }
  const generated = `// @ts-nocheck\n// Generated by scripts/build-classic-editor.mjs from the September 5 capture.\n// Private static factories; never registered in the live webpack registry.\nexport const captureRevision = ${JSON.stringify({ captured: '2026-09-05', source: hash(modules[73681]), readable: hash(readableSource), modules: [...factories.keys()].map(Number), hosts: [...hosts].map(Number) })};\nexport const classicFactories = {\n${[...factories].map(([id, source]) => `${JSON.stringify(id)}:${source}`).join(',\n')}\n};\n`;
  await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.mkdir(assets, { recursive: true });
  const styles = JSON.parse(await fs.readFile(path.join(capture, 'styles.json'), 'utf8'));
  const fonts = JSON.parse(await fs.readFile(path.join(capture, 'font-assets.json'), 'utf8'));
  let css = (await Promise.all(styles.map(style => fs.readFile(path.join(capture, style.file), 'utf8')))).join('\n');
  const fontNames = [...new Set([...css.matchAll(/@font-face\s*\{[^}]*?font-family:([^;}]+)/g)].map(match => match[1].trim()))];
  for (const name of fontNames) css = css.split(name).join(`BabelClassic_${name.replace(/["']/g, '').replace(/\s/g, '_')}`);
  const animations = [...new Set([...css.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)/g)].map(match => match[1]))];
  for (const name of animations) css = css.replace(new RegExp(`(?<![\\w-])${name}(?![\\w-])`, 'g'), `babel-classic-${name}`);
  css = scopeCss(css.replace(/url\((?:["'])?(?:\.\.\/media\/|\/_next\/static\/media\/)([^)'"\s]+)["']?\)/g, 'url("chrome-extension://__MSG_@@extension_id__/dist/classic/fonts/$1")'));
  css += '\n[data-babel-classic-surface],[data-babel-classic-portals]{--font-sans:BabelClassic___Inter_f367f3,BabelClassic___Inter_Fallback_f367f3;font-family:var(--font-sans),Arial,sans-serif;font-size:12px;line-height:1.5;color:#171717;background:#fff;color-scheme:light}\n[data-babel-classic-surface]{width:100%;min-width:0}[data-babel-classic-surface] table{width:100%;border-collapse:collapse}[data-babel-classic-surface] textarea{width:100%}[data-babel-classic-surface] th{position:sticky;top:0;background:white;text-align:left;z-index:1}[data-babel-classic-portals]{position:relative;z-index:1000}\n[data-babel-classic-surface][data-hide-timestamps] [data-babel-classic-ghost] td:nth-child(-n+4){display:none}\n';
  const assetHashes = { 'editor.css': hash(css) };
  await fs.mkdir(path.join(assets, 'fonts'), { recursive: true });
  for (const font of fonts) { const bytes = await fs.readFile(path.join(capture, font.file)); if (hash(bytes) !== font.sha256) throw new Error(`Captured font changed: ${font.file}`); const name = `fonts/${path.basename(font.file)}`; await fs.writeFile(path.join(assets, name), bytes); assetHashes[name] = hash(bytes); }
  await fs.writeFile(destination, generated); await fs.writeFile(path.join(assets, 'editor.css'), css);
  await fs.writeFile(manifestPath, JSON.stringify({ generated: hash(generated), assets: assetHashes }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildClassicEditor();
