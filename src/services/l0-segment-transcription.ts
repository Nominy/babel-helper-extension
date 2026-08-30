export type L0SegmentBrokerRequest =
  | {
      operation: 'ping';
    }
  | {
      operation: 'transcribeSegmentL0';
      taskId: string;
      row: {
        rowId: string;
        speakerKey: string;
        startSeconds: number;
        endSeconds: number;
        text: '';
        index: number;
      };
    };

type L0SegmentBrokerResult = {
  ok?: unknown;
  reason?: unknown;
  message?: unknown;
  fallbackAllowed?: unknown;
  capabilities?: {
    transcribeSegmentL0?: unknown;
    [key: string]: unknown;
  } | null;
  result?: { text?: unknown } | null;
  [key: string]: unknown;
};

export type L0SegmentTranscriptionOptions<Row, Identity> = {
  taskId: string;
  rowIdentity: Identity;
  rowId: string;
  speakerKey: string;
  startSeconds: number;
  endSeconds: number;
  index: number;
  request: (request: L0SegmentBrokerRequest) => Promise<L0SegmentBrokerResult | null>;
  getCurrentTaskId: () => string;
  resolveCurrentRow: (identity: Identity) => Row | null;
  isRowEmpty: (row: Row) => boolean;
  writeRowText: (row: Row, text: string) => boolean;
};

export function capitalizeFirstL0TranscriptLetter(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase());
}

export function hasL0SegmentBrokerCapability(response: L0SegmentBrokerResult | null): boolean {
  return (
    response?.ok === true &&
    response.capabilities?.transcribeSegmentL0 === true
  );
}

export function isL0SegmentLegacyFallbackAllowed(result: Record<string, unknown> | null): boolean {
  return result?.fallbackAllowed !== false;
}

export async function transcribeEmptySegmentWithL0<Row, Identity>(
  options: L0SegmentTranscriptionOptions<Row, Identity>
): Promise<Record<string, unknown>> {
  const availability = await options.request({ operation: 'ping' });
  if (!hasL0SegmentBrokerCapability(availability)) {
    return {
      ok: false,
      reason: 'l0-provider-unavailable',
      fallbackAllowed: false,
      broker: availability
    };
  }

  const response = await options.request({
    operation: 'transcribeSegmentL0',
    taskId: options.taskId,
    row: {
      rowId: options.rowId,
      speakerKey: options.speakerKey,
      startSeconds: options.startSeconds,
      endSeconds: options.endSeconds,
      text: '',
      index: options.index
    }
  });

  if (options.getCurrentTaskId() !== options.taskId) {
    return { ok: false, reason: 'task-changed' };
  }
  const row = options.resolveCurrentRow(options.rowIdentity);
  if (!row) return { ok: false, reason: 'segment-no-longer-current' };
  if (!options.isRowEmpty(row)) return { ok: false, reason: 'segment-no-longer-empty' };

  if (!response || response.ok !== true) {
    const failure: Record<string, unknown> = {
      ok: false,
      reason:
        response && typeof response.reason === 'string' && response.reason.trim()
          ? response.reason.trim()
          : 'l0-transcription-failed',
      broker: response
    };
    if (typeof response?.fallbackAllowed === 'boolean') {
      failure.fallbackAllowed = response.fallbackAllowed;
    }
    return failure;
  }

  const text = capitalizeFirstL0TranscriptLetter(response.result?.text);
  if (!text) {
    return { ok: false, reason: 'empty-transcription', broker: response };
  }
  if (!options.writeRowText(row, text)) {
    return { ok: false, reason: 'transcription-write-failed' };
  }

  return { ok: true, changed: true, textLength: text.length };
}
