// @ts-nocheck
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerAutoInsertSegment(helper: any, api: Pick<TimelineModules, 'segmentation' | 'site' | 'loop' | 'progress' | 'trim'>) {
  const AUTO_INSERT_SEGMENT_SCAN_WINDOW_SECONDS = 1;

  const AUTO_INSERT_SEGMENT_PROVISIONAL_PADDING_SECONDS = 0.05;

  const AUTO_INSERT_SEGMENT_MERGE_WINDOW_SECONDS = 1;

  const AUTO_INSERT_SEGMENT_SETTLE_MS = api.segmentation.AUTO_SEGMENT_SPLIT_SETTLE_MS;

  helper.state.autoInsertSegmentHotkeyHandledAt = 0;


  async function collectAutoInsertSegmentLaneTargets() {
    const candidates = [];

    for (const container of api.site.discoverWaveformContainers()) {
      if (!(container instanceof HTMLElement)) {
        continue;
      }

      const host = api.site.getWaveformHostFromContainer(container);
      if (!(host instanceof HTMLElement)) {
        continue;
      }

      const hostMarker = api.loop.ensureSelectionHostMarker(container);
      if (!hostMarker) {
        continue;
      }

      candidates.push({
        container,
        host,
        hostMarker,
        index: candidates.length
      });
    }

    const bridgeResult = candidates.length
      ? await api.site.callSelectionBridge('resolve-visible-lane-targets', {
        lanes: candidates.map((candidate) => ({
          index: candidate.index,
          hostMarker: candidate.hostMarker
        }))
      })
      : null;
    const resolvedByMarker = new Map();
    if (bridgeResult && Array.isArray(bridgeResult.targets)) {
      for (const resolvedLane of bridgeResult.targets) {
        if (
          resolvedLane &&
          typeof resolvedLane.hostMarker === 'string' &&
          resolvedLane.hostMarker
        ) {
          resolvedByMarker.set(resolvedLane.hostMarker, resolvedLane);
        }
      }
    }

    const targets = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const resolvedLane = resolvedByMarker.get(candidate.hostMarker) || {};
      const resolvedOk = resolvedLane.ok !== false;
      const resolvedHasWave = resolvedLane.hasWave === true;
      const processedRecordingId =
        typeof resolvedLane.processedRecordingId === 'string'
          ? resolvedLane.processedRecordingId
          : '';
      const speakerKey =
        (typeof resolvedLane.speakerKey === 'string' && resolvedLane.speakerKey) ||
        (typeof resolvedLane.trackLabel === 'string' && resolvedLane.trackLabel) ||
        processedRecordingId;
      const target = {
        container: candidate.container,
        host: candidate.host,
        hostMarker: candidate.hostMarker,
        trackId: processedRecordingId,
        speakerKey: speakerKey || processedRecordingId,
        trackLabel: typeof resolvedLane.trackLabel === 'string' ? resolvedLane.trackLabel : ''
      };
      const key = target.trackId || target.speakerKey || candidate.hostMarker;
      if (
        !target.trackId ||
        !resolvedOk ||
        !resolvedHasWave ||
        !api.site.isAutoInsertLaneSemanticallyVisible(target) ||
        seen.has(key)
      ) {
        continue;
      }

      seen.add(key);
      targets.push(target);
    }

    return targets;
  }


  async function requestNearestSpeechIslandForLane(target) {
    if (!target || !target.hostMarker) {
      return null;
    }

    return api.site.callSelectionBridge('find-nearest-speech-island', {
      hostMarker: target.hostMarker,
      speakerKey: target.speakerKey,
      strictHost: true,
      scanWindowSeconds: AUTO_INSERT_SEGMENT_SCAN_WINDOW_SECONDS,
      amplitudeThreshold: api.segmentation.AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD,
      paddingSeconds: AUTO_INSERT_SEGMENT_PROVISIONAL_PADDING_SECONDS
    });
  }


  function findAutoInsertCreatedRow(target, createResult, islandResult) {
    const verification = createResult && createResult.verification ? createResult.verification : createResult;
    const annotationId =
      verification && typeof verification.annotationId === 'string' ? verification.annotationId : '';
    const speakerKeys = [];
    const addSpeakerKey = (value) => {
      const speakerKey = typeof value === 'string' ? value.trim() : '';
      if (speakerKey && !speakerKeys.includes(speakerKey)) {
        speakerKeys.push(speakerKey);
      }
    };
    addSpeakerKey(target && target.trackLabel);
    addSpeakerKey(target && target.speakerKey);
    addSpeakerKey(target && target.trackId);

    const startText = verification && typeof verification.startText === 'string' ? verification.startText : '';
    const endText = verification && typeof verification.endText === 'string' ? verification.endText : '';
    const lookupSpeakerKeys = speakerKeys.length ? speakerKeys : [''];

    if (annotationId && typeof helper.findRowByIdentity === 'function') {
      for (const speakerKey of lookupSpeakerKeys) {
        const byIdentity = helper.findRowByIdentity({
          annotationId,
          speakerKey,
          startText,
          endText
        });
        if (byIdentity instanceof HTMLTableRowElement) {
          return byIdentity;
        }
      }
    }

    if (startText && endText) {
      for (const speakerKey of lookupSpeakerKeys) {
        const byLabels = api.site.findRowByTimeLabels(startText, endText, {
          speakerKey
        });
        if (byLabels instanceof HTMLTableRowElement) {
          return byLabels;
        }
      }
    }

    const startSeconds =
      verification && Number.isFinite(Number(verification.startSeconds))
        ? Number(verification.startSeconds)
        : islandResult && Number.isFinite(Number(islandResult.targetStartSeconds))
          ? Number(islandResult.targetStartSeconds)
          : null;
    const endSeconds =
      verification && Number.isFinite(Number(verification.endSeconds))
        ? Number(verification.endSeconds)
        : islandResult && Number.isFinite(Number(islandResult.targetEndSeconds))
          ? Number(islandResult.targetEndSeconds)
          : null;
    if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds) {
      for (const speakerKey of lookupSpeakerKeys) {
        const byRange = api.site.findRowByTimeRange(startSeconds, endSeconds, {
          speakerKey
        });
        if (byRange instanceof HTMLTableRowElement) {
          return byRange;
        }
      }
    }

    return null;
  }


  function buildAutoInsertTrimTarget(target, createResult, islandResult) {
    const row = findAutoInsertCreatedRow(target, createResult, islandResult);
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const labels = api.site.getRowTimeLabels(row);
    if (!labels || !labels.startText || !labels.endText) {
      return null;
    }

    const rowSpeakerKey = helper.getRowSpeakerKey(row);
    const trimTarget = {
      row,
      rowIdentity: typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null,
      speakerKey: rowSpeakerKey,
      container: target && target.container instanceof HTMLElement ? target.container : null,
      entry: {
        startText: labels.startText,
        endText: labels.endText
      }
    };
    api.site.rememberTimelineSegmentTarget(row, trimTarget.container, trimTarget.entry, rowSpeakerKey);
    return trimTarget;
  }


  async function waitForAutoInsertTrimTarget(target, createResult, islandResult) {
    const isReady = (candidate) => {
      if (!candidate) {
        return false;
      }

      if (!(candidate.container instanceof HTMLElement) || !candidate.container.isConnected) {
        return true;
      }

      return Boolean(api.site.findRegionEntryForRow(candidate.row, candidate.container));
    };

    const initial = buildAutoInsertTrimTarget(target, createResult, islandResult);
    if (isReady(initial) || typeof helper.waitFor !== 'function') {
      return initial;
    }

    const settled = await helper.waitFor(() => {
      const candidate = buildAutoInsertTrimTarget(target, createResult, islandResult);
      return isReady(candidate) ? candidate : null;
    }, AUTO_INSERT_SEGMENT_SETTLE_MS, 40);
    return settled || initial;
  }


  function findAutoInsertAdjacentMergePlan(row, direction) {
    const current = api.segmentation.getAutoSegmentRowActionSnapshot(row);
    if (!current || !current.speakerKey) {
      return null;
    }

    const sameSpeakerRows = helper
      .getTranscriptRows()
      .map((candidateRow) => api.segmentation.getAutoSegmentRowActionSnapshot(candidateRow))
      .filter((candidate) => candidate && candidate.speakerKey === current.speakerKey)
      .sort((left, right) => left.startSeconds - right.startSeconds);
    const currentIndex = sameSpeakerRows.findIndex((candidate) => candidate.row === current.row);
    if (currentIndex < 0) {
      return null;
    }

    if (direction === 'above') {
      const neighbor = sameSpeakerRows[currentIndex - 1];
      const leftGapSeconds = neighbor ? current.startSeconds - neighbor.endSeconds : Infinity;
      const isLeftWithinWindow =
        Number.isFinite(leftGapSeconds) &&
        leftGapSeconds <= AUTO_INSERT_SEGMENT_MERGE_WINDOW_SECONDS;
      if (!neighbor || !isLeftWithinWindow) {
        return null;
      }

      return {
        direction: 'above',
        current,
        neighbor,
        gapSeconds: leftGapSeconds,
        mergedStartSeconds: Math.min(neighbor.startSeconds, current.startSeconds),
        mergedEndSeconds: Math.max(neighbor.endSeconds, current.endSeconds)
      };
    }

    const neighbor = sameSpeakerRows[currentIndex + 1];
    const rightGapSeconds = neighbor ? neighbor.startSeconds - current.endSeconds : Infinity;
    const isRightWithinWindow =
      Number.isFinite(rightGapSeconds) &&
      rightGapSeconds <= AUTO_INSERT_SEGMENT_MERGE_WINDOW_SECONDS;
    if (!neighbor || !isRightWithinWindow) {
      return null;
    }

    return {
      direction: 'below',
      current,
      neighbor,
      gapSeconds: rightGapSeconds,
      mergedStartSeconds: Math.min(current.startSeconds, neighbor.startSeconds),
      mergedEndSeconds: Math.max(current.endSeconds, neighbor.endSeconds)
    };
  }


  function findAutoInsertMergedRow(plan) {
    if (!plan || !plan.current || !plan.current.speakerKey) {
      return null;
    }

    return api.site.findRowByTimeRange(plan.mergedStartSeconds, plan.mergedEndSeconds, {
      speakerKey: plan.current.speakerKey
    });
  }


  async function applyAutoInsertAdjacentMerge(row, direction) {
    const plan = findAutoInsertAdjacentMergePlan(row, direction);
    if (!plan) {
      return {
        ok: true,
        changed: false,
        direction,
        reason: 'no-adjacent-segment'
      };
    }

    const neighborText = helper.getRowTextValue(plan.neighbor.row) || '';
    const currentText = helper.getRowTextValue(plan.current.row) || '';
    const result = await helper.mergeSegmentWithNativeAction({
      direction: plan.direction,
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
    if (!result || !result.ok) {
      return {
        ok: false,
        changed: false,
        direction,
        gapSeconds: plan.gapSeconds,
        merge: result || null
      };
    }

    await helper.sleep(api.segmentation.AUTO_SEGMENT_SPLIT_SETTLE_MS);
    return {
      ok: true,
      changed: true,
      direction,
      gapSeconds: plan.gapSeconds,
      merge: result,
      neighborTextLength: neighborText.length,
      currentTextLength: currentText.length,
      row: findAutoInsertMergedRow(plan) || row
    };
  }


  async function mergeAutoInsertAdjacentRows(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return {
        ok: false,
        changed: false,
        reason: 'missing-row',
        mergeCount: 0
      };
    }

    if (typeof helper.mergeSegmentWithNativeAction !== 'function') {
      return {
        ok: false,
        changed: false,
        reason: 'missing-merge-action',
        mergeCount: 0
      };
    }

    let currentRow = row;
    let mergeCount = 0;
    let caretPosition = 'start';
    let caretOffset = 0;
    let leftTextLength = 0;
    const results = [];

    const leftResult = await applyAutoInsertAdjacentMerge(currentRow, 'above');
    results.push(leftResult);
    if (leftResult && leftResult.ok && leftResult.changed) {
      mergeCount += 1;
      caretPosition = 'end';
      leftTextLength = Number(leftResult.neighborTextLength) || 0;
      caretOffset = leftTextLength;
      if (leftResult.row instanceof HTMLTableRowElement) {
        currentRow = leftResult.row;
      }
    }

    const rightResult = await applyAutoInsertAdjacentMerge(currentRow, 'below');
    results.push(rightResult);
    if (rightResult && rightResult.ok && rightResult.changed) {
      mergeCount += 1;
      if (leftResult && leftResult.ok && leftResult.changed) {
        caretPosition = 'offset';
        caretOffset = leftTextLength;
      } else {
        caretPosition = 'start';
        caretOffset = 0;
      }
      if (rightResult.row instanceof HTMLTableRowElement) {
        currentRow = rightResult.row;
      }
    }

    return {
      ok: results.every((result) => result && result.ok),
      changed: mergeCount > 0,
      mergeCount,
      caretPosition,
      caretOffset,
      row: currentRow,
      rowIdentity: typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(currentRow) : null,
      results
    };
  }


  function getAutoInsertFocusedRow(fallbackRow, mergeResult) {
    const rowIdentity =
      mergeResult && mergeResult.rowIdentity && typeof mergeResult.rowIdentity === 'object'
        ? mergeResult.rowIdentity
        : null;
    const byIdentity =
      rowIdentity && typeof helper.findRowByIdentity === 'function'
        ? helper.findRowByIdentity(rowIdentity)
        : null;
    if (byIdentity instanceof HTMLTableRowElement) {
      return byIdentity;
    }

    const row = mergeResult && mergeResult.row instanceof HTMLTableRowElement ? mergeResult.row : null;
    if (row && row.isConnected) {
      return row;
    }

    return fallbackRow instanceof HTMLTableRowElement ? fallbackRow : null;
  }


  function getAutoInsertRowTextLength(row) {
    const textarea = helper.getRowTextarea(row);
    return textarea instanceof HTMLTextAreaElement ? (textarea.value || '').length : 0;
  }


  function getAutoInsertCaretOffset(row, mergeResult) {
    const textLength = getAutoInsertRowTextLength(row);
    if (mergeResult && mergeResult.caretPosition === 'end') {
      return textLength;
    }

    if (
      mergeResult &&
      mergeResult.caretPosition === 'offset' &&
      Number.isFinite(Number(mergeResult.caretOffset))
    ) {
      return api.site.clamp(Number(mergeResult.caretOffset), 0, textLength);
    }

    return 0;
  }


  function focusAutoInsertResultRow(fallbackRow, mergeResult) {
    const row = getAutoInsertFocusedRow(fallbackRow, mergeResult);
    if (!(row instanceof HTMLTableRowElement) || typeof helper.focusRow !== 'function') {
      return {
        ok: false,
        reason: 'missing-row'
      };
    }

    const caretOffset = getAutoInsertCaretOffset(row, mergeResult);
    const focused = helper.focusRow(row, {
      activateRow: false,
      selectionStart: caretOffset,
      selectionEnd: caretOffset
    });
    return {
      ok: Boolean(focused),
      caretOffset,
      rowIdentity: typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null
    };
  }


  function serializeAutoInsertMergeResult(mergeResult) {
    if (!mergeResult || typeof mergeResult !== 'object') {
      return mergeResult || null;
    }

    const { row: _row, results, ...rest } = mergeResult;
    return {
      ...rest,
      results: Array.isArray(results)
        ? results.map((result) => {
          if (!result || typeof result !== 'object') {
            return result;
          }

          const { row: _resultRow, ...serializableResult } = result;
          return serializableResult;
        })
        : results
    };
  }


  helper.autoInsertSegmentAtCaret = async function autoInsertSegmentAtCaret() {
    if (helper.state.autoSegmentationPending) {
      return {
        ok: false,
        reason: 'auto-segmentation-pending',
        createCount: 0
      };
    }

    if (typeof helper.createSegmentWithNativeAction !== 'function') {
      return {
        ok: false,
        reason: 'missing-create-action',
        createCount: 0
      };
    }

    const targets = await collectAutoInsertSegmentLaneTargets();
    if (!targets.length) {
      return {
        ok: false,
        reason: 'missing-visible-lanes',
        createCount: 0
      };
    }

    helper.state.autoSegmentationPending = true;
    api.progress.updateLongTaskProgress({
      label: 'Creating segment near caret',
      current: 0,
      total: targets.length,
      detail: 'Scanning visible lanes'
    });

    try {
      const scanned = await Promise.all(
        targets.map(async (target) => ({
          target,
          islandResult: await requestNearestSpeechIslandForLane(target)
        }))
      );

      let createCount = 0;
      let trimCount = 0;
      let mergeCount = 0;
      let skippedCount = 0;
      const results = [];

      for (let index = 0; index < scanned.length; index += 1) {
        const { target, islandResult } = scanned[index];
        api.progress.updateLongTaskProgress({
          label: 'Creating segment near caret',
          current: index,
          total: scanned.length,
          detail: 'Created ' + createCount + ' segments'
        });

        if (!islandResult || !islandResult.ok) {
          results.push({
            ok: false,
            trackId: target.trackId,
            reason: islandResult && islandResult.reason ? islandResult.reason : 'bridge-failed',
            island: islandResult || null
          });
          continue;
        }

        if (islandResult.skipped || !islandResult.foundAudio) {
          skippedCount += 1;
          results.push({
            ok: true,
            changed: false,
            trackId: target.trackId,
            reason: islandResult.reason || 'no-nearest-speech',
            island: islandResult
          });
          continue;
        }

        const startSeconds = Number(islandResult.targetStartSeconds);
        const endSeconds = Number(islandResult.targetEndSeconds);
        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
          results.push({
            ok: false,
            trackId: target.trackId,
            reason: 'invalid-island-range',
            island: islandResult
          });
          continue;
        }

        const createResult = await helper.createSegmentWithNativeAction({
          processedRecordingId: target.trackId,
          speakerKey: target.speakerKey,
          startSeconds,
          endSeconds,
          attempts: 2,
          retryDelayMs: 80
        });
        if (!createResult || !createResult.ok) {
          results.push({
            ok: false,
            trackId: target.trackId,
            reason: createResult && createResult.reason ? createResult.reason : 'create-failed',
            island: islandResult,
            create: createResult || null
          });
          continue;
        }

        createCount += 1;
        const trimTarget = await waitForAutoInsertTrimTarget(target, createResult, islandResult);
        const trimOptions = {
          progressLabel: 'Trimming inserted segment',
          keepProgress: true
        };
        const trimResult = trimTarget
          ? await api.trim.trimSegmentTarget(trimTarget, trimOptions)
          : null;
        const mergeResult =
          trimTarget && trimResult && trimResult.ok
            ? await mergeAutoInsertAdjacentRows(trimTarget.row)
            : null;
        const focusResult =
          trimTarget && trimResult && trimResult.ok
            ? focusAutoInsertResultRow(trimTarget.row, mergeResult)
            : null;
        if (trimResult && trimResult.ok) {
          trimCount += 1;
        }
        if (mergeResult && mergeResult.ok && Number.isFinite(Number(mergeResult.mergeCount))) {
          mergeCount += Number(mergeResult.mergeCount);
        }

        results.push({
          ok: Boolean(trimResult && trimResult.ok && (!mergeResult || mergeResult.ok)),
          changed: true,
          trackId: target.trackId,
          island: islandResult,
          create: createResult,
          trim: trimResult || { ok: false, reason: 'created-row-not-found' },
          merge: serializeAutoInsertMergeResult(mergeResult),
          focus: focusResult
        });
        api.progress.updateLongTaskProgress({
          label: 'Creating segment near caret',
          current: index + 1,
          total: scanned.length,
          detail: 'Created ' + createCount + ' segments'
        });
        await helper.sleep(16);
      }

      const ok = createCount > 0;
      const finalResult = {
        ok,
        changed: ok,
        reason: ok ? null : 'no-nearest-speech',
        laneCount: targets.length,
        createCount,
        trimCount,
        mergeCount,
        skippedCount,
        results
      };
      return finalResult;
    } finally {
      helper.state.autoSegmentationPending = false;
      api.progress.dismissLongTaskProgress();
    }
  };

  return {};
}
