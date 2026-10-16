// @ts-nocheck
import { createNativeEditorAdapter } from './native-render-editor';
import { createClassicControls } from './classic-controls';
import { createClassicRuntime, createClassicViewBoundary, classicAutocomplete, classicOrderedRows, assertClassicTranscript } from '../classic/runtime';

const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
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

/** Only the current workbench's transcript callback is replaced. The original
 * panel still owns track filtering, action dialogs, save, Undo and all gates. */
export function createClassicEditorAdapter(report, nativeRequire) {
  const native = createNativeEditorAdapter(report), imports = new WeakMap();
  let React, jsx, nativeJsx, ReactDOM, Context, ViewBoundary, controls, runtime, portals, released = false, unsupportedReported = false;
  const workbenches = new WeakMap(), panels = new WeakMap();
  const unsupported = error => {
    if (unsupportedReported) return;
    unsupportedReported = true;
    const reason = error instanceof Error ? error.message : String(error);
    report({ boundary: 'classic-transcript', state: 'unsupported', reason });
  };
  const fail = reason => {
    const error = new Error(reason);
    unsupported(error);
    throw error;
  };
  function ensureContext() {
    if (!React || !jsx) return fail('Classic requires the live React and JSX imports');
    if (!Context) Context = React.createContext(null);
    if (!ViewBoundary) ViewBoundary = createClassicViewBoundary(React, jsx, unsupported);
  }
  function ready() {
    if (runtime) return runtime;
    ensureContext();
    // 91284 is the verified ReactDOM namespace in both captures and the native
    // fixture. Do not enumerate/probe arbitrary require or tRPC proxy members.
    ReactDOM = nativeRequire(91284);
    if (!objectLike(ReactDOM) || !Object.hasOwn(ReactDOM, 'createPortal') || !Object.hasOwn(ReactDOM, 'flushSync') ||
        typeof ReactDOM.createPortal !== 'function' || typeof ReactDOM.flushSync !== 'function') return fail('Classic requires the live ReactDOM portal/flush contract');
    controls = createClassicControls(React, () => React.useContext(Context));
    runtime = createClassicRuntime({ React, jsx, ReactDOM, nativeRequire, controls,
      useAutocomplete: () => {
        const context = React.useContext(Context);
        if (!context?.autocomplete) return fail('Classic TTS input has no current vocabulary owner');
        return context.autocomplete;
      },
      portalRoot: () => {
        if (!portals) {
          portals = document.createElement('div');
          portals.setAttribute('data-babel-classic-portals', '');
          document.body.appendChild(portals);
        }
        return portals;
      }
    });
    return runtime;
  }
  function ClassicRowHost({ turn, handlers, readOnly, index, issueIndex }) {
    const context = React.useContext(Context), transcript = context.transcriptProps, panel = context.panelProps;
    const actions = transcript.renderActions(turn), actionProps = actions?.props;
    const owner = React.useRef(null);
    owner.current = { context, turn, handlers, readOnly };
    React.useLayoutEffect(() => () => { owner.current = null; }, []);
    const owned = () => {
      const state = owner.current;
      if (released || !state || !state.context.taskOwner.current || state.context.reviewActionId !== state.context.taskOwner.current.reviewActionId) return fail('Classic input no longer owns this task');
      if (state.readOnly || state.context.panelProps.readOnly || state.context.panelProps.assessment?.isAssessmentReadOnly) return fail('This Classic transcript is read-only');
      const current = state.context.annotationById.get(turn.id);
      if (!current || current.processedRecordingId !== state.turn.processedRecordingId) return fail('Classic annotation no longer belongs to this recording');
      return state;
    };
    const mutation = (key, collection = 'handlers') => (...args) => {
      const state = owned();
      const source = collection === 'handlers' ? state.handlers : state.context.panelProps;
      const fn = source[key];
      if (typeof fn !== 'function') return fail(`Classic requires the current ${key} handler`);
      return fn(...args);
    };
    const action = key => (...args) => {
      const state = owned(), current = state.context.transcriptProps.renderActions(state.turn)?.props;
      if (typeof current?.[key] !== 'function') return fail(`Classic row action ${key} is not available for this segment`);
      return current[key](...args);
    };
    const annotation = context.annotationById.get(turn.id);
    if (!annotation) return fail('Classic row is absent from the authoritative panel annotations');
    const track = context.trackById.get(turn.processedRecordingId);
    if (!track?.colors && !panel.trackColorsMap?.[turn.processedRecordingId]) return fail('Classic row has no current track colors');
    const warnings = issueIndex.get(turn.id)?.warnings ?? [], errors = issueIndex.get(turn.id)?.errors ?? [];
    const seek = handlers.onSeek;
    if (typeof seek !== 'function') return fail('Classic requires the current annotation seek handler');
    const rowContext = { ...context, annotation: turn, annotationId: turn.id };
    const rowProps = {
      annotation: turn, index, isActive: transcript.activeIds.has(turn.id), isPlaying: Boolean(panel.playingState[turn.processedRecordingId]),
      colors: panel.trackColorsMap[turn.processedRecordingId] ?? track.colors, tracks: panel.tracks,
      regionRowRef: panel.regionRowRefs(turn.id), onSeek: seek,
      onLabelChange: mutation('onChangeText'), onTrackChange: mutation('onChangeSpeaker'), onTimeChange: mutation('onChangeTime'),
      onDelete: action('onDelete'), onMergeAbove: action('onMergeAbove'), onMergeBelow: action('onMergeBelow'),
      canMergeAbove: !readOnly && Boolean(actionProps?.canMergeAbove), canMergeBelow: !readOnly && Boolean(actionProps?.canMergeBelow),
      onInsertRegionAbove: action('onInsertAbove'), onInsertRegionBelow: action('onInsertBelow'),
      isReadOnly: readOnly, isRTL: transcript.isRTL, hideTimestamps: transcript.hideTimestamps, lockSegments: transcript.lockSegments,
      linterErrors: errors, lintWarnings: warnings, lintVersion: transcript.lintVersion,
      assertedWarningKeys: panel.assertedWarningKeys, answeredPromptKeys: panel.answeredPromptKeys,
      onToggleAssertion: mutation('onConfirmWarnings'), onAnswerSignalPrompt: mutation('onAnswerPrompt'),
      onJumpToAnnotation: handlers.onJumpTo,
      resolveJumpTarget: id => {
        const target = panel.annotations.find(annotation => annotation.id === id);
        if (!target) return null;
        const seconds = target.startTimeInSeconds;
        return { timeLabel: seconds == null ? '--:--' : `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`, preview: String(target.content ?? '').slice(0, 80) };
      },
      onApplyLintFix: (id, edits) => {
        const state = owned();
        if (id !== state.turn.id || typeof state.turn.content !== 'string') return fail('Classic lint fix source changed');
        return mutation('onChangeText')(id, runtime.applyLintFix(state.turn.content, edits));
      },
      diffMode: Boolean(transcript.diffMap), annotationDiffMap: transcript.diffMap,
      lowConfidenceIndices: transcript.lowConfidence.getLowConfidenceIndices(turn.id), acknowledgedIndices: transcript.lowConfidence.getAcknowledgedIndices(turn.id),
      onAcknowledgeWord: mutation('onKeepWord'), onClearLowConfidence: mutation('onClearLowConfidence', 'panel'),
      projectId: context.workbenchProps.projectId, settingsProjectId: context.workbenchProps.settingsProjectId,
      showReviewers: panel.showReviewers, reviewer: panel.showReviewers ? panel.getReviewerForAnnotation?.(turn.startTimeInSeconds ?? 0) : undefined,
      reviewerColorMap: panel.reviewerColorMap, isTtsProject: panel.isTtsProject,
      ttsTranscriptWords: transcript.machineWords, onSeekToTime: time => {
        if (typeof handlers.onPlayFrom !== 'function') return fail('Classic TTS requires the current word playback handler');
        return handlers.onPlayFrom(turn, time);
      },
      classicAutocomplete: context.autocomplete, classicActions: actions
    };
    return jsx.jsx(Context.Provider, { value: rowContext, children: jsx.jsx(runtime.view.Row, rowProps) });
  }
  function ClassicTranscriptHost(props) {
    ready();
    const parent = React.useContext(Context);
    assertClassicTranscript(props);
    if (!parent?.panelProps || !parent.workbenchProps || !parent.taskOwner) return fail('Classic transcript is missing the live workbench/panel context');
    const autocomplete = React.useMemo(() => classicAutocomplete(props), [props.vocabulary, props.tagOptions, props.isRTL]);
    const annotationById = React.useMemo(() => new Map(parent.panelProps.annotations.map(annotation => [annotation.id, annotation])), [parent.panelProps.annotations]);
    const trackById = React.useMemo(() => new Map(parent.panelProps.tracks.map(track => [track.id, track])), [parent.panelProps.tracks]);
    const context = { ...parent, transcriptProps: props, autocomplete, annotationById, trackById, flushSync: ReactDOM.flushSync };
    const issueIndex = React.useMemo(() => {
      const map = new Map();
      for (const issue of props.lintIssues) {
        if (!map.has(issue.annotationId)) map.set(issue.annotationId, { errors: [], warnings: [] });
        map.get(issue.annotationId)[issue.severity === 'error' ? 'errors' : 'warnings'].push(issue);
      }
      return map;
    }, [props.lintIssues]);
    const ordered = React.useMemo(() => classicOrderedRows(props.turns, props.ghosts), [props.turns, props.ghosts]);
    const table = runtime.view.Table, panel = parent.panelProps;
    const headers = props.hideTimestamps ? [] : ['ID', 'Speaker', 'Start (mm:ss)', 'End (mm:ss)'];
    if (panel.showReviewers) headers.push('Reviewer');
    headers.push('Text', 'Linter');
    if (!props.lockSegments || props.turns.length > 1) headers.push('Actions');
    return jsx.jsx(Context.Provider, { value: context, children: jsx.jsx(runtime.view.TooltipProvider, { delayDuration: 0, children:
      jsx.jsx('div', { 'data-babel-classic-surface': '', 'data-hide-timestamps': props.hideTimestamps ? '' : undefined,
        children: jsx.jsxs(table.iA, { noWrapper: true, children: [
          jsx.jsx(table.xD, { className: 'sticky top-0 z-10 bg-white', children: jsx.jsx(table.SC, { className: 'hover:bg-white', children: headers.map((label, index) => jsx.jsx(table.ss, { className: '!px-2 !py-1 text-xs', children: label }, index)) }) }),
          jsx.jsx(table.RM, { children: ordered.length ? ordered.map(row => row.turn
            ? jsx.jsx(ClassicRowHost, { turn: row.turn, handlers: props.handlers, readOnly: Boolean(props.readOnly || panel.readOnly || panel.assessment?.isAssessmentReadOnly), index: row.index, issueIndex }, `${parent.reviewActionId}:${row.turn.id}`)
            : jsx.jsx(runtime.view.GhostRow, { modifiedSegment: row.ghost, isRTL: props.isRTL, showAsAdded: props.ghostsAsAdded, showReviewers: panel.showReviewers, hideActions: props.lockSegments && props.turns.length <= 1 }, `ghost-${row.ghost.segmentInfo.annotationId}`))
            : jsx.jsx(table.SC, { children: jsx.jsx(table.pj, { colSpan: headers.length, className: 'py-4 text-center text-sm', children: 'No transcriptions yet. Click and drag on the waveform above to create a region, then add your transcription text.' }) }) })
        ] }) }) }) });
  }
  function workbenchFor(type) {
    let wrapper = workbenches.get(type);
    if (!wrapper) {
      wrapper = function ClassicWorkbenchContext({ nativeType, nativeProps }) {
        ensureContext();
        const owner = React.useRef(nativeProps);
        owner.current = nativeProps;
        React.useLayoutEffect(() => () => { owner.current = null; }, []);
        const value = { workbenchProps: nativeProps, reviewActionId: nativeProps.reviewActionId, taskOwner: owner };
        return jsx.jsx(Context.Provider, { value, children: nativeJsx.jsx(nativeType, nativeProps) });
      };
      workbenches.set(type, wrapper);
    }
    return wrapper;
  }
  function panelFor(type) {
    let wrapper = panels.get(type);
    if (!wrapper) {
      wrapper = function ClassicPanelContext({ nativeType, nativeProps }) {
        ensureContext();
        const parent = React.useContext(Context);
        const original = nativeProps.renderTranscript;
        const renderTranscript = React.useCallback((...args) => {
          const element = original(...args);
          return jsx.jsx(ViewBoundary, { children: jsx.jsx(ClassicTranscriptResult, { nativeElement: element }) });
        }, [original]);
        const value = { ...parent, panelProps: nativeProps };
        return jsx.jsx(Context.Provider, { value, children: nativeJsx.jsx(nativeType, { ...nativeProps, renderTranscript }) });
      };
      panels.set(type, wrapper);
    }
    return wrapper;
  }
  function ClassicTranscriptResult({ nativeElement }) {
    if (!React.isValidElement(nativeElement)) return fail('Current renderTranscript did not return its native transcript element');
    return jsx.jsx(ClassicTranscriptHost, nativeElement.props);
  }
  return {
    adaptImport(namespace, moduleId) {
      if (!objectLike(namespace) || released) return namespace;
      if (imports.has(namespace)) return imports.get(namespace);
      const adapted = native.adaptImport(namespace, moduleId);
      let result = adapted;
      if (Object.hasOwn(namespace, 'useContext') && Object.hasOwn(namespace, 'createContext') && Object.hasOwn(namespace, 'useMemo')) React = namespace;
      if (Object.hasOwn(namespace, 'jsx') && Object.hasOwn(namespace, 'jsxs') && typeof namespace.jsx === 'function' && typeof namespace.jsxs === 'function') {
        jsx = namespace;
        nativeJsx = adapted;
        const override = {};
        for (const name of ['jsx', 'jsxs']) override[name] = function(type, props, key) {
          if (!released && props && typeof type === 'function') {
            if (typeof props.reviewActionId === 'string' && Array.isArray(props.annotations) && Array.isArray(props.transcriptionChunkProcessedRecordings) && Object.hasOwn(props, 'projectId')) {
              return adapted[name](workbenchFor(type), { nativeType: type, nativeProps: props }, key);
            }
            if (Array.isArray(props.annotations) && props.saveState && typeof props.onSave === 'function' && typeof props.renderTranscript === 'function') {
              if (!unsupportedReported) report({ boundary: 'classic-transcript', state: 'installed' });
              return adapted[name](panelFor(type), { nativeType: type, nativeProps: props }, key);
            }
          }
          return adapted[name](type, props, key);
        };
        result = facade(adapted, override);
      }
      imports.set(namespace, result);
      return result;
    },
    release() {
      if (released) return;
      released = true;
      controls?.release();
      native.release();
      portals?.remove();
    }
  };
}
