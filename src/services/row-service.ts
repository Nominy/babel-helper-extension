// @ts-nocheck
export function registerRowService(helper: any) {
  if (!helper || helper.__rowsRegistered) {
    return;
  }

  helper.__rowsRegistered = true;
  helper.state.speakerSwitchPending = false;
  const PLAYBACK_BRIDGE_REQUEST_EVENT = 'babel-helper-playback-request';
  const PLAYBACK_BRIDGE_RESPONSE_EVENT = 'babel-helper-playback-response';
  const PLAYBACK_BRIDGE_SCRIPT_PATH = 'dist/content/playback-bridge.js';
  const PLAYBACK_BRIDGE_TIMEOUT_MS = 500;

  let playbackBridgeInjected = false;
  let playbackBridgeLoadPromise = null;
  let playbackBridgeRequestId = 0;
  let escapePlaybackQueue = Promise.resolve();

  const PROPORTIONAL_MIN_DELTA_SECONDS = 0.3;

  // Reaction-time compensation: subtract this from restorePlaybackTime before
  // computing the proportional cursor offset. Accounts for the delay between
  // hearing a problem word and pressing Escape.  Tweak this value if the
  // cursor consistently lands too far forward or backward.
  const REACTION_TIME_OFFSET_SECONDS = 0.6;

  function parseSegmentTimeValue(value) {
    if (typeof value !== 'string') { return null; }
    const trimmed = value.trim();
    if (!trimmed) { return null; }
    const match = trimmed.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
    if (!match) { return null; }
    const parts = match[0].split(':');
    let total = 0;
    for (const part of parts) {
      const numeric = Number(part);
      if (!Number.isFinite(numeric)) { return null; }
      total = total * 60 + numeric;
    }
    return total;
  }

  function getRowTimeRange(row) {
    if (!(row instanceof HTMLElement)) { return null; }
    const startCell = row.children[2];
    const endCell = row.children[3];
    const startSeconds = startCell instanceof HTMLElement
      ? parseSegmentTimeValue(helper.normalizeText(startCell))
      : null;
    const endSeconds = endCell instanceof HTMLElement
      ? parseSegmentTimeValue(helper.normalizeText(endCell))
      : null;
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
      return null;
    }
    return { startSeconds, endSeconds };
  }

  /**
   * Find the transcript row whose time range contains the given playback time.
   * Returns the first matching row, or null if none match.
   */
  function findRowByPlaybackTime(playbackTime) {
    if (typeof playbackTime !== 'number' || !Number.isFinite(playbackTime)) {
      return null;
    }
    const rows = helper.getTranscriptRows();
    for (const row of rows) {
      const range = getRowTimeRange(row);
      if (range && playbackTime >= range.startSeconds && playbackTime < range.endSeconds) {
        return row;
      }
    }
    return null;
  }

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

  const GHOST_CURSOR_INTERVAL_MS = 66; // ~15 fps
  const GHOST_CURSOR_ATTR = 'data-babel-helper-ghost-cursor';

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

  function createGhostCursorElement() {
    const el = document.createElement('div');
    el.setAttribute(GHOST_CURSOR_ATTR, '');
    el.style.position = 'fixed';
    el.style.width = '2px';
    el.style.background = 'rgba(245, 158, 11, 0.75)'; // amber-500
    el.style.borderRadius = '1px';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '20';
    el.style.transition = 'left 80ms linear, top 80ms linear';
    el.style.willChange = 'left, top';
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

    if (wasActive && helper.analytics) {
      helper.analytics.record('ghost:stop', { rowId: stoppedRowId });
    }
  }

  function startGhostCursor(row) {
    stopGhostCursor(); // clean up any previous instance

    if (!helper.config.features.proportionalCursorRestore) { return; }
    if (!(row instanceof HTMLElement) || !row.isConnected) { return; }

    const textarea = helper.getRowTextarea(row);
    if (!(textarea instanceof HTMLTextAreaElement)) { return; }

    const timeRange = getRowTimeRange(row);
    if (!timeRange) { return; }

    const blurTime = helper.state.blurPlaybackTime;

    const el = createGhostCursorElement();
    document.body.appendChild(el);
    helper.state.ghostCursorElement = el;
    helper.state.ghostCursorRow = row;

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
            : getPlaybackStateLocally();
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
        // time range, find the new row by playback time.
        if (currentTime < trackedTimeRange.startSeconds || currentTime >= trackedTimeRange.endSeconds) {
          const newRow = findRowByPlaybackTime(currentTime);
          if (newRow && newRow !== trackedRow) {
            const newRange = getRowTimeRange(newRow);
            if (newRange) {
              const prevRowId = helper.getRowIdentity(trackedRow)?.annotationId ?? null;
              trackedRow = newRow;
              trackedTimeRange = newRange;
              helper.state.ghostCursorRow = newRow;

              if (helper.analytics) {
                const newRowId = helper.getRowIdentity(newRow)?.annotationId ?? null;
                helper.analytics.record('ghost:row-switch', {
                  fromRowId: prevRowId,
                  toRowId: newRowId,
                  playbackTime: currentTime
                });
              }

              // Update the synthetic blur's row so State 2 restores into
              // the correct row when the user presses Esc.
              const remembered = helper.state.lastBlur;
              if (remembered && remembered.synthetic) {
                remembered.row = newRow;
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
        const result = computeRestoreOffset(text, trackedTimeRange, currentTime, blurTime, baseline);
        if (result === null) {
          el.style.display = 'none';
          return;
        }

        // Change color based on whether the baseline floor is clamping:
        // amber when advancing, dim gray when stuck at baseline.
        el.style.background = result.clamped
          ? 'rgba(156, 163, 175, 0.6)'   // gray-400 — stuck at baseline
          : 'rgba(245, 158, 11, 0.75)';   // amber-500 — advancing

        const pos = getCaretPixelPosition(ta, result.offset);
        el.style.display = '';
        el.style.top = `${pos.top}px`;
        el.style.left = `${pos.left}px`;
        el.style.height = `${pos.height}px`;
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

  helper.getTranscriptRows = function getTranscriptRows() {
    return Array.from(document.querySelectorAll('tbody tr')).filter((row) =>
      row.querySelector(helper.config.rowTextareaSelector)
    );
  };

  helper.getRowTextarea = function getRowTextarea(row) {
    return row ? row.querySelector(helper.config.rowTextareaSelector) : null;
  };

  helper.getRowTextValue = function getRowTextValue(row) {
    const textarea = helper.getRowTextarea(row);
    return textarea instanceof HTMLTextAreaElement ? textarea.value || '' : '';
  };

  helper.getActiveRowTextarea = function getActiveRowTextarea() {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.matches(helper.config.rowTextareaSelector)
      ? active
      : null;
  };

  function getReactInternalValue(element, prefix) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    for (const name of Object.getOwnPropertyNames(element)) {
      if (typeof name === 'string' && name.indexOf(prefix) === 0) {
        return element[name];
      }
    }

    return null;
  }

  function getReactFiber(element) {
    return getReactInternalValue(element, '__reactFiber$');
  }

  function injectPlaybackBridge() {
    if (window.__babelHelperPlaybackBridge) {
      playbackBridgeInjected = true;
      return Promise.resolve(true);
    }

    if (playbackBridgeInjected) {
      return Promise.resolve(true);
    }

    if (playbackBridgeLoadPromise) {
      return playbackBridgeLoadPromise;
    }

    playbackBridgeLoadPromise = new Promise((resolve) => {
      const parent = document.documentElement || document.head || document.body;
      if (
        !parent ||
        typeof chrome === 'undefined' ||
        !chrome.runtime ||
        typeof chrome.runtime.getURL !== 'function'
      ) {
        playbackBridgeLoadPromise = null;
        resolve(false);
        return;
      }

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(PLAYBACK_BRIDGE_SCRIPT_PATH);
      script.async = false;
      script.onload = () => {
        script.remove();
        playbackBridgeInjected = true;
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        playbackBridgeLoadPromise = null;
        resolve(false);
      };

      parent.appendChild(script);
    });

    return playbackBridgeLoadPromise;
  }

  async function callPlaybackBridge(operation, payload) {
    const ready = await injectPlaybackBridge();
    if (!ready) {
      return null;
    }

    return new Promise((resolve) => {
      playbackBridgeRequestId += 1;
      const id = 'playback-request-' + playbackBridgeRequestId;
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        window.removeEventListener(PLAYBACK_BRIDGE_RESPONSE_EVENT, handleResponse, true);
        window.clearTimeout(timeoutId);
        resolve(result || null);
      };

      const handleResponse = (event) => {
        const detail = event.detail || {};
        if (detail.id !== id) {
          return;
        }

        finish(detail.result || null);
      };

      const timeoutId = window.setTimeout(() => finish(null), PLAYBACK_BRIDGE_TIMEOUT_MS);
      window.addEventListener(PLAYBACK_BRIDGE_RESPONSE_EVENT, handleResponse, true);
      window.dispatchEvent(
        new CustomEvent(PLAYBACK_BRIDGE_REQUEST_EVENT, {
          detail: {
            id,
            operation,
            payload: payload || {}
          }
        })
      );
    });
  }

  function getWaveRegistryFromValue(value) {
    const registry =
      value && typeof value === 'object' && !Array.isArray(value) && value.current
        ? value.current
        : value;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      return null;
    }

    const keys = Object.keys(registry);
    const hasWaveEntry = keys.some((key) => {
      const entry = registry[key];
      return entry && typeof entry === 'object' && entry.wavesurfer;
    });
    return hasWaveEntry ? registry : null;
  }

  function getWaveRegistryFromFiber(fiber) {
    let owner = fiber;
    let ownerDepth = 0;
    while (owner && typeof owner === 'object' && ownerDepth < 16) {
      let hook = owner.memoizedState;
      let hookIndex = 0;
      while (hook && typeof hook === 'object' && hookIndex < 24) {
        const registry = getWaveRegistryFromValue(hook.memoizedState);
        if (registry) {
          return registry;
        }

        hook = hook.next;
        hookIndex += 1;
      }

      owner = owner.return;
      ownerDepth += 1;
    }

    return null;
  }

  function getWaveRegistryFromPlaybackControls() {
    const controls = document.querySelectorAll(
      'button[aria-label="Jump back 5 seconds"], button[aria-label="Play all tracks"], button[aria-label="Pause all tracks"], button[aria-label="Jump forward 5 seconds"]'
    );
    for (const control of controls) {
      const registry = getWaveRegistryFromFiber(getReactFiber(control));
      if (registry) {
        return registry;
      }
    }

    return null;
  }

  function getWaveformHosts() {
    return Array.from(document.querySelectorAll('div')).filter((node) => {
      if (!(node instanceof HTMLDivElement) || !(node.shadowRoot instanceof ShadowRoot)) {
        return false;
      }

      return Boolean(node.shadowRoot.querySelector('[part="scroll"], [part="wrapper"]'));
    });
  }

  function getWaveformRegistryFromHost(host) {
    let fiber = getReactFiber(host);
    if (!fiber && host instanceof HTMLElement) {
      fiber = getReactFiber(host.parentElement);
    }
    return getWaveRegistryFromFiber(fiber);
  }

  function getPlaybackWaveInstances() {
    const unique = [];
    const seen = new Set();
    const registries = [];
    const playbackRegistry = getWaveRegistryFromPlaybackControls();
    if (playbackRegistry) {
      registries.push(playbackRegistry);
    }

    for (const host of getWaveformHosts()) {
      const registry = getWaveformRegistryFromHost(host);
      if (!registry || typeof registry !== 'object') {
        continue;
      }
      registries.push(registry);
    }

    for (const registry of registries) {
      for (const key of Object.keys(registry)) {
        const entry = registry[key];
        const wave =
          entry && typeof entry === 'object' && entry.wavesurfer ? entry.wavesurfer : null;
        if (
          !wave ||
          typeof wave !== 'object' ||
          seen.has(wave) ||
          typeof wave.getCurrentTime !== 'function' ||
          typeof wave.setTime !== 'function'
        ) {
          continue;
        }

        seen.add(wave);
        unique.push(wave);
      }
    }

    return unique;
  }

  function normalizeSpeakerLabel(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    const match = text.match(/\bspeaker\s*([12])\b/i);
    if (!match) {
      return '';
    }

    return 'Speaker ' + match[1];
  }

  function normalizeTrackFilterLabel(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (/\ball\s*tracks\b/i.test(text)) {
      return 'All Tracks';
    }

    return normalizeSpeakerLabel(text);
  }

  function getSpeakerLane(label) {
    const normalizedTarget = normalizeSpeakerLabel(label);
    if (!normalizedTarget) {
      return null;
    }

    const targetLower = normalizedTarget.toLowerCase();
    const headings = Array.from(document.querySelectorAll('h3'));
    for (const heading of headings) {
      if (!(heading instanceof HTMLElement)) {
        continue;
      }

      if (helper.normalizeText(heading).toLowerCase() !== targetLower) {
        continue;
      }

      const header = heading.parentElement;
      if (!(header instanceof HTMLElement)) {
        continue;
      }

      const visibilityButton = header.querySelector(
        'button[aria-label="Show track"], button[aria-label="Hide track"]'
      );
      if (!(visibilityButton instanceof HTMLElement)) {
        continue;
      }

      const controlsRoot = header.parentElement instanceof HTMLElement ? header.parentElement : header;
      const solo = controlsRoot.querySelector('button[aria-label="Solo track"], button[aria-label="Unsolo track"]');

      return {
        label: normalizedTarget,
        heading,
        header,
        controlsRoot,
        visibilityButton,
        soloButton: solo instanceof HTMLElement ? solo : null
      };
    }

    return null;
  }

  function getLaneVisibilityState(lane) {
    const button =
      lane &&
      lane.visibilityButton instanceof HTMLElement &&
      lane.visibilityButton.isConnected
        ? lane.visibilityButton
        : null;
    if (!(button instanceof HTMLElement)) {
      return '';
    }

    const ariaLabel = helper.normalizeText(button).toLowerCase() || '';
    const semantic = (button.getAttribute('aria-label') || '').toLowerCase();
    if (semantic === 'show track' || ariaLabel === 'show track') {
      return 'hidden';
    }
    if (semantic === 'hide track' || ariaLabel === 'hide track') {
      return 'visible';
    }

    return '';
  }

  function getLaneMuteState(lane) {
    const button =
      lane &&
      lane.soloButton instanceof HTMLElement &&
      lane.soloButton.isConnected
        ? lane.soloButton
        : null;
    if (!(button instanceof HTMLElement)) {
      return '';
    }

    const label = (button.getAttribute('aria-label') || '').trim().toLowerCase();
    if (label === 'solo track') {
      return 'muted';
    }
    if (label === 'unsolo track') {
      return 'unmuted';
    }

    return '';
  }

  function clickControl(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    try {
      element.click();
      return true;
    } catch (_error) {
      helper.dispatchClick(element);
      return true;
    }
  }

  async function ensureLaneVisibility(label, shouldBeVisible) {
    const lane = getSpeakerLane(label);
    if (!lane) {
      return false;
    }

    const targetState = shouldBeVisible ? 'visible' : 'hidden';
    const currentState = getLaneVisibilityState(lane);
    if (currentState === targetState) {
      return true;
    }

    clickControl(lane.visibilityButton);

    const settled = await helper.waitFor(() => {
      const refreshed = getSpeakerLane(label);
      if (!refreshed) {
        return null;
      }

      return getLaneVisibilityState(refreshed) === targetState ? refreshed : null;
    }, 900, 40);

    return Boolean(settled);
  }

  function getPlayAllTracksButton() {
    const button = document.querySelector('button[aria-label="Play all tracks"]');
    return button instanceof HTMLElement ? button : null;
  }

  function getPauseAllTracksButton() {
    const button = document.querySelector('button[aria-label="Pause all tracks"]');
    return button instanceof HTMLElement ? button : null;
  }

  async function ensureLaneMuteState(label, shouldBeMuted) {
    const desired = shouldBeMuted ? 'muted' : 'unmuted';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lane = getSpeakerLane(label);
      if (!lane) {
        return false;
      }

      const current = getLaneMuteState(lane);
      if (current === desired) {
        return true;
      }

      const button = lane.soloButton;
      if (!(button instanceof HTMLElement)) {
        const ready = await helper.waitFor(() => {
          const refreshed = getSpeakerLane(label);
          return refreshed && refreshed.soloButton instanceof HTMLElement ? refreshed : null;
        }, 600, 40);

        if (!ready) {
          continue;
        }
      }

      const refreshedLane = getSpeakerLane(label);
      if (!(refreshedLane && refreshedLane.soloButton instanceof HTMLElement)) {
        continue;
      }

      clickControl(refreshedLane.soloButton);
      const settled = await helper.waitFor(() => {
        const next = getSpeakerLane(label);
        return next && getLaneMuteState(next) === desired ? next : null;
      }, 900, 40);
      if (settled) {
        return true;
      }
    }

    return false;
  }

  function getUniqueLaneSoloButtons() {
    const buttons = [];
    const seen = new Set();
    for (const label of ['Speaker 1', 'Speaker 2']) {
      const lane = getSpeakerLane(label);
      const button = lane && lane.soloButton instanceof HTMLElement ? lane.soloButton : null;
      if (!(button instanceof HTMLElement) || seen.has(button)) {
        continue;
      }

      seen.add(button);
      buttons.push(button);
    }

    return buttons;
  }

  function hasActiveSoloMode(buttons) {
    for (const button of buttons) {
      const label = (button.getAttribute('aria-label') || '').trim().toLowerCase();
      if (label === 'unsolo track') {
        return true;
      }
    }

    return false;
  }

  async function clearAllLaneMutes() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const buttons = getUniqueLaneSoloButtons();
      if (!buttons.length) {
        return false;
      }

      const active = buttons.find(
        (button) => (button.getAttribute('aria-label') || '').trim().toLowerCase() === 'unsolo track'
      );
      if (!(active instanceof HTMLElement)) {
        return true;
      }

      clickControl(active);
      const settled = await helper.waitFor(() => {
        const refreshedButtons = getUniqueLaneSoloButtons();
        return refreshedButtons.length && !hasActiveSoloMode(refreshedButtons) ? refreshedButtons : null;
      }, 900, 40);
      if (settled) {
        return true;
      }
    }

    return false;
  }

  function findSpeakerSelectorCombobox() {
    function isSpeakerSelectorCombobox(node) {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      const label = helper.normalizeText(node);
      return Boolean(normalizeTrackFilterLabel(label));
    }

    const playAll = getPlayAllTracksButton();
    let current = playAll instanceof HTMLElement ? playAll.parentElement : null;

    while (current instanceof HTMLElement) {
      const combo = Array.from(current.querySelectorAll('button[role="combobox"]')).find((node) =>
        isSpeakerSelectorCombobox(node)
      );
      if (combo instanceof HTMLElement) {
        return combo;
      }

      current = current.parentElement;
    }

    const fallback = Array.from(document.querySelectorAll('button[role="combobox"]')).find((node) =>
      isSpeakerSelectorCombobox(node)
    );

    return fallback instanceof HTMLElement ? fallback : null;
  }

  function findSpeakerSelectorOption(label) {
    const normalizedTarget = normalizeTrackFilterLabel(label);
    if (!normalizedTarget) {
      return null;
    }

    const targetLower = normalizedTarget.toLowerCase();
    const candidates = Array.from(
      document.querySelectorAll(
        '[role="option"], [role="menuitemradio"], [role="menuitem"], [data-radix-collection-item]'
      )
    );

    for (const node of candidates) {
      if (!(node instanceof HTMLElement) || !helper.isVisible(node)) {
        continue;
      }

      if (node.matches('button[role="combobox"]')) {
        continue;
      }

      const candidateLabel = normalizeTrackFilterLabel(helper.normalizeText(node));
      if (candidateLabel && candidateLabel.toLowerCase() === targetLower) {
        return node;
      }
    }

    return null;
  }

  async function selectSpeakerInToolbar(label) {
    const normalizedTarget = normalizeTrackFilterLabel(label);
    if (!normalizedTarget) {
      return false;
    }

    const combo = findSpeakerSelectorCombobox();
    if (!(combo instanceof HTMLElement)) {
      return false;
    }

    const activeLabel = normalizeTrackFilterLabel(helper.normalizeText(combo));
    if (activeLabel === normalizedTarget) {
      return true;
    }

    clickControl(combo);

    const option = await helper.waitFor(() => findSpeakerSelectorOption(normalizedTarget), 900, 40);
    if (!(option instanceof HTMLElement)) {
      return false;
    }

    clickControl(option);
    const applied = await helper.waitFor(() => {
      const nextCombo = findSpeakerSelectorCombobox();
      if (!(nextCombo instanceof HTMLElement)) {
        return null;
      }

      return normalizeTrackFilterLabel(helper.normalizeText(nextCombo)) === normalizedTarget
        ? nextCombo
        : null;
    }, 1000, 40);

    return Boolean(applied);
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

    const otherLabel = targetLabel === 'Speaker 1' ? 'Speaker 2' : 'Speaker 1';
    helper.state.speakerSwitchPending = true;

    try {
      const targetVisible = await ensureLaneVisibility(targetLabel, true);
      const otherVisibleForMute = await ensureLaneVisibility(otherLabel, true);
      const targetMuted = await ensureLaneMuteState(targetLabel, true);
      const otherUnmuted = await ensureLaneMuteState(otherLabel, false);
      const otherHidden = await ensureLaneVisibility(otherLabel, false);
      const selectorUpdated = await selectSpeakerInToolbar(targetLabel);

      return Boolean(
        targetVisible &&
        otherVisibleForMute &&
        targetMuted &&
        otherUnmuted &&
        otherHidden &&
        selectorUpdated
      );
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
      const speakerOneVisible = await ensureLaneVisibility('Speaker 1', true);
      const speakerTwoVisible = await ensureLaneVisibility('Speaker 2', true);
      const allUnmuted = await clearAllLaneMutes();
      const selectorUpdated = await selectSpeakerInToolbar('All Tracks');

      return Boolean(speakerOneVisible && speakerTwoVisible && allUnmuted && selectorUpdated);
    } finally {
      helper.state.speakerSwitchPending = false;
    }
  };

  helper.getRowIdentity = function getRowIdentity(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const identity = {
      annotationId: null,
      processedRecordingId: null,
      trackLabel: '',
      speakerKey: '',
      isActive: false,
      startText: '',
      endText: ''
    };

    const startCell = row.children[2];
    const endCell = row.children[3];
    identity.startText = startCell instanceof HTMLElement ? helper.normalizeText(startCell) : '';
    identity.endText = endCell instanceof HTMLElement ? helper.normalizeText(endCell) : '';

    let fiber = getReactFiber(row);
    if (!fiber) {
      const textarea = helper.getRowTextarea(row);
      fiber = getReactFiber(textarea);
    }

    let current = fiber;
    let depth = 0;
    while (current && typeof current === 'object' && depth < 12) {
      const props = current.memoizedProps;
      if (props && typeof props === 'object' && typeof props.isActive === 'boolean') {
        identity.isActive = props.isActive;
      }

      const annotation =
        props && typeof props === 'object' && props.annotation && typeof props.annotation === 'object'
          ? props.annotation
          : null;
      if (annotation && typeof annotation.id === 'string' && annotation.id) {
        identity.annotationId = annotation.id;
        identity.processedRecordingId =
          annotation.processedRecordingId != null ? String(annotation.processedRecordingId) : null;
        identity.trackLabel =
          typeof annotation.trackLabel === 'string' ? annotation.trackLabel.trim() : '';
        identity.speakerKey =
          identity.processedRecordingId ||
          identity.trackLabel ||
          (row.children[1] instanceof HTMLElement ? helper.normalizeText(row.children[1]) : '');
        break;
      }

      current = current.return;
      depth += 1;
    }

    if (!identity.speakerKey) {
      identity.speakerKey =
        (row.children[1] instanceof HTMLElement ? helper.normalizeText(row.children[1]) : '') || '';
    }

    if (!identity.annotationId && !identity.startText && !identity.endText && !identity.speakerKey) {
      return null;
    }

    return identity;
  };

  helper.getRowSpeakerKey = function getRowSpeakerKey(row) {
    const identity = helper.getRowIdentity(row);
    return identity && typeof identity.speakerKey === 'string' ? identity.speakerKey : '';
  };

  helper.rowsShareSpeaker = function rowsShareSpeaker(leftRow, rightRow) {
    const leftKey = helper.getRowSpeakerKey(leftRow);
    const rightKey = helper.getRowSpeakerKey(rightRow);
    return Boolean(leftKey && rightKey && leftKey === rightKey);
  };

  helper.findAdjacentRowBySpeaker = function findAdjacentRowBySpeaker(row, offset) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    const currentIndex = rows.indexOf(row);
    if (currentIndex < 0 || !offset) {
      return null;
    }

    const direction = offset < 0 ? -1 : 1;
    const speakerKey = helper.getRowSpeakerKey(row);
    if (!speakerKey) {
      return null;
    }

    for (
      let index = currentIndex + direction;
      index >= 0 && index < rows.length;
      index += direction
    ) {
      const candidate = rows[index];
      if (!(candidate instanceof HTMLTableRowElement)) {
        continue;
      }

      if (helper.getRowSpeakerKey(candidate) === speakerKey) {
        return candidate;
      }
    }

    return null;
  };

  helper.findActiveRowByReactState = function findActiveRowByReactState() {
    const rows = helper.getTranscriptRows();
    return (
      rows.find((row) => {
        const identity = helper.getRowIdentity(row);
        return Boolean(identity && identity.isActive);
      }) || null
    );
  };

  helper.findActiveRowByDomState = function findActiveRowByDomState() {
    const rows = helper.getTranscriptRows();
    return (
      rows.find((row) => {
        if (!(row instanceof HTMLElement)) {
          return false;
        }

        const classes = row.classList;
        return (
          classes.contains('bg-neutral-100') &&
          classes.contains('ring-1') &&
          classes.contains('ring-neutral-300')
        );
      }) || null
    );
  };

  helper.rowMatchesIdentity = function rowMatchesIdentity(row, identity) {
    if (!(row instanceof HTMLElement) || !identity || typeof identity !== 'object') {
      return false;
    }

    const rowIdentity = helper.getRowIdentity(row);
    if (!rowIdentity) {
      return false;
    }

    if (
      identity.annotationId &&
      rowIdentity.annotationId &&
      identity.annotationId === rowIdentity.annotationId
    ) {
      return true;
    }

    return Boolean(
      identity.speakerKey &&
      rowIdentity.speakerKey &&
      identity.speakerKey === rowIdentity.speakerKey &&
      (
        (
      identity.startText &&
      identity.endText &&
      identity.startText === rowIdentity.startText &&
      identity.endText === rowIdentity.endText
        ) ||
        (
          !identity.startText &&
          !identity.endText
        )
      )
    );
  };

  helper.findRowByIdentity = function findRowByIdentity(identity) {
    if (!identity || typeof identity !== 'object') {
      return null;
    }

    const rows = helper.getTranscriptRows();
    if (identity.annotationId) {
      const byAnnotation = rows.find((row) => {
        const rowIdentity = helper.getRowIdentity(row);
        return rowIdentity && rowIdentity.annotationId === identity.annotationId;
      });
      if (byAnnotation) {
        return byAnnotation;
      }
    }

    if (identity.startText && identity.endText) {
      return (
        rows.find((row) => {
          const rowIdentity = helper.getRowIdentity(row);
          return (
            rowIdentity &&
            (
              !identity.speakerKey ||
              !rowIdentity.speakerKey ||
              rowIdentity.speakerKey === identity.speakerKey
            ) &&
            rowIdentity.startText === identity.startText &&
            rowIdentity.endText === identity.endText
          );
        }) || null
      );
    }

    return null;
  };

  helper.getCurrentRow = function getCurrentRow(options) {
    const settings = options || {};
    const allowFallback = settings.allowFallback !== false;

    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const activeRow = active.closest('tr');
      if (activeRow && activeRow.querySelector(helper.config.rowTextareaSelector)) {
        helper.setCurrentRow(activeRow);
        return activeRow;
      }
    }

    const activeRowByDom = helper.findActiveRowByDomState();
    if (activeRowByDom) {
      helper.setCurrentRow(activeRowByDom);
      return activeRowByDom;
    }

    const activeRowByState = helper.findActiveRowByReactState();
    if (activeRowByState) {
      helper.setCurrentRow(activeRowByState);
      return activeRowByState;
    }

    const cachedRow = helper.state.currentRow;
    const cachedIdentity =
      helper.state.currentRowIdentity ||
      (cachedRow instanceof HTMLElement ? helper.getRowIdentity(cachedRow) : null);

    if (cachedRow instanceof HTMLElement && cachedRow.isConnected) {
      if (!cachedIdentity || helper.rowMatchesIdentity(cachedRow, cachedIdentity)) {
        return cachedRow;
      }
    }

    if (cachedIdentity) {
      const resolved = helper.findRowByIdentity(cachedIdentity);
      if (resolved) {
        helper.state.currentRow = resolved;
        helper.state.currentRowIdentity = helper.getRowIdentity(resolved);
        return resolved;
      }
    }

    if (!allowFallback) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    return rows[0] || null;
  };

  helper.getCurrentRowIndex = function getCurrentRowIndex() {
    const rows = helper.getTranscriptRows();
    const currentRow = helper.getCurrentRow();
    return currentRow ? rows.indexOf(currentRow) : -1;
  };

  helper.setCurrentRow = function setCurrentRow(row) {
    if (row && row.isConnected) {
      helper.state.currentRow = row;
      helper.state.currentRowIdentity = helper.getRowIdentity(row);
    } else {
      helper.state.currentRow = null;
      helper.state.currentRowIdentity = null;
    }
  };

  helper.getMenuRoots = function getMenuRoots() {
    const portalRoots = Array.from(
      document.querySelectorAll('[data-radix-popper-content-wrapper], [data-radix-portal], [role="menu"]')
    );
    return portalRoots.length ? portalRoots : [document.body];
  };

  helper.collectMenuCandidates = function collectMenuCandidates() {
    const selectors = [
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[data-radix-collection-item]'
    ];
    const matches = [];
    const seen = new Set();

    for (const root of helper.getMenuRoots()) {
      const scoped = Array.from(root.querySelectorAll(selectors.join(',')));
      for (const node of scoped) {
        if (seen.has(node) || !helper.isVisible(node)) {
          continue;
        }

        const label = helper.normalizeText(node);
        if (!label) {
          continue;
        }

        seen.add(node);
        matches.push(node);
      }
    }

    if (matches.length) {
      return matches;
    }

    const fallback = [];
    for (const root of helper.getMenuRoots()) {
      const scoped = Array.from(root.querySelectorAll('button, [role], div, span'));
      for (const node of scoped) {
        if (!(node instanceof HTMLElement) || seen.has(node) || !helper.isVisible(node)) {
          continue;
        }

        if (node.children.length > 1 && !node.matches('button, [role]')) {
          continue;
        }

        const label = helper.normalizeText(node);
        if (!label) {
          continue;
        }

        seen.add(node);
        fallback.push(node);
      }
    }

    return fallback;
  };

  helper.findMenuAction = function findMenuAction(actionName, options) {
    const settings = options || {};
    const exclude = settings.exclude instanceof Set ? settings.exclude : null;
    const candidates = helper
      .collectMenuCandidates()
      .filter((candidate) => !(exclude && exclude.has(candidate)));
    const patterns = helper.config.actionPatterns[actionName] || [];
    for (const pattern of patterns) {
      const found = candidates.find((candidate) => pattern.test(helper.normalizeText(candidate)));
      if (found) {
        return found;
      }
    }

    if (actionName === 'mergePrevious' || actionName === 'mergeNext') {
      for (const pattern of helper.config.actionPatterns.mergeFallback) {
        const found = candidates.find((candidate) => pattern.test(helper.normalizeText(candidate)));
        if (found) {
          return found;
        }
      }
    }

    return null;
  };

  function getMergeActionPlan(actionName, row, rows, originalIndex) {
    if (
      (actionName !== 'mergePrevious' && actionName !== 'mergeNext') ||
      !(row instanceof HTMLTableRowElement) ||
      !Array.isArray(rows) ||
      originalIndex < 0
    ) {
      return null;
    }

    const direction = actionName === 'mergePrevious' ? -1 : 1;
    const adjacentRow = rows[originalIndex + direction];
    if (!(adjacentRow instanceof HTMLTableRowElement)) {
      return null;
    }

    const survivingRow = direction < 0 ? adjacentRow : row;
    const survivingText = helper.getRowTextValue(survivingRow);
    const mergedText =
      direction < 0
        ? helper.joinSegmentText(helper.getRowTextValue(adjacentRow), helper.getRowTextValue(row))
        : helper.joinSegmentText(helper.getRowTextValue(row), helper.getRowTextValue(adjacentRow));
    const appendedText = direction < 0 ? helper.getRowTextValue(row) : helper.getRowTextValue(adjacentRow);
    const caretOffset =
      appendedText && mergedText.endsWith(appendedText)
        ? mergedText.length - appendedText.length
        : survivingText.length;

    return {
      actionName,
      adjacentRow,
      adjacentText: helper.getRowTextValue(adjacentRow),
      expectedRowCount: rows.length - 1,
      mergedText,
      originalIndex,
      survivingRow,
      survivingText,
      targetIndex: direction < 0 ? Math.max(0, originalIndex - 1) : originalIndex,
      caretOffset
    };
  }

  function findMergedRow(plan, updatedRows) {
    if (!plan || !Array.isArray(updatedRows) || !updatedRows.length) {
      return null;
    }

    const candidates = [];
    if (plan.survivingRow instanceof HTMLTableRowElement && plan.survivingRow.isConnected) {
      candidates.push(plan.survivingRow);
    }

    const indexed = updatedRows[plan.targetIndex];
    if (indexed instanceof HTMLTableRowElement && !candidates.includes(indexed)) {
      candidates.push(indexed);
    }

    for (const row of updatedRows) {
      if (row instanceof HTMLTableRowElement && !candidates.includes(row)) {
        candidates.push(row);
      }
    }

    for (const candidate of candidates) {
      const text = helper.getRowTextValue(candidate);
      if (!text) {
        continue;
      }

      if (text === plan.mergedText) {
        return candidate;
      }

      if (
        text !== plan.survivingText &&
        text.includes(plan.survivingText) &&
        (!plan.adjacentText || text.includes(plan.adjacentText))
      ) {
        return candidate;
      }
    }

    return candidates[0] || null;
  }

  function restoreMergeSelection(row, caretOffset) {
    if (!(row instanceof HTMLTableRowElement)) {
      return false;
    }

    const textarea = helper.getRowTextarea(row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const caret = Math.max(0, Math.min(textarea.value.length, Number(caretOffset) || 0));
    const applySelection = () => {
      helper.state.lastBlur = {
        row,
        selectionStart: caret,
        selectionEnd: caret,
        direction: 'none'
      };
      helper.state.blurRestorePending = true;
      textarea.focus({
        preventScroll: true
      });

      try {
        textarea.setSelectionRange(caret, caret, 'none');
      } catch (_error) {
        // Ignore selection errors from browsers that reject the call mid-render.
      }
    };

    helper.focusRow(row, {
      activateRow: false,
      scroll: false,
      selectionStart: caret,
      selectionEnd: caret
    });

    window.requestAnimationFrame(() => {
      applySelection();
      window.requestAnimationFrame(applySelection);
    });
    window.setTimeout(applySelection, 80);
    window.setTimeout(applySelection, 180);

    return true;
  }

  helper.runRowAction = async function runRowAction(actionName, options) {
    const settings = options || {};
    const row =
      settings.row instanceof HTMLElement
        ? settings.row
        : helper.getCurrentRow({
            allowFallback: settings.allowFallback !== false
          });
    if (!row) {
      return false;
    }

    const actionTrigger = row.querySelector(helper.config.actionTriggerSelector);
    if (!(actionTrigger instanceof HTMLElement)) {
      return false;
    }

    const rows = helper.getTranscriptRows();
    const originalIndex = rows.indexOf(row);
    const mergePlan = getMergeActionPlan(actionName, row, rows, originalIndex);
    helper.setCurrentRow(row);

    const previousCandidates = new Set(helper.collectMenuCandidates());
    helper.dispatchClick(actionTrigger);

    await helper.waitFor(
      () =>
        actionTrigger.getAttribute('aria-expanded') === 'true' ||
        actionTrigger.getAttribute('data-state') === 'open',
      250,
      25
    );

    const actionItem = await helper.waitFor(
      () =>
        helper.findMenuAction(actionName, {
          exclude: previousCandidates
        }) || helper.findMenuAction(actionName),
      1000,
      50
    );
    if (!(actionItem instanceof HTMLElement)) {
      helper.dispatchClick(actionTrigger);
      return false;
    }

    helper.dispatchClick(actionItem);

    if (helper.analytics) {
      if (actionName === 'mergePrevious') {
        helper.analytics.record('text:merge-previous', {
          rowIndex: originalIndex,
          hasMergePlan: Boolean(mergePlan)
        });
      } else if (actionName === 'mergeNext') {
        helper.analytics.record('text:merge-next', {
          rowIndex: originalIndex,
          hasMergePlan: Boolean(mergePlan)
        });
      }
    }

    if (mergePlan) {
      const mergedRow = await helper.waitFor(() => {
        const updatedRows = helper.getTranscriptRows();
        const candidate = findMergedRow(mergePlan, updatedRows);
        if (!(candidate instanceof HTMLTableRowElement)) {
          return null;
        }

        const text = helper.getRowTextValue(candidate);
        const rowCountSettled = updatedRows.length <= mergePlan.expectedRowCount;
        const textSettled =
          text === mergePlan.mergedText ||
          (text !== mergePlan.survivingText &&
            text.includes(mergePlan.survivingText) &&
            (!mergePlan.adjacentText || text.includes(mergePlan.adjacentText)));
        const adjacentRemoved =
          !(mergePlan.adjacentRow instanceof HTMLTableRowElement) || !mergePlan.adjacentRow.isConnected;

        return rowCountSettled || textSettled || adjacentRemoved ? candidate : null;
      }, 1200, 40);

      const resolvedRow =
        (mergedRow instanceof HTMLTableRowElement && mergedRow) ||
        findMergedRow(mergePlan, helper.getTranscriptRows());
      if (resolvedRow) {
        helper.setCurrentRow(resolvedRow);
        restoreMergeSelection(resolvedRow, mergePlan.caretOffset);
        return true;
      }
    }

    window.setTimeout(() => {
      const updatedRows = helper.getTranscriptRows();
      if (!updatedRows.length) {
        helper.setCurrentRow(null);
        return;
      }

      const fallbackIndex = originalIndex >= 0 ? Math.min(originalIndex, updatedRows.length - 1) : 0;
      helper.setCurrentRow(updatedRows[fallbackIndex]);
    }, 180);

    return true;
  };

  helper.focusRow = function focusRow(row, options) {
    if (!row) {
      return false;
    }

    const textarea = helper.getRowTextarea(row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    helper.setCurrentRow(row);
    if (!options || options.scroll !== false) {
      row.scrollIntoView({
        block: 'center',
        behavior: 'smooth'
      });
    }
    if (!options || options.activateRow !== false) {
      row.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }
    textarea.focus({
      preventScroll: true
    });

    try {
      if (options && typeof options.selectionStart === 'number') {
        const end =
          typeof options.selectionEnd === 'number' ? options.selectionEnd : options.selectionStart;
        textarea.setSelectionRange(
          options.selectionStart,
          end,
          typeof options.direction === 'string' ? options.direction : 'none'
        );
      } else if (options && options.cursor === 'start') {
        textarea.setSelectionRange(0, 0);
      } else {
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    } catch (_error) {
      // Ignore selection errors from browsers that reject the call mid-render.
    }

    return true;
  };

  helper.moveFocus = function moveFocus(offset) {
    const rows = helper.getTranscriptRows();
    if (!rows.length) {
      return false;
    }

    const currentIndex = helper.getCurrentRowIndex();
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(0, Math.min(rows.length - 1, baseIndex + offset));
    if (nextIndex === baseIndex && currentIndex >= 0) {
      return false;
    }

    return helper.focusRow(rows[nextIndex]);
  };

  helper.joinSegmentText = function joinSegmentText(left, right) {
    const before = typeof left === 'string' ? left : String(left ?? '');
    const after = typeof right === 'string' ? right : String(right ?? '');
    if (!before) {
      return after;
    }
    if (!after) {
      return before;
    }

    if (/\s$/.test(before) || /^\s/.test(after)) {
      return before + after;
    }

    return before + ' ' + after;
  };

  helper.splitTextByWordRatio = function splitTextByWordRatio(text, ratio) {
    const source = typeof text === 'string' ? text : String(text ?? '');
    const words = source.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      return {
        firstText: '',
        secondText: '',
        splitCount: 0,
        wordCount: 0
      };
    }

    const clampedRatio = Math.min(Math.max(Number(ratio) || 0, 0), 1);
    let splitCount = Math.round(words.length * clampedRatio);
    if (clampedRatio > 0 && clampedRatio < 1 && words.length > 1) {
      splitCount = Math.max(1, Math.min(words.length - 1, splitCount));
    } else {
      splitCount = Math.max(0, Math.min(words.length, splitCount));
    }

    return {
      firstText: words.slice(0, splitCount).join(' '),
      secondText: words.slice(splitCount).join(' '),
      splitCount,
      wordCount: words.length
    };
  };

  helper.applySmartSplitToRows = function applySmartSplitToRows(leftRow, rightRow, sourceText, ratio) {
    const leftTextarea = helper.getRowTextarea(leftRow);
    const rightTextarea = helper.getRowTextarea(rightRow);
    if (!(leftTextarea instanceof HTMLTextAreaElement) || !(rightTextarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const parts = helper.splitTextByWordRatio(sourceText, ratio);
    if (!parts.wordCount) {
      return false;
    }

    const wroteLeft = helper.setEditableValue(leftTextarea, parts.firstText);
    const wroteRight = helper.setEditableValue(rightTextarea, parts.secondText);
    return Boolean(wroteLeft && wroteRight);
  };

  helper.moveTextToAdjacentSegment = function moveTextToAdjacentSegment(offset) {
    const textarea = helper.getActiveRowTextarea();
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const row = textarea.closest('tr');
    if (!(row instanceof HTMLElement)) {
      return false;
    }

    const rows = helper.getTranscriptRows();
    const currentIndex = rows.indexOf(row);
    if (currentIndex < 0) {
      return false;
    }

    const targetRow = helper.findAdjacentRowBySpeaker(row, offset);
    if (!(targetRow instanceof HTMLTableRowElement)) {
      return false;
    }

    const targetTextarea = helper.getRowTextarea(targetRow);
    if (!(targetTextarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const currentValue = textarea.value || '';
    const targetValue = targetTextarea.value || '';
    const selectionStart =
      typeof textarea.selectionStart === 'number' ? textarea.selectionStart : currentValue.length;
    const selectionEnd =
      typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : selectionStart;

    if (offset < 0) {
      const splitIndex = Math.max(0, Math.min(currentValue.length, selectionStart));
      const movedText = currentValue.slice(0, splitIndex).replace(/^\s+/, '').replace(/\s+$/, '');
      if (!movedText) {
        return false;
      }

      const nextCurrentValue = currentValue.slice(splitIndex).replace(/^\s+/, '');
      const nextTargetValue = helper.joinSegmentText(targetValue, movedText);
      if (!helper.setEditableValue(targetTextarea, nextTargetValue)) {
        return false;
      }
      if (!helper.setEditableValue(textarea, nextCurrentValue)) {
        return false;
      }

      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, 0);
      helper.setCurrentRow(row);

      if (helper.analytics) {
        helper.analytics.record('text:move-left', {
          movedLength: movedText.length,
          splitIndex,
          remainingLength: nextCurrentValue.length,
          targetLength: nextTargetValue.length
        });
      }
      return true;
    }

    const splitIndex = Math.max(0, Math.min(currentValue.length, selectionEnd));
    const movedText = currentValue.slice(splitIndex).replace(/^\s+/, '').replace(/\s+$/, '');
    if (!movedText) {
      return false;
    }

    const nextCurrentValue = currentValue.slice(0, splitIndex).replace(/\s+$/, '');
    const nextTargetValue = helper.joinSegmentText(movedText, targetValue);
    if (!helper.setEditableValue(textarea, nextCurrentValue)) {
      return false;
    }
    if (!helper.setEditableValue(targetTextarea, nextTargetValue)) {
      return false;
    }

    const caret = nextCurrentValue.length;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
    helper.setCurrentRow(row);

    if (helper.analytics) {
      helper.analytics.record('text:move-right', {
        movedLength: movedText.length,
        splitIndex,
        remainingLength: nextCurrentValue.length,
        targetLength: nextTargetValue.length
      });
    }
    return true;
  };

  helper.clearActiveFocus = function clearActiveFocus() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return false;
    }

    if (helper.isEditable(active)) {
      active.blur();
    }

    if (document.activeElement === active) {
      document.body.setAttribute('tabindex', '-1');
      document.body.focus({
        preventScroll: true
      });
      document.body.removeAttribute('tabindex');
    }

    return document.activeElement !== active;
  };

  helper.toggleEditorFocus = function toggleEditorFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.matches(helper.config.rowTextareaSelector)) {
      const row = active.closest('tr');
      if (row) {
        helper.setCurrentRow(row);
      }

      const selStart = active.selectionStart;
      const selEnd = active.selectionEnd;
      const textLen = (active.value || '').length;
      const rowId = row ? (helper.getRowIdentity(row)?.annotationId ?? null) : null;

      helper.state.lastBlur = {
        row: row || helper.getCurrentRow(),
        selectionStart: selStart,
        selectionEnd: selEnd,
        direction: active.selectionDirection || 'none'
      };
      helper.state.blurRestorePending = true;

      // Preserve the current cursor baseline. If the user manually moved
      // the cursor since the last restore, cursorBaseline was already
      // updated by the input/selectionchange listener. If not, use the
      // current selection as a sensible default.
      if (typeof helper.state.cursorBaseline !== 'number') {
        helper.state.cursorBaseline = selStart;
      }

      const cleared = helper.clearActiveFocus();

      if (helper.analytics) {
        helper.analytics.record('focus:blur', {
          rowId,
          cursorPos: selStart,
          selectionLength: selEnd - selStart,
          textLength: textLen,
          cursorBaseline: helper.state.cursorBaseline,
          cursorRatio: textLen > 0 ? Math.round((selStart / textLen) * 100) / 100 : null
        });
      }

      return cleared;
    }

    const remembered = helper.state.lastBlur;
    if (!helper.state.blurRestorePending) {
      return false;
    }

    // Tear down the ghost cursor as soon as we begin restoring focus.
    stopGhostCursor();

    const currentRow = helper.getCurrentRow();
    if (!remembered) {
      const focused = helper.focusRow(currentRow, { cursor: 'start' });
      if (focused) {
        helper.state.blurRestorePending = false;
        if (helper.analytics) {
          helper.analytics.record('focus:restore-fallback', { reason: 'no-remembered-blur' });
        }
      }
      return focused;
    }

    const rememberedRow = remembered.row;
    const rememberedRowStillCurrent =
      rememberedRow &&
      rememberedRow.isConnected &&
      currentRow &&
      currentRow === rememberedRow;

    if (rememberedRowStillCurrent) {
      let selectionStart = remembered.selectionStart;
      let selectionEnd = remembered.selectionEnd;
      let direction = remembered.direction;
      let usedProportional = false;

      if (helper.config.features.proportionalCursorRestore) {
        const blurTime = helper.state.blurPlaybackTime;
        const restoreTime = helper.state.restorePlaybackTime;
        if (
          typeof blurTime === 'number' && Number.isFinite(blurTime) &&
          typeof restoreTime === 'number' && Number.isFinite(restoreTime) &&
          Math.abs(restoreTime - blurTime) >= PROPORTIONAL_MIN_DELTA_SECONDS
        ) {
          const timeRange = getRowTimeRange(rememberedRow);
          if (timeRange) {
            const textarea = helper.getRowTextarea(rememberedRow);
            const text = textarea instanceof HTMLTextAreaElement ? textarea.value || '' : '';
            if (text.length > 0) {
              const baseline = typeof helper.state.cursorBaseline === 'number'
                ? helper.state.cursorBaseline
                : remembered.selectionStart;
              const result = computeRestoreOffset(text, timeRange, restoreTime, blurTime, baseline);
              if (result) {
                selectionStart = result.offset;
                selectionEnd = result.offset;
                direction = 'none';
                usedProportional = true;

                if (helper.analytics) {
                  helper.analytics.record('cursor:proportional-offset', {
                    blurTime,
                    restoreTime,
                    playbackDelta: Math.round((restoreTime - blurTime) * 1000) / 1000,
                    timeRange,
                    textLength: text.length,
                    baseline,
                    rawOffset: result.offset,
                    clamped: result.clamped,
                    rememberedPos: remembered.selectionStart
                  });
                }
              }
            }
          }
        }
      }

      helper.state.blurPlaybackTime = null;
      helper.state.restorePlaybackTime = null;

      // Update baseline to the restored position so the next Esc cycle
      // uses it as the floor. The user can further advance it by editing.
      helper.state.cursorBaseline = selectionStart;

      const focused = helper.focusRow(rememberedRow, {
        activateRow: false,
        selectionStart: selectionStart,
        selectionEnd: selectionEnd,
        direction: direction
      });
      if (focused) {
        helper.state.blurRestorePending = false;

        if (helper.analytics) {
          const rowId = helper.getRowIdentity(rememberedRow)?.annotationId ?? null;
          const eventType = usedProportional ? 'focus:restore-proportional' : 'focus:restore';
          helper.analytics.record(eventType, {
            rowId,
            cursorPos: selectionStart,
            proportional: usedProportional,
            sameRow: true,
            cursorBaseline: helper.state.cursorBaseline
          });
          helper.analytics.endEscCycle({
            playbackTime: helper.state.restorePlaybackTime,
            cursorPos: selectionStart,
            proportional: usedProportional,
            rowId
          });
        }
      }
      return focused;
    }

    const fallbackRow =
      (currentRow && currentRow.isConnected && currentRow) ||
      (rememberedRow && rememberedRow.isConnected && rememberedRow) ||
      helper.getTranscriptRows()[0] ||
      null;
    if (!fallbackRow) {
      if (helper.analytics) {
        helper.analytics.record('focus:restore-failed', { reason: 'no-fallback-row' });
      }
      return false;
    }

    const focused = helper.focusRow(fallbackRow, {
      activateRow: false,
      cursor: 'start'
    });
    if (focused) {
      helper.state.blurRestorePending = false;
      if (helper.analytics) {
        const rowId = helper.getRowIdentity(fallbackRow)?.annotationId ?? null;
        helper.analytics.record('focus:restore-fallback', {
          rowId,
          reason: 'row-mismatch',
          rememberedRowConnected: rememberedRow?.isConnected ?? false,
          currentRowConnected: currentRow?.isConnected ?? false
        });
        helper.analytics.endEscCycle({
          cursorPos: 0,
          proportional: false,
          rowId
        });
      }
    }
    return focused;
  };

  function queueEscapePlaybackTask(task) {
    const scheduled = escapePlaybackQueue.catch(() => {}).then(task);
    escapePlaybackQueue = scheduled.catch(() => {});
    return scheduled;
  }

  function getWavePausedState(wave) {
    if (!wave || typeof wave !== 'object') {
      return null;
    }

    if (typeof wave.isPlaying === 'function') {
      try {
        return !Boolean(wave.isPlaying());
      } catch (_error) {
        return null;
      }
    }

    if (wave.media && 'paused' in wave.media) {
      return Boolean(wave.media.paused);
    }

    return null;
  }

  function getPlaybackStateLocally() {
    const waves = getPlaybackWaveInstances();
    if (waves.length) {
      const currentTime = Number(waves[0].getCurrentTime());
      const duration =
        typeof waves[0].getDuration === 'function' ? Number(waves[0].getDuration()) : NaN;
      const paused = getWavePausedState(waves[0]);
      return {
        ok: Number.isFinite(currentTime) || typeof paused === 'boolean',
        source: 'wavesurfer',
        currentTime: Number.isFinite(currentTime) ? currentTime : null,
        duration: Number.isFinite(duration) ? duration : null,
        paused: typeof paused === 'boolean' ? paused : null,
        waveCount: waves.length
      };
    }

    const audio = document.querySelector('audio');
    if (!(audio instanceof HTMLMediaElement)) {
      return {
        ok: false,
        reason: 'playback-unavailable',
        paused: null,
        waveCount: 0
      };
    }

    return {
      ok: true,
      source: 'audio',
      currentTime: Number.isFinite(Number(audio.currentTime)) ? Number(audio.currentTime) : null,
      duration: Number.isFinite(Number(audio.duration)) ? Number(audio.duration) : null,
      paused: Boolean(audio.paused),
      waveCount: 0
    };
  }

  function setWavePausedStateLocally(paused) {
    const waves = getPlaybackWaveInstances();
    if (!waves.length) {
      return null;
    }

    let applied = 0;
    for (const wave of waves) {
      try {
        if (paused) {
          if (typeof wave.pause === 'function') {
            wave.pause();
            applied += 1;
            continue;
          }
          if (wave.media && typeof wave.media.pause === 'function') {
            wave.media.pause();
            applied += 1;
            continue;
          }
        } else {
          if (typeof wave.play === 'function') {
            const result = wave.play();
            if (result && typeof result.catch === 'function') {
              result.catch(() => {});
            }
            applied += 1;
            continue;
          }
          if (wave.media && typeof wave.media.play === 'function') {
            const result = wave.media.play();
            if (result && typeof result.catch === 'function') {
              result.catch(() => {});
            }
            applied += 1;
            continue;
          }
        }
      } catch (_error) {
        // Ignore one-off instance failures; other synced waveforms may still update.
      }
    }

    if (!applied) {
      return null;
    }

    return getPlaybackStateLocally();
  }

  function setAudioPausedStateLocally(paused) {
    const audio = document.querySelector('audio');
    if (!(audio instanceof HTMLMediaElement)) {
      return null;
    }

    try {
      if (paused) {
        audio.pause();
      } else if (typeof audio.play === 'function') {
        const result = audio.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      }
    } catch (_error) {
      return null;
    }

    return getPlaybackStateLocally();
  }

  function setPlaybackPausedLocally(paused) {
    const desired = Boolean(paused);
    const previous = getPlaybackStateLocally();
    if (previous && previous.ok && previous.paused === desired) {
      return {
        ...previous,
        ok: true,
        previousPaused: previous.paused,
        changed: false,
        via: 'noop'
      };
    }

    const control = desired ? getPauseAllTracksButton() : getPlayAllTracksButton();
    if (control && clickControl(control)) {
      const afterControl = getPlaybackStateLocally();
      if (afterControl && afterControl.ok && afterControl.paused === desired) {
        return {
          ...afterControl,
          previousPaused: previous && typeof previous.paused === 'boolean' ? previous.paused : null,
          changed:
            previous && typeof previous.paused === 'boolean'
              ? previous.paused !== afterControl.paused
              : null,
          via: 'control'
        };
      }
    }

    const direct =
      setWavePausedStateLocally(desired) ||
      setAudioPausedStateLocally(desired) || {
        ok: false,
        reason: 'playback-unavailable',
        paused: null,
        waveCount: 0
      };

    return {
      ...direct,
      previousPaused: previous && typeof previous.paused === 'boolean' ? previous.paused : null,
      changed:
        previous &&
        typeof previous.paused === 'boolean' &&
        typeof direct.paused === 'boolean'
          ? previous.paused !== direct.paused
          : null
    };
  }

  helper.setPlaybackPaused = function setPlaybackPaused(paused) {
    const desired = Boolean(paused);
    return callPlaybackBridge('set-paused', { paused: desired }).then((result) => {
      if (result && result.ok && result.paused === desired) {
        return result;
      }

      return setPlaybackPausedLocally(desired);
    });
  };

  helper.getPlaybackState = function getPlaybackState() {
    return callPlaybackBridge('state').then((result) => {
      if (result && result.ok && typeof result.paused === 'boolean') {
        return result;
      }

      return getPlaybackStateLocally();
    });
  };

  function focusCurrentEditorForEscape() {
    if (helper.state.blurRestorePending && helper.toggleEditorFocus()) {
      return true;
    }

    // toggleEditorFocus may have failed because the remembered row reference
    // went stale (e.g. Babel re-rendered rows while audio was playing).
    // Try to find the correct row by playback time and focus it with a
    // proportional cursor offset.
    const restoreTime = helper.state.restorePlaybackTime;
    if (typeof restoreTime === 'number' && Number.isFinite(restoreTime)) {
      const timeRow = findRowByPlaybackTime(restoreTime);
      if (timeRow instanceof HTMLElement) {
        const timeRange = getRowTimeRange(timeRow);
        const textarea = helper.getRowTextarea(timeRow);
        if (timeRange && textarea instanceof HTMLTextAreaElement) {
          const text = textarea.value || '';
          if (text.length > 0 && helper.config.features.proportionalCursorRestore) {
            const blurTime = helper.state.blurPlaybackTime;
            const baseline = typeof helper.state.cursorBaseline === 'number'
              ? helper.state.cursorBaseline : 0;
            const result = computeRestoreOffset(text, timeRange, restoreTime, blurTime, baseline);

            helper.state.blurPlaybackTime = null;
            helper.state.restorePlaybackTime = null;
            helper.state.blurRestorePending = false;

            if (result) {
              helper.state.cursorBaseline = result.offset;

              if (helper.analytics) {
                const rowId = helper.getRowIdentity(timeRow)?.annotationId ?? null;
                helper.analytics.record('focus:restore-fallback', {
                  reason: 'time-lookup-proportional',
                  rowId,
                  cursorPos: result.offset,
                  playbackTime: restoreTime,
                  clamped: result.clamped
                });
                helper.analytics.endEscCycle({
                  playbackTime: restoreTime,
                  cursorPos: result.offset,
                  proportional: true,
                  rowId
                });
              }

              return helper.focusRow(timeRow, {
                activateRow: false,
                selectionStart: result.offset,
                selectionEnd: result.offset,
                direction: 'none'
              });
            }
          }
        }

        // Fall back to start of the time-matched row
        helper.state.blurPlaybackTime = null;
        helper.state.restorePlaybackTime = null;
        helper.state.blurRestorePending = false;

        if (helper.analytics) {
          const rowId = helper.getRowIdentity(timeRow)?.annotationId ?? null;
          helper.analytics.record('focus:restore-fallback', {
            reason: 'time-lookup-start',
            rowId,
            playbackTime: restoreTime
          });
          helper.analytics.endEscCycle({
            playbackTime: restoreTime,
            cursorPos: 0,
            proportional: false,
            rowId
          });
        }

        return helper.focusRow(timeRow, {
          activateRow: false,
          cursor: 'start'
        });
      }
    }

    const currentRow = helper.getCurrentRow();
    if (!(currentRow instanceof HTMLElement)) {
      if (helper.analytics) {
        helper.analytics.record('focus:restore-failed', { reason: 'no-current-row-for-escape' });
      }
      return false;
    }

    if (helper.analytics) {
      const rowId = helper.getRowIdentity(currentRow)?.annotationId ?? null;
      helper.analytics.record('focus:restore-fallback', {
        reason: 'current-row-fallback',
        rowId
      });
      helper.analytics.endEscCycle({
        cursorPos: 0,
        proportional: false,
        rowId
      });
    }

    return helper.focusRow(currentRow, {
      activateRow: false,
      cursor: 'start'
    });
  }

  helper.handleEscapeWorkflow = function handleEscapeWorkflow() {
    const focused = helper.getActiveRowTextarea() instanceof HTMLTextAreaElement;

    if (helper.analytics) {
      helper.analytics.record('hotkey:escape', {
        focused,
        blurRestorePending: helper.state.blurRestorePending,
        hasLastBlur: Boolean(helper.state.lastBlur),
        cursorBaseline: helper.state.cursorBaseline
      });
    }

    void queueEscapePlaybackTask(async () => {
      const playback = await helper.getPlaybackState();
      const isPlaying = Boolean(playback && playback.ok && playback.paused === false);
      const currentTime = playback && typeof playback.currentTime === 'number' ? playback.currentTime : null;

      if (helper.analytics) {
        helper.analytics.record('esc:playback-query', {
          ok: playback?.ok,
          paused: playback?.paused,
          currentTime,
          source: playback?.source
        });
      }

      if (focused && isPlaying) {
        // State 1: focused + playing -> pause only
        if (helper.analytics) {
          helper.analytics.record('esc:state1:focused-playing', {
            playbackTime: currentTime
          });
        }
        await helper.setPlaybackPaused(true);
        if (helper.analytics) {
          helper.analytics.record('playback:pause', { via: 'esc-state1', playbackTime: currentTime });
        }
        return;
      }

      if (!focused && isPlaying) {
        // State 2: unfocused + playing -> restore focus + pause
        stopGhostCursor();
        helper.state.restorePlaybackTime =
          playback && typeof playback.currentTime === 'number' ? playback.currentTime : null;

        if (helper.analytics) {
          const rowId = helper.state.lastBlur?.row
            ? (helper.getRowIdentity(helper.state.lastBlur.row)?.annotationId ?? null)
            : null;
          helper.analytics.record('esc:state2:unfocused-playing', {
            playbackTime: currentTime,
            blurPlaybackTime: helper.state.blurPlaybackTime,
            playbackDelta: currentTime != null && helper.state.blurPlaybackTime != null
              ? Math.round((currentTime - helper.state.blurPlaybackTime) * 1000) / 1000
              : null,
            rowId,
            blurRestorePending: helper.state.blurRestorePending
          });
        }

        focusCurrentEditorForEscape();
        await helper.setPlaybackPaused(true);
        if (helper.analytics) {
          helper.analytics.record('playback:pause', { via: 'esc-state2', playbackTime: currentTime });
        }
        return;
      }

      if (focused && !isPlaying) {
        // State 3: focused + not playing -> blur + play
        const activeTextarea = helper.getActiveRowTextarea();
        const cursorPos = activeTextarea ? activeTextarea.selectionStart : null;
        const textLen = activeTextarea ? (activeTextarea.value || '').length : null;
        const row = activeTextarea ? activeTextarea.closest('tr') : null;
        const rowId = row ? (helper.getRowIdentity(row)?.annotationId ?? null) : null;

        helper.toggleEditorFocus();
        helper.state.blurPlaybackTime =
          playback && typeof playback.currentTime === 'number' ? playback.currentTime : null;

        if (helper.analytics) {
          helper.analytics.record('esc:state3:focused-notplaying', {
            playbackTime: currentTime,
            cursorPos,
            textLength: textLen,
            rowId,
            cursorBaseline: helper.state.cursorBaseline
          });
          helper.analytics.startEscCycle(3, {
            playbackTime: currentTime,
            rowId,
            cursorPos,
            textLength: textLen
          });
        }

        await helper.setPlaybackPaused(false);
        if (helper.analytics) {
          helper.analytics.record('playback:resume', { via: 'esc-state3', playbackTime: currentTime });
        }

        // Start the ghost cursor on the just-blurred row so the user sees
        // a live preview of where the cursor would land.
        const blurredRow = helper.state.lastBlur && helper.state.lastBlur.row;
        if (blurredRow) {
          startGhostCursor(blurredRow);
        }
        return;
      }

      // State 4: !focused && !isPlaying — bootstrap a synthetic blur so the
      // next Esc press (State 2) can restore focus with proportional cursor.

      // Find the row matching current playback position, falling back to
      // Babel-active row or the DOM/React-state active row.
      const bootstrapRow =
        (typeof currentTime === 'number' && findRowByPlaybackTime(currentTime)) ||
        helper.findActiveRowByDomState() ||
        helper.findActiveRowByReactState() ||
        helper.getCurrentRow();

      const bootstrapRowId = bootstrapRow ? (helper.getRowIdentity(bootstrapRow)?.annotationId ?? null) : null;

      if (helper.analytics) {
        helper.analytics.record('esc:state4:unfocused-notplaying', {
          playbackTime: currentTime,
          bootstrapRowId,
          hasBootstrapRow: Boolean(bootstrapRow)
        });
        helper.analytics.startEscCycle(4, {
          playbackTime: currentTime,
          rowId: bootstrapRowId,
          cursorPos: 0,
          textLength: bootstrapRow ? (helper.getRowTextValue(bootstrapRow) || '').length : null
        });
      }

      if (bootstrapRow) {
        helper.state.lastBlur = {
          row: bootstrapRow,
          selectionStart: 0,
          selectionEnd: 0,
          direction: 'none',
          synthetic: true
        };
        helper.state.blurRestorePending = true;
        helper.state.cursorBaseline = 0;
        helper.state.blurPlaybackTime =
          typeof currentTime === 'number' ? currentTime : null;
        helper.setCurrentRow(bootstrapRow);
      }

      await helper.setPlaybackPaused(false);
      if (helper.analytics) {
        helper.analytics.record('playback:resume', { via: 'esc-state4', playbackTime: currentTime });
      }

      // Start the ghost cursor so the user sees a live preview of where
      // the cursor would land if they press Esc.
      if (bootstrapRow && helper.config.features.proportionalCursorRestore) {
        startGhostCursor(bootstrapRow);
      }
    });
    return true;
  };

  function seekPlaybackBySecondsLocally(deltaSeconds) {
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta) || delta === 0) {
      return false;
    }

    const waves = getPlaybackWaveInstances();
    if (waves.length) {
      const currentTime = Number(waves[0].getCurrentTime());
      if (!Number.isFinite(currentTime)) {
        return false;
      }

      const duration =
        typeof waves[0].getDuration === 'function' ? Number(waves[0].getDuration()) : NaN;
      const maxTime = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
      const nextTime = Math.max(0, Math.min(maxTime, currentTime + delta));
      if (!Number.isFinite(nextTime)) {
        return false;
      }

      for (const wave of waves) {
        try {
          wave.setTime(nextTime);
        } catch (_error) {
          // Ignore one-off instance failures; other synced waveforms may still update.
        }
      }

      return true;
    }

    const audio = document.querySelector('audio');
    if (!(audio instanceof HTMLMediaElement)) {
      return false;
    }

    const currentTime = Number(audio.currentTime);
    if (!Number.isFinite(currentTime)) {
      return false;
    }

    const duration = Number(audio.duration);
    const maxTime = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
    const nextTime = Math.max(0, Math.min(maxTime, currentTime + delta));
    if (!Number.isFinite(nextTime)) {
      return false;
    }

    audio.currentTime = nextTime;
    return true;
  }

  helper.seekPlaybackBySeconds = function seekPlaybackBySeconds(deltaSeconds) {
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta) || delta === 0) {
      return false;
    }

    if (helper.analytics) {
      helper.analytics.record('playback:seek', { deltaSeconds: delta });
    }

    return callPlaybackBridge('seek', { deltaSeconds: delta }).then((result) => {
      if (result && result.ok) {
        return true;
      }

      return seekPlaybackBySecondsLocally(delta);
    });
  };

}


