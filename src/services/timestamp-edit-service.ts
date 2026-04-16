// @ts-nocheck

export function registerTimestampEditService(helper: any) {
  if (!helper || helper.__timestampEditRegistered) {
    return;
  }

  helper.__timestampEditRegistered = true;

  const BRIDGE_REQUEST_EVENT = 'babel-helper-timestamp-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-timestamp-response';
  const BRIDGE_SCRIPT_PATH = 'dist/content/timestamp-bridge.js';
  const BRIDGE_TIMEOUT_MS = 1600;

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function parseTimeValue(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = trimmed.toLowerCase();
    const timestampMatch = normalized.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
    if (timestampMatch) {
      const parts = timestampMatch[0].split(':');
      let total = 0;
      for (const part of parts) {
        const numeric = Number(part);
        if (!Number.isFinite(numeric)) {
          return null;
        }
        total = total * 60 + numeric;
      }

      return total;
    }

    let total = 0;
    let foundUnit = false;
    const unitPattern = /(-?\d+(?:\.\d+)?)\s*([hms])/g;
    for (const match of normalized.matchAll(unitPattern)) {
      const numeric = Number(match[1]);
      if (!Number.isFinite(numeric)) {
        return null;
      }

      foundUnit = true;
      const unit = match[2];
      if (unit === 'h') {
        total += numeric * 3600;
      } else if (unit === 'm') {
        total += numeric * 60;
      } else {
        total += numeric;
      }
    }

    if (foundUnit) {
      return total;
    }

    const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!numericMatch) {
      return null;
    }

    const numeric = Number(numericMatch[0]);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function getRowTimeLabels(row) {
    if (!(row instanceof HTMLTableRowElement) || row.children.length < 4) {
      return null;
    }

    return {
      startText: helper.normalizeText(row.children[2]),
      endText: helper.normalizeText(row.children[3])
    };
  }

  function getRowTimeRange(row) {
    const labels = getRowTimeLabels(row);
    if (!labels) {
      return null;
    }

    const startSeconds = parseTimeValue(labels.startText);
    const endSeconds = parseTimeValue(labels.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return {
      startSeconds,
      endSeconds
    };
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
      if (!(row instanceof HTMLTableRowElement)) {
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
      script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH);
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

  async function callTimestampBridge(operation, payload) {
    const ready = await injectTimestampBridge();
    if (!ready) {
      return null;
    }

    return new Promise((resolve) => {
      bridgeRequestId += 1;
      const id = 'timestamp-request-' + bridgeRequestId;
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

  helper.parseTimestampEditTimeValue = parseTimeValue;
  helper.getTimestampEditRowTimeLabels = getRowTimeLabels;
  helper.getTimestampEditRowTimeRange = getRowTimeRange;
  helper.findTimestampEditRowByTimeRange = findRowByTimeRange;
  helper.findTimestampEditRowByTimeLabels = findRowByTimeLabels;

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

    const attempts = clamp(Math.round(Number(settings.attempts) || 0) || 2, 1, 4);
    const retryDelayMs = clamp(Math.round(Number(settings.retryDelayMs) || 0) || 80, 0, 400);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const row =
        findRowByTimeLabels(settings.startText, settings.endText, {
          speakerKey: settings.speakerKey
        }) ||
        findRowNearBoundary(side, targetSeconds, {
          speakerKey: settings.speakerKey
        });
      const rowIdentity = row ? helper.getRowIdentity(row) : null;
      const bridgeResult = await callTimestampBridge('set-boundary-time', {
        side,
        startText: settings.startText,
        endText: settings.endText,
        speakerKey: settings.speakerKey,
        targetSeconds,
        annotationId:
          rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '',
        rowIdentity
      });

      if (bridgeResult && bridgeResult.ok) {
        return {
          ok: true,
          attempts: attempt + 1,
          backend:
            typeof bridgeResult.backend === 'string' && bridgeResult.backend
              ? bridgeResult.backend
              : 'page-react-row-time-change',
          verification: bridgeResult
        };
      }

      if (attempt < attempts - 1 && retryDelayMs > 0) {
        await helper.sleep(retryDelayMs);
      }
    }

    return {
      ok: false,
      attempts,
      backend: 'page-react-row-time-change',
      verification: null
    };
  };
}
