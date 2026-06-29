// @ts-nocheck
import {
  BABEL_EDITOR_CONTRACT_VERSION,
  BABEL_ROW_TEXTAREA_SELECTOR,
  BABEL_TABLE_COLUMN_INDEX,
  isBabelActiveRowClassList,
  normalizeBabelContractText,
  parseBabelDisplayedTime
} from '../core/babel-editor-contract';

export function initRecoveredEditorBridge() {
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const REQUEST_EVENT = 'babel-helper-recovered-editor-request';
  const RESPONSE_EVENT = 'babel-helper-recovered-editor-response';
  const existingBridge = window.__babelHelperRecoveredEditorBridge;
  let extendedDiffPatch = null;
  let extendedDiffFetchPatch = null;
  let extendedDiffMutationRecords = [];
  let extendedDiffMutationKeys = new WeakMap();
  if (existingBridge && typeof existingBridge.dispose === 'function') {
    existingBridge.dispose();
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

  function getReactInternalValue(element, prefix) {
    if (!(element instanceof Element) || typeof prefix !== 'string' || !prefix) {
      return null;
    }

    for (const name of Object.getOwnPropertyNames(element)) {
      if (typeof name === 'string' && name.indexOf(prefix) === 0) {
        return element[name];
      }
    }

    return null;
  }

  function getReactFiber(element) {
    return getReactInternalValue(element, '__reactFiber$');
  }

  function getFiberProps(fiber) {
    return fiber && typeof fiber === 'object' ? fiber.memoizedProps || fiber.pendingProps || null : null;
  }

  function getRootFiber() {
    const seed =
      document.querySelector(BABEL_ROW_TEXTAREA_SELECTOR) ||
      document.querySelector('tbody tr') ||
      document.querySelector('[role="switch"]') ||
      document.body;
    let current = getReactFiber(seed);
    let depth = 0;
    while (current && current.return && depth < 200) {
      current = current.return;
      depth += 1;
    }
    return current || null;
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

  function recordExtendedDiffMutation(target, key, value) {
    if (!target || typeof target !== 'object') {
      return false;
    }

    let keys = extendedDiffMutationKeys.get(target);
    if (!keys) {
      keys = new Set();
      extendedDiffMutationKeys.set(target, keys);
    }

    if (!keys.has(key)) {
      keys.add(key);
      extendedDiffMutationRecords.push({
        target,
        key,
        hadKey: Object.prototype.hasOwnProperty.call(target, key),
        value: target[key]
      });
    }

    target[key] = value;
    return true;
  }

  function setExtendedDiffValue(target, key, value, restorable) {
    if (!target || typeof target !== 'object') {
      return false;
    }

    if (restorable) {
      return recordExtendedDiffMutation(target, key, value);
    }

    target[key] = value;
    return true;
  }

  function restoreExtendedDiffMutations() {
    for (let index = extendedDiffMutationRecords.length - 1; index >= 0; index -= 1) {
      const record = extendedDiffMutationRecords[index];
      if (!record || !record.target || typeof record.target !== 'object') {
        continue;
      }

      if (record.hadKey) {
        record.target[record.key] = record.value;
      } else {
        delete record.target[record.key];
      }
    }

    extendedDiffMutationRecords = [];
    extendedDiffMutationKeys = new WeakMap();
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

  function patchSegmentWordRanges(segments, restorable) {
    if (!Array.isArray(segments)) {
      return;
    }

    let offset = 0;
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') {
        continue;
      }

      const length = splitFullDiffTokens(segment.text).length;
      setExtendedDiffValue(segment, 'wordRange', [offset, offset + length], restorable);
      offset += length;
    }
  }

  function patchTranscriptionDiffPayload(payload, restorable = false) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.speakerDiffs)) {
      return false;
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

        totalReferenceWords += splitFullDiffTokens(referenceText).length;
        totalHypothesisWords += splitFullDiffTokens(hypothesisText).length;
        totalSubstitutions += editCounts.substitutions;
        totalInsertions += editCounts.insertions;
        totalDeletions += editCounts.deletions;

        if (!wordDiffs.length && Array.isArray(mapping.wordDiffs) && !mapping.wordDiffs.length) {
          continue;
        }

        patched = setExtendedDiffValue(mapping, 'wordDiffs', wordDiffs, restorable) || patched;
        patched = setExtendedDiffValue(mapping, 'substitutions', editCounts.substitutions, restorable) || patched;
        patched = setExtendedDiffValue(mapping, 'insertions', editCounts.insertions, restorable) || patched;
        patched = setExtendedDiffValue(mapping, 'deletions', editCounts.deletions, restorable) || patched;
        patchSegmentWordRanges(mapping.segmentsA, restorable);
        patchSegmentWordRanges(mapping.segmentsB, restorable);
      }
    }

    if (patched) {
      setExtendedDiffValue(payload, 'totalReferenceWords', totalReferenceWords, restorable);
      setExtendedDiffValue(payload, 'totalHypothesisWords', totalHypothesisWords, restorable);
      setExtendedDiffValue(payload, 'totalSubstitutions', totalSubstitutions, restorable);
      setExtendedDiffValue(payload, 'totalInsertions', totalInsertions, restorable);
      setExtendedDiffValue(payload, 'totalDeletions', totalDeletions, restorable);
      setExtendedDiffValue(
        payload,
        'overallWordErrorRate',
        (totalSubstitutions + totalInsertions + totalDeletions) / Math.max(1, totalReferenceWords),
        restorable
      );
    }

    return patched;
  }

  function patchTranscriptionDiffJson(root, restorable = false) {
    let patched = false;
    const stack = [root];
    const seen = new Set();

    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) {
        continue;
      }
      seen.add(value);

      if (Array.isArray(value.speakerDiffs)) {
        patched = patchTranscriptionDiffPayload(value, restorable) || patched;
      }

      if (Array.isArray(value)) {
        for (const child of value) stack.push(child);
      } else {
        for (const child of Object.values(value)) stack.push(child);
      }
    }

    return patched;
  }

  function patchTranscriptionDiffResponseText(text) {
    try {
      const json = JSON.parse(text);
      return patchTranscriptionDiffJson(json, false) ? JSON.stringify(json) : text;
    } catch (_error) {
      const lines = text.split(/\r?\n/);
      let patched = false;
      const output = lines.map((line) => {
        if (!line.trim()) {
          return line;
        }

        try {
          const json = JSON.parse(line);
          if (patchTranscriptionDiffJson(json, false)) {
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

  async function patchTranscriptionDiffFetchResponse(response) {
    if (!(response instanceof Response) || !response.ok) {
      return response;
    }

    try {
      const text = await response.clone().text();
      const patchedText = patchTranscriptionDiffResponseText(text);
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
      const response = await originalFetch.apply(this, args);
      return isTranscriptionDiffFetch(args[0]) ? patchTranscriptionDiffFetchResponse(response) : response;
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

  function patchCurrentDiffResult(toolbarProps) {
    return patchTranscriptionDiffPayload(toolbarProps?.diffResult, true);
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

  function getTranscriptRows() {
    return Array.from(document.querySelectorAll('tbody tr')).filter(
      (row) => row instanceof HTMLTableRowElement && row.querySelector(BABEL_ROW_TEXTAREA_SELECTOR)
    );
  }

  function getFiberPropsForRow(row) {
    let fiber = getReactFiber(row);
    if (!fiber) {
      fiber = getReactFiber(row.querySelector(BABEL_ROW_TEXTAREA_SELECTOR));
    }

    let current = fiber;
    let depth = 0;
    while (current && typeof current === 'object' && depth < 24) {
      const props = current.memoizedProps || current.pendingProps;
      const annotation =
        props && typeof props === 'object' && props.annotation && typeof props.annotation === 'object'
          ? props.annotation
          : null;
      if (annotation && typeof annotation.id === 'string' && annotation.id) {
        return props;
      }

      current = current.return;
      depth += 1;
    }

    return null;
  }

  function getWorkbenchProps() {
    const seed = document.querySelector(BABEL_ROW_TEXTAREA_SELECTOR) || document.querySelector('tbody tr');
    let current = getReactFiber(seed);
    let depth = 0;
    while (current && typeof current === 'object' && depth < 80) {
      const props = current.memoizedProps || current.pendingProps;
      if (
        props &&
        typeof props === 'object' &&
        Array.isArray(props.annotations) &&
        (Array.isArray(props.tracks) || typeof props.reviewActionId === 'string')
      ) {
        return props;
      }

      current = current.return;
      depth += 1;
    }
    return null;
  }

  function getRowCellText(row, key) {
    const index = BABEL_TABLE_COLUMN_INDEX[key];
    const cell = row.children[index];
    return cell instanceof HTMLElement ? normalizeBabelContractText(cell.innerText || cell.textContent || '') : '';
  }

  function getRowSnapshot(row, index) {
    const props = getFiberPropsForRow(row);
    const annotation =
      props && typeof props === 'object' && props.annotation && typeof props.annotation === 'object'
        ? props.annotation
        : null;
    const textarea = row.querySelector(BABEL_ROW_TEXTAREA_SELECTOR);
    const speakerLabel =
      typeof annotation?.trackLabel === 'string' && annotation.trackLabel
        ? annotation.trackLabel
        : getRowCellText(row, 'speaker');
    const processedRecordingId =
      annotation?.processedRecordingId != null ? String(annotation.processedRecordingId) : null;
    const startText = getRowCellText(row, 'start');
    const endText = getRowCellText(row, 'end');
    const isActive =
      Boolean(props && typeof props === 'object' && props.isActive === true) ||
      isBabelActiveRowClassList(row.classList);

    return {
      index,
      annotationId: typeof annotation?.id === 'string' ? annotation.id : '',
      processedRecordingId,
      speakerKey: processedRecordingId || speakerLabel,
      speakerLabel,
      startText,
      endText,
      startSeconds:
        Number.isFinite(Number(annotation?.startTimeInSeconds))
          ? Number(annotation.startTimeInSeconds)
          : parseBabelDisplayedTime(startText),
      endSeconds:
        Number.isFinite(Number(annotation?.endTimeInSeconds))
          ? Number(annotation.endTimeInSeconds)
          : parseBabelDisplayedTime(endText),
      text:
        typeof annotation?.content === 'string'
          ? annotation.content
          : textarea instanceof HTMLTextAreaElement
            ? textarea.value || ''
            : '',
      isActive
    };
  }

  function collectTracks(rows) {
    const props = getWorkbenchProps();
    if (props && Array.isArray(props.tracks)) {
      return props.tracks
        .map((track) => ({
          id: typeof track?.id === 'string' ? track.id : '',
          label: typeof track?.label === 'string' ? track.label : '',
          collapsed: typeof track?.collapsed === 'boolean' ? track.collapsed : null
        }))
        .filter((track) => track.id || track.label);
    }

    const seen = new Set();
    const tracks = [];
    for (const row of rows) {
      const id = row.processedRecordingId || row.speakerKey || row.speakerLabel;
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      tracks.push({
        id,
        label: row.speakerLabel || id,
        collapsed: null
      });
    }
    return tracks;
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

  function getEditorSnapshot() {
    const rows = getTranscriptRows().map((row, index) => getRowSnapshot(row, index));
    const activeRow = rows.find((row) => row.isActive) || null;
    return {
      contractVersion: BABEL_EDITOR_CONTRACT_VERSION,
      capturedAt: Date.now(),
      routeKey: `${window.location.pathname || ''}${window.location.search || ''}`,
      activeRowId: activeRow && activeRow.annotationId ? activeRow.annotationId : null,
      rows,
      tracks: collectTracks(rows),
      playback: getPlaybackSnapshot()
    };
  }

  function applyExtendedDiffState(payload) {
    const toolbarProps = getTranscriptionDiffToolbarProps();
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

    if (!extendedDiffPatch || extendedDiffPatch.routeKey !== routeKey) {
      extendedDiffPatch = {
        routeKey,
        previousIsDiffMode: currentIsDiffMode,
        previousSelectedCompareActionId: currentSelectedCompareActionId,
        syntheticExtendedDiffActionId: ensuredAction.syntheticExtendedDiffActionId,
        lastAppliedActionId: action.id
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
    }

    const fetchPatchInstalled = installExtendedDiffFetchPatch();
    const patchedCurrentDiffResult = patchCurrentDiffResult(toolbarProps);
    const shouldRefreshSelection = currentIsDiffMode && currentSelectedCompareActionId === action.id;

    toolbarProps.onToggleDiffMode(true);
    if (shouldRefreshSelection) {
      toolbarProps.onSelectCompareAction(null);
      window.setTimeout(() => {
        const latestToolbarProps = getTranscriptionDiffToolbarProps() || toolbarProps;
        latestToolbarProps.onSelectCompareAction(action.id);
      }, 0);
    } else {
      toolbarProps.onSelectCompareAction(action.id);
    }

    return {
      ok: true,
      actionId: action.id,
      compareLevel: getNumber(action.level),
      syntheticActionInserted: Boolean(ensuredAction.syntheticExtendedDiffActionId),
      fetchPatchInstalled,
      patchedCurrentDiffResult,
      refreshedSelection: shouldRefreshSelection,
      previousIsDiffMode: extendedDiffPatch.previousIsDiffMode,
      previousSelectedCompareActionId: extendedDiffPatch.previousSelectedCompareActionId
    };
  }

  function clearExtendedDiffState() {
    restoreExtendedDiffMutations();
    uninstallExtendedDiffFetchPatch();

    if (!extendedDiffPatch) {
      return {
        ok: true,
        restored: false
      };
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
      toolbarProps.onToggleDiffMode(true);
      toolbarProps.onSelectCompareAction(extendedDiffPatch.previousSelectedCompareActionId);
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

  function handleRequest(event) {
    const detail = event.detail || {};
    const id = detail.id;
    if (!id) {
      return;
    }

    if (detail.operation === 'snapshot') {
      respond(id, {
        ok: true,
        snapshot: getEditorSnapshot()
      });
      return;
    }

    if (detail.operation === 'apply-extended-diff-state') {
      respond(id, applyExtendedDiffState(detail.payload || {}));
      return;
    }

    if (detail.operation === 'clear-extended-diff-state') {
      respond(id, clearExtendedDiffState());
      return;
    }

    respond(id, {
      ok: false,
      reason: 'unknown-operation'
    });
  }

  function dispose() {
    restoreExtendedDiffMutations();
    uninstallExtendedDiffFetchPatch();
    window.removeEventListener(REQUEST_EVENT, handleRequest, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    delete window.__babelHelperRecoveredEditorBridge;
  }

  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  window.__babelHelperRecoveredEditorBridge = {
    getEditorSnapshot,
    applyExtendedDiffState,
    clearExtendedDiffState,
    dispose
  };
}

initRecoveredEditorBridge();
