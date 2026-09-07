import { createRowSiteApi } from '../site/rows';
import { createRowTimeApi } from '../site/row-time';
import { createPlaybackSiteApi } from '../site/playback';
import { registerGhostCursor } from '../features/ghost-cursor';
import { registerSpeakerWorkflow } from '../features/speaker-workflow';
import { registerRowActions } from '../features/row-actions-feature';
import { registerTextMove } from '../features/text-move-feature';
import { registerFocusToggle } from '../features/focus-toggle-feature';

export type RowModules = {
  rows: ReturnType<typeof createRowSiteApi>;
  time: ReturnType<typeof createRowTimeApi>;
  playback: ReturnType<typeof createPlaybackSiteApi>;
  cursor: ReturnType<typeof registerGhostCursor>;
  speaker: ReturnType<typeof registerSpeakerWorkflow>;
  actions: ReturnType<typeof registerRowActions>;
  text: ReturnType<typeof registerTextMove>;
  focus: ReturnType<typeof registerFocusToggle>;
};

// This is the composition root. Modules share per-session API references;
// callbacks resolve their dependencies when invoked, after registration completes.
export function registerRowService(helper: any) {
  if (!helper || helper.__rowsRegistered) {
    return;
  }
  helper.__rowsRegistered = true;
  const api = {} as RowModules;
  api.rows = createRowSiteApi(helper, api);
  api.time = createRowTimeApi(helper);
  api.playback = createPlaybackSiteApi(helper);
  api.cursor = registerGhostCursor(helper, api);
  api.speaker = registerSpeakerWorkflow(helper, api);
  api.actions = registerRowActions(helper, api);
  api.text = registerTextMove(helper);
  api.focus = registerFocusToggle(helper, api);
}
