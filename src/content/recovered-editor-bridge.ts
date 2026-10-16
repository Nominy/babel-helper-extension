// @ts-nocheck
import { findBabelEditorFiber, subscribeBabelEditorCommits, readBabelTranscriptBindings, readBabelTrackBindings, readBabelPlaybackBindings, readBabelSessionState, readBabelTurnIdentity, createBabelRowIdentityIndex, readBabelClassicInput, flushBabelClassicInputs } from '@nominy/babel-babel-runtime';
import { BABEL_EDITOR_CONTRACT_VERSION } from '../core/babel-editor-contract';
import {
  findNativeDescendant, findNativeTurnFiber, readNativeTurn, readNativeSlateSelection, replaceNativeTurn, replaceClassicTurns, selectNativeSlate, nativeDomPointOffset,
  TRANSCRIPT_ROW_SELECTOR, TRANSCRIPT_EDITOR_SELECTOR
} from './native-transcript';
import { SEGMENT_CLICK_SEEK_ATTRIBUTE } from '../features/native-segment-click-seek-feature';
import { handleNativeTagDropdownKeydown } from './native-tag-dropdown-keyboard';
import { acceptAllNativeWarnings } from './native-warning-actions';
import { installNativeMergePolicy } from './native-merge-policy';
import { installNativeCoveragePerformance } from './native-coverage-performance';
import {
  getNativeReplacementStatus, runNativeReplacementRules, recoverNativeReplacementRules,
  invalidateNativeReplacementSession, installNativeReplacementTracking
} from './native-find-replace';
import { NATIVE_COMPATIBILITY_CHANGE_EVENT, NATIVE_MERGE_GAPS_ATTRIBUTE, NATIVE_FIND_REPLACE_ATTRIBUTE } from '../core/native-compatibility';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';

const REPLACEMENT_METHODS = {
  'native-replacement-status': 'getNativeReplacementStatus',
  'run-native-replacement-rules': 'runNativeReplacementRules',
  'recover-native-replacement-rules': 'recoverNativeReplacementRules'
};
const NATIVE_ACTIVATION_KEYS = ['onSelect'];

export function initRecoveredEditorBridge() {
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const REQUEST_EVENT = 'babel-helper-recovered-editor-request';
  const RESPONSE_EVENT = 'babel-helper-recovered-editor-response';
  const SERVICE_ID = 'page.recoveredEditor';
  let serviceRegistry = null;
  let serviceProviderHandle = null;
  let disposed = false;
  const pendingNativeSelections = new WeakMap();
  const existingBridge = window.__babelHelperRecoveredEditorBridge;
  let extendedDiffPatch = null;
  let extendedDiffFetchPatch = null;
  const extendedDiffQueryRecords = new Map();
  let extendedDiffEditorFiber = null;
  let extendedDiffEditorGeneration = 0;
  let nativeActivationPatch = null;
  if (existingBridge && typeof existingBridge.dispose === 'function') {
    existingBridge.dispose();
  }

  const SESSION_EVENT = 'babel-helper:native-session-change';
  const SESSION_ATTRIBUTE = 'data-babel-helper-native-session';
  const ROUTE_EVENT = 'babel-helper:native-route-change';
  const SESSION_GENERATION = Symbol.for('babel-helper.native-session-generation');
  let sessionRoot = null;
  let sessionSurface = null;
  let sessionUnsubscribe = null;
  let sessionGeneration = Number(window[SESSION_GENERATION]) || 0;
  let sessionInitialized = false;
  let sessionError = '';
  let publishedSession = null;
  let publishedSessionPayload = '';
  const rowIdentityIndex = createBabelRowIdentityIndex();
  let sessionMountQueued = false;
  let sessionMountSeeds = [];
  const SESSION_MOUNT_SELECTOR = 'main, [data-transcript-scroll]';
  const SESSION_DISCOVERY_SELECTOR = `${SESSION_MOUNT_SELECTOR}, ${TRANSCRIPT_ROW_SELECTOR}`;
  const historyPatches = [];
  let mergePolicy = null;
  let replacementTracking = null;
  let mergePolicyFailed = false;
  let replacementTrackingFailed = false;
  let stopNativeCoverage = null;

  function reconcileNativeCoverage(state) {
    const stop = stopNativeCoverage;
    stopNativeCoverage = null;
    try {
      stop?.();
      if (state && !sessionError && !disposed) stopNativeCoverage = installNativeCoveragePerformance();
    } catch (error) {
      console.error('[Babel Helper] Timeline coverage optimization stopped:', error);
      showNativeAutomationFailure('Timeline coverage', error instanceof Error ? error.message : String(error));
    }
  }

  function retireNativeCompatibility() {
    const merge = mergePolicy, stopTracking = replacementTracking;
    mergePolicy = null;
    replacementTracking = null;
    merge?.dispose();
    stopTracking?.();
    invalidateNativeReplacementSession();
  }

  function compatibilityFailure(feature, error) {
    if (disposed) return;
    if (feature === 'Merge across gaps') {
      const previous = mergePolicy;
      mergePolicy = null;
      mergePolicyFailed = true;
      previous?.dispose();
    } else {
      const stopTracking = replacementTracking;
      replacementTracking = null;
      replacementTrackingFailed = true;
      stopTracking?.();
      invalidateNativeReplacementSession();
    }
    console.error(`[Babel Helper] ${feature} stopped:`, error);
    showNativeAutomationFailure(feature, error instanceof Error ? error.message : String(error));
  }

  function reconcileNativeCompatibility() {
    if (disposed) return;
    const canBind = !sessionError && sessionUnsubscribe && readBabelSessionState();
    const mergeEnabled = document.documentElement.getAttribute(NATIVE_MERGE_GAPS_ATTRIBUTE) === 'true';
    const replaceEnabled = document.documentElement.getAttribute(NATIVE_FIND_REPLACE_ATTRIBUTE) === 'true';
    if (!mergeEnabled) {
      const previous = mergePolicy; mergePolicy = null;
      previous?.dispose(); mergePolicyFailed = false;
    } else if (canBind && !mergePolicyFailed) {
      try {
        if (mergePolicy) mergePolicy.reconcile();
        else {
          const policy = installNativeMergePolicy({
            isEnabled: () => document.documentElement.getAttribute(NATIVE_MERGE_GAPS_ATTRIBUTE) === 'true',
            onFailure: error => { if (mergePolicy === policy) compatibilityFailure('Merge across gaps', error); }
          });
          mergePolicy = policy;
        }
      } catch (error) { compatibilityFailure('Merge across gaps', error); }
    }
    if (!replaceEnabled) {
      const stopTracking = replacementTracking; replacementTracking = null;
      stopTracking?.(); replacementTrackingFailed = false;
      invalidateNativeReplacementSession();
    } else if (canBind && !replacementTrackingFailed && !replacementTracking) {
      try { replacementTracking = installNativeReplacementTracking(); }
      catch (error) { compatibilityFailure('Replacement rules', error); }
    }
  }

  function handleNativeMergeInteraction(event) {
    if (disposed || !mergePolicy) return;
    try { mergePolicy.handleInteraction(event); }
    catch (error) { compatibilityFailure('Merge across gaps', error); }
  }

  function publishSession(state) {
    if (disposed) return;
    const href = window.location.href;
    const reviewActionId = state?.reviewActionId || '';
    const readOnly = state?.readOnly ?? null;
    const status = sessionError ? 'error' : state ? 'ready' : 'unmounted';
    if (publishedSession?.href === href && publishedSession.generation === sessionGeneration &&
        publishedSession.reviewActionId === reviewActionId && publishedSession.readOnly === readOnly &&
        publishedSession.status === status && publishedSession.error === sessionError) return;
    const publication = { href, generation: sessionGeneration, reviewActionId, readOnly, status, error: sessionError };
    const payload = JSON.stringify(publication);
    retireNativeCompatibility();
    mergePolicyFailed = false;
    replacementTrackingFailed = false;
    publishedSession = publication;
    publishedSessionPayload = payload;
    document.documentElement.setAttribute(SESSION_ATTRIBUTE, payload);
    reconcileNativeCompatibility();
    reconcileNativeCoverage(state);
    window.dispatchEvent(new CustomEvent(SESSION_EVENT, { detail: payload }));
  }

  function publishEditorCommit(committed = false) {
    const rows = !sessionError && sessionUnsubscribe ? rowIdentityIndex.reconcile(committed) : null;
    const publication = { href: window.location.href, generation: sessionGeneration,
      reviewActionId: rows?.reviewActionId || '', annotationRevision: rows?.revision ?? null,
      readOnly: rows?.readOnly ?? true, activeIds: rows?.activeIds || [], editingId: rows?.editingId ?? null };
    window.dispatchEvent(new CustomEvent('babel-helper:native-editor-commit', { detail: JSON.stringify(publication) }));
  }

  function reconcileNativeSession(mountChanged = false) {
    if (disposed) return;
    // A native commit/route already reconciles any queued mount delivery.
    mountChanged ||= sessionMountQueued;
    sessionMountQueued = false;
    const surface = document.querySelector('[data-transcript-scroll]');
    const root = surface ? getRootFiber()?.stateNode : null;
    if (sessionInitialized && surface === sessionSurface && root === sessionRoot) {
      if (mountChanged) rememberSessionMountSeeds();
      publishSession(!sessionError && sessionUnsubscribe ? readBabelSessionState() : null);
      return;
    }
    sessionUnsubscribe?.();
    sessionInitialized = true;
    sessionUnsubscribe = null;
    sessionRoot = root;
    sessionSurface = surface;
    sessionError = '';
    rememberSessionMountSeeds();
    const generation = ++sessionGeneration;
    window[SESSION_GENERATION] = generation;
    let state = null;
    if (surface) {
      try {
        sessionUnsubscribe = subscribeBabelEditorCommits(() => {
          if (disposed || generation !== sessionGeneration) return;
          reconcileNativeSession();
          if (!disposed && generation === sessionGeneration) publishEditorCommit(true);
        });
        state = readBabelSessionState();
        if (!state) throw new Error('Native editor committed session metadata is unavailable.');
      } catch (error) {
        sessionUnsubscribe?.();
        sessionUnsubscribe = null;
        sessionError = error instanceof Error ? error.message : String(error);
        console.error('[babel-helper] Native session automation stopped:', sessionError);
      }
    }
    publishSession(state);
    publishEditorCommit();
  }

  function publishRoute() {
    if (disposed) return;
    window.dispatchEvent(new CustomEvent(ROUTE_EVENT, { detail: window.location.href }));
    reconcileNativeSession();
  }

  // These wrappers live in MAIN, where the application actually calls history.
  // Navigation API is preferred; the owned wrappers cover browsers without it.
  if (!window.navigation?.addEventListener) {
    for (const name of ['pushState', 'replaceState']) {
      const original = window.history[name];
      const wrapped = function (...args) {
        const result = original.apply(this, args);
        publishRoute();
        return result;
      };
      window.history[name] = wrapped;
      historyPatches.push({ name, original, wrapped });
    }
  }
  function readSessionMountRoot(seed) {
    const key = seed.key || Object.getOwnPropertyNames(seed.node).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? seed.node[key] : null;
    while (fiber?.return) fiber = fiber.return;
    return fiber?.stateNode || null;
  }

  function rememberSessionMountSeeds() {
    sessionMountSeeds = [];
    const remember = node => {
      const seed = { node, key: Object.getOwnPropertyNames(node).find(name => name.startsWith('__reactFiber$')),
        root: null, connected: node.isConnected };
      seed.root = readSessionMountRoot(seed);
      sessionMountSeeds.push(seed);
    };
    for (const node of document.querySelectorAll(SESSION_MOUNT_SELECTOR)) remember(node);
    // Match the runtime's annotation seed only when its stable surfaces cannot locate this root.
    if (sessionRoot && !sessionMountSeeds.some(seed => seed.root === sessionRoot)) {
      for (const node of document.querySelectorAll(TRANSCRIPT_ROW_SELECTOR)) {
        remember(node);
        if (sessionMountSeeds[sessionMountSeeds.length - 1].root === sessionRoot) break;
      }
    }
  }

  function isSessionMountNode(node) {
    const selector = sessionRoot ? SESSION_MOUNT_SELECTOR : SESSION_DISCOVERY_SELECTOR;
    return node instanceof Element &&
      (node.matches(selector) || Boolean(node.querySelector(selector)));
  }

  function hasSessionMountChange(mutations) {
    // DOM nodes may survive a new React root at the same URL. Check only the
    // remembered seed-to-root links, not editor props or session serialization.
    for (const seed of sessionMountSeeds) {
      if (seed.node.isConnected !== seed.connected || readSessionMountRoot(seed) !== seed.root) return true;
    }
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      for (const node of mutation.addedNodes) if (isSessionMountNode(node)) return true;
      for (const node of mutation.removedNodes) if (isSessionMountNode(node)) return true;
    }
    return false;
  }

  const sessionMountObserver = new MutationObserver(mutations => {
    if (disposed || sessionMountQueued || !hasSessionMountChange(mutations)) return;
    sessionMountQueued = true;
    queueMicrotask(() => {
      if (!disposed && sessionMountQueued) reconcileNativeSession(true);
    });
  });
  sessionMountObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.navigation?.addEventListener('currententrychange', publishRoute);
  window.addEventListener('popstate', publishRoute, true);
  window.addEventListener('hashchange', publishRoute, true);

  function restoreNativeActivation() {
    const owner = nativeActivationPatch;
    if (owner) {
      for (const patch of owner.patches) {
        if (owner.handlers[patch.key] === patch.wrapped) owner.handlers[patch.key] = patch.original;
      }
    }
    nativeActivationPatch = null;
  }

  function handleNativeActivationCapture(event) {
    if (disposed || document.documentElement.getAttribute(SEGMENT_CLICK_SEEK_ATTRIBUTE) !== 'true') {
      restoreNativeActivation();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(TRANSCRIPT_ROW_SELECTOR)) return;
    const binding = readBabelTranscriptBindings();
    const handlers = binding?.transcript?.handlers;
    if (!handlers || !NATIVE_ACTIVATION_KEYS.some(key => typeof handlers[key] === 'function')) return;
    if (nativeActivationPatch?.handlers === handlers && NATIVE_ACTIVATION_KEYS.every(key =>
      typeof handlers[key] !== 'function' ||
      nativeActivationPatch.patches.some(patch => patch.key === key && handlers[key] === patch.wrapped))) return;
    restoreNativeActivation();
    const reviewActionId = binding.reviewActionId;
    const owner = { handlers, patches: [] };
    nativeActivationPatch = owner;
    for (const key of NATIVE_ACTIVATION_KEYS) {
      const original = handlers[key];
      if (typeof original !== 'function') continue;
      const wrapped = function (...args) {
        if (disposed || document.documentElement.getAttribute(SEGMENT_CLICK_SEEK_ATTRIBUTE) !== 'true') {
          return original.apply(this, args);
        }
        const playback = readBabelPlaybackBindings();
        if (playback?.reviewActionId !== reviewActionId) return original.apply(this, args);
        const patches = [];
        try {
          for (const wave of playback.waves) {
            if (typeof wave.seekTo !== 'function') continue;
            const descriptor = Object.getOwnPropertyDescriptor(wave, 'seekTo');
            const blockedSeek = () => {};
            wave.seekTo = blockedSeek;
            patches.push({ wave, descriptor, blockedSeek });
          }
          // Oct15 onSelect may seek outside the current turn; onActivate is
          // only the editingId setter and must retain its native identity.
          // Explicit onSeek/onPlay/onPlayFrom remain native.
          return original.apply(this, args);
        } finally {
          for (const { wave, descriptor, blockedSeek } of patches) {
            if (wave.seekTo !== blockedSeek) continue;
            if (descriptor) Object.defineProperty(wave, 'seekTo', descriptor);
            else delete wave.seekTo;
          }
        }
      };
      handlers[key] = wrapped;
      owner.patches.push({ key, original, wrapped });
    }
  }

  function respond(id, result) {
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          id,
          result
        }
      })
    );
  }


  function getFiberProps(fiber) {
    return fiber && typeof fiber === 'object' ? fiber.memoizedProps || null : null;
  }

  function getRootFiber() {
    let current = findBabelEditorFiber();
    while (current?.return) current = current.return;
    return current?.stateNode?.current || null;
  }

  function findFiberProps(predicate) {
    const root = getRootFiber();
    if (!root) {
      return null;
    }

    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) {
        continue;
      }
      seen.add(fiber);

      const props = getFiberProps(fiber);
      if (props && typeof props === 'object' && predicate(props)) {
        return props;
      }

      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
  }

  function getTranscriptionDiffToolbarProps() {
    return findFiberProps(
      (props) =>
        Array.isArray(props.availableReviewActions) &&
        typeof props.onToggleDiffMode === 'function' &&
        typeof props.onSelectCompareAction === 'function' &&
        ('diffResult' in props || 'referenceLabel' in props || 'hypothesisLabel' in props)
    );
  }

  function readExtendedDiffEditorGeneration() {
    const editor = findBabelEditorFiber();
    if (editor !== extendedDiffEditorFiber && editor?.alternate !== extendedDiffEditorFiber) {
      extendedDiffEditorFiber = editor;
      extendedDiffEditorGeneration++;
    }
    return extendedDiffEditorGeneration;
  }

  function readExtendedDiffState() {
    const binding = readBabelTranscriptBindings();
    const base = { routeKey: getRouteKey(), generation: sessionGeneration,
      editorGeneration: readExtendedDiffEditorGeneration(), reviewActionId: binding?.reviewActionId || '' };
    if (sessionError) return { ...base, ok: false, reason: sessionError };
    if (!binding) return { ...base, ok: true, status: 'unmounted' };
    const toolbar = getTranscriptionDiffToolbarProps();
    if (!toolbar) return { ...base, ok: false, reason: 'transcription-diff-toolbar-not-found' };
    const selectedCompareActionId = getString(toolbar.selectedCompareActionId);
    const state = {
      ...base, ok: true, selectedCompareActionId, isDiffMode: toolbar.isDiffMode === true,
      availableReviewActions: toolbar.availableReviewActions.map(({ id, level }) => ({ id, level }))
    };
    if (!state.isDiffMode) return { ...state, status: 'disabled' };
    // The native toolbar passes isLoadingActions here; diff readiness belongs to its QueryObserver.
    if (toolbar.isLoading) return { ...state, status: 'loading' };
    if (!selectedCompareActionId) return { ...state, ok: false, reason: 'compare-action-not-found' };
    const observer = findCurrentTranscriptionDiffObserver({ id: selectedCompareActionId });
    if (!observer) return { ...state, ok: false, reason: 'transcription-diff-query-not-found' };
    const result = observer.getCurrentResult();
    if (result?.isError || result?.status === 'error') {
      return { ...state, ok: false, reason: result.error?.message || 'transcription-diff-query-failed' };
    }
    const query = observer.getCurrentQuery();
    const data = result?.data;
    if (!matchesCurrentTranscriptionDiffResult(data, { id: selectedCompareActionId }, binding.reviewActionId)) {
      if (result?.isPending || result?.isLoading || result?.isFetching || result?.status === 'pending') {
        return { ...state, status: 'loading' };
      }
      return { ...state, ok: false, reason: 'transcription-diff-query-data-unavailable' };
    }
    const record = extendedDiffQueryRecords.get(query);
    const fetched = isCurrentExtendedDiffPatch(extendedDiffPatch)
      ? readFetchedDiffOriginal(data, extendedDiffPatch) : null;
    const payload = fetched || (record?.applied === data ? record.original : data);
    return { ...state, status: 'ready', payload };
  }

  function matchesCurrentTranscriptionDiffResult(data, action, reviewActionId = readBabelTranscriptBindings()?.reviewActionId) {
    if (!data || !Array.isArray(data.speakerDiffs) || !reviewActionId || !action?.id) return false;
    return (data.referenceReviewActionId === action.id && data.currentReviewActionId === reviewActionId) ||
      (data.currentReviewActionId === action.id && data.referenceReviewActionId === reviewActionId);
  }

  function isCurrentExtendedDiffPatch(patch) {
    const editor = findBabelEditorFiber();
    return Boolean(patch && extendedDiffPatch === patch && patch.routeKey === getRouteKey() &&
      patch.reviewActionId === readBabelTranscriptBindings()?.reviewActionId &&
      (editor === patch.editorFiber || editor?.alternate === patch.editorFiber));
  }

  function findCurrentTranscriptionDiffObserver(action) {
    const root = findBabelEditorFiber();
    if (!root) {
      return null;
    }

    const stack = [root];
    const seenFibers = new Set();
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || seenFibers.has(fiber)) {
        continue;
      }
      seenFibers.add(fiber);

      let hook = fiber.memoizedState;
      const seenHooks = new Set();
      let depth = 0;
      while (hook && typeof hook === 'object' && !seenHooks.has(hook) && depth < 700) {
        seenHooks.add(hook);
        const memoizedState = hook.memoizedState;
        if (typeof memoizedState?.getCurrentResult === 'function' &&
            typeof memoizedState.getCurrentQuery === 'function' &&
            typeof memoizedState.refetch === 'function' &&
            (matchesCurrentTranscriptionDiffResult(memoizedState.getCurrentResult()?.data, action) ||
              matchesTranscriptionDiffQuery(memoizedState.options?.queryKey || memoizedState.getCurrentQuery()?.queryKey, action))) {
          return memoizedState;
        }

        hook = hook.next;
        depth += 1;
      }

      if (fiber.child) stack.push(fiber.child);
      if (fiber !== root && fiber.sibling) stack.push(fiber.sibling);
    }

    return null;
  }

  function findCurrentTranscriptionDiffQueryResult(action) {
    return findCurrentTranscriptionDiffObserver(action)?.getCurrentResult() || null;
  }

  function matchesTranscriptionDiffQuery(key, action) {
    if (!Array.isArray(key) || !action?.id) return false;
    const [path, options] = key;
    if (!Array.isArray(path) || path.join('.') !== 'transcriptions.getTranscriptionDiff') return false;
    const input = options?.input;
    const reviewActionId = readBabelTranscriptBindings()?.reviewActionId;
    return Boolean(reviewActionId && input &&
      ((input.referenceReviewActionId === reviewActionId && input.currentReviewActionId === action.id) ||
       (input.currentReviewActionId === reviewActionId && input.referenceReviewActionId === action.id)));
  }

  function getRouteKey() {
    return `${window.location.pathname || ''}${window.location.search || ''}`;
  }

  function getString(value) {
    return typeof value === 'string' ? value : '';
  }

  function getNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeExtendedDiffTextMode(value) {
    return value === 'reference' || value === 'current' ? value : 'fusion';
  }


  function splitFullDiffTokens(text) {
    return String(text || '').match(/\S+/g) || [];
  }

  function buildFullWordDiffs(beforeText, afterText) {
    const left = splitFullDiffTokens(beforeText);
    const right = splitFullDiffTokens(afterText);
    const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));

    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const wordDiffs = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        wordDiffs.push({ status: 'unchanged', value: left[i] });
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        wordDiffs.push({ status: 'removed', value: left[i] });
        i += 1;
      } else {
        wordDiffs.push({ status: 'added', value: right[j] });
        j += 1;
      }
    }

    while (i < left.length) {
      wordDiffs.push({ status: 'removed', value: left[i] });
      i += 1;
    }
    while (j < right.length) {
      wordDiffs.push({ status: 'added', value: right[j] });
      j += 1;
    }

    return wordDiffs;
  }

  function countFullWordDiffEdits(wordDiffs) {
    let substitutions = 0;
    let insertions = 0;
    let deletions = 0;
    let index = 0;

    while (index < wordDiffs.length) {
      const diff = wordDiffs[index];
      if (diff?.status === 'removed') {
        const next = wordDiffs[index + 1];
        if (next?.status === 'added') {
          substitutions += 1;
          index += 2;
        } else {
          deletions += 1;
          index += 1;
        }
      } else if (diff?.status === 'added') {
        insertions += 1;
        index += 1;
      } else {
        index += 1;
      }
    }

    return { substitutions, insertions, deletions };
  }

  function patchSegmentWordRanges(segments) {
    let offset = 0;
    for (const segment of Array.isArray(segments) ? segments : []) {
      if (!segment || typeof segment !== 'object') continue;
      const length = splitFullDiffTokens(segment.text).length;
      segment.wordRange = [offset, offset + length];
      offset += length;
    }
  }

  function patchTranscriptionDiffPayload(payload, textMode = 'fusion', reviewActionId = '') {
    textMode = normalizeExtendedDiffTextMode(textMode);
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.speakerDiffs)) {
      return false;
    }
    // "Current" is the open task, even when the server orders a newer comparison as side B.
    if (textMode !== 'fusion' && payload.referenceReviewActionId === reviewActionId) {
      textMode = textMode === 'reference' ? 'current' : 'reference';
    }

    let patched = false;
    let totalReferenceWords = 0;
    let totalHypothesisWords = 0;
    let totalSubstitutions = 0;
    let totalInsertions = 0;
    let totalDeletions = 0;

    for (const speakerDiff of payload.speakerDiffs) {
      const mappings = Array.isArray(speakerDiff?.segmentMappings) ? speakerDiff.segmentMappings : [];
      for (const mapping of mappings) {
        if (!mapping || typeof mapping !== 'object') {
          continue;
        }

        const referenceText = getString(mapping.referenceText);
        const hypothesisText = getString(mapping.hypothesisText);
        const wordDiffs = buildFullWordDiffs(referenceText, hypothesisText);
        const editCounts = countFullWordDiffEdits(wordDiffs);
        const tags = new Map((mapping.wordDiffs || []).filter(word => word.kind === 'tag')
          .map(word => [word.value, word]));
        for (let index = 0; index < wordDiffs.length; index += 1) {
          const word = wordDiffs[index];
          const tag = tags.get(word.value);
          if (tag) wordDiffs[index] = { ...tag, ...word };
          // Native multi-turn slicing counts tokens on the displayed task's side.
          // Keep alignment/status slots while hiding the other side's text; turning
          // everything into "unchanged" truncates reference text after a split/merge.
          if ((textMode === 'reference' && word.status === 'added') ||
              (textMode === 'current' && word.status === 'removed')) {
            wordDiffs[index].value = '';
          }
        }

        totalReferenceWords += splitFullDiffTokens(referenceText).length;
        totalHypothesisWords += splitFullDiffTokens(hypothesisText).length;
        totalSubstitutions += editCounts.substitutions;
        totalInsertions += editCounts.insertions;
        totalDeletions += editCounts.deletions;

        if (!wordDiffs.length && Array.isArray(mapping.wordDiffs) && !mapping.wordDiffs.length) {
          continue;
        }

        mapping.wordDiffs = wordDiffs;
        mapping.substitutions = editCounts.substitutions;
        mapping.insertions = editCounts.insertions;
        mapping.deletions = editCounts.deletions;
        patchSegmentWordRanges(mapping.segmentsA);
        patchSegmentWordRanges(mapping.segmentsB);
        patched = true;
      }
    }

    if (patched) {
      payload.totalReferenceWords = totalReferenceWords;
      payload.totalHypothesisWords = totalHypothesisWords;
      payload.totalSubstitutions = totalSubstitutions;
      payload.totalInsertions = totalInsertions;
      payload.totalDeletions = totalDeletions;
      payload.overallWordErrorRate =
        (totalSubstitutions + totalInsertions + totalDeletions) / Math.max(1, totalReferenceWords);
    }

    return patched;
  }

  function patchTranscriptionDiffJson(root, textMode = 'fusion', patch = null) {
    textMode = normalizeExtendedDiffTextMode(textMode);
    let patched = false;
    const stack = [root];
    const seen = new Set();

    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) {
        continue;
      }
      seen.add(value);

      if (Array.isArray(value.speakerDiffs) && (!patch ||
          matchesCurrentTranscriptionDiffResult(value, { id: patch.lastAppliedActionId }, patch.reviewActionId))) {
        const original = patch ? structuredClone(value) : null;
        const changed = patchTranscriptionDiffPayload(value, textMode, patch?.reviewActionId);
        if (patch && changed) {
          patch.fetchedDiffPayloads.set(diffPayloadKey(value), { original, projected: JSON.stringify(value) });
        }
        patched = changed || patched;
      }

      if (Array.isArray(value)) {
        for (const child of value) stack.push(child);
      } else {
        for (const child of Object.values(value)) stack.push(child);
      }
    }

    return patched;
  }

  function patchTranscriptionDiffResponseText(text, textMode = 'fusion', patch = null) {
    textMode = normalizeExtendedDiffTextMode(textMode);
    try {
      const json = JSON.parse(text);
      return patchTranscriptionDiffJson(json, textMode, patch) ? JSON.stringify(json) : text;
    } catch (_error) {
      const lines = text.split(/\r?\n/);
      let patched = false;
      const output = lines.map((line) => {
        if (!line.trim()) {
          return line;
        }

        try {
          const json = JSON.parse(line);
          if (patchTranscriptionDiffJson(json, textMode, patch)) {
            patched = true;
            return JSON.stringify(json);
          }
        } catch (_lineError) {
          return line;
        }

        return line;
      });

      return patched ? output.join('\n') : text;
    }
  }

  function getFetchRequestUrl(input) {
    if (typeof input === 'string') {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    if (input instanceof Request) {
      return input.url || '';
    }
    return '';
  }

  function isTranscriptionDiffFetch(input) {
    return getFetchRequestUrl(input).includes('/api/trpc/transcriptions.getTranscriptionDiff');
  }

  async function patchTranscriptionDiffFetchResponse(response, patch) {
    if (!(response instanceof Response) || !response.ok) {
      return response;
    }

    try {
      const text = await response.clone().text();
      if (!isCurrentExtendedDiffPatch(patch)) return response;
      const patchedText = patchTranscriptionDiffResponseText(text, patch.textMode, patch);
      if (patchedText === text) {
        return response;
      }

      return new Response(patchedText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (_error) {
      return response;
    }
  }

  function installExtendedDiffFetchPatch() {
    if (extendedDiffFetchPatch) {
      return true;
    }

    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') {
      return false;
    }

    const patchedFetch = async function patchedExtendedDiffFetch(...args) {
      const patch = extendedDiffPatch;
      const response = await originalFetch.apply(this, args);
      return isCurrentExtendedDiffPatch(patch) && isTranscriptionDiffFetch(args[0])
        ? patchTranscriptionDiffFetchResponse(response, patch) : response;
    };

    extendedDiffFetchPatch = { originalFetch, patchedFetch };
    window.fetch = patchedFetch;
    return true;
  }

  function uninstallExtendedDiffFetchPatch() {
    if (!extendedDiffFetchPatch) {
      return;
    }

    if (window.fetch === extendedDiffFetchPatch.patchedFetch) {
      window.fetch = extendedDiffFetchPatch.originalFetch;
    }
    extendedDiffFetchPatch = null;
  }

  function diffPayloadKey(payload) {
    return `${payload.referenceReviewActionId}:${payload.currentReviewActionId}`;
  }

  function readFetchedDiffOriginal(data, patch) {
    if (!data) return null;
    const fetched = patch.fetchedDiffPayloads.get(diffPayloadKey(data));
    // A fetched projection may be structurally shared with an older query root.
    // Its action IDs alone cannot establish ownership of a later cache-only edit.
    return fetched && JSON.stringify(data) === fetched.projected ? fetched.original : null;
  }

  function patchCurrentDiffResult(action, patch) {
    const observer = findCurrentTranscriptionDiffObserver(action);
    const query = observer?.getCurrentQuery();
    if (!isCurrentExtendedDiffPatch(patch) || typeof query?.setData !== 'function') return false;
    const data = query.state?.data;
    if (!matchesCurrentTranscriptionDiffResult(data, action, patch.reviewActionId)) return false;
    const previous = extendedDiffQueryRecords.get(query);
    const key = diffPayloadKey(data);
    const fetched = readFetchedDiffOriginal(data, patch);
    const original = fetched || (previous?.applied === data ? previous.original : data);
    const projected = structuredClone(original);
    if (!patchTranscriptionDiffPayload(projected, patch.textMode, patch.reviewActionId)) return false;
    // Never mutate a memoized prop/cache value: both React and Query's structural sharing
    // must observe a new diff root to rebuild the native per-turn/deleted-turn maps.
    const applied = query.setData(projected, { manual: true });
    if (fetched) patch.fetchedDiffPayloads.delete(key);
    extendedDiffQueryRecords.set(query, { original, applied });
    return true;
  }

  function restoreExtendedDiffQueries(patch) {
    if (isCurrentExtendedDiffPatch(patch)) {
      const observer = findCurrentTranscriptionDiffObserver({ id: patch.lastAppliedActionId });
      const query = observer?.getCurrentQuery();
      if (query && !extendedDiffQueryRecords.has(query)) {
        const original = readFetchedDiffOriginal(query.state?.data, patch);
        if (original) extendedDiffQueryRecords.set(query, { original });
      }
      for (const [query, record] of extendedDiffQueryRecords) {
        const data = query.state?.data;
        const original = readFetchedDiffOriginal(data, patch) || (record.applied === data ? record.original : null);
        if (original) query.setData(original, { manual: true });
      }
    }
    extendedDiffQueryRecords.clear();
  }

  function findExtendedDiffReviewAction(toolbarProps, payload) {
    const actions = Array.isArray(toolbarProps?.availableReviewActions) ? toolbarProps.availableReviewActions : [];
    const selectedCompareActionId = getString(
      payload?.selectedCompareActionId || payload?.compareActionId || payload?.actionId
    );
    if (selectedCompareActionId) {
      return actions.find((action) => action?.id === selectedCompareActionId) || null;
    }

    const compareLevel = getNumber(payload?.compareLevel);
    return actions.find((action) => compareLevel != null && Number(action?.level) === compareLevel) || null;
  }

  function buildSyntheticExtendedDiffAction(payload) {
    const selectedCompareActionId = getString(
      payload?.selectedCompareActionId || payload?.compareActionId || payload?.actionId
    );
    if (!selectedCompareActionId) {
      return null;
    }

    const compareLevel = getNumber(payload?.compareLevel);
    return {
      id: selectedCompareActionId,
      level: compareLevel,
      label: compareLevel == null ? 'Extended Diff' : `L${compareLevel}`,
      createdAt: new Date().toISOString(),
      workerId: null,
      __babelHelperExtendedDiff: true
    };
  }

  function removeSyntheticExtendedDiffAction(toolbarProps, syntheticExtendedDiffActionId) {
    const availableReviewActions = toolbarProps?.availableReviewActions;
    if (!Array.isArray(availableReviewActions) || !syntheticExtendedDiffActionId) {
      return false;
    }

    const index = availableReviewActions.findIndex(
      (action) => action?.id === syntheticExtendedDiffActionId && action.__babelHelperExtendedDiff === true
    );
    if (index < 0) {
      return false;
    }

    availableReviewActions.splice(index, 1);
    return true;
  }

  function ensureExtendedDiffReviewAction(toolbarProps, payload) {
    const existingAction = findExtendedDiffReviewAction(toolbarProps, payload);
    if (existingAction) {
      return {
        action: existingAction,
        syntheticExtendedDiffActionId: existingAction.__babelHelperExtendedDiff === true ? existingAction.id : null
      };
    }

    const availableReviewActions = toolbarProps?.availableReviewActions;
    if (!Array.isArray(availableReviewActions)) {
      return {
        action: null,
        syntheticExtendedDiffActionId: null
      };
    }

    const syntheticAction = buildSyntheticExtendedDiffAction(payload);
    if (!syntheticAction) {
      return {
        action: null,
        syntheticExtendedDiffActionId: null
      };
    }

    availableReviewActions.push(syntheticAction);
    return {
      action: syntheticAction,
      syntheticExtendedDiffActionId: syntheticAction.id
    };
  }


  function getEditorSnapshot() {
    const binding = readBabelTranscriptBindings();
    const trackState = readBabelTrackBindings()?.tracks;
    const rows = (binding?.annotations || []).filter(annotation => annotation.type === 'transcription')
      .slice().sort((a, b) => (a.startTimeInSeconds ?? 0) - (b.startTimeInSeconds ?? 0))
      .map((annotation, index) => {
        const speakerLabel = binding.tracks.find(track => track.id === annotation.processedRecordingId)?.label || '';
        return { index, annotationId: annotation.id, processedRecordingId: annotation.processedRecordingId,
          speakerKey: annotation.processedRecordingId || speakerLabel, speakerLabel,
          startText: formatTime(annotation.startTimeInSeconds), endText: formatTime(annotation.endTimeInSeconds),
          startSeconds: annotation.startTimeInSeconds, endSeconds: annotation.endTimeInSeconds,
          text: binding.pendingTextById?.[annotation.id] ?? annotation.content ?? '', isActive: binding.transcript?.activeIds?.has(annotation.id) === true };
      });
    return { contractVersion: BABEL_EDITOR_CONTRACT_VERSION, capturedAt: Date.now(), routeKey: getRouteKey(),
      reviewActionId: binding?.reviewActionId || '', readOnly: binding?.readOnly ?? true,
      activeRowId: rows.find(row => row.isActive)?.annotationId || null, rows,
      tracks: (binding?.tracks || []).map(track => ({ id: track.id, label: track.label,
        collapsed: trackState?.find(state => state.id === track.id)?.collapsed ?? null })), playback: getPlaybackSnapshot() };
  }

  function formatTime(value) {
    return Number.isFinite(value) ? `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}` : '';
  }

  function caretRect(row, state, offset) {
    let target = null, localOffset = 0;
    if (state.editor) {
      let start = 0;
      const nodes = row.querySelectorAll('[data-slate-node="text"]');
      for (const [index, node] of state.editor.children[0].children.entries()) {
        const length = (node.text ?? node.raw ?? '').length;
        if (typeof node.text === 'string' && offset <= start + length) {
          target = nodes[index]; localOffset = Math.max(0, offset - start); break;
        }
        start += length;
      }
    } else {
      for (const node of row.querySelectorAll('[data-offset]')) {
        const start = Number(node.getAttribute('data-offset'));
        const chip = Number(node.getAttribute('data-chip')) || 0;
        const length = chip || node.textContent.length;
        if (offset >= start && offset <= start + length) {
          if (chip) {
            const rect = node.getBoundingClientRect();
            const x = offset - start < length / 2 ? rect.left : rect.right;
            return { top: rect.top, bottom: rect.bottom, left: x, right: x, width: 0, height: rect.height };
          }
          target = node; localOffset = offset - start; break;
        }
      }
    }
    if (!target) return null;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (localOffset <= textNode.length) {
        const range = document.createRange();
        range.setStart(textNode, localOffset); range.collapse(true);
        const rect = range.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
      }
      localOffset -= textNode.length;
    }
    return null;
  }

  function slatePointRange(element, point) {
    const leaf = element.querySelectorAll('[data-slate-node="text"]')[point.path[1]];
    if (!leaf) return null;
    const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
    let offset = point.offset, node;
    while ((node = walker.nextNode())) {
      if (offset <= node.length) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        return range;
      }
      offset -= node.length;
    }
    return null;
  }

  function pageNativeSelection(row, state, request) {
    const element = row.querySelector('[data-slate-editor="true"]');
    const viewport = element?.closest('[data-transcript-scroll]');
    const selection = window.getSelection();
    if (!state.editor || !element?.isContentEditable || document.activeElement !== element ||
        !viewport?.clientHeight || !element.contains(selection?.anchorNode) ||
        !element.contains(selection?.focusNode) ||
        (request.direction !== 'up' && request.direction !== 'down')) return null;
    const anchor = state.direction === 'backward' ? state.end : state.start;
    const focus = state.direction === 'backward' ? state.start : state.end;
    const caret = caretRect(row, state, focus);
    const first = caretRect(row, state, 0), last = caretRect(row, state, state.text.length);
    if (!caret?.height || !first?.height || !last?.height) return null;
    const bounds = viewport.getBoundingClientRect();
    const top = bounds.top + viewport.clientTop;
    const bottom = top + viewport.clientHeight;
    const distance = Math.max(caret.height, viewport.clientHeight - caret.height);
    const targetY = caret.top + caret.height / 2 + (request.direction === 'down' ? distance : -distance);
    let offset = targetY < first.top ? 0 : targetY >= last.bottom ? state.text.length : null;
    const previousTop = viewport.scrollTop;
    // Keep the new focus at the old caret's viewport position where possible.
    // Only the transcript scrolls; neither DOM selection nor focus reveals ancestors.
    const y = offset === 0 ? first.top + first.height / 2
      : offset === state.text.length ? last.top + last.height / 2 : targetY;
    const visibleY = Math.max(top + caret.height / 2,
      Math.min(bottom - caret.height / 2, caret.top + caret.height / 2));
    viewport.scrollTop += y - visibleY;
    if (offset === null) {
      const box = element.getBoundingClientRect();
      const x = Math.max(Math.max(bounds.left + viewport.clientLeft, box.left) + 1,
        Math.min(Math.min(bounds.left + viewport.clientLeft + viewport.clientWidth, box.right) - 1, caret.left));
      const hitY = Math.max(top + 1, Math.min(bottom - 1, y - (viewport.scrollTop - previousTop)));
      const point = document.caretPositionFromPoint?.(x, hitY);
      const range = point ? null : document.caretRangeFromPoint?.(x, hitY);
      offset = nativeDomPointOffset(row, point?.offsetNode || range?.startContainer,
        point ? point.offset : range?.startOffset, state.editor);
    }
    if (offset === null) {
      viewport.scrollTop = previousTop;
      return null;
    }
    const start = request.extend ? Math.min(anchor, offset) : offset;
    const end = request.extend ? Math.max(anchor, offset) : offset;
    const direction = request.extend && anchor !== offset ? (anchor > offset ? 'backward' : 'forward') : 'none';
    if (!selectNativeSlate(state.editor, start, end, direction)) {
      viewport.scrollTop = previousTop;
      return null;
    }
    const native = state.editor.selection;
    const anchorRange = slatePointRange(element, native.anchor);
    const focusRange = slatePointRange(element, native.focus);
    if (!anchorRange || !focusRange) {
      selectNativeSlate(state.editor, state.start, state.end, state.direction);
      viewport.scrollTop = previousTop;
      return null;
    }
    // Project the exact native points before Slate's render effect. An already
    // matching DOM selection does not trigger Slate's ancestor scrollIntoView.
    selection.setBaseAndExtent(anchorRange.startContainer, anchorRange.startOffset,
      focusRange.startContainer, focusRange.startOffset);
    return readNativeSlateSelection(state.editor);
  }

  function getStartNativeEdit(annotationId) {
    return findNativeDescendant(findNativeTurnFiber(annotationId),
      fiber => typeof fiber.memoizedProps?.onStartEdit === 'function')?.memoizedProps.onStartEdit;
  }

  function handleEditorControl(event) {
    if (disposed) return;
    let request;
    try { request = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail; } catch { return; }
    if (!request?.id) return;
    if (request.operation === 'identities') {
      if (event.target !== document.documentElement) return;
      const rows = !sessionError && sessionUnsubscribe ? rowIdentityIndex.reconcile() : null;
      document.documentElement.setAttribute('data-babel-helper-editor-result', JSON.stringify({
        id: request.id, ok: Boolean(rows), href: window.location.href, generation: sessionGeneration,
        annotationRevision: rows?.revision ?? null, ...rows
      }));
      return;
    }
    if (request.operation === 'session') {
      if (event.target !== document.documentElement) return;
      const binding = !sessionError && sessionUnsubscribe ? readBabelSessionState() : null;
      const ok = Boolean(binding && typeof binding.reviewActionId === 'string' && binding.reviewActionId.length > 0);
      document.documentElement.setAttribute('data-babel-helper-editor-result', JSON.stringify({
        id: request.id, ok, reviewActionId: ok ? binding.reviewActionId : '',
        readOnly: ok ? binding.readOnly : true, routeKey: getRouteKey(), error: sessionError
      }));
      return;
    }
    const responseRow = event.target instanceof Element ? event.target.closest(TRANSCRIPT_ROW_SELECTOR) : null;
    if (!responseRow) return;
    // Identity is presentation metadata, not a Classic input read. In
    // particular it must never flush pending text or serialize a selection.
    if (request.operation === 'identity') {
      const annotationId = responseRow.getAttribute('data-annotation-id');
      const identity = annotationId === request.annotationId ? readBabelTurnIdentity(annotationId) : null;
      const ok = Boolean(identity && (!request.reviewActionId || request.reviewActionId === identity.reviewActionId) &&
        (request.processedRecordingId === undefined || request.processedRecordingId === identity.processedRecordingId));
      responseRow.setAttribute('data-babel-helper-editor-result', JSON.stringify({ ...identity, id: request.id, ok }));
      return;
    }
    if (responseRow.getAttribute('data-babel-classic-row') === 'true') {
      const annotationId = responseRow.getAttribute('data-annotation-id');
      let owned = readBabelClassicInput(annotationId);
      let identity = readBabelTurnIdentity(annotationId);
      let ok = Boolean(owned && owned.row === responseRow && identity && annotationId === request.annotationId &&
        (!request.reviewActionId || request.reviewActionId === identity.reviewActionId) &&
        (request.processedRecordingId === undefined || request.processedRecordingId === identity.processedRecordingId));
      const operation = request.operation;
      const read = ['read', 'caretRect', 'offsetAtPoint'].includes(operation);
      if (!read && owned?.readOnly) ok = false;
      let rect = null, offset = null, reason = ok ? undefined : 'stale-or-read-only-classic-input';
      try {
        if (ok && (operation === 'focus' || operation === 'replace' || (operation === 'select' && request.activateRow))) {
          ok = flushBabelClassicInputs();
          owned = readBabelClassicInput(annotationId);
          ok = Boolean(ok && owned && owned.row === responseRow && !owned.readOnly);
        }
        if (ok) {
          const input = owned.input, state = input.read();
          const start = request.selectAll ? 0 : Number(request.start ?? state.start);
          const end = request.selectAll ? state.text.length : Number(request.end ?? start);
          if (operation === 'focus' || operation === 'select') {
            ok = input.select(start, end, request.direction || 'none', operation === 'focus' || request.activateRow === true);
          } else if (operation === 'replace') ok = input.replace(request.text, request);
          else if (operation === 'replaceMany') ok = replaceClassicTurns(request);
          else if (operation === 'pageSelection') ok = input.page(request.direction, request.extend === true);
          else if (operation === 'caretRect') { rect = input.rects(start)[0] || null; ok = Boolean(rect); }
          else if (operation === 'offsetAtPoint') { offset = input.offsetAtPoint(request.x, request.y); ok = offset !== null; }
          else if (!['read', 'syncSelection'].includes(operation)) ok = false;
        }
      } catch (error) {
        ok = false;
        reason = error instanceof Error ? error.message : String(error);
        showNativeAutomationFailure('Classic native text editing', reason);
      }
      owned = readBabelClassicInput(annotationId);
      identity = readBabelTurnIdentity(annotationId);
      const latest = owned?.input.read();
      responseRow.setAttribute('data-babel-helper-editor-result', JSON.stringify({
        ...identity, id: request.id, ok: Boolean(ok && owned && identity), reason,
        text: latest?.text ?? '', start: offset ?? latest?.start ?? 0, end: offset ?? latest?.end ?? 0,
        direction: offset === null ? latest?.direction ?? 'none' : 'none', readOnly: owned?.readOnly ?? true,
        ...(rect ? { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          bottom: rect.bottom, right: rect.right } } : {})
      }));
      return;
    }
    let row = responseRow;
    let binding = readBabelTranscriptBindings();
    const annotationId = row.getAttribute('data-annotation-id');
    const taskId = binding?.reviewActionId;
    let state = binding && readNativeTurn(annotationId, binding);
    let ok = Boolean(state && annotationId === request.annotationId &&
      (!request.reviewActionId || request.reviewActionId === binding.reviewActionId) &&
      (request.processedRecordingId === undefined || request.processedRecordingId === (state.annotation.processedRecordingId ?? null)));
    let reason = ok ? undefined : 'stale-task';
    const operation = request.operation;
    const selectAll = operation === 'select' && request.selectAll === true;
    let pointerOffset = null;
    let acceptedSelection = null;
    if (ok && !['read', 'caretRect', 'offsetAtPoint'].includes(operation) && binding.readOnly) { ok = false; reason = 'read-only'; }
    const activating = operation === 'focus' ||
      (operation === 'select' && !selectAll && (!state?.editor || Boolean(request.activateRow))) ||
      (operation === 'replace' && Boolean(request.focus));
    if (ok && activating) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.isConnected &&
          focused.matches(TRANSCRIPT_EDITOR_SELECTOR) &&
          focused.closest(TRANSCRIPT_ROW_SELECTOR) !== row) {
        // Native activation can replace the other turn before browser default
        // blur. Flush/blur while that editor's native DOM mapping still exists.
        const routeAtBlur = getRouteKey();
        focused.blur();
        binding = readBabelTranscriptBindings();
        row = Array.from(document.querySelectorAll(TRANSCRIPT_ROW_SELECTOR))
          .find(candidate => candidate.getAttribute('data-annotation-id') === annotationId) || null;
        state = binding && row && readNativeTurn(annotationId, binding);
        ok = Boolean(!disposed && getRouteKey() === routeAtBlur &&
          binding?.reviewActionId === taskId && row && state && !binding.readOnly);
        if (!ok) reason = binding?.reviewActionId === taskId && binding?.readOnly ? 'read-only' : 'stale-task';
      }
    }
    if (ok) {
      const start = selectAll ? 0 : Math.max(0, Math.min(Number(request.start ?? state.start), state.text.length));
      const end = selectAll ? state.text.length : Math.max(start, Math.min(Number(request.end ?? start), state.text.length));
      if (!Number.isFinite(start) || !Number.isFinite(end)) { ok = false; reason = 'invalid-selection'; }
      else if (selectAll) {
        const element = row.querySelector('[data-slate-editor="true"]');
        const selection = window.getSelection();
        if (!state.editor || !element?.isConnected || document.activeElement !== element) {
          ok = false; reason = 'editor-not-focused';
        } else if (!selection || typeof selection.selectAllChildren !== 'function') {
          ok = false; reason = 'selection-unavailable';
        } else {
          pendingNativeSelections.delete(row);
          ok = selectNativeSlate(state.editor, 0, state.text.length, 'forward');
          const model = ok && readNativeSlateSelection(state.editor);
          ok = Boolean(model && model.start === 0 && model.end === state.text.length);
          if (ok) {
            selection.selectAllChildren(element);
            const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
            ok = Boolean(element.isConnected && document.activeElement === element &&
              range?.startContainer === element && range.startOffset === 0 &&
              range.endContainer === element && range.endOffset === element.childNodes.length);
            if (ok) acceptedSelection = model;
          }
          if (!ok) reason = 'selection-unavailable';
        }
      }
      else if (operation === 'pageSelection') {
        acceptedSelection = pageNativeSelection(row, state, request);
        ok = Boolean(acceptedSelection);
        if (!ok) reason = 'paging-unavailable';
      }
      else if (operation === 'focus' || operation === 'select') {
        if (request.activateRow) binding.transcript?.handlers?.onActivate(annotationId);
        if (state.editor) {
          if (activating) row.querySelector('[data-slate-editor="true"]')?.focus({ preventScroll: true });
          ok = selectNativeSlate(state.editor, start, end, request.direction);
        } else {
          const startEdit = getStartNativeEdit(annotationId);
          ok = Boolean(startEdit);
          startEdit?.({ anchor: request.direction === 'backward' ? end : start, focus: request.direction === 'backward' ? start : end });
        }
        if (ok) acceptedSelection = (state.editor && readNativeSlateSelection(state.editor)) ||
          { start, end, direction: request.direction || 'none' };
      } else if (operation === 'replace') {
        const startEdit = !state.editor && request.focus ? getStartNativeEdit(annotationId) : null;
        try {
          ok = (!request.focus || state.editor || startEdit) && replaceNativeTurn(annotationId, request.text, request);
        } catch (error) {
          ok = false;
          reason = error instanceof Error ? error.message : String(error);
          showNativeAutomationFailure('Native text editing', reason);
        }
        if (ok) {
          const nextStart = Math.max(0, Math.min(request.start ?? request.text.length, request.text.length));
          const nextEnd = Math.max(nextStart, Math.min(request.end ?? nextStart, request.text.length));
          acceptedSelection = (state.editor && readNativeSlateSelection(state.editor)) ||
            { start: nextStart, end: nextEnd, direction: request.direction || 'none' };
          if (request.focus) {
            if (state.editor) row.querySelector('[data-slate-editor="true"]')?.focus({ preventScroll: true });
            else startEdit({ anchor: request.direction === 'backward' ? nextEnd : nextStart,
              focus: request.direction === 'backward' ? nextStart : nextEnd });
          }
        }
      } else if (operation === 'syncSelection') {
        const element = row.querySelector('[data-slate-editor="true"]');
        const selection = window.getSelection();
        // Synchronize only the actual active text selection. Static turns and
        // selections outside their editor are intentionally untouched.
        let pending = pendingNativeSelections.get(row);
        if (pending && (pending.taskId !== taskId || pending.text !== state.text ||
            (pending.editor && pending.editor !== state.editor))) {
          pendingNativeSelections.delete(row);
          pending = null;
        }
        if (request.source === 'intent') {
          pendingNativeSelections.delete(row);
          pending = null;
        }
        if (request.source === 'intent') {
          acceptedSelection = state.editor && readNativeSlateSelection(state.editor);
        } else if (state.editor && element?.contains(selection?.anchorNode) && element.contains(selection?.focusNode)) {
          const model = pending && readNativeSlateSelection(state.editor);
          if (pending) pending.editor = state.editor;
          // A native focus/select can commit before Slate projects its range into
          // the DOM. Neither notification nor text input makes old DOM new selection intent.
          if (pending && (!model || model.start !== state.start || model.end !== state.end ||
              model.direction !== state.direction)) {
            acceptedSelection = model;
            if (!model) { ok = false; reason = 'native-selection-pending'; }
          } else {
            pendingNativeSelections.delete(row);
            ok = selectNativeSlate(state.editor, state.start, state.end, state.direction);
            if (ok) acceptedSelection = { start: state.start, end: state.end, direction: state.direction };
          }
        }
      } else if (operation === 'offsetAtPoint') {
        const point = document.caretPositionFromPoint?.(request.x, request.y);
        const range = point ? null : document.caretRangeFromPoint?.(request.x, request.y);
        pointerOffset = nativeDomPointOffset(row, point?.offsetNode || range?.startContainer,
          point ? point.offset : range?.startOffset, state.editor);
        ok = pointerOffset !== null;
        if (!ok) reason = 'point-outside-text';
      } else if (operation !== 'read' && operation !== 'caretRect') { ok = false; reason = 'unknown-operation'; }
    }
    const latest = state && readNativeTurn(annotationId);
    if (ok && acceptedSelection && (operation === 'focus' || operation === 'select' || operation === 'pageSelection' ||
        (operation === 'replace' && (state.editor || request.focus)))) {
      pendingNativeSelections.set(row, { taskId, editor: state.editor,
        text: operation === 'replace' && !state.editor ? request.text : latest?.text ?? state.text });
    }
    const text = operation === 'replace' && ok ? request.text : latest?.text ?? '';
    responseRow.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: Boolean(ok), reason, text,
      start: pointerOffset ?? acceptedSelection?.start ?? latest?.start ?? 0,
      end: pointerOffset ?? acceptedSelection?.end ?? latest?.end ?? 0,
      direction: pointerOffset === null ? acceptedSelection?.direction ?? latest?.direction ?? 'none' : 'none',
      readOnly: binding?.readOnly ?? true,
      annotationId, reviewActionId: binding?.reviewActionId ?? '', processedRecordingId: state?.annotation.processedRecordingId ?? '',
      trackLabel: binding?.tracks.find(track => track.id === state?.annotation.processedRecordingId)?.label ?? '',
      startSeconds: state?.annotation.startTimeInSeconds ?? null, endSeconds: state?.annotation.endTimeInSeconds ?? null,
      isActive: binding?.transcript?.activeIds?.has(annotationId) === true,
      isEditing: latest?.isEditing === true,
      ...(operation === 'caretRect' && ok ? { rect: caretRect(row, state, request.start ?? state.start) } : {})
    }));
  }

  function getPlaybackSnapshot() {
    const playbackBridge = window.__babelHelperPlaybackBridge;
    if (playbackBridge && typeof playbackBridge.getPlaybackState === 'function') {
      try {
        const state = playbackBridge.getPlaybackState();
        return {
          currentTime: Number.isFinite(Number(state?.currentTime)) ? Number(state.currentTime) : null,
          duration: Number.isFinite(Number(state?.duration)) ? Number(state.duration) : null,
          paused: typeof state?.paused === 'boolean' ? state.paused : null,
          rate: Number.isFinite(Number(state?.playbackRate)) ? Number(state.playbackRate) : null,
          source: 'playback-bridge'
        };
      } catch (_error) {
        return {
          currentTime: null,
          duration: null,
          paused: null,
          rate: null,
          source: 'playback-bridge-error'
        };
      }
    }

    return {
      currentTime: null,
      duration: null,
      paused: null,
      rate: null,
      source: 'unavailable'
    };
  }


  function applyExtendedDiffState(payload) {
    if (payload?.routeKey && payload.routeKey !== getRouteKey()) return { ok: false, reason: 'stale-task' };
    if ((payload?.nativeSessionGeneration != null && payload.nativeSessionGeneration !== sessionGeneration) ||
        (payload?.editorGeneration != null && payload.editorGeneration !== readExtendedDiffEditorGeneration())) {
      return { ok: false, reason: 'stale-task' };
    }
    const toolbarProps = getTranscriptionDiffToolbarProps();
    const reviewActionId = readBabelTranscriptBindings()?.reviewActionId;
    if (!reviewActionId) return { ok: false, reason: 'transcription-task-not-found' };
    if ((payload?.referenceReviewActionId || payload?.currentReviewActionId) &&
        payload.referenceReviewActionId !== reviewActionId && payload.currentReviewActionId !== reviewActionId) {
      return { ok: false, reason: 'stale-task' };
    }
    if (!toolbarProps) {
      return {
        ok: false,
        reason: 'transcription-diff-toolbar-not-found'
      };
    }

    const ensuredAction = ensureExtendedDiffReviewAction(toolbarProps, payload || {});
    const action = ensuredAction.action;
    if (!action || typeof action.id !== 'string' || !action.id) {
      return {
        ok: false,
        reason: 'compare-action-not-found'
      };
    }

    const currentSelectedCompareActionId =
      typeof toolbarProps.selectedCompareActionId === 'string' ? toolbarProps.selectedCompareActionId : null;
    const currentIsDiffMode = toolbarProps.isDiffMode === true;
    const routeKey = getString(payload?.routeKey) || getRouteKey();
    const textMode = normalizeExtendedDiffTextMode(payload?.textMode);

    if (!isCurrentExtendedDiffPatch(extendedDiffPatch)) {
      extendedDiffQueryRecords.clear();
      extendedDiffPatch = {
        routeKey,
        reviewActionId,
        editorFiber: findBabelEditorFiber(),
        fetchedDiffPayloads: new Map(),
        previousIsDiffMode: currentIsDiffMode,
        previousSelectedCompareActionId: currentSelectedCompareActionId,
        syntheticExtendedDiffActionId: ensuredAction.syntheticExtendedDiffActionId,
        lastAppliedActionId: action.id,
        textMode
      };
    } else {
      if (
        extendedDiffPatch.syntheticExtendedDiffActionId &&
        extendedDiffPatch.syntheticExtendedDiffActionId !== ensuredAction.syntheticExtendedDiffActionId
      ) {
        removeSyntheticExtendedDiffAction(toolbarProps, extendedDiffPatch.syntheticExtendedDiffActionId);
      }
      extendedDiffPatch.syntheticExtendedDiffActionId = ensuredAction.syntheticExtendedDiffActionId;
      extendedDiffPatch.lastAppliedActionId = action.id;
      extendedDiffPatch.textMode = textMode;
    }

    const fetchPatchInstalled = installExtendedDiffFetchPatch();
    const patchedCurrentDiffResult = patchCurrentDiffResult(action, extendedDiffPatch);
    // Do not bounce the selected action through null: it races native query activation
    // and can reselect an old action after a newer mode/task request.
    if (!currentIsDiffMode) toolbarProps.onToggleDiffMode(true);
    if (currentSelectedCompareActionId !== action.id) toolbarProps.onSelectCompareAction(action.id);

    return {
      ok: patchedCurrentDiffResult,
      ...(!patchedCurrentDiffResult ? { reason: 'transcription-diff-query-data-unavailable' } : {}),
      actionId: action.id,
      compareLevel: getNumber(action.level),
      syntheticActionInserted: Boolean(ensuredAction.syntheticExtendedDiffActionId),
      fetchPatchInstalled,
      patchedCurrentDiffResult,
      textMode,
      previousIsDiffMode: extendedDiffPatch.previousIsDiffMode,
      previousSelectedCompareActionId: extendedDiffPatch.previousSelectedCompareActionId
    };
  }

  function clearExtendedDiffState() {
    restoreExtendedDiffQueries(extendedDiffPatch);
    uninstallExtendedDiffFetchPatch();

    if (!extendedDiffPatch) {
      return {
        ok: true,
        restored: false
      };
    }
    if (!isCurrentExtendedDiffPatch(extendedDiffPatch)) {
      extendedDiffPatch = null;
      return { ok: true, restored: false, reason: 'stale-task' };
    }

    const toolbarProps = getTranscriptionDiffToolbarProps();
    if (!toolbarProps) {
      extendedDiffPatch = null;
      return {
        ok: false,
        restored: false,
        reason: 'transcription-diff-toolbar-not-found'
      };
    }

    const currentSelectedCompareActionId =
      typeof toolbarProps.selectedCompareActionId === 'string' ? toolbarProps.selectedCompareActionId : null;
    const currentIsDiffMode = toolbarProps.isDiffMode === true;
    if (!currentIsDiffMode) {
      removeSyntheticExtendedDiffAction(toolbarProps, extendedDiffPatch.syntheticExtendedDiffActionId);
      extendedDiffPatch = null;
      return {
        ok: true,
        restored: false,
        reason: 'diff-mode-off'
      };
    }

    if (
      currentSelectedCompareActionId &&
      extendedDiffPatch.lastAppliedActionId &&
      currentSelectedCompareActionId !== extendedDiffPatch.lastAppliedActionId
    ) {
      removeSyntheticExtendedDiffAction(toolbarProps, extendedDiffPatch.syntheticExtendedDiffActionId);
      extendedDiffPatch = null;
      return {
        ok: true,
        restored: false,
        reason: 'user-changed-selection'
      };
    }

    if (extendedDiffPatch.previousIsDiffMode) {
      if (currentSelectedCompareActionId !== extendedDiffPatch.previousSelectedCompareActionId) {
        toolbarProps.onSelectCompareAction(extendedDiffPatch.previousSelectedCompareActionId);
      }
    } else {
      toolbarProps.onToggleDiffMode(false);
    }

    removeSyntheticExtendedDiffAction(toolbarProps, extendedDiffPatch.syntheticExtendedDiffActionId);
    extendedDiffPatch = null;
    return {
      ok: true,
      restored: true
    };
  }

  const rawImplementation = {
    getEditorSnapshot,
    readExtendedDiffState,
    applyExtendedDiffState,
    clearExtendedDiffState,
    getNativeReplacementStatus,
    runNativeReplacementRules,
    recoverNativeReplacementRules,
    acceptAllNativeWarnings,
    getTranscriptionDiffToolbarProps,
    findCurrentTranscriptionDiffQueryResult,
    patchTranscriptionDiffPayload,
    patchTranscriptionDiffResponseText
  };
  const implementation = {
    getEditorSnapshot,
    readExtendedDiffState,
    applyExtendedDiffState,
    clearExtendedDiffState,
    getNativeReplacementStatus,
    runNativeReplacementRules,
    recoverNativeReplacementRules,
    acceptAllNativeWarnings,
    raw: rawImplementation
  };

  function getHostServiceRegistry() {
    const services = window.BabelMods?.unsafe?.services;
    return services && typeof services.invoke === 'function' ? services : null;
  }

  function ensureServiceProvider() {
    const currentRegistry = getHostServiceRegistry();
    if (!currentRegistry || typeof currentRegistry.provide !== 'function') {
      return null;
    }

    if (serviceRegistry === currentRegistry && serviceProviderHandle) {
      return currentRegistry;
    }

    if (serviceProviderHandle && typeof serviceProviderHandle.dispose === 'function') {
      serviceProviderHandle.dispose();
    }
    serviceRegistry = currentRegistry;
    serviceProviderHandle = currentRegistry.provide(SERVICE_ID, implementation, {
      owner: 'builtin:recovered-editor'
    });
    return currentRegistry;
  }

  function invokeService(method, ...args) {
    const currentRegistry = ensureServiceProvider();
    if (currentRegistry) {
      return currentRegistry.invoke(SERVICE_ID, method, ...args);
    }

    const operation = implementation[method];
    if (typeof operation !== 'function') {
      throw new TypeError(`Unknown ${SERVICE_ID} operation: ${String(method)}`);
    }
    return operation.apply(implementation, args);
  }

  function handleRequest(event) {
    const detail = event.detail || {};
    const id = detail.id;
    if (!id) {
      return;
    }
    if (Object.hasOwn(REPLACEMENT_METHODS, detail.operation)) {
      try {
        respond(id, invokeService(REPLACEMENT_METHODS[detail.operation], detail.payload));
      } catch (error) {
        respond(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (detail.operation === 'accept-all-warnings') {
      Promise.resolve().then(() => invokeService('acceptAllNativeWarnings', detail.payload)).then(
        result => respond(id, result),
        error => respond(id, { ok: false, error: error instanceof Error ? error.message : String(error) })
      );
      return;
    }

    if (detail.operation === 'snapshot') {
      respond(id, {
        ok: true,
        snapshot: invokeService('getEditorSnapshot')
      });
      return;
    }

    if (detail.operation === 'read-extended-diff-state') {
      respond(id, invokeService('readExtendedDiffState'));
      return;
    }

    if (detail.operation === 'apply-extended-diff-state') {
      respond(id, invokeService('applyExtendedDiffState', detail.payload || {}));
      return;
    }

    if (detail.operation === 'clear-extended-diff-state') {
      respond(id, invokeService('clearExtendedDiffState'));
      return;
    }

    respond(id, {
      ok: false,
      reason: 'unknown-operation'
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    retireNativeCompatibility();
    reconcileNativeCoverage(null);
    sessionGeneration++;
    sessionUnsubscribe?.();
    sessionUnsubscribe = null;
    rowIdentityIndex.dispose();
    sessionMountObserver.disconnect();
    sessionMountQueued = false;
    sessionMountSeeds = [];
    window.navigation?.removeEventListener('currententrychange', publishRoute);
    window.removeEventListener('popstate', publishRoute, true);
    window.removeEventListener('hashchange', publishRoute, true);
    for (const { name, original, wrapped } of historyPatches) {
      if (window.history[name] === wrapped) window.history[name] = original;
    }
    if (document.documentElement.getAttribute(SESSION_ATTRIBUTE) === publishedSessionPayload) {
      document.documentElement.removeAttribute(SESSION_ATTRIBUTE);
    }
    clearExtendedDiffState();
    restoreNativeActivation();
    if (serviceProviderHandle && typeof serviceProviderHandle.dispose === 'function') {
      serviceProviderHandle.dispose();
    }
    serviceProviderHandle = null;
    serviceRegistry = null;
    window.removeEventListener(REQUEST_EVENT, handleRequest, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    window.removeEventListener('babel-helper:editor-control', handleEditorControl, true);
    window.removeEventListener('mousedown', handleNativeActivationCapture, true);
    window.removeEventListener('focusin', handleNativeActivationCapture, true);
    window.removeEventListener('keydown', handleNativeTagDropdownKeydown, true);
    window.removeEventListener(NATIVE_COMPATIBILITY_CHANGE_EVENT, reconcileNativeCompatibility);
    window.removeEventListener('pointerdown', handleNativeMergeInteraction, true);
    window.removeEventListener('keydown', handleNativeMergeInteraction, true);
    window.removeEventListener('click', handleNativeMergeInteraction, true);
    delete window.__babelHelperRecoveredEditorBridge;
  }

  ensureServiceProvider();
  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);
  window.addEventListener('babel-helper:editor-control', handleEditorControl, true);
  window.addEventListener('mousedown', handleNativeActivationCapture, true);
  window.addEventListener('focusin', handleNativeActivationCapture, true);
  window.addEventListener('keydown', handleNativeTagDropdownKeydown, true);
  window.addEventListener(NATIVE_COMPATIBILITY_CHANGE_EVENT, reconcileNativeCompatibility);
  window.addEventListener('pointerdown', handleNativeMergeInteraction, true);
  window.addEventListener('keydown', handleNativeMergeInteraction, true);
  window.addEventListener('click', handleNativeMergeInteraction, true);

  window.__babelHelperRecoveredEditorBridge = {
    getEditorSnapshot: (...args) => invokeService('getEditorSnapshot', ...args),
    readExtendedDiffState: (...args) => invokeService('readExtendedDiffState', ...args),
    applyExtendedDiffState: (...args) => invokeService('applyExtendedDiffState', ...args),
    clearExtendedDiffState: (...args) => invokeService('clearExtendedDiffState', ...args),
    acceptAllNativeWarnings: (...args) => invokeService('acceptAllNativeWarnings', ...args),
    implementation: rawImplementation,
    dispose
  };
  reconcileNativeSession();
}

initRecoveredEditorBridge();
