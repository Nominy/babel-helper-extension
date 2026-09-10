// @ts-nocheck
import { matchesShortcut } from '../core/shortcuts';
import type { RowModules } from '../services/row-service';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';
import { readBabelTrackBindings } from '@nominy/babel-babel-runtime';

export function registerSpeakerWorkflow(helper: any, api: Pick<RowModules, 'playback' | 'cursor'>) {
  helper.state.speakerSwitchPending = false;


  function normalizeSpeakerLabel(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    const match = text.match(/\bspeaker\s*([12])\b/i);
    if (!match) {
      return '';
    }

    return 'Speaker ' + match[1];
  }


  function recordSpeakerWorkflow(stage, details) {
    const data = {
      stage,
      ...(details && typeof details === 'object' ? details : {})
    };
    try {
      document.documentElement.dataset.babelHelperSpeakerWorkflow = JSON.stringify(data);
    } catch (_error) {
      document.documentElement.dataset.babelHelperSpeakerWorkflow = stage;
    }
    if (helper.analytics) {
      helper.analytics.record('speaker-workflow:state', data);
    }
  }


  helper.switchSpeakerWorkflow = async function switchSpeakerWorkflow(targetSpeakerLabel) {
    if (typeof helper.isFeatureEnabled === 'function' && !helper.isFeatureEnabled('speakerWorkflowHotkeys')) {
      return false;
    }

    if (
      helper.runtime &&
      typeof helper.runtime.isSessionInteractive === 'function' &&
      !helper.runtime.isSessionInteractive()
    ) {
      return false;
    }

    const targetLabel = normalizeSpeakerLabel(targetSpeakerLabel);
    if (!targetLabel) {
      return false;
    }

    if (helper.state.speakerSwitchPending) {
      return false;
    }

    helper.state.speakerSwitchPending = true;

    try {
      const result = await api.playback.callPlaybackBridge('speaker-workflow', { targetLabel });
      const ok = Boolean(result?.ok);
      if (ok) {
        api.cursor.setGhostCursorLaneLockForSpeaker(targetLabel, 'manual');
        recordSpeakerWorkflow('switch-ok', { targetLabel });
      } else {
        recordSpeakerWorkflow('switch-failed', { targetLabel, reason: result?.reason || 'bridge-unavailable' });
      }
      return ok;
    } finally {
      helper.state.speakerSwitchPending = false;
    }
  };


  helper.resetSpeakerWorkflow = async function resetSpeakerWorkflow() {
    if (typeof helper.isFeatureEnabled === 'function' && !helper.isFeatureEnabled('speakerWorkflowHotkeys')) {
      return false;
    }

    if (
      helper.runtime &&
      typeof helper.runtime.isSessionInteractive === 'function' &&
      !helper.runtime.isSessionInteractive()
    ) {
      return false;
    }

    if (helper.state.speakerSwitchPending) {
      return false;
    }

    helper.state.speakerSwitchPending = true;

    try {
      const result = await api.playback.callPlaybackBridge('speaker-workflow', { targetLabel: null });
      const ok = Boolean(result?.ok);
      if (ok) {
        api.cursor.setGhostCursorLaneLockAuto();
        recordSpeakerWorkflow('reset-ok', {});
      } else {
        recordSpeakerWorkflow('reset-failed', { reason: result?.reason || 'bridge-unavailable' });
      }
      return ok;
    } finally {
      helper.state.speakerSwitchPending = false;
    }
  };

  return { normalizeSpeakerLabel };
}

export function registerSpeakerInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;

  hooks.on('keydown', (event) => {
    let handled = false;
    if (isFeatureEnabled('rowActions') &&
      isFeatureEnabled('speakerWorkflowHotkeys') &&
      matchesShortcut(helper.config?.shortcuts, 'speaker.first', event, helper.state?.rightShiftPressed) &&
      typeof helper.switchSpeakerWorkflow === 'function') {
      handled = true;
      void helper.switchSpeakerWorkflow('Speaker 1');
      if (helper.analytics) {
        helper.analytics.record('hotkey:speaker-switch', { speaker: 'Speaker 1' });
      }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 90);
  hooks.on('keydown', (event) => {
    let handled = false;
    if (isFeatureEnabled('rowActions') &&
      isFeatureEnabled('speakerWorkflowHotkeys') &&
      matchesShortcut(helper.config?.shortcuts, 'speaker.second', event, helper.state?.rightShiftPressed) &&
      typeof helper.switchSpeakerWorkflow === 'function') {
      handled = true;
      void helper.switchSpeakerWorkflow('Speaker 2');
      if (helper.analytics) {
        helper.analytics.record('hotkey:speaker-switch', { speaker: 'Speaker 2' });
      }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 91);
  hooks.on('keydown', (event) => {
    let handled = false;
    if (isFeatureEnabled('rowActions') &&
      isFeatureEnabled('speakerWorkflowHotkeys') &&
      matchesShortcut(helper.config?.shortcuts, 'speaker.reset', event, helper.state?.rightShiftPressed) &&
      typeof helper.resetSpeakerWorkflow === 'function') {
      handled = true;
      void helper.resetSpeakerWorkflow();
      if (helper.analytics) {
        helper.analytics.record('hotkey:speaker-reset', {});
      }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 92);
}

export async function setSpeakerWorkflow(targetLabel) {
  const bindings = readBabelTrackBindings();
  if (!bindings?.setFilter) return { ok: false, reason: 'track-controls-unavailable' };
  const lanes = ['Speaker 1', 'Speaker 2'].map(label => bindings.tracks.find(track => track.label === label));
  if (lanes.some(lane => !lane) || (targetLabel !== null && !lanes.some(lane => lane.label === targetLabel))) {
    return { ok: false, reason: 'speaker-unavailable' };
  }
  const desired = lanes.map(lane => ({
    id: lane.id,
    collapsed: targetLabel !== null && lane.label !== targetLabel,
    muted: targetLabel !== null && lane.label !== targetLabel
  }));
  const filterValue = targetLabel === null ? 'all' : lanes.find(lane => lane.label === targetLabel).id;
  // Call each toggle at most once using committed state. Collapsed tracks
  // retain the mute callback, so no temporary expansion is necessary.
  lanes.forEach((lane, index) => {
    if (lane.collapsed !== desired[index].collapsed) lane.toggleCollapsed();
    if (lane.muted !== desired[index].muted) lane.toggleMuted();
  });
  if (bindings.filterValue !== filterValue) bindings.setFilter(filterValue);
  const deadline = Date.now() + 350;
  do {
    await new Promise(resolve => window.setTimeout(resolve, 16));
    const current = readBabelTrackBindings();
    if (current?.reviewActionId !== bindings.reviewActionId) return { ok: false, reason: 'stale-task' };
    if (current.filterValue === filterValue && desired.every(expected => {
      const lane = current.tracks.find(track => track.id === expected.id);
      return lane?.collapsed === expected.collapsed && lane?.muted === expected.muted;
    })) return { ok: true };
  } while (Date.now() < deadline);
  return { ok: false, reason: 'track-state-unsettled' };
}
