// @ts-nocheck
import { parseTimeValue } from '../hooks/parsing';
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerAudioTrim(helper: any, api: Pick<TimelineModules, 'loop' | 'site' | 'segmentation' | 'progress'>) {
  const AUDIO_TRIM_INWARD_THRESHOLD = Math.pow(10, -62 / 20);

  const AUDIO_TRIM_OUTWARD_THRESHOLD = Math.pow(10, -62 / 20);

  const AUDIO_TRIM_OUTWARD_STEP_SECONDS = 0.05;

  const AUDIO_TRIM_PADDING_SECONDS = 0.005;

  const AUDIO_TRIM_EPSILON_SECONDS = 0.0015;

  const AUDIO_TRIM_NEIGHBOR_GUARD_SECONDS = 0.01;


  function getAudioTrimAmplitudeThreshold(options, fallback) {
    const value = Number(options && options.amplitudeThreshold);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }


  function getTrimProgressLabel(options) {
    const label = options && typeof options.progressLabel === 'string' ? options.progressLabel.trim() : '';
    return label || 'Trimming visible segments';
  }


  async function requestTrimTargetsForContainer(container, entry, options) {
    if (!(container instanceof HTMLElement) || !entry) {
      return null;
    }

    const hostMarker = api.loop.ensureSelectionHostMarker(container);
    if (!hostMarker) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return api.site.callSelectionBridge('trim-segment-audio', {
      hostMarker,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_INWARD_THRESHOLD),
      paddingSeconds: AUDIO_TRIM_PADDING_SECONDS
    });
  }


  async function requestTrimTargetsForSpeaker(speakerKey, entry, options) {
    if (!entry) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return api.site.callSelectionBridge('trim-segment-audio-for-speaker', {
      speakerKey,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_INWARD_THRESHOLD),
      paddingSeconds: AUDIO_TRIM_PADDING_SECONDS
    });
  }


  async function requestTrimTargets(target, labels, speakerKey, options) {
    const primary =
      target && target.container instanceof HTMLElement && target.entry
        ? await requestTrimTargetsForContainer(target.container, target.entry, options)
        : null;
    if (primary && primary.ok) {
      return primary;
    }

    const fallbackEntry =
      target && target.entry
        ? target.entry
        : labels && labels.startText && labels.endText
          ? labels
          : null;
    const fallback = await requestTrimTargetsForSpeaker(speakerKey, fallbackEntry, options);
    return fallback || primary;
  }


  async function requestExtendTargetsForContainer(container, entry, options) {
    if (!(container instanceof HTMLElement) || !entry) {
      return null;
    }

    const hostMarker = api.loop.ensureSelectionHostMarker(container);
    if (!hostMarker) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return api.site.callSelectionBridge('extend-segment-audio-to-silence', {
      hostMarker,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_OUTWARD_THRESHOLD),
      stepSeconds: AUDIO_TRIM_OUTWARD_STEP_SECONDS
    });
  }


  async function requestExtendTargetsForSpeaker(speakerKey, entry, options) {
    if (!entry) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return api.site.callSelectionBridge('extend-segment-audio-to-silence-for-speaker', {
      speakerKey,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_OUTWARD_THRESHOLD),
      stepSeconds: AUDIO_TRIM_OUTWARD_STEP_SECONDS
    });
  }


  async function requestExtendTargets(target, labels, speakerKey, options) {
    const primary =
      target && target.container instanceof HTMLElement && target.entry
        ? await requestExtendTargetsForContainer(target.container, target.entry, options)
        : null;
    if (primary && primary.ok) {
      return primary;
    }

    const fallbackEntry =
      target && target.entry
        ? target.entry
        : labels && labels.startText && labels.endText
          ? labels
          : null;
    const fallback = await requestExtendTargetsForSpeaker(speakerKey, fallbackEntry, options);
    return fallback || primary;
  }


  async function moveSegmentBoundary(side, labels, speakerKey, targetSeconds, row) {
    const rowIdentity =
      row instanceof HTMLTableRowElement && typeof helper.getRowIdentity === 'function'
        ? helper.getRowIdentity(row)
        : null;
    return helper.setSegmentBoundaryTime({
      side,
      startText: labels.startText,
      endText: labels.endText,
      startSeconds: parseTimeValue(labels.startText),
      endSeconds: parseTimeValue(labels.endText),
      speakerKey,
      targetSeconds,
      annotationId:
        rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '',
      rowIdentity,
      attempts: 2,
      retryDelayMs: 70
    });
  }


  function getCurrentMoveLabels(row, fallbackLabels) {
    return api.site.getRowTimeLabels(row) || fallbackLabels;
  }


  function getSameSpeakerBoundaryNeighborLimits(row, speakerKey) {
    if (!(row instanceof HTMLTableRowElement)) {
      return {
        minStartSeconds: null,
        maxEndSeconds: null
      };
    }

    const targetSpeakerKey =
      (typeof speakerKey === 'string' && speakerKey) || helper.getRowSpeakerKey(row);
    if (!targetSpeakerKey) {
      return {
        minStartSeconds: null,
        maxEndSeconds: null
      };
    }

    const sameSpeakerRows = helper
      .getTranscriptRows()
      .filter(
        (candidate) =>
          candidate instanceof HTMLTableRowElement &&
          candidate.isConnected &&
          helper.getRowSpeakerKey(candidate) === targetSpeakerKey
      );
    const rowIndex = sameSpeakerRows.indexOf(row);
    if (rowIndex < 0) {
      return {
        minStartSeconds: null,
        maxEndSeconds: null
      };
    }

    let minStartSeconds = null;
    for (let index = rowIndex - 1; index >= 0; index -= 1) {
      const previousRange = api.site.getRowTimeRange(sameSpeakerRows[index]);
      if (previousRange && Number.isFinite(previousRange.endSeconds)) {
        minStartSeconds = previousRange.endSeconds + AUDIO_TRIM_NEIGHBOR_GUARD_SECONDS;
        break;
      }
    }

    let maxEndSeconds = null;
    for (let index = rowIndex + 1; index < sameSpeakerRows.length; index += 1) {
      const nextRange = api.site.getRowTimeRange(sameSpeakerRows[index]);
      if (nextRange && Number.isFinite(nextRange.startSeconds)) {
        maxEndSeconds = nextRange.startSeconds - AUDIO_TRIM_NEIGHBOR_GUARD_SECONDS;
        break;
      }
    }

    return {
      minStartSeconds,
      maxEndSeconds
    };
  }


  function capOutwardBoundaryTarget(row, side, speakerKey, targetSeconds) {
    if (!Number.isFinite(targetSeconds)) {
      return targetSeconds;
    }

    const limits = getSameSpeakerBoundaryNeighborLimits(row, speakerKey);
    if (side === 'right' && Number.isFinite(limits.maxEndSeconds)) {
      return Math.min(targetSeconds, limits.maxEndSeconds);
    }

    if (side === 'left' && Number.isFinite(limits.minStartSeconds)) {
      return Math.max(targetSeconds, limits.minStartSeconds);
    }

    return targetSeconds;
  }


  async function applyInwardTrimToRow(row, speakerKey, trimBridgeResult) {
    let labels = api.site.getRowTimeLabels(row);
    const rowRange = api.site.getRowTimeRange(row);
    if (!labels || !rowRange || !trimBridgeResult || !trimBridgeResult.ok || !trimBridgeResult.foundAudio) {
      return { ok: true, changed: false };
    }

    let leftChanged = false;
    let rightChanged = false;
    const nextEndSeconds = Number(trimBridgeResult.targetEndSeconds);
    const nextStartSeconds = Number(trimBridgeResult.targetStartSeconds);

    if (
      Number.isFinite(nextEndSeconds) &&
      nextEndSeconds < rowRange.endSeconds - AUDIO_TRIM_EPSILON_SECONDS &&
      nextEndSeconds > rowRange.startSeconds + AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedRight = await moveSegmentBoundary('right', labels, speakerKey, nextEndSeconds, row);
      if (!movedRight || !movedRight.ok) {
        return { ok: false, reason: 'right-trim-failed' };
      }
      rightChanged = true;
      labels = getCurrentMoveLabels(row, labels);
      await helper.sleep(32);
    }

    if (
      Number.isFinite(nextStartSeconds) &&
      nextStartSeconds > rowRange.startSeconds + AUDIO_TRIM_EPSILON_SECONDS &&
      nextStartSeconds < rowRange.endSeconds - AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedLeft = await moveSegmentBoundary('left', getCurrentMoveLabels(row, labels), speakerKey, nextStartSeconds, row);
      if (!movedLeft || !movedLeft.ok) {
        return { ok: false, reason: 'left-trim-failed' };
      }
      leftChanged = true;
    }

    return {
      ok: true,
      changed: leftChanged || rightChanged,
      leftChanged,
      rightChanged
    };
  }


  async function requestTrimTargetsForRow(row, speakerKey, options) {
    const labels = api.site.getRowTimeLabels(row);
    if (!labels) {
      return null;
    }

    return requestTrimTargetsForSpeaker(speakerKey, labels, options);
  }


  async function trimSegmentTarget(target, options) {
    if (!target || !target.entry) {
      return { ok: false, reason: 'missing-target' };
    }

    const speakerKey =
      typeof target.speakerKey === 'string'
        ? target.speakerKey
        : target.row instanceof HTMLTableRowElement
          ? helper.getRowSpeakerKey(target.row)
          : '';
    const entryStartSeconds = parseTimeValue(target.entry.startText);
    const entryEndSeconds = parseTimeValue(target.entry.endText);
    const row =
      api.site.findRowByTimeLabels(target.entry.startText, target.entry.endText, {
        speakerKey
      }) ||
      (Number.isFinite(entryStartSeconds) &&
        Number.isFinite(entryEndSeconds) &&
        entryEndSeconds > entryStartSeconds
        ? api.site.findRowByTimeRange(entryStartSeconds, entryEndSeconds, {
          speakerKey
        })
        : null) ||
      (target.row instanceof HTMLTableRowElement ? target.row : null);
    if (!(row instanceof HTMLTableRowElement)) {
      return { ok: false, reason: 'missing-row' };
    }

    let labels = api.site.getRowTimeLabels(row);
    const rowRange = api.site.getRowTimeRange(row);
    if (!labels || !rowRange) {
      return { ok: false, reason: 'missing-row-range' };
    }

    const liveEntry =
      target.container instanceof HTMLElement && target.container.isConnected
        ? api.site.findRegionEntryForRow(row, target.container)
        : null;
    const liveTarget = {
      ...target,
      row,
      entry: liveEntry || labels
    };
    if (helper.state.currentTimelineTarget && helper.state.currentTimelineTarget.row === row) {
      helper.state.currentTimelineTarget.startText = labels.startText;
      helper.state.currentTimelineTarget.endText = labels.endText;
    }

    const trimResult = await requestTrimTargets(liveTarget, labels, speakerKey, options);
    if (!trimResult || !trimResult.ok) {
      return { ok: false, reason: 'bridge-failed', bridge: trimResult || null };
    }

    if (!trimResult.foundAudio) {
      return { ok: true, changed: false, reason: 'no-audio-above-threshold' };
    }

    let changed = false;
    const inwardMove = await applyInwardTrimToRow(row, speakerKey, trimResult);
    if (!inwardMove || !inwardMove.ok) {
      return {
        ok: false,
        reason: inwardMove && inwardMove.reason ? inwardMove.reason : 'trim-failed',
        bridge: trimResult
      };
    }
    changed = Boolean(inwardMove.changed);
    const shouldExtendLeft = !inwardMove.leftChanged;
    const shouldExtendRight = !inwardMove.rightChanged;

    if (!shouldExtendLeft && !shouldExtendRight) {
      return {
        ok: true,
        changed,
        trim: trimResult
      };
    }

    if (!api.site.isFeatureEnabled('audioTrimOutwardPass')) {
      return {
        ok: true,
        changed,
        trim: trimResult,
        extend: { ok: false, reason: 'outward-pass-disabled' }
      };
    }

    labels = getCurrentMoveLabels(row, labels);
    liveTarget.entry = labels;
    const extendResult = await requestExtendTargets(liveTarget, labels, speakerKey, options);
    if (!extendResult || !extendResult.ok) {
      return {
        ok: true,
        changed: false,
        trim: trimResult,
        extend: extendResult || null
      };
    }

    const extendStartSeconds = Number(extendResult.targetStartSeconds);
    const extendEndSeconds = Number(extendResult.targetEndSeconds);
    const cappedExtendEndSeconds = capOutwardBoundaryTarget(row, 'right', speakerKey, extendEndSeconds);
    const currentRightRange = api.site.getRowTimeRange(row) || rowRange;

    if (
      shouldExtendRight &&
      currentRightRange &&
      Number.isFinite(cappedExtendEndSeconds) &&
      cappedExtendEndSeconds > currentRightRange.endSeconds + AUDIO_TRIM_EPSILON_SECONDS &&
      cappedExtendEndSeconds > currentRightRange.startSeconds + AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedRight = await moveSegmentBoundary('right', labels, speakerKey, cappedExtendEndSeconds, row);
      if (!movedRight || !movedRight.ok) {
        return { ok: false, reason: 'right-extend-failed', bridge: extendResult };
      }
      changed = true;
      labels = getCurrentMoveLabels(row, labels);
      await helper.sleep(32);
    }

    const cappedExtendStartSeconds = capOutwardBoundaryTarget(row, 'left', speakerKey, extendStartSeconds);
    const currentLeftRange = api.site.getRowTimeRange(row) || currentRightRange || rowRange;
    if (
      shouldExtendLeft &&
      currentLeftRange &&
      Number.isFinite(cappedExtendStartSeconds) &&
      cappedExtendStartSeconds < currentLeftRange.startSeconds - AUDIO_TRIM_EPSILON_SECONDS &&
      cappedExtendStartSeconds < currentLeftRange.endSeconds - AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedLeft = await moveSegmentBoundary('left', getCurrentMoveLabels(row, labels), speakerKey, cappedExtendStartSeconds, row);
      if (!movedLeft || !movedLeft.ok) {
        return { ok: false, reason: 'left-extend-failed', bridge: extendResult };
      }
      changed = true;
    }

    let finalTrimResult = null;
    if (changed) {
      await helper.sleep(32);
      finalTrimResult = await requestTrimTargetsForRow(row, speakerKey, options);
      if (finalTrimResult && finalTrimResult.ok && finalTrimResult.foundAudio) {
        const finalInwardMove = await applyInwardTrimToRow(row, speakerKey, finalTrimResult);
        if (!finalInwardMove || !finalInwardMove.ok) {
          return {
            ok: false,
            reason: finalInwardMove && finalInwardMove.reason ? finalInwardMove.reason : 'final-trim-failed',
            bridge: finalTrimResult
          };
        }
      }
    }

    return {
      ok: true,
      changed,
      trim: trimResult,
      extend: extendResult,
      finalTrim: finalTrimResult
    };
  }

  helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio(options) {
    const target = api.site.findCurrentSegmentTarget();
    if (!target) {
      return { ok: false, reason: 'missing-current-segment' };
    }

    return trimSegmentTarget(target, options);
  };


  helper.trimAllSegmentsToAudio = async function trimAllSegmentsToAudio(options) {
    const progressLabel = getTrimProgressLabel(options);
    const keepProgress = Boolean(options && options.keepProgress);
    const progressPhase = options && typeof options.progressPhase === 'string' ? options.progressPhase : '';
    const targets = api.site.collectAllSegmentTargets();
    if (!targets.length) {
      return {
        ok: false,
        reason: 'missing-segments',
        changedCount: 0
      };
    }

    let changedCount = 0;
    const updateTrimProgress = (current) => {
      const detail = `${current} / ${targets.length} segments`;
      if (progressPhase) {
        api.segmentation.updateAutoSegmentProgress({
          phase: progressPhase,
          current,
          total: targets.length,
          label: progressLabel,
          detail
        });
        return;
      }

      api.progress.updateLongTaskProgress({
        label: progressLabel,
        current,
        total: targets.length,
        detail
      });
    };
    updateTrimProgress(0);

    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        updateTrimProgress(index);

        const result = await trimSegmentTarget(target, options);
        if (!result || !result.ok) {
          return {
            ok: false,
            reason: result && result.reason ? result.reason : 'trim-failed',
            changedCount
          };
        }
        if (result.changed) {
          changedCount += 1;
        }
        updateTrimProgress(index + 1);
        await helper.sleep(16);
      }

      return {
        ok: true,
        changedCount
      };
    } finally {
      if (!keepProgress) {
        api.progress.dismissLongTaskProgress();
      }
    }
  };

  return { requestTrimTargets, trimSegmentTarget, capOutwardBoundaryTarget, AUDIO_TRIM_EPSILON_SECONDS, moveSegmentBoundary, getCurrentMoveLabels };
}
