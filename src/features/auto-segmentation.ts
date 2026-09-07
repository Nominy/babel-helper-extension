// @ts-nocheck
import { applyAutoSegmentTextReview, createAutoSegmentTextRedistributionDraft, createL0TimedAutoSegmentTextAllocations, normalizeAutoSegmentText, validateAutoSegmentTextAllocationsPreserveText } from '../services/auto-segment-text-allocation';
import { getCurrentL0TimingIndex } from '../content/l0-timing-listener';
import { buildCurrentL0TimingTaskId, buildL0TimingLaneAliases, resolveL0TimingTrack } from '../services/l0-timing-identity';
import { hasL0SegmentBrokerCapability } from '../services/l0-segment-transcription';
import { requestGoldDraftingAiBroker } from '../services/gold-drafting-ai-broker';
import { parseTimeValue } from '../hooks/parsing';
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerAutoSegmentation(helper: any, api: Pick<TimelineModules, 'site' | 'progress' | 'loop' | 'trim' | 'split'>) {
  const AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD = Math.pow(10, -56 / 20);

  const AUTO_SEGMENT_SILENCE_MIN_SECONDS = 1;

  const AUTO_SEGMENT_MERGE_GAP_SECONDS = 1;

  const AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS = 0.05;

  const AUTO_SEGMENT_SPLIT_SETTLE_MS = 220;

  const AUTO_SEGMENT_TIMING_WAIT_MS = 300000;

  const AUTO_SEGMENT_TIMING_POLL_MS = 250;

  const AUTO_SEGMENT_PROGRESS_PHASES = {
    prepare: { label: 'Preparing auto segmentation', percentBase: 0, percentSpan: 4 },
    preTrim: { label: 'Pre-trimming visible segments', percentBase: 4, percentSpan: 18 },
    merge: { label: 'Merging close segments', percentBase: 22, percentSpan: 8 },
    silence: { label: 'Finding silence runs', percentBase: 30, percentSpan: 18 },
    split: { label: 'Splitting on silence', percentBase: 48, percentSpan: 14 },
    postTrim: { label: 'Post-trimming segmented draft', percentBase: 62, percentSpan: 16 },
    cleanup: { label: 'Cleaning silent rows', percentBase: 78, percentSpan: 8 },
    alignText: { label: 'Aligning segmented text', percentBase: 86, percentSpan: 12 },
    complete: { label: 'Finishing auto segmentation', percentBase: 98, percentSpan: 2 }
  };

  helper.state.autoSegmentationPending = false;


  function updateAutoSegmentProgress({ phase, current, total, detail, label }) {
    const config = AUTO_SEGMENT_PROGRESS_PHASES[phase] || AUTO_SEGMENT_PROGRESS_PHASES.prepare;
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCurrent = api.site.clamp(Number(current) || 0, 0, safeTotal || 1);
    const percentBase = Number(config.percentBase) || 0;
    const percentSpan = Number(config.percentSpan) || 0;
    const fraction = safeTotal > 0 ? safeCurrent / safeTotal : 0;
    api.progress.updateLongTaskProgress({
      label: label || config.label,
      current: safeCurrent,
      total: safeTotal || 100,
      detail,
      percent: percentBase + Math.round(fraction * percentSpan)
    });
  }


  function collectAutoSegmentTargets() {
    const targets = [];
    const containers = api.site.discoverWaveformContainers();
    for (const row of helper.getTranscriptRows()) {
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      const labels = api.site.getRowTimeLabels(row);
      const startSeconds = labels ? parseTimeValue(labels.startText) : null;
      const endSeconds = labels ? parseTimeValue(labels.endText) : null;
      if (!labels || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        continue;
      }

      const speakerKey = helper.getRowSpeakerKey(row);
      const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
      const container =
        containers.find((candidate) => {
          const candidateSpeakerKey = api.site.getSpeakerKeyForContainer(candidate);
          return !speakerKey || candidateSpeakerKey === speakerKey;
        }) || null;

      targets.push({
        row,
        rowIdentity,
        annotationId:
          rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '',
        container,
        speakerKey,
        entry: {
          startText: labels.startText,
          endText: labels.endText
        },
        startSeconds,
        endSeconds
      });
    }

    return targets;
  }


  function getAutoSegmentTargetDiagnostics() {
    const rows = helper.getTranscriptRows();
    const fallbackRows = api.site.getFallbackTranscriptRows();
    const containers = api.site.discoverWaveformContainers();
    return {
      rowCount: rows.length,
      fallbackRowCount: fallbackRows.length,
      containerCount: containers.length,
      rows: rows.slice(0, 5).map((row) => {
        const labels = api.site.getRowTimeLabels(row);
        return {
          speakerKey: helper.getRowSpeakerKey(row),
          startText: labels ? labels.startText : '',
          endText: labels ? labels.endText : '',
          hasTextarea: Boolean(row.querySelector('textarea'))
        };
      }),
      containers: containers.slice(0, 5).map((container) => ({
        speakerKey: api.site.getSpeakerKeyForContainer(container),
        hasHost: api.site.getWaveformHostFromContainer(container) instanceof HTMLElement
      }))
    };
  }


  async function requestAutoSegmentSilenceRuns(target) {
    if (!target || !target.entry) {
      return null;
    }

    const hostMarker =
      target.container instanceof HTMLElement ? api.loop.ensureSelectionHostMarker(target.container) : '';
    if (target.container instanceof HTMLElement && !hostMarker) {
      return null;
    }

    return api.site.callSelectionBridge('find-segment-silence-runs', {
      hostMarker,
      speakerKey: target.speakerKey,
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
      amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD,
      minimumSilenceSeconds: AUTO_SEGMENT_SILENCE_MIN_SECONDS
    });
  }


  function getAutoSegmentRowActionSnapshot(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const labels = api.site.getRowTimeLabels(row);
    const range = api.site.getRowTimeRange(row);
    if (!labels || !range) {
      return null;
    }

    const speakerKey = helper.getRowSpeakerKey(row);
    const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
    return {
      row,
      rowIdentity,
      annotationId:
        rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '',
      speakerKey,
      startText: labels.startText,
      endText: labels.endText,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds
    };
  }


  function collectAutoSegmentMergePlans() {
    const rows = helper.getTranscriptRows();
    const rowsBySpeaker = new Map();
    const plans = [];
    const seen = new Set();

    for (const row of rows) {
      const snapshot = getAutoSegmentRowActionSnapshot(row);
      if (!snapshot || !snapshot.speakerKey) {
        continue;
      }

      const speakerRows = rowsBySpeaker.get(snapshot.speakerKey);
      if (speakerRows) {
        speakerRows.push(snapshot);
      } else {
        rowsBySpeaker.set(snapshot.speakerKey, [snapshot]);
      }
    }

    for (const speakerRows of rowsBySpeaker.values()) {
      speakerRows.sort((left, right) => left.startSeconds - right.startSeconds);

      for (let index = speakerRows.length - 2; index >= 0; index -= 1) {
        const current = speakerRows[index];
        const next = speakerRows[index + 1];
        const gapSeconds = next.startSeconds - current.endSeconds;
        if (!Number.isFinite(gapSeconds) || gapSeconds > AUTO_SEGMENT_MERGE_GAP_SECONDS) {
          continue;
        }

        const key = [
          current.annotationId || current.startText,
          next.annotationId || next.startText,
          Math.round(current.endSeconds * 1000),
          Math.round(next.startSeconds * 1000)
        ].join(':');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        plans.push({
          key,
          current,
          next,
          gapSeconds
        });
      }
    }

    return plans;
  }


  async function mergeAutoSegmentCloseRows(options) {
    const progressPhase = options && typeof options.progressPhase === 'string' ? options.progressPhase : '';
    const skipped = new Set();
    let mergeCount = 0;
    let skippedCount = 0;

    if (progressPhase) {
      updateAutoSegmentProgress({
        phase: progressPhase,
        current: 0,
        total: 1,
        detail: 'Looking for close rows...'
      });
    }

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const plan = collectAutoSegmentMergePlans().find((candidate) => !skipped.has(candidate.key));
      if (!plan) {
        break;
      }

      if (progressPhase) {
        updateAutoSegmentProgress({
          phase: progressPhase,
          current: Math.min(attempt, 199),
          total: 200,
          detail: 'Merged ' + mergeCount + ' rows'
        });
      }

      const result = await helper.mergeSegmentWithNativeAction({
        direction: 'below',
        annotationId: plan.current.annotationId,
        rowIdentity: plan.current.rowIdentity,
        startText: plan.current.startText,
        endText: plan.current.endText,
        startSeconds: plan.current.startSeconds,
        endSeconds: plan.current.endSeconds,
        speakerKey: plan.current.speakerKey,
        attempts: 2,
        retryDelayMs: 80
      });

      if (result && result.ok) {
        mergeCount += 1;
        if (progressPhase) {
          updateAutoSegmentProgress({
            phase: progressPhase,
            current: Math.min(attempt + 1, 200),
            total: 200,
            detail: 'Merged ' + mergeCount + ' rows'
          });
        }
        skipped.clear();
        await helper.sleep(AUTO_SEGMENT_SPLIT_SETTLE_MS);
        continue;
      }

      skipped.add(plan.key);
      skippedCount += 1;
    }

    if (progressPhase) {
      updateAutoSegmentProgress({
        phase: progressPhase,
        current: 1,
        total: 1,
        detail: 'Merged ' + mergeCount + ' rows'
      });
    }

    return {
      ok: true,
      mergeCount,
      skippedCount
    };
  }


  function findNearestSameSpeakerAutoSegmentRow(silent) {
    if (!silent || !(silent.row instanceof HTMLTableRowElement)) {
      return null;
    }

    const speakerKey = typeof silent.speakerKey === 'string' ? silent.speakerKey : '';
    if (!speakerKey) {
      return null;
    }

    let best = null;
    let bestDistance = Infinity;
    let bestBefore = false;
    for (const candidate of helper.getTranscriptRows()) {
      if (!(candidate instanceof HTMLTableRowElement) || candidate === silent.row) {
        continue;
      }

      const candidateSpeakerKey = helper.getRowSpeakerKey(candidate);
      if (candidateSpeakerKey !== speakerKey) {
        continue;
      }

      const range = api.site.getRowTimeRange(candidate);
      if (!range) {
        continue;
      }

      const isBefore = range.endSeconds <= silent.startSeconds;
      const distance = isBefore
        ? silent.startSeconds - range.endSeconds
        : range.startSeconds >= silent.endSeconds
          ? range.startSeconds - silent.endSeconds
          : 0;
      if (
        distance < bestDistance ||
        (distance === bestDistance && isBefore && !bestBefore)
      ) {
        best = {
          row: candidate,
          range
        };
        bestDistance = distance;
        bestBefore = isBefore;
      }
    }

    return best;
  }


  function stitchAutoSegmentSilentText(silent, nearest) {
    if (!silent || !nearest || !(nearest.row instanceof HTMLTableRowElement)) {
      return { ok: false, reason: 'missing-nearest-row' };
    }

    const silentText = helper.getRowTextValue(silent.row);
    if (!silentText) {
      return { ok: true, changed: false };
    }

    const nearestTextarea = helper.getRowTextarea(nearest.row);
    if (!(nearestTextarea instanceof HTMLTextAreaElement)) {
      return { ok: false, reason: 'missing-nearest-textarea' };
    }

    const nearestText = helper.getRowTextValue(nearest.row);
    const silentComesFirst =
      silent.endSeconds <= nearest.range.startSeconds ||
      (silent.startSeconds < nearest.range.startSeconds &&
        !(nearest.range.endSeconds <= silent.startSeconds));
    const nextText = silentComesFirst
      ? helper.joinSegmentText(silentText, nearestText)
      : helper.joinSegmentText(nearestText, silentText);
    if (nextText === nearestText) {
      return { ok: true, changed: false };
    }

    if (!helper.setEditableValue(nearestTextarea, nextText)) {
      return { ok: false, reason: 'text-stitch-failed' };
    }

    return { ok: true, changed: true };
  }


  async function collectAutoSegmentSilentRowPlans(options) {
    const targets = collectAutoSegmentTargets();
    const progressPhase = options && typeof options.progressPhase === 'string' ? options.progressPhase : '';
    const silentRows = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (progressPhase) {
        updateAutoSegmentProgress({
          phase: progressPhase,
          current: index,
          total: targets.length,
          detail: 'Checking silent rows ' + index + ' / ' + targets.length
        });
      }
      const labels =
        target && target.entry && target.entry.startText && target.entry.endText
          ? target.entry
          : null;
      if (!labels) {
        continue;
      }

      const probe = await api.trim.requestTrimTargets(target, labels, target.speakerKey, {
        amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD
      });
      if (probe && probe.ok && !probe.foundAudio) {
        silentRows.push({
          ...target,
          probe
        });
      }
    }

    if (progressPhase) {
      updateAutoSegmentProgress({
        phase: progressPhase,
        current: targets.length,
        total: targets.length,
        detail: 'Found ' + silentRows.length + ' silent rows'
      });
    }

    return silentRows;
  }


  function getAutoSegmentErrorMessage(error) {
    if (!error) {
      return '';
    }
    if (typeof error === 'string') {
      return error.slice(0, 240);
    }
    if (typeof error.message === 'string') {
      return error.message.slice(0, 240);
    }
    return String(error).slice(0, 240);
  }


  function createAutoSegmentCleanupFailureResult(error) {
    return {
      ok: false,
      reason: 'silent-cleanup-threw',
      deleteCount: 0,
      stitchCount: 0,
      skippedCount: 0,
      errorMessage: getAutoSegmentErrorMessage(error)
    };
  }


  function createAutoSegmentRedistributionFailureResult(error) {
    return {
      ok: false,
      reason: 'redistribution-threw',
      changedCount: 0,
      appliedGroupCount: 0,
      skippedCount: 0,
      groupCount: 0,
      audioSampleCount: 0,
      errorMessage: getAutoSegmentErrorMessage(error)
    };
  }


  async function cleanupAutoSegmentSilentRows(options) {
    const progressPhase = options && typeof options.progressPhase === 'string' ? options.progressPhase : '';
    let silentRows = [];
    try {
      silentRows = await collectAutoSegmentSilentRowPlans(options);
    } catch (error) {
      return {
        ok: false,
        reason: 'silent-cleanup-probe-failed',
        deleteCount: 0,
        stitchCount: 0,
        skippedCount: 0,
        errorMessage: getAutoSegmentErrorMessage(error)
      };
    }

    let deleteCount = 0;
    let stitchCount = 0;
    let skippedCount = 0;
    let lastErrorMessage = '';

    if (!silentRows.length) {
      return {
        ok: true,
        deleteCount,
        stitchCount,
        skippedCount,
        reason: 'no-silent-rows'
      };
    }

    if (typeof helper.deleteSegmentWithNativeAction !== 'function') {
      return {
        ok: false,
        reason: 'missing-delete-action',
        deleteCount,
        stitchCount,
        skippedCount: silentRows.length
      };
    }

    const rowsToDelete = silentRows.reverse();
    for (let index = 0; index < rowsToDelete.length; index += 1) {
      const silent = rowsToDelete[index];
      try {
        if (progressPhase) {
          updateAutoSegmentProgress({
            phase: progressPhase,
            current: index,
            total: rowsToDelete.length,
            detail: 'Removed ' + deleteCount + ' silent rows'
          });
        }
        if (!(silent.row instanceof HTMLTableRowElement) || !silent.row.isConnected) {
          continue;
        }

        const silentText = helper.getRowTextValue(silent.row);
        const nearest = findNearestSameSpeakerAutoSegmentRow(silent);
        if (!nearest && silentText) {
          skippedCount += 1;
          continue;
        }

        if (nearest) {
          const stitchResult = stitchAutoSegmentSilentText(silent, nearest);
          if (!stitchResult || !stitchResult.ok) {
            skippedCount += 1;
            continue;
          }
          if (stitchResult.changed) {
            stitchCount += 1;
            await helper.sleep(32);
          }
        }

        const deleteResult = await helper.deleteSegmentWithNativeAction({
          annotationId: silent.annotationId,
          rowIdentity: silent.rowIdentity,
          startText: silent.entry.startText,
          endText: silent.entry.endText,
          startSeconds: silent.startSeconds,
          endSeconds: silent.endSeconds,
          speakerKey: silent.speakerKey,
          attempts: 2,
          retryDelayMs: 80
        });
        if (deleteResult && deleteResult.ok) {
          deleteCount += 1;
          await helper.sleep(AUTO_SEGMENT_SPLIT_SETTLE_MS);
        } else {
          skippedCount += 1;
        }
      } catch (error) {
        skippedCount += 1;
        lastErrorMessage = getAutoSegmentErrorMessage(error);
      }
    }

    if (progressPhase) {
      updateAutoSegmentProgress({
        phase: progressPhase,
        current: rowsToDelete.length,
        total: rowsToDelete.length,
        detail: 'Removed ' + deleteCount + ' silent rows'
      });
    }

    const result = {
      ok: true,
      deleteCount,
      stitchCount,
      skippedCount
    };
    if (lastErrorMessage) {
      result.errorMessage = lastErrorMessage;
    }
    return result;
  }


  function normalizeAutoSegmentRedistributionText(value) {
    return normalizeAutoSegmentText(value);
  }


  function getAutoSegmentRedistributionRowSegment(row, index) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const speakerKey = helper.getRowSpeakerKey(row);
    const labels = api.site.getRowTimeLabels(row);
    const range = api.site.getRowTimeRange(row);
    if (!speakerKey || !labels || !range) {
      return null;
    }

    const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
    const annotationId =
      rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '';
    return {
      id:
        annotationId ||
        [
          speakerKey,
          Math.round(range.startSeconds * 1000),
          Math.round(range.endSeconds * 1000),
          index
        ].join(':'),
      row,
      rowIdentity,
      speakerKey,
      timingLaneAliases: getL0TimingLaneAliases(row, speakerKey),
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      startText: labels.startText,
      endText: labels.endText,
      text: normalizeAutoSegmentRedistributionText(helper.getRowTextValue(row))
    };
  }


  function collectAutoSegmentTextBaselineGroups() {
    const groups = [];
    let current = null;
    const rows = helper.getTranscriptRows();

    for (let index = 0; index < rows.length; index += 1) {
      const segment = getAutoSegmentRedistributionRowSegment(rows[index], index);
      if (!segment) {
        current = null;
        continue;
      }

      const gapSeconds = current ? segment.startSeconds - current.endSeconds : Infinity;
      if (
        !current ||
        segment.speakerKey !== current.speakerKey ||
        !Number.isFinite(gapSeconds) ||
        gapSeconds > AUTO_SEGMENT_MERGE_GAP_SECONDS
      ) {
        current = {
          id: 'baseline-' + groups.length,
          speakerKey: segment.speakerKey,
          timingLaneAliases: segment.timingLaneAliases,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          fullText: '',
          segments: []
        };
        groups.push(current);
      }

      current.segments.push(segment);
      current.startSeconds = Math.min(current.startSeconds, segment.startSeconds);
      current.endSeconds = Math.max(current.endSeconds, segment.endSeconds);
      current.fullText = current.segments
        .map((item) => normalizeAutoSegmentRedistributionText(item.text))
        .filter(Boolean)
        .join(' ');
    }

    return groups.filter(
      (group) =>
        normalizeAutoSegmentRedistributionText(group.fullText) &&
        group.segments.some((segment) => normalizeAutoSegmentRedistributionText(segment.text))
    );
  }


  function collectCurrentAutoSegmentRedistributionSegments() {
    const rows = helper.getTranscriptRows();
    return rows
      .map((row, index) => getAutoSegmentRedistributionRowSegment(row, index))
      .filter(Boolean);
  }


  function collectAutoSegmentTextRedistributionGroups(baselineGroups) {
    const baselines = Array.isArray(baselineGroups) ? baselineGroups : [];
    const currentSegments = collectCurrentAutoSegmentRedistributionSegments();
    if (baselines.length) {
      return baselines
        .map((baseline) => {
          const segments = currentSegments
            .filter(
              (segment) =>
                segment.speakerKey === baseline.speakerKey &&
                segment.endSeconds > baseline.startSeconds - AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS &&
                segment.startSeconds < baseline.endSeconds + AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS
            )
            .sort((left, right) => left.startSeconds - right.startSeconds);
          return {
            speakerKey: baseline.speakerKey,
            timingLaneAliases:
              baseline.timingLaneAliases || segments[0]?.timingLaneAliases || buildL0TimingLaneAliases({ speakerKey: baseline.speakerKey }),
            fullText: normalizeAutoSegmentRedistributionText(baseline.fullText),
            segments
          };
        })
        .filter((group) => group.fullText && group.segments.length > 0);
    }

    const groups = [];
    let current = null;
    for (const segment of currentSegments) {
      if (!current || segment.speakerKey !== current.speakerKey) {
        current = {
          speakerKey: segment.speakerKey,
          timingLaneAliases: segment.timingLaneAliases,
          fullText: '',
          segments: []
        };
        groups.push(current);
      }
      current.segments.push(segment);
      current.fullText = current.segments
        .map((item) => normalizeAutoSegmentRedistributionText(item.text))
        .filter(Boolean)
        .join(' ');
    }

    return groups.filter((group) => group.segments.length > 0 && normalizeAutoSegmentRedistributionText(group.fullText));
  }




  function applyAutoSegmentTextRedistributionAllocations(group, allocations) {
    if (!validateAutoSegmentTextAllocationsPreserveText(group, allocations)) {
      return {
        ok: false,
        reason: 'invalid-redistribution'
      };
    }

    let changedCount = 0;
    for (let index = 0; index < group.segments.length; index += 1) {
      const segment = group.segments[index];
      const allocation = allocations[index];
      if (!(segment.row instanceof HTMLTableRowElement) || !segment.row.isConnected) {
        continue;
      }

      const textarea = helper.getRowTextarea(segment.row);
      if (!(textarea instanceof HTMLTextAreaElement)) {
        continue;
      }

      if (allocation.text === normalizeAutoSegmentRedistributionText(textarea.value || '')) {
        continue;
      }

      if (helper.setEditableValue(textarea, allocation.text)) {
        changedCount += 1;
      }
    }

    return {
      ok: true,
      changedCount
    };
  }


  function getL0TimingLaneAliases(row, fallback) {
    const identity =
      row instanceof HTMLTableRowElement && typeof helper.getRowIdentity === 'function'
        ? helper.getRowIdentity(row) || {}
        : {};
    const speakerCell =
      row instanceof HTMLTableRowElement && row.children[1] instanceof HTMLElement
        ? helper.normalizeText(row.children[1])
        : '';
    return buildL0TimingLaneAliases(identity, [
      fallback,
      row instanceof HTMLTableRowElement ? helper.getRowSpeakerKey(row) : '',
      speakerCell
    ]);
  }


  async function redistributeAutoSegmentTextWithL0Timing(baselineGroups, options) {
    const progressPhase = options && typeof options.progressPhase === 'string' ? options.progressPhase : '';
    const timingIndex = options && options.timingIndex;
    const groups = collectAutoSegmentTextRedistributionGroups(baselineGroups);
    if (!groups.length) {
      return {
        ok: true,
        changedCount: 0,
        appliedGroupCount: 0,
        skippedCount: 0,
        groupCount: 0,
        source: 'l0-word-timing',
        reason: 'no-text-redistribution-groups'
      };
    }
    if (!timingIndex || !Array.isArray(timingIndex.tracks)) {
      return {
        ok: false,
        changedCount: 0,
        appliedGroupCount: 0,
        skippedCount: groups.length,
        groupCount: groups.length,
        source: 'l0-word-timing',
        reason: 'timing-unavailable'
      };
    }

    let changedCount = 0;
    let appliedGroupCount = 0;
    let skippedCount = 0;
    let lastErrorMessage = '';

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const detail = 'Aligned ' + appliedGroupCount + ' / ' + groups.length + ' text groups';
      if (progressPhase) {
        updateAutoSegmentProgress({
          phase: progressPhase,
          current: index,
          total: groups.length,
          detail
        });
      } else {
        api.progress.updateLongTaskProgress({
          label: 'Aligning segmented text',
          current: index,
          total: groups.length,
          detail
        });
      }

      const timingTrack = resolveL0TimingTrack(
        timingIndex,
        group.timingLaneAliases || buildL0TimingLaneAliases({ speakerKey: group.speakerKey })
      );
      if (!timingTrack) {
        skippedCount += 1;
        lastErrorMessage = 'No L0 timing track matched ' + group.speakerKey + '.';
        continue;
      }

      const timedResult = createL0TimedAutoSegmentTextAllocations(
        group,
        timingTrack.tokens
      );
      if (!timedResult || !timedResult.ok) {
        skippedCount += 1;
        lastErrorMessage =
          timedResult && timedResult.reason
            ? timedResult.reason
            : 'L0 timing allocation failed.';
        continue;
      }

      let applyResult = null;
      try {
        applyResult = applyAutoSegmentTextRedistributionAllocations(
          group,
          timedResult.allocations
        );
      } catch (error) {
        skippedCount += 1;
        lastErrorMessage = getAutoSegmentErrorMessage(error);
        continue;
      }
      if (!applyResult || !applyResult.ok) {
        skippedCount += 1;
        lastErrorMessage = 'L0 timing allocations did not preserve transcript text.';
        continue;
      }

      appliedGroupCount += 1;
      changedCount += applyResult.changedCount || 0;
      if (applyResult.changedCount) {
        await helper.sleep(32);
      }
    }

    const finalDetail = 'Aligned ' + appliedGroupCount + ' / ' + groups.length + ' text groups';
    if (progressPhase) {
      updateAutoSegmentProgress({
        phase: progressPhase,
        current: groups.length,
        total: groups.length,
        detail: finalDetail
      });
    } else {
      api.progress.updateLongTaskProgress({
        label: 'Aligning segmented text',
        current: groups.length,
        total: groups.length,
        detail: finalDetail
      });
    }

    return {
      ok: skippedCount === 0,
      changedCount,
      appliedGroupCount,
      skippedCount,
      groupCount: groups.length,
      source: 'l0-word-timing',
      reason: skippedCount ? 'timed-redistribution-incomplete' : null,
      errorMessage: lastErrorMessage
    };
  }


  async function redistributeAutoSegmentTextWithLegacyModels(baselineGroups, options) {
    const progressPhase = options && typeof options.progressPhase === 'string' ? options.progressPhase : '';
    const groups = collectAutoSegmentTextRedistributionGroups(baselineGroups);
    if (!groups.length) {
      return {
        ok: true,
        changedCount: 0,
        appliedGroupCount: 0,
        skippedCount: 0,
        groupCount: 0,
        source: 'legacy-model-fallback'
      };
    }

    const drafts = groups.map((group) => createAutoSegmentTextRedistributionDraft(group));
    const remoteGroups = drafts.flatMap((draft, index) =>
      draft && draft.ok
        ? [{
          groupId: 'auto-segment-text-group-' + index,
          speakerKey: groups[index].speakerKey,
          fullText: draft.fullText,
          segments: groups[index].segments.map((segment, segmentIndex) => ({
            id: segment.id,
            index: segmentIndex,
            speakerKey: segment.speakerKey,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            text: segment.text || ''
          })),
          draftAllocations: draft.allocations.map((allocation) => ({
            segmentId: allocation.id,
            text: allocation.text
          }))
        }]
        : []
    );
    const brokerResult = remoteGroups.length
      ? await requestGoldDraftingAiBroker({
        operation: 'redistributeText',
        groups: remoteGroups
      }).catch(() => null)
      : null;
    const brokerReviews =
      brokerResult && brokerResult.ok && Array.isArray(brokerResult.results)
        ? brokerResult.results
        : [];

    let changedCount = 0;
    let appliedGroupCount = 0;
    let skippedCount = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const draft = drafts[index];
      if (!draft || !draft.ok) {
        skippedCount += 1;
        continue;
      }
      if (progressPhase) {
        updateAutoSegmentProgress({
          phase: progressPhase,
          current: index,
          total: groups.length,
          detail: 'Aligning ' + (index + 1) + ' / ' + groups.length + ' text groups'
        });
      }

      let allocations = draft.allocations;
      const brokerReview =
        brokerReviews[index] && brokerReviews[index].ok
          ? brokerReviews[index].review
          : null;
      if (brokerReview) {
        const reviewed = applyAutoSegmentTextReview(group, allocations, brokerReview);
        if (reviewed && reviewed.ok) allocations = reviewed.allocations;
      } else {
        const localReview = await api.site.callSelectionBridge('auto-segment-redistribute-text', {
          speakerKey: group.speakerKey,
          fullText: draft.fullText,
          segments: group.segments.map((segment) => ({
            id: segment.id,
            speakerKey: segment.speakerKey,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            text: segment.text || ''
          })),
          draftAllocations: allocations,
          timeoutMs: 300000
        }).catch(() => null);
        if (localReview && localReview.ok && localReview.review) {
          const reviewed = applyAutoSegmentTextReview(group, allocations, localReview.review);
          if (reviewed && reviewed.ok) allocations = reviewed.allocations;
        }
      }

      const applied = applyAutoSegmentTextRedistributionAllocations(group, allocations);
      if (!applied || !applied.ok) {
        skippedCount += 1;
        continue;
      }
      appliedGroupCount += 1;
      changedCount += applied.changedCount || 0;
    }

    return {
      ok: skippedCount === 0,
      changedCount,
      appliedGroupCount,
      skippedCount,
      groupCount: groups.length,
      source: 'legacy-model-fallback'
    };
  }


  function emitAutoSegmentDebug(detail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
      return;
    }

    window.dispatchEvent(
      new CustomEvent('babel-helper-auto-segmentation-debug', {
        detail
      })
    );
  }


  function collectAutoSegmentSplitPlans(targets, silenceResults) {
    const plans = [];
    const seen = new Set();
    const results = Array.isArray(silenceResults) ? silenceResults : [];

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const result = results[index];
      const runs = result && result.ok && Array.isArray(result.runs) ? result.runs : [];
      for (const run of runs) {
        const splitSeconds = Number(run && run.splitSeconds);
        if (
          !Number.isFinite(splitSeconds) ||
          splitSeconds <= target.startSeconds + AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS ||
          splitSeconds >= target.endSeconds - AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS
        ) {
          continue;
        }

        const key = [
          target.speakerKey || '',
          Math.round(splitSeconds * 1000)
        ].join(':');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        plans.push({
          container: target.container,
          row: target.row,
          rowIdentity: target.rowIdentity || null,
          annotationId: target.annotationId || '',
          speakerKey: target.speakerKey,
          splitSeconds,
          startSeconds: target.startSeconds,
          endSeconds: target.endSeconds
        });
      }
    }

    return plans.sort((left, right) => right.splitSeconds - left.splitSeconds);
  }


  function findCurrentAutoSegmentSplitRow(plan) {
    if (!plan || !Number.isFinite(plan.splitSeconds)) {
      return null;
    }

    const speakerKey =
      typeof plan.speakerKey === 'string' && plan.speakerKey ? plan.speakerKey : '';
    for (const row of helper.getTranscriptRows()) {
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
        continue;
      }

      const range = api.site.getRowTimeRange(row);
      if (!range) {
        continue;
      }

      if (
        plan.splitSeconds > range.startSeconds + AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS &&
        plan.splitSeconds < range.endSeconds - Math.max(AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS, 0.1)
      ) {
        return row;
      }
    }

    return plan.row instanceof HTMLTableRowElement && plan.row.isConnected ? plan.row : null;
  }


  async function waitForAutoSegmentL0Timing() {
    const expectedTaskId = buildCurrentL0TimingTaskId(helper);
    const brokerAvailability = await requestGoldDraftingAiBroker({
      operation: 'ping'
    }).catch(() => null);
    if (!hasL0SegmentBrokerCapability(brokerAvailability)) {
      return { ok: false, reason: 'timing-provider-unavailable' };
    }
    const existingTiming = getCurrentL0TimingIndex(helper.state, helper);
    if (existingTiming && existingTiming.taskId === expectedTaskId) {
      return { ok: true, timingIndex: existingTiming };
    }
    const startedAt = Date.now();
    let reportedSecond = -1;
    while (Date.now() - startedAt < AUTO_SEGMENT_TIMING_WAIT_MS) {
      if (buildCurrentL0TimingTaskId(helper) !== expectedTaskId) {
        return { ok: false, reason: 'task-changed' };
      }
      const timingIndex = getCurrentL0TimingIndex(helper.state, helper);
      if (timingIndex && timingIndex.taskId === expectedTaskId) {
        return { ok: true, timingIndex };
      }
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsedSeconds !== reportedSecond) {
        reportedSecond = elapsedSeconds;
        updateAutoSegmentProgress({
          phase: 'prepare',
          current: 0,
          total: 1,
          detail: 'Waiting for background word timing (' + elapsedSeconds + 's)'
        });
      }
      await helper.sleep(AUTO_SEGMENT_TIMING_POLL_MS);
    }
    return { ok: false, reason: 'timing-timeout' };
  }


  helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences() {
    if (helper.state.autoSegmentationPending) {
      return {
        ok: false,
        reason: 'auto-segmentation-pending',
        splitCount: 0
      };
    }

    helper.state.autoSegmentationPending = true;

    try {
      updateAutoSegmentProgress({
        phase: 'prepare',
        current: 0,
        total: 1,
        detail: 'Waiting for background word timing'
      });
      const timingWaitResult = await waitForAutoSegmentL0Timing();
      if (
        timingWaitResult &&
        timingWaitResult.reason === 'task-changed'
      ) {
        return { ok: false, reason: 'task-changed', splitCount: 0 };
      }
      if (
        timingWaitResult &&
        timingWaitResult.reason === 'timing-provider-unavailable'
      ) {
        return { ok: false, reason: 'timing-provider-unavailable', splitCount: 0 };
      }
      const timingIndex =
        timingWaitResult && timingWaitResult.ok
          ? timingWaitResult.timingIndex
          : null;
      const useLegacyRedistribution = !timingIndex;
      if (useLegacyRedistribution) {
        updateAutoSegmentProgress({
          phase: 'prepare',
          current: 1,
          total: 1,
          detail: 'Using default text redistribution'
        });
      }
      const preTrimResult = await helper.trimAllSegmentsToAudio({
        amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD,
        progressLabel: 'Pre-trimming visible segments',
        keepProgress: true,
        progressPhase: 'preTrim'
      });
      if (!(preTrimResult && preTrimResult.ok)) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: preTrimResult && preTrimResult.reason ? preTrimResult.reason : 'pre-trim-failed',
          targetCount: 0,
          splitCount: 0,
          preTrim: preTrimResult || null,
          diagnostics: getAutoSegmentTargetDiagnostics()
        });
        return {
          ok: false,
          reason: preTrimResult && preTrimResult.reason ? preTrimResult.reason : 'pre-trim-failed',
          splitCount: 0,
          preTrim: preTrimResult || null
        };
      }

      const mergeResult = await mergeAutoSegmentCloseRows({
        progressPhase: 'merge'
      });
      if (!mergeResult || !mergeResult.ok) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: mergeResult && mergeResult.reason ? mergeResult.reason : 'merge-failed',
          targetCount: 0,
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult || null,
          diagnostics: getAutoSegmentTargetDiagnostics()
        });
        return {
          ok: false,
          reason: mergeResult && mergeResult.reason ? mergeResult.reason : 'merge-failed',
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult || null
        };
      }

      const textBaselineGroups = collectAutoSegmentTextBaselineGroups();
      const targets = collectAutoSegmentTargets();
      if (!targets.length) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: 'missing-segments',
          targetCount: 0,
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult,
          textBaselineGroupCount: textBaselineGroups.length,
          diagnostics: getAutoSegmentTargetDiagnostics()
        });
        return {
          ok: false,
          reason: 'missing-segments',
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult,
          textBaselineGroupCount: textBaselineGroups.length
        };
      }

      updateAutoSegmentProgress({
        phase: 'silence',
        current: 0,
        total: targets.length,
        detail: 'Detected 0 silence runs'
      });

      let splitCount = 0;
      let silenceRunCount = 0;
      const silenceResults = [];
      for (let index = 0; index < targets.length; index += 1) {
        updateAutoSegmentProgress({
          phase: 'silence',
          current: index,
          total: targets.length,
          detail: 'Detected ' + silenceRunCount + ' silence runs'
        });
        const silenceResult = await requestAutoSegmentSilenceRuns(targets[index]);
        silenceResults.push(silenceResult);
        silenceRunCount += silenceResult && Array.isArray(silenceResult.runs) ? silenceResult.runs.length : 0;
        updateAutoSegmentProgress({
          phase: 'silence',
          current: index + 1,
          total: targets.length,
          detail: 'Detected ' + silenceRunCount + ' silence runs'
        });
      }

      const splitPlans = collectAutoSegmentSplitPlans(targets, silenceResults);
      emitAutoSegmentDebug({
        phase: 'planned',
        ok: true,
        targetCount: targets.length,
        silenceResultCount: silenceResults.length,
        splitPlanCount: splitPlans.length,
        silenceResults: silenceResults.map((result) => ({
          ok: Boolean(result && result.ok),
          reason: result && result.reason ? result.reason : null,
          source: result && result.source ? result.source : null,
          runCount: result && Array.isArray(result.runs) ? result.runs.length : 0
        }))
      });

      for (let index = 0; index < splitPlans.length; index += 1) {
        updateAutoSegmentProgress({
          phase: 'split',
          current: index,
          total: splitPlans.length,
          detail: 'Created ' + splitCount + ' splits'
        });

        const plan = splitPlans[index];
        const row = findCurrentAutoSegmentSplitRow(plan);
        if (!(row instanceof HTMLTableRowElement)) {
          continue;
        }

        const labels = api.site.getRowTimeLabels(row);
        const range = api.site.getRowTimeRange(row);
        const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
        const smartSplitPlan = api.split.buildSmartSplitPlanForRow(row, plan.splitSeconds, plan.speakerKey);
        const splitResult = await helper.splitSegmentAtTime({
          annotationId: plan.annotationId,
          rowIdentity: rowIdentity || plan.rowIdentity || null,
          startText: labels ? labels.startText : '',
          endText: labels ? labels.endText : '',
          startSeconds: range ? range.startSeconds : plan.startSeconds,
          endSeconds: range ? range.endSeconds : plan.endSeconds,
          speakerKey: plan.speakerKey,
          splitSeconds: plan.splitSeconds
        });

        if (!splitResult || !splitResult.ok) {
          continue;
        }

        splitCount += 1;
        updateAutoSegmentProgress({
          phase: 'split',
          current: index + 1,
          total: splitPlans.length,
          detail: 'Created ' + splitCount + ' splits'
        });
        if (smartSplitPlan) {
          await api.split.applySmartSplit(smartSplitPlan);
        }
        await helper.sleep(AUTO_SEGMENT_SPLIT_SETTLE_MS);
      }

      updateAutoSegmentProgress({
        phase: 'postTrim',
        current: 0,
        total: 1,
        detail: 'Preparing post-trim pass'
      });
      const postTrimResult = await helper.trimAllSegmentsToAudio({
        amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD,
        progressLabel: 'Post-trimming segmented draft',
        keepProgress: true,
        progressPhase: 'postTrim'
      });
      if (!(postTrimResult && postTrimResult.ok)) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: postTrimResult && postTrimResult.reason ? postTrimResult.reason : 'trim-failed',
          targetCount: targets.length,
          splitPlanCount: splitPlans.length,
          splitCount,
          preTrim: preTrimResult,
          merge: mergeResult,
          trim: postTrimResult || null
        });
        return {
          ok: false,
          reason: postTrimResult && postTrimResult.reason ? postTrimResult.reason : 'trim-failed',
          splitCount,
          preTrim: preTrimResult,
          merge: mergeResult,
          trim: postTrimResult || null
        };
      }

      const silentCleanupResult = await cleanupAutoSegmentSilentRows({
        progressPhase: 'cleanup'
      }).catch((error) =>
        createAutoSegmentCleanupFailureResult(error)
      );
      const redistributionResult = await (
        useLegacyRedistribution
          ? redistributeAutoSegmentTextWithLegacyModels(textBaselineGroups, {
            progressPhase: 'alignText'
          })
          : redistributeAutoSegmentTextWithL0Timing(textBaselineGroups, {
            progressPhase: 'alignText',
            timingIndex
          })
      ).catch((error) =>
        createAutoSegmentRedistributionFailureResult(error)
      );
      const finalPhaseOk =
        Boolean(silentCleanupResult && silentCleanupResult.ok) &&
        Boolean(redistributionResult && redistributionResult.ok);
      const result = {
        ok: finalPhaseOk,
        reason: finalPhaseOk ? null : 'finalize-failed',
        changed: splitCount > 0 || Boolean(postTrimResult && postTrimResult.changedCount) || Boolean(mergeResult && mergeResult.mergeCount) || Boolean(silentCleanupResult && silentCleanupResult.deleteCount) || Boolean(redistributionResult && redistributionResult.changedCount),
        splitCount,
        preTrim: preTrimResult,
        merge: mergeResult,
        trim: postTrimResult,
        cleanup: silentCleanupResult,
        redistribution: redistributionResult,
        textBaselineGroupCount: textBaselineGroups.length
      };
      updateAutoSegmentProgress({
        phase: 'complete',
        current: 1,
        total: 1,
        detail: result.ok ? 'Complete' : 'Finished with issues'
      });
      emitAutoSegmentDebug({
        phase: 'complete',
        ok: result.ok,
        reason: result.reason || null,
        changed: result.changed,
        targetCount: targets.length,
        splitPlanCount: splitPlans.length,
        splitCount,
        preTrim: preTrimResult,
        merge: mergeResult,
        trim: postTrimResult,
        cleanup: silentCleanupResult,
        redistribution: redistributionResult,
        textBaselineGroupCount: textBaselineGroups.length
      });
      return result;
    } finally {
      helper.state.autoSegmentationPending = false;
      api.progress.dismissLongTaskProgress();
    }
  };

  return { AUTO_SEGMENT_SPLIT_SETTLE_MS, AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD, getAutoSegmentRowActionSnapshot, AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS, getL0TimingLaneAliases, normalizeAutoSegmentRedistributionText, updateAutoSegmentProgress };
}
