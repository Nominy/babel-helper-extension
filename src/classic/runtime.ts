// @ts-nocheck
import { classicFactories } from './classic-editor.generated';

/** A private synchronous module graph. No factories enter the host registry. */
export function createClassicRuntime({ React, jsx, ReactDOM, nativeRequire, controls, useAutocomplete, portalRoot }) {
  const cache = new Map();
  const dom = Object.create(Object.getPrototypeOf(ReactDOM));
  for (const key of Reflect.ownKeys(ReactDOM)) {
    const descriptor = Object.getOwnPropertyDescriptor(ReactDOM, key);
    Object.defineProperty(dom, key, key === 'createPortal'
      ? { configurable: true, enumerable: descriptor.enumerable, value(children, _container, key) { return ReactDOM.createPortal(children, portalRoot(), key); } }
      : { ...descriptor, configurable: true });
  }
  const host = new Map([[24289, React], [92827, jsx], [91284, dom]]);
  function require(id) {
    id = Number(id);
    if (host.has(id)) return host.get(id);
    if (cache.has(id)) return cache.get(id).exports;
    const factory = classicFactories[id];
    if (typeof factory !== 'function') throw new Error(`Classic captured module ${id} is unavailable`);
    const module = { exports: {} };
    cache.set(id, module);
    try { factory.call(module.exports, module, module.exports, require); }
    catch (error) { cache.delete(id); throw error; }
    return module.exports;
  }
  require.d = (exports, definitions) => {
    for (const key of Object.keys(definitions)) if (!Object.hasOwn(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get: definitions[key] });
  };
  require.o = (object, key) => Object.hasOwn(object, key);
  require.r = exports => {
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    Object.defineProperty(exports, '__esModule', { value: true });
  };
  require.n = module => { const getter = module?.__esModule ? () => module.default : () => module; require.d(getter, { a: getter }); return getter; };
  require.g = globalThis;
  Object.defineProperty(require, 'nc', { get: () => readClassicHostNonce(nativeRequire) });
  require.classic = { ...controls, useAutocomplete };
  return { view: require(73681), applyLintFix: require(92113).C1 };
}

/** A missing own nonce means the live webpack runtime has no CSP nonce.
 * Inspect descriptors before reading; fixture/proxy loaders reject probes. */
export function readClassicHostNonce(nativeRequire) {
  const descriptor = Object.getOwnPropertyDescriptor(nativeRequire, 'nc');
  if (!descriptor) return undefined;
  return Object.hasOwn(descriptor, 'value') ? descriptor.value : descriptor.get?.call(nativeRequire);
}

export function classicAutocomplete(transcript) {
  const vocabulary = transcript.vocabulary, options = transcript.tagOptions;
  if (!vocabulary || !Array.isArray(vocabulary.bracketTypes) || !(vocabulary.tags instanceof Set) || !(vocabulary.styleTags instanceof Set) ||
      !options || !Array.isArray(options.bracket) || !Array.isArray(options.style) || !Array.isArray(options.curly)) throw new Error('Classic requires the current transcript vocabulary and tag options');
  const groups = new Map();
  for (const tag of options.bracket) {
    const name = tag.group;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(tag.name);
  }
  const foreign = options.style.find(tag => tag.foreign);
  return {
    bracketTags: [...vocabulary.tags], styleTags: [...vocabulary.styleTags],
    bracketTypes: vocabulary.bracketTypes, bracketTagGroups: [...groups].map(([name, tags]) => ({ name, tags })),
    foreignStyleTag: foreign?.name, foreignTagFormat: foreign?.foreign.format ?? (transcript.isRTL ? 'marker' : 'attribute'),
    foreignOptions: options.style.filter(tag => tag.foreign && tag.name === foreign?.name).map(tag => ({ code: tag.foreign.code, name: tag.group })),
    curlyTags: options.curly.map(tag => tag.name.endsWith(' ') ? tag.name : `${tag.name} `)
  };
}

export function classicOrderedRows(turns, ghosts) {
  const rows = turns.map((turn, index) => ({ turn, index, time: turn.startTimeInSeconds ?? 0 }));
  for (const ghost of ghosts) rows.push({ ghost, time: ghost.segmentInfo.startTimeInSeconds ?? 0 });
  return rows.sort((left, right) => left.time - right.time);
}

export function assertClassicTranscript(props) {
  if (!Array.isArray(props.turns) || !Array.isArray(props.ghosts) || !Array.isArray(props.lintIssues) || !Array.isArray(props.machineWords) ||
      !props.handlers || typeof props.renderActions !== 'function' || !(props.activeIds instanceof Set) ||
      typeof props.lowConfidence?.getLowConfidenceIndices !== 'function' || typeof props.lowConfidence?.getAcknowledgedIndices !== 'function') throw new Error('Current transcript contract changed; Classic cannot mount safely');
}

/** Catch only captured-view descendants; the current controller/panel are
 * siblings/ancestors and retain their own native error handling. */
export function createClassicViewBoundary(React, jsx, onUnsupported) {
  return class ClassicViewBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { failed: false, error: null };
      this.reported = false;
    }
    static getDerivedStateFromError(error) { return { failed: true, error }; }
    componentDidCatch(error) {
      if (this.reported) return;
      this.reported = true;
      onUnsupported(error);
    }
    render() {
      if (!this.state.failed) return this.props.children;
      const reason = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
      return jsx.jsxs('section', {
        role: 'alert', 'data-babel-classic-surface': '', 'data-babel-classic-unavailable': '',
        className: 'rounded border border-red-300 bg-red-50 p-4 text-sm',
        children: [
          jsx.jsx('h2', { className: 'font-semibold', children: 'Classic transcript unavailable' }),
          jsx.jsx('p', { className: 'mt-2 whitespace-pre-wrap', children: reason }),
          jsx.jsx('p', { className: 'mt-2', children: 'The current task controls remain active. Do not reload or submit while unsaved work is at risk. Report this error; after preserving your work, select Native mode and refresh manually.' })
        ]
      });
    }
  };
}
