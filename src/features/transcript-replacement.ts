import { captureL0TaskGuard } from '../services/l0-timing-identity';

type ReplacementRow = {
  id: string;
  lane: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};

type ReplacementRequest = {
  type: 'babel-gold-drafting:l0-replace-request';
  version: 1;
  requestId: string;
  rows: ReplacementRow[];
  expectedReviewActionId: string;
  expectedRows: Array<{
    rowId: string;
    processedRecordingId?: string;
    speakerKey: string;
    startSeconds: number | null;
    endSeconds: number | null;
    text: string;
    index: number;
  }>;
};

type CreatedRow = {
  id: string;
  annotationId: string;
  lane: string;
  startSeconds: number;
  endSeconds: number;
};

export type ReplacementResponse = {
  type: 'babel-gold-drafting:l0-replace-response';
  version: 1;
  requestId: string;
  ok: boolean;
  created?: CreatedRow[];
  reason?: string;
  message?: string;
};

type SnapshotRow = {
  annotationId: string;
  processedRecordingId: string;
  speakerKey: string;
  lane: string;
  trackLabel: string;
  startSeconds: number;
  endSeconds: number;
  startText: string;
  endText: string;
  text: string;
  rowIdentity: Record<string, unknown>;
};

type LaneBinding = {
  processedRecordingId: string;
  speakerKey: string;
};

type SnapshotLane = LaneBinding & { lane: string; trackLabel: string };
type TranscriptSnapshot = SnapshotRow[] & {
  lanes: SnapshotLane[];
  reviewActionId: string;
  historyRevision: number;
  historyToken: string;
};

type PreparedRow = ReplacementRow & LaneBinding & { requestIndex: number };

type MutationResult = {
  ok?: boolean;
  reason?: string;
  message?: string;
  previousHistoryRevision?: number;
  historyRevision?: number;
  previousHistoryToken?: string;
  historyToken?: string;
  verification?: Record<string, unknown> | null;
};

type TranscriptReplacementHelper = {
  snapshotTranscriptWithNativeBridge: () => Promise<unknown>;
  undoTranscriptWithNativeBridge: (options: Record<string, unknown>) => Promise<MutationResult>;
  createSegmentWithNativeAction: (options: Record<string, unknown>) => Promise<MutationResult>;
  deleteSegmentWithNativeAction: (options: Record<string, unknown>) => Promise<MutationResult>;
};

function hasReplacementCapabilities(value: unknown): value is TranscriptReplacementHelper {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TranscriptReplacementHelper>;
  return (
    typeof candidate.snapshotTranscriptWithNativeBridge === 'function' &&
    typeof candidate.undoTranscriptWithNativeBridge === 'function' &&
    typeof candidate.createSegmentWithNativeAction === 'function' &&
    typeof candidate.deleteSegmentWithNativeAction === 'function'
  );
}

const REQUEST_TYPE = 'babel-gold-drafting:l0-replace-request';
const RESPONSE_TYPE = 'babel-gold-drafting:l0-replace-response';

function response(
  requestId: string,
  ok: boolean,
  details: Omit<ReplacementResponse, 'type' | 'version' | 'requestId' | 'ok'> = {}
): ReplacementResponse {
  return {
    type: RESPONSE_TYPE,
    version: 1,
    requestId,
    ok,
    ...details
  };
}

function failureMessage(prefix: string, result: MutationResult | null | undefined): string {
  const detail = result?.reason || result?.message;
  return detail ? `${prefix}: ${detail}` : prefix;
}

function validateRequest(value: unknown):
  | { ok: true; request: ReplacementRequest }
  | { ok: false; requestId: string; reason: string; message: string } {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const requestId = typeof candidate?.requestId === 'string' ? candidate.requestId : '';
  if (!candidate || candidate.type !== REQUEST_TYPE || candidate.version !== 1) {
    return { ok: false, requestId, reason: 'invalid-request', message: 'Unsupported request type or version.' };
  }
  if (!requestId.trim()) {
    return { ok: false, requestId, reason: 'invalid-request-id', message: 'requestId must be a nonempty string.' };
  }
  if (!Array.isArray(candidate.rows) || candidate.rows.length === 0) {
    return { ok: false, requestId, reason: 'invalid-rows', message: 'rows must be a nonempty array.' };
  }

  const ids = new Set<string>();
  const rows: ReplacementRow[] = [];
  for (let index = 0; index < candidate.rows.length; index += 1) {
    const raw = candidate.rows[index];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, requestId, reason: 'invalid-row', message: `rows[${index}] must be an object.` };
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const lane = typeof row.lane === 'string' ? row.lane.trim() : '';
    const text = typeof row.text === 'string' ? row.text : '';
    const startSeconds = row.startSeconds;
    const endSeconds = row.endSeconds;
    if (!id) {
      return { ok: false, requestId, reason: 'invalid-row-id', message: `rows[${index}].id must be nonempty.` };
    }
    if (ids.has(id)) {
      return { ok: false, requestId, reason: 'duplicate-row-id', message: `Duplicate row id: ${id}.` };
    }
    if (!lane) {
      return { ok: false, requestId, reason: 'invalid-lane', message: `rows[${index}].lane must be nonempty.` };
    }
    if (!text.trim()) {
      return { ok: false, requestId, reason: 'invalid-text', message: `rows[${index}].text must be nonempty.` };
    }
    if (
      typeof startSeconds !== 'number' ||
      typeof endSeconds !== 'number' ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds
    ) {
      return {
        ok: false,
        requestId,
        reason: 'invalid-range',
        message: `rows[${index}] must have a finite nonnegative start and a later end.`
      };
    }
    ids.add(id);
    rows.push({ id, lane, startSeconds, endSeconds, text });
  }
  if (typeof candidate.expectedReviewActionId !== 'string' || !candidate.expectedReviewActionId.trim() ||
      !Array.isArray(candidate.expectedRows) || candidate.expectedRows.some((value) => {
        if (!value || typeof value !== 'object') return true;
        const row = value as Record<string, unknown>;
        return typeof row.rowId !== 'string' || !row.rowId ||
          typeof row.text !== 'string' || typeof row.speakerKey !== 'string' ||
          typeof row.index !== 'number' || !Number.isInteger(row.index) ||
          (row.startSeconds !== null && (typeof row.startSeconds !== 'number' || !Number.isFinite(row.startSeconds))) ||
          (row.endSeconds !== null && (typeof row.endSeconds !== 'number' || !Number.isFinite(row.endSeconds)));
      })) {
    return { ok: false, requestId, reason: 'invalid-expected-snapshot', message: 'The originating native task and complete transcript snapshot are required.' };
  }

  return {
    ok: true,
    request: {
      type: REQUEST_TYPE,
      version: 1,
      requestId,
      rows,
      expectedReviewActionId: candidate.expectedReviewActionId,
      expectedRows: candidate.expectedRows as ReplacementRequest['expectedRows']
    }
  };
}

function snapshotBridgeRow(value: unknown, index: number): SnapshotRow {
  if (!value || typeof value !== 'object') {
    throw new Error(`Current transcript row ${index} is not an object.`);
  }
  const row = value as Record<string, unknown>;
  const annotationId = typeof row.annotationId === 'string' ? row.annotationId.trim() : '';
  const processedRecordingId =
    typeof row.processedRecordingId === 'string' ? row.processedRecordingId.trim() : '';
  const speakerKey = typeof row.speakerKey === 'string' ? row.speakerKey.trim() : '';
  const lane = typeof row.lane === 'string' ? row.lane.trim() : '';
  const trackLabel =
    (typeof row.trackLabel === 'string' ? row.trackLabel.trim() : '') || lane;
  const startText = typeof row.startText === 'string' ? row.startText.trim() : '';
  const endText = typeof row.endText === 'string' ? row.endText.trim() : '';
  const startSeconds = row.startSeconds;
  const endSeconds = row.endSeconds;
  const text = typeof row.text === 'string' ? row.text : null;

  if (!annotationId || !processedRecordingId || !speakerKey || !(lane || trackLabel)) {
    throw new Error(`Current transcript row ${index} has incomplete annotation or speaker identity.`);
  }
  if (!startText || !endText) {
    throw new Error(`Current transcript row ${index} has incomplete timestamp labels.`);
  }
  if (
    typeof startSeconds !== 'number' ||
    typeof endSeconds !== 'number' ||
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    throw new Error(`Current transcript row ${index} has an invalid timestamp range.`);
  }
  if (text === null) {
    throw new Error(`Current transcript row ${index} has no editable transcript text.`);
  }

  return {
    annotationId,
    processedRecordingId,
    speakerKey,
    lane: lane || trackLabel,
    trackLabel,
    startSeconds,
    endSeconds,
    startText,
    endText,
    text,
    rowIdentity: {
      annotationId,
      processedRecordingId,
      speakerKey,
      trackLabel,
      startText,
      endText
    }
  };
}

async function snapshotTranscript(
  helper: TranscriptReplacementHelper,
  allowEmpty = false
): Promise<TranscriptSnapshot> {
  const result = await helper.snapshotTranscriptWithNativeBridge();
  if (!result || typeof result !== 'object') {
    throw new Error('The native transcript snapshot bridge did not respond.');
  }
  const candidate = result as Record<string, unknown>;
  if (candidate.ok !== true || !Array.isArray(candidate.rows)) {
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    throw new Error(message || 'The native transcript snapshot bridge failed.');
  }
  if (!allowEmpty && candidate.rows.length === 0) {
    throw new Error('The current Babel transcript has no rows.');
  }
  const rows = candidate.rows.map((row, index) => snapshotBridgeRow(row, index)) as TranscriptSnapshot;
  if (candidate.readOnly === true) throw new Error('The native transcript is read-only.');
  if (typeof candidate.reviewActionId !== 'string' || !candidate.reviewActionId ||
      !Number.isInteger(candidate.historyRevision) || Number(candidate.historyRevision) < 0 ||
      typeof candidate.historyToken !== 'string' || !candidate.historyToken) {
    throw new Error('The native transcript history is unavailable.');
  }
  rows.reviewActionId = candidate.reviewActionId;
  rows.historyRevision = candidate.historyRevision as number;
  rows.historyToken = candidate.historyToken;
  rows.lanes = [];
  for (const value of Array.isArray(candidate.lanes) ? candidate.lanes : []) {
    if (!value || typeof value !== 'object') continue;
    const lane = value as Record<string, unknown>;
    const id = typeof lane.processedRecordingId === 'string' ? lane.processedRecordingId.trim() : '';
    if (!id) continue;
    rows.lanes.push({
      processedRecordingId: id,
      speakerKey: id,
      lane: typeof lane.lane === 'string' ? lane.lane.trim() : '',
      trackLabel: typeof lane.trackLabel === 'string' ? lane.trackLabel.trim() : ''
    });
  }
  return rows;
}

function laneBindings(snapshot: TranscriptSnapshot): Map<string, LaneBinding | null> {
  const bindings = new Map<string, LaneBinding | null>();
  for (const row of snapshot.lanes || []) {
    const binding = {
      processedRecordingId: row.processedRecordingId,
      speakerKey: row.speakerKey
    };
    for (const alias of [row.trackLabel, row.processedRecordingId]) {
      if (!alias) continue;
      const existing = bindings.get(alias);
      if (
        existing &&
        (existing.processedRecordingId !== binding.processedRecordingId || existing.speakerKey !== binding.speakerKey)
      ) {
        bindings.set(alias, null);
      } else if (!bindings.has(alias)) {
        bindings.set(alias, binding);
      }
    }
  }
  return bindings;
}

function prepareRows(rows: ReplacementRow[], snapshot: TranscriptSnapshot):
  | { ok: true; rows: PreparedRow[] }
  | { ok: false; reason: string; message: string } {
  const bindings = laneBindings(snapshot);
  const prepared: PreparedRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!bindings.has(row.lane)) {
      return { ok: false, reason: 'lane-not-found', message: `No current Babel speaker matches lane: ${row.lane}.` };
    }
    const binding = bindings.get(row.lane);
    if (!binding) {
      return { ok: false, reason: 'lane-ambiguous', message: `Lane maps to multiple Babel speakers: ${row.lane}.` };
    }
    prepared.push({ ...row, ...binding, requestIndex: index });
  }
  prepared.sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds ||
      left.requestIndex - right.requestIndex
  );
  return { ok: true, rows: prepared };
}

function deleteOptions(row: SnapshotRow | (PreparedRow & { annotationId?: string })) {
  return {
    annotationId: 'annotationId' in row ? row.annotationId || '' : '',
    rowIdentity: 'rowIdentity' in row ? row.rowIdentity : undefined,
    processedRecordingId: row.processedRecordingId,
    speakerKey: row.speakerKey,
    startText: 'startText' in row ? row.startText : undefined,
    endText: 'endText' in row ? row.endText : undefined,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds
  };
}

function annotationIdFrom(result: MutationResult): string {
  const verification = result.verification;
  return verification && typeof verification.annotationId === 'string'
    ? verification.annotationId
    : '';
}

async function rollback(
  helper: TranscriptReplacementHelper,
  original: TranscriptSnapshot,
  historyRevision: number,
  historyToken: string,
  isCurrentTask: () => boolean
): Promise<{ errors: string[]; staleTask: boolean }> {
  while (historyRevision > original.historyRevision) {
    if (!isCurrentTask()) return { errors: [], staleTask: true };
    let result: MutationResult;
    try {
      result = await helper.undoTranscriptWithNativeBridge({
        reviewActionId: original.reviewActionId,
        expectedHistoryRevision: historyRevision,
        expectedHistoryToken: historyToken
      });
    } catch {
      return { errors: ['native undo did not respond'], staleTask: !isCurrentTask() };
    }
    if (!isCurrentTask()) return { errors: [], staleTask: true };
    if (!result?.ok || result.previousHistoryRevision !== historyRevision ||
        result.previousHistoryToken !== historyToken || result.historyRevision !== historyRevision - 1 ||
        typeof result.historyToken !== 'string' || !result.historyToken) {
      return { errors: ['native history changed; refusing to undo unrelated edits'], staleTask: false };
    }
    historyRevision = result.historyRevision;
    historyToken = result.historyToken;
  }
  return { errors: historyToken === original.historyToken ? [] : ['native history no longer matches the original snapshot'],
    staleTask: !isCurrentTask() };
}

export async function replaceTranscriptSegmentation(
  helperValue: unknown,
  value: unknown
): Promise<ReplacementResponse> {
  const validation = validateRequest(value);
  if (!validation.ok) {
    return response(validation.requestId, false, {
      reason: validation.reason,
      message: validation.message
    });
  }
  const { request } = validation;
  if (!hasReplacementCapabilities(helperValue)) {
    return response(request.requestId, false, {
      reason: 'service-unavailable',
      message: 'Babel transcript editing services are not ready.'
    });
  }
  const helper = helperValue;
  const isCurrentTask = captureL0TaskGuard({ requireIdentity: true, includeAudioVariant: true });
  const isSameReviewTask = captureL0TaskGuard({ requireIdentity: true });
  const untouchedStaleTaskResponse = () => response(request.requestId, false, {
    reason: 'stale-task',
    message: 'The current task could not be confirmed or changed before transcript replacement began. No transcript changes were made. Reload the task and try again.'
  });

  let original: TranscriptSnapshot;
  try {
    if (!isCurrentTask()) return untouchedStaleTaskResponse();
    original = await snapshotTranscript(helper, true);
  } catch (error) {
    if (!isCurrentTask()) return untouchedStaleTaskResponse();
    return response(request.requestId, false, {
      reason: 'snapshot-invalid',
      message: error instanceof Error ? error.message : 'Could not snapshot the current transcript.'
    });
  }
  if (!isCurrentTask()) return untouchedStaleTaskResponse();
  if (original.reviewActionId !== request.expectedReviewActionId) return untouchedStaleTaskResponse();
  const expectedById = new Map(request.expectedRows.map(row => [row.rowId, row]));
  if (expectedById.size !== request.expectedRows.length || original.length !== expectedById.size ||
      original.some(row => {
        const expected = expectedById.get(row.annotationId);
        return !expected || row.processedRecordingId !== (expected.processedRecordingId || expected.speakerKey) ||
          row.startSeconds !== expected.startSeconds || row.endSeconds !== expected.endSeconds ||
          row.text !== expected.text;
      })) {
    return response(request.requestId, false, { reason: 'stale-transcript', message: 'The transcript changed since this replacement was requested. No transcript changes were made.' });
  }
  const prepared = prepareRows(request.rows, original);
  if (!prepared.ok) {
    return response(request.requestId, false, {
      reason: prepared.reason,
      message: prepared.message
    });
  }

  const created: Array<PreparedRow & { annotationId: string }> = [];
  const deletedOriginalIds = new Set<string>();
  let mutationReason = '';
  let mutationMessage = '';
  let staleTask = false;
  let historyRevision = original.historyRevision;
  let historyToken = original.historyToken;
  let historyConflict = false;
  const recordMutation = (result: MutationResult) => {
    const receipt = result?.verification || result;
    if (result?.reason === 'history-conflict' || result?.reason === 'stale-transcript' ||
        receipt?.previousHistoryRevision !== historyRevision || receipt?.previousHistoryToken !== historyToken ||
        !Number.isInteger(receipt?.historyRevision) ||
        typeof receipt.historyToken !== 'string' || !receipt.historyToken ||
        Number(receipt.historyRevision) < historyRevision ||
        Number(receipt.historyRevision) > historyRevision + 1 ||
        (receipt.historyRevision === historyRevision && receipt.historyToken !== historyToken) ||
        (receipt.historyRevision === historyRevision + 1 && receipt.historyToken === historyToken) ||
        (result?.ok === true && receipt.historyRevision !== historyRevision + 1)) {
      historyConflict = true;
      return;
    }
    historyRevision = Number(receipt.historyRevision);
    historyToken = receipt.historyToken;
  };

  for (let index = original.length - 1; index >= 0 && !staleTask; index -= 1) {
    let result: MutationResult;
    try {
      result = await helper.deleteSegmentWithNativeAction({
        ...deleteOptions(original[index]),
        expectedReviewActionId: original.reviewActionId,
        expectedHistoryRevision: historyRevision,
        expectedHistoryToken: historyToken
      });
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    recordMutation(result);
    if (result?.ok) deletedOriginalIds.add(original[index].annotationId);
    staleTask = !isCurrentTask();
    if (!result?.ok || historyConflict) {
      mutationReason = 'delete-failed';
      mutationMessage = failureMessage(
        `Could not delete original annotation ${original[index].annotationId}`,
        result
      );
      break;
    }
  }

  if (!mutationReason && !staleTask) {
    for (const row of prepared.rows) {
      let result: MutationResult;
      try {
        result = await helper.createSegmentWithNativeAction({
          expectedReviewActionId: original.reviewActionId,
          expectedHistoryRevision: historyRevision,
          expectedHistoryToken: historyToken,
          processedRecordingId: row.processedRecordingId,
          speakerKey: row.speakerKey,
          startSeconds: row.startSeconds,
          endSeconds: row.endSeconds,
          text: row.text
        });
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      recordMutation(result);
      const annotationId = result?.ok ? annotationIdFrom(result) : '';
      if (annotationId) created.push({ ...row, annotationId });
      staleTask = !isCurrentTask();
      if (!result?.ok || !annotationId || historyConflict) {
        mutationReason = 'create-failed';
        mutationMessage = !result?.ok
          ? failureMessage(`Could not create requested row ${row.id}`, result)
          : `Created row ${row.id} did not return an annotation identity.`;
        break;
      }
      if (staleTask) break;
    }
  }

  if (staleTask && !deletedOriginalIds.size && !created.length) {
    return untouchedStaleTaskResponse();
  }

  if (mutationReason || staleTask) {
    const report = historyConflict
      ? { errors: ['native history changed or its mutation receipt is unavailable; refusing to undo unrelated edits'], staleTask: !isSameReviewTask() }
      : await rollback(helper, original, historyRevision, historyToken, isSameReviewTask);
    const outcome = report.errors.length
      ? `Rollback incomplete: ${report.errors.join('; ')}.`
      : 'Original transcript restored.';
    if (report.staleTask) {
      return response(request.requestId, false, {
        reason: 'stale-task',
        message:
          `The task changed during transcript replacement after ${deletedOriginalIds.size} original `
          + `annotation(s) were deleted and ${created.length} created. Rollback stopped when the task changed `
          + `to avoid modifying the new task. The original transcript may be incomplete; return to the original task to review it.`
      });
    }
    return response(request.requestId, false, {
      reason: staleTask ? 'stale-task' : mutationReason,
      message: `${staleTask ? 'The audio selection changed during transcript replacement.' : mutationMessage} ${outcome}`
    });
  }

  const createdByRequestIndex = [...created].sort(
    (left, right) => left.requestIndex - right.requestIndex
  );
  return response(request.requestId, true, {
    created: createdByRequestIndex.map((row) => ({
      id: row.id,
      annotationId: row.annotationId,
      lane: row.lane,
      startSeconds: row.startSeconds,
      endSeconds: row.endSeconds
    }))
  });
}
