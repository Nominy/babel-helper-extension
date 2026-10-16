// @ts-nocheck
import { createNativeEditorAdapter } from './native-render-editor';

const leaseKey = Symbol.for('babel-helper/native-render-performance');
const originalFactoryKey = Symbol.for('babel-helper/original-native-factory');
export interface NativeRenderPerformanceOptions {
  windowRef?: Window & typeof globalThis;
  onStatus?: (status: { moduleId: number; boundary: string; state: string; reason?: string }) => void;
}

/**
 * MAIN world, document_start only. Native factories run unchanged; only the
 * editor's own imports receive scoped adapters. No eval or global React patches.
 * Public editor markers locate the factory independently of webpack module IDs.
 */
export function installNativeRenderPerformance({ windowRef = window, onStatus = () => {} }: NativeRenderPerformanceOptions = {}) {
  if (windowRef[leaseKey]) throw new Error('Native render performance already owns this document');
  const registrations = [];
  const adapters = new Set();
  const statuses = new Map();
  const wrappers = new WeakMap();
  const inspected = new WeakSet();
  let disposed = false;
  const report = (moduleId, status) => {
    const key = `${moduleId}:${status.boundary}`;
    if (statuses.get(key) === status.state) return;
    statuses.set(key, status.state);
    onStatus({ moduleId, ...status });
  };
  const chunk = windowRef.webpackChunk_N_E || (windowRef.webpackChunk_N_E = []);
  if (!Array.isArray(chunk)) throw new Error('Native webpackChunk_N_E is not an array');
  const descriptor = Object.getOwnPropertyDescriptor(chunk, 'push');
  if (descriptor && (!descriptor.configurable || !('value' in descriptor))) throw new Error('Native webpack chunk push ownership is unavailable');
  let delegate = chunk.push;
  if (typeof delegate !== 'function') throw new Error('Native webpack chunk push is unavailable');
  if (delegate !== Array.prototype.push) throw new Error('Native render performance must install before the webpack runtime consumes factories');
  const inspect = payload => {
    const modules = payload?.[1];
    if (!modules || typeof modules !== 'object') return;
    for (const id of Object.keys(modules)) {
      const original = modules[id];
      if (typeof original !== 'function' || original[originalFactoryKey]) continue;
      let replacement = wrappers.get(original);
      if (!replacement) {
        if (inspected.has(original)) continue;
        inspected.add(original);
        const source = Function.prototype.toString.call(original);
        if (!source.includes('data-turn-issues') || !source.includes('data-annotation-id') ||
            !source.includes('onDraftTag')) continue;
        replacement = function(module, exports, webpackRequire) {
          if (disposed) return original.call(this, module, exports, webpackRequire);
          if (typeof webpackRequire !== 'function') {
            report(Number(id), { boundary: 'editor-imports', state: 'unsupported', reason: 'Native module loader is unavailable' });
            return original.call(this, module, exports, webpackRequire);
          }
          const adapter = createNativeEditorAdapter(status => report(Number(id), status));
          adapters.add(adapter);
          const scopedRequire = new Proxy(webpackRequire, {
            apply(target, receiver, args) {
              return adapter.adaptImport(Reflect.apply(target, receiver, args));
            }
          });
          report(Number(id), { boundary: 'editor-imports', state: 'installed' });
          return original.call(this, module, exports, scopedRequire);
        };
        Object.defineProperty(replacement, originalFactoryKey, { value: original });
        wrappers.set(original, replacement);
      }
      modules[id] = replacement;
      registrations.push({ modules, id, original, replacement });
    }
  };
  const wrap = original => function(...payloads) {
    if (!disposed) for (const payload of payloads) inspect(payload);
    return Reflect.apply(original, this, payloads);
  };
  let wrapped = wrap(delegate);
  const get = () => wrapped;
  const set = value => {
    if (typeof value !== 'function') throw new Error('Native webpack push must remain callable');
    // webpack captures the previous push in its callback. Each wrapper closes
    // over that exact previous delegate; it must never recurse via this slot.
    delegate = value;
    wrapped = wrap(value);
  };
  Object.defineProperty(chunk, 'push', { configurable: true, enumerable: descriptor?.enumerable ?? false, get, set });
  const release = () => {
    if (disposed) return;
    disposed = true;
    const current = Object.getOwnPropertyDescriptor(chunk, 'push');
    if (current?.get === get && current?.set === set) {
      if (descriptor) Object.defineProperty(chunk, 'push', { ...descriptor, value: delegate });
      else if (delegate === Array.prototype.push) delete chunk.push;
      else Object.defineProperty(chunk, 'push', { configurable: true, writable: true, enumerable: false, value: delegate });
    }
    for (const registration of registrations) {
      if (registration.modules[registration.id] === registration.replacement) registration.modules[registration.id] = registration.original;
    }
    registrations.length = 0;
    const failures = [];
    for (const adapter of adapters) {
      try { adapter.release(); } catch (error) { failures.push(error); }
    }
    adapters.clear();
    if (windowRef[leaseKey] === release) delete windowRef[leaseKey];
    if (failures.length) throw new AggregateError(failures, 'Native rendering hooks could not all be released');
  };
  release.status = () => Object.fromEntries(statuses);
  windowRef[leaseKey] = release;
  try {
    for (const payload of chunk) inspect(payload);
  } catch (error) { release(); throw error; }
  return release;
}
