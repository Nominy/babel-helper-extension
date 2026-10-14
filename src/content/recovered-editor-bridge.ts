// @ts-nocheck
import { findBabelEditorFiber, readBabelTranscriptBindings, readBabelTrackBindings, readBabelPlaybackBindings, readBabelSessionState, readBabelTurnIdentity } from '@nominy/babel-babel-runtime';
import { BABEL_EDITOR_CONTRACT_VERSION } from '../core/babel-editor-contract';
import {
  findNativeDescendant, findNativeTurnFiber, readNativeTurn, readNativeSlateSelection, replaceNativeTurn, selectNativeSlate, nativeDomPointOffset,
  TRANSCRIPT_ROW_SELECTOR
} from './native-transcript';
import { SEGMENT_CLICK_SEEK_ATTRIBUTE } from '../features/native-segment-click-seek-feature';
import { handleNativeTagDropdownKeydown } from './native-tag-dropdown-keyboard';

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
  let nativeActivationPatch = null;
  if (existingBridge && typeof existingBridge.dispose === 'function') {
    existingBridge.dispose();
  }

  function restoreNativeActivation() {
    const patch = nativeActivationPatch;
    if (patch && patch.handlers.onActivate === patch.wrapped) {
      patch.handlers.onActivate = patch.original;
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
    if (!handlers || typeof handlers.onActivate !== 'function') return;
    if (nativeActivationPatch?.handlers === handlers && handlers.onActivate === nativeActivationPatch.wrapped) return;
    restoreNativeActivation();
    const original = handlers.onActivate;
    const reviewActionId = binding.reviewActionId;
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
        // Native activation still selects/highlights the turn. Only its
        // synchronous incidental seek is suppressed, never seeked back afterward.
        return original.apply(this, args);
      } finally {
        for (const { wave, descriptor, blockedSeek } of patches) {
          if (wave.seekTo !== blockedSeek) continue;
          if (descriptor) Object.defineProperty(wave, 'seekTo', descriptor);
          else delete wave.seekTo;
        }
      }
    };
    handlers.onActivate = wrapped;
    nativeActivationPatch = { handlers, original, wrapped };
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
            matchesCurrentTranscriptionDiffResult(memoizedState.getCurrentResult()?.data, action)) {
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

  function scheduleCurrentTranscriptionDiffRepaint(action) {
    const patch = extendedDiffPatch;
    const operation = patch?.operation;
    window.setTimeout(() => {
      if (!isCurrentExtendedDiffPatch(patch) || patch.operation !== operation) return;
      patchCurrentDiffResult(action, patch);
    }, 50);
    return true;
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
        if (patch) patch.originalPayloads.set(diffPayloadKey(value), structuredClone(value));
        patched = patchTranscriptionDiffPayload(value, textMode, patch?.reviewActionId) || patched;
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

  function patchCurrentDiffResult(action, patch) {
    const observer = findCurrentTranscriptionDiffObserver(action);
    const query = observer?.getCurrentQuery();
    if (!isCurrentExtendedDiffPatch(patch) || typeof query?.setData !== 'function') return false;
    const data = query.state?.data;
    if (!matchesCurrentTranscriptionDiffResult(data, action, patch.reviewActionId)) return false;
    const previous = extendedDiffQueryRecords.get(query);
    const original = patch.originalPayloads.get(diffPayloadKey(data)) ||
      (previous?.applied === data ? previous.original : data);
    const projected = structuredClone(original);
    if (!patchTranscriptionDiffPayload(projected, patch.textMode, patch.reviewActionId)) return false;
    // Never mutate a memoized prop/cache value: both React and Query's structural sharing
    // must observe a new diff root to rebuild the native per-turn/deleted-turn maps.
    const applied = query.setData(projected, { manual: true });
    extendedDiffQueryRecords.set(query, { original, applied });
    return true;
  }

  function restoreExtendedDiffQueries(patch) {
    if (isCurrentExtendedDiffPatch(patch)) {
      const observer = findCurrentTranscriptionDiffObserver({ id: patch.lastAppliedActionId });
      const query = observer?.getCurrentQuery();
      if (query && !extendedDiffQueryRecords.has(query)) {
        const original = patch.originalPayloads.get(diffPayloadKey(query.state.data));
        if (original) extendedDiffQueryRecords.set(query, { original });
      }
      for (const [query, record] of extendedDiffQueryRecords) {
        const original = patch.originalPayloads.get(diffPayloadKey(record.original)) || record.original;
        query.setData(original, { manual: true });
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

  function getStartNativeEdit(annotationId) {
    return findNativeDescendant(findNativeTurnFiber(annotationId),
      fiber => typeof fiber.memoizedProps?.onStartEdit === 'function')?.memoizedProps.onStartEdit;
  }

  function handleEditorControl(event) {
    if (disposed) return;
    let request;
    try { request = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail; } catch { return; }
    if (!request?.id) return;
    if (request.operation === 'session') {
      if (event.target !== document.documentElement) return;
      const binding = readBabelSessionState();
      const ok = Boolean(binding && typeof binding.reviewActionId === 'string' && binding.reviewActionId.length > 0);
      document.documentElement.setAttribute('data-babel-helper-editor-result', JSON.stringify({
        id: request.id, ok, reviewActionId: ok ? binding.reviewActionId : '',
        readOnly: ok ? binding.readOnly : true, routeKey: getRouteKey()
      }));
      return;
    }
    const responseRow = event.target instanceof Element ? event.target.closest(TRANSCRIPT_ROW_SELECTOR) : null;
    if (!responseRow) return;
    if (request.operation === 'identity') {
      const annotationId = responseRow.getAttribute('data-annotation-id');
      const identity = annotationId === request.annotationId ? readBabelTurnIdentity(annotationId) : null;
      const ok = Boolean(identity && (!request.reviewActionId || request.reviewActionId === identity.reviewActionId));
      responseRow.setAttribute('data-babel-helper-editor-result', JSON.stringify({
        ...identity, id: request.id, ok
      }));
      return;
    }
    let row = responseRow;
    let binding = readBabelTranscriptBindings();
    const annotationId = row.getAttribute('data-annotation-id');
    const taskId = binding?.reviewActionId;
    let state = binding && readNativeTurn(annotationId, binding);
    let ok = Boolean(state && annotationId === request.annotationId &&
      (!request.reviewActionId || request.reviewActionId === binding.reviewActionId));
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
          focused.matches('[data-slate-editor="true"]') &&
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
        ok = (!request.focus || state.editor || startEdit) && replaceNativeTurn(annotationId, request.text, request);
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
    if (ok && acceptedSelection && (operation === 'focus' || operation === 'select' ||
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
        originalPayloads: new Map(),
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
    extendedDiffPatch.operation = {};

    const fetchPatchInstalled = installExtendedDiffFetchPatch();
    const patchedCurrentDiffResult = patchCurrentDiffResult(action, extendedDiffPatch);
    // Do not bounce the selected action through null: it races native query activation
    // and can reselect an old action after a newer mode/task request.
    if (!currentIsDiffMode) toolbarProps.onToggleDiffMode(true);
    if (currentSelectedCompareActionId !== action.id) toolbarProps.onSelectCompareAction(action.id);
    const repaintScheduled = scheduleCurrentTranscriptionDiffRepaint(action);

    return {
      ok: true,
      actionId: action.id,
      compareLevel: getNumber(action.level),
      syntheticActionInserted: Boolean(ensuredAction.syntheticExtendedDiffActionId),
      fetchPatchInstalled,
      patchedCurrentDiffResult,
      repaintScheduled,
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
    applyExtendedDiffState,
    clearExtendedDiffState,
    getTranscriptionDiffToolbarProps,
    findCurrentTranscriptionDiffQueryResult,
    patchTranscriptionDiffPayload,
    patchTranscriptionDiffResponseText
  };
  const implementation = {
    getEditorSnapshot,
    applyExtendedDiffState,
    clearExtendedDiffState,
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

    if (detail.operation === 'snapshot') {
      respond(id, {
        ok: true,
        snapshot: invokeService('getEditorSnapshot')
      });
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
    delete window.__babelHelperRecoveredEditorBridge;
  }

  ensureServiceProvider();
  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);
  window.addEventListener('babel-helper:editor-control', handleEditorControl, true);
  window.addEventListener('mousedown', handleNativeActivationCapture, true);
  window.addEventListener('focusin', handleNativeActivationCapture, true);
  window.addEventListener('keydown', handleNativeTagDropdownKeydown, true);

  window.__babelHelperRecoveredEditorBridge = {
    getEditorSnapshot: (...args) => invokeService('getEditorSnapshot', ...args),
    applyExtendedDiffState: (...args) => invokeService('applyExtendedDiffState', ...args),
    clearExtendedDiffState: (...args) => invokeService('clearExtendedDiffState', ...args),
    implementation: rawImplementation,
    dispose
  };
}

initRecoveredEditorBridge();
