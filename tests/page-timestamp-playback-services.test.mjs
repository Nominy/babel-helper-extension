import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function importBundledTs(relativePath, label) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `babel-helper-${label}-`));
  const outfile = path.join(tempDir, `${label}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020'
  });

  try {
    return await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

class FakeCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class FakeElement {}
class FakeHTMLElement extends FakeElement {}
class FakeHTMLDivElement extends FakeHTMLElement {}
class FakeHTMLMediaElement extends FakeHTMLElement {}
class FakeHTMLTableRowElement extends FakeHTMLElement {}
class FakeShadowRoot {}

function installPageGlobals(services) {
  const pageWindow = new EventTarget();
  const pageDocument = {
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  Object.assign(pageWindow, {
    BabelMods: { unsafe: { services } },
    document: pageDocument,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout,
    window: pageWindow
  });
  Object.assign(globalThis, {
    CustomEvent: FakeCustomEvent,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLDivElement: FakeHTMLDivElement,
    HTMLMediaElement: FakeHTMLMediaElement,
    HTMLTableRowElement: FakeHTMLTableRowElement,
    ShadowRoot: FakeShadowRoot,
    document: pageDocument,
    window: pageWindow
  });

  return pageWindow;
}

function callEventFacade(pageWindow, requestType, responseType, operation, payload = {}) {
  const id = `${operation}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pageWindow.removeEventListener(responseType, onResponse);
      reject(new Error(`Timed out waiting for ${responseType}`));
    }, 250);
    function onResponse(event) {
      if (event.detail?.id !== id) {
        return;
      }
      clearTimeout(timeout);
      pageWindow.removeEventListener(responseType, onResponse);
      resolve(event.detail.result);
    }

    pageWindow.addEventListener(responseType, onResponse);
    pageWindow.dispatchEvent(
      new FakeCustomEvent(requestType, {
        detail: { id, operation, payload }
      })
    );
  });
}

test('timestamp and playback facades stay late-bound across mod layers and teardown', async () => {
  const { createServiceRegistry } = await importBundledTs(
    'src/mod-platform/service-registry.ts',
    'page-service-registry'
  );
  const services = createServiceRegistry();
  const pageWindow = installPageGlobals(services);

  await importBundledTs('src/content/playback-bridge.ts', 'playback-bridge');
  await importBundledTs('src/content/timestamp-bridge.ts', 'timestamp-bridge');

  const playbackFacade = pageWindow.__babelHelperPlaybackBridge;
  const timestampFacade = pageWindow.__babelHelperTimestampBridge;
  assert.equal(playbackFacade.getPlaybackState().reason, 'playback-unavailable');
  assert.equal(
    (await timestampFacade.setBoundaryTime({ targetSeconds: Number.NaN })).reason,
    'invalid-target'
  );

  const playbackDecorator = services.decorate(
    'page.playback',
    (next) => ({
      ...next,
      getPlaybackState() {
        return { ...next.getPlaybackState(), decoratedBy: 'mod.playback' };
      }
    }),
    { owner: 'mod.playback' }
  );
  assert.equal(playbackFacade.getPlaybackState().decoratedBy, 'mod.playback');
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-playback-request',
        'babel-helper-playback-response',
        'state'
      )
    ).decoratedBy,
    'mod.playback'
  );
  playbackDecorator.dispose();
  assert.equal(playbackFacade.getPlaybackState().decoratedBy, undefined);
  assert.equal(playbackFacade.getPlaybackState().reason, 'playback-unavailable');
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-playback-request',
        'babel-helper-playback-response',
        'state'
      )
    ).reason,
    'playback-unavailable'
  );

  const timestampReplacement = services.replace(
    'page.timestamp',
    {
      setBoundaryTime(payload) {
        return { ok: true, replacedBy: 'mod.timestamp', payload };
      }
    },
    { owner: 'mod.timestamp' }
  );
  assert.equal(
    (await timestampFacade.setBoundaryTime({ targetSeconds: 12 })).replacedBy,
    'mod.timestamp'
  );
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-timestamp-request',
        'babel-helper-timestamp-response',
        'set-boundary-time',
        { targetSeconds: 12 }
      )
    ).replacedBy,
    'mod.timestamp'
  );
  timestampReplacement.dispose();
  assert.equal(
    (await timestampFacade.setBoundaryTime({ targetSeconds: Number.NaN })).reason,
    'invalid-target'
  );
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-timestamp-request',
        'babel-helper-timestamp-response',
        'set-boundary-time',
        { targetSeconds: Number.NaN }
      )
    ).reason,
    'invalid-target'
  );

  const survivingDecorator = services.decorate(
    'page.playback',
    (next) => ({
      ...next,
      getPlaybackState() {
        return { ...next.getPlaybackState(), decoratedAfterReprovide: true };
      }
    }),
    { owner: 'mod.survivor' }
  );
  pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-bridge-teardown'));
  assert.equal(pageWindow.__babelHelperPlaybackBridge, undefined);
  assert.equal(pageWindow.__babelHelperTimestampBridge, undefined);
  assert.throws(() => services.invoke('page.playback', 'getPlaybackState'));

  const replacementBase = services.provide(
    'page.playback',
    {
      getPlaybackState() {
        return { ok: true, source: 'replacement-base' };
      }
    },
    { owner: 'test:replacement-base' }
  );
  assert.deepEqual(services.invoke('page.playback', 'getPlaybackState'), {
    ok: true,
    source: 'replacement-base',
    decoratedAfterReprovide: true
  });
  replacementBase.dispose();
  survivingDecorator.dispose();
});
