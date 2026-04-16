// @ts-nocheck
import {
  clampAutoTrimBoundaryTarget,
  collectVisibleAutoTrimEntries,
  summarizeAutoTrimResults
} from './auto-trim-utils';

export function registerAutoTrimService(helper: any) {
  if (!helper || helper.__autoTrimRegistered) {
    return;
  }

  helper.__autoTrimRegistered = true;

  const BRIDGE_REQUEST_EVENT = 'babel-helper-magnifier-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-magnifier-response';
  const BRIDGE_SCRIPT_PATH = 'dist/content/magnifier-bridge.js';
  const BRIDGE_TIMEOUT_MS = 900;
  const PADDING_MS = 20;
  const MAX_OUTWARD_MS = 50;
  const MIN_DELTA_MS = 5;
  const MIN_GAP_SECONDS = 0.01;
  const LEFT_WINDOW_BEFORE_MS = 250;
  const LEFT_WINDOW_AFTER_MS = 350;
  const RIGHT_WINDOW_BEFORE_MS = 350;
  const RIGHT_WINDOW_AFTER_MS = 250;

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;

  helper.state.autoTrimInFlight = false;
  helper.state.autoTrimLastSummary = null;
  helper.config.hotkeysHelpRows.unshift(
    ['Alt + T', 'Auto-trim current row'],
    ['Alt + Shift + T', 'Auto-trim visible rows']
  );

  function bridgeSupportsAutoTrim() {
    return bridgeInjected;
  }

  function injectBridge() {
    if (bridgeInjected) {
      return Promise.resolve(true);
    }

    if (bridgeLoadPromise) {
      return bridgeLoadPromise;
    }

    bridgeLoadPromise = new Promise((resolve) => {
      const parent = document.documentElement || document.head || document.body;
      if (
        !parent ||
        typeof chrome === 'undefined' ||
        !chrome.runtime ||
        typeof chrome.runtime.getURL !== 'function'
      ) {
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH);
      script.async = false;
      script.onload = () => {
        script.remove();
        // Page-world bridges are not directly introspectable from the isolated
        // content-script world. A successful script load is enough; subsequent
        // bridge requests verify support by response/timeout.
        bridgeInjected = true;
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        bridgeLoadPromise = null;
        resolve(false);
      };

      parent.appendChild(script);
    });

    return bridgeLoadPromise;
  }

  async function callBridge(operation, payload) {
    const ready = await injectBridge();
    if (!ready) {
      return null;
    }

    return new Promise((resolve) => {
      bridgeRequestId += 1;
      const id = 'auto-trim-request-' + bridgeRequestId;
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
        window.clearTimeout(timeoutId);
        resolve(result || null);
      };

      const handleResponse = (event) => {
        const detail = event.detail || {};
        if (detail.id !== id) {
          return;
        }

        finish(detail.result || null);
      };

      const timeoutId = window.setTimeout(() => finish(null), BRIDGE_TIMEOUT_MS);
      window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
      window.dispatchEvent(
        new CustomEvent(BRIDGE_REQUEST_EVENT, {
          detail: {
            id,
            operation,
            payload: payload || {}
          }
        })
      );
    });
  }

  function getTranscriptRowsSnapshot() {
    return helper.getTranscriptRows().map((row) => ({
      row,
      identity: helper.getRowIdentity(row),
      visible: helper.isVisible(row)
    }));
  }

  function findSnapshotIndex(snapshot, identity) {
    if (!Array.isArray(snapshot) || !identity) {
      return -1;
    }

    return snapshot.findIndex((entry) => entry && helper.rowMatchesIdentity(entry.row, identity));
  }

  function resolveSnapshotRow(snapshot, index, direction) {
    if (!Array.isArray(snapshot)) {
      return null;
    }

    const startIndex = Number(index);
    const step = direction < 0 ? -1 : 1;
    for (
      let pointer = startIndex + step;
      pointer >= 0 && pointer < snapshot.length;
      pointer += step
    ) {
      const candidate = snapshot[pointer];
      if (!candidate || !candidate.identity) {
        continue;
      }

      const row = helper.findRowByIdentity(candidate.identity);
      if (row instanceof HTMLTableRowElement) {
        return row;
      }
    }

    return null;
  }

  function getRowTimeLabels(row) {
    return typeof helper.getTimestampEditRowTimeLabels === 'function'
      ? helper.getTimestampEditRowTimeLabels(row)
      : null;
  }

  function getRowTimeRange(row) {
    return typeof helper.getTimestampEditRowTimeRange === 'function'
      ? helper.getTimestampEditRowTimeRange(row)
      : null;
  }

  function buildVisibleAutoTrimEntries(snapshot) {
    return collectVisibleAutoTrimEntries(
      snapshot.map((entry) => entry.row),
      (row) => helper.isVisible(row),
      (row) => helper.getRowIdentity(row)
    )
      .map((entry, visibleOrder) => ({
        ...entry,
        index: findSnapshotIndex(snapshot, entry.identity),
        visibleOrder
      }))
      .filter((entry) => entry.index >= 0);
  }

  function buildAutoTrimSummary(results) {
    return {
      ...summarizeAutoTrimResults(results),
      paddingMs: PADDING_MS,
      maxOutwardMs: MAX_OUTWARD_MS
    };
  }

  async function runAutoTrimEntries(entries, snapshot, options) {
    const settings = options || {};
    const bridgeRows = await requestVisibleRowBoundarySuggestions();
    const results = [];

    for (const entry of entries) {
      const visibleOrder = Number(entry && entry.visibleOrder);
      const result = await autoTrimRowBoundaries(entry, {
        snapshot,
        bridgeRows,
        bridgeSuggestion:
          Array.isArray(bridgeRows) && Number.isInteger(visibleOrder) && visibleOrder >= 0
            ? bridgeRows[visibleOrder] || null
            : null
      });
      results.push(result);
    }

    const summary = buildAutoTrimSummary(results);
    helper.state.autoTrimLastSummary = summary;
    console.info(
      settings.logLabel || '[Babel Helper] Auto-trim rows',
      summary
    );
    return summary;
  }

  async function requestVisibleRowBoundarySuggestions() {
    const response = await callBridge('visible-row-boundary-trim-suggestions', {
      leftWindowMsBefore: LEFT_WINDOW_BEFORE_MS,
      leftWindowMsAfter: LEFT_WINDOW_AFTER_MS,
      rightWindowMsBefore: RIGHT_WINDOW_BEFORE_MS,
      rightWindowMsAfter: RIGHT_WINDOW_AFTER_MS,
      paddingMs: PADDING_MS,
      maxOutwardMs: MAX_OUTWARD_MS
    });
    if (!response || response.ok === false || !Array.isArray(response.rows)) {
      return [];
    }

    return response.rows;
  }

  function findBridgeSuggestionForEntry(entry, bridgeRows) {
    if (!entry || !entry.identity || !Array.isArray(bridgeRows)) {
      return null;
    }

    const entryIdentity = entry.identity;
    for (const bridgeRow of bridgeRows) {
      const identity = bridgeRow && bridgeRow.identity ? bridgeRow.identity : null;
      if (!identity) {
        continue;
      }

      if (
        entryIdentity.annotationId &&
        identity.annotationId &&
        entryIdentity.annotationId === identity.annotationId
      ) {
        return bridgeRow;
      }

      if (
        entryIdentity.speakerKey &&
        identity.speakerKey &&
        entryIdentity.speakerKey === identity.speakerKey &&
        entryIdentity.startText &&
        entryIdentity.endText &&
        entryIdentity.startText === identity.startText &&
        entryIdentity.endText === identity.endText
      ) {
        return bridgeRow;
      }
    }

    return null;
  }

  async function applyBoundaryTime(row, side, targetSeconds) {
    const labels = getRowTimeLabels(row);
    const identity = helper.getRowIdentity(row);
    if (!labels || !identity) {
      return { ok: false, reason: 'missing-row-state' };
    }

    return helper.setSegmentBoundaryTime({
      side,
      startText: labels.startText,
      endText: labels.endText,
      speakerKey: identity.speakerKey,
      targetSeconds,
      attempts: 2,
      retryDelayMs: 80
    });
  }

  async function autoTrimRowBoundaries(entry, context) {
    const baseIdentity = entry && entry.identity ? entry.identity : null;
    const currentRow = baseIdentity ? helper.findRowByIdentity(baseIdentity) : null;
    if (!(currentRow instanceof HTMLTableRowElement)) {
      return {
        status: 'skipped-invalid',
        boundariesTrimmed: 0,
        reason: 'row-missing'
      };
    }

    const currentRange = getRowTimeRange(currentRow);
    if (!currentRange) {
      return {
        status: 'skipped-invalid',
        boundariesTrimmed: 0,
        reason: 'range-missing'
      };
    }

    const previousRow = resolveSnapshotRow(context.snapshot, entry.index, -1);
    const nextRow = resolveSnapshotRow(context.snapshot, entry.index, 1);
    const previousRange = getRowTimeRange(previousRow);
    const nextRange = getRowTimeRange(nextRow);
    const bridgeSuggestion =
      context && context.bridgeSuggestion
        ? context.bridgeSuggestion
        : findBridgeSuggestionForEntry(entry, context.bridgeRows);
    const leftSuggestion = bridgeSuggestion ? bridgeSuggestion.leftSuggestion : null;
    const rightSuggestion = bridgeSuggestion ? bridgeSuggestion.rightSuggestion : null;
    const suggestions = [
      { side: 'left', suggestion: leftSuggestion },
      { side: 'right', suggestion: rightSuggestion }
    ];

    let boundariesTrimmed = 0;
    let hadLowConfidence = false;
    let hadNoAudio = false;
    let hadWriteFailure = false;
    let hadNoop = false;

    for (const item of suggestions) {
      const suggestion = item.suggestion;
      if (!suggestion || suggestion.ok === false) {
        hadNoAudio = true;
        continue;
      }

      if (suggestion.confidence !== 'high' || !Number.isFinite(Number(suggestion.suggestedSeconds))) {
        hadLowConfidence = true;
        continue;
      }

      const liveRow = helper.findRowByIdentity(baseIdentity);
      const liveRange = getRowTimeRange(liveRow);
      if (!(liveRow instanceof HTMLTableRowElement) || !liveRange) {
        hadWriteFailure = true;
        continue;
      }

      const clampResult = clampAutoTrimBoundaryTarget({
        side: item.side,
        currentStartSeconds: liveRange.startSeconds,
        currentEndSeconds: liveRange.endSeconds,
        suggestedSeconds: Number(suggestion.suggestedSeconds),
        previousEndSeconds: previousRange ? previousRange.endSeconds : null,
        nextStartSeconds: nextRange ? nextRange.startSeconds : null,
        minGapSeconds: MIN_GAP_SECONDS,
        minDeltaMs: MIN_DELTA_MS
      });
      if (!clampResult.ok || !Number.isFinite(Number(clampResult.targetSeconds))) {
        hadNoop = clampResult.reason === 'below-min-delta' || clampResult.reason === 'clamped-to-neighbor';
        if (!hadNoop) {
          hadLowConfidence = true;
        }
        continue;
      }

      const writeResult = await applyBoundaryTime(
        liveRow,
        item.side,
        Number(clampResult.targetSeconds)
      );
      if (!writeResult || !writeResult.ok) {
        hadWriteFailure = true;
        continue;
      }

      boundariesTrimmed += 1;
      await helper.sleep(48);
    }

    if (boundariesTrimmed > 0) {
      return {
        status: 'trimmed',
        boundariesTrimmed,
        reason: hadWriteFailure ? 'partial-trim-with-write-failure' : 'trimmed'
      };
    }

    if (hadWriteFailure) {
      return {
        status: 'failed-write',
        boundariesTrimmed: 0,
        reason: 'write-failed'
      };
    }

    if (hadNoAudio) {
      return {
        status: 'skipped-no-audio',
        boundariesTrimmed: 0,
        reason: 'audio-unavailable'
      };
    }

    if (hadNoop) {
      return {
        status: 'skipped-noop',
        boundariesTrimmed: 0,
        reason: 'delta-too-small'
      };
    }

    return {
      status: 'skipped-low-confidence',
      boundariesTrimmed: 0,
      reason: hadLowConfidence ? 'low-confidence' : 'no-suggestion'
    };
  }

  helper.autoTrimVisibleRows = async function autoTrimVisibleRows() {
    if (helper.state.autoTrimInFlight) {
      return helper.state.autoTrimLastSummary || {
        rowsProcessed: 0,
        trimmed: 0,
        boundariesTrimmed: 0,
        skippedLowConfidence: 0,
        skippedNoAudio: 0,
        failedWrite: 0,
        skippedNoop: 0,
        skippedInvalid: 0,
        inFlight: true
      };
    }

    helper.state.autoTrimInFlight = true;

    try {
      const snapshot = getTranscriptRowsSnapshot();
      const visibleEntries = buildVisibleAutoTrimEntries(snapshot);
      return await runAutoTrimEntries(visibleEntries, snapshot, {
        logLabel: '[Babel Helper] Auto-trim visible rows'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Babel Helper] Auto-trim failed', error);
      const summary = {
        rowsProcessed: 0,
        trimmed: 0,
        boundariesTrimmed: 0,
        skippedLowConfidence: 0,
        skippedNoAudio: 0,
        failedWrite: 0,
        skippedNoop: 0,
        skippedInvalid: 0,
        error: message
      };
      helper.state.autoTrimLastSummary = summary;
      return summary;
    } finally {
      helper.state.autoTrimInFlight = false;
    }
  };

  helper.autoTrimCurrentRow = async function autoTrimCurrentRow() {
    if (helper.state.autoTrimInFlight) {
      return helper.state.autoTrimLastSummary || {
        rowsProcessed: 0,
        trimmed: 0,
        boundariesTrimmed: 0,
        skippedLowConfidence: 0,
        skippedNoAudio: 0,
        failedWrite: 0,
        skippedNoop: 0,
        skippedInvalid: 0,
        inFlight: true
      };
    }

    helper.state.autoTrimInFlight = true;

    try {
      const snapshot = getTranscriptRowsSnapshot();
      const visibleEntries = buildVisibleAutoTrimEntries(snapshot);
      const currentRow =
        typeof helper.getCurrentRow === 'function'
          ? helper.getCurrentRow({ allowFallback: false })
          : null;
      const currentEntry =
        currentRow instanceof HTMLTableRowElement
          ? visibleEntries.find((entry) => helper.rowMatchesIdentity(currentRow, entry.identity)) || null
          : null;

      if (!currentEntry) {
        const summary = {
          rowsProcessed: 0,
          trimmed: 0,
          boundariesTrimmed: 0,
          skippedLowConfidence: 0,
          skippedNoAudio: 0,
          failedWrite: 0,
          skippedNoop: 0,
          skippedInvalid: 1,
          paddingMs: PADDING_MS,
          maxOutwardMs: MAX_OUTWARD_MS,
          reason: 'no-current-visible-row'
        };
        helper.state.autoTrimLastSummary = summary;
        console.info('[Babel Helper] Auto-trim current row', summary);
        return summary;
      }

      return await runAutoTrimEntries([currentEntry], snapshot, {
        logLabel: '[Babel Helper] Auto-trim current row'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Babel Helper] Auto-trim failed', error);
      const summary = {
        rowsProcessed: 0,
        trimmed: 0,
        boundariesTrimmed: 0,
        skippedLowConfidence: 0,
        skippedNoAudio: 0,
        failedWrite: 0,
        skippedNoop: 0,
        skippedInvalid: 0,
        paddingMs: PADDING_MS,
        maxOutwardMs: MAX_OUTWARD_MS,
        error: message
      };
      helper.state.autoTrimLastSummary = summary;
      return summary;
    } finally {
      helper.state.autoTrimInFlight = false;
    }
  };
}
