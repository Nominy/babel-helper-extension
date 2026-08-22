import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class TestServiceRegistry {
  constructor() {
    this.base = new Map();
    this.replacements = new Map();
    this.decorators = new Map();
    this.providedId = null;
    this.providedService = null;
    this.providerDisposed = false;
  }

  provide(id, service) {
    this.providedId = id;
    this.providedService = service;
    this.base.set(id, service);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.providerDisposed = true;
        this.base.delete(id);
      }
    };
  }

  replace(id, service) {
    const layers = this.replacements.get(id) || [];
    const layer = { service };
    layers.push(layer);
    this.replacements.set(id, layers);
    return {
      dispose: () => {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      }
    };
  }

  decorate(id, decorate) {
    const layers = this.decorators.get(id) || [];
    const layer = { decorate };
    layers.push(layer);
    this.decorators.set(id, layers);
    return {
      dispose: () => {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      }
    };
  }

  current(id) {
    const replacements = this.replacements.get(id) || [];
    let service = replacements.length
      ? replacements[replacements.length - 1].service
      : this.base.get(id);
    for (const { decorate } of this.decorators.get(id) || []) {
      service = decorate(service);
    }
    if (!service) throw new Error(`Missing service ${id}`);
    return service;
  }

  invoke(id, method, ...args) {
    const service = this.current(id);
    return Reflect.apply(service[method], service, args);
  }
}

const operationMethods = new Map([
  ['ensure', 'ensureLens'],
  ['update', 'updateLens'],
  ['destroy', 'destroyLens'],
  ['loop-start', 'startLoop'],
  ['selection-time-range', 'measureSelectionTimeRange'],
  ['trim-segment-audio', 'findTrimTargets'],
  ['find-segment-silence-runs', 'findSegmentSilenceRuns'],
  ['find-nearest-speech-island', 'findNearestSpeechIsland'],
  ['resolve-visible-lane-targets', 'resolveVisibleLaneTargets'],
  ['prepare-auto-segment-text-redistribution', 'prepareAutoSegmentTextRedistributionSession'],
  ['auto-segment-redistribute-text', 'redistributeAutoSegmentText'],
  ['transcribe-segment-audio', 'transcribeSegmentAudio'],
  ['destroy-auto-segment-text-redistribution-session', 'destroyAutoSegmentTextRedistributionSession'],
  ['trim-segment-audio-for-speaker', 'findTrimTargetsForSpeaker'],
  ['extend-segment-audio-to-silence', 'findExtendTargets'],
  ['extend-segment-audio-to-silence-for-speaker', 'findExtendTargetsForSpeaker'],
  ['zoom-set', 'setZoomValue'],
  ['waveform-scale-unlock-enable', 'enableWaveformScaleUnlock'],
  ['waveform-scale-unlock-disable', 'disableWaveformScaleUnlock'],
  ['waveform-scale-set', 'setWaveformScaleByIndex'],
  ['loop-stop', 'stopLoop'],
  ['seek-source', 'seekSource'],
  ['navigate-source', 'navigateSource'],
  ['minimap-data', 'getMinimapData']
]);

async function loadBridge() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-magnifier-mod-'));
  const outfile = path.join(tempDir, 'magnifier-bridge.mjs');
  await build({
    entryPoints: [path.resolve('src/content/magnifier-bridge.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  });
  await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`);
}

test('page.magnifier keeps every legacy operation late-bound, preserves progress, and disposes ownership', async () => {
  const services = new TestServiceRegistry();
  const pageWindow = new EventTarget();
  const pageDocument = new EventTarget();
  pageWindow.BabelMods = { unsafe: { services } };

  globalThis.window = pageWindow;
  globalThis.document = pageDocument;
  globalThis.CustomEvent = TestCustomEvent;
  globalThis.HTMLElement = class HTMLElement {};

  const responses = [];
  pageWindow.addEventListener('babel-helper-magnifier-response', (event) => {
    responses.push(event.detail);
  });

  await loadBridge();

  assert.equal(services.providedId, 'page.magnifier');
  assert.deepEqual(
    [...operationMethods.values()].filter((method) => typeof services.providedService[method] !== 'function'),
    []
  );
  assert.equal(typeof services.providedService.findNearestSpeechIslandForResolvedWave, 'function');

  const replacementService = new Proxy(
    {},
    {
      get(_target, method) {
        if (method === 'transcribeSegmentAudio') {
          return async (_payload, onProgress) => {
            onProgress({ phase: 'streaming', completed: 2, total: 3 });
            return { ok: true, method };
          };
        }
        return (...args) => ({ ok: true, method, args });
      }
    }
  );
  const replacement = services.replace('page.magnifier', replacementService);
  const decorator = services.decorate('page.magnifier', (next) =>
    new Proxy(next, {
      get(target, method) {
        const member = Reflect.get(target, method);
        if (method !== 'findTrimTargetsForSpeaker') return member;
        return (...args) => ({ ...Reflect.apply(member, target, args), decorated: true });
      }
    })
  );

  const direct = pageWindow.__babelHelperMagnifierBridge.findTrimTargetsForSpeaker(
    'speaker-a',
    1,
    2,
    0.1,
    0.05
  );
  assert.equal(direct.method, 'findTrimTargetsForSpeaker');
  assert.equal(direct.decorated, true);
  const directNearest =
    pageWindow.__babelHelperMagnifierBridge.findNearestSpeechIsland({}, {}, 4, 1, 0.2, 0.05);
  assert.equal(directNearest.method, 'findNearestSpeechIslandForResolvedWave');

  let requestSequence = 0;
  for (const [operation, method] of operationMethods) {
    const id = `request-${requestSequence++}`;
    pageWindow.dispatchEvent(
      new TestCustomEvent('babel-helper-magnifier-request', {
        detail: { id, operation, payload: {} }
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    const finalResponse = responses.find((entry) => entry.id === id && 'result' in entry);
    assert.equal(finalResponse?.result?.method, method, `${operation} did not invoke ${method}`);
  }

  const transcriptionResponses = responses.filter((entry) => entry.id === 'request-11');
  assert.deepEqual(transcriptionResponses[0].progress, {
    phase: 'streaming',
    completed: 2,
    total: 3
  });
  assert.equal(transcriptionResponses[1].result.method, 'transcribeSegmentAudio');

  decorator.dispose();
  const undecorated = pageWindow.__babelHelperMagnifierBridge.findTrimTargetsForSpeaker('speaker-a');
  assert.equal(undecorated.decorated, undefined);
  assert.equal(undecorated.method, 'findTrimTargetsForSpeaker');

  replacement.dispose();
  pageWindow.dispatchEvent(
    new TestCustomEvent('babel-helper-magnifier-request', {
      detail: { id: 'restored-native', operation: 'destroy', payload: { instanceId: 'missing' } }
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    responses.find((entry) => entry.id === 'restored-native')?.result,
    { ok: true }
  );
  const responseCountBeforeDispose = responses.length;
  pageWindow.__babelHelperMagnifierBridge.dispose();
  assert.equal(services.providerDisposed, true);
  assert.equal(pageWindow.__babelHelperMagnifierBridge, undefined);

  pageWindow.dispatchEvent(
    new TestCustomEvent('babel-helper-magnifier-request', {
      detail: { id: 'after-dispose', operation: 'destroy', payload: {} }
    })
  );
  assert.equal(responses.length, responseCountBeforeDispose);
});
