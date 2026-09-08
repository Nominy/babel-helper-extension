// @ts-nocheck
import { getCurrentL0TimingIndex } from '../content/l0-timing-listener';
import { buildCurrentL0TimingTaskId, getPreferredL0TimingLaneKey, resolveL0TimingTrack } from '../services/l0-timing-identity';
import { transcribeEmptySegmentWithL0 } from './segment-transcription/request';
import { requestGoldDraftingAiBroker } from '../services/gold-drafting-ai-broker';
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerSegmentTranscription(helper: any, api: Pick<TimelineModules, 'site' | 'segmentation' | 'progress'>) {

  helper.transcribeCurrentSegmentWithL0 = async function transcribeCurrentSegmentWithL0() {
    const target = api.site.findCurrentSegmentTarget();
    if (!target) {
      return { ok: false, reason: 'missing-current-segment' };
    }

    const textarea = helper.getRowTextarea(target.row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return { ok: false, reason: 'missing-current-textarea' };
    }
    if (api.segmentation.normalizeAutoSegmentRedistributionText(helper.getRowTextValue(target.row))) {
      return { ok: false, reason: 'segment-not-empty' };
    }

    const range = api.site.getRowTimeRange(target.row);
    if (!range) {
      return { ok: false, reason: 'missing-current-range' };
    }
    const rowIdentity =
      typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(target.row) : null;
    if (!rowIdentity) {
      return { ok: false, reason: 'missing-current-row-identity' };
    }

    const laneAliases = api.segmentation.getL0TimingLaneAliases(target.row, target.speakerKey);
    const timingIndex = getCurrentL0TimingIndex(helper.state, helper);
    const timingTrack = timingIndex ? resolveL0TimingTrack(timingIndex, laneAliases) : null;
    if (timingIndex && !timingTrack && !laneAliases.stableId) {
      return { ok: false, reason: 'ambiguous-current-speaker' };
    }
    const speakerKey = timingTrack?.lane || getPreferredL0TimingLaneKey(laneAliases);
    if (!speakerKey) {
      return { ok: false, reason: 'missing-current-speaker' };
    }

    const taskId = buildCurrentL0TimingTaskId(helper);
    const rows = helper.getTranscriptRows();
    const rowIndex = Array.isArray(rows) ? rows.indexOf(target.row) : -1;
    const rowId =
      typeof rowIdentity.annotationId === 'string' && rowIdentity.annotationId.trim()
        ? rowIdentity.annotationId.trim()
        : [
          speakerKey,
          Math.round(range.startSeconds * 1000),
          Math.round(range.endSeconds * 1000)
        ].join(':');

    api.progress.updateL0SegmentTranscriptionProgress(null, range);
    let keepFailureProgress = false;
    try {
      const result = await transcribeEmptySegmentWithL0({
        taskId,
        rowIdentity,
        rowId,
        speakerKey,
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
        index: Math.max(0, rowIndex),
        request: (request) =>
          requestGoldDraftingAiBroker(request, {
            onEvent: (event) => api.progress.updateL0SegmentTranscriptionProgress(event, range)
          }),
        getCurrentTaskId: () => buildCurrentL0TimingTaskId(helper),
        resolveCurrentRow: (identity) => {
          const currentRow = typeof helper.getCurrentActionRow === 'function'
            ? helper.getCurrentActionRow({ allowFallback: false })
            : api.site.findCurrentSegmentTarget()?.row;
          if (!(currentRow instanceof HTMLTableRowElement)) return null;
          if (
            typeof helper.rowMatchesIdentity === 'function' &&
            !helper.rowMatchesIdentity(currentRow, identity)
          ) {
            return null;
          }
          return currentRow;
        },
        isRowEmpty: (row) =>
          !api.segmentation.normalizeAutoSegmentRedistributionText(helper.getRowTextValue(row)) &&
          !api.segmentation.normalizeAutoSegmentRedistributionText(helper.getRowTextarea(row)?.value || ''),
        writeRowText: (row, text) => {
          const currentTextarea = helper.getRowTextarea(row);
          return currentTextarea instanceof HTMLTextAreaElement
            ? helper.setEditableValue(currentTextarea, text)
            : false;
        }
      });

      if (!result || !result.ok) {
        keepFailureProgress = true;
        api.progress.showL0SegmentTranscriptionFailure(result);
        return result;
      }
      api.progress.updateLongTaskProgress({
        label: 'Transcribing current segment',
        current: 100,
        total: 100,
        percent: 100,
        detail: 'Applied free L0 transcription'
      });
      return result;
    } finally {
      if (!keepFailureProgress) {
        api.progress.dismissLongTaskProgress();
      }
    }
  };

  return {};
}
