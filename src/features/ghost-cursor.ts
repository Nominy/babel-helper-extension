// @ts-nocheck
import { getCurrentL0TimingIndex } from '../content/l0-timing-listener';
import { computeL0TimedCharacterOffset, computeL0TimestampAtCharacterOffset } from '../services/l0-word-timing-alignment';
import { buildL0TimingLaneAliases, resolveL0TimingTrack } from '../services/l0-timing-identity';
import type { RowModules } from '../services/row-service';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerGhostCursor(helper: any, api: Pick<RowModules, 'time' | 'speaker' | 'playback'>) {

  const PROPORTIONAL_MIN_DELTA_SECONDS = 0.3;


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
  // Ghost cursor: a live-updating orange bar on the blurred textarea row that
  // shows where the cursor WOULD land if the user pressed Escape right now.
  // Gated behind proportionalCursorRestore.
  // ---------------------------------------------------------------------------

  const GHOST_CURSOR_INTERVAL_MS = 66;
  // ~15 fps
  const GHOST_CURSOR_ATTR = 'data-babel-helper-ghost-cursor';

  const GHOST_CURSOR_TOGGLE_LANES = ['Speaker 1', 'Speaker 2'];


  /** Copied style properties for the mirror-div caret measurement. */
  const MIRROR_STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'lineHeight', 'whiteSpace', 'wordWrap', 'overflowWrap', 'direction',
    'boxSizing', 'tabSize', 'textAlign'
  ];


  /**
   * Compute the viewport-pixel coordinates of a character index inside a
   * textarea using the mirror-div technique.  Returns { top, left, height }
   * where height is the line-height so the ghost cursor bar can be sized.
   *
   * The mirror is overlaid exactly on top of the textarea (via position:fixed
   * matching the textarea's border-box rect) so the marker span's
   * getBoundingClientRect() gives direct viewport coordinates.  We only
   * compensate for textarea scroll offsets.
   *
   * The marker span is zero-width (\u200b) so its bounding rect is a single
   * point at the caret insertion position.  The remaining text after the
   * caret is placed in a *separate* text node so line-wrap decisions for the
   * text before the caret remain correct, but the marker rect is not
   * inflated by wrapped continuation text.
   */
  function getCaretPixelPosition(textarea, charIndex) {
    const mirror = document.createElement('div');
    try {
      const computed = window.getComputedStyle(textarea);
      const textareaRect = textarea.getBoundingClientRect();

      // Position the mirror exactly over the textarea's border box so that
      // all internal offsets (padding, line wrapping) match pixel-for-pixel.
      mirror.style.position = 'fixed';
      mirror.style.top = `${textareaRect.top}px`;
      mirror.style.left = `${textareaRect.left}px`;
      mirror.style.visibility = 'hidden';
      mirror.style.overflow = 'hidden';
      mirror.style.pointerEvents = 'none';

      for (const prop of MIRROR_STYLE_PROPS) {
        mirror.style[prop] = computed[prop];
      }

      // Textarea content wraps like pre-wrap.  The computed style of a
      // <textarea> may not report this directly, so force it after the loop
      // to ensure the mirror wraps identically.
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.wordWrap = 'break-word';
      mirror.style.overflowWrap = 'break-word';

      // Always size to the textarea's border-box dimensions so wrapping is
      // identical regardless of the textarea's box-sizing mode.
      mirror.style.width = `${textarea.offsetWidth}px`;
      mirror.style.height = `${textarea.offsetHeight}px`;
      mirror.style.boxSizing = 'border-box';

      const beforeCaret = textarea.value.substring(0, charIndex);
      const afterCaret = textarea.value.substring(charIndex);

      // 1. Text before the caret — plain text node.
      mirror.appendChild(document.createTextNode(beforeCaret));

      // 2. Zero-width marker span at the caret position.  Using a single
      //    zero-width space keeps the span on the same visual line as the
      //    preceding text and gives getBoundingClientRect() a tight rect
      //    at the insertion point.
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      mirror.appendChild(marker);

      // 3. Remaining text after the caret in a *separate* text node.  This
      //    participates in layout (influencing where the line before the
      //    caret wraps) without inflating the marker span's bounding rect.
      if (afterCaret) {
        mirror.appendChild(document.createTextNode(afterCaret));
      }

      document.body.appendChild(mirror);

      const markerRect = marker.getBoundingClientRect();
      const lineHeight = parseFloat(computed.lineHeight) || markerRect.height || 16;

      // Because the mirror is positioned to match the textarea border box,
      // the marker rect is already in viewport coordinates.  Subtract the
      // textarea's scroll offsets so the cursor tracks visible content.
      const top = markerRect.top - textarea.scrollTop;
      const left = markerRect.left - textarea.scrollLeft;

      return { top, left, height: lineHeight };
    } finally {
      if (mirror.parentNode) {
        mirror.parentNode.removeChild(mirror);
      }
    }
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

    const floor = typeof baseline === 'number' && baseline >= 0 ? baseline : 0;
    const final = Math.max(floor, snapped);
    return { offset: final, clamped: final !== snapped };
  }


  function getL0TimingTrackForRow(row) {
    const index = getCurrentL0TimingIndex(helper.state, helper);
    if (!index || !(row instanceof HTMLElement)) {
      return null;
    }

    const identity = helper.getRowIdentity(row) || {};
    const speakerCell = row.children[1] instanceof HTMLElement
      ? helper.normalizeText(row.children[1])
      : '';
    return resolveL0TimingTrack(
      index,
      buildL0TimingLaneAliases(identity, [api.time.getRowSpeakerKeySafe(row), speakerCell])
    );
  }


  function computeGhostCursorOffset(text, row, timeRange, currentTime, blurTime, baseline) {
    const track = getL0TimingTrackForRow(row);
    if (track) {
      const timedOffset = computeL0TimedCharacterOffset(text, track.tokens, timeRange, currentTime);
      if (timedOffset !== null) {
        const floor = typeof baseline === 'number' && baseline >= 0 ? baseline : 0;
        const final = Math.max(floor, timedOffset);
        return { offset: final, clamped: final !== timedOffset };
      }
    }
    return computeRestoreOffset(text, timeRange, currentTime, blurTime, baseline);
  }


  helper.getL0TimestampForRowOffset = function getL0TimestampForRowOffset(row, offset) {
    const track = getL0TimingTrackForRow(row);
    const range = api.time.getRowTimeRange(row);
    const textarea = helper.getRowTextarea(row);
    if (!track || !range || !(textarea instanceof HTMLTextAreaElement)) {
      return null;
    }
    return computeL0TimestampAtCharacterOffset(
      textarea.value || '',
      track.tokens,
      range,
      offset
    );
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
    el.style.transition = `transform ${appearance.transitionMs}ms linear`;
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


  function stopGhostCursor() {
    const wasActive = helper.state.ghostCursorIntervalId != null;
    if (helper.state.ghostCursorIntervalId != null) {
      clearInterval(helper.state.ghostCursorIntervalId);
      helper.state.ghostCursorIntervalId = null;
    }
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
    const normalized = api.speaker.normalizeSpeakerLabel(speakerLabel);
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
    const rememberedTime = helper.state.ghostCursorPlaybackTime;
    if (typeof rememberedTime === 'number' && Number.isFinite(rememberedTime)) {
      return {
        ok: true,
        currentTime: rememberedTime,
        paused: helper.state.ghostCursorPlaybackPaused === true
      };
    }

    const localPlayback = api.playback.unavailablePlaybackState();
    if (
      localPlayback &&
      localPlayback.ok &&
      typeof localPlayback.currentTime === 'number' &&
      Number.isFinite(localPlayback.currentTime)
    ) {
      rememberGhostCursorPlaybackState(localPlayback);
      return {
        ok: true,
        currentTime: localPlayback.currentTime,
        paused: typeof localPlayback.paused === 'boolean' ? localPlayback.paused : false
      };
    }

    return {
      ok: false,
      currentTime: null,
      paused: true
    };
  }


  function getRememberedGhostCursorProjection(speakerKey) {
    if (typeof speakerKey !== 'string' || !speakerKey) {
      return null;
    }

    const projections = getGhostCursorLaneProjections();
    const projection = projections[speakerKey];
    if (!projection || typeof projection !== 'object') {
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

    for (const cachedEntry of api.time.getRowTimeEntries()) {
      const entry = api.time.resolveRowTimeEntry(cachedEntry);
      if (!entry) {
        continue;
      }

      const identity = helper.getRowIdentity(entry.row) || {};
      const speakerKey = api.time.getRowSpeakerKeySafe(entry.row);
      const speakerCell = entry.row.children[1] instanceof HTMLElement
        ? helper.normalizeText(entry.row.children[1])
        : '';
      const candidates = [speakerKey, identity.trackLabel, speakerCell].filter(Boolean);
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
    const keys = [];
    const seen = new Set();
    for (const label of GHOST_CURSOR_TOGGLE_LANES) {
      const key = getSpeakerKeyForGhostToggleLabel(label);
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      keys.push(key);
    }
    return keys;
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
    const remembered = getRememberedGhostCursorProjection(speakerKey);
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
    const textarea = helper.getActiveRowTextarea();
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return null;
    }

    const row = textarea.closest('tr');
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
    let entry = api.time.findRowEntryByPlaybackTime(currentTime, { speakerKey });
    if (!entry) {
      entry = api.time.findLatestRowEntryBeforePlaybackTime(currentTime, { speakerKey });
    }
    return entry;
  }


  function computeGhostCursorProjectionForEntry(entry, currentTime, blurTime) {
    if (!entry || !(entry.row instanceof HTMLElement)) {
      return null;
    }

    const textarea = helper.getRowTextarea(entry.row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
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
      baseline
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


  function updateGhostCursorLaneProjectionsForPlayback(currentTime, blurTime) {
    for (const speakerKey of getGhostCursorToggleSpeakerKeys()) {
      const entry = findGhostCursorProjectionEntryByPlaybackTime(currentTime, speakerKey);
      computeGhostCursorProjectionForEntry(entry, currentTime, blurTime);
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


  function renderGhostCursorProjection(projection) {
    if (!projection || !(projection.row instanceof HTMLElement) || !projection.row.isConnected) {
      return false;
    }

    const textarea = helper.getRowTextarea(projection.row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const textLength = (textarea.value || '').length;
    const offset = Math.max(0, Math.min(textLength, Math.round(Number(projection.offset) || 0)));
    let el = helper.state.ghostCursorElement;
    if (!(el instanceof HTMLElement) || !el.isConnected) {
      el = createGhostCursorElement();
      document.body.appendChild(el);
      helper.state.ghostCursorElement = el;
    }

    applyGhostCursorAppearance(el, projection.clamped);
    const pos = getCaretPixelPosition(textarea, offset);
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const snapToDevicePixel = (value) => Math.round(value * pixelRatio) / pixelRatio;
    el.style.display = '';
    el.style.transform = `translate3d(${pos.left}px, ${pos.top}px, 0)`;
    el.style.height = `${snapToDevicePixel(pos.height)}px`;

    helper.state.ghostCursorRow = projection.row;
    helper.state.ghostCursorRowIdentity = helper.getRowIdentity(projection.row);
    helper.state.ghostCursorOffset = offset;
    return true;
  }


  function focusGhostCursorProjection(projection) {
    if (!projection || !(projection.row instanceof HTMLElement) || !projection.row.isConnected) {
      return false;
    }

    const textarea = helper.getRowTextarea(projection.row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
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


  function findGhostCursorEntryByPlaybackTime(playbackTime) {
    const lock = getGhostCursorLaneLock();
    if (lock && !api.time.hasRowsForSpeakerKey(lock.speakerKey)) {
      helper.state.ghostCursorLaneLock = null;
    }

    const activeLock = getGhostCursorLaneLock();
    if (activeLock) {
      const lockedEntry = api.time.findRowEntryByPlaybackTime(playbackTime, {
        speakerKey: activeLock.speakerKey
      });
      if (lockedEntry) {
        return lockedEntry;
      }
    }

    const nextActiveEntry = api.time.findRowEntryByPlaybackTime(playbackTime);
    if (nextActiveEntry) {
      setGhostCursorLaneLock(nextActiveEntry.row, 'auto');
      return nextActiveEntry;
    }

    const danglingEntry =
      (activeLock &&
        api.time.findLatestRowEntryBeforePlaybackTime(playbackTime, {
          speakerKey: activeLock.speakerKey
        })) ||
      api.time.findLatestRowEntryBeforePlaybackTime(playbackTime);

    return danglingEntry || null;
  }


  function startGhostCursor(row) {
    stopGhostCursor(); // clean up any previous instance

    if (!helper.config.features.proportionalCursorRestore) { return; }
    if (!(row instanceof HTMLElement) || !row.isConnected) { return; }

    const textarea = helper.getRowTextarea(row);
    if (!(textarea instanceof HTMLTextAreaElement)) { return; }

    const timeRange = api.time.getRowTimeRange(row);
    if (!timeRange) { return; }

    const blurTime = helper.state.blurPlaybackTime;
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

    // Mutable tracking state for dynamic row switching
    let trackedRow = row;
    let trackedTimeRange = timeRange;

    // Initial hide until first position is computed
    el.style.display = 'none';
    let tickInFlight = false;

    async function tick() {
      if (tickInFlight) {
        return;
      }

      tickInFlight = true;

      // Bail if state was cleaned up or row disconnected
      try {
        if (!helper.state.ghostCursorElement || helper.state.ghostCursorElement !== el) { return; }

        const playback =
          typeof helper.getPlaybackState === 'function'
            ? await helper.getPlaybackState()
            : api.playback.unavailablePlaybackState();
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

        // Dynamic row tracking: if playback time exits the tracked row's
        // time range or a manual lane lock points elsewhere, resolve by
        // lane-lock-aware playback time.
        const laneLock = getGhostCursorLaneLock();
        const trackedSpeakerKey = api.time.getRowSpeakerKeySafe(trackedRow);
        if (
          currentTime < trackedTimeRange.startSeconds ||
          currentTime >= trackedTimeRange.endSeconds ||
          (laneLock && laneLock.speakerKey && trackedSpeakerKey && laneLock.speakerKey !== trackedSpeakerKey)
        ) {
          const nextEntry = findGhostCursorEntryByPlaybackTime(currentTime);
          const newRow = nextEntry ? nextEntry.row : null;
          if (newRow && newRow !== trackedRow) {
            const newRange = nextEntry || api.time.getRowTimeRange(newRow);
            if (newRange) {
              const prevRowId = helper.getRowIdentity(trackedRow)?.annotationId ?? null;
              trackedRow = newRow;
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
                helper.setCurrentRow(newRow);
              }
            }
          }
        }

        if (!trackedRow.isConnected) {
          stopGhostCursor();
          return;
        }

        // Re-query textarea in case Babel re-rendered the row
        const ta = helper.getRowTextarea(trackedRow);
        if (!(ta instanceof HTMLTextAreaElement)) {
          stopGhostCursor();
          return;
        }

        const text = ta.value || '';
        const baseline = typeof helper.state.cursorBaseline === 'number'
          ? helper.state.cursorBaseline : 0;
        const result = computeGhostCursorOffset(
          text,
          trackedRow,
          trackedTimeRange,
          currentTime,
          blurTime,
          baseline
        );
        if (result === null) {
          el.style.display = 'none';
          return;
        }

        updateGhostCursorLaneProjectionsForPlayback(currentTime, blurTime);
        const activeProjection = rememberGhostCursorProjection(trackedRow, result.offset, {
          source: 'active',
          cursorBaseline: result.offset,
          playbackTime: currentTime,
          timeRange: trackedTimeRange,
          clamped: result.clamped
        });
        const renderedProjection = getRenderedGhostCursorProjection() || activeProjection;
        if (!renderGhostCursorProjection(renderedProjection)) {
          helper.state.ghostCursorOffset = null;
          el.style.display = 'none';
        }
      } catch (_e) {
        el.style.display = 'none';
      } finally {
        tickInFlight = false;
      }
    }

    // Run first tick immediately, then schedule the interval
    void tick();
    helper.state.ghostCursorIntervalId = setInterval(() => {
      void tick();
    }, GHOST_CURSOR_INTERVAL_MS);

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


  helper.toggleGhostCursorLane = function toggleGhostCursorLane() {
    if (!helper.config.features.proportionalCursorRestore) {
      return false;
    }

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

  return { setGhostCursorLaneLockForSpeaker, setGhostCursorLaneLockAuto, getGhostCursorTarget, stopGhostCursor, PROPORTIONAL_MIN_DELTA_SECONDS, computeRestoreOffset, startGhostCursor };
}

export function registerGhostCursorInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;
  function isGhostCursorLaneToggleShortcut(event) {
    return Boolean(
      isFeatureEnabled('rowActions') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.code === 'Tab'
    );
  }
  hooks.on('keydown', (event) => {
    if (isGhostCursorLaneToggleShortcut(event) && typeof helper.toggleGhostCursorLane === 'function') {
      const handled = helper.toggleGhostCursorLane();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return true;
    }
  }, 40);
  hooks.on('capture', (event) => {
    if (isGhostCursorLaneToggleShortcut(event) && typeof helper.toggleGhostCursorLane === 'function') {
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
