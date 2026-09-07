import { createTimelineSiteApi } from '../site/timeline';
import { createLongTaskProgress } from '../ui/long-task-progress';
import { registerZoomPersistence } from '../features/zoom-persistence';
import { registerAudioTrim } from '../features/audio-trim';
import { registerSmartSplit } from '../features/smart-split';
import { registerAutoSegmentation } from '../features/auto-segmentation';
import { registerAutoInsertSegment } from '../features/auto-insert-segment';
import { registerSegmentTranscription } from '../features/segment-transcription';
import { registerSelectionLoop } from '../features/selection-loop';
import { registerTimelineEdgeAdjustment } from '../features/timeline-edge-adjustment';
import { registerTimelineSelection } from '../features/timeline-selection-feature';

export type TimelineModules = {
  site: ReturnType<typeof createTimelineSiteApi>;
  progress: ReturnType<typeof createLongTaskProgress>;
  zoom: ReturnType<typeof registerZoomPersistence>;
  trim: ReturnType<typeof registerAudioTrim>;
  split: ReturnType<typeof registerSmartSplit>;
  segmentation: ReturnType<typeof registerAutoSegmentation>;
  insert: ReturnType<typeof registerAutoInsertSegment>;
  transcription: ReturnType<typeof registerSegmentTranscription>;
  loop: ReturnType<typeof registerSelectionLoop>;
  edge: ReturnType<typeof registerTimelineEdgeAdjustment>;
  selection: ReturnType<typeof registerTimelineSelection>;
};

// This is the composition root. Modules share per-session API references;
// callbacks resolve their dependencies when invoked, after registration completes.
export function registerTimelineSelectionService(helper: any) {
  if (!helper || helper.__cutRegistered) {
    return;
  }
  helper.__cutRegistered = true;
  const api = {} as TimelineModules;
  api.site = createTimelineSiteApi(helper);
  api.progress = createLongTaskProgress(helper, api);
  api.zoom = registerZoomPersistence(helper, api);
  api.trim = registerAudioTrim(helper, api);
  api.split = registerSmartSplit(helper, api);
  api.segmentation = registerAutoSegmentation(helper, api);
  api.insert = registerAutoInsertSegment(helper, api);
  api.transcription = registerSegmentTranscription(helper, api);
  api.loop = registerSelectionLoop(helper, api);
  api.edge = registerTimelineEdgeAdjustment(helper, api);
  api.selection = registerTimelineSelection(helper, api);
}
