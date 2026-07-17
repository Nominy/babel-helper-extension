// @ts-nocheck
import {
  BABEL_EDITOR_CONTRACT_VERSION,
  BABEL_TABLE_COLUMN_INDEX,
  parseBabelDisplayedTime,
  normalizeBabelContractText
} from '../core/babel-editor-contract';

export function registerRecoveredEditorSnapshotService(helper: any) {
  if (!helper || helper.__recoveredEditorSnapshotRegistered) {
    return;
  }

  helper.__recoveredEditorSnapshotRegistered = true;

  const BRIDGE_REQUEST_EVENT = 'babel-helper-recovered-editor-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-recovered-editor-response';
  const BRIDGE_SCRIPT_PATH = 'dist/content/recovered-editor-bridge.js';
  const BRIDGE_TIMEOUT_MS = 700;
  const SNAPSHOT_MAX_AGE_MS = 750;

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;
  let snapshotInFlight = null;

  function injectRecoveredEditorBridge() {
    if (window.__babelHelperRecoveredEditorBridge) {
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
      script.setAttribute('data-babel-helper-recovered-editor-bridge', 'true');
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

  async function callRecoveredEditorBridge(operation, payload) {
    const ready = await injectRecoveredEditorBridge();
    if (!ready) {
      return null;
    }

    return new Promise((resolve) => {
      bridgeRequestId += 1;
      const id = `recovered-editor-request-${bridgeRequestId}`;
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

      const timeoutId = window.setTimeout(() => {
        bridgeInjected = false;
        bridgeLoadPromise = null;
        finish(null);
      }, BRIDGE_TIMEOUT_MS);
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

  function isFreshSnapshot(snapshot) {
    return Boolean(
      snapshot &&
        snapshot.contractVersion === BABEL_EDITOR_CONTRACT_VERSION &&
        Number.isFinite(Number(snapshot.capturedAt)) &&
        Date.now() - Number(snapshot.capturedAt) <= SNAPSHOT_MAX_AGE_MS
    );
  }

  function getDomRowTimeLabels(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const startCell = row.children[BABEL_TABLE_COLUMN_INDEX.start];
    const endCell = row.children[BABEL_TABLE_COLUMN_INDEX.end];
    return {
      startText: startCell instanceof HTMLElement ? normalizeBabelContractText(startCell.innerText || startCell.textContent || '') : '',
      endText: endCell instanceof HTMLElement ? normalizeBabelContractText(endCell.innerText || endCell.textContent || '') : ''
    };
  }

  function rowMatchesSnapshot(row, snapshotRow) {
    if (!(row instanceof HTMLTableRowElement) || !snapshotRow) {
      return false;
    }

    if (typeof helper.getRowIdentity === 'function') {
      const identity = helper.getRowIdentity(row);
      if (
        identity &&
        identity.annotationId &&
        snapshotRow.annotationId &&
        identity.annotationId === snapshotRow.annotationId
      ) {
        return true;
      }
    }

    const labels = getDomRowTimeLabels(row);
    if (!labels) {
      return false;
    }

    const speakerCell = row.children[BABEL_TABLE_COLUMN_INDEX.speaker];
    const speakerLabel = speakerCell instanceof HTMLElement
      ? normalizeBabelContractText(speakerCell.innerText || speakerCell.textContent || '')
      : '';
    const startSeconds = parseBabelDisplayedTime(labels.startText);
    const endSeconds = parseBabelDisplayedTime(labels.endText);
    return Boolean(
      (!snapshotRow.speakerLabel || !speakerLabel || snapshotRow.speakerLabel === speakerLabel) &&
        labels.startText === snapshotRow.startText &&
        labels.endText === snapshotRow.endText &&
        (
          snapshotRow.startSeconds == null ||
          startSeconds == null ||
          Math.abs(Number(snapshotRow.startSeconds) - startSeconds) <= 0.035
        ) &&
        (
          snapshotRow.endSeconds == null ||
          endSeconds == null ||
          Math.abs(Number(snapshotRow.endSeconds) - endSeconds) <= 0.035
        )
    );
  }

  helper.refreshEditorSnapshot = async function refreshEditorSnapshot(reason) {
    if (snapshotInFlight) {
      return snapshotInFlight;
    }

    snapshotInFlight = (async () => {
      const result = await callRecoveredEditorBridge('snapshot', { reason: reason || 'refresh' });
      const snapshot = result && result.ok && result.snapshot ? result.snapshot : null;
      if (snapshot && snapshot.contractVersion === BABEL_EDITOR_CONTRACT_VERSION) {
        helper.state.editorSnapshot = snapshot;
        helper.state.editorSnapshotCapturedAt = Date.now();
        helper.perf?.count?.('editor-snapshot.refresh', {
          rows: Array.isArray(snapshot.rows) ? snapshot.rows.length : 0,
          reason: reason || 'refresh'
        });
        return snapshot;
      }
      return null;
    })();

    try {
      return await snapshotInFlight;
    } finally {
      snapshotInFlight = null;
    }
  };

  helper.getEditorSnapshot = function getEditorSnapshot() {
    const snapshot = helper.state.editorSnapshot || null;
    if (isFreshSnapshot(snapshot)) {
      return snapshot;
    }

    void helper.refreshEditorSnapshot('stale-read');
    return snapshot && snapshot.contractVersion === BABEL_EDITOR_CONTRACT_VERSION ? snapshot : null;
  };

  helper.applyRecoveredEditorDiffState = async function applyRecoveredEditorDiffState(payload) {
    return callRecoveredEditorBridge('apply-extended-diff-state', payload || {});
  };

  helper.clearRecoveredEditorDiffState = async function clearRecoveredEditorDiffState(reason) {
    return callRecoveredEditorBridge('clear-extended-diff-state', { reason: reason || 'clear' });
  };

  helper.findRowFromEditorSnapshot = function findRowFromEditorSnapshot(target) {
    const snapshot = helper.getEditorSnapshot();
    if (!snapshot || !Array.isArray(snapshot.rows)) {
      return null;
    }

    const annotationId =
      typeof target === 'string'
        ? target
        : target && typeof target === 'object' && typeof target.annotationId === 'string'
          ? target.annotationId
          : snapshot.activeRowId || '';
    const snapshotRow =
      (annotationId
        ? snapshot.rows.find((row) => row && row.annotationId === annotationId)
        : null) ||
      (target && typeof target === 'object' ? target : null);
    if (!snapshotRow) {
      return null;
    }

    const rows =
      typeof helper.getTranscriptRows === 'function'
        ? helper.getTranscriptRows()
        : Array.from(document.querySelectorAll('tbody tr'));
    return rows.find((row) => rowMatchesSnapshot(row, snapshotRow)) || null;
  };
}
