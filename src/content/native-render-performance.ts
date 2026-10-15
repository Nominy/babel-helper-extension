// @ts-nocheck
import * as algorithms from './native-render-algorithms';
import { prepareNativeTranscript } from './native-render-transcript';
import { createNativeRenderFactories } from './native-render-factories.generated';
import { bindNativeSlateHistory, useNativeSlateBeforeInput } from './native-transcript';

const leaseKey = Symbol.for('babel-helper/native-render-performance/oct15');
export interface NativeRenderPerformanceOptions {
  windowRef?: Window & typeof globalThis;
  onStatus?: (status: { moduleId: number; state: string }) => void;
}

/**
 * MAIN world, document_start only. Substitutes precompiled, narrowly edited
 * native factories only after byte-for-byte source verification. No eval,
 * injected remote code, patched React globals, playback throttling or polling.
 * Executed factory closures intentionally live for their native task lifetime;
 * stopping this lease restores unexecuted registrations, not a live editor.
 */
export function installNativeRenderPerformance({ windowRef = window, onStatus = () => {} }: NativeRenderPerformanceOptions = {}) {
  if (windowRef[leaseKey]) throw new Error('Native render performance already owns this document');
  const factories = createNativeRenderFactories({ ...algorithms, prepareNativeTranscript, bindNativeSlateHistory, useNativeSlateBeforeInput });
  const contracts = new Map(factories.map(contract => [String(contract.id), contract]));
  const registrations = [];
  const statuses = new Map(factories.map(contract => [contract.id, 'awaiting-native-factory']));
  let disposed = false;
  const report = (id, state) => { statuses.set(id, state); onStatus({ moduleId: id, state }); };
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
    for (const [id, contract] of contracts) {
      if (!Object.hasOwn(modules, id)) continue;
      const original = modules[id];
      if (original === contract.factory || (contract.recoveredFactory && original === contract.recoveredFactory)) continue;
      const source = typeof original === 'function' ? Function.prototype.toString.call(original) : null;
      const replacement = source !== null && source === contract.recoveredOriginal ? contract.recoveredFactory :
        contract.originals.includes(source) ? contract.factory : null;
      if (!replacement) {
        report(contract.id, 'unsupported-native-factory-source');
        continue;
      }
      modules[id] = replacement;
      registrations.push({ modules, id, original, replacement });
      report(contract.id, 'installed-exact-oct15-factory');
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
    if (windowRef[leaseKey] === release) delete windowRef[leaseKey];
  };
  release.status = () => Object.fromEntries(statuses);
  windowRef[leaseKey] = release;
  try {
    for (const payload of chunk) inspect(payload);
  } catch (error) { release(); throw error; }
  return release;
}
