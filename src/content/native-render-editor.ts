// @ts-nocheck
import { NativeIntervalIndex, NativeRenderPlayhead } from './native-render-algorithms';
import { bindNativeSlateHistory, useNativeSlateBeforeInput } from './native-transcript';
import { createNativeTranscriptWords, sameNativeWordMap } from './native-render-transcript';
import { createNativeWaveAdapters } from './native-render-wave';

const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const shallowEqual = (left, right) => {
  if (Object.is(left, right)) return true;
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
};
function sameRowArray(left, right, key) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) =>
    Object.is(value, right[index]) || key === 'lowConfidenceWords' && shallowEqual(value, right[index]));
}
function sameRowProps(left, right) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) &&
    (Object.is(left[key], right[key]) || ['issues', 'machineWords', 'lowConfidenceWords'].includes(key) && sameRowArray(left[key], right[key], key)));
}
function facade(namespace, overrides) {
  const result = Object.create(Object.getPrototypeOf(namespace));
  for (const key of Reflect.ownKeys(namespace)) {
    const descriptor = Object.getOwnPropertyDescriptor(namespace, key);
    Object.defineProperty(result, key, Object.hasOwn(overrides, key)
      ? { value: overrides[key], enumerable: descriptor.enumerable, configurable: true }
      : { ...descriptor, configurable: true });
  }
  return result;
}
function isTurn(props) {
  return props && objectLike(props.turn) && objectLike(props.handlers) && Array.isArray(props.machineWords) &&
    Array.isArray(props.issues) && Array.isArray(props.lowConfidenceWords) && typeof props.playhead?.subscribe === 'function' &&
    typeof props.playhead?.getTime === 'function';
}
function isTranscript(props) {
  return props && Array.isArray(props.turns) && Array.isArray(props.machineWords) && Array.isArray(props.ghosts) &&
    objectLike(props.handlers) && objectLike(props.lowConfidence) && typeof props.playhead?.subscribe === 'function';
}

/** These facades belong to one executing native factory, never the shared modules. */
export function createNativeEditorAdapter(report: (status: { boundary: string; state: string; reason?: string }) => void = () => {}) {
  const reported = new Set(), imports = new WeakMap(), components = new WeakMap(), editables = new WeakMap();
  const bridges = new WeakMap(), liveBridges = new Set();
  let React, scope = null, released = false;
  const notice = (boundary, state, reason) => {
    const key = `${boundary}:${state}`;
    if (!reported.has(key)) { reported.add(key); report({ boundary, state, ...(reason ? { reason } : {}) }); }
  };
  const wave = createNativeWaveAdapters(report);

  function bridgeFor(playhead) {
    let bridge = bridges.get(playhead);
    if (bridge && bridge.nativeSubscribe === playhead.subscribe && bridge.nativeGetTime === playhead.getTime) return bridge;
    bridge = { clock: new NativeRenderPlayhead(), records: new WeakMap(), rows: new Set(), count: 0, dispose: null,
      nativeSubscribe: playhead.subscribe, nativeGetTime: playhead.getTime, playhead };
    bridges.set(playhead, bridge);
    bridge.owned = () => !released && bridge.nativeSubscribe === playhead.subscribe && bridge.nativeGetTime === playhead.getTime;
    bridge.time = () => bridge.nativeGetTime.call(playhead);
    bridge.record = words => {
      let record = bridge.records.get(words);
      if (record) return record;
      const index = new NativeIntervalIndex(words, word => word.startTime, word => word.endTime);
      record = {
        snapshot: () => index.first(bridge.time())?.order ?? -1,
        subscribe(listener) {
          if (!bridge.owned()) {
            notice('turn-playhead', 'unsupported', 'Native playhead methods changed ownership');
            return playhead.subscribe(listener);
          }
          bridge.clock.update(bridge.time());
          const stop = bridge.clock.subscribeWords(words, listener);
          const row = { listener, fallback: null };
          bridge.rows.add(row);
          if (++bridge.count === 1) liveBridges.add(bridge);
          if (!bridge.dispose) bridge.dispose = bridge.nativeSubscribe.call(playhead, () => bridge.clock.update(bridge.time()));
          // Close the render-to-subscribe gap using the original clock.
          bridge.clock.update(bridge.time());
          return () => {
            stop();
            row.fallback?.();
            bridge.rows.delete(row);
            if (--bridge.count === 0) {
              bridge.dispose?.();
              bridge.dispose = null;
              liveBridges.delete(bridge);
              bridge.clock.index = null;
              bridge.clock.active.clear();
              bridge.clock.dirty = true;
            }
          };
        }
      };
      bridge.records.set(words, record);
      return record;
    };
    return bridge;
  }

  function scopedComponent(type, kind) {
    const known = components.get(type);
    if (known) return known;
    function NativeComponent(props) {
      // One unconditional wrapper hook; native hooks retain their exact order.
      const state = React.useRef(null);
      if (!state.current) state.current = { indexWords: createNativeTranscriptWords(), mapping: 'pending' };
      const previous = scope;
      const supported = kind === 'turn' ? isTurn(props) : isTranscript(props);
      if (!released && supported && kind === 'turn') {
        const prior = state.current.rowProps;
        let stable = props;
        for (const key of ['issues', 'machineWords', 'lowConfidenceWords']) {
          if (prior && prior[key] !== props[key] && sameRowArray(prior[key], props[key], key)) {
            if (stable === props) stable = { ...props };
            stable[key] = prior[key];
          }
        }
        state.current.rowProps = stable;
        props = stable;
      }
      scope = { kind: supported ? kind : null, props, state: state.current, words: null };
      if (!supported) notice(kind === 'turn' ? 'turn-playhead' : 'transcript-word-index', 'unsupported', 'Native component props changed ownership or shape');
      try {
        const result = type(props);
        if (!released && supported && kind === 'turn' && !scope.wordStoreMatched && !state.current.wordUnsupported) {
          state.current.wordUnsupported = true;
          notice('turn-playhead', 'unsupported', 'Native timed-word memo or matching playhead subscription was not observed');
        }
        if (!released && supported && kind === 'transcript' && state.current.mapping === 'pending') {
          state.current.mapping = 'unsupported';
          notice('transcript-word-index', 'unsupported', 'Native machine-word memo dependency boundary was not observed');
        }
        return result;
      }
      finally { scope = previous; }
    }
    const wrapped = kind === 'turn' ? React.memo(NativeComponent, sameRowProps) : NativeComponent;
    const entry = { wrapped, kind };
    components.set(type, entry);
    notice(kind === 'turn' ? 'turn-memo' : 'transcript-native-body', 'installed');
    return entry;
  }

  function adaptJsx(namespace) {
    const overrides = {};
    for (const name of ['jsx', 'jsxs', 'jsxDEV']) {
      if (typeof namespace[name] !== 'function') continue;
      const native = namespace[name];
      overrides[name] = function(type, props, ...rest) {
        if (!React) return native(type, props, ...rest);
        if (objectLike(type) && (editables.has(type) || !released && typeof props?.onDOMBeforeInput === 'function' &&
          typeof props.renderElement === 'function' && typeof props.renderLeaf === 'function')) {
          let Editable = editables.get(type);
          if (!Editable) {
            Editable = React.forwardRef(function NativeEditable(next, ref) {
              const handler = useNativeSlateBeforeInput(React, next.onDOMBeforeInput);
              return native(type, { ...next, ref, onDOMBeforeInput: next.onDOMBeforeInput ? handler : undefined });
            });
            editables.set(type, Editable);
            notice('slate-beforeinput', 'installed');
          }
          return native(Editable, props, ...rest);
        }
        if (typeof type !== 'function') return native(type, props, ...rest);
        const known = components.get(type);
        const kind = isTurn(props) ? 'turn' : isTranscript(props) ? 'transcript' : null;
        if (!known && (!kind || released)) return native(type, props, ...rest);
        const entry = known || scopedComponent(type, kind);
        const child = native(entry.wrapped, props, ...rest);
        return entry.kind === 'turn' ? namespace.jsx('div', { className: 'babel-helper-native-turn', children: child }, rest[0]) : child;
      };
    }
    return facade(namespace, overrides);
  }

  function adaptReact(namespace) {
    React = namespace;
    return facade(namespace, {
      useCallback(callback, dependencies) { return wave.adaptCallback(namespace.useCallback(callback, dependencies)); },
      useMemo(calculate, dependencies) {
        const current = scope;
        const props = current?.props;
        const mapping = current?.kind === 'transcript' && dependencies?.length === 2 &&
          dependencies[0] === props.machineWords && dependencies[1] === props.turns;
        const value = namespace.useMemo(mapping ? () => {
          if (current.state.mapping === 'unsupported' || released) return calculate();
          const indexed = current.state.indexWords(props.machineWords, props.turns);
          if (current.state.mapping === 'pending') {
            const original = calculate();
            if (!sameNativeWordMap(original, indexed)) {
              current.state.mapping = 'unsupported';
              notice('transcript-word-index', 'unsupported', 'Native machine-word map disagrees with half-open midpoint assignment');
              return original;
            }
            current.state.mapping = 'installed';
            notice('transcript-word-index', 'installed');
          }
          return indexed;
        } : calculate, dependencies);
        if (current?.kind === 'turn' && dependencies?.length >= 4 && dependencies[3] === props.machineWords &&
          dependencies[0] === (typeof props.turn.content === 'string' ? props.turn.content : '') &&
          dependencies[1] === (props.turn.startTimeInSeconds ?? 0) && dependencies[2] === (props.turn.endTimeInSeconds ?? 0)) {
          if (Array.isArray(value) && value.every(word => typeof word?.startTime === 'number' && typeof word?.endTime === 'number')) current.words = value;
          else notice('turn-playhead', 'unsupported', 'Native word memo no longer returns timed words');
        }
        return value;
      },
      useSyncExternalStore(subscribe, snapshot, serverSnapshot) {
        const current = scope;
        if (!released && current?.kind === 'turn' && !current.state.wordUnsupported && current.words && subscribe === current.props.playhead.subscribe) {
          current.wordStoreMatched = true;
          const record = bridgeFor(current.props.playhead).record(current.words);
          if (Object.is(snapshot(), record.snapshot()) && (!serverSnapshot || Object.is(serverSnapshot(), record.snapshot()))) {
            notice('turn-playhead', 'installed');
            return namespace.useSyncExternalStore(record.subscribe, record.snapshot, serverSnapshot ? record.snapshot : undefined);
          }
          current.state.wordUnsupported = true;
          notice('turn-playhead', 'unsupported', 'Native word snapshot disagrees with first half-open interval');
        }
        return namespace.useSyncExternalStore(subscribe, snapshot, serverSnapshot);
      }
    });
  }

  function adaptHistory(namespace) {
    const keys = Object.keys(namespace);
    const apis = keys.map(key => namespace[key]).filter(value => objectLike(value) &&
      Object.hasOwn(value, 'isHistoryEditor') && Object.hasOwn(value, 'withNewBatch') &&
      typeof value.isHistoryEditor === 'function' && typeof value.withNewBatch === 'function');
    if (apis.length !== 1) return namespace;
    const functions = keys.filter(key => typeof namespace[key] === 'function');
    const key = typeof namespace.withHistory === 'function' ? 'withHistory' : functions.length === 1 ? functions[0] : null;
    if (!key) { notice('slate-history', 'unsupported', 'Cannot identify the unique native withHistory export'); return namespace; }
    const original = namespace[key], api = apis[0];
    return facade(namespace, { [key]: function(...args) {
      const editor = original.apply(this, args);
      if (api.isHistoryEditor(editor)) {
        bindNativeSlateHistory(editor, api);
        notice('slate-history', 'installed');
      } else notice('slate-history', 'unsupported', 'Native withHistory did not return a history editor');
      return editor;
    } });
  }

  return {
    adaptImport(namespace) {
      if (!objectLike(namespace)) return namespace;
      if (imports.has(namespace)) return imports.get(namespace);
      if (released) return namespace;
      let result = namespace;
      if (Object.hasOwn(namespace, 'useMemo') && Object.hasOwn(namespace, 'useSyncExternalStore') &&
        Object.hasOwn(namespace, 'memo') && Object.hasOwn(namespace, 'forwardRef') &&
        typeof namespace.useMemo === 'function' && typeof namespace.useSyncExternalStore === 'function' &&
        typeof namespace.memo === 'function' && typeof namespace.forwardRef === 'function') result = adaptReact(namespace);
      else if (Object.hasOwn(namespace, 'jsx') && Object.hasOwn(namespace, 'jsxs') &&
        typeof namespace.jsx === 'function' && typeof namespace.jsxs === 'function') result = adaptJsx(namespace);
      else result = adaptHistory(namespace);
      result = wave.adaptImport(result);
      imports.set(namespace, result);
      return result;
    },
    release() {
      if (released) return;
      released = true;
      for (const bridge of liveBridges) {
        bridge.dispose?.();
        bridge.dispose = null;
        // Existing fibers keep their type and native local/history hooks. Hand
        // subscriptions back to the original store until their next render.
        for (const row of bridge.rows) row.fallback = bridge.playhead.subscribe(row.listener);
      }
      liveBridges.clear();
      wave.release();
    }
  };
}
