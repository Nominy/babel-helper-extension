// @ts-nocheck
import { readBabelTranscriptBindings } from '@nominy/babel-babel-runtime';
import { parseTimeValue } from '../hooks/parsing';

export function initTimestampBridge() {
  const REQUEST_EVENT = 'babel-helper-timestamp-request';
  const RESPONSE_EVENT = 'babel-helper-timestamp-response';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const SERVICE_ID = 'page.timestamp';
  window.__babelHelperTimestampBridge?.dispose();
  let disposed = false;
  const routeKey = () => `${location.pathname}${location.search}`;
  const timeText = value => Number.isFinite(value)
    ? `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(2).padStart(5, '0')}` : '';
  const turns = binding => binding.annotations.filter(turn => turn.type === 'transcription')
    .slice().sort((a, b) => (a.startTimeInSeconds ?? 0) - (b.startTimeInSeconds ?? 0));
  const failure = (backend, reason) => ({ ok: false, backend, reason });
  const historyEpoch = crypto.randomUUID();
  const commandIds = new WeakMap();
  let nextCommandId = 0;

  function historyToken(binding, depth = binding?.history?.undoStack.length) {
    const history = binding?.history;
    if (!history || !Number.isInteger(depth) || depth < 0 || depth > history.undoStack.length) return null;
    const command = depth ? history.undoStack[depth - 1] : history.undo;
    if (!command || (typeof command !== 'object' && typeof command !== 'function')) return null;
    let id = commandIds.get(command);
    if (!id) { id = ++nextCommandId; commandIds.set(command, id); }
    return `${historyEpoch}:${binding.reviewActionId}:${depth}:${id}`;
  }

  function matchesExpectedHistory(binding, payload) {
    return Number.isInteger(payload?.expectedHistoryRevision) && payload.expectedHistoryRevision >= 0 &&
      payload.expectedHistoryRevision === binding?.history?.undoStack.length &&
      typeof payload.expectedHistoryToken === 'string' &&
      payload.expectedHistoryToken === historyToken(binding);
  }

  function invokeNativeCommand(context, invoke) {
    const binding = current(context);
    if (!binding) return { error: failure(context.backend, 'stale-task') };
    if (context.guarded && (!matchesExpectedHistory(binding, context.payload) ||
        Object.keys(binding.pendingTextById || {}).length)) return { error: failure(context.backend, 'history-conflict') };
    const previousHistoryToken = historyToken(binding);
    if (!previousHistoryToken) return { error: failure(context.backend, 'history-unavailable') };
    const receipt = { previousHistoryRevision: binding.history.undoStack.length, previousHistoryToken,
      historyRevision: null, historyToken: null };
    context.execution.receipt = receipt;
    let value;
    try {
      value = invoke(binding);
    } finally {
      // Native Zustand history updates synchronously. Capture this command's
      // identity now, never a possibly unrelated head after awaiting React.
      const after = current(context);
      receipt.historyRevision = after?.history?.undoStack.length ?? null;
      receipt.historyToken = historyToken(after);
    }
    if (!receipt.historyToken) return { error: failure(context.backend, 'history-unavailable') };
    return { value, receipt, annotationsBefore: binding.annotations };
  }

  function snapshotRow(annotation, index, binding) {
    const trackLabel = binding.tracks.find(track => track.id === annotation.processedRecordingId)?.label || '';
    return { index, annotationId: annotation.id, processedRecordingId: annotation.processedRecordingId,
      trackLabel, speakerKey: annotation.processedRecordingId || trackLabel, lane: trackLabel,
      startText: timeText(annotation.startTimeInSeconds), endText: timeText(annotation.endTimeInSeconds),
      startSeconds: annotation.startTimeInSeconds, endSeconds: annotation.endTimeInSeconds,
      text: binding.pendingTextById?.[annotation.id] ?? annotation.content ?? '' };
  }

  function snapshotTranscript() {
    const binding = readBabelTranscriptBindings();
    const backend = 'page-react-transcript-snapshot';
    if (!binding) return failure(backend, 'binding-not-found');
    return { ok: true, backend, reviewActionId: binding.reviewActionId, readOnly: binding.readOnly,
      historyRevision: binding.history?.undoStack.length ?? null,
      historyToken: historyToken(binding),
      rows: turns(binding).map((turn, index) => snapshotRow(turn, index, binding)),
      lanes: binding.tracks.map(track => ({ processedRecordingId: track.id, speakerKey: track.id,
        trackLabel: track.label, lane: track.label })) };
  }

  function begin(payload, backend, execution) {
    const binding = readBabelTranscriptBindings();
    if (!binding || disposed) return { error: failure(backend, 'binding-not-found') };
    if (binding.readOnly) return { error: failure(backend, 'read-only') };
    const taskId = payload?.expectedReviewActionId || payload?.reviewActionId || payload?.rowIdentity?.reviewActionId;
    if ((taskId && taskId !== binding.reviewActionId) || (payload?.routeKey && payload.routeKey !== routeKey())) {
      return { error: failure(backend, 'stale-task') };
    }
    const guarded = payload?.expectedHistoryRevision !== undefined || payload?.expectedHistoryToken !== undefined;
    if (guarded && (!matchesExpectedHistory(binding, payload) || Object.keys(binding.pendingTextById || {}).length)) {
      return { error: failure(backend, 'history-conflict') };
    }
    return { binding, taskId: binding.reviewActionId, route: routeKey(), backend, guarded, payload, execution };
  }

  function current(context) {
    const binding = readBabelTranscriptBindings();
    return !disposed && routeKey() === context.route && binding?.reviewActionId === context.taskId && !binding.readOnly
      ? binding : null;
  }

  async function settle(context, predicate, command = null) {
    const deadline = Date.now() + 1600;
    do {
      const binding = current(context);
      if (!binding) return { error: failure(context.backend, 'stale-task') };
      if (command && historyToken(binding) !== command.receipt.historyToken) {
        return { error: failure(context.backend, 'history-conflict') };
      }
      const value = (!command || binding.annotations !== command.annotationsBefore) && predicate(binding);
      if (value) return { binding, value };
      await new Promise(resolve => window.setTimeout(resolve, 16));
    } while (Date.now() < deadline);
    return { error: failure(context.backend, 'verify-timeout') };
  }

  function resolveTurn(binding, payload, boundary = null) {
    const id = payload?.annotationId || payload?.rowIdentity?.annotationId;
    if (id) return turns(binding).find(turn => turn.id === id) || null;
    const lane = payload?.processedRecordingId || payload?.speakerKey;
    const candidates = turns(binding).filter(turn => !lane || turn.processedRecordingId === lane ||
      binding.tracks.find(track => track.id === turn.processedRecordingId)?.label === lane);
    const start = payload?.startSeconds == null ? parseTimeValue(payload?.startText || '') : Number(payload.startSeconds);
    const end = payload?.endSeconds == null ? parseTimeValue(payload?.endText || '') : Number(payload.endSeconds);
    if (!boundary && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) return null;
    let best = null;
    let score = Infinity;
    for (const turn of candidates) {
      const left = turn.startTimeInSeconds, right = turn.endTimeInSeconds;
      if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
      const next = boundary ? Math.abs((boundary.side === 'left' ? left : right) - boundary.time)
        : Math.abs(left - start) + Math.abs(right - end) - 100 * Math.max(0, Math.min(end, right) - Math.max(start, left));
      if (next < score) { best = turn; score = next; }
    }
    return best;
  }

  async function flushEdits(context, annotations) {
    const expected = annotations.map(turn => ({
      id: turn.id, committedText: turn.content ?? '', text: context.binding.pendingTextById?.[turn.id] ?? turn.content ?? ''
    }));
    let changed = false;
    const result = await settle(context, latest => {
      const byId = new Map(latest.annotations.map(turn => [turn.id, turn]));
      let committed = true;
      for (const turn of expected) {
        const annotation = byId.get(turn.id);
        const pending = latest.pendingTextById?.[turn.id];
        if (!annotation || (pending !== undefined && pending !== turn.text) ||
            (annotation.content !== turn.committedText && annotation.content !== turn.text)) {
          changed = true;
          return true;
        }
        if (annotation.content !== turn.text) committed = false;
      }
      return committed;
    });
    return changed ? failure(context.backend, 'stale-transcript') : result.error || null;
  }

  async function flushTranscript(payload, execution) {
    const binding = readBabelTranscriptBindings();
    if (binding?.readOnly) return snapshotTranscript();
    const context = begin(payload, 'page-react-transcript-snapshot', execution);
    if (context.error) return context.error;
    const error = await flushEdits(context, turns(context.binding));
    return error || snapshotTranscript();
  }

  async function createSegment(payload, execution) {
    const backend = 'page-react-create-annotation';
    const context = begin(payload, backend, execution);
    if (context.error) return context.error;
    const start = Number(payload?.startSeconds), end = Number(payload?.endSeconds);
    const trackId = payload?.processedRecordingId;
    if (!context.binding.tracks.some(track => track.id === trackId) || !Number.isFinite(start) ||
        !Number.isFinite(end) || start < 0 || end <= start) return failure(backend, 'invalid-segment');
    const annotationId = payload?.annotationId || crypto.randomUUID();
    if (context.binding.annotations.some(turn => turn.id === annotationId)) return failure(backend, 'duplicate-annotation');
    if (typeof context.binding.panel.onCreateAnnotation !== 'function') return failure(backend, 'binding-not-found');
    const rowCountBefore = turns(context.binding).length;
    const command = invokeNativeCommand(context, latest => latest.panel.onCreateAnnotation({
      id: annotationId, type: 'transcription', content: payload?.text || '',
      processedRecordingId: trackId, startTimeInSeconds: start, endTimeInSeconds: end, intensity: null }));
    if (command.error) return command.error;
    const result = await settle(context, latest => latest.annotations.find(turn => turn.id === annotationId), command);
    if (result.error) return result.error;
    return { ok: true, backend, ...snapshotRow(result.value, 0, result.binding), rowCountBefore,
      rowCountAfter: turns(result.binding).length };
  }

  async function deleteSegment(payload, execution) {
    const backend = 'page-react-row-action';
    const context = begin(payload, backend, execution);
    if (context.error) return context.error;
    const turn = resolveTurn(context.binding, payload);
    if (!turn) return failure(backend, 'row-not-found');
    if (context.binding.transcript?.lockSegments) return failure(backend, 'segments-locked');
    const flushed = await flushEdits(context, [turn]);
    if (flushed) return flushed;
    const binding = current(context);
    if (!binding) return failure(backend, 'stale-task');
    if (typeof binding.panel.onDeleteAnnotation !== 'function') return failure(backend, 'binding-not-found');
    const rowCountBefore = turns(binding).length;
    const command = invokeNativeCommand(context, latest => latest.panel.onDeleteAnnotation(turn.id));
    if (command.error) return command.error;
    const result = await settle(context, latest => !latest.annotations.some(item => item.id === turn.id), command);
    if (result.error) return result.error;
    return { ok: true, backend, annotationId: turn.id, rowCountBefore, rowCountAfter: turns(result.binding).length };
  }

  async function mergeSegment(payload, execution) {
    const backend = 'page-react-row-action';
    const context = begin(payload, backend, execution);
    if (context.error) return context.error;
    const direction = payload?.direction === 'below' ? 'below' : 'above';
    const turn = resolveTurn(context.binding, payload);
    if (!turn) return failure(backend, 'row-not-found');
    if (context.binding.transcript?.lockSegments) return failure(backend, 'segments-locked');
    const lane = turns(context.binding).filter(item => item.processedRecordingId === turn.processedRecordingId);
    const adjacent = lane[lane.findIndex(item => item.id === turn.id) + (direction === 'below' ? 1 : -1)];
    if (!adjacent) return failure(backend, 'merge-disabled');
    const flushed = await flushEdits(context, [turn, adjacent]);
    if (flushed) return flushed;
    const binding = current(context);
    if (!binding) return failure(backend, 'stale-task');
    if (!binding.annotations.some(item => item.id === adjacent.id) || !binding.annotations.some(item => item.id === turn.id)) {
      return failure(backend, 'row-not-found');
    }
    if (typeof binding.panel.onMergeAnnotations !== 'function') return failure(backend, 'binding-not-found');
    const rowCountBefore = turns(binding).length;
    const command = invokeNativeCommand(context, latest => latest.panel.onMergeAnnotations(turn.id, direction));
    if (command.error) return command.error;
    const result = await settle(context, latest => !latest.annotations.some(item => item.id === adjacent.id), command);
    if (result.error) return result.error;
    return { ok: true, backend, annotationId: turn.id, direction, rowCountBefore, rowCountAfter: turns(result.binding).length };
  }

  async function setBoundaryTime(payload, execution) {
    const backend = 'page-react-row-time-change';
    const target = Number(payload?.targetSeconds), side = payload?.side === 'left' ? 'left' : 'right';
    if (!Number.isFinite(target) || target < 0) return failure(backend, 'invalid-target');
    const context = begin(payload, backend, execution);
    if (context.error) return context.error;
    const turn = resolveTurn(context.binding, payload, { side, time: target });
    if (!turn) return failure(backend, 'row-not-found');
    const range = { start: side === 'left' ? target : turn.startTimeInSeconds,
      end: side === 'right' ? target : turn.endTimeInSeconds };
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) return failure(backend, 'next-range-invalid');
    const flushed = await flushEdits(context, [turn]);
    if (flushed) return flushed;
    const binding = current(context);
    if (!binding) return failure(backend, 'stale-task');
    if (typeof binding.panel.onChangeAnnotationTime !== 'function') return failure(backend, 'binding-not-found');
    const command = invokeNativeCommand(context, latest => latest.panel.onChangeAnnotationTime(turn.id, range));
    if (command.error) return command.error;
    const result = await settle(context, latest => {
      const updated = latest.annotations.find(item => item.id === turn.id);
      return updated && Math.abs((side === 'left' ? updated.startTimeInSeconds : updated.endTimeInSeconds) - target) < 0.001 && updated;
    }, command);
    if (result.error) return result.error;
    return { ok: true, backend, ...snapshotRow(result.value, 0, result.binding), side, targetSeconds: target };
  }

  async function splitSegmentAtTime(payload, execution) {
    const backend = 'page-react-split-annotation';
    const time = Number(payload?.splitSeconds);
    const texts = payload?.texts;
    if (texts !== undefined && (!Array.isArray(texts) || texts.length !== 2 ||
        typeof texts[0] !== 'string' || typeof texts[1] !== 'string' || typeof payload?.sourceText !== 'string')) {
      return failure(backend, 'invalid-split');
    }
    if (!Number.isFinite(time)) return failure(backend, 'invalid-split');
    const context = begin(payload, backend, execution);
    if (context.error) return context.error;
    const turn = resolveTurn(context.binding, payload);
    if (!turn) return failure(backend, 'row-not-found');
    if (context.binding.transcript?.lockSegments) return failure(backend, 'segments-locked');
    if (time <= turn.startTimeInSeconds + 0.1 || time >= turn.endTimeInSeconds - 0.1) {
      return failure(backend, 'split-out-of-range');
    }
    if (texts !== undefined && (context.binding.pendingTextById?.[turn.id] ?? turn.content ?? '') !== payload.sourceText) {
      return failure(backend, 'stale-transcript');
    }
    const flushed = await flushEdits(context, [turn]);
    if (flushed) return flushed;
    const binding = current(context);
    if (!binding) return failure(backend, 'stale-task');
    const currentTurn = binding.annotations.find(item => item.id === turn.id);
    if (texts !== undefined && (!currentTurn ||
        (binding.pendingTextById?.[turn.id] ?? currentTurn.content ?? '') !== payload.sourceText)) {
      return failure(backend, 'stale-transcript');
    }
    if (typeof binding.controller?.split !== 'function') return failure(backend, 'binding-not-found');
    const command = invokeNativeCommand(context, latest => latest.controller.split(turn.id, time, texts));
    if (command.error) return command.error;
    const ids = command.value;
    if (!Array.isArray(ids) || ids.length !== 2) return failure(backend, 'split-rejected');
    const result = await settle(context, latest => ids.map(id => latest.annotations.find(item => item.id === id)).every(Boolean), command);
    if (result.error) return result.error;
    const [left, right] = ids.map(id => snapshotRow(result.binding.annotations.find(item => item.id === id), 0, result.binding));
    return { ok: true, backend, annotationId: turn.id, splitSeconds: time,
      leftAnnotationId: ids[0], rightAnnotationId: ids[1], leftStartText: left.startText, leftEndText: left.endText,
      rightStartText: right.startText, rightEndText: right.endText, leftStartSeconds: left.startSeconds,
      leftEndSeconds: left.endSeconds, rightStartSeconds: right.startSeconds, rightEndSeconds: right.endSeconds };
  }

  async function undoTranscript(payload, execution) {
    const backend = 'page-react-transcript-undo';
    const context = begin(payload, backend, execution);
    if (context.error) return context.error;
    const history = context.binding.history;
    // Undo is always guarded; depth without native command identity is unsafe.
    if (!matchesExpectedHistory(context.binding, payload) || Object.keys(context.binding.pendingTextById || {}).length) {
      return failure(backend, 'history-conflict');
    }
    if (!history?.undoStack.length || typeof history.undo !== 'function') return failure(backend, 'history-unavailable');
    const expectedAfter = historyToken(context.binding, history.undoStack.length - 1);
    const command = invokeNativeCommand(context, latest => latest.history.undo());
    if (command.error) return command.error;
    if (command.receipt.historyToken !== expectedAfter) return failure(backend, 'history-conflict');
    const result = await settle(context, () => true, command);
    return result.error || { ok: true, backend };
  }

  const nativeService = { snapshotTranscript };
  // Include receipts on failures as well: a callback may mutate native history
  // before a later commit timeout. Callers must not recreate approximate rows.
  for (const [name, operation] of Object.entries({ createSegment, deleteSegment, mergeSegment,
    setBoundaryTime, splitSegmentAtTime, undoTranscript, flushTranscript })) {
    nativeService[name] = async payload => {
      const before = readBabelTranscriptBindings();
      const execution = { receipt: null };
      const previousHistoryRevision = before?.history?.undoStack.length ?? null;
      const previousHistoryToken = historyToken(before);
      let result;
      try { result = await operation(payload, execution); }
      catch (error) { result = { ok: false, reason: 'apply-threw', message: String(error) }; }
      const after = readBabelTranscriptBindings();
      const sameTask = before && after?.reviewActionId === before.reviewActionId;
      const receipt = execution.receipt || { previousHistoryRevision, previousHistoryToken,
        historyRevision: sameTask ? after.history?.undoStack.length ?? null : null,
        historyToken: sameTask ? historyToken(after) : null };
      if (!execution.receipt && name !== 'flushTranscript' && sameTask &&
          receipt.historyToken !== previousHistoryToken) {
        // No Helper command ran: a user commit during the wait is not a
        // transaction receipt and must never become an authorized rollback.
        result = { ...result, ok: false, reason: 'history-conflict' };
      }
      return { ...receipt, ...result };
    };
  }
  const services = window.BabelMods?.unsafe?.services;
  if (!services?.provide || !services?.invoke) throw new Error('BabelMods page service registry is unavailable');
  const provider = services.provide(SERVICE_ID, nativeService, { owner: 'builtin:timestamp' });
  const operations = { 'snapshot-transcript': 'snapshotTranscript', 'flush-transcript': 'flushTranscript', 'set-boundary-time': 'setBoundaryTime',
    'split-segment-at-time': 'splitSegmentAtTime', 'merge-segment': 'mergeSegment',
    'create-segment': 'createSegment', 'delete-segment': 'deleteSegment', 'undo-transcript': 'undoTranscript' };
  function handleRequest(event) {
    const { id, operation, payload = {} } = event.detail || {};
    if (!id) return;
    Promise.resolve().then(() => operations[operation]
      ? services.invoke(SERVICE_ID, operations[operation], payload) : failure('page-react-transcript', 'unknown-operation'))
      .then(result => window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: { id, result } })),
        error => window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: { id,
          result: { ok: false, reason: 'bridge-error', message: String(error) } } })));
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener(REQUEST_EVENT, handleRequest, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    provider.dispose();
    if (window.__babelHelperTimestampBridge === facade) delete window.__babelHelperTimestampBridge;
  }
  const facade = { dispose };
  for (const method of Object.keys(nativeService)) facade[method] = (...args) => services.invoke(SERVICE_ID, method, ...args);
  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);
  window.__babelHelperTimestampBridge = facade;
}

initTimestampBridge();
