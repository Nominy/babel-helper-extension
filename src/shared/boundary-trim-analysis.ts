export type BoundaryTrimConfidence = 'high' | 'low' | 'none';

export interface BoundaryTrimEnvelopeInput {
  side: 'left' | 'right';
  boundarySeconds: number;
  windowStartSeconds: number;
  stepSeconds: number;
  values: number[];
  paddingMs: number;
  maxOutwardMs: number;
  source?: 'decoded' | 'peaks' | 'unknown';
}

export interface BoundaryTrimSuggestion {
  ok: boolean;
  suggestedSeconds: number | null;
  confidence: BoundaryTrimConfidence;
  reason: string;
  detectedSpeechSeconds: number | null;
  paddingMs: number;
  outwardDeltaMs: number;
  inwardDeltaMs: number;
  source: 'decoded' | 'peaks' | 'unknown';
  stepMs: number;
}

type BoundaryTrimSource = BoundaryTrimSuggestion['source'];

interface SpeechRun {
  startIndex: number;
  endIndex: number;
  peak: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function quantile(values: number[], fraction: number) {
  if (!Array.isArray(values) || !values.length) {
    return 0;
  }

  const sorted = values.slice().sort((left, right) => left - right);
  const lastIndex = sorted.length - 1;
  const clampedFraction = clamp(fraction, 0, 1);
  const position = clampedFraction * lastIndex;
  const leftIndex = Math.floor(position);
  const rightIndex = Math.min(lastIndex, leftIndex + 1);
  const weight = position - leftIndex;
  return sorted[leftIndex] * (1 - weight) + sorted[rightIndex] * weight;
}

function smoothEnvelope(values: number[], radius = 2) {
  if (!Array.isArray(values) || !values.length) {
    return [];
  }

  const out = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    let total = 0;
    let count = 0;
    for (
      let pointer = Math.max(0, index - radius);
      pointer <= Math.min(values.length - 1, index + radius);
      pointer += 1
    ) {
      total += Number(values[pointer]) || 0;
      count += 1;
    }
    out[index] = count > 0 ? total / count : 0;
  }

  return out;
}

function buildSpeechRuns(
  values: number[],
  threshold: number,
  minRunBins: number,
  mergeGapBins: number
) {
  const rawRuns: SpeechRun[] = [];
  let runStart = -1;
  let runPeak = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]) || 0;
    if (value >= threshold) {
      if (runStart < 0) {
        runStart = index;
        runPeak = value;
      } else if (value > runPeak) {
        runPeak = value;
      }
      continue;
    }

    if (runStart >= 0) {
      rawRuns.push({
        startIndex: runStart,
        endIndex: index,
        peak: runPeak
      });
      runStart = -1;
      runPeak = 0;
    }
  }

  if (runStart >= 0) {
    rawRuns.push({
      startIndex: runStart,
      endIndex: values.length,
      peak: runPeak
    });
  }

  if (!rawRuns.length) {
    return [];
  }

  const merged: SpeechRun[] = [];
  for (const run of rawRuns) {
    const previous = merged[merged.length - 1];
    if (previous && run.startIndex - previous.endIndex <= mergeGapBins) {
      previous.endIndex = run.endIndex;
      previous.peak = Math.max(previous.peak, run.peak);
      continue;
    }

    merged.push({ ...run });
  }

  return merged.filter((run) => run.endIndex - run.startIndex >= minRunBins);
}

function getRunDistanceBins(run: SpeechRun, boundaryIndex: number) {
  if (boundaryIndex < run.startIndex) {
    return run.startIndex - boundaryIndex;
  }

  if (boundaryIndex > run.endIndex) {
    return boundaryIndex - run.endIndex;
  }

  return 0;
}

function getRunTimeStart(run: SpeechRun, windowStartSeconds: number, stepSeconds: number) {
  return windowStartSeconds + run.startIndex * stepSeconds;
}

function getRunTimeEnd(run: SpeechRun, windowStartSeconds: number, stepSeconds: number) {
  return windowStartSeconds + run.endIndex * stepSeconds;
}

function getSilenceBinsBeforeRun(
  values: number[],
  run: SpeechRun,
  silenceThreshold: number
) {
  let bins = 0;
  for (let index = run.startIndex - 1; index >= 0; index -= 1) {
    if ((Number(values[index]) || 0) > silenceThreshold) {
      break;
    }
    bins += 1;
  }
  return bins;
}

function getSilenceBinsAfterRun(
  values: number[],
  run: SpeechRun,
  silenceThreshold: number
) {
  let bins = 0;
  for (let index = run.endIndex; index < values.length; index += 1) {
    if ((Number(values[index]) || 0) > silenceThreshold) {
      break;
    }
    bins += 1;
  }
  return bins;
}

export function analyzeBoundaryTrimEnvelope(
  input: BoundaryTrimEnvelopeInput
): BoundaryTrimSuggestion {
  const side = input.side === 'left' ? 'left' : 'right';
  const source: BoundaryTrimSource =
    input.source === 'decoded' || input.source === 'peaks' ? input.source : 'unknown';
  const boundarySeconds = Number(input.boundarySeconds);
  const windowStartSeconds = Number(input.windowStartSeconds);
  const stepSeconds = Number(input.stepSeconds);
  const paddingMs = Math.max(0, Number(input.paddingMs) || 0);
  const maxOutwardMs = Math.max(0, Number(input.maxOutwardMs) || 0);
  const rawValues = Array.isArray(input.values)
    ? input.values.map((value) => Math.max(0, Number(value) || 0))
    : [];

  const emptyResult = (reason: string, confidence: BoundaryTrimConfidence = 'none') => ({
    ok: true,
    suggestedSeconds: null,
    confidence,
    reason,
    detectedSpeechSeconds: null,
    paddingMs,
    outwardDeltaMs: 0,
    inwardDeltaMs: 0,
    source,
    stepMs: stepSeconds > 0 ? stepSeconds * 1000 : 0
  });

  if (!Number.isFinite(boundarySeconds) || !Number.isFinite(windowStartSeconds) || !(stepSeconds > 0)) {
    return emptyResult('invalid-input');
  }

  if (rawValues.length < 8) {
    return emptyResult('insufficient-window');
  }

  const stepMs = stepSeconds * 1000;
  if (stepMs > 60) {
    return emptyResult('coarse-resolution');
  }

  const smoothed = smoothEnvelope(rawValues, 2);
  const peak = smoothed.reduce((max, value) => Math.max(max, Number(value) || 0), 0);
  if (!(peak > 0.0001)) {
    return emptyResult('no-signal');
  }

  const floor = quantile(smoothed, 0.2);
  const dynamicRange = Math.max(0, peak - floor);
  if (dynamicRange < Math.max(peak * 0.14, 0.006)) {
    return emptyResult('low-dynamic-range');
  }

  const speechThreshold =
    floor + dynamicRange * (source === 'peaks' ? 0.4 : 0.25);
  const silenceThreshold = floor + dynamicRange * 0.12;
  const minSpeechRunMs = source === 'peaks' ? 28 : 20;
  const minSilenceRunMs = source === 'peaks' ? 18 : 12;
  const minSpeechRunBins = Math.max(2, Math.ceil(minSpeechRunMs / stepMs));
  const mergeGapBins = Math.max(1, Math.ceil(12 / stepMs));
  const boundaryIndex = (boundarySeconds - windowStartSeconds) / stepSeconds;
  const runs = buildSpeechRuns(smoothed, speechThreshold, minSpeechRunBins, mergeGapBins);

  if (!runs.length) {
    return emptyResult('no-speech');
  }

  const nearestRun = runs
    .slice()
    .sort((left, right) => {
      const distanceDelta =
        getRunDistanceBins(left, boundaryIndex) - getRunDistanceBins(right, boundaryIndex);
      if (distanceDelta !== 0) {
        return distanceDelta;
      }
      return left.startIndex - right.startIndex;
    })[0];

  const detectedSpeechSeconds =
    side === 'left'
      ? getRunTimeStart(nearestRun, windowStartSeconds, stepSeconds)
      : getRunTimeEnd(nearestRun, windowStartSeconds, stepSeconds);
  const paddingSeconds = paddingMs / 1000;
  const unclampedSuggestedSeconds =
    side === 'left'
      ? detectedSpeechSeconds - paddingSeconds
      : detectedSpeechSeconds + paddingSeconds;
  const maxOutwardSeconds = maxOutwardMs / 1000;
  const suggestedSeconds =
    side === 'left'
      ? Math.max(unclampedSuggestedSeconds, boundarySeconds - maxOutwardSeconds)
      : Math.min(unclampedSuggestedSeconds, boundarySeconds + maxOutwardSeconds);
  const outwardDeltaMs =
    side === 'left'
      ? Math.max(0, (boundarySeconds - suggestedSeconds) * 1000)
      : Math.max(0, (suggestedSeconds - boundarySeconds) * 1000);
  const inwardDeltaMs =
    side === 'left'
      ? Math.max(0, (suggestedSeconds - boundarySeconds) * 1000)
      : Math.max(0, (boundarySeconds - suggestedSeconds) * 1000);
  const runSpeechMs = (nearestRun.endIndex - nearestRun.startIndex) * stepMs;
  const silenceBeforeMs = getSilenceBinsBeforeRun(smoothed, nearestRun, silenceThreshold) * stepMs;
  const silenceAfterMs = getSilenceBinsAfterRun(smoothed, nearestRun, silenceThreshold) * stepMs;
  const runStartSeconds = getRunTimeStart(nearestRun, windowStartSeconds, stepSeconds);
  const runEndSeconds = getRunTimeEnd(nearestRun, windowStartSeconds, stepSeconds);

  if (outwardDeltaMs < 0.5 && inwardDeltaMs < 0.5) {
    return emptyResult('already-aligned', 'low');
  }

  if (runSpeechMs < minSpeechRunMs) {
    return {
      ok: true,
      suggestedSeconds,
      confidence: 'low',
      reason: 'short-speech-run',
      detectedSpeechSeconds,
      paddingMs,
      outwardDeltaMs,
      inwardDeltaMs,
      source,
      stepMs
    };
  }

  const isOutwardMove = outwardDeltaMs > 0.5;
  if (isOutwardMove) {
    const touchesBoundary =
      side === 'left'
        ? runStartSeconds <= boundarySeconds + stepSeconds &&
          runEndSeconds >= boundarySeconds - 0.02
        : runEndSeconds >= boundarySeconds - stepSeconds &&
          runStartSeconds <= boundarySeconds + 0.02;

    const confidence: BoundaryTrimConfidence =
      touchesBoundary && outwardDeltaMs <= maxOutwardMs + 0.5 ? 'high' : 'low';
    return {
      ok: true,
      suggestedSeconds,
      confidence,
      reason: confidence === 'high' ? 'speech-clipped-near-boundary' : 'outward-ambiguous',
      detectedSpeechSeconds,
      paddingMs,
      outwardDeltaMs,
      inwardDeltaMs,
      source,
      stepMs
    };
  }

  const confidence: BoundaryTrimConfidence =
    (() => {
      const gapFromBoundaryMs =
        side === 'left'
          ? Math.max(0, (detectedSpeechSeconds - boundarySeconds) * 1000)
          : Math.max(0, (boundarySeconds - detectedSpeechSeconds) * 1000);
      if (gapFromBoundaryMs >= paddingMs + 8) {
        return 'high';
      }

      if (side === 'left') {
        return silenceBeforeMs >= minSilenceRunMs ? 'high' : 'low';
      }

      return silenceAfterMs >= minSilenceRunMs ? 'high' : 'low';
    })();

  return {
    ok: true,
    suggestedSeconds,
    confidence,
    reason:
      confidence === 'high'
        ? side === 'left'
          ? 'leading-silence-detected'
          : 'trailing-silence-detected'
        : side === 'left'
          ? 'leading-boundary-ambiguous'
          : 'trailing-boundary-ambiguous',
    detectedSpeechSeconds,
    paddingMs,
    outwardDeltaMs,
    inwardDeltaMs,
    source,
    stepMs
  };
}
