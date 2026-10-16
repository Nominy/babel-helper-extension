// @ts-nocheck
import { matchesShortcut } from '../core/shortcuts';
import { getCurrentL0PlaybackTimingIndex } from '../content/l0-timing-listener';
import {
  createL0TimingAlignmentCache,
  isPublishedL0TimingIndex,
  computePreparedL0TimedCharacterOffset,
  computePreparedL0TimestampAtCharacterOffset
} from '../services/l0-word-timing-alignment';
import { buildL0TimingLaneAliases, resolveL0TimingTrack } from '../services/l0-timing-identity';
import { AUDIO_ENHANCEMENT_STATE_EVENT, readAudioEnhancementState } from '@nominy/babel-babel-runtime';
import { readNativeSessionState } from '../site/editor-control';
import type { RowModules } from '../services/row-service';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerGhostCursor(helper: any, api: Pick<RowModules, 'time' | 'speaker' | 'playback'>) {

  const PROPORTIONAL_MIN_DELTA_SECONDS = 0.3;

  let playbackGeneration = 0;
  let cursorGeneration = 0;
  let sourceContext = readAudioEnhancementState();
  let activeTaskGuard: (() => boolean) | null = null;
  let unsubscribePlayback: (() => void) | null = null;
  let renderedRow: HTMLElement | null = null;
  let renderedTop: number | null = null;
  let recordingTracks = [];
  let recordingIds = new Set();
  const timingAlignmentCache = createL0TimingAlignmentCache();
  let timingRowsIndex = null;
  let timingRows = new WeakMap();
  let timingRowEntries = null;

  function invalidatePlaybackContext() {
    playbackGeneration += 1;
    timingAlignmentCache.clear();
    timingRowsIndex = null;
    timingRows = new WeakMap();
    timingRowEntries = null;
    helper.state.ghostCursorPlaybackTime = null;
    helper.state.ghostCursorPlaybackPaused = null;
    for (const projection of Object.values(getGhostCursorLaneProjections())) {
      projection.timingValid = false;
      projection.playbackTime = null;
    }
    if (helper.state.ghostCursorElement) helper.state.ghostCursorElement.style.display = 'none';
  }

  function refreshPlaybackContext() {
    const next = readAudioEnhancementState();
    const changed =
      next?.taskId !== sourceContext?.taskId ||
      next?.strength !== sourceContext?.strength ||
      next?.variantKey !== sourceContext?.variantKey ||
      next?.pairedVariantKey !== sourceContext?.pairedVariantKey ||
      (next?.status === 'switching') !== (sourceContext?.status === 'switching');
    sourceContext = next;
    // Progress/message revisions do not change the loaded source or ownership.
    if (changed) invalidatePlaybackContext();
  }

  function isSourceSwitching() {
    refreshPlaybackContext();
    const taskId = readNativeSessionState()?.reviewActionId;
    return Boolean(taskId && sourceContext?.taskId === taskId && sourceContext.status === 'switching');
  }

  function captureNativeTaskGuard(): () => boolean {
    const session = readNativeSessionState();
    const reviewActionId = session?.reviewActionId;
    const routeKey = session?.routeKey;
    const href = window.location.href;
    const revision = helper.state.sessionLifecycleRevision;
    return () => {
      const current = readNativeSessionState();
      return Boolean(reviewActionId && current?.reviewActionId === reviewActionId &&
        current.readOnly === false && current.routeKey === routeKey && window.location.href === href &&
        revision === helper.state.sessionLifecycleRevision &&
        (!helper.runtime?.isSessionInteractive || helper.runtime.isSessionInteractive()));
    };
  }

  function capturePlaybackGuard(): () => boolean {
    if (activeTaskGuard && !activeTaskGuard()) stopGhostCursor(true);
    refreshPlaybackContext();
    const generation = playbackGeneration;
    const cursor = cursorGeneration;
    const revision = helper.state.sessionLifecycleRevision;
    const taskGuard = captureNativeTaskGuard();
    return () => {
      refreshPlaybackContext();
      return generation === playbackGeneration && cursor === cursorGeneration &&
        revision === helper.state.sessionLifecycleRevision && taskGuard() &&
        (!activeTaskGuard || activeTaskGuard()) &&
        (!helper.runtime?.isSessionInteractive || helper.runtime.isSessionInteractive());
    };
  }

  function onSourceChange(event) {
    if (activeTaskGuard && !activeTaskGuard()) {
      stopGhostCursor(true);
      return;
    }
    refreshPlaybackContext();
    if (document.hidden || isSourceSwitching()) {
      cursorGeneration += 1;
      if (helper.state.ghostCursorElement) helper.state.ghostCursorElement.style.display = 'none';
    }
  }


  // Reaction-time compensation: subtract this from restorePlaybackTime before
  // computing the proportional cursor offset. Accounts for the delay between
  // hearing a problem word and pressing Escape.  Tweak this value if the
  // cursor consistently lands too far forward or backward.
  const REACTION_TIME_OFFSET_SECONDS = 0.6;


  function snapToWordBoundary(text, offset) {
    if (!text || offset <= 0) { return 0; }
    if (offset >= text.length) { return text.length; }

    // If already at a word boundary (space before or at position 0), return as-is.
    if (offset === 0 || /\s/.test(text[offset - 1])) { return offset; }

    // Scan backward and forward for the nearest whitespace and pick the closer one.
    let backward = offset;
    while (backward > 0 && !/\s/.test(text[backward - 1])) { backward--; }

    let forward = offset;
    while (forward < text.length && !/\s/.test(text[forward])) { forward++; }
    // Position after the space (start of next word).
    if (forward < text.length) { forward++; }

    // Pick whichever boundary is closer to the raw offset.
    return (offset - backward) <= (forward - offset) ? backward : forward;
  }


  // ---------------------------------------------------------------------------
  // Ghost cursor: a live-updating orange bar on the blurred native turn that
  // shows where the cursor WOULD land if the user pressed Escape right now.
  // Gated behind proportionalCursorRestore.
  // ---------------------------------------------------------------------------

  const GHOST_CURSOR_TRANSITION_MS = 66;
  const GHOST_CURSOR_ATTR = 'data-babel-helper-ghost-cursor';




  function scrollToCaret(row, offset) {
    const textarea = helper.getRowEditor(row);
    if (!textarea) return;
    const scrollParent = textarea.element?.closest('[data-transcript-scroll]');
    if (!scrollParent) return;
    const caret = textarea.getCaretRect(offset);
    if (!caret) return;
    const viewport = scrollParent.getBoundingClientRect();
    scrollParent.scrollTop += caret.top + caret.height / 2 -
      (viewport.top + scrollParent.clientTop + scrollParent.clientHeight / 2);
  }


  /**
   * Compute the character offset the cursor should land at for a given
   * playback time, applying reaction-time compensation, word-boundary
   * snapping, and the monotonic baseline floor.
   *
   * Returns { offset, clamped } where `offset` is the final character
   * index and `clamped` is true when the baseline floor prevented the
   * cursor from advancing (i.e. the ghost cursor is "stuck").
   * Returns null if the position cannot be computed.
   */
  function computeRestoreOffset(text, timeRange, currentTime, blurTime, baseline) {
    if (!text || text.length === 0 || !timeRange) { return null; }
    const duration = timeRange.endSeconds - timeRange.startSeconds;
    if (duration <= 0) { return null; }

    const adjustedTime = Math.max(
      typeof blurTime === 'number' && Number.isFinite(blurTime) ? blurTime : timeRange.startSeconds,
      currentTime - REACTION_TIME_OFFSET_SECONDS
    );
    const ratio = Math.max(0, Math.min(1,
      (adjustedTime - timeRange.startSeconds) / duration
    ));
    const rawOffset = Math.round(ratio * text.length);
    const snapped = snapToWordBoundary(text, rawOffset);

    const floor = typeof baseline === 'number' && baseline >= 0 ? Math.min(text.length, baseline) : 0;
    const final = Math.max(floor, snapped);
    return { offset: final, clamped: final !== snapped };
  }


  function getL0AlignmentForRow(text, row, timeRange, index = getCurrentL0PlaybackTimingIndex(helper.state, helper)) {
    if (isSourceSwitching() || !index || !(row instanceof HTMLElement)) {
      if (timingRowsIndex !== null) {
        timingAlignmentCache.clear();
        timingRowsIndex = null;
        timingRows = new WeakMap();
      }
      return null;
    }
    if (timingRowsIndex !== index) {
      timingAlignmentCache.clear();
      timingRowsIndex = index;
      timingRows = new WeakMap();
    }
    const identity = helper.getRowIdentity(row) || {};
    const speakerKey = api.time.getRowSpeakerKeySafe(row);
    const laneMetadata = document.documentElement?.getAttribute('data-babel-recording-lanes');
    const published = isPublishedL0TimingIndex(index);
    let cached = published ? timingRows.get(row) : null;
    if (!cached || cached.processedRecordingId !== identity.processedRecordingId ||
        cached.speakerKey !== identity.speakerKey || cached.trackLabel !== identity.trackLabel ||
        cached.speakerLabel !== identity.speakerLabel || cached.lane !== identity.lane ||
        cached.displaySpeaker !== speakerKey || cached.laneMetadata !== laneMetadata) {
      cached = {
        processedRecordingId: identity.processedRecordingId,
        speakerKey: identity.speakerKey,
        trackLabel: identity.trackLabel,
        speakerLabel: identity.speakerLabel,
        lane: identity.lane,
        displaySpeaker: speakerKey,
        laneMetadata,
        track: resolveL0TimingTrack(index, buildL0TimingLaneAliases(identity, [speakerKey]))
      };
      if (published) timingRows.set(row, cached);
    }
    return cached.track ? timingAlignmentCache.get(index, cached.track, row, text, timeRange) : null;
  }


  function computeGhostCursorOffset(text, row, timeRange, currentTime, blurTime, baseline, timingIndex) {
    const alignment = getL0AlignmentForRow(text, row, timeRange, timingIndex);
    if (alignment) {
      const timedOffset = computePreparedL0TimedCharacterOffset(alignment, currentTime);
      if (timedOffset !== null) {
        const floor = typeof baseline === 'number' && baseline >= 0 ? Math.min(text.length, baseline) : 0;
        const final = Math.max(floor, timedOffset);
        return { offset: final, clamped: final !== timedOffset };
      }
    }
    return computeRestoreOffset(text, timeRange, currentTime, blurTime, baseline);
  }


  helper.getL0TimestampForRowOffset = function getL0TimestampForRowOffset(row, offset) {
    const range = api.time.getRowTimeRange(row);
    const textarea = helper.getRowEditor(row);
    if (!range || !textarea) return null;
    return computePreparedL0TimestampAtCharacterOffset(
      getL0AlignmentForRow(textarea.value || '', row, range), offset);
  };


  function getGhostCursorAppearance() {
    const configured = helper.settings?.ghostCursor;
    const isHexColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    const color = isHexColor(configured?.color) ? configured.color : '#f59e0b';
    const gradientColor = isHexColor(configured?.gradientColor) ? configured.gradientColor : '#fb7185';
    const thickness = Number.isFinite(Number(configured?.thickness))
      ? Math.max(1, Math.min(8, Math.round(Number(configured.thickness))))
      : 2;
    const motion = configured?.motion === 'snappy' || configured?.motion === 'balanced'
      ? configured.motion
      : 'slow';

    return {
      color,
      gradientColor,
      gradientEnabled: configured?.gradientEnabled === true,
      thickness,
      transitionMs: motion === 'snappy' ? 70 : motion === 'balanced' ? 130 : 220,
      animationDuration: motion === 'snappy' ? '0.9s' : motion === 'balanced' ? '1.8s' : '3.2s'
    };
  }


  function ensureGhostCursorGradientAnimation() {
    const styleAttribute = 'data-babel-helper-ghost-cursor-animation';
    if (document.querySelector(`style[${styleAttribute}]`)) {
      return;
    }

    const style = document.createElement('style');
    style.setAttribute(styleAttribute, '');
    style.textContent = `
      @keyframes babel-helper-ghost-cursor-gradient {
        from { background-position: 0 0, 0 0; }
        to { background-position: 0 100%, 0 0; }
      }
    `;
    (document.head || document.documentElement || document.body)?.appendChild(style);
  }


  function applyGhostCursorAppearance(el, clamped) {
    const appearance = getGhostCursorAppearance();
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const thickness = Math.max(1, Math.round(appearance.thickness * pixelRatio)) / pixelRatio;
    el.style.width = `${thickness}px`;
    el.style.borderRadius = `${Math.ceil(thickness / 2)}px`;
    // Animate a composited layer so movement stays smooth without relaying out
    // a narrow bar at fractional left/top positions.
    el.style.left = '0px';
    el.style.top = '0px';
    // Keep native-event updates responsive while preserving motion presets.
    el.style.transition = `transform ${appearance.transitionMs / 220 * GHOST_CURSOR_TRANSITION_MS}ms linear`;
    el.style.willChange = 'transform, background-position';
    if (clamped) {
      el.style.background = 'rgba(156, 163, 175, 0.6)';
      el.style.backgroundImage = 'none';
      el.style.backgroundSize = '';
      el.style.animation = 'none';
      return;
    }

    const { color, gradientColor } = appearance;
    el.style.backgroundColor = color;
    el.style.backgroundImage = appearance.gradientEnabled
      ? `linear-gradient(180deg, ${color}, ${gradientColor}, ${color})`
      : 'none';
    el.style.backgroundSize = appearance.gradientEnabled ? '100% 220%' : '';
    el.style.backgroundRepeat = 'no-repeat';
    if (appearance.gradientEnabled) {
      ensureGhostCursorGradientAnimation();
    }
    el.style.animation = appearance.gradientEnabled
      ? `babel-helper-ghost-cursor-gradient ${appearance.animationDuration} ease-in-out infinite alternate`
      : 'none';
  }


  function createGhostCursorElement() {
    const el = document.createElement('div');
    el.setAttribute(GHOST_CURSOR_ATTR, '');
    el.style.position = 'fixed';
    el.style.background = '#f59e0b';
    el.style.borderRadius = '1px';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '20';
    applyGhostCursorAppearance(el, false);
    return el;
  }


  function stopGhostCursor(discardPlayback = false) {
    cursorGeneration += 1;
    renderedRow = null;
    renderedTop = null;
    timingAlignmentCache.clear();
    timingRowsIndex = null;
    timingRows = new WeakMap();
    timingRowEntries = null;
    window.removeEventListener(AUDIO_ENHANCEMENT_STATE_EVENT, onSourceChange);
    document.removeEventListener('visibilitychange', onSourceChange);
    unsubscribePlayback?.();
    unsubscribePlayback = null;
    if (discardPlayback) {
      activeTaskGuard = null;
      recordingTracks = [];
      recordingIds.clear();
    }
    const wasActive = Boolean(helper.state.ghostCursorElement);
    if (helper.state.ghostCursorElement) {
      try {
        if (helper.state.ghostCursorElement.parentNode) {
          helper.state.ghostCursorElement.parentNode.removeChild(helper.state.ghostCursorElement);
        }
      } catch (_e) { /* ignore */ }
      helper.state.ghostCursorElement = null;
    }
    const stoppedRowId = helper.state.ghostCursorRow
      ? (helper.getRowIdentity(helper.state.ghostCursorRow)?.annotationId ?? null)
      : null;
    helper.state.ghostCursorRow = null;
    helper.state.ghostCursorRowIdentity = null;
    helper.state.ghostCursorOffset = null;
    // Keep valid same-task projections for Tab after Escape restores focus.
    // Session/navigation disposal drops their row references and transport.
    if (discardPlayback) {
      helper.state.ghostCursorLaneProjections = {};
      helper.state.ghostCursorPlaybackTime = null;
      helper.state.ghostCursorPlaybackPaused = null;
      helper.state.ghostCursorProjectionSpeakerKey = null;
      helper.state.ghostCursorDefaultProjectionSpeakerKey = null;
      helper.state.ghostCursorProjectionSource = 'auto';
    }

    if (wasActive && helper.analytics) {
      helper.analytics.record('ghost:stop', { rowId: stoppedRowId });
    }
  }


  function getGhostCursorLaneLock() {
    const lock = helper.state.ghostCursorLaneLock;
    return lock && typeof lock === 'object' && typeof lock.speakerKey === 'string' && lock.speakerKey
      ? lock
      : null;
  }


  function setGhostCursorLaneLock(row, source) {
    const speakerKey = api.time.getRowSpeakerKeySafe(row);
    if (!speakerKey) {
      helper.state.ghostCursorLaneLock = null;
      return null;
    }

    helper.state.ghostCursorLaneLock = {
      speakerKey,
      source: source || 'auto',
      acquiredAt: Date.now(),
      rowIdentity: helper.getRowIdentity(row)
    };
    return helper.state.ghostCursorLaneLock;
  }


  function setGhostCursorLaneLockForSpeaker(speakerLabel, source) {
    const normalized = getSpeakerKeyForGhostToggleLabel(speakerLabel);
    if (!normalized) {
      return null;
    }

    const row =
      api.time.getRowTimeEntries()
        .map((entry) => api.time.resolveRowTimeEntry(entry))
        .find((entry) => entry && api.time.getRowSpeakerKeySafe(entry.row) === normalized)?.row || null;

    helper.state.ghostCursorLaneLock = {
      speakerKey: normalized,
      source: source || 'manual',
      acquiredAt: Date.now(),
      rowIdentity: row instanceof HTMLElement ? helper.getRowIdentity(row) : null
    };
    return helper.state.ghostCursorLaneLock;
  }


  function setGhostCursorLaneLockAuto() {
    const lock = getGhostCursorLaneLock();
    if (lock) {
      helper.state.ghostCursorLaneLock = {
        ...lock,
        source: 'auto',
        acquiredAt: Date.now()
      };
    }
  }


  function getGhostCursorLaneProjections() {
    const projections = helper.state.ghostCursorLaneProjections;
    if (!projections || typeof projections !== 'object' || Array.isArray(projections)) {
      helper.state.ghostCursorLaneProjections = {};
      return helper.state.ghostCursorLaneProjections;
    }
    return projections;
  }


  function rememberGhostCursorPlaybackState(playback) {
    if (isSourceSwitching()) return;
    if (Array.isArray(playback?.recordingTracks) && playback.recordingTracks !== recordingTracks) {
      recordingTracks = playback.recordingTracks;
      recordingIds = new Set(recordingTracks.map(track => track.id));
    }
    helper.state.ghostCursorPlaybackTime =
      playback && typeof playback.currentTime === 'number' && Number.isFinite(playback.currentTime)
        ? playback.currentTime
        : null;
    helper.state.ghostCursorPlaybackPaused =
      playback && typeof playback.paused === 'boolean'
        ? playback.paused
        : null;
  }


  function getCurrentGhostCursorPlaybackSnapshot() {
    if (isSourceSwitching() || helper.state.speakerSwitchPending) {
      return { ok: false, currentTime: null, paused: null };
    }
    const rememberedTime = helper.state.ghostCursorPlaybackTime;
    if (typeof rememberedTime === 'number' && Number.isFinite(rememberedTime)) {
      return {
        ok: true,
        currentTime: rememberedTime,
        paused: helper.state.ghostCursorPlaybackPaused
      };
    }


    return {
      ok: false,
      currentTime: null,
      paused: null
    };
  }


  function getRememberedGhostCursorProjection(speakerKey) {
    if (typeof speakerKey !== 'string' || !speakerKey) {
      return null;
    }

    const projections = getGhostCursorLaneProjections();
    const projection = projections[speakerKey];
    if (!projection || typeof projection !== 'object' || projection.timingValid === false) {
      return null;
    }

    const row = api.time.resolveConnectedRow(projection.row, projection.rowIdentity);
    const offset = Number(projection.offset);
    if (!(row instanceof HTMLElement) || !Number.isFinite(offset) || offset < 0) {
      delete projections[speakerKey];
      return null;
    }

    return {
      ...projection,
      row,
      offset
    };
  }


  function getSpeakerKeyForGhostToggleLabel(label) {
    const normalized = api.speaker.normalizeSpeakerLabel(label);
    if (!normalized) {
      return '';
    }
    const track = recordingTracks.find((entry) =>
      entry.id === label || api.speaker.normalizeSpeakerLabel(entry.label) === normalized);
    if (track?.id) return track.id;

    for (const cachedEntry of api.time.getRowTimeEntries()) {
      const entry = api.time.resolveRowTimeEntry(cachedEntry);
      if (!entry) {
        continue;
      }

      const identity = helper.getRowIdentity(entry.row) || {};
      const speakerKey = api.time.getRowSpeakerKeySafe(entry.row);
      const candidates = [speakerKey, identity.trackLabel].filter(Boolean);
      if (
        candidates.some((candidate) =>
          candidate === normalized || api.speaker.normalizeSpeakerLabel(candidate) === normalized
        )
      ) {
        return speakerKey || normalized;
      }
    }

    return normalized;
  }


  function getGhostCursorToggleSpeakerKeys() {
    return [...recordingIds];
  }


  function getToggleableGhostCursorSpeakerKeys() {
    return getGhostCursorToggleSpeakerKeys().filter(
      (speakerKey) => api.time.hasRowsForSpeakerKey(speakerKey) || getRememberedGhostCursorProjection(speakerKey)
    );
  }


  function ghostCursorProjectionMatchesEntry(projection, entry) {
    if (!projection || !entry || !(entry.row instanceof HTMLElement)) {
      return false;
    }

    const row = api.time.resolveConnectedRow(projection.row, projection.rowIdentity);
    if (!(row instanceof HTMLElement) || row !== entry.row) {
      return false;
    }

    const range = projection.timeRange;
    if (!range) {
      return true;
    }

    return (
      range.startSeconds === entry.startSeconds &&
      range.endSeconds === entry.endSeconds
    );
  }


  function getGhostCursorProjectionBaseline(speakerKey, entry) {
    const remembered = getGhostCursorLaneProjections()[speakerKey];
    if (
      remembered &&
      ghostCursorProjectionMatchesEntry(remembered, entry) &&
      typeof remembered.cursorBaseline === 'number'
    ) {
      return remembered.cursorBaseline;
    }

    return (
      remembered &&
      ghostCursorProjectionMatchesEntry(remembered, entry) &&
      typeof remembered.offset === 'number'
    )
      ? remembered.offset
      : 0;
  }


  function rememberGhostCursorProjection(row, offset, options) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const speakerKey = api.time.getRowSpeakerKeySafe(row);
    if (!speakerKey) {
      return null;
    }

    const numericOffset = Math.max(0, Math.round(Number(offset) || 0));
    const settings = options || {};
    const projection = {
      row,
      rowIdentity: helper.getRowIdentity(row),
      offset: numericOffset,
      cursorBaseline:
        typeof settings.cursorBaseline === 'number' && Number.isFinite(settings.cursorBaseline)
          ? Math.max(0, Math.round(settings.cursorBaseline))
          : numericOffset,
      playbackTime:
        typeof settings.playbackTime === 'number' && Number.isFinite(settings.playbackTime)
          ? settings.playbackTime
          : null,
      timeRange: settings.timeRange || api.time.getRowTimeRange(row),
      clamped: Boolean(settings.clamped),
      timingValid: true,
      updatedAt: Date.now()
    };

    getGhostCursorLaneProjections()[speakerKey] = projection;
    if (settings.source === 'active') {
      helper.state.ghostCursorDefaultProjectionSpeakerKey = speakerKey;
      if (helper.state.ghostCursorProjectionSource !== 'manual') {
        helper.state.ghostCursorProjectionSpeakerKey = speakerKey;
        helper.state.ghostCursorProjectionSource = 'auto';
      }
    }

    return projection;
  }


  function rememberFocusedGhostCursorProjection() {
    const textarea = helper.getActiveRowEditor();
    if (!textarea) {
      return null;
    }

    const row = textarea.row;
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const offset =
      typeof textarea.selectionStart === 'number' && Number.isFinite(textarea.selectionStart)
        ? textarea.selectionStart
        : 0;
    return rememberGhostCursorProjection(row, offset, {
      cursorBaseline: offset,
      playbackTime: helper.state.ghostCursorPlaybackTime,
      timeRange: api.time.getRowTimeRange(row)
    });
  }


  function findGhostCursorProjectionEntryByPlaybackTime(currentTime, speakerKey) {
    const entries = api.time.getRowTimeEntries();
    return api.time.findRowEntryByPlaybackTime(currentTime, { speakerKey }, entries) ||
      api.time.findLatestRowEntryBeforePlaybackTime(currentTime, { speakerKey }, entries);
  }


  function computeGhostCursorProjectionForEntry(entry, currentTime, blurTime, timingIndex) {
    if (!entry || !(entry.row instanceof HTMLElement)) {
      return null;
    }

    const textarea = helper.getRowEditor(entry.row);
    if (!textarea) {
      return null;
    }

    const speakerKey = api.time.getRowSpeakerKeySafe(entry.row);
    const text = textarea.value || '';
    const baseline = getGhostCursorProjectionBaseline(speakerKey, entry);
    const result = computeGhostCursorOffset(
      text,
      entry.row,
      entry,
      currentTime,
      blurTime,
      baseline,
      timingIndex
    );
    if (!result) {
      return null;
    }

    return rememberGhostCursorProjection(entry.row, result.offset, {
      cursorBaseline: result.offset,
      playbackTime: currentTime,
      timeRange: {
        startSeconds: entry.startSeconds,
        endSeconds: entry.endSeconds
      },
      clamped: result.clamped
    });
  }


  function updateGhostCursorLaneProjectionsForPlayback(currentTime, blurTime, activeSpeakerKey, entries, timingIndex) {
    for (const speakerKey of recordingIds) {
      if (speakerKey === activeSpeakerKey) continue;
      const entry = api.time.findRowEntryByPlaybackTime(currentTime, { speakerKey }, entries) ||
        api.time.findLatestRowEntryBeforePlaybackTime(currentTime, { speakerKey }, entries);
      if (entry) computeGhostCursorProjectionForEntry(entry, currentTime, blurTime, timingIndex);
    }
  }


  function getRenderedGhostCursorProjection() {
    const selectedKey =
      helper.state.ghostCursorProjectionSource === 'manual'
        ? helper.state.ghostCursorProjectionSpeakerKey
        : helper.state.ghostCursorDefaultProjectionSpeakerKey;
    const projection = getRememberedGhostCursorProjection(selectedKey);
    if (projection) {
      return projection;
    }

    const defaultKey = helper.state.ghostCursorDefaultProjectionSpeakerKey;
    if (defaultKey && defaultKey !== selectedKey) {
      helper.state.ghostCursorProjectionSpeakerKey = defaultKey;
      helper.state.ghostCursorProjectionSource = 'auto';
      return getRememberedGhostCursorProjection(defaultKey);
    }

    return null;
  }


  function renderGhostCursorProjection(projection, sampledEditor = null, sampledTextLength = null) {
    if (!projection || !(projection.row instanceof HTMLElement) || !projection.row.isConnected) {
      return false;
    }

    const textarea = sampledEditor?.row === projection.row ? sampledEditor : helper.getRowEditor(projection.row);
    if (!textarea) {
      return false;
    }

    const textLength = textarea === sampledEditor && sampledTextLength != null
      ? sampledTextLength : (textarea.value || '').length;
    const offset = Math.max(0, Math.min(textLength, Math.round(Number(projection.offset) || 0)));
    // Read transcript geometry before touching the overlay's styles. Style
    // invalidation here otherwise forces a synchronous layout in getCaretRect.
    const pos = textarea.getCaretRect(offset);
    if (!pos) {
      if (helper.state.ghostCursorElement) helper.state.ghostCursorElement.style.display = 'none';
      return false;
    }
    const scrollParent = textarea.element?.closest('[data-transcript-scroll]');
    const viewport = scrollParent?.getBoundingClientRect();
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const snapToDevicePixel = (value) => Math.round(value * pixelRatio) / pixelRatio;
    let el = helper.state.ghostCursorElement;
    if (!(el instanceof HTMLElement) || !el.isConnected) {
      el = createGhostCursorElement();
      document.body.appendChild(el);
      helper.state.ghostCursorElement = el;
    }
    const previousOffset = helper.state.ghostCursorOffset;
    const jump = renderedRow !== projection.row ||
      el.style.display === 'none' || offset < previousOffset || renderedTop !== pos.top;
    applyGhostCursorAppearance(el, projection.clamped);
    // A row/line change or seek is a discontinuity, not forward cursor motion.
    if (jump) el.style.transition = 'none';
    renderedRow = projection.row;
    renderedTop = pos.top;
    // The fixed marker must not paint over controls when the text scrolls away.
    el.style.display = viewport && (pos.top < viewport.top || pos.top + pos.height > viewport.bottom)
      ? 'none' : '';
    el.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
    el.style.height = `${snapToDevicePixel(pos.height)}px`;

    helper.state.ghostCursorRow = projection.row;
    helper.state.ghostCursorRowIdentity = helper.getRowIdentity(projection.row);
    helper.state.ghostCursorOffset = offset;
    // Tab selects a rendered lane independently of the primary playback lane.
    // Publish that projection, never the internal row used to advance timing.
    if (!helper.getActiveRowEditor()) helper.setCurrentRow(projection.row);
    return true;
  }


  function focusGhostCursorProjection(projection) {
    if (!projection || !(projection.row instanceof HTMLElement) || !projection.row.isConnected) {
      return false;
    }

    const textarea = helper.getRowEditor(projection.row);
    if (!textarea) {
      return false;
    }

    const textLength = (textarea.value || '').length;
    const offset = Math.max(0, Math.min(textLength, Math.round(Number(projection.offset) || 0)));
    helper.state.cursorBaseline = offset;
    helper.state.blurRestorePending = false;
    helper.state.ghostCursorRow = projection.row;
    helper.state.ghostCursorRowIdentity = helper.getRowIdentity(projection.row);
    helper.state.ghostCursorOffset = offset;

    return helper.focusRow(projection.row, {
      activateRow: false,
      scroll: false,
      selectionStart: offset,
      selectionEnd: offset,
      direction: 'none'
    });
  }


  function findGhostCursorEntryByPlaybackTime(playbackTime, entries) {
    const lock = getGhostCursorLaneLock();
    if (lock && !api.time.hasRowsForSpeakerKey(lock.speakerKey, entries)) {
      helper.state.ghostCursorLaneLock = null;
    }

    const activeLock = getGhostCursorLaneLock();
    if (activeLock) {
      const lockedEntry = api.time.findRowEntryByPlaybackTime(playbackTime, {
        speakerKey: activeLock.speakerKey
      }, entries);
      if (lockedEntry) {
        return lockedEntry;
      }
    }

    const nextActiveEntry = api.time.findRowEntryByPlaybackTime(playbackTime, null, entries);
    if (nextActiveEntry) {
      setGhostCursorLaneLock(nextActiveEntry.row, 'auto');
      return nextActiveEntry;
    }

    const danglingEntry =
      (activeLock &&
        api.time.findLatestRowEntryBeforePlaybackTime(playbackTime, {
          speakerKey: activeLock.speakerKey
        }, entries)) ||
      api.time.findLatestRowEntryBeforePlaybackTime(playbackTime, null, entries);

    return danglingEntry || null;
  }


  function startGhostCursor(row) {
    stopGhostCursor(true); // clean up any previous instance

    if (!helper.config.features.proportionalCursorRestore) { return; }
    if (!(row instanceof HTMLElement) || !row.isConnected) { return; }

    const textarea = helper.getRowEditor(row);
    if (!textarea) { return; }

    const timeRange = api.time.getRowTimeRange(row);
    if (!timeRange) { return; }

    let blurTime = helper.state.blurPlaybackTime;
    const existingLock = getGhostCursorLaneLock();
    if (!existingLock || existingLock.source !== 'manual' || !api.time.hasRowsForSpeakerKey(existingLock.speakerKey)) {
      setGhostCursorLaneLock(row, existingLock?.source || 'auto');
    }

    const el = createGhostCursorElement();
    document.body.appendChild(el);
    helper.state.ghostCursorElement = el;
    helper.state.ghostCursorRow = row;
    helper.state.ghostCursorRowIdentity = helper.getRowIdentity(row);
    helper.state.ghostCursorOffset = null;
    helper.state.ghostCursorProjectionSpeakerKey = api.time.getRowSpeakerKeySafe(row) || null;
    helper.state.ghostCursorDefaultProjectionSpeakerKey = api.time.getRowSpeakerKeySafe(row) || null;
    helper.state.ghostCursorProjectionSource = 'auto';
    helper.state.ghostCursorLaneProjections = {};
    refreshPlaybackContext();
    activeTaskGuard = captureNativeTaskGuard();
    window.addEventListener(AUDIO_ENHANCEMENT_STATE_EVENT, onSourceChange);
    document.addEventListener('visibilitychange', onSourceChange);

    // Mutable tracking state for dynamic row switching
    let trackedRow = row;
    let trackedIdentity = helper.getRowIdentity(row);
    let trackedTimeRange = timeRange;

    // Initial hide until first position is computed
    el.style.display = 'none';

    function tick(playback) {
      if (helper.state.ghostCursorElement !== el) return;
      if (!helper.config.features.proportionalCursorRestore) {
        stopGhostCursor(true);
        return;
      }
      if (playback?.fatal) {
        stopGhostCursor(true);
        return;
      }
      if (document.hidden) {
        return;
      }

      const isCurrentPlayback = capturePlaybackGuard();

      // Bail if state was cleaned up or row disconnected
      try {
        if (!helper.state.ghostCursorElement || helper.state.ghostCursorElement !== el) { return; }
        if (!activeTaskGuard?.()) {
          stopGhostCursor(true);
          return;
        }
        // Only the published, task-owned paired load may suspend pause handling.
        // Speaker filtering may remount rows; its committed lane is resolved next tick.
        if (isSourceSwitching() || helper.state.speakerSwitchPending) {
          el.style.display = 'none';
          return;
        }

        if (document.hidden || !isCurrentPlayback() || helper.state.ghostCursorElement !== el) return;
        const previousTime = helper.state.ghostCursorPlaybackTime;
        const rewound = Number.isFinite(previousTime) && Number.isFinite(playback?.currentTime) &&
          playback.currentTime < previousTime;
        if (rewound) {
          // Explicit seeks and native loop wraps retire the forward-only floor.
          // The new floor must use the same compensated clock as projection:
          // raw seek time cancels reaction compensation and can pin the cursor
          // to its pre-seek word. Lane toggles and Escape share this floor.
          helper.state.cursorBaseline = 0;
          helper.state.ghostCursorLaneProjections = {};
          blurTime = helper.state.blurPlaybackTime = playback.currentTime - REACTION_TIME_OFFSET_SECONDS;
        }
        rememberGhostCursorPlaybackState(playback);
        if (!playback || !playback.ok || typeof playback.currentTime !== 'number') {
          el.style.display = 'none';
          return;
        }

        // If playback stopped (user clicked pause outside our workflow, etc.), remove ghost
        if (playback.paused === true) {
          stopGhostCursor();
          return;
        }

        const currentTime = playback.currentTime;
        const rowTimeEntries = api.time.getRowTimeEntries();
        if (timingRowEntries !== rowTimeEntries) {
          timingAlignmentCache.retainRows((row) => api.time.getRowTimeEntry(row)?.row === row);
          timingRowEntries = rowTimeEntries;
        }
        const timingIndex = getCurrentL0PlaybackTimingIndex(helper.state, helper);
        const playbackEntry = api.time.findRowEntryByPlaybackTime(currentTime, undefined, rowTimeEntries);
        if (playbackEntry) api.time.rememberPlaybackRow(playbackEntry.row);

        const trackedEntry = api.time.getRowTimeEntry(trackedRow, trackedIdentity);
        const connectedRow = trackedEntry?.row;
        if (connectedRow instanceof HTMLElement && connectedRow.isConnected) {
          if (connectedRow !== trackedRow) {
            const remembered = helper.state.lastBlur;
            if (remembered?.row === trackedRow) remembered.row = connectedRow;
            trackedRow = connectedRow;
            trackedIdentity = helper.getRowIdentity(connectedRow);
          }
          trackedTimeRange = trackedEntry;
        }

        // Dynamic row tracking: if playback time exits the tracked row's
        // time range or a manual lane lock points elsewhere, resolve by
        // lane-lock-aware playback time.
        const laneLock = getGhostCursorLaneLock();
        const trackedSpeakerKey = api.time.getRowSpeakerKeySafe(trackedRow);
        if (
          !trackedEntry ||
          currentTime < trackedTimeRange.startSeconds ||
          currentTime >= trackedTimeRange.endSeconds ||
          (laneLock && laneLock.speakerKey && trackedSpeakerKey && laneLock.speakerKey !== trackedSpeakerKey)
        ) {
          const nextEntry = findGhostCursorEntryByPlaybackTime(currentTime, rowTimeEntries);
          if (!nextEntry) {
            el.style.display = 'none';
            return;
          }
          const newRow = nextEntry.row;
          if (newRow !== trackedRow) {
            const newRange = nextEntry;
            if (newRange) {
              const prevRowId = helper.getRowIdentity(trackedRow)?.annotationId ?? null;
              trackedRow = newRow;
              trackedIdentity = helper.getRowIdentity(newRow);
              trackedTimeRange = newRange;
              helper.state.ghostCursorRow = newRow;
              helper.state.ghostCursorRowIdentity = helper.getRowIdentity(newRow);
              helper.state.cursorBaseline = 0;

              if (helper.analytics) {
                const newRowId = helper.getRowIdentity(newRow)?.annotationId ?? null;
                helper.analytics.record('ghost:row-switch', {
                  fromRowId: prevRowId,
                  toRowId: newRowId,
                  playbackTime: currentTime
                });
              }

              // Update the remembered blur's row so State 2 restores into
              // the correct row when the user presses Esc.  This must
              // happen for both synthetic and real blurs: if the user
              // blurred from row A (State 3) and playback advanced into
              // row B, the restore must target row B — otherwise
              // focusRow would scroll back to the old segment and
              // Babel's active-segment highlight would jump.
              const remembered = helper.state.lastBlur;
              if (remembered) {
                remembered.row = newRow;
                remembered.selectionStart = 0;
                remembered.selectionEnd = 0;
              }
            }
          }
        }

        if (!trackedRow.isConnected) {
          el.style.display = 'none';
          return;
        }

        // Re-query the turn control after a native static/Slate replacement.
        const ta = helper.getRowEditor(trackedRow);
        if (!ta) {
          el.style.display = 'none';
          return;
        }

        const text = ta.value || '';
        const baseline = Math.max(
          typeof helper.state.cursorBaseline === 'number' ? helper.state.cursorBaseline : 0,
          getGhostCursorProjectionBaseline(api.time.getRowSpeakerKeySafe(trackedRow), {
            row: trackedRow,
            ...trackedTimeRange
          })
        );
        const result = computeGhostCursorOffset(
          text,
          trackedRow,
          trackedTimeRange,
          currentTime,
          blurTime,
          baseline,
          timingIndex
        );
        if (result === null) {
          el.style.display = 'none';
          return;
        }

        updateGhostCursorLaneProjectionsForPlayback(currentTime, blurTime, api.time.getRowSpeakerKeySafe(trackedRow), rowTimeEntries, timingIndex);
        const activeProjection = rememberGhostCursorProjection(trackedRow, result.offset, {
          source: 'active',
          cursorBaseline: result.offset,
          playbackTime: currentTime,
          timeRange: trackedTimeRange,
          clamped: result.clamped
        });
        const renderedProjection = getRenderedGhostCursorProjection() || activeProjection;
        if (!renderGhostCursorProjection(renderedProjection, ta, text.length)) {
          helper.state.ghostCursorOffset = null;
          el.style.display = 'none';
        }
      } catch (error) {
        // A retired subscription cannot tear down a replacement cursor.
        if (!isCurrentPlayback() || helper.state.ghostCursorElement !== el) return;
        stopGhostCursor(true);
        helper.reportPlaybackFailure?.({ reason: 'native-playback-update-failed', message: String(error) });
      }
    }

    try {
      if (typeof helper.subscribePlayback !== 'function') throw new Error('Native playback subscription is unavailable');
      unsubscribePlayback = helper.subscribePlayback(tick);
    } catch (error) {
      stopGhostCursor(true);
      helper.reportPlaybackFailure?.({ reason: 'native-playback-subscription-failed', message: String(error) });
    }

    if (helper.analytics) {
      const rowId = helper.getRowIdentity(row)?.annotationId ?? null;
      helper.analytics.record('ghost:start', {
        rowId,
        timeRange,
        blurTime: helper.state.blurPlaybackTime
      });
    }
  }


  function getGhostCursorTarget() {
    if (!helper.config.features.proportionalCursorRestore || (activeTaskGuard && !activeTaskGuard())) {
      stopGhostCursor(true);
      return null;
    }
    const row = api.time.resolveConnectedRow(
      helper.state.ghostCursorRow,
      helper.state.ghostCursorRowIdentity
    );
    const offset = helper.state.ghostCursorOffset;
    if (!(row instanceof HTMLElement) || typeof offset !== 'number' || offset < 0) {
      return null;
    }

    return {
      row,
      offset
    };
  }


  helper.getGhostCursorTarget = getGhostCursorTarget;
  helper.stopGhostCursor = () => stopGhostCursor(true);


  helper.toggleGhostCursorLane = function toggleGhostCursorLane() {
    if (!helper.config.features.proportionalCursorRestore) {
      return false;
    }
    if (activeTaskGuard && !activeTaskGuard()) {
      stopGhostCursor(true);
      return false;
    }
    refreshPlaybackContext();

    const lanes = getToggleableGhostCursorSpeakerKeys();
    if (lanes.length < 2) {
      return false;
    }

    const focusedProjection = rememberFocusedGhostCursorProjection();
    const focusedKey = focusedProjection ? api.time.getRowSpeakerKeySafe(focusedProjection.row) : '';
    const currentKey =
      focusedKey ||
      helper.state.ghostCursorProjectionSpeakerKey ||
      helper.state.ghostCursorDefaultProjectionSpeakerKey ||
      api.time.getRowSpeakerKeySafe(helper.state.ghostCursorRow);
    const currentIndex = lanes.indexOf(currentKey);
    const targetKey = lanes[(currentIndex >= 0 ? currentIndex + 1 : 0) % lanes.length];
    if (!targetKey || targetKey === currentKey) {
      return false;
    }
    if ((isSourceSwitching() || helper.state.speakerSwitchPending) && helper.state.ghostCursorElement) {
      helper.state.ghostCursorProjectionSpeakerKey = targetKey;
      helper.state.ghostCursorProjectionSource = 'manual';
      return true;
    }

    const playbackSnapshot = getCurrentGhostCursorPlaybackSnapshot();
    if (playbackSnapshot.ok && typeof playbackSnapshot.currentTime === 'number') {
      const entry = findGhostCursorProjectionEntryByPlaybackTime(playbackSnapshot.currentTime, targetKey);
      computeGhostCursorProjectionForEntry(
        entry,
        playbackSnapshot.currentTime,
        helper.state.blurPlaybackTime
      );
    }

    const projection = getRememberedGhostCursorProjection(targetKey);
    if (!projection) {
      return false;
    }

    helper.state.ghostCursorProjectionSpeakerKey = targetKey;
    helper.state.ghostCursorProjectionSource = 'manual';
    const rendered = helper.state.ghostCursorElement instanceof HTMLElement
      ? renderGhostCursorProjection(projection)
      : focusGhostCursorProjection(projection);
    if (helper.analytics) {
      helper.analytics.record('hotkey:ghost-lane-toggle', {
        speakerKey: targetKey,
        rendered
      });
    }
    return rendered;
  };

  return { setGhostCursorLaneLockForSpeaker, setGhostCursorLaneLockAuto, getGhostCursorTarget, stopGhostCursor, scrollToCaret, PROPORTIONAL_MIN_DELTA_SECONDS, computeRestoreOffset, startGhostCursor, capturePlaybackGuard, isSourceSwitching, invalidatePlaybackContext, timingAlignmentCache };
}

export function registerGhostCursorInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;
  hooks.on('keydown', (event) => {
    if (isFeatureEnabled('rowActions') &&
      matchesShortcut(helper.config?.shortcuts, 'ghost.lane', event, helper.state?.rightShiftPressed) &&
      typeof helper.toggleGhostCursorLane === 'function') {
      const handled = helper.toggleGhostCursorLane();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return true;
    }
  }, 40);
  hooks.on('capture', (event) => {
    if (isFeatureEnabled('rowActions') &&
      matchesShortcut(helper.config?.shortcuts, 'ghost.lane', event, helper.state?.rightShiftPressed) &&
      typeof helper.toggleGhostCursorLane === 'function') {
      const handled = helper.toggleGhostCursorLane();
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (helper.analytics) {
          helper.analytics.record('hotkey:ghost-lane-toggle', {
            via: 'window-capture',
            defaultPrevented: event.defaultPrevented
          });
        }
      }
      return true;
    }
  }, 10);
}
