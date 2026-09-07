// @ts-nocheck
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerTimelineEdgeAdjustment(helper: any, api: Pick<TimelineModules, 'selection' | 'site' | 'loop' | 'trim'>) {
  helper.state.timelineEdgeClickDraft = null;


  function isAltTimelineEdgeClickEvent(event) {
    return Boolean(
      event &&
      event.button === 0 &&
      event.altKey &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey
    );
  }


  function getAltClickTimelineEdgeDraft(event) {
    if (!isAltTimelineEdgeClickEvent(event)) {
      return null;
    }

    const plainAlt = event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
    if (!plainAlt) {
      return null;
    }

    const lane = api.selection.getTimelineLaneFromEvent(event);
    if (!lane || !(lane.container instanceof HTMLElement)) {
      return null;
    }

    const containerRect = lane.container.getBoundingClientRect();
    if (containerRect.width <= 0 || containerRect.height <= 0) {
      return null;
    }

    api.site.rememberCutContainer(lane.container);

    return {
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : 1,
      sourceRegion: lane.sourceRegion,
      container: lane.container,
      containerRect,
      startClientX: api.site.clamp(event.clientX, containerRect.left, containerRect.right),
      startClientY: api.site.clamp(event.clientY, containerRect.top, containerRect.bottom)
    };
  }


  function suppressAltTimelineEdgeEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }


  async function resolveAltClickTimelinePointSeconds(draft, event) {
    const lane =
      draft && draft.container instanceof HTMLElement && draft.container.isConnected
        ? {
          container: draft.container
        }
        : api.selection.getTimelineLaneFromEvent(event);
    if (!lane || !(lane.container instanceof HTMLElement) || !api.site.isVisibleWaveformContainer(lane.container)) {
      return null;
    }

    const containerRect = lane.container.getBoundingClientRect();
    if (containerRect.width <= 0) {
      return null;
    }

    const hostMarker = api.loop.ensureSelectionHostMarker(lane.container);
    if (!hostMarker) {
      return null;
    }

    const localX = api.site.clamp(event.clientX - containerRect.left, 0, containerRect.width);
    const result = await api.site.callSelectionBridge('selection-time-range', {
      hostMarker,
      leftPx: localX,
      rightPx: localX + 1
    });

    const startSeconds = Number(result && result.startSeconds);
    return result && result.ok && Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : null;
  }


  function getAltClickTargetSeconds(candidate, localX, laneTargetSeconds) {
    const bridgeTargetSeconds =
      candidate && Number.isFinite(candidate.bridgeTargetSeconds)
        ? candidate.bridgeTargetSeconds
        : null;
    if (Number.isFinite(bridgeTargetSeconds)) {
      return Math.max(0, bridgeTargetSeconds);
    }

    if (Number.isFinite(laneTargetSeconds)) {
      return Math.max(0, laneTargetSeconds);
    }

    if (!candidate || !candidate.entry || !candidate.rowRange) {
      return null;
    }

    const width = candidate.entry.rightPx - candidate.entry.leftPx;
    const duration = candidate.rowRange.endSeconds - candidate.rowRange.startSeconds;
    if (!(width > 0) || !(duration > 0)) {
      return candidate.side === 'left'
        ? candidate.rowRange.startSeconds
        : candidate.rowRange.endSeconds;
    }

    const ratio = (localX - candidate.entry.leftPx) / width;
    return Math.max(0, candidate.rowRange.startSeconds + ratio * duration);
  }


  function chooseNearestAltClickTimelineBoundary(draft, event) {
    const lane =
      draft && draft.container instanceof HTMLElement && draft.container.isConnected
        ? {
          container: draft.container,
          sourceRegion: draft.sourceRegion instanceof HTMLElement ? draft.sourceRegion : null
        }
        : api.selection.getTimelineLaneFromEvent(event);
    if (!lane || !(lane.container instanceof HTMLElement)) {
      return null;
    }

    const container = lane.container;
    if (!api.site.isVisibleWaveformContainer(container)) {
      return null;
    }

    const speakerKey = api.site.getSpeakerKeyForContainer(container);
    const containerRect = container.getBoundingClientRect();
    if (containerRect.width <= 0) {
      return null;
    }

    const localX = api.site.clamp(event.clientX - containerRect.left, 0, containerRect.width);
    const laneScale = api.site.getLaneTimeScale(container);
    const laneTargetSeconds =
      laneScale && Number.isFinite(laneScale.secondsPerPx) && laneScale.secondsPerPx > 0
        ? laneScale.offsetSeconds + localX * laneScale.secondsPerPx
        : null;
    const snapshot = api.site.collectRegionSnapshot(container);
    if (!snapshot) {
      return null;
    }

    const sourceEntry =
      lane.sourceRegion instanceof HTMLElement
        ? snapshot.bounds.find((entry) => entry.region === lane.sourceRegion) || null
        : null;
    const entries = sourceEntry ? [sourceEntry] : snapshot.bounds;
    let candidate = null;
    let bestDistance = Infinity;

    for (const entry of entries) {
      if (!entry || !entry.startText || !entry.endText) {
        continue;
      }

      const row = api.site.findRowByTimeLabels(entry.startText, entry.endText, {
        speakerKey
      });
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      const rowRange = api.site.getRowTimeRange(row);
      const labels = api.site.getRowTimeLabels(row);
      if (!rowRange || !labels) {
        continue;
      }

      const leftDistance = Math.abs(localX - entry.leftPx);
      const rightDistance = Math.abs(localX - entry.rightPx);
      const side = leftDistance <= rightDistance ? 'left' : 'right';
      const distance = side === 'left' ? leftDistance : rightDistance;
      if (distance < bestDistance) {
        candidate = {
          row,
          rowRange,
          labels,
          entry,
          side,
          bridgeTargetSeconds:
            draft && Number.isFinite(draft.bridgeTargetSeconds)
              ? draft.bridgeTargetSeconds
              : null
        };
        bestDistance = distance;
      }
    }

    if (!candidate) {
      return null;
    }

    let targetSeconds = getAltClickTargetSeconds(candidate, localX, laneTargetSeconds);
    if (!Number.isFinite(targetSeconds)) {
      return null;
    }

    targetSeconds = api.trim.capOutwardBoundaryTarget(candidate.row, candidate.side, speakerKey, targetSeconds);
    const rowRange = candidate.rowRange;
    if (
      candidate.side === 'right' &&
      targetSeconds <= rowRange.startSeconds + api.trim.AUDIO_TRIM_EPSILON_SECONDS
    ) {
      return null;
    }

    if (
      candidate.side === 'left' &&
      targetSeconds >= rowRange.endSeconds - api.trim.AUDIO_TRIM_EPSILON_SECONDS
    ) {
      return null;
    }

    const currentBoundarySeconds =
      candidate.side === 'left' ? rowRange.startSeconds : rowRange.endSeconds;
    if (Math.abs(targetSeconds - currentBoundarySeconds) <= api.trim.AUDIO_TRIM_EPSILON_SECONDS) {
      return null;
    }

    return {
      row: candidate.row,
      labels: candidate.labels,
      speakerKey,
      container,
      entry: candidate.entry,
      side: candidate.side,
      targetSeconds
    };
  }


  helper.adjustNearestTimelineSegmentEdgeFromAltClick = async function adjustNearestTimelineSegmentEdgeFromAltClick(draft, event) {
    const bridgeTargetSeconds = await resolveAltClickTimelinePointSeconds(draft, event);
    if (draft && typeof draft === 'object') {
      if (Number.isFinite(bridgeTargetSeconds)) {
        draft.bridgeTargetSeconds = bridgeTargetSeconds;
      } else {
        delete draft.bridgeTargetSeconds;
      }
    }

    const move = chooseNearestAltClickTimelineBoundary(draft, event);
    if (!move) {
      return {
        ok: false,
        reason: 'missing-alt-click-boundary'
      };
    }

    helper.state.cutCommitPending = true;
    try {
      api.site.rememberTimelineSegmentTarget(move.row, move.container, move.entry, move.speakerKey);
      const result = await api.trim.moveSegmentBoundary(move.side, move.labels, move.speakerKey, move.targetSeconds, move.row);
      if (!result || !result.ok) {
        return {
          ok: false,
          reason: 'alt-click-boundary-move-failed',
          verification: result || null
        };
      }

      const labels = api.trim.getCurrentMoveLabels(move.row, move.labels);
      if (helper.state.currentTimelineTarget && helper.state.currentTimelineTarget.row === move.row) {
        helper.state.currentTimelineTarget.startText = labels.startText;
        helper.state.currentTimelineTarget.endText = labels.endText;
      }

      return {
        ok: true,
        changed: true,
        side: move.side,
        targetSeconds: move.targetSeconds,
        verification: result
      };
    } finally {
      helper.state.cutCommitPending = false;
    }
  };

  return { isAltTimelineEdgeClickEvent, getAltClickTimelineEdgeDraft, suppressAltTimelineEdgeEvent };
}
