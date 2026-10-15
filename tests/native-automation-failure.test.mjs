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

test('native failure is accessible, deduplicated and actionable, with feature-scoped dismissal', t => {
  const saved = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let reloads = 0;
  class Element extends EventTarget {
    style = {}; dataset = {}; children = []; attributes = {}; ownText = '';
    constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.ownText = value; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
    append(...children) { for (const child of children) this.appendChild(child); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    querySelectorAll(tag) {
      return this.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.querySelectorAll(tag)]);
    }
  }
  const body = new Element('body');
  const action = (root, name) => root.querySelectorAll('button')
    .find(button => name.test(button.getAttribute('aria-label') || button.textContent));
  Object.assign(globalThis, {
    window: { location: { reload() { reloads++; } } },
    document: {
      getElementById: id => body.children.find(root => root.id === id),
      createElement: tag => new Element(tag),
      body
    }
  });
  t.after(() => { for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  } });
  showNativeAutomationFailure('Playback', 'unsupported FiberRoot descriptor');
  showNativeAutomationFailure('Playback', 'unsupported FiberRoot descriptor');
  assert.equal(body.children.length, 1);
  const failure = body.children[0];
  assert.equal(failure.getAttribute('role'), 'alert');
  assert.match(failure.textContent, /unsupported FiberRoot descriptor/);
  const reload = action(failure, /reload/i);
  assert.ok(reload, 'the alert exposes an accessible reload action');
  reload.dispatchEvent(new Event('click'));
  assert.equal(reloads, 1);
  const dismiss = action(failure, /dismiss/i);
  assert.ok(dismiss, 'the alert exposes an accessible dismiss action');
  dismiss.dispatchEvent(new Event('click'));
  assert.equal(body.children.length, 0, 'dismiss removes the alert');
  assert.equal(reloads, 1, 'dismiss does not reload the page');
  showNativeAutomationFailure('Playback', 'another unsupported native hook');
  assert.equal(body.children.length, 0, 'dismissal suppresses subsequent notices for the same feature');
  showNativeAutomationFailure('History', 'unsupported history hook');
  assert.equal(body.children.length, 1, 'dismissal does not suppress other feature notices');
  assert.equal(body.children[0].getAttribute('role'), 'alert');
  assert.match(body.children[0].textContent, /unsupported history hook/);
});
