import assert from 'node:assert/strict';
import ts from 'typescript';

// Keep captured code intact; only discover its declaration and callback boundaries.
export function createNativeSource(text) {
  assert.ok(text, 'The current captured native source must be available');
  const source = ts.createSourceFile('native-oracle.js', `(${text})`, ts.ScriptTarget.Latest, true);
  assert.equal(source.parseDiagnostics.length, 0, 'The captured native source must parse');
  const callbackFactories = new Map();

  function find(root, predicate, label) {
    const matches = [];
    function visit(node) {
      if (predicate(node)) matches.push(node);
      ts.forEachChild(node, visit);
    }
    visit(root);
    assert.equal(matches.length, 1, `Expected one captured native ${label}`);
    return matches[0];
  }

  function callbackCall(node) {
    if (!ts.isCallExpression(node)) return false;
    let callee = node.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) callee = callee.right;
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'useCallback';
  }

  return {
    declaration(name) {
      const node = find(source, node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
        ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name, `declaration ${name}`);
      return ts.isVariableDeclaration(node) ? `const ${node.getText(source)};` : node.getText(source);
    },
    callback(name, scope, hookProperty) {
      const parameters = Object.keys(scope);
      const key = JSON.stringify([hookProperty, name, parameters]);
      let factory = callbackFactories.get(key);
      if (!factory) {
        // Hook return properties identify the lexical scope without pinning its local aliases.
        const root = hookProperty ? find(source, node => ts.isFunctionExpression(node) &&
          node.body.statements.some(statement => ts.isReturnStatement(statement) && statement.expression &&
            ts.isObjectLiteralExpression(statement.expression) && statement.expression.properties.some(property =>
              ts.isPropertyAssignment(property) && property.name.getText(source) === hookProperty)), `hook returning ${hookProperty}`) : source;
        const declaration = find(root, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
          node.name.text === name && node.initializer && callbackCall(node.initializer), `callback ${name}`);
        const callback = declaration.initializer.arguments[0];
        assert.ok(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)), `Native ${name} must contain a callback`);
        factory = new Function(...parameters, `return (${callback.getText(source)});`);
        callbackFactories.set(key, factory);
      }
      return factory(...Object.values(scope));
    }
  };
}
