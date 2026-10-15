import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/ui/native-automation-failure.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  plugins: [{ name: 'theme-fixture', setup(build) {
    build.onResolve({ filter: /^@nominy\/babel-extension-frontend$/ }, () => ({ path: 'theme', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const themeRoot = element => { element.dataset.theme = "white"; }; export const applyComponent = (element, name) => { element.dataset.component = name; };' }));
  } }]
});
const { showNativeAutomationFailure } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

test('native failure is an accessible, deduplicated visible notification with reload action', t => {
  const saved = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const roots = [];
  let reloads = 0;
  class Element extends EventTarget {
    style = {}; dataset = {}; children = []; attributes = {};
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { this.children.push(...children); }
  }
  Object.assign(globalThis, {
    window: { location: { reload() { reloads++; } } },
    document: {
      getElementById: id => roots.find(root => root.id === id),
      createElement: () => new Element(),
      body: { appendChild(root) { roots.push(root); } }
    }
  });
  t.after(() => { for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  } });
  showNativeAutomationFailure('Playback', 'unsupported FiberRoot descriptor');
  showNativeAutomationFailure('Playback', 'unsupported FiberRoot descriptor');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].attributes.role, 'alert');
  assert.match(roots[0].children[1].textContent, /unsupported FiberRoot descriptor/);
  const button = roots[0].children[2];
  button.dispatchEvent(new Event('click'));
  assert.equal(reloads, 1);
});
