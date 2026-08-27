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

type PreparedRow = ReplacementRow & LaneBinding & { requestIndex: number };

type MutationResult = {
  ok?: boolean;
  reason?: string;
  message?: string;
  verification?: Record<string, unknown> | null;
};

type TranscriptReplacementHelper = {
  getTranscriptRows: () => unknown[];
  getRowIdentity: (row: unknown) => Record<string, unknown> | null;
  getRowTextarea: (row: unknown) => { value: string } | null;
  findRowByIdentity?: (identity: Record<string, unknown>) => unknown;
  normalizeText?: (value: unknown) => string;
  setEditableValue: (element: unknown, value: string) => boolean;
  createSegmentWithNativeAction: (options: Record<string, unknown>) => Promise<MutationResult>;
  deleteSegmentWithNativeAction: (options: Record<string, unknown>) => Promise<MutationResult>;
};

function hasReplacementCapabilities(value: unknown): value is TranscriptReplacementHelper {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TranscriptReplacementHelper>;
  return (
    typeof candidate.getTranscriptRows === 'function' &&
    typeof candidate.getRowIdentity === 'function' &&
    typeof candidate.getRowTextarea === 'function' &&
    typeof candidate.createSegmentWithNativeAction === 'function' &&
    typeof candidate.deleteSegmentWithNativeAction === 'function' &&
    typeof candidate.setEditableValue === 'function'
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

  return {
    ok: true,
    request: {
      type: REQUEST_TYPE,
      version: 1,
      requestId,
      rows
    }
  };
}

function parseTimeValue(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const timestamp = normalized.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
  if (timestamp) {
    let total = 0;
    for (const part of timestamp[0].split(':')) {
      const numeric = Number(part);
      if (!Number.isFinite(numeric)) return null;
      total = total * 60 + numeric;
    }
    return total;
  }
  let total = 0;
  let foundUnit = false;
  for (const match of normalized.matchAll(/(-?\d+(?:\.\d+)?)\s*([hms])/g)) {
    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) return null;
    foundUnit = true;
    total += match[2] === 'h' ? numeric * 3600 : match[2] === 'm' ? numeric * 60 : numeric;
  }
  if (foundUnit) return total;
  const numeric = Number(normalized.match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizedText(helper: TranscriptReplacementHelper, value: unknown): string {
  if (typeof helper.normalizeText === 'function') {
    return String(helper.normalizeText(value) || '').trim();
  }
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function childAt(row: unknown, index: number): unknown {
  if (!row || typeof row !== 'object' || !('children' in row)) return undefined;
  const children = row.children;
  if (!children || typeof children !== 'object') return undefined;
  return (children as Record<number, unknown>)[index];
}

function snapshotRow(
  helper: TranscriptReplacementHelper,
  row: unknown,
  index: number
): SnapshotRow {
  const identity = helper.getRowIdentity(row);
  if (!identity || typeof identity !== 'object') {
    throw new Error(`Current transcript row ${index} has no Babel annotation identity.`);
  }
  const annotationId = typeof identity.annotationId === 'string' ? identity.annotationId.trim() : '';
  const processedRecordingId =
    typeof identity.processedRecordingId === 'string' ? identity.processedRecordingId.trim() : '';
  const speakerKey = typeof identity.speakerKey === 'string' ? identity.speakerKey.trim() : '';
  const trackLabel = typeof identity.trackLabel === 'string' ? identity.trackLabel.trim() : '';
  const visibleLane = normalizedText(helper, childAt(row, 1));
  const lane = visibleLane || trackLabel || speakerKey;
  const startText =
    typeof identity.startText === 'string' && identity.startText
      ? identity.startText
      : normalizedText(helper, childAt(row, 2));
  const endText =
    typeof identity.endText === 'string' && identity.endText
      ? identity.endText
      : normalizedText(helper, childAt(row, 3));
  const startSeconds = parseTimeValue(startText);
  const endSeconds = parseTimeValue(endText);
  const textarea = helper.getRowTextarea(row);
  const text = typeof textarea?.value === 'string' ? textarea.value : '';

  if (!annotationId || !processedRecordingId || !speakerKey || !lane) {
    throw new Error(`Current transcript row ${index} has incomplete annotation or speaker identity.`);
  }
  if (startSeconds === null || endSeconds === null || startSeconds < 0 || endSeconds <= startSeconds) {
    throw new Error(`Current transcript row ${index} has an invalid timestamp range.`);
  }
  if (!textarea || typeof textarea.value !== 'string') {
    throw new Error(`Current transcript row ${index} has no editable transcript text.`);
  }

  return {
    annotationId,
    processedRecordingId,
    speakerKey,
    lane,
    trackLabel,
    startSeconds,
    endSeconds,
    startText,
    endText,
    text,
    rowIdentity: { ...identity }
  };
}

function snapshotTranscript(helper: TranscriptReplacementHelper): SnapshotRow[] {
  const rows = helper.getTranscriptRows();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The current Babel transcript has no rows.');
  }
  return rows.map((row: unknown, index: number) => snapshotRow(helper, row, index));
}

function laneBindings(snapshot: SnapshotRow[]): Map<string, LaneBinding | null> {
  const bindings = new Map<string, LaneBinding | null>();
  for (const row of snapshot) {
    const binding = {
      processedRecordingId: row.processedRecordingId,
      speakerKey: row.speakerKey
    };
    for (const alias of new Set([row.lane, row.trackLabel, row.speakerKey, row.processedRecordingId])) {
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

function prepareRows(rows: ReplacementRow[], snapshot: SnapshotRow[]):
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

function findRowByAnnotationId(
  helper: TranscriptReplacementHelper,
  annotationId: string
): unknown | null {
  if (typeof helper.findRowByIdentity === 'function') {
    const found = helper.findRowByIdentity({ annotationId });
    if (found) return found;
  }
  const rows = helper.getTranscriptRows();
  if (!Array.isArray(rows)) return null;
  return (
    rows.find((row: unknown) => helper.getRowIdentity(row)?.annotationId === annotationId) || null
  );
}

function restoreText(helper: TranscriptReplacementHelper, row: SnapshotRow): boolean {
  const current = findRowByAnnotationId(helper, row.annotationId);
  const textarea = current ? helper.getRowTextarea(current) : null;
  return Boolean(textarea && helper.setEditableValue(textarea, row.text));
}

async function rollback(
  helper: TranscriptReplacementHelper,
  original: SnapshotRow[],
  created: Array<PreparedRow & { annotationId: string }>
): Promise<string[]> {
  const errors: string[] = [];
  for (let index = created.length - 1; index >= 0; index -= 1) {
    try {
      await helper.deleteSegmentWithNativeAction(deleteOptions(created[index]));
    } catch {
      // The live transcript scan below retries cleanup by annotation identity.
    }
  }

  const originalIds = new Set(original.map((row) => row.annotationId));
  let currentRows: unknown[] = [];
  try {
    currentRows = helper.getTranscriptRows();
    for (let index = currentRows.length - 1; index >= 0; index -= 1) {
      const identity = helper.getRowIdentity(currentRows[index]);
      const annotationId =
        identity && typeof identity.annotationId === 'string' ? identity.annotationId : '';
      if (!annotationId || originalIds.has(annotationId)) continue;
      try {
        const stray = snapshotRow(helper, currentRows[index], index);
        const result = await helper.deleteSegmentWithNativeAction(deleteOptions(stray));
        if (!result?.ok) errors.push(`could not remove new annotation ${annotationId}`);
      } catch {
        errors.push(`could not remove new annotation ${annotationId}`);
      }
    }
    currentRows = helper.getTranscriptRows();
  } catch {
    errors.push('could not inspect transcript during rollback');
  }

  const present = new Set(
    currentRows
      .map((row) => helper.getRowIdentity(row)?.annotationId)
      .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))
  );
  for (const row of original) {
    if (!present.has(row.annotationId)) {
      let recreated: MutationResult;
      try {
        recreated = await helper.createSegmentWithNativeAction({
          annotationId: row.annotationId,
          processedRecordingId: row.processedRecordingId,
          speakerKey: row.speakerKey,
          startSeconds: row.startSeconds,
          endSeconds: row.endSeconds
        });
      } catch {
        recreated = { ok: false };
      }
      if (!recreated?.ok) {
        errors.push(`could not recreate original annotation ${row.annotationId}`);
        continue;
      }
      present.add(row.annotationId);
    }
    try {
      if (!restoreText(helper, row)) {
        errors.push(`could not restore text for original annotation ${row.annotationId}`);
      }
    } catch {
      errors.push(`could not restore text for original annotation ${row.annotationId}`);
    }
  }
  return errors;
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

  let original: SnapshotRow[];
  try {
    original = snapshotTranscript(helper);
  } catch (error) {
    return response(request.requestId, false, {
      reason: 'snapshot-invalid',
      message: error instanceof Error ? error.message : 'Could not snapshot the current transcript.'
    });
  }
  const prepared = prepareRows(request.rows, original);
  if (!prepared.ok) {
    return response(request.requestId, false, {
      reason: prepared.reason,
      message: prepared.message
    });
  }

  const created: Array<PreparedRow & { annotationId: string }> = [];
  let mutationReason = '';
  let mutationMessage = '';

  for (let index = original.length - 1; index >= 0; index -= 1) {
    let result: MutationResult;
    try {
      result = await helper.deleteSegmentWithNativeAction(deleteOptions(original[index]));
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!result?.ok) {
      mutationReason = 'delete-failed';
      mutationMessage = failureMessage(
        `Could not delete original annotation ${original[index].annotationId}`,
        result
      );
      break;
    }
  }

  if (!mutationReason) {
    for (const row of prepared.rows) {
      let result: MutationResult;
      try {
        result = await helper.createSegmentWithNativeAction({
          processedRecordingId: row.processedRecordingId,
          speakerKey: row.speakerKey,
          startSeconds: row.startSeconds,
          endSeconds: row.endSeconds
        });
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      const annotationId = result?.ok ? annotationIdFrom(result) : '';
      if (!result?.ok || !annotationId) {
        mutationReason = 'create-failed';
        mutationMessage = !result?.ok
          ? failureMessage(`Could not create requested row ${row.id}`, result)
          : `Created row ${row.id} did not return an annotation identity.`;
        break;
      }
      created.push({ ...row, annotationId });
    }
  }

  if (mutationReason) {
    const rollbackErrors = await rollback(helper, original, created);
    if (rollbackErrors.length) {
      mutationMessage += ` Rollback incomplete: ${rollbackErrors.join('; ')}.`;
    } else {
      mutationMessage += ' Original transcript restored.';
    }
    return response(request.requestId, false, {
      reason: mutationReason,
      message: mutationMessage
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
