// @ts-nocheck
import { BABEL_ROW_TEXTAREA_SELECTOR } from '../core/babel-editor-contract';

export function initTimestampBridge() {
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const existingBridge = window.__babelHelperTimestampBridge;
  if (existingBridge) {
    if (typeof existingBridge.createSegment === 'function') {
      return;
    }

    if (typeof existingBridge.dispose === 'function') {
      existingBridge.dispose();
    } else {
      delete window.__babelHelperTimestampBridge;
    }
  }

  const REQUEST_EVENT = 'babel-helper-timestamp-request';
  const RESPONSE_EVENT = 'babel-helper-timestamp-response';
  const ROW_TEXTAREA_SELECTOR = BABEL_ROW_TEXTAREA_SELECTOR;

  function safe(callback, fallbackValue) {
    try {
      const value = callback();
      return value == null ? fallbackValue : value;
    } catch (_error) {
      return fallbackValue;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  async function waitFor(callback, timeoutMs = 1200, intervalMs = 40) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const value = safe(() => callback(), null);
      if (value) {
        return value;
      }

      await sleep(intervalMs);
    }

    return null;
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

  function normalizeText(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
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

  function getTranscriptRows() {
    return Array.from(document.querySelectorAll('tbody tr')).filter(
      (row) => row instanceof HTMLTableRowElement && row.querySelector(ROW_TEXTAREA_SELECTOR)
    );
  }

  function getRowSpeakerKey(row) {
    if (!(row instanceof HTMLTableRowElement) || row.children.length < 2) {
      return '';
    }

    return normalizeText(row.children[1]?.textContent || '');
  }

  function getRowTimeLabels(row) {
    if (!(row instanceof HTMLTableRowElement) || row.children.length < 4) {
      return null;
    }

    return {
      startText: normalizeText(row.children[2]?.textContent || ''),
      endText: normalizeText(row.children[3]?.textContent || '')
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
    const rows = getTranscriptRows();
    let bestRow = null;
    let bestScore = -Infinity;

    for (const row of rows) {
      if (speakerKey && getRowSpeakerKey(row) !== speakerKey) {
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
    const rows = getTranscriptRows();
    const exactMatch =
      rows.find((row) => {
        if (speakerKey && getRowSpeakerKey(row) !== speakerKey) {
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
    const rows = getTranscriptRows();
    let bestRow = null;
    let bestScore = Infinity;

    for (const row of rows) {
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      if (speakerKey && getRowSpeakerKey(row) !== speakerKey) {
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

  function resolveRowTimeChangeBinding(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    let fiber = getReactFiber(row);
    if (!fiber) {
      fiber = getReactFiber(row.querySelector(ROW_TEXTAREA_SELECTOR));
    }

    let current = fiber;
    let depth = 0;
    while (current && typeof current === 'object' && depth < 16) {
      const props = current.memoizedProps;
      const annotation =
        props && typeof props === 'object' && props.annotation && typeof props.annotation === 'object'
          ? props.annotation
          : null;
      const onTimeChange =
        props && typeof props === 'object' && typeof props.onTimeChange === 'function'
          ? props.onTimeChange
          : null;
      if (annotation && typeof annotation.id === 'string' && annotation.id && onTimeChange) {
        return {
          annotationId: annotation.id,
          onTimeChange,
          startSeconds: Number(annotation.startTimeInSeconds),
          endSeconds: Number(annotation.endTimeInSeconds)
        };
      }

      current = current.return;
      depth += 1;
    }

    return null;
  }

  function resolveRowActionBinding(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    let fiber = getReactFiber(row);
    if (!fiber) {
      fiber = getReactFiber(row.querySelector(ROW_TEXTAREA_SELECTOR));
    }

    let current = fiber;
    let depth = 0;
    while (current && typeof current === 'object' && depth < 24) {
      const props = current.memoizedProps;
      const annotation =
        props && typeof props === 'object' && props.annotation && typeof props.annotation === 'object'
          ? props.annotation
          : null;
      if (annotation && typeof annotation.id === 'string' && annotation.id) {
        const onMergeAbove =
          props && typeof props === 'object' && typeof props.onMergeAbove === 'function'
            ? props.onMergeAbove
            : null;
        const onMergeBelow =
          props && typeof props === 'object' && typeof props.onMergeBelow === 'function'
            ? props.onMergeBelow
            : null;
        const onDelete =
          props && typeof props === 'object' && typeof props.onDelete === 'function'
            ? props.onDelete
            : null;
        if (onMergeAbove || onMergeBelow || onDelete) {
          return {
            annotation,
            annotationId: annotation.id,
            canMergeAbove: Boolean(props.canMergeAbove),
            canMergeBelow: Boolean(props.canMergeBelow),
            onDelete,
            onMergeAbove,
            onMergeBelow,
            startSeconds: Number(annotation.startTimeInSeconds),
            endSeconds: Number(annotation.endTimeInSeconds)
          };
        }
      }

      current = current.return;
      depth += 1;
    }

    return null;
  }

  function findRowByAnnotationId(annotationId) {
    if (typeof annotationId !== 'string' || !annotationId) {
      return null;
    }

    for (const row of getTranscriptRows()) {
      const binding = resolveRowTimeChangeBinding(row);
      if (binding && binding.annotationId === annotationId) {
        return row;
      }
    }

    return null;
  }

  function findSplitAnnotationCallback(startElement) {
    let fiber = getReactFiber(startElement);
    if (!fiber && startElement instanceof HTMLTableRowElement) {
      fiber = getReactFiber(startElement.querySelector(ROW_TEXTAREA_SELECTOR));
    }

    let current = fiber;
    let depth = 0;
    while (current && typeof current === 'object' && depth < 40) {
      let hook = current.memoizedState;
      let hookIndex = 0;
      while (hook && typeof hook === 'object' && hookIndex < 180) {
        const memoizedState = hook.memoizedState;
        const candidate =
          Array.isArray(memoizedState) && typeof memoizedState[0] === 'function'
            ? memoizedState[0]
            : typeof memoizedState === 'function'
              ? memoizedState
              : null;
        if (candidate) {
          const source = Function.prototype.toString.call(candidate);
          if (
            candidate.length === 2 &&
            source.includes('crypto.randomUUID') &&
            source.includes('startTimeInSeconds') &&
            source.includes('endTimeInSeconds') &&
            source.includes('lowConfidenceResolved') &&
            source.includes('.05') &&
            source.includes('undo')
          ) {
            return candidate;
          }
        }

        hook = hook.next;
        hookIndex += 1;
      }

      current = current.return;
      depth += 1;
    }

    return null;
  }

  function resolveRowSplitBinding(row) {
    const timeBinding = resolveRowTimeChangeBinding(row);
    const splitAnnotation = findSplitAnnotationCallback(row);
    if (!timeBinding || typeof timeBinding.annotationId !== 'string' || !timeBinding.annotationId) {
      return null;
    }

    if (typeof splitAnnotation !== 'function') {
      return null;
    }

    return {
      annotationId: timeBinding.annotationId,
      splitAnnotation,
      startSeconds: timeBinding.startSeconds,
      endSeconds: timeBinding.endSeconds
    };
  }

  function createAnnotationId() {
    const randomId =
      typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : '';
    return randomId || 'babel-helper-created-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function resolveCreateAnnotationBinding() {
    const seeds = [];
    for (const row of getTranscriptRows()) {
      seeds.push(row);
      const textarea = row.querySelector(ROW_TEXTAREA_SELECTOR);
      if (textarea instanceof HTMLElement) {
        seeds.push(textarea);
      }
    }

    for (const seed of seeds) {
      let current = getReactFiber(seed);
      let depth = 0;
      while (current && typeof current === 'object' && depth < 90) {
        const props = current.memoizedProps;
        const onCreateAnnotation =
          props && typeof props === 'object' && typeof props.onCreateAnnotation === 'function'
            ? props.onCreateAnnotation
            : null;
        if (onCreateAnnotation) {
          return {
            onCreateAnnotation,
            annotations: Array.isArray(props.annotations) ? props.annotations : [],
            tracks: Array.isArray(props.tracks) ? props.tracks : []
          };
        }

        current = current.return;
        depth += 1;
      }
    }

    return null;
  }

  function findRowsAroundSplit(annotationId, splitSeconds, options) {
    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const originalStart = Number(settings.startSeconds);
    const originalEnd = Number(settings.endSeconds);
    const leftTargetEnd = splitSeconds - 0.05;
    const rightTargetStart = splitSeconds + 0.05;
    const tolerance = 0.09;
    let leftRow = null;
    let rightRow = null;

    for (const row of getTranscriptRows()) {
      if (speakerKey && getRowSpeakerKey(row) !== speakerKey) {
        continue;
      }

      const binding = resolveRowTimeChangeBinding(row);
      if (binding && binding.annotationId === annotationId) {
        continue;
      }

      const range = getRowTimeRange(row);
      if (!range) {
        continue;
      }

      if (
        Number.isFinite(originalStart) &&
        Math.abs(range.startSeconds - originalStart) <= tolerance &&
        Math.abs(range.endSeconds - leftTargetEnd) <= tolerance
      ) {
        leftRow = row;
      }

      if (
        Number.isFinite(originalEnd) &&
        Math.abs(range.startSeconds - rightTargetStart) <= tolerance &&
        Math.abs(range.endSeconds - originalEnd) <= tolerance
      ) {
        rightRow = row;
      }
    }

    return leftRow && rightRow ? { leftRow, rightRow } : null;
  }

  function resolveRowFromPayload(payload) {
    let row =
      (payload?.annotationId ? findRowByAnnotationId(payload.annotationId) : null) ||
      findRowByTimeLabels(payload?.startText, payload?.endText, {
        speakerKey: payload?.speakerKey
      }) ||
      findRowByTimeRange(Number(payload?.startSeconds), Number(payload?.endSeconds), {
        speakerKey: payload?.speakerKey
      });
    if (!(row instanceof HTMLTableRowElement) && payload?.rowIdentity && typeof payload.rowIdentity === 'object') {
      row = findRowByAnnotationId(payload.rowIdentity.annotationId || '');
    }
    return row instanceof HTMLTableRowElement ? row : null;
  }

  async function createSegment(payload) {
    const processedRecordingId =
      typeof payload?.processedRecordingId === 'string' ? payload.processedRecordingId : '';
    const speakerKey = typeof payload?.speakerKey === 'string' ? payload.speakerKey : processedRecordingId;
    const startSeconds = Number(payload?.startSeconds);
    const endSeconds = Number(payload?.endSeconds);
    if (!processedRecordingId || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return {
        ok: false,
        backend: 'page-react-create-annotation',
        reason: 'invalid-segment'
      };
    }

    const binding = resolveCreateAnnotationBinding();
    if (!binding || typeof binding.onCreateAnnotation !== 'function') {
      return {
        ok: false,
        backend: 'page-react-create-annotation',
        reason: 'binding-not-found'
      };
    }

    const annotationId =
      typeof payload?.annotationId === 'string' && payload.annotationId
        ? payload.annotationId
        : createAnnotationId();
    const rowCountBefore = getTranscriptRows().length;
    try {
      binding.onCreateAnnotation({
        id: annotationId,
        type: 'transcription',
        content: '',
        processedRecordingId,
        startTimeInSeconds: startSeconds,
        endTimeInSeconds: endSeconds,
        intensity: null
      });
    } catch (error) {
      return {
        ok: false,
        backend: 'page-react-create-annotation',
        reason: 'apply-threw',
        message: error instanceof Error ? error.message : String(error || '')
      };
    }

    const createdRow = await waitFor(() => {
      const byId = findRowByAnnotationId(annotationId);
      if (byId instanceof HTMLTableRowElement) {
        return byId;
      }

      return findRowByTimeRange(startSeconds, endSeconds, {
        speakerKey: speakerKey || processedRecordingId
      });
    }, 1600, 40);

    if (!(createdRow instanceof HTMLTableRowElement)) {
      return {
        ok: false,
        backend: 'page-react-create-annotation',
        reason: 'verify-timeout',
        annotationId
      };
    }

    const labels = getRowTimeLabels(createdRow);
    const range = getRowTimeRange(createdRow);
    const timeBinding = resolveRowTimeChangeBinding(createdRow);
    return {
      ok: true,
      backend: 'page-react-create-annotation',
      annotationId: timeBinding?.annotationId || annotationId,
      processedRecordingId,
      speakerKey,
      startText: labels?.startText || '',
      endText: labels?.endText || '',
      startSeconds: range?.startSeconds ?? startSeconds,
      endSeconds: range?.endSeconds ?? endSeconds,
      rowCountBefore,
      rowCountAfter: getTranscriptRows().length
    };
  }

  async function mergeSegment(payload) {
    const direction = payload && payload.direction === 'below' ? 'below' : 'above';
    const row = resolveRowFromPayload(payload);
    if (!(row instanceof HTMLTableRowElement)) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'row-not-found'
      };
    }

    const binding = resolveRowActionBinding(row);
    const action = direction === 'below' ? binding?.onMergeBelow : binding?.onMergeAbove;
    const canMerge = direction === 'below' ? binding?.canMergeBelow : binding?.canMergeAbove;
    if (!binding || typeof action !== 'function' || typeof binding.annotationId !== 'string' || !binding.annotationId) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'binding-not-found'
      };
    }

    if (!canMerge) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'merge-disabled',
        annotationId: binding.annotationId,
        direction
      };
    }

    const rowCountBefore = getTranscriptRows().length;
    try {
      if (direction === 'below') {
        binding.onMergeBelow(binding.annotationId);
      } else {
        binding.onMergeAbove(binding.annotationId);
      }
    } catch (error) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'apply-threw',
        message: error instanceof Error ? error.message : String(error || '')
      };
    }

    const settled = await waitFor(() => {
      const rows = getTranscriptRows();
      if (rows.length < rowCountBefore) {
        return { rowCountAfter: rows.length, removed: true };
      }

      const current = findRowByAnnotationId(binding.annotationId);
      if (!(current instanceof HTMLTableRowElement)) {
        return { rowCountAfter: rows.length, removed: true };
      }

      return null;
    }, 1600, 40);

    if (!settled) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'verify-timeout',
        annotationId: binding.annotationId,
        direction
      };
    }

    return {
      ok: true,
      backend: 'page-react-row-action',
      annotationId: binding.annotationId,
      direction,
      rowCountBefore,
      rowCountAfter: settled.rowCountAfter
    };
  }

  async function deleteSegment(payload) {
    const row = resolveRowFromPayload(payload);
    if (!(row instanceof HTMLTableRowElement)) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'row-not-found'
      };
    }

    const binding = resolveRowActionBinding(row);
    if (
      !binding ||
      typeof binding.onDelete !== 'function' ||
      typeof binding.annotationId !== 'string' ||
      !binding.annotationId
    ) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'binding-not-found'
      };
    }

    const rowCountBefore = getTranscriptRows().length;
    try {
      binding.onDelete(binding.annotationId);
    } catch (error) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'apply-threw',
        message: error instanceof Error ? error.message : String(error || '')
      };
    }

    const settled = await waitFor(() => {
      const rows = getTranscriptRows();
      if (rows.length < rowCountBefore) {
        return { rowCountAfter: rows.length, removed: true };
      }

      const current = findRowByAnnotationId(binding.annotationId);
      if (!(current instanceof HTMLTableRowElement)) {
        return { rowCountAfter: rows.length, removed: true };
      }

      return null;
    }, 1600, 40);

    if (!settled) {
      return {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'verify-timeout',
        annotationId: binding.annotationId
      };
    }

    return {
      ok: true,
      backend: 'page-react-row-action',
      annotationId: binding.annotationId,
      rowCountBefore,
      rowCountAfter: settled.rowCountAfter
    };
  }

  async function setBoundaryTime(payload) {
    const side = payload && payload.side === 'left' ? 'left' : 'right';
    const targetSeconds = Number(payload?.targetSeconds);
    if (!Number.isFinite(targetSeconds)) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'invalid-target'
      };
    }

    let row =
      resolveRowFromPayload(payload) ||
      findRowNearBoundary(side, targetSeconds, {
        speakerKey: payload?.speakerKey
      });
    if (!(row instanceof HTMLTableRowElement)) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'row-not-found'
      };
    }

    const binding = resolveRowTimeChangeBinding(row);
    if (
      !binding ||
      typeof binding.onTimeChange !== 'function' ||
      typeof binding.annotationId !== 'string' ||
      !binding.annotationId
    ) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'binding-not-found'
      };
    }

    const rowRange = getRowTimeRange(row);
    const currentStart = Number.isFinite(binding.startSeconds)
      ? binding.startSeconds
      : rowRange
        ? rowRange.startSeconds
        : null;
    const currentEnd = Number.isFinite(binding.endSeconds)
      ? binding.endSeconds
      : rowRange
        ? rowRange.endSeconds
        : null;
    if (!Number.isFinite(currentStart) || !Number.isFinite(currentEnd)) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'current-range-invalid'
      };
    }

    const nextRange =
      side === 'left'
        ? {
            start: targetSeconds,
            end: currentEnd
          }
        : {
            start: currentStart,
            end: targetSeconds
          };
    if (!Number.isFinite(nextRange.start) || !Number.isFinite(nextRange.end) || nextRange.end <= nextRange.start) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'next-range-invalid'
      };
    }

    try {
      binding.onTimeChange(binding.annotationId, nextRange);
    } catch (error) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'apply-threw',
        message: error instanceof Error ? error.message : String(error || '')
      };
    }

    const updatedRow = await waitFor(() => {
      const candidate =
        findRowByAnnotationId(binding.annotationId) ||
        findRowNearBoundary(side, targetSeconds, {
          speakerKey: payload?.speakerKey
        });
      if (!(candidate instanceof HTMLTableRowElement)) {
        return null;
      }

      const range = getRowTimeRange(candidate);
      if (!range) {
        return null;
      }

      const boundarySeconds = side === 'left' ? range.startSeconds : range.endSeconds;
      return Math.abs(boundarySeconds - targetSeconds) <= 0.03 ? candidate : null;
    }, 1200, 40);

    if (!(updatedRow instanceof HTMLTableRowElement)) {
      return {
        ok: false,
        backend: 'page-react-row-time-change',
        reason: 'verify-timeout'
      };
    }

    const updatedLabels = getRowTimeLabels(updatedRow);
    const updatedRange = getRowTimeRange(updatedRow);
    return {
      ok: true,
      backend: 'page-react-row-time-change',
      annotationId: binding.annotationId,
      side,
      targetSeconds,
      startText: updatedLabels?.startText || '',
      endText: updatedLabels?.endText || '',
      startSeconds: updatedRange?.startSeconds ?? null,
      endSeconds: updatedRange?.endSeconds ?? null
    };
  }

  async function splitSegmentAtTime(payload) {
    const splitSeconds = Number(payload?.splitSeconds);
    if (!Number.isFinite(splitSeconds)) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'invalid-split'
      };
    }

    let row = resolveRowFromPayload(payload);
    if (!(row instanceof HTMLTableRowElement)) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'row-not-found'
      };
    }

    const binding = resolveRowSplitBinding(row);
    if (
      !binding ||
      typeof binding.splitAnnotation !== 'function' ||
      typeof binding.annotationId !== 'string' ||
      !binding.annotationId
    ) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'binding-not-found'
      };
    }

    const rowRange = getRowTimeRange(row);
    const currentStart = Number.isFinite(binding.startSeconds)
      ? binding.startSeconds
      : rowRange
        ? rowRange.startSeconds
        : null;
    const currentEnd = Number.isFinite(binding.endSeconds)
      ? binding.endSeconds
      : rowRange
        ? rowRange.endSeconds
        : null;
    if (!Number.isFinite(currentStart) || !Number.isFinite(currentEnd)) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'current-range-invalid'
      };
    }

    if (splitSeconds <= currentStart || splitSeconds >= currentEnd - 0.1) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'split-out-of-range'
      };
    }

    try {
      binding.splitAnnotation(binding.annotationId, splitSeconds);
    } catch (error) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'apply-threw',
        message: error instanceof Error ? error.message : String(error || '')
      };
    }

    const splitRows = await waitFor(
      () =>
        findRowsAroundSplit(binding.annotationId, splitSeconds, {
          speakerKey: payload?.speakerKey,
          startSeconds: currentStart,
          endSeconds: currentEnd
        }),
      1200,
      40
    );

    if (!splitRows) {
      return {
        ok: false,
        backend: 'page-react-split-annotation',
        reason: 'verify-timeout'
      };
    }

    const leftLabels = getRowTimeLabels(splitRows.leftRow);
    const rightLabels = getRowTimeLabels(splitRows.rightRow);
    const leftRange = getRowTimeRange(splitRows.leftRow);
    const rightRange = getRowTimeRange(splitRows.rightRow);
    const leftBinding = resolveRowTimeChangeBinding(splitRows.leftRow);
    const rightBinding = resolveRowTimeChangeBinding(splitRows.rightRow);
    return {
      ok: true,
      backend: 'page-react-split-annotation',
      annotationId: binding.annotationId,
      leftAnnotationId: leftBinding?.annotationId || '',
      rightAnnotationId: rightBinding?.annotationId || '',
      splitSeconds,
      leftStartText: leftLabels?.startText || '',
      leftEndText: leftLabels?.endText || '',
      rightStartText: rightLabels?.startText || '',
      rightEndText: rightLabels?.endText || '',
      leftStartSeconds: leftRange?.startSeconds ?? null,
      leftEndSeconds: leftRange?.endSeconds ?? null,
      rightStartSeconds: rightRange?.startSeconds ?? null,
      rightEndSeconds: rightRange?.endSeconds ?? null
    };
  }

  function handleRequest(event) {
    const detail = event.detail || {};
    const id = detail.id;
    const operation = detail.operation;
    const payload = detail.payload || {};
    if (!id) {
      return;
    }

    if (operation === 'set-boundary-time') {
      Promise.resolve(setBoundaryTime(payload))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            backend: 'page-react-row-time-change',
            reason: 'bridge-error',
            message: error instanceof Error ? error.message : String(error || '')
          })
        );
    } else if (operation === 'split-segment-at-time') {
      Promise.resolve(splitSegmentAtTime(payload))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            backend: 'page-react-split-annotation',
            reason: 'bridge-error',
            message: error instanceof Error ? error.message : String(error || '')
          })
        );
    } else if (operation === 'merge-segment') {
      Promise.resolve(mergeSegment(payload))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            backend: 'page-react-row-action',
            reason: 'bridge-error',
            message: error instanceof Error ? error.message : String(error || '')
          })
        );
    } else if (operation === 'create-segment') {
      Promise.resolve(createSegment(payload))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            backend: 'page-react-create-annotation',
            reason: 'bridge-error',
            message: error instanceof Error ? error.message : String(error || '')
          })
        );
    } else if (operation === 'delete-segment') {
      Promise.resolve(deleteSegment(payload))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            backend: 'page-react-row-action',
            reason: 'bridge-error',
            message: error instanceof Error ? error.message : String(error || '')
          })
        );
    }
  }

  function dispose() {
    window.removeEventListener(REQUEST_EVENT, handleRequest, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    delete window.__babelHelperTimestampBridge;
  }

  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  window.__babelHelperTimestampBridge = {
    createSegment,
    deleteSegment,
    mergeSegment,
    setBoundaryTime,
    splitSegmentAtTime,
    dispose
  };
}

initTimestampBridge();
