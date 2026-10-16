// @ts-nocheck
import { parseTimeValue } from '../hooks/parsing';
import { captureL0TaskGuard } from '../services/l0-timing-identity';

export function registerTimestampEditService(helper: any) {
  if (!helper || helper.__timestampEditRegistered) {
    return;
  }

  helper.__timestampEditRegistered = true;

  const BRIDGE_REQUEST_EVENT = 'babel-helper-timestamp-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-timestamp-response';
  const BRIDGE_SCRIPT_PATH = 'dist/content/timestamp-bridge.js';
  // Let MAIN return its 1600ms operation deadline and exact command receipt.
  const BRIDGE_TIMEOUT_MS = 2000;

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;


  function getRowTimeLabels(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }
    const identity = helper.getRowIdentity(row);
    return identity?.startText && identity?.endText
      ? { startText: identity.startText, endText: identity.endText }
      : null;
  }

  function getRowTimeRange(row) {
    return helper.getRowTimeRange(row);
  }

  function findRowByTimeRange(startSeconds, endSeconds, options) {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const rows = helper.getTranscriptRows();
    let bestRow = null;
    let bestScore = -Infinity;

    for (const row of rows) {
      if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
        continue;
      }

      const range = getRowTimeRange(row);
      if (!range) {
        continue;
      }

      const overlap = Math.max(
        0,
        Math.min(endSeconds, range.endSeconds) - Math.max(startSeconds, range.startSeconds)
      );
      const distance =
        Math.abs(range.startSeconds - startSeconds) + Math.abs(range.endSeconds - endSeconds);
      const score = overlap > 0 ? overlap * 100 - distance : -distance;

      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }

    return bestRow;
  }

  function findRowByTimeLabels(startText, endText, options) {
    if (!startText || !endText) {
      return null;
    }

    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const rows = helper.getTranscriptRows();
    const exactMatch =
      rows.find((row) => {
        if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
          return false;
        }

        const labels = getRowTimeLabels(row);
        return labels && labels.startText === startText && labels.endText === endText;
      }) || null;
    if (exactMatch) {
      return exactMatch;
    }

    const targetStart = parseTimeValue(startText);
    const targetEnd = parseTimeValue(endText);
    if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || targetEnd <= targetStart) {
      return null;
    }

    return findRowByTimeRange(targetStart, targetEnd, {
      speakerKey
    });
  }

  function findRowNearBoundary(side, targetSeconds, options) {
    if (!Number.isFinite(targetSeconds)) {
      return null;
    }

    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const boundarySide = side === 'left' ? 'left' : 'right';
    const rows = helper.getTranscriptRows();
    let bestRow = null;
    let bestScore = Infinity;

    for (const row of rows) {
      if (!(row instanceof HTMLElement)) {
        continue;
      }

      if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
        continue;
      }

      const range = getRowTimeRange(row);
      if (!range) {
        continue;
      }

      const boundarySeconds =
        boundarySide === 'left' ? range.startSeconds : range.endSeconds;
      let score = Math.abs(boundarySeconds - targetSeconds);

      if (range.startSeconds <= targetSeconds && range.endSeconds >= targetSeconds) {
        score -= 2;
      }

      if (boundarySide === 'right') {
        if (range.startSeconds >= targetSeconds + 0.01) {
          score += 1000;
        } else if (range.endSeconds < targetSeconds - 5) {
          score += 25;
        }
      } else if (range.endSeconds <= targetSeconds - 0.01) {
        score += 1000;
      } else if (range.startSeconds > targetSeconds + 5) {
        score += 25;
      }

      if (score < bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }

    return bestRow;
  }

  function injectTimestampBridge() {
    if (window.__babelHelperTimestampBridge) {
      bridgeInjected = true;
      return Promise.resolve(true);
    }

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
      try {
        script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH);
      } catch (_error) {
        script.remove();
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }
      script.async = false;
      script.onload = () => {
        script.remove();
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

  async function callTimestampBridge(operation, payload, isCurrentTask) {
    if (isCurrentTask && !isCurrentTask()) return { ok: false, reason: 'stale-task', commandInvoked: false };
    const ready = await injectTimestampBridge();
    if (isCurrentTask && !isCurrentTask()) return { ok: false, reason: 'stale-task', commandInvoked: false };
    if (!ready) return { ok: false, reason: 'bridge-unavailable', commandInvoked: false };
    const { promise, resolve } = Promise.withResolvers();
    const id = 'timestamp-request-' + ++bridgeRequestId;
    let settled = false;
    let tornDown = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
      window.removeEventListener('babel-helper-bridge-teardown', handleTeardown, true);
      window.clearTimeout(timeoutId);
      resolve(result && typeof result.ok === 'boolean' ? result : { ok: false, reason: 'invalid-bridge-response' });
    };
    const handleResponse = event => {
      if (event.detail?.id === id) finish(event.detail.result);
    };
    // MAIN resolves cancelled verification with its exact native receipt.
    // Do not discard that response by settling early in the teardown event.
    const handleTeardown = () => { tornDown = true; };
    const timeoutId = window.setTimeout(() => finish({
      ok: false, reason: tornDown ? 'bridge-disposed' : 'bridge-response-timeout'
    }), BRIDGE_TIMEOUT_MS);
    window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
    window.addEventListener('babel-helper-bridge-teardown', handleTeardown, true);
    window.dispatchEvent(new CustomEvent(BRIDGE_REQUEST_EVENT, {
      detail: { id, operation, payload: payload || {} }
    }));
    return promise;
  }

  async function invokeTimestampMutation(operation, backend, buildPayload) {
    const isCurrentTask = captureL0TaskGuard();
    if (!isCurrentTask()) return { ok: false, reason: 'stale-task', commandInvoked: false, backend, verification: null };
    const result = await callTimestampBridge(operation, buildPayload(), isCurrentTask);
    return {
      ...result,
      ...(!isCurrentTask() ? { ok: false, reason: 'stale-task' } : {}),
      backend: typeof result.backend === 'string' && result.backend ? result.backend : backend,
      verification: result
    };
  }

  function resolveRowMutationPayload(settings) {
    const row = settings.selectionTarget ? null :
      (typeof helper.findRowByIdentity === 'function' && settings.rowIdentity
        ? helper.findRowByIdentity(settings.rowIdentity)
        : null) ||
      findRowByTimeLabels(settings.startText, settings.endText, {
        speakerKey: settings.speakerKey
      }) ||
      findRowByTimeRange(Number(settings.startSeconds), Number(settings.endSeconds), {
        speakerKey: settings.speakerKey
      });
    const rowIdentity = row ? helper.getRowIdentity(row) : settings.rowIdentity || null;
    return {
      expectedReviewActionId: settings.expectedReviewActionId,
      expectedHistoryRevision: settings.expectedHistoryRevision,
      expectedHistoryToken: settings.expectedHistoryToken,
      processedRecordingId: settings.processedRecordingId,
      selectionTarget: settings.selectionTarget,
      startText: settings.startText,
      endText: settings.endText,
      startSeconds: settings.startSeconds,
      endSeconds: settings.endSeconds,
      speakerKey: settings.speakerKey,
      annotationId:
        (typeof settings.annotationId === 'string' && settings.annotationId) ||
        (rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : ''),
      rowIdentity
    };
  }

  helper.parseTimestampEditTimeValue = parseTimeValue;
  helper.getTimestampEditRowTimeLabels = getRowTimeLabels;
  helper.getTimestampEditRowTimeRange = getRowTimeRange;
  helper.findTimestampEditRowByTimeRange = findRowByTimeRange;
  helper.findTimestampEditRowByTimeLabels = findRowByTimeLabels;


  helper.snapshotTranscriptWithNativeBridge =
    async function snapshotTranscriptWithNativeBridge() {
      return callTimestampBridge('flush-transcript', {});
    };
  helper.undoTranscriptWithNativeBridge = async function undoTranscriptWithNativeBridge(options) {
    return callTimestampBridge('undo-transcript', options, captureL0TaskGuard());
  };
  helper.setSegmentBoundaryTime = async function setSegmentBoundaryTime(options) {
    const settings = options || {};
    const side = settings.side === 'left' ? 'left' : 'right';
    const targetSeconds = Number(settings.targetSeconds);
    if (!Number.isFinite(targetSeconds)) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'invalid-target'
      };
    }

    return invokeTimestampMutation('set-boundary-time', 'page-react-row-time-change', () => {
      if (settings.selectionTarget) {
        return { ...resolveRowMutationPayload(settings), side, targetSeconds };
      }
      const row =
        (typeof helper.findRowByIdentity === 'function' && settings.rowIdentity
          ? helper.findRowByIdentity(settings.rowIdentity)
          : null) ||
        findRowByTimeLabels(settings.startText, settings.endText, {
          speakerKey: settings.speakerKey
        }) ||
        findRowNearBoundary(side, targetSeconds, {
          speakerKey: settings.speakerKey
        });
      const rowIdentity = row ? helper.getRowIdentity(row) : settings.rowIdentity || null;
      return {
        expectedReviewActionId: settings.expectedReviewActionId,
        expectedHistoryRevision: settings.expectedHistoryRevision,
        expectedHistoryToken: settings.expectedHistoryToken,
        side,
        startText: settings.startText,
        endText: settings.endText,
        startSeconds: settings.startSeconds,
        endSeconds: settings.endSeconds,
        speakerKey: settings.speakerKey,
        targetSeconds,
        annotationId:
          (typeof settings.annotationId === 'string' && settings.annotationId) ||
          (rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : ''),
        rowIdentity
      };
    });
  };

  helper.splitSegmentAtTime = async function splitSegmentAtTime(options) {
    const settings = options || {};
    const splitSeconds = Number(settings.splitSeconds);
    if (!Number.isFinite(splitSeconds)) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'invalid-split'
      };
    }

    return invokeTimestampMutation('split-segment-at-time', 'page-react-split-annotation', () => {
      const payload = resolveRowMutationPayload(settings);
      payload.splitSeconds = splitSeconds;
      if (settings.sourceText !== undefined) payload.sourceText = settings.sourceText;
      if (settings.texts !== undefined) {
        payload.texts = settings.texts;
      }
      return payload;
    });
  };

  helper.mergeSegmentWithNativeAction = async function mergeSegmentWithNativeAction(options) {
    const settings = options || {};
    const direction = settings.direction === 'below' ? 'below' : 'above';
    return invokeTimestampMutation('merge-segment', 'page-react-row-action', () => {
      const payload = resolveRowMutationPayload(settings);
      payload.direction = direction;
      return payload;
    });
  };

  helper.createSegmentWithNativeAction = async function createSegmentWithNativeAction(options) {
    const settings = options || {};
    const startSeconds = Number(settings.startSeconds);
    const endSeconds = Number(settings.endSeconds);
    const processedRecordingId =
      typeof settings.processedRecordingId === 'string' ? settings.processedRecordingId : '';
    if (!processedRecordingId || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return {
        ok: false,
        backend: 'page-react-create-annotation',
        reason: 'invalid-segment'
      };
    }

    return invokeTimestampMutation('create-segment', 'page-react-create-annotation', () => ({
      expectedReviewActionId: settings.expectedReviewActionId,
      expectedHistoryRevision: settings.expectedHistoryRevision,
      expectedHistoryToken: settings.expectedHistoryToken,
      annotationId:
        typeof settings.annotationId === 'string' && settings.annotationId
          ? settings.annotationId
          : '',
      processedRecordingId: settings.processedRecordingId,
      speakerKey: settings.speakerKey,
      text: typeof settings.text === 'string' ? settings.text : '',
      startSeconds,
      endSeconds
    }));
  };

  helper.deleteSegmentWithNativeAction = async function deleteSegmentWithNativeAction(options) {
    const settings = options || {};
    return invokeTimestampMutation('delete-segment', 'page-react-row-action', () =>
      resolveRowMutationPayload(settings)
    );
  };
}
