export interface AutoTrimBoundaryClampInput {
  side: 'left' | 'right';
  currentStartSeconds: number;
  currentEndSeconds: number;
  suggestedSeconds: number;
  previousEndSeconds?: number | null;
  nextStartSeconds?: number | null;
  minGapSeconds?: number;
  minDeltaMs?: number;
}

export interface AutoTrimBoundaryClampResult {
  ok: boolean;
  targetSeconds: number | null;
  reason: string;
  deltaMs: number;
  clamped: boolean;
  outwardDeltaMs: number;
  inwardDeltaMs: number;
}

export interface AutoTrimResultSummary {
  rowsProcessed: number;
  trimmed: number;
  boundariesTrimmed: number;
  skippedLowConfidence: number;
  skippedNoAudio: number;
  failedWrite: number;
  skippedNoop: number;
  skippedInvalid: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function collectVisibleAutoTrimEntries<T>(
  rows: T[],
  isVisible: (row: T) => boolean,
  getIdentity: (row: T) => unknown
) {
  const entries: Array<{ row: T; identity: unknown }> = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isVisible(row)) {
      continue;
    }

    const identity = getIdentity(row);
    if (!identity || typeof identity !== 'object') {
      continue;
    }

    entries.push({ row, identity });
  }

  return entries;
}

export function clampAutoTrimBoundaryTarget(
  input: AutoTrimBoundaryClampInput
): AutoTrimBoundaryClampResult {
  const side = input.side === 'left' ? 'left' : 'right';
  const currentStartSeconds = Number(input.currentStartSeconds);
  const currentEndSeconds = Number(input.currentEndSeconds);
  const suggestedSeconds = Number(input.suggestedSeconds);
  const minGapSeconds = Math.max(0.001, Number(input.minGapSeconds) || 0.01);
  const minDeltaMs = Math.max(0, Number(input.minDeltaMs) || 0);

  if (
    !Number.isFinite(currentStartSeconds) ||
    !Number.isFinite(currentEndSeconds) ||
    !(currentEndSeconds > currentStartSeconds) ||
    !Number.isFinite(suggestedSeconds)
  ) {
    return {
      ok: false,
      targetSeconds: null,
      reason: 'invalid-range',
      deltaMs: 0,
      clamped: false,
      outwardDeltaMs: 0,
      inwardDeltaMs: 0
    };
  }

  const currentBoundarySeconds = side === 'left' ? currentStartSeconds : currentEndSeconds;
  const minAllowed =
    side === 'left'
      ? Number.isFinite(Number(input.previousEndSeconds))
        ? Number(input.previousEndSeconds) + minGapSeconds
        : 0
      : currentStartSeconds + minGapSeconds;
  const maxAllowed =
    side === 'left'
      ? currentEndSeconds - minGapSeconds
      : Number.isFinite(Number(input.nextStartSeconds))
        ? Number(input.nextStartSeconds) - minGapSeconds
        : Number.POSITIVE_INFINITY;

  if (!(maxAllowed > minAllowed)) {
    return {
      ok: false,
      targetSeconds: null,
      reason: 'invalid-neighbor-gap',
      deltaMs: 0,
      clamped: false,
      outwardDeltaMs: 0,
      inwardDeltaMs: 0
    };
  }

  const targetSeconds = clamp(suggestedSeconds, minAllowed, maxAllowed);
  const deltaMs = Math.abs(targetSeconds - currentBoundarySeconds) * 1000;
  const clamped = Math.abs(targetSeconds - suggestedSeconds) > 0.0005;
  const outwardDeltaMs =
    side === 'left'
      ? Math.max(0, (currentBoundarySeconds - targetSeconds) * 1000)
      : Math.max(0, (targetSeconds - currentBoundarySeconds) * 1000);
  const inwardDeltaMs =
    side === 'left'
      ? Math.max(0, (targetSeconds - currentBoundarySeconds) * 1000)
      : Math.max(0, (currentBoundarySeconds - targetSeconds) * 1000);

  if (deltaMs < minDeltaMs) {
    return {
      ok: false,
      targetSeconds,
      reason: 'below-min-delta',
      deltaMs,
      clamped,
      outwardDeltaMs,
      inwardDeltaMs
    };
  }

  return {
    ok: true,
    targetSeconds,
    reason: clamped ? 'clamped-to-neighbor' : 'ok',
    deltaMs,
    clamped,
    outwardDeltaMs,
    inwardDeltaMs
  };
}

export function summarizeAutoTrimResults(
  results: Array<{ status: string; boundariesTrimmed?: number }>
): AutoTrimResultSummary {
  const summary: AutoTrimResultSummary = {
    rowsProcessed: 0,
    trimmed: 0,
    boundariesTrimmed: 0,
    skippedLowConfidence: 0,
    skippedNoAudio: 0,
    failedWrite: 0,
    skippedNoop: 0,
    skippedInvalid: 0
  };

  for (const result of Array.isArray(results) ? results : []) {
    summary.rowsProcessed += 1;
    summary.boundariesTrimmed += Math.max(0, Number(result?.boundariesTrimmed) || 0);

    switch (result?.status) {
      case 'trimmed':
        summary.trimmed += 1;
        break;
      case 'skipped-low-confidence':
        summary.skippedLowConfidence += 1;
        break;
      case 'skipped-no-audio':
        summary.skippedNoAudio += 1;
        break;
      case 'failed-write':
        summary.failedWrite += 1;
        break;
      case 'skipped-noop':
        summary.skippedNoop += 1;
        break;
      default:
        summary.skippedInvalid += 1;
        break;
    }
  }

  return summary;
}
