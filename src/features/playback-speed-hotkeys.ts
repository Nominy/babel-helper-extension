// @ts-nocheck
import { matchesShortcut } from '../core/shortcuts';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';
import { readBabelPlaybackBindings } from '@nominy/babel-babel-runtime';

export function registerPlaybackSpeedInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;
  function recordPlaybackSpeedHotkey(event, direction, result) {
    if (!helper.analytics) {
      return;
    }

    helper.analytics.record('hotkey:playback-speed', {
      key: event.key,
      code: event.code,
      direction,
      ...(result && typeof result === 'object' ? result : {})
    });
  }
  hooks.on('keydown', (event) => {
    if (
      isFeatureEnabled('rowActions') &&
      isFeatureEnabled('playbackSpeedHotkeys') &&
      matchesShortcut(helper.config?.shortcuts, 'playback.faster', event, helper.state?.rightShiftPressed) &&
      !isTypingInTextControl(event) &&
      typeof helper.adjustPlaybackSpeed === 'function'
    ) {
      event.preventDefault();
      event.stopPropagation();
      void helper.adjustPlaybackSpeed(1).then((result) =>
        recordPlaybackSpeedHotkey(event, 1, result)
      );
      return true;
    }
    if (
      isFeatureEnabled('rowActions') &&
      isFeatureEnabled('playbackSpeedHotkeys') &&
      matchesShortcut(helper.config?.shortcuts, 'playback.slower', event, helper.state?.rightShiftPressed) &&
      !isTypingInTextControl(event) &&
      typeof helper.adjustPlaybackSpeed === 'function'
    ) {
      event.preventDefault();
      event.stopPropagation();
      void helper.adjustPlaybackSpeed(-1).then((result) =>
        recordPlaybackSpeedHotkey(event, -1, result)
      );
      return true;
    }
  }, 30);
}

export function installNativeSpeedFix() {
  const speedPatches = new Map();
  function patchNativeSpeed() {
    const waves = readBabelPlaybackBindings()?.waves || [];
    for (const [wave, patch] of speedPatches) {
      if (waves.includes(wave)) continue;
      if (wave.setPlaybackRate === patch.wrapped) wave.setPlaybackRate = patch.original;
      speedPatches.delete(wave);
    }
    for (const wave of waves) {
      if (speedPatches.has(wave)) continue;
      const original = wave.setPlaybackRate;
      if (typeof original !== 'function' || typeof wave.seekTo !== 'function') continue;
      function wrapped(...args) {
        const time = this.getCurrentTime();
        const result = original.apply(this, args);
        const duration = this.getDuration();
        // Babel's native speed control changes the WebAudio time base.
        // Restore this lane after the rate change, including native UI calls.
        if (Number.isFinite(time) && duration > 0) this.seekTo(Math.max(0, Math.min(1, time / duration)));
        return result;
      }
      wave.setPlaybackRate = wrapped;
      speedPatches.set(wave, { original, wrapped });
    }
  }
  const speedObserver = new MutationObserver(patchNativeSpeed);
  speedObserver.observe(document, { childList: true, subtree: true });
  patchNativeSpeed();

  return {
    patchNativeSpeed, dispose() {
      speedObserver.disconnect();
      for (const [wave, patch] of speedPatches) {
        if (wave.setPlaybackRate === patch.wrapped) wave.setPlaybackRate = patch.original;
      }
      speedPatches.clear();
    }
  };
}
