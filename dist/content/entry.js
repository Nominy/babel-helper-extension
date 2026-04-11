var __dirname = typeof __dirname === "string" ? __dirname : "/virtual";
"use strict";
(() => {
  // src/core/settings.ts
  var SETTINGS_STORAGE_KEY = "settings";
  var DEFAULT_FEATURE_SETTINGS = {
    hotkeysHelp: true,
    rowActions: true,
    speakerWorkflowHotkeys: true,
    selectedNumberToSkaz: true,
    textMove: true,
    quickRegionAutocomplete: true,
    disableNativeArrowSeek: true,
    focusToggle: true,
    timelineSelection: true,
    timelineZoomDefaults: true,
    magnifier: true,
    minimap: true,
    customLinter: true,
    proportionalCursorRestore: true,
    wavesurferTooltipEllipsis: true
  };
  var DEFAULT_EXTENSION_SETTINGS = {
    features: DEFAULT_FEATURE_SETTINGS
  };
  var FEATURE_KEYS = [
    "hotkeysHelp",
    "rowActions",
    "speakerWorkflowHotkeys",
    "selectedNumberToSkaz",
    "textMove",
    "quickRegionAutocomplete",
    "disableNativeArrowSeek",
    "focusToggle",
    "timelineSelection",
    "timelineZoomDefaults",
    "magnifier",
    "minimap",
    "customLinter",
    "proportionalCursorRestore",
    "wavesurferTooltipEllipsis"
  ];
  function getExtensionStorage() {
    const chromeApi = globalThis.chrome;
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
      return null;
    }
    return chromeApi.storage.local;
  }
  function normalizeExtensionSettings(source) {
    const incoming = source && typeof source === "object" && source !== null ? source : {};
    const rawFeatures = incoming.features && typeof incoming.features === "object" ? incoming.features : {};
    const features = {};
    for (const key of FEATURE_KEYS) {
      const value = rawFeatures[key];
      features[key] = typeof value === "boolean" ? value : DEFAULT_FEATURE_SETTINGS[key];
    }
    return {
      features
    };
  }
  async function loadExtensionSettings() {
    const storage = getExtensionStorage();
    if (!storage || typeof storage.get !== "function") {
      return normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS);
    }
    return new Promise((resolve) => {
      storage.get(SETTINGS_STORAGE_KEY, (items) => {
        const runtime = globalThis.chrome;
        if (runtime?.runtime?.lastError) {
          resolve(normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS));
          return;
        }
        resolve(normalizeExtensionSettings(items?.[SETTINGS_STORAGE_KEY]));
      });
    });
  }

  // src/core/config.ts
  var PLAYBACK_REWIND_SHORTCUTS = [
    { code: "KeyX", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, seconds: 1, label: "Alt + X" }
  ];
  function buildHotkeysHelpRows(featureSettings) {
    const rows = [];
    if (featureSettings.focusToggle) {
      rows.push(["Esc", "Pause and blur / resume and restore cursor" + (featureSettings.proportionalCursorRestore ? " (proportional to playback position)" : "")]);
    }
    if (featureSettings.textMove) {
      rows.push(["Alt + [ (\u0420\u0490)", "Move text before caret to previous segment"]);
      rows.push(["Alt + ] (\u0420\u0404)", "Move text after caret to next segment"]);
    }
    if (featureSettings.rowActions && featureSettings.speakerWorkflowHotkeys) {
      rows.push(["Alt + 1 / Alt + 2", "Switch active speaker workflow lane"]);
      rows.push(["Alt + ~", "Reset lanes: show both, unmute both, select All Tracks"]);
    }
    if (featureSettings.selectedNumberToSkaz) {
      rows.push(["Digit", "Replace selection with `digit {\u0421\u041A\u0410\u0417: original}`"]);
      rows.push(["Alt + A", "Auto-convert selected digits into `digits {\u0421\u041A\u0410\u0417: words}`"]);
    }
    if (featureSettings.rowActions) {
      for (const shortcut of PLAYBACK_REWIND_SHORTCUTS) {
        const milliseconds = Math.round(shortcut.seconds * 1e3);
        rows.push([shortcut.label, "Rewind playback " + milliseconds + "ms"]);
      }
      rows.push(["Right Shift + Left / Right", "Focus previous / next segment from start"]);
      rows.push(["Alt + Shift + Up", "Merge with previous segment"]);
      rows.push(["Alt + Shift + Down", "Merge with next segment"]);
      rows.push(["D", "Delete current segment when not typing"]);
    }
    if (featureSettings.customLinter) {
      rows.push(["Alt + F", "Auto-fix lint issues in current row"]);
      rows.push(["Alt + Shift + F", "Auto-fix lint issues in all rows"]);
    }
    return rows;
  }
  function createConfig(featureSettings = DEFAULT_FEATURE_SETTINGS) {
    return {
      features: {
        ...featureSettings
      },
      rowTextareaSelector: 'textarea[placeholder^="What was said"]',
      actionTriggerSelector: 'button[aria-haspopup="menu"]',
      hotkeysHelpMarker: "data-babel-helper-hotkeys",
      hotkeysDialogPatterns: [
        /\bkeyboard shortcuts\b/i,
        /\buse these shortcuts to navigate and control the transcription workbench\b/i,
        /\bhotkeys\b/i
      ],
      hotkeysHelpRows: buildHotkeysHelpRows(featureSettings),
      playbackRewindShortcuts: PLAYBACK_REWIND_SHORTCUTS.map((shortcut) => ({
        ...shortcut
      })),
      actionPatterns: {
        deleteSegment: [/\bdelete(?:\s+segment)?\b/i, /\bremove(?:\s+segment)?\b/i],
        mergePrevious: [
          /\bmerge\b.*\b(previous|prev|above|before|up)\b/i,
          /\b(previous|prev|above|before|up)\b.*\b(merge|combine|join)\b/i,
          /\b(combine|join)\b.*\b(previous|prev|above|before|up)\b/i
        ],
        mergeNext: [
          /\bmerge\b.*\b(next|below|after|following|down)\b/i,
          /\b(next|below|after|following|down)\b.*\b(merge|combine|join)\b/i,
          /\b(combine|join)\b.*\b(next|below|after|following|down)\b/i
        ],
        mergeFallback: [/\bmerge\b/i, /\bcombine\b/i, /\bjoin\b/i]
      }
    };
  }

  // src/core/state-store.ts
  function createState() {
    return {
      currentRow: null,
      currentRowIdentity: null,
      lastBlur: null,
      blurPlaybackTime: null,
      restorePlaybackTime: null,
      blurRestorePending: false,
      runtimeBound: false,
      routeWatchBound: false,
      routeRefreshTimer: 0,
      routeRefreshAttempts: 0,
      routeRefreshWindowStartedAt: 0,
      hotkeysEnhanceFrame: 0,
      hotkeysObserver: null,
      routeRecoveryObserver: null,
      keydownBound: false,
      nativeArrowSuppressBound: false,
      rightShiftPressed: false,
      sessionActive: false,
      rowTrackingBound: false,
      cutListenersBound: false,
      magnifierListenersBound: false,
      cutDraft: null,
      cutPreview: null,
      cutCommitPending: false,
      cutLastContainer: null,
      smartSplitClickDraft: null,
      smartSplitClickContext: null,
      selectionLoop: null,
      magnifier: null,
      magnifierDrag: null,
      speakerSwitchPending: false,
      cursorBaseline: null,
      ghostCursorElement: null,
      ghostCursorIntervalId: null,
      ghostCursorRow: null,
      ghostCursorRowIdentity: null,
      ghostCursorOffset: null,
      playbackRowSyncTimer: null,
      playbackRowSyncInFlight: false,
      lastPlaybackRow: null,
      lastPlaybackRowIdentity: null,
      onLoadedCalled: false
    };
  }

  // src/core/logger.ts
  function createLogger(scope) {
    const prefix = `[babel-helper:${scope}]`;
    return {
      debug: (...args) => console.debug(prefix, ...args),
      info: (...args) => console.info(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args)
    };
  }

  // src/hooks/dom.ts
  function isEditable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (element.isContentEditable) {
      return true;
    }
    return element.matches("textarea, input");
  }
  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function normalizeText(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }
    return element.innerText.replace(/\s+/g, " ").trim();
  }
  function setEditableValue(element, value) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const nextValue = typeof value === "string" ? value : String(value ?? "");
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : null;
    if (typeof setter === "function") {
      setter.call(element, nextValue);
    } else if ("value" in element) {
      element.value = nextValue;
    } else {
      return false;
    }
    element.dispatchEvent(
      typeof InputEvent === "function" ? new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        data: null,
        inputType: "insertText"
      }) : new Event("input", {
        bubbles: true,
        cancelable: false
      })
    );
    return true;
  }
  function dispatchClick(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "mouse"
        })
      );
    }
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
    element.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
    element.click();
  }
  function sleep(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }
  async function waitFor(getValue, timeoutMs, intervalMs) {
    const timeout = timeoutMs || 800;
    const interval = intervalMs || 50;
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeout) {
      const value = getValue();
      if (value) {
        return value;
      }
      await sleep(interval);
    }
    return null;
  }

  // src/services/row-service.ts
  function registerRowService(helper) {
    if (!helper || helper.__rowsRegistered) {
      return;
    }
    helper.__rowsRegistered = true;
    helper.state.speakerSwitchPending = false;
    const PLAYBACK_BRIDGE_REQUEST_EVENT = "babel-helper-playback-request";
    const PLAYBACK_BRIDGE_RESPONSE_EVENT = "babel-helper-playback-response";
    const PLAYBACK_BRIDGE_SCRIPT_PATH = "dist/content/playback-bridge.js";
    const PLAYBACK_BRIDGE_TIMEOUT_MS = 500;
    let playbackBridgeInjected = false;
    let playbackBridgeLoadPromise = null;
    let playbackBridgeRequestId = 0;
    let escapePlaybackQueue = Promise.resolve();
    const PROPORTIONAL_MIN_DELTA_SECONDS = 0.3;
    const REACTION_TIME_OFFSET_SECONDS = 0.6;
    function parseSegmentTimeValue(value) {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const match = trimmed.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
      if (!match) {
        return null;
      }
      const parts = match[0].split(":");
      let total = 0;
      for (const part of parts) {
        const numeric = Number(part);
        if (!Number.isFinite(numeric)) {
          return null;
        }
        total = total * 60 + numeric;
      }
      return total;
    }
    function getRowTimeRange(row) {
      if (!(row instanceof HTMLElement)) {
        return null;
      }
      const startCell = row.children[2];
      const endCell = row.children[3];
      const startSeconds = startCell instanceof HTMLElement ? parseSegmentTimeValue(helper.normalizeText(startCell)) : null;
      const endSeconds = endCell instanceof HTMLElement ? parseSegmentTimeValue(helper.normalizeText(endCell)) : null;
      if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
        return null;
      }
      return { startSeconds, endSeconds };
    }
    function findRowByPlaybackTime(playbackTime) {
      if (typeof playbackTime !== "number" || !Number.isFinite(playbackTime)) {
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
    function resolveConnectedRow(row, identity) {
      if (row instanceof HTMLElement && row.isConnected) {
        if (!identity || helper.rowMatchesIdentity(row, identity)) {
          return row;
        }
      }
      if (identity) {
        return helper.findRowByIdentity(identity);
      }
      return null;
    }
    function getLastPlaybackRow() {
      return resolveConnectedRow(
        helper.state.lastPlaybackRow,
        helper.state.lastPlaybackRowIdentity
      );
    }
    function rememberPlaybackRow(row) {
      if (row instanceof HTMLElement && row.isConnected) {
        helper.state.lastPlaybackRow = row;
        helper.state.lastPlaybackRowIdentity = helper.getRowIdentity(row);
        return row;
      }
      helper.state.lastPlaybackRow = null;
      helper.state.lastPlaybackRowIdentity = null;
      return null;
    }
    function snapToWordBoundary(text, offset) {
      if (!text || offset <= 0) {
        return 0;
      }
      if (offset >= text.length) {
        return text.length;
      }
      if (offset === 0 || /\s/.test(text[offset - 1])) {
        return offset;
      }
      let backward = offset;
      while (backward > 0 && !/\s/.test(text[backward - 1])) {
        backward--;
      }
      let forward = offset;
      while (forward < text.length && !/\s/.test(text[forward])) {
        forward++;
      }
      if (forward < text.length) {
        forward++;
      }
      return offset - backward <= forward - offset ? backward : forward;
    }
    const GHOST_CURSOR_INTERVAL_MS = 66;
    const GHOST_CURSOR_ATTR = "data-babel-helper-ghost-cursor";
    const MIRROR_STYLE_PROPS = [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "letterSpacing",
      "textTransform",
      "wordSpacing",
      "textIndent",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "lineHeight",
      "whiteSpace",
      "wordWrap",
      "overflowWrap",
      "direction",
      "boxSizing",
      "tabSize",
      "textAlign"
    ];
    function getCaretPixelPosition(textarea, charIndex) {
      const mirror = document.createElement("div");
      try {
        const computed = window.getComputedStyle(textarea);
        const textareaRect = textarea.getBoundingClientRect();
        mirror.style.position = "fixed";
        mirror.style.top = `${textareaRect.top}px`;
        mirror.style.left = `${textareaRect.left}px`;
        mirror.style.visibility = "hidden";
        mirror.style.overflow = "hidden";
        mirror.style.pointerEvents = "none";
        for (const prop of MIRROR_STYLE_PROPS) {
          mirror.style[prop] = computed[prop];
        }
        mirror.style.whiteSpace = "pre-wrap";
        mirror.style.wordWrap = "break-word";
        mirror.style.overflowWrap = "break-word";
        mirror.style.width = `${textarea.offsetWidth}px`;
        mirror.style.height = `${textarea.offsetHeight}px`;
        mirror.style.boxSizing = "border-box";
        const beforeCaret = textarea.value.substring(0, charIndex);
        const afterCaret = textarea.value.substring(charIndex);
        mirror.appendChild(document.createTextNode(beforeCaret));
        const marker = document.createElement("span");
        marker.textContent = "\u200B";
        mirror.appendChild(marker);
        if (afterCaret) {
          mirror.appendChild(document.createTextNode(afterCaret));
        }
        document.body.appendChild(mirror);
        const markerRect = marker.getBoundingClientRect();
        const lineHeight = parseFloat(computed.lineHeight) || markerRect.height || 16;
        const top = markerRect.top - textarea.scrollTop;
        const left = markerRect.left - textarea.scrollLeft;
        return { top, left, height: lineHeight };
      } finally {
        if (mirror.parentNode) {
          mirror.parentNode.removeChild(mirror);
        }
      }
    }
    function computeRestoreOffset(text, timeRange, currentTime, blurTime, baseline) {
      if (!text || text.length === 0 || !timeRange) {
        return null;
      }
      const duration = timeRange.endSeconds - timeRange.startSeconds;
      if (duration <= 0) {
        return null;
      }
      const adjustedTime = Math.max(
        typeof blurTime === "number" && Number.isFinite(blurTime) ? blurTime : timeRange.startSeconds,
        currentTime - REACTION_TIME_OFFSET_SECONDS
      );
      const ratio = Math.max(0, Math.min(
        1,
        (adjustedTime - timeRange.startSeconds) / duration
      ));
      const rawOffset = Math.round(ratio * text.length);
      const snapped = snapToWordBoundary(text, rawOffset);
      const floor = typeof baseline === "number" && baseline >= 0 ? baseline : 0;
      const final = Math.max(floor, snapped);
      return { offset: final, clamped: final !== snapped };
    }
    function createGhostCursorElement() {
      const el = document.createElement("div");
      el.setAttribute(GHOST_CURSOR_ATTR, "");
      el.style.position = "fixed";
      el.style.width = "2px";
      el.style.background = "rgba(245, 158, 11, 0.75)";
      el.style.borderRadius = "1px";
      el.style.pointerEvents = "none";
      el.style.zIndex = "20";
      el.style.transition = "left 80ms linear, top 80ms linear";
      el.style.willChange = "left, top";
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
        } catch (_e) {
        }
        helper.state.ghostCursorElement = null;
      }
      const stoppedRowId = helper.state.ghostCursorRow ? helper.getRowIdentity(helper.state.ghostCursorRow)?.annotationId ?? null : null;
      helper.state.ghostCursorRow = null;
      helper.state.ghostCursorRowIdentity = null;
      helper.state.ghostCursorOffset = null;
      if (wasActive && helper.analytics) {
        helper.analytics.record("ghost:stop", { rowId: stoppedRowId });
      }
    }
    function startGhostCursor(row) {
      stopGhostCursor();
      if (!helper.config.features.proportionalCursorRestore) {
        return;
      }
      if (!(row instanceof HTMLElement) || !row.isConnected) {
        return;
      }
      const textarea = helper.getRowTextarea(row);
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return;
      }
      const timeRange = getRowTimeRange(row);
      if (!timeRange) {
        return;
      }
      const blurTime = helper.state.blurPlaybackTime;
      const el = createGhostCursorElement();
      document.body.appendChild(el);
      helper.state.ghostCursorElement = el;
      helper.state.ghostCursorRow = row;
      helper.state.ghostCursorRowIdentity = helper.getRowIdentity(row);
      helper.state.ghostCursorOffset = null;
      let trackedRow = row;
      let trackedTimeRange = timeRange;
      el.style.display = "none";
      let tickInFlight = false;
      async function tick() {
        if (tickInFlight) {
          return;
        }
        tickInFlight = true;
        try {
          if (!helper.state.ghostCursorElement || helper.state.ghostCursorElement !== el) {
            return;
          }
          const playback = typeof helper.getPlaybackState === "function" ? await helper.getPlaybackState() : getPlaybackStateLocally();
          if (!playback || !playback.ok || typeof playback.currentTime !== "number") {
            el.style.display = "none";
            return;
          }
          if (playback.paused === true) {
            stopGhostCursor();
            return;
          }
          const currentTime = playback.currentTime;
          if (currentTime < trackedTimeRange.startSeconds || currentTime >= trackedTimeRange.endSeconds) {
            const newRow = findRowByPlaybackTime(currentTime);
            if (newRow && newRow !== trackedRow) {
              const newRange = getRowTimeRange(newRow);
              if (newRange) {
                const prevRowId = helper.getRowIdentity(trackedRow)?.annotationId ?? null;
                trackedRow = newRow;
                trackedTimeRange = newRange;
                helper.state.ghostCursorRow = newRow;
                helper.state.ghostCursorRowIdentity = helper.getRowIdentity(newRow);
                helper.state.cursorBaseline = 0;
                if (helper.analytics) {
                  const newRowId = helper.getRowIdentity(newRow)?.annotationId ?? null;
                  helper.analytics.record("ghost:row-switch", {
                    fromRowId: prevRowId,
                    toRowId: newRowId,
                    playbackTime: currentTime
                  });
                }
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
          const ta = helper.getRowTextarea(trackedRow);
          if (!(ta instanceof HTMLTextAreaElement)) {
            stopGhostCursor();
            return;
          }
          const text = ta.value || "";
          const baseline = typeof helper.state.cursorBaseline === "number" ? helper.state.cursorBaseline : 0;
          const result = computeRestoreOffset(text, trackedTimeRange, currentTime, blurTime, baseline);
          if (result === null) {
            el.style.display = "none";
            return;
          }
          el.style.background = result.clamped ? "rgba(156, 163, 175, 0.6)" : "rgba(245, 158, 11, 0.75)";
          helper.state.ghostCursorOffset = result.offset;
          const pos = getCaretPixelPosition(ta, result.offset);
          el.style.display = "";
          el.style.top = `${pos.top}px`;
          el.style.left = `${pos.left}px`;
          el.style.height = `${pos.height}px`;
        } catch (_e) {
          el.style.display = "none";
        } finally {
          tickInFlight = false;
        }
      }
      void tick();
      helper.state.ghostCursorIntervalId = setInterval(() => {
        void tick();
      }, GHOST_CURSOR_INTERVAL_MS);
      if (helper.analytics) {
        const rowId = helper.getRowIdentity(row)?.annotationId ?? null;
        helper.analytics.record("ghost:start", {
          rowId,
          timeRange,
          blurTime: helper.state.blurPlaybackTime
        });
      }
    }
    function getGhostCursorTarget() {
      const row = resolveConnectedRow(
        helper.state.ghostCursorRow,
        helper.state.ghostCursorRowIdentity
      );
      const offset = helper.state.ghostCursorOffset;
      if (!(row instanceof HTMLElement) || typeof offset !== "number" || offset < 0) {
        return null;
      }
      return {
        row,
        offset
      };
    }
    helper.getTranscriptRows = function getTranscriptRows() {
      return Array.from(document.querySelectorAll("tbody tr")).filter(
        (row) => row.querySelector(helper.config.rowTextareaSelector)
      );
    };
    helper.getRowTextarea = function getRowTextarea(row) {
      return row ? row.querySelector(helper.config.rowTextareaSelector) : null;
    };
    helper.getRowTextValue = function getRowTextValue(row) {
      const textarea = helper.getRowTextarea(row);
      return textarea instanceof HTMLTextAreaElement ? textarea.value || "" : "";
    };
    helper.getActiveRowTextarea = function getActiveRowTextarea() {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement && active.matches(helper.config.rowTextareaSelector) ? active : null;
    };
    function getReactInternalValue(element, prefix) {
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      for (const name of Object.getOwnPropertyNames(element)) {
        if (typeof name === "string" && name.indexOf(prefix) === 0) {
          return element[name];
        }
      }
      return null;
    }
    function getReactFiber(element) {
      return getReactInternalValue(element, "__reactFiber$");
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
        if (!parent || typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") {
          playbackBridgeLoadPromise = null;
          resolve(false);
          return;
        }
        const script = document.createElement("script");
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
        const id = "playback-request-" + playbackBridgeRequestId;
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
      const registry = value && typeof value === "object" && !Array.isArray(value) && value.current ? value.current : value;
      if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
        return null;
      }
      const keys = Object.keys(registry);
      const hasWaveEntry = keys.some((key) => {
        const entry = registry[key];
        return entry && typeof entry === "object" && entry.wavesurfer;
      });
      return hasWaveEntry ? registry : null;
    }
    function getWaveRegistryFromFiber(fiber) {
      let owner = fiber;
      let ownerDepth = 0;
      while (owner && typeof owner === "object" && ownerDepth < 16) {
        let hook = owner.memoizedState;
        let hookIndex = 0;
        while (hook && typeof hook === "object" && hookIndex < 24) {
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
      return Array.from(document.querySelectorAll("div")).filter((node) => {
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
      const seen = /* @__PURE__ */ new Set();
      const registries = [];
      const playbackRegistry = getWaveRegistryFromPlaybackControls();
      if (playbackRegistry) {
        registries.push(playbackRegistry);
      }
      for (const host of getWaveformHosts()) {
        const registry = getWaveformRegistryFromHost(host);
        if (!registry || typeof registry !== "object") {
          continue;
        }
        registries.push(registry);
      }
      for (const registry of registries) {
        for (const key of Object.keys(registry)) {
          const entry = registry[key];
          const wave = entry && typeof entry === "object" && entry.wavesurfer ? entry.wavesurfer : null;
          if (!wave || typeof wave !== "object" || seen.has(wave) || typeof wave.getCurrentTime !== "function" || typeof wave.setTime !== "function") {
            continue;
          }
          seen.add(wave);
          unique.push(wave);
        }
      }
      return unique;
    }
    function normalizeSpeakerLabel(value) {
      const text = typeof value === "string" ? value : String(value ?? "");
      const match = text.match(/\bspeaker\s*([12])\b/i);
      if (!match) {
        return "";
      }
      return "Speaker " + match[1];
    }
    function normalizeTrackFilterLabel(value) {
      const text = typeof value === "string" ? value : String(value ?? "");
      if (/\ball\s*tracks\b/i.test(text)) {
        return "All Tracks";
      }
      return normalizeSpeakerLabel(text);
    }
    function getSpeakerLane(label) {
      const normalizedTarget = normalizeSpeakerLabel(label);
      if (!normalizedTarget) {
        return null;
      }
      const targetLower = normalizedTarget.toLowerCase();
      const headings = Array.from(document.querySelectorAll("h3"));
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
      const button = lane && lane.visibilityButton instanceof HTMLElement && lane.visibilityButton.isConnected ? lane.visibilityButton : null;
      if (!(button instanceof HTMLElement)) {
        return "";
      }
      const ariaLabel = helper.normalizeText(button).toLowerCase() || "";
      const semantic = (button.getAttribute("aria-label") || "").toLowerCase();
      if (semantic === "show track" || ariaLabel === "show track") {
        return "hidden";
      }
      if (semantic === "hide track" || ariaLabel === "hide track") {
        return "visible";
      }
      return "";
    }
    function getLaneMuteState(lane) {
      const button = lane && lane.soloButton instanceof HTMLElement && lane.soloButton.isConnected ? lane.soloButton : null;
      if (!(button instanceof HTMLElement)) {
        return "";
      }
      const label = (button.getAttribute("aria-label") || "").trim().toLowerCase();
      if (label === "solo track") {
        return "muted";
      }
      if (label === "unsolo track") {
        return "unmuted";
      }
      return "";
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
      const targetState = shouldBeVisible ? "visible" : "hidden";
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
      const desired = shouldBeMuted ? "muted" : "unmuted";
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
      const seen = /* @__PURE__ */ new Set();
      for (const label of ["Speaker 1", "Speaker 2"]) {
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
        const label = (button.getAttribute("aria-label") || "").trim().toLowerCase();
        if (label === "unsolo track") {
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
          (button) => (button.getAttribute("aria-label") || "").trim().toLowerCase() === "unsolo track"
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
        const combo = Array.from(current.querySelectorAll('button[role="combobox"]')).find(
          (node) => isSpeakerSelectorCombobox(node)
        );
        if (combo instanceof HTMLElement) {
          return combo;
        }
        current = current.parentElement;
      }
      const fallback = Array.from(document.querySelectorAll('button[role="combobox"]')).find(
        (node) => isSpeakerSelectorCombobox(node)
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
        return normalizeTrackFilterLabel(helper.normalizeText(nextCombo)) === normalizedTarget ? nextCombo : null;
      }, 1e3, 40);
      return Boolean(applied);
    }
    helper.switchSpeakerWorkflow = async function switchSpeakerWorkflow(targetSpeakerLabel) {
      if (typeof helper.isFeatureEnabled === "function" && !helper.isFeatureEnabled("speakerWorkflowHotkeys")) {
        return false;
      }
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function" && !helper.runtime.isSessionInteractive()) {
        return false;
      }
      const targetLabel = normalizeSpeakerLabel(targetSpeakerLabel);
      if (!targetLabel) {
        return false;
      }
      if (helper.state.speakerSwitchPending) {
        return false;
      }
      const otherLabel = targetLabel === "Speaker 1" ? "Speaker 2" : "Speaker 1";
      helper.state.speakerSwitchPending = true;
      try {
        const targetVisible = await ensureLaneVisibility(targetLabel, true);
        const otherVisibleForMute = await ensureLaneVisibility(otherLabel, true);
        const targetMuted = await ensureLaneMuteState(targetLabel, true);
        const otherUnmuted = await ensureLaneMuteState(otherLabel, false);
        const otherHidden = await ensureLaneVisibility(otherLabel, false);
        const selectorUpdated = await selectSpeakerInToolbar(targetLabel);
        return Boolean(
          targetVisible && otherVisibleForMute && targetMuted && otherUnmuted && otherHidden && selectorUpdated
        );
      } finally {
        helper.state.speakerSwitchPending = false;
      }
    };
    helper.resetSpeakerWorkflow = async function resetSpeakerWorkflow() {
      if (typeof helper.isFeatureEnabled === "function" && !helper.isFeatureEnabled("speakerWorkflowHotkeys")) {
        return false;
      }
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function" && !helper.runtime.isSessionInteractive()) {
        return false;
      }
      if (helper.state.speakerSwitchPending) {
        return false;
      }
      helper.state.speakerSwitchPending = true;
      try {
        const speakerOneVisible = await ensureLaneVisibility("Speaker 1", true);
        const speakerTwoVisible = await ensureLaneVisibility("Speaker 2", true);
        const allUnmuted = await clearAllLaneMutes();
        const selectorUpdated = await selectSpeakerInToolbar("All Tracks");
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
        trackLabel: "",
        speakerKey: "",
        isActive: false,
        startText: "",
        endText: ""
      };
      const startCell = row.children[2];
      const endCell = row.children[3];
      identity.startText = startCell instanceof HTMLElement ? helper.normalizeText(startCell) : "";
      identity.endText = endCell instanceof HTMLElement ? helper.normalizeText(endCell) : "";
      let fiber = getReactFiber(row);
      if (!fiber) {
        const textarea = helper.getRowTextarea(row);
        fiber = getReactFiber(textarea);
      }
      let current = fiber;
      let depth = 0;
      while (current && typeof current === "object" && depth < 12) {
        const props = current.memoizedProps;
        if (props && typeof props === "object" && typeof props.isActive === "boolean") {
          identity.isActive = props.isActive;
        }
        const annotation = props && typeof props === "object" && props.annotation && typeof props.annotation === "object" ? props.annotation : null;
        if (annotation && typeof annotation.id === "string" && annotation.id) {
          identity.annotationId = annotation.id;
          identity.processedRecordingId = annotation.processedRecordingId != null ? String(annotation.processedRecordingId) : null;
          identity.trackLabel = typeof annotation.trackLabel === "string" ? annotation.trackLabel.trim() : "";
          identity.speakerKey = identity.processedRecordingId || identity.trackLabel || (row.children[1] instanceof HTMLElement ? helper.normalizeText(row.children[1]) : "");
          break;
        }
        current = current.return;
        depth += 1;
      }
      if (!identity.speakerKey) {
        identity.speakerKey = (row.children[1] instanceof HTMLElement ? helper.normalizeText(row.children[1]) : "") || "";
      }
      if (!identity.annotationId && !identity.startText && !identity.endText && !identity.speakerKey) {
        return null;
      }
      return identity;
    };
    helper.getRowSpeakerKey = function getRowSpeakerKey(row) {
      const identity = helper.getRowIdentity(row);
      return identity && typeof identity.speakerKey === "string" ? identity.speakerKey : "";
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
      for (let index = currentIndex + direction; index >= 0 && index < rows.length; index += direction) {
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
      return rows.find((row) => {
        const identity = helper.getRowIdentity(row);
        return Boolean(identity && identity.isActive);
      }) || null;
    };
    helper.findActiveRowByDomState = function findActiveRowByDomState() {
      const rows = helper.getTranscriptRows();
      return rows.find((row) => {
        if (!(row instanceof HTMLElement)) {
          return false;
        }
        const classes = row.classList;
        return classes.contains("bg-neutral-100") && classes.contains("ring-1") && classes.contains("ring-neutral-300");
      }) || null;
    };
    helper.rowMatchesIdentity = function rowMatchesIdentity(row, identity) {
      if (!(row instanceof HTMLElement) || !identity || typeof identity !== "object") {
        return false;
      }
      const rowIdentity = helper.getRowIdentity(row);
      if (!rowIdentity) {
        return false;
      }
      if (identity.annotationId && rowIdentity.annotationId && identity.annotationId === rowIdentity.annotationId) {
        return true;
      }
      return Boolean(
        identity.speakerKey && rowIdentity.speakerKey && identity.speakerKey === rowIdentity.speakerKey && (identity.startText && identity.endText && identity.startText === rowIdentity.startText && identity.endText === rowIdentity.endText || !identity.startText && !identity.endText)
      );
    };
    helper.findRowByIdentity = function findRowByIdentity(identity) {
      if (!identity || typeof identity !== "object") {
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
        return rows.find((row) => {
          const rowIdentity = helper.getRowIdentity(row);
          return rowIdentity && (!identity.speakerKey || !rowIdentity.speakerKey || rowIdentity.speakerKey === identity.speakerKey) && rowIdentity.startText === identity.startText && rowIdentity.endText === identity.endText;
        }) || null;
      }
      return null;
    };
    helper.getCurrentRow = function getCurrentRow(options) {
      const settings = options || {};
      const allowFallback = settings.allowFallback !== false;
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        const activeRow = active.closest("tr");
        if (activeRow && activeRow.querySelector(helper.config.rowTextareaSelector)) {
          helper.setCurrentRow(activeRow);
          return activeRow;
        }
      }
      const playbackRow = getLastPlaybackRow();
      if (playbackRow) {
        helper.setCurrentRow(playbackRow);
        return playbackRow;
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
      const cachedIdentity = helper.state.currentRowIdentity || (cachedRow instanceof HTMLElement ? helper.getRowIdentity(cachedRow) : null);
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
        "[data-radix-collection-item]"
      ];
      const matches = [];
      const seen = /* @__PURE__ */ new Set();
      for (const root of helper.getMenuRoots()) {
        const scoped = Array.from(root.querySelectorAll(selectors.join(",")));
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
        const scoped = Array.from(root.querySelectorAll("button, [role], div, span"));
        for (const node of scoped) {
          if (!(node instanceof HTMLElement) || seen.has(node) || !helper.isVisible(node)) {
            continue;
          }
          if (node.children.length > 1 && !node.matches("button, [role]")) {
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
      const candidates = helper.collectMenuCandidates().filter((candidate) => !(exclude && exclude.has(candidate)));
      const patterns = helper.config.actionPatterns[actionName] || [];
      for (const pattern of patterns) {
        const found = candidates.find((candidate) => pattern.test(helper.normalizeText(candidate)));
        if (found) {
          return found;
        }
      }
      if (actionName === "mergePrevious" || actionName === "mergeNext") {
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
      if (actionName !== "mergePrevious" && actionName !== "mergeNext" || !(row instanceof HTMLTableRowElement) || !Array.isArray(rows) || originalIndex < 0) {
        return null;
      }
      const direction = actionName === "mergePrevious" ? -1 : 1;
      const adjacentRow = rows[originalIndex + direction];
      if (!(adjacentRow instanceof HTMLTableRowElement)) {
        return null;
      }
      const survivingRow = direction < 0 ? adjacentRow : row;
      const survivingText = helper.getRowTextValue(survivingRow);
      const mergedText = direction < 0 ? helper.joinSegmentText(helper.getRowTextValue(adjacentRow), helper.getRowTextValue(row)) : helper.joinSegmentText(helper.getRowTextValue(row), helper.getRowTextValue(adjacentRow));
      const appendedText = direction < 0 ? helper.getRowTextValue(row) : helper.getRowTextValue(adjacentRow);
      const caretOffset = appendedText && mergedText.endsWith(appendedText) ? mergedText.length - appendedText.length : survivingText.length;
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
        if (text !== plan.survivingText && text.includes(plan.survivingText) && (!plan.adjacentText || text.includes(plan.adjacentText))) {
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
          direction: "none"
        };
        helper.state.blurRestorePending = true;
        textarea.focus({
          preventScroll: true
        });
        try {
          textarea.setSelectionRange(caret, caret, "none");
        } catch (_error) {
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
      const row = settings.row instanceof HTMLElement ? settings.row : helper.getCurrentRow({
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
        () => actionTrigger.getAttribute("aria-expanded") === "true" || actionTrigger.getAttribute("data-state") === "open",
        250,
        25
      );
      const actionItem = await helper.waitFor(
        () => helper.findMenuAction(actionName, {
          exclude: previousCandidates
        }) || helper.findMenuAction(actionName),
        1e3,
        50
      );
      if (!(actionItem instanceof HTMLElement)) {
        helper.dispatchClick(actionTrigger);
        return false;
      }
      helper.dispatchClick(actionItem);
      if (helper.analytics) {
        if (actionName === "mergePrevious") {
          helper.analytics.record("text:merge-previous", {
            rowIndex: originalIndex,
            hasMergePlan: Boolean(mergePlan)
          });
        } else if (actionName === "mergeNext") {
          helper.analytics.record("text:merge-next", {
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
          const textSettled = text === mergePlan.mergedText || text !== mergePlan.survivingText && text.includes(mergePlan.survivingText) && (!mergePlan.adjacentText || text.includes(mergePlan.adjacentText));
          const adjacentRemoved = !(mergePlan.adjacentRow instanceof HTMLTableRowElement) || !mergePlan.adjacentRow.isConnected;
          return rowCountSettled || textSettled || adjacentRemoved ? candidate : null;
        }, 1200, 40);
        const resolvedRow = mergedRow instanceof HTMLTableRowElement && mergedRow || findMergedRow(mergePlan, helper.getTranscriptRows());
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
          block: "center",
          behavior: "smooth"
        });
      }
      if (!options || options.activateRow !== false) {
        row.dispatchEvent(
          new MouseEvent("click", {
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
        if (options && typeof options.selectionStart === "number") {
          const end = typeof options.selectionEnd === "number" ? options.selectionEnd : options.selectionStart;
          textarea.setSelectionRange(
            options.selectionStart,
            end,
            typeof options.direction === "string" ? options.direction : "none"
          );
        } else if (options && options.cursor === "start") {
          textarea.setSelectionRange(0, 0);
        } else {
          const end = textarea.value.length;
          textarea.setSelectionRange(end, end);
        }
      } catch (_error) {
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
      return helper.focusRow(rows[nextIndex], {
        cursor: "start"
      });
    };
    helper.joinSegmentText = function joinSegmentText(left, right) {
      const before = typeof left === "string" ? left : String(left ?? "");
      const after = typeof right === "string" ? right : String(right ?? "");
      if (!before) {
        return after;
      }
      if (!after) {
        return before;
      }
      if (/\s$/.test(before) || /^\s/.test(after)) {
        return before + after;
      }
      return before + " " + after;
    };
    helper.splitTextByWordRatio = function splitTextByWordRatio(text, ratio) {
      const source = typeof text === "string" ? text : String(text ?? "");
      const words = source.trim().split(/\s+/).filter(Boolean);
      if (!words.length) {
        return {
          firstText: "",
          secondText: "",
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
        firstText: words.slice(0, splitCount).join(" "),
        secondText: words.slice(splitCount).join(" "),
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
      const row = textarea.closest("tr");
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
      const currentValue = textarea.value || "";
      const targetValue = targetTextarea.value || "";
      const selectionStart = typeof textarea.selectionStart === "number" ? textarea.selectionStart : currentValue.length;
      const selectionEnd = typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : selectionStart;
      if (offset < 0) {
        const splitIndex2 = Math.max(0, Math.min(currentValue.length, selectionStart));
        const movedText2 = currentValue.slice(0, splitIndex2).replace(/^\s+/, "").replace(/\s+$/, "");
        if (!movedText2) {
          return false;
        }
        const nextCurrentValue2 = currentValue.slice(splitIndex2).replace(/^\s+/, "");
        const nextTargetValue2 = helper.joinSegmentText(targetValue, movedText2);
        if (!helper.setEditableValue(targetTextarea, nextTargetValue2)) {
          return false;
        }
        if (!helper.setEditableValue(textarea, nextCurrentValue2)) {
          return false;
        }
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(0, 0);
        helper.setCurrentRow(row);
        if (helper.analytics) {
          helper.analytics.record("text:move-left", {
            movedLength: movedText2.length,
            splitIndex: splitIndex2,
            remainingLength: nextCurrentValue2.length,
            targetLength: nextTargetValue2.length
          });
        }
        return true;
      }
      const splitIndex = Math.max(0, Math.min(currentValue.length, selectionEnd));
      const movedText = currentValue.slice(splitIndex).replace(/^\s+/, "").replace(/\s+$/, "");
      if (!movedText) {
        return false;
      }
      const nextCurrentValue = currentValue.slice(0, splitIndex).replace(/\s+$/, "");
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
        helper.analytics.record("text:move-right", {
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
        document.body.setAttribute("tabindex", "-1");
        document.body.focus({
          preventScroll: true
        });
        document.body.removeAttribute("tabindex");
      }
      return document.activeElement !== active;
    };
    helper.toggleEditorFocus = function toggleEditorFocus() {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.matches(helper.config.rowTextareaSelector)) {
        const row = active.closest("tr");
        if (row) {
          helper.setCurrentRow(row);
        }
        const selStart = active.selectionStart;
        const selEnd = active.selectionEnd;
        const textLen = (active.value || "").length;
        const rowId = row ? helper.getRowIdentity(row)?.annotationId ?? null : null;
        helper.state.lastBlur = {
          row: row || helper.getCurrentRow(),
          selectionStart: selStart,
          selectionEnd: selEnd,
          direction: active.selectionDirection || "none"
        };
        helper.state.blurRestorePending = true;
        if (typeof helper.state.cursorBaseline !== "number") {
          helper.state.cursorBaseline = selStart;
        }
        const cleared = helper.clearActiveFocus();
        if (helper.analytics) {
          helper.analytics.record("focus:blur", {
            rowId,
            cursorPos: selStart,
            selectionLength: selEnd - selStart,
            textLength: textLen,
            cursorBaseline: helper.state.cursorBaseline,
            cursorRatio: textLen > 0 ? Math.round(selStart / textLen * 100) / 100 : null
          });
        }
        return cleared;
      }
      const remembered = helper.state.lastBlur;
      if (!helper.state.blurRestorePending) {
        return false;
      }
      const preservedGhostTarget = getGhostCursorTarget();
      stopGhostCursor();
      const currentRow = helper.getCurrentRow();
      if (!remembered) {
        const focused2 = preservedGhostTarget ? helper.focusRow(preservedGhostTarget.row, {
          activateRow: false,
          selectionStart: preservedGhostTarget.offset,
          selectionEnd: preservedGhostTarget.offset,
          direction: "none"
        }) : helper.focusRow(currentRow, { cursor: "start" });
        if (focused2) {
          helper.state.blurRestorePending = false;
          if (helper.analytics) {
            helper.analytics.record("focus:restore-fallback", {
              reason: preservedGhostTarget ? "ghost-cursor-no-remembered-blur" : "no-remembered-blur"
            });
          }
        }
        return focused2;
      }
      const rememberedRow = remembered.row;
      const rememberedRowStillCurrent = rememberedRow && rememberedRow.isConnected && currentRow && currentRow === rememberedRow;
      if (rememberedRowStillCurrent) {
        let selectionStart = remembered.selectionStart;
        let selectionEnd = remembered.selectionEnd;
        let direction = remembered.direction;
        let usedProportional = false;
        if (helper.config.features.proportionalCursorRestore) {
          const blurTime = helper.state.blurPlaybackTime;
          const restoreTime = helper.state.restorePlaybackTime;
          if (typeof blurTime === "number" && Number.isFinite(blurTime) && typeof restoreTime === "number" && Number.isFinite(restoreTime) && Math.abs(restoreTime - blurTime) >= PROPORTIONAL_MIN_DELTA_SECONDS) {
            const timeRange = getRowTimeRange(rememberedRow);
            if (timeRange) {
              const textarea = helper.getRowTextarea(rememberedRow);
              const text = textarea instanceof HTMLTextAreaElement ? textarea.value || "" : "";
              if (text.length > 0) {
                const baseline = typeof helper.state.cursorBaseline === "number" ? helper.state.cursorBaseline : remembered.selectionStart;
                const result = computeRestoreOffset(text, timeRange, restoreTime, blurTime, baseline);
                if (result) {
                  selectionStart = result.offset;
                  selectionEnd = result.offset;
                  direction = "none";
                  usedProportional = true;
                  if (helper.analytics) {
                    helper.analytics.record("cursor:proportional-offset", {
                      blurTime,
                      restoreTime,
                      playbackDelta: Math.round((restoreTime - blurTime) * 1e3) / 1e3,
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
        helper.state.cursorBaseline = selectionStart;
        const focused2 = helper.focusRow(rememberedRow, {
          activateRow: false,
          selectionStart,
          selectionEnd,
          direction
        });
        if (focused2) {
          helper.state.blurRestorePending = false;
          if (helper.analytics) {
            const rowId = helper.getRowIdentity(rememberedRow)?.annotationId ?? null;
            const eventType = usedProportional ? "focus:restore-proportional" : "focus:restore";
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
        return focused2;
      }
      if (preservedGhostTarget) {
        helper.state.blurPlaybackTime = null;
        helper.state.restorePlaybackTime = null;
        helper.state.blurRestorePending = false;
        helper.state.cursorBaseline = preservedGhostTarget.offset;
        const focused2 = helper.focusRow(preservedGhostTarget.row, {
          activateRow: false,
          selectionStart: preservedGhostTarget.offset,
          selectionEnd: preservedGhostTarget.offset,
          direction: "none"
        });
        if (focused2 && helper.analytics) {
          const rowId = helper.getRowIdentity(preservedGhostTarget.row)?.annotationId ?? null;
          helper.analytics.record("focus:restore-fallback", {
            rowId,
            reason: "ghost-cursor-target",
            cursorPos: preservedGhostTarget.offset,
            rememberedRowConnected: rememberedRow?.isConnected ?? false,
            currentRowConnected: currentRow?.isConnected ?? false
          });
          helper.analytics.endEscCycle({
            cursorPos: preservedGhostTarget.offset,
            proportional: true,
            rowId
          });
        }
        return focused2;
      }
      const fallbackRow = currentRow && currentRow.isConnected && currentRow || rememberedRow && rememberedRow.isConnected && rememberedRow || helper.getTranscriptRows()[0] || null;
      if (!fallbackRow) {
        if (helper.analytics) {
          helper.analytics.record("focus:restore-failed", { reason: "no-fallback-row" });
        }
        return false;
      }
      const focused = helper.focusRow(fallbackRow, {
        activateRow: false,
        cursor: "start"
      });
      if (focused) {
        helper.state.blurRestorePending = false;
        if (helper.analytics) {
          const rowId = helper.getRowIdentity(fallbackRow)?.annotationId ?? null;
          helper.analytics.record("focus:restore-fallback", {
            rowId,
            reason: "row-mismatch",
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
      const scheduled = escapePlaybackQueue.catch(() => {
      }).then(task);
      escapePlaybackQueue = scheduled.catch(() => {
      });
      return scheduled;
    }
    function getWavePausedState(wave) {
      if (!wave || typeof wave !== "object") {
        return null;
      }
      if (typeof wave.isPlaying === "function") {
        try {
          return !Boolean(wave.isPlaying());
        } catch (_error) {
          return null;
        }
      }
      if (wave.media && "paused" in wave.media) {
        return Boolean(wave.media.paused);
      }
      return null;
    }
    function getPlaybackStateLocally() {
      const waves = getPlaybackWaveInstances();
      if (waves.length) {
        const currentTime = Number(waves[0].getCurrentTime());
        const duration = typeof waves[0].getDuration === "function" ? Number(waves[0].getDuration()) : NaN;
        const paused = getWavePausedState(waves[0]);
        return {
          ok: Number.isFinite(currentTime) || typeof paused === "boolean",
          source: "wavesurfer",
          currentTime: Number.isFinite(currentTime) ? currentTime : null,
          duration: Number.isFinite(duration) ? duration : null,
          paused: typeof paused === "boolean" ? paused : null,
          waveCount: waves.length
        };
      }
      const audio = document.querySelector("audio");
      if (!(audio instanceof HTMLMediaElement)) {
        return {
          ok: false,
          reason: "playback-unavailable",
          paused: null,
          waveCount: 0
        };
      }
      return {
        ok: true,
        source: "audio",
        currentTime: Number.isFinite(Number(audio.currentTime)) ? Number(audio.currentTime) : null,
        duration: Number.isFinite(Number(audio.duration)) ? Number(audio.duration) : null,
        paused: Boolean(audio.paused),
        waveCount: 0
      };
    }
    helper.syncCurrentRowToPlayback = async function syncCurrentRowToPlayback() {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function" && !helper.runtime.isSessionInteractive()) {
        rememberPlaybackRow(null);
        return null;
      }
      const playback = typeof helper.getPlaybackState === "function" ? await helper.getPlaybackState() : getPlaybackStateLocally();
      if (!playback || !playback.ok) {
        return getLastPlaybackRow();
      }
      const playbackRow = typeof playback.currentTime === "number" ? findRowByPlaybackTime(playback.currentTime) : null;
      const preferredRow = playbackRow || getLastPlaybackRow();
      if (playbackRow) {
        rememberPlaybackRow(playbackRow);
      }
      if (playback.paused === false && preferredRow && !helper.state.ghostCursorElement) {
        startGhostCursor(preferredRow);
      } else if (playback.paused !== false) {
        stopGhostCursor();
      }
      if (!(helper.getActiveRowTextarea() instanceof HTMLTextAreaElement) && preferredRow) {
        helper.setCurrentRow(preferredRow);
      }
      return preferredRow;
    };
    function setWavePausedStateLocally(paused) {
      const waves = getPlaybackWaveInstances();
      if (!waves.length) {
        return null;
      }
      let applied = 0;
      for (const wave of waves) {
        try {
          if (paused) {
            if (typeof wave.pause === "function") {
              wave.pause();
              applied += 1;
              continue;
            }
            if (wave.media && typeof wave.media.pause === "function") {
              wave.media.pause();
              applied += 1;
              continue;
            }
          } else {
            if (typeof wave.play === "function") {
              const result = wave.play();
              if (result && typeof result.catch === "function") {
                result.catch(() => {
                });
              }
              applied += 1;
              continue;
            }
            if (wave.media && typeof wave.media.play === "function") {
              const result = wave.media.play();
              if (result && typeof result.catch === "function") {
                result.catch(() => {
                });
              }
              applied += 1;
              continue;
            }
          }
        } catch (_error) {
        }
      }
      if (!applied) {
        return null;
      }
      return getPlaybackStateLocally();
    }
    function setAudioPausedStateLocally(paused) {
      const audio = document.querySelector("audio");
      if (!(audio instanceof HTMLMediaElement)) {
        return null;
      }
      try {
        if (paused) {
          audio.pause();
        } else if (typeof audio.play === "function") {
          const result = audio.play();
          if (result && typeof result.catch === "function") {
            result.catch(() => {
            });
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
          via: "noop"
        };
      }
      const control = desired ? getPauseAllTracksButton() : getPlayAllTracksButton();
      if (control && clickControl(control)) {
        const afterControl = getPlaybackStateLocally();
        if (afterControl && afterControl.ok && afterControl.paused === desired) {
          return {
            ...afterControl,
            previousPaused: previous && typeof previous.paused === "boolean" ? previous.paused : null,
            changed: previous && typeof previous.paused === "boolean" ? previous.paused !== afterControl.paused : null,
            via: "control"
          };
        }
      }
      const direct = setWavePausedStateLocally(desired) || setAudioPausedStateLocally(desired) || {
        ok: false,
        reason: "playback-unavailable",
        paused: null,
        waveCount: 0
      };
      return {
        ...direct,
        previousPaused: previous && typeof previous.paused === "boolean" ? previous.paused : null,
        changed: previous && typeof previous.paused === "boolean" && typeof direct.paused === "boolean" ? previous.paused !== direct.paused : null
      };
    }
    helper.setPlaybackPaused = function setPlaybackPaused(paused) {
      const desired = Boolean(paused);
      return callPlaybackBridge("set-paused", { paused: desired }).then((result) => {
        if (result && result.ok && result.paused === desired) {
          return result;
        }
        return setPlaybackPausedLocally(desired);
      });
    };
    helper.getPlaybackState = function getPlaybackState() {
      return callPlaybackBridge("state").then((result) => {
        if (result && result.ok && typeof result.paused === "boolean") {
          return result;
        }
        return getPlaybackStateLocally();
      });
    };
    function focusCurrentEditorForEscape() {
      if (helper.state.blurRestorePending && helper.toggleEditorFocus()) {
        return true;
      }
      const ghostTarget = getGhostCursorTarget();
      stopGhostCursor();
      if (ghostTarget) {
        helper.state.blurPlaybackTime = null;
        helper.state.restorePlaybackTime = null;
        helper.state.blurRestorePending = false;
        helper.state.cursorBaseline = ghostTarget.offset;
        if (helper.analytics) {
          const rowId = helper.getRowIdentity(ghostTarget.row)?.annotationId ?? null;
          helper.analytics.record("focus:restore-fallback", {
            reason: "ghost-cursor-escape",
            rowId,
            cursorPos: ghostTarget.offset
          });
          helper.analytics.endEscCycle({
            cursorPos: ghostTarget.offset,
            proportional: true,
            rowId
          });
        }
        return helper.focusRow(ghostTarget.row, {
          activateRow: false,
          selectionStart: ghostTarget.offset,
          selectionEnd: ghostTarget.offset,
          direction: "none"
        });
      }
      const restoreTime = helper.state.restorePlaybackTime;
      if (typeof restoreTime === "number" && Number.isFinite(restoreTime)) {
        const timeRow = findRowByPlaybackTime(restoreTime);
        if (timeRow instanceof HTMLElement) {
          const timeRange = getRowTimeRange(timeRow);
          const textarea = helper.getRowTextarea(timeRow);
          if (timeRange && textarea instanceof HTMLTextAreaElement) {
            const text = textarea.value || "";
            if (text.length > 0 && helper.config.features.proportionalCursorRestore) {
              const blurTime = helper.state.blurPlaybackTime;
              const baseline = typeof helper.state.cursorBaseline === "number" ? helper.state.cursorBaseline : 0;
              const result = computeRestoreOffset(text, timeRange, restoreTime, blurTime, baseline);
              helper.state.blurPlaybackTime = null;
              helper.state.restorePlaybackTime = null;
              helper.state.blurRestorePending = false;
              if (result) {
                helper.state.cursorBaseline = result.offset;
                if (helper.analytics) {
                  const rowId = helper.getRowIdentity(timeRow)?.annotationId ?? null;
                  helper.analytics.record("focus:restore-fallback", {
                    reason: "time-lookup-proportional",
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
                  direction: "none"
                });
              }
            }
          }
          helper.state.blurPlaybackTime = null;
          helper.state.restorePlaybackTime = null;
          helper.state.blurRestorePending = false;
          if (helper.analytics) {
            const rowId = helper.getRowIdentity(timeRow)?.annotationId ?? null;
            helper.analytics.record("focus:restore-fallback", {
              reason: "time-lookup-start",
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
            cursor: "start"
          });
        }
      }
      const currentRow = helper.getCurrentRow();
      if (!(currentRow instanceof HTMLElement)) {
        if (helper.analytics) {
          helper.analytics.record("focus:restore-failed", { reason: "no-current-row-for-escape" });
        }
        return false;
      }
      if (helper.analytics) {
        const rowId = helper.getRowIdentity(currentRow)?.annotationId ?? null;
        helper.analytics.record("focus:restore-fallback", {
          reason: "current-row-fallback",
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
        cursor: "start"
      });
    }
    helper.handleEscapeWorkflow = function handleEscapeWorkflow() {
      const focused = helper.getActiveRowTextarea() instanceof HTMLTextAreaElement;
      if (helper.analytics) {
        helper.analytics.record("hotkey:escape", {
          focused,
          blurRestorePending: helper.state.blurRestorePending,
          hasLastBlur: Boolean(helper.state.lastBlur),
          cursorBaseline: helper.state.cursorBaseline
        });
      }
      void queueEscapePlaybackTask(async () => {
        const playback = await helper.getPlaybackState();
        const isPlaying = Boolean(playback && playback.ok && playback.paused === false);
        const currentTime = playback && typeof playback.currentTime === "number" ? playback.currentTime : null;
        if (helper.analytics) {
          helper.analytics.record("esc:playback-query", {
            ok: playback?.ok,
            paused: playback?.paused,
            currentTime,
            source: playback?.source
          });
        }
        if (focused && isPlaying) {
          if (helper.analytics) {
            helper.analytics.record("esc:state1:focused-playing", {
              playbackTime: currentTime
            });
          }
          await helper.setPlaybackPaused(true);
          if (helper.analytics) {
            helper.analytics.record("playback:pause", { via: "esc-state1", playbackTime: currentTime });
          }
          return;
        }
        if (!focused && isPlaying) {
          helper.state.restorePlaybackTime = playback && typeof playback.currentTime === "number" ? playback.currentTime : null;
          if (helper.analytics) {
            const rowId = helper.state.lastBlur?.row ? helper.getRowIdentity(helper.state.lastBlur.row)?.annotationId ?? null : null;
            helper.analytics.record("esc:state2:unfocused-playing", {
              playbackTime: currentTime,
              blurPlaybackTime: helper.state.blurPlaybackTime,
              playbackDelta: currentTime != null && helper.state.blurPlaybackTime != null ? Math.round((currentTime - helper.state.blurPlaybackTime) * 1e3) / 1e3 : null,
              rowId,
              blurRestorePending: helper.state.blurRestorePending
            });
          }
          focusCurrentEditorForEscape();
          await helper.setPlaybackPaused(true);
          if (helper.analytics) {
            helper.analytics.record("playback:pause", { via: "esc-state2", playbackTime: currentTime });
          }
          return;
        }
        if (focused && !isPlaying) {
          const activeTextarea = helper.getActiveRowTextarea();
          const cursorPos = activeTextarea ? activeTextarea.selectionStart : null;
          const textLen = activeTextarea ? (activeTextarea.value || "").length : null;
          const row = activeTextarea ? activeTextarea.closest("tr") : null;
          const rowId = row ? helper.getRowIdentity(row)?.annotationId ?? null : null;
          helper.toggleEditorFocus();
          helper.state.blurPlaybackTime = playback && typeof playback.currentTime === "number" ? playback.currentTime : null;
          if (helper.analytics) {
            helper.analytics.record("esc:state3:focused-notplaying", {
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
            helper.analytics.record("playback:resume", { via: "esc-state3", playbackTime: currentTime });
          }
          const blurredRow = helper.state.lastBlur && helper.state.lastBlur.row;
          if (blurredRow) {
            startGhostCursor(blurredRow);
          }
          return;
        }
        const bootstrapRow = typeof currentTime === "number" && findRowByPlaybackTime(currentTime) || helper.findActiveRowByDomState() || helper.findActiveRowByReactState() || helper.getCurrentRow();
        const bootstrapRowId = bootstrapRow ? helper.getRowIdentity(bootstrapRow)?.annotationId ?? null : null;
        if (helper.analytics) {
          helper.analytics.record("esc:state4:unfocused-notplaying", {
            playbackTime: currentTime,
            bootstrapRowId,
            hasBootstrapRow: Boolean(bootstrapRow)
          });
          helper.analytics.startEscCycle(4, {
            playbackTime: currentTime,
            rowId: bootstrapRowId,
            cursorPos: 0,
            textLength: bootstrapRow ? (helper.getRowTextValue(bootstrapRow) || "").length : null
          });
        }
        if (bootstrapRow) {
          helper.state.lastBlur = {
            row: bootstrapRow,
            selectionStart: 0,
            selectionEnd: 0,
            direction: "none",
            synthetic: true
          };
          helper.state.blurRestorePending = true;
          helper.state.cursorBaseline = 0;
          helper.state.blurPlaybackTime = typeof currentTime === "number" ? currentTime : null;
          helper.setCurrentRow(bootstrapRow);
        }
        await helper.setPlaybackPaused(false);
        if (helper.analytics) {
          helper.analytics.record("playback:resume", { via: "esc-state4", playbackTime: currentTime });
        }
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
        const currentTime2 = Number(waves[0].getCurrentTime());
        if (!Number.isFinite(currentTime2)) {
          return false;
        }
        const duration2 = typeof waves[0].getDuration === "function" ? Number(waves[0].getDuration()) : NaN;
        const maxTime2 = Number.isFinite(duration2) && duration2 > 0 ? duration2 : Number.POSITIVE_INFINITY;
        const nextTime2 = Math.max(0, Math.min(maxTime2, currentTime2 + delta));
        if (!Number.isFinite(nextTime2)) {
          return false;
        }
        for (const wave of waves) {
          try {
            wave.setTime(nextTime2);
          } catch (_error) {
          }
        }
        return true;
      }
      const audio = document.querySelector("audio");
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
        helper.analytics.record("playback:seek", { deltaSeconds: delta });
      }
      return callPlaybackBridge("seek", { deltaSeconds: delta }).then((result) => {
        if (result && result.ok) {
          return true;
        }
        return seekPlaybackBySecondsLocally(delta);
      });
    };
  }

  // src/services/hotkeys-help-service.ts
  function registerHotkeysHelpService(helper) {
    if (!helper || helper.__hotkeysRegistered) {
      return;
    }
    helper.__hotkeysRegistered = true;
    helper.findHotkeysHosts = function findHotkeysHosts() {
      const candidates = Array.from(
        document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]')
      );
      return candidates.filter((candidate) => candidate instanceof HTMLElement && helper.isVisible(candidate)).map(
        (candidate) => candidate.matches('[role="dialog"]') ? candidate : candidate.querySelector('[role="dialog"]') || candidate
      ).filter((candidate) => candidate instanceof HTMLElement && helper.isVisible(candidate)).filter((candidate) => {
        const text = helper.normalizeText(candidate);
        return helper.config.hotkeysDialogPatterns.some((pattern) => pattern.test(text));
      });
    };
    helper.buildHotkeysHelpBlock = function buildHotkeysHelpBlock() {
      const wrapper = document.createElement("div");
      wrapper.setAttribute(helper.config.hotkeysHelpMarker, "true");
      wrapper.style.marginTop = "12px";
      wrapper.style.paddingTop = "12px";
      wrapper.style.borderTop = "1px solid rgba(148, 163, 184, 0.35)";
      const title = document.createElement("div");
      title.textContent = "Babel Helper";
      title.style.fontWeight = "700";
      title.style.fontSize = "14px";
      title.style.marginBottom = "8px";
      wrapper.appendChild(title);
      for (const [shortcut, description] of helper.config.hotkeysHelpRows) {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.gap = "12px";
        row.style.marginTop = "4px";
        const text = document.createElement("span");
        text.textContent = description;
        text.style.flex = "1";
        text.style.minWidth = "0";
        text.style.fontSize = "14px";
        text.style.color = "rgb(51, 65, 85)";
        text.style.textAlign = "left";
        const key = document.createElement("kbd");
        key.textContent = shortcut;
        key.style.marginLeft = "auto";
        key.style.padding = "3px 8px";
        key.style.border = "1px solid rgb(226, 232, 240)";
        key.style.borderRadius = "8px";
        key.style.background = "rgb(248, 250, 252)";
        key.style.fontFamily = "ui-monospace, SFMono-Regular, Consolas, monospace";
        key.style.fontSize = "12px";
        key.style.fontWeight = "700";
        key.style.whiteSpace = "nowrap";
        key.style.color = "rgb(100, 116, 139)";
        row.appendChild(text);
        row.appendChild(key);
        wrapper.appendChild(row);
      }
      return wrapper;
    };
    helper.enhanceHotkeysDialog = function enhanceHotkeysDialog() {
      for (const host of helper.findHotkeysHosts()) {
        if (!(host instanceof HTMLElement) || host.querySelector("[" + helper.config.hotkeysHelpMarker + "]")) {
          continue;
        }
        const contentTarget = host.querySelector('[data-slot="dialog-content"]') || host.querySelector('[class*="overflow-y-auto"]') || host.querySelector('[class*="overflow-auto"]') || host.querySelector('[class*="max-h"]') || host;
        if (contentTarget instanceof HTMLElement) {
          contentTarget.style.overflowY = "auto";
          contentTarget.style.maxHeight = "min(80vh, calc(100vh - 96px))";
        }
        contentTarget.appendChild(helper.buildHotkeysHelpBlock());
      }
    };
  }

  // src/core/workflow-defaults.ts
  var WORKFLOW_DEFAULTS_STORAGE_KEY = "workflowDefaults";
  var MIN_ZOOM_VALUE = 10;
  var MAX_ZOOM_VALUE = 2e3;
  var DEFAULT_WORKFLOW_DEFAULTS = {
    lastZoomValue: null
  };
  function getExtensionStorage2() {
    const chromeApi = globalThis.chrome;
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
      return null;
    }
    return chromeApi.storage.local;
  }
  function normalizeZoomValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return Math.min(MAX_ZOOM_VALUE, Math.max(MIN_ZOOM_VALUE, Math.round(numeric)));
  }
  function normalizeWorkflowDefaults(source) {
    const incoming = source && typeof source === "object" && source !== null ? source : {};
    return {
      lastZoomValue: normalizeZoomValue(incoming.lastZoomValue)
    };
  }
  async function loadWorkflowDefaults() {
    const storage = getExtensionStorage2();
    if (!storage || typeof storage.get !== "function") {
      return normalizeWorkflowDefaults(DEFAULT_WORKFLOW_DEFAULTS);
    }
    return new Promise((resolve) => {
      storage.get(WORKFLOW_DEFAULTS_STORAGE_KEY, (items) => {
        const runtime = globalThis.chrome;
        if (runtime?.runtime?.lastError) {
          resolve(normalizeWorkflowDefaults(DEFAULT_WORKFLOW_DEFAULTS));
          return;
        }
        resolve(normalizeWorkflowDefaults(items?.[WORKFLOW_DEFAULTS_STORAGE_KEY]));
      });
    });
  }
  async function saveWorkflowDefaults(defaults) {
    const normalized = normalizeWorkflowDefaults(defaults);
    const storage = getExtensionStorage2();
    if (!storage || typeof storage.set !== "function") {
      return normalized;
    }
    return new Promise((resolve) => {
      storage.set({ [WORKFLOW_DEFAULTS_STORAGE_KEY]: normalized }, () => {
        resolve(normalized);
      });
    });
  }

  // src/services/timeline-selection-service.ts
  function registerTimelineSelectionService(helper) {
    if (!helper || helper.__cutRegistered) {
      return;
    }
    helper.__cutRegistered = true;
    const CUT_PREVIEW_ATTR = "data-babel-helper-cut-preview";
    const CUT_PREVIEW_HANDLE_ATTR = "data-babel-helper-cut-handle";
    const CUT_PREVIEW_MIN_SECONDS = 1;
    const CUT_PREVIEW_SAFETY_MIN_SECONDS = 8e-3;
    const CUT_PREVIEW_SAFETY_MAX_SECONDS = 0.03;
    const CUT_PREVIEW_MIN_WIDTH = 8;
    const CUT_PREVIEW_DRAG_THRESHOLD = 5;
    const CUT_PREVIEW_HANDLE_HIT_WIDTH = 12;
    const SELECTION_LOOP_HOST_ATTR = "data-babel-helper-selection-loop-host";
    const BRIDGE_REQUEST_EVENT = "babel-helper-magnifier-request";
    const BRIDGE_RESPONSE_EVENT = "babel-helper-magnifier-response";
    const BRIDGE_SCRIPT_PATH3 = "dist/content/magnifier-bridge.js";
    const BRIDGE_TIMEOUT_MS = 700;
    const ZOOM_PERSIST_DEBOUNCE_MS = 240;
    helper.state.cutDraft = null;
    helper.state.cutPreview = null;
    helper.state.cutCommitPending = false;
    helper.state.cutLastContainer = null;
    helper.state.smartSplitClickDraft = null;
    helper.state.smartSplitClickContext = null;
    helper.state.selectionLoop = null;
    helper.config.hotkeysHelpRows.unshift(["Shift + Ctrl/Cmd + Click", "Run native split and redistribute words"]);
    helper.config.hotkeysHelpRows.unshift(["L", "Loop the selected range until playback caret moves"]);
    helper.config.hotkeysHelpRows.unshift(["Shift + S", "Split the selected range"]);
    helper.config.hotkeysHelpRows.unshift(["S", "Smart-split the selected range"]);
    helper.config.hotkeysHelpRows.unshift(["Alt + Drag", "Create a timeline selection"]);
    let bridgeInjected = false;
    let bridgeLoadPromise = null;
    let bridgeRequestId = 0;
    let zoomPersistenceSlider = null;
    let zoomPersistenceObserver = null;
    let zoomPersistenceTimer = 0;
    let zoomPersistenceApplying = false;
    let zoomPersistenceLoaded = false;
    let zoomPersistenceDefaults = null;
    let zoomPersistenceSaveChain = Promise.resolve();
    function isFeatureEnabled(featureKey) {
      if (typeof helper.isFeatureEnabled === "function") {
        return helper.isFeatureEnabled(featureKey);
      }
      return true;
    }
    function setSelectionLoopDebug(stage, details) {
      const root = document.documentElement;
      if (!(root instanceof HTMLElement)) {
        return;
      }
      root.dataset.babelHelperSelectionLoopStage = stage || "";
      if (details && typeof details === "object") {
        try {
          root.dataset.babelHelperSelectionLoopInfo = JSON.stringify(details);
        } catch (error) {
          root.dataset.babelHelperSelectionLoopInfo = String(error && error.message ? error.message : error);
        }
      } else {
        delete root.dataset.babelHelperSelectionLoopInfo;
      }
    }
    function nextLoopMarker() {
      return "selection-loop-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    }
    function ensureSelectionHostMarker(container) {
      const host = getWaveformHostFromContainer(container);
      if (!(host instanceof HTMLElement)) {
        return null;
      }
      const existing = host.getAttribute(SELECTION_LOOP_HOST_ATTR);
      if (existing) {
        return existing;
      }
      const marker = nextLoopMarker();
      host.setAttribute(SELECTION_LOOP_HOST_ATTR, marker);
      return marker;
    }
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }
    function parseTimeValue(value) {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const normalized = trimmed.toLowerCase();
      const timestampMatch = normalized.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
      if (timestampMatch) {
        const parts = timestampMatch[0].split(":");
        let total2 = 0;
        for (const part of parts) {
          const numeric2 = Number(part);
          if (!Number.isFinite(numeric2)) {
            return null;
          }
          total2 = total2 * 60 + numeric2;
        }
        return total2;
      }
      let total = 0;
      let foundUnit = false;
      const unitPattern = /(-?\d+(?:\.\d+)?)\s*([hms])/g;
      for (const match of normalized.matchAll(unitPattern)) {
        const numeric2 = Number(match[1]);
        if (!Number.isFinite(numeric2)) {
          return null;
        }
        foundUnit = true;
        const unit = match[2];
        if (unit === "h") {
          total += numeric2 * 3600;
        } else if (unit === "m") {
          total += numeric2 * 60;
        } else {
          total += numeric2;
        }
      }
      if (foundUnit) {
        return total;
      }
      const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
      if (!numericMatch) {
        return null;
      }
      const numeric = Number(numericMatch[0]);
      return Number.isFinite(numeric) ? numeric : null;
    }
    function parseSecondsLabel(value) {
      const parsed = parseTimeValue(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    function parsePixels(value) {
      if (typeof value !== "string") {
        return null;
      }
      const match = value.match(/(-?\d+(?:\.\d+)?)px/i);
      if (!match) {
        return null;
      }
      const numeric = Number(match[1]);
      return Number.isFinite(numeric) ? numeric : null;
    }
    function parseTranslateXPixels(value) {
      if (typeof value !== "string") {
        return null;
      }
      const match = value.match(/translateX\((-?\d+(?:\.\d+)?)px\)/i);
      if (!match) {
        return null;
      }
      const numeric = Number(match[1]);
      return Number.isFinite(numeric) ? numeric : null;
    }
    function getReactInternalValue(element, prefix) {
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      for (const name of Object.getOwnPropertyNames(element)) {
        if (typeof name === "string" && name.indexOf(prefix) === 0) {
          return element[name];
        }
      }
      return null;
    }
    function getReactFiber(element) {
      return getReactInternalValue(element, "__reactFiber$");
    }
    function getRegionPartTokens(element) {
      const part = element instanceof Element ? element.getAttribute("part") : "";
      return part ? part.split(/\s+/).filter(Boolean) : [];
    }
    function isRegionHandle(element) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const tokens = getRegionPartTokens(element);
      return tokens.includes("region-handle") || tokens.includes("region-handle-left") || tokens.includes("region-handle-right");
    }
    function getRegionHandleElement(element) {
      let current = element instanceof HTMLElement ? element : null;
      while (current instanceof HTMLElement) {
        if (isRegionHandle(current)) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }
    function isRegionBody(element) {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const tokens = getRegionPartTokens(element);
      return tokens.includes("region");
    }
    function getOwningRegionBody(element) {
      let current = element instanceof HTMLElement ? element : null;
      while (current instanceof HTMLElement) {
        if (isRegionBody(current)) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }
    function isSmartSplitClickEvent(event) {
      return Boolean(
        event && event.button === 0 && !event.altKey && event.shiftKey && (event.ctrlKey || event.metaKey)
      );
    }
    function getPreviewHostFromEvent(event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const node of path) {
        if (node instanceof HTMLElement && node.hasAttribute(CUT_PREVIEW_ATTR)) {
          return node;
        }
      }
      return null;
    }
    function getRegionTimeText(region, selector) {
      if (!(region instanceof HTMLElement)) {
        return "";
      }
      const tooltip = region.querySelector(selector);
      return tooltip instanceof HTMLElement ? helper.normalizeText(tooltip) : "";
    }
    function getRowTimeLabels(row) {
      if (!(row instanceof HTMLTableRowElement) || row.children.length < 4) {
        return null;
      }
      return {
        startText: helper.normalizeText(row.children[2]),
        endText: helper.normalizeText(row.children[3])
      };
    }
    function getRowTimeRange(row) {
      const labels = getRowTimeLabels(row);
      if (!labels) {
        return null;
      }
      const startSeconds = parseTimeValue(labels.startText);
      const endSeconds = parseTimeValue(labels.endText);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return null;
      }
      return {
        startSeconds,
        endSeconds
      };
    }
    function findRowByTimeRange(startSeconds, endSeconds, options) {
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return null;
      }
      const settings = options || {};
      const speakerKey = typeof settings.speakerKey === "string" && settings.speakerKey ? settings.speakerKey : "";
      const rows = helper.getTranscriptRows();
      let bestRow = null;
      let bestScore = -Infinity;
      for (const row of rows) {
        if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
          continue;
        }
        const range = getRowTimeRange(row);
        if (!range) {
          continue;
        }
        const overlap = Math.max(
          0,
          Math.min(endSeconds, range.endSeconds) - Math.max(startSeconds, range.startSeconds)
        );
        const distance = Math.abs(range.startSeconds - startSeconds) + Math.abs(range.endSeconds - endSeconds);
        const score = overlap > 0 ? overlap * 100 - distance : -distance;
        if (score > bestScore) {
          bestScore = score;
          bestRow = row;
        }
      }
      return bestRow;
    }
    function findRowByTimeLabels(startText, endText, options) {
      if (!startText || !endText) {
        return null;
      }
      const settings = options || {};
      const speakerKey = typeof settings.speakerKey === "string" && settings.speakerKey ? settings.speakerKey : "";
      const rows = helper.getTranscriptRows();
      const exactMatch = rows.find((row) => {
        if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
          return false;
        }
        const labels = getRowTimeLabels(row);
        return labels && labels.startText === startText && labels.endText === endText;
      }) || null;
      if (exactMatch) {
        return exactMatch;
      }
      const targetStart = parseTimeValue(startText);
      const targetEnd = parseTimeValue(endText);
      if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || targetEnd <= targetStart) {
        return null;
      }
      return findRowByTimeRange(targetStart, targetEnd, {
        speakerKey
      });
    }
    async function deleteRegionByTimeLabels(startText, endText, options) {
      const row = findRowByTimeLabels(startText, endText, options);
      if (!(row instanceof HTMLTableRowElement)) {
        return false;
      }
      helper.setCurrentRow(row);
      return helper.runRowAction("deleteSegment");
    }
    function getWaveformScope(container) {
      const timelineSelector = '[part~="timeline-notch-primary"], [part~="timeline-notch-secondary"]';
      let scope = container instanceof HTMLElement ? container : null;
      while (scope instanceof HTMLElement) {
        if (scope.querySelectorAll(timelineSelector).length >= 2) {
          return scope;
        }
        scope = scope.parentElement;
      }
      const root = container && typeof container.getRootNode === "function" ? container.getRootNode() : null;
      if (root && typeof root.querySelectorAll === "function" && root.querySelectorAll(timelineSelector).length >= 2) {
        return root;
      }
      return root && typeof root.querySelector === "function" ? root : null;
    }
    function getZoomSliderElement() {
      const selector = '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';
      const slider = document.querySelector(selector);
      return slider instanceof HTMLElement ? slider : null;
    }
    function clearZoomPersistenceTimer() {
      if (zoomPersistenceTimer) {
        window.clearTimeout(zoomPersistenceTimer);
        zoomPersistenceTimer = 0;
      }
    }
    function getNumericZoomValueFromSlider(slider) {
      if (!(slider instanceof HTMLElement)) {
        return null;
      }
      const numeric = Number(slider.getAttribute("aria-valuenow"));
      return Number.isFinite(numeric) ? numeric : null;
    }
    async function ensureZoomPersistenceDefaults() {
      if (zoomPersistenceLoaded && zoomPersistenceDefaults) {
        return zoomPersistenceDefaults;
      }
      const loaded = await loadWorkflowDefaults();
      zoomPersistenceDefaults = loaded;
      zoomPersistenceLoaded = true;
      return loaded;
    }
    async function persistZoomValue(value) {
      if (!isFeatureEnabled("timelineZoomDefaults")) {
        return;
      }
      const normalized = normalizeZoomValue(value);
      if (!Number.isFinite(normalized)) {
        return;
      }
      const defaults = await ensureZoomPersistenceDefaults();
      if (defaults.lastZoomValue === normalized) {
        return;
      }
      const saved = await saveWorkflowDefaults({
        ...defaults,
        lastZoomValue: normalized
      });
      zoomPersistenceDefaults = saved;
      zoomPersistenceLoaded = true;
    }
    function queuePersistZoomValue(value) {
      zoomPersistenceSaveChain = zoomPersistenceSaveChain.then(() => persistZoomValue(value)).catch(() => {
      });
    }
    function scheduleZoomPersistenceFromSlider(slider) {
      if (!isFeatureEnabled("timelineZoomDefaults")) {
        return;
      }
      if (zoomPersistenceApplying) {
        return;
      }
      const value = getNumericZoomValueFromSlider(slider);
      if (!Number.isFinite(value)) {
        return;
      }
      clearZoomPersistenceTimer();
      zoomPersistenceTimer = window.setTimeout(() => {
        zoomPersistenceTimer = 0;
        queuePersistZoomValue(value);
      }, ZOOM_PERSIST_DEBOUNCE_MS);
    }
    function getZoomValueCallbacks(slider) {
      if (!(slider instanceof HTMLElement)) {
        return [];
      }
      const callbacks = [];
      let node = getReactFiber(slider);
      let depth = 0;
      while (node && typeof node === "object" && depth < 40) {
        const props = node.memoizedProps;
        if (props && typeof props === "object" && typeof props.onValueChange === "function") {
          callbacks.push(props.onValueChange);
        }
        node = node.return;
        depth += 1;
      }
      return callbacks;
    }
    async function applyZoomValueToSlider(value) {
      const slider = getZoomSliderElement();
      if (!(slider instanceof HTMLElement)) {
        return false;
      }
      const sliderMin = Number(slider.getAttribute("aria-valuemin"));
      const sliderMax = Number(slider.getAttribute("aria-valuemax"));
      if (!Number.isFinite(sliderMin) || !Number.isFinite(sliderMax) || sliderMax <= sliderMin) {
        return false;
      }
      const normalized = normalizeZoomValue(value);
      if (!Number.isFinite(normalized)) {
        return false;
      }
      const target = Math.min(sliderMax, Math.max(sliderMin, normalized));
      const current = getNumericZoomValueFromSlider(slider);
      if (Number.isFinite(current) && Math.abs(current - target) <= 0.5) {
        return true;
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let invoked = false;
        const bridgeResult = await callSelectionBridge("zoom-set", {
          value: target
        });
        if (bridgeResult && bridgeResult.ok) {
          invoked = true;
        }
        if (!invoked) {
          const callbacks = getZoomValueCallbacks(slider);
          for (const callback of callbacks) {
            try {
              callback([target]);
              invoked = true;
            } catch (_error) {
            }
          }
        }
        if (!invoked) {
          return false;
        }
        const settled = await helper.waitFor(() => {
          const refreshedSlider = getZoomSliderElement();
          const refreshedValue = getNumericZoomValueFromSlider(refreshedSlider);
          return Number.isFinite(refreshedValue) && Math.abs(refreshedValue - target) <= 1 ? refreshedSlider : null;
        }, 240, 20);
        if (settled) {
          return true;
        }
        await helper.sleep(32);
      }
      return false;
    }
    helper.bindZoomPersistence = function bindZoomPersistence() {
      if (!isFeatureEnabled("timelineZoomDefaults")) {
        helper.unbindZoomPersistence();
        return false;
      }
      const slider = getZoomSliderElement();
      if (!(slider instanceof HTMLElement) || typeof MutationObserver !== "function") {
        return false;
      }
      if (zoomPersistenceSlider === slider && zoomPersistenceObserver) {
        return true;
      }
      if (zoomPersistenceObserver && typeof zoomPersistenceObserver.disconnect === "function") {
        zoomPersistenceObserver.disconnect();
      }
      zoomPersistenceSlider = slider;
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes" && mutation.attributeName === "aria-valuenow") {
            scheduleZoomPersistenceFromSlider(slider);
            return;
          }
        }
      });
      observer.observe(slider, {
        attributes: true,
        attributeFilter: ["aria-valuenow"]
      });
      zoomPersistenceObserver = observer;
      return true;
    };
    helper.unbindZoomPersistence = function unbindZoomPersistence() {
      clearZoomPersistenceTimer();
      if (zoomPersistenceObserver && typeof zoomPersistenceObserver.disconnect === "function") {
        zoomPersistenceObserver.disconnect();
      }
      zoomPersistenceObserver = null;
      zoomPersistenceSlider = null;
    };
    helper.applySavedZoomDefault = async function applySavedZoomDefault() {
      if (!isFeatureEnabled("timelineZoomDefaults")) {
        return false;
      }
      const slider = getZoomSliderElement() || await helper.waitFor(() => getZoomSliderElement(), 1e3, 50);
      if (!(slider instanceof HTMLElement)) {
        return false;
      }
      helper.bindZoomPersistence();
      const defaults = await ensureZoomPersistenceDefaults();
      const targetValue = normalizeZoomValue(defaults.lastZoomValue);
      if (!Number.isFinite(targetValue)) {
        return false;
      }
      const currentValue = getNumericZoomValueFromSlider(slider);
      if (Number.isFinite(currentValue) && Math.abs(currentValue - targetValue) <= 0.5) {
        return true;
      }
      zoomPersistenceApplying = true;
      try {
        return await applyZoomValueToSlider(targetValue);
      } finally {
        window.setTimeout(() => {
          zoomPersistenceApplying = false;
        }, 120);
      }
    };
    function getZoomSliderSignature() {
      const slider = getZoomSliderElement();
      if (!(slider instanceof HTMLElement)) {
        return "";
      }
      const numericValue = Number(slider.getAttribute("aria-valuenow"));
      if (Number.isFinite(numericValue)) {
        return "slider:" + numericValue;
      }
      const tooltip = slider.querySelector("div");
      const label = parseSecondsLabel(helper.normalizeText(tooltip));
      if (Number.isFinite(label)) {
        return "slider-label:" + Math.round(label * 1e3) / 1e3;
      }
      return "";
    }
    function getWaveformWrapperElement(container) {
      const scope = getWaveformScope(container);
      if (!scope || typeof scope.querySelector !== "function") {
        return null;
      }
      const wrapper = scope.querySelector('[part="wrapper"]');
      return wrapper instanceof HTMLElement ? wrapper : null;
    }
    function getWaveformWrapperWidth(container) {
      const wrapper = getWaveformWrapperElement(container);
      if (!(wrapper instanceof HTMLElement)) {
        return null;
      }
      const styleWidth = parsePixels(wrapper.style.width || "");
      if (Number.isFinite(styleWidth) && styleWidth > 0) {
        return styleWidth;
      }
      const rect = wrapper.getBoundingClientRect();
      return rect.width > 0 ? rect.width : null;
    }
    function getLaneTimelinePoints(container) {
      const scope = getWaveformScope(container);
      if (!scope || typeof scope.querySelectorAll !== "function") {
        return [];
      }
      const notchSelector = '[part~="timeline-notch-primary"], [part~="timeline-notch-secondary"]';
      return Array.from(scope.querySelectorAll(notchSelector)).map((notch) => {
        if (!(notch instanceof HTMLElement)) {
          return null;
        }
        const seconds = parseSecondsLabel(helper.normalizeText(notch));
        const leftPx = parsePixels(notch.style.left || "");
        if (!Number.isFinite(seconds) || !Number.isFinite(leftPx)) {
          return null;
        }
        return {
          seconds,
          leftPx
        };
      }).filter(Boolean).sort((left, right) => left.leftPx - right.leftPx);
    }
    function getLaneZoomSignature(container) {
      const zoomSliderSignature = getZoomSliderSignature();
      if (zoomSliderSignature) {
        return zoomSliderSignature;
      }
      const wrapperWidth = getWaveformWrapperWidth(container);
      if (Number.isFinite(wrapperWidth) && wrapperWidth > 0) {
        return "wrapper:" + Math.round(wrapperWidth * 10) / 10;
      }
      const timeScale = getLaneTimeScale(container);
      if (timeScale && Number.isFinite(timeScale.secondsPerPx) && timeScale.secondsPerPx > 0) {
        return "scale:" + Math.round(timeScale.secondsPerPx * 1e6) / 1e6;
      }
      const regionSecondsPerPx = getLaneSecondsPerPixelFromRegions(container);
      if (Number.isFinite(regionSecondsPerPx) && regionSecondsPerPx > 0) {
        return "region-scale:" + Math.round(regionSecondsPerPx * 1e6) / 1e6;
      }
      return "";
    }
    function getLaneTimeScale(container) {
      const scope = getWaveformScope(container);
      if (!scope || typeof scope.querySelector !== "function") {
        return null;
      }
      const points = getLaneTimelinePoints(container);
      if (points.length >= 2) {
        const first = points[0];
        const last = points[points.length - 1];
        const dx = last.leftPx - first.leftPx;
        const dt = last.seconds - first.seconds;
        if (dx !== 0 && dt > 0) {
          const secondsPerPx = dt / dx;
          return {
            secondsPerPx,
            offsetSeconds: first.seconds - first.leftPx * secondsPerPx
          };
        }
      }
      const hover = typeof scope.querySelector === "function" ? scope.querySelector('[part="hover"]') : null;
      const hoverLabel = hover instanceof HTMLElement ? hover.querySelector('[part="hover-label"]') : null;
      const hoverSeconds = parseSecondsLabel(helper.normalizeText(hoverLabel));
      const hoverPx = hover instanceof HTMLElement ? parseTranslateXPixels(hover.style.transform || "") : null;
      if (Number.isFinite(hoverSeconds) && Number.isFinite(hoverPx)) {
        const secondsPerPixel = getLaneSecondsPerPixelFromRegions(container);
        if (Number.isFinite(secondsPerPixel) && secondsPerPixel > 0) {
          return {
            secondsPerPx: secondsPerPixel,
            offsetSeconds: hoverSeconds - hoverPx * secondsPerPixel
          };
        }
      }
      return null;
    }
    function getLaneSecondsPerPixelFromRegions(container) {
      const ratios = getRegionElements(container).map((region) => {
        const start = parseTimeValue(getRegionTimeText(region, ".wavesurfer-region-tooltip-start"));
        const end = parseTimeValue(getRegionTimeText(region, ".wavesurfer-region-tooltip-end"));
        const width = region.getBoundingClientRect().width;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || width <= 0) {
          return null;
        }
        return (end - start) / width;
      }).filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
      if (!ratios.length) {
        return null;
      }
      const middle = Math.floor(ratios.length / 2);
      if (ratios.length % 2 === 1) {
        return ratios[middle];
      }
      return (ratios[middle - 1] + ratios[middle]) / 2;
    }
    function isValidPreviewTimeRange(timeRange) {
      return Boolean(
        timeRange && Number.isFinite(timeRange.startSeconds) && Number.isFinite(timeRange.endSeconds) && timeRange.endSeconds > timeRange.startSeconds
      );
    }
    function getPreviewDurationSeconds(preview) {
      if (!preview) {
        return null;
      }
      const timeRange = getPreviewTimeRange(preview);
      if (timeRange && Number.isFinite(timeRange.startSeconds) && Number.isFinite(timeRange.endSeconds) && timeRange.endSeconds > timeRange.startSeconds) {
        return timeRange.endSeconds - timeRange.startSeconds;
      }
      return null;
    }
    function getPreviewCommitSafetySeconds(preview) {
      if (!preview || !(preview.container instanceof HTMLElement)) {
        return CUT_PREVIEW_SAFETY_MIN_SECONDS;
      }
      const waveformEntry = getWaveformEntryForContainer(preview.container);
      const pixelsPerSecond = getWaveformPixelsPerSecond(waveformEntry, preview.container);
      if (!(Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0)) {
        return CUT_PREVIEW_SAFETY_MIN_SECONDS;
      }
      return clamp(
        2 / pixelsPerSecond,
        CUT_PREVIEW_SAFETY_MIN_SECONDS,
        CUT_PREVIEW_SAFETY_MAX_SECONDS
      );
    }
    function getPreviewTimeRange(preview, options) {
      if (!preview) {
        return null;
      }
      if (isValidPreviewTimeRange(preview.timeRange)) {
        return preview.timeRange;
      }
      const settings = options || {};
      if (!preview.timeRangeRequest && settings.allowAsync !== false) {
        void refreshPreviewTimeRange(preview);
      }
      return null;
    }
    async function refreshPreviewTimeRange(preview, options) {
      if (!preview || helper.state.cutPreview !== preview) {
        return null;
      }
      const settings = options || {};
      if (preview.timeRangeRequest && !settings.force) {
        return preview.timeRangeRequest;
      }
      const hostMarker = preview.hostMarker || ensureSelectionHostMarker(preview.container);
      if (!hostMarker) {
        preview.timeRange = null;
        return null;
      }
      preview.hostMarker = hostMarker;
      const requestLeftPx = preview.leftPx;
      const requestRightPx = preview.rightPx;
      const request = callSelectionBridge("selection-time-range", {
        hostMarker,
        leftPx: requestLeftPx,
        rightPx: requestRightPx
      }).then((result) => {
        if (preview.timeRangeRequest !== request) {
          return getPreviewTimeRange(preview, { allowAsync: false });
        }
        preview.timeRangeRequest = null;
        if (preview.leftPx === requestLeftPx && preview.rightPx === requestRightPx && result && result.ok && isValidPreviewTimeRange(result)) {
          preview.timeRange = {
            startSeconds: result.startSeconds,
            endSeconds: result.endSeconds
          };
        } else if (preview.leftPx !== requestLeftPx || preview.rightPx !== requestRightPx) {
        } else {
          preview.timeRange = null;
        }
        if (helper.state.cutPreview === preview) {
          updatePreviewElement();
        }
        return preview.timeRange;
      });
      preview.timeRangeRequest = request;
      return request;
    }
    async function ensurePreviewTimeRange(preview) {
      const cached = getPreviewTimeRange(preview, { allowAsync: false });
      if (cached) {
        return cached;
      }
      return await refreshPreviewTimeRange(preview, { force: true }) || null;
    }
    function getSelectionAudioElement() {
      const audio = document.querySelector("audio");
      return audio instanceof HTMLMediaElement ? audio : null;
    }
    function injectSelectionBridge() {
      if (bridgeInjected && window.__babelHelperMagnifierBridge) {
        return Promise.resolve(true);
      }
      if (bridgeLoadPromise) {
        return bridgeLoadPromise;
      }
      bridgeLoadPromise = new Promise((resolve) => {
        const parent = document.documentElement || document.head || document.body;
        if (!parent || typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") {
          bridgeLoadPromise = null;
          resolve(false);
          return;
        }
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH3);
        script.async = false;
        script.onload = () => {
          script.remove();
          bridgeInjected = true;
          resolve(true);
        };
        script.onerror = () => {
          script.remove();
          bridgeLoadPromise = null;
          resolve(false);
        };
        parent.appendChild(script);
      });
      return bridgeLoadPromise;
    }
    async function callSelectionBridge(operation, payload) {
      const ready = await injectSelectionBridge();
      if (!ready) {
        return null;
      }
      return new Promise((resolve) => {
        bridgeRequestId += 1;
        const id = "cut-loop-request-" + bridgeRequestId;
        let settled = false;
        const finish = (result) => {
          if (settled) {
            return;
          }
          settled = true;
          window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
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
        const timeoutId = window.setTimeout(() => finish(null), BRIDGE_TIMEOUT_MS);
        window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
        window.dispatchEvent(
          new CustomEvent(BRIDGE_REQUEST_EVENT, {
            detail: {
              id,
              operation,
              payload: payload || {}
            }
          })
        );
      });
    }
    function getWaveformHostFromContainer(container) {
      if (!(container instanceof HTMLElement) || typeof container.getRootNode !== "function") {
        return null;
      }
      const root = container.getRootNode();
      return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
    }
    function getWaveformRegistryFromHost(host) {
      let fiber = getReactFiber(host);
      if (!fiber && host instanceof HTMLElement) {
        fiber = getReactFiber(host.parentElement);
      }
      let owner = fiber;
      let ownerDepth = 0;
      while (owner && typeof owner === "object" && ownerDepth < 16) {
        let hook = owner.memoizedState;
        let hookIndex = 0;
        while (hook && typeof hook === "object" && hookIndex < 24) {
          const value = hook.memoizedState;
          const current = value && typeof value === "object" && !Array.isArray(value) && value.current ? value.current : null;
          if (current && typeof current === "object" && !Array.isArray(current)) {
            const keys = Object.keys(current);
            const hasWaveEntry = keys.some((key) => {
              const entry = current[key];
              return entry && typeof entry === "object" && entry.wavesurfer;
            });
            if (hasWaveEntry) {
              return current;
            }
          }
          hook = hook.next;
          hookIndex += 1;
        }
        owner = owner.return;
        ownerDepth += 1;
      }
      return null;
    }
    function getTrackIdForHost(host) {
      if (!(host instanceof HTMLElement)) {
        return null;
      }
      let fiber = getReactFiber(host);
      if (!fiber && host.parentElement instanceof HTMLElement) {
        fiber = getReactFiber(host.parentElement);
      }
      let owner = fiber;
      let ownerDepth = 0;
      while (owner && typeof owner === "object" && ownerDepth < 20) {
        const props = owner.memoizedProps;
        const track = props && typeof props === "object" && props.track && typeof props.track === "object" ? props.track : null;
        if (track && track.id != null) {
          return String(track.id);
        }
        owner = owner.return;
        ownerDepth += 1;
      }
      return null;
    }
    function getSpeakerKeyForContainer(container) {
      const host = getWaveformHostFromContainer(container);
      if (!(host instanceof HTMLElement)) {
        return "";
      }
      return getTrackIdForHost(host) || "";
    }
    function getWaveformEntryForContainer(container) {
      const host = getWaveformHostFromContainer(container);
      if (!(host instanceof HTMLElement)) {
        return null;
      }
      const registry = getWaveformRegistryFromHost(host);
      if (!registry || typeof registry !== "object") {
        return null;
      }
      const trackId = getTrackIdForHost(host);
      let wrapperMatch = null;
      let trackMatch = null;
      for (const key of Object.keys(registry)) {
        const entry = registry[key];
        const wavesurfer = entry && typeof entry === "object" && entry.wavesurfer ? entry.wavesurfer : null;
        if (!wavesurfer || typeof wavesurfer !== "object") {
          continue;
        }
        const wrapper = typeof wavesurfer.getWrapper === "function" ? wavesurfer.getWrapper() : null;
        const wrapperHost = wrapper && typeof wrapper.getRootNode === "function" ? wrapper.getRootNode().host : null;
        const containerMatches = wavesurfer.container === host || wavesurfer.container === container || wrapper === container || wrapperHost === host;
        const keyMatchesTrack = trackId && String(key) === trackId;
        if (containerMatches && keyMatchesTrack) {
          return entry;
        }
        if (containerMatches && !wrapperMatch) {
          wrapperMatch = entry;
        }
        if (keyMatchesTrack && !trackMatch) {
          trackMatch = entry;
        }
      }
      return wrapperMatch || trackMatch || null;
    }
    function getWaveformDurationSeconds(wavesurfer) {
      if (!wavesurfer || typeof wavesurfer !== "object") {
        return 0;
      }
      const direct = typeof wavesurfer.getDuration === "function" ? Number(wavesurfer.getDuration()) : NaN;
      if (Number.isFinite(direct) && direct > 0) {
        return direct;
      }
      const optionValue = Number(
        wavesurfer.options && typeof wavesurfer.options === "object" ? wavesurfer.options.duration : NaN
      );
      return Number.isFinite(optionValue) && optionValue > 0 ? optionValue : 0;
    }
    function getWaveformWrapperForEntry(entry, container) {
      const wavesurfer = entry && typeof entry === "object" && entry.wavesurfer ? entry.wavesurfer : null;
      const directWrapper = wavesurfer && typeof wavesurfer.getWrapper === "function" ? wavesurfer.getWrapper() : null;
      if (directWrapper instanceof HTMLElement) {
        return directWrapper;
      }
      const host = getWaveformHostFromContainer(container);
      const shadowWrapper = host && host.shadowRoot ? host.shadowRoot.querySelector('[part="wrapper"]') : null;
      return shadowWrapper instanceof HTMLElement ? shadowWrapper : null;
    }
    function getWaveformPixelsPerSecond(entry, container) {
      const wavesurfer = entry && typeof entry === "object" && entry.wavesurfer ? entry.wavesurfer : null;
      const renderer = wavesurfer && wavesurfer.renderer && typeof wavesurfer.renderer === "object" ? wavesurfer.renderer : null;
      const rendererWrapper = renderer && renderer.wrapper instanceof HTMLElement ? renderer.wrapper : null;
      const duration = getWaveformDurationSeconds(wavesurfer);
      const fullWidth = rendererWrapper instanceof HTMLElement ? Number(rendererWrapper.scrollWidth) || parsePixels(rendererWrapper.style.width || "") || Number(rendererWrapper.clientWidth) : NaN;
      if (Number.isFinite(fullWidth) && fullWidth > 0 && duration > 0) {
        return fullWidth / duration;
      }
      const optionValue = Number(
        wavesurfer && wavesurfer.options && typeof wavesurfer.options === "object" ? wavesurfer.options.minPxPerSec : NaN
      );
      if (Number.isFinite(optionValue) && optionValue > 0) {
        return optionValue;
      }
      return 0;
    }
    function getSelectionPlaybackTarget(preview) {
      const entry = getWaveformEntryForContainer(preview && preview.container);
      const wavesurfer = entry && typeof entry === "object" && entry.wavesurfer ? entry.wavesurfer : null;
      if (wavesurfer && typeof wavesurfer.getCurrentTime === "function" && typeof wavesurfer.setTime === "function") {
        return {
          kind: "wavesurfer",
          getCurrentTime() {
            const time = Number(wavesurfer.getCurrentTime());
            return Number.isFinite(time) ? time : null;
          },
          setTime(seconds) {
            wavesurfer.setTime(seconds);
          },
          play() {
            if (typeof wavesurfer.play === "function") {
              return wavesurfer.play();
            }
            return null;
          },
          playRange(startSeconds, endSeconds) {
            if (typeof wavesurfer.play === "function") {
              return wavesurfer.play(startSeconds, endSeconds);
            }
            wavesurfer.setTime(startSeconds);
            if (typeof wavesurfer.play === "function") {
              return wavesurfer.play();
            }
            return null;
          },
          isPaused() {
            if (typeof wavesurfer.isPlaying === "function") {
              return !wavesurfer.isPlaying();
            }
            if (wavesurfer.media && "paused" in wavesurfer.media) {
              return Boolean(wavesurfer.media.paused);
            }
            return false;
          }
        };
      }
      const audio = getSelectionAudioElement();
      if (!(audio instanceof HTMLMediaElement)) {
        return null;
      }
      return {
        kind: "audio",
        getCurrentTime() {
          const time = Number(audio.currentTime);
          return Number.isFinite(time) ? time : null;
        },
        setTime(seconds) {
          audio.currentTime = seconds;
        },
        play() {
          return typeof audio.play === "function" ? audio.play() : null;
        },
        playRange(startSeconds) {
          audio.currentTime = startSeconds;
          return typeof audio.play === "function" ? audio.play() : null;
        },
        isPaused() {
          return Boolean(audio.paused);
        }
      };
    }
    function updatePreviewElement() {
      const preview = helper.state.cutPreview;
      if (!preview || !(preview.element instanceof HTMLElement)) {
        return;
      }
      preview.element.style.left = preview.leftPx + "px";
      preview.element.style.width = Math.max(CUT_PREVIEW_MIN_WIDTH, preview.rightPx - preview.leftPx) + "px";
      const duration = getPreviewDurationSeconds(preview);
      const safetyMargin = getPreviewCommitSafetySeconds(preview);
      const requiredDuration = CUT_PREVIEW_MIN_SECONDS + safetyMargin;
      const label = preview.element.querySelector("[data-babel-helper-cut-label]");
      const tooShort = Number.isFinite(duration) && duration < requiredDuration;
      preview.element.style.background = tooShort ? "rgba(239, 68, 68, 0.18)" : "rgba(14, 165, 233, 0.16)";
      preview.element.style.borderColor = tooShort ? "rgba(220, 38, 38, 0.95)" : "rgba(2, 132, 199, 0.95)";
      if (label instanceof HTMLElement) {
        label.textContent = Number.isFinite(duration) ? duration.toFixed(2) + "s" : "Selection";
        label.style.background = tooShort ? "rgba(127, 29, 29, 0.92)" : "rgba(15, 23, 42, 0.82)";
      }
    }
    function clearCutDraft() {
      helper.state.cutDraft = null;
    }
    function rememberCutContainer(container) {
      if (container instanceof HTMLElement && container.isConnected) {
        helper.state.cutLastContainer = container;
      }
    }
    helper.stopSelectionLoop = function stopSelectionLoop() {
      const loop = helper.state.selectionLoop;
      if (!loop) {
        return;
      }
      if (loop.timer) {
        window.clearInterval(loop.timer);
      }
      if (loop.hostMarker) {
        void callSelectionBridge("loop-stop", {
          hostMarker: loop.hostMarker
        });
      }
      const activePreview = helper.state.cutPreview;
      const previewOwnsMarker = activePreview && activePreview.hostMarker && activePreview.hostMarker === loop.hostMarker;
      if (loop.host instanceof HTMLElement && loop.hostMarker && loop.host.getAttribute(SELECTION_LOOP_HOST_ATTR) === loop.hostMarker && !previewOwnsMarker) {
        loop.host.removeAttribute(SELECTION_LOOP_HOST_ATTR);
      }
      helper.state.selectionLoop = null;
    };
    helper.clearCutPreview = function clearCutPreview() {
      const preview = helper.state.cutPreview;
      helper.stopSelectionLoop();
      if (preview && preview.zoomObserver) {
        preview.zoomObserver.disconnect();
      }
      if (preview && preview.element && preview.element.isConnected) {
        preview.element.remove();
      }
      if (preview && preview.hostMarker) {
        const host = getWaveformHostFromContainer(preview.container);
        if (host instanceof HTMLElement && host.getAttribute(SELECTION_LOOP_HOST_ATTR) === preview.hostMarker) {
          host.removeAttribute(SELECTION_LOOP_HOST_ATTR);
        }
      }
      helper.state.cutPreview = null;
      helper.state.cutCommitPending = false;
      clearCutDraft();
    };
    helper.resetCutState = function resetCutState() {
      helper.state.smartSplitClickDraft = null;
      helper.state.smartSplitClickContext = null;
      helper.state.cutDraft = null;
      helper.state.cutLastContainer = null;
      helper.clearCutPreview();
    };
    helper.startSelectionLoop = async function startSelectionLoop() {
      const preview = helper.state.cutPreview;
      if (!preview || helper.state.cutCommitPending) {
        setSelectionLoopDebug(!preview ? "no-preview" : "commit-pending");
        return false;
      }
      const timeRange = await ensurePreviewTimeRange(preview);
      if (!timeRange) {
        setSelectionLoopDebug("no-time-range");
        return false;
      }
      const existing = helper.state.selectionLoop;
      if (existing && existing.preview === preview && Math.abs(existing.startSeconds - timeRange.startSeconds) < 0.01 && Math.abs(existing.endSeconds - timeRange.endSeconds) < 0.01) {
        setSelectionLoopDebug("toggle-off", {
          startSeconds: timeRange.startSeconds,
          endSeconds: timeRange.endSeconds,
          kind: existing.kind || "unknown"
        });
        helper.stopSelectionLoop();
        return true;
      }
      helper.stopSelectionLoop();
      const host = getWaveformHostFromContainer(preview.container);
      if (host instanceof HTMLElement) {
        const hostMarker = preview.hostMarker || ensureSelectionHostMarker(preview.container);
        if (!hostMarker) {
          return false;
        }
        preview.hostMarker = hostMarker;
        const bridgeResult = await callSelectionBridge("loop-start", {
          hostMarker,
          startSeconds: timeRange.startSeconds,
          endSeconds: timeRange.endSeconds
        });
        if (bridgeResult && bridgeResult.ok) {
          helper.state.selectionLoop = {
            preview,
            host,
            kind: "bridge",
            hostMarker,
            startSeconds: timeRange.startSeconds,
            endSeconds: timeRange.endSeconds,
            timer: null
          };
          setSelectionLoopDebug("started", {
            startSeconds: timeRange.startSeconds,
            endSeconds: timeRange.endSeconds,
            kind: "bridge"
          });
          return true;
        }
        if (bridgeResult && bridgeResult.reason) {
          setSelectionLoopDebug("bridge-" + bridgeResult.reason);
        } else {
          setSelectionLoopDebug("bridge-failed");
        }
      }
      const playback = getSelectionPlaybackTarget(preview);
      if (!playback) {
        setSelectionLoopDebug("no-playback");
        return false;
      }
      const loop = {
        preview,
        playback,
        kind: playback.kind || "unknown",
        startSeconds: timeRange.startSeconds,
        endSeconds: timeRange.endSeconds,
        lastTime: playback.getCurrentTime() || 0,
        internalSeekUntil: 0,
        timer: null
      };
      const runTick = () => {
        if (helper.state.selectionLoop !== loop) {
          return;
        }
        const activePreview = helper.state.cutPreview;
        if (!activePreview || activePreview !== preview) {
          setSelectionLoopDebug("lost-preview");
          helper.stopSelectionLoop();
          return;
        }
        const currentRange = getPreviewTimeRange(activePreview);
        if (!currentRange) {
          setSelectionLoopDebug("lost-range");
          helper.stopSelectionLoop();
          return;
        }
        loop.startSeconds = currentRange.startSeconds;
        loop.endSeconds = currentRange.endSeconds;
        const currentTime = loop.playback.getCurrentTime();
        if (!Number.isFinite(currentTime)) {
          return;
        }
        const now = Date.now();
        const delta = currentTime - loop.lastTime;
        if (now > loop.internalSeekUntil) {
          if (currentTime < loop.startSeconds - 0.08 || currentTime > loop.endSeconds + 0.08) {
            setSelectionLoopDebug("escaped-range", {
              currentTime,
              startSeconds: loop.startSeconds,
              endSeconds: loop.endSeconds,
              delta
            });
            helper.stopSelectionLoop();
            return;
          }
          if (delta < -0.08 || delta > 0.35) {
            setSelectionLoopDebug("user-move", {
              currentTime,
              startSeconds: loop.startSeconds,
              endSeconds: loop.endSeconds,
              delta
            });
            helper.stopSelectionLoop();
            return;
          }
        }
        if (currentTime >= loop.endSeconds - 0.03) {
          loop.internalSeekUntil = now + 220;
          const playResult2 = typeof loop.playback.playRange === "function" ? loop.playback.playRange(loop.startSeconds, loop.endSeconds) : (loop.playback.setTime(loop.startSeconds), loop.playback.play());
          if (playResult2 && typeof playResult2.catch === "function") {
            playResult2.catch(() => {
            });
          }
          loop.lastTime = loop.startSeconds;
          return;
        }
        loop.lastTime = currentTime;
      };
      if (!Number.isFinite(loop.lastTime) || loop.lastTime < loop.startSeconds || loop.lastTime > loop.endSeconds) {
        loop.internalSeekUntil = Date.now() + 220;
        loop.lastTime = loop.startSeconds;
      }
      const playResult = typeof loop.playback.playRange === "function" ? loop.playback.playRange(loop.startSeconds, loop.endSeconds) : (loop.playback.setTime(loop.startSeconds), loop.playback.play());
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => {
        });
      }
      loop.timer = window.setInterval(runTick, 40);
      helper.state.selectionLoop = loop;
      setSelectionLoopDebug("started", {
        startSeconds: loop.startSeconds,
        endSeconds: loop.endSeconds,
        kind: loop.playback.kind || "unknown"
      });
      return true;
    };
    function cancelCutPreviewIfZoomChanged() {
      const preview = helper.state.cutPreview;
      if (!preview || !preview.zoomSignature || !(preview.container instanceof HTMLElement)) {
        return false;
      }
      if (getLaneZoomSignature(preview.container) === preview.zoomSignature) {
        return false;
      }
      helper.clearCutPreview();
      return true;
    }
    function startCutPreviewZoomWatcher(preview) {
      if (!preview || !(preview.container instanceof HTMLElement)) {
        return;
      }
      const zoomSlider = getZoomSliderElement();
      if (!(zoomSlider instanceof HTMLElement) || typeof MutationObserver !== "function") {
        return;
      }
      const observer = new MutationObserver(() => {
        const activePreview = helper.state.cutPreview;
        if (!activePreview || activePreview !== preview || helper.state.cutCommitPending) {
          return;
        }
        if (activePreview.zoomSignature && getLaneZoomSignature(activePreview.container) !== activePreview.zoomSignature) {
          helper.clearCutPreview();
        }
      });
      observer.observe(zoomSlider, {
        attributes: true,
        attributeFilter: ["aria-valuenow", "style"]
      });
      preview.zoomObserver = observer;
    }
    function createPreviewFromDraft(draft, clientX) {
      const localX = clamp(clientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
      const startX = clamp(draft.startClientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
      const leftPx = Math.min(startX, localX);
      const rightPx = Math.max(startX, localX);
      const preview = document.createElement("div");
      preview.setAttribute(CUT_PREVIEW_ATTR, "true");
      preview.style.position = "absolute";
      preview.style.top = "0";
      preview.style.height = "100%";
      preview.style.boxSizing = "border-box";
      preview.style.border = "2px solid rgba(2, 132, 199, 0.95)";
      preview.style.borderRadius = "3px";
      preview.style.pointerEvents = "auto";
      preview.style.cursor = "default";
      preview.style.zIndex = "6";
      preview.style.touchAction = "none";
      const leftHandle = document.createElement("div");
      leftHandle.setAttribute(CUT_PREVIEW_HANDLE_ATTR, "left");
      leftHandle.style.position = "absolute";
      leftHandle.style.left = "0";
      leftHandle.style.top = "0";
      leftHandle.style.width = "8px";
      leftHandle.style.height = "100%";
      leftHandle.style.cursor = "ew-resize";
      const rightHandle = document.createElement("div");
      rightHandle.setAttribute(CUT_PREVIEW_HANDLE_ATTR, "right");
      rightHandle.style.position = "absolute";
      rightHandle.style.right = "0";
      rightHandle.style.top = "0";
      rightHandle.style.width = "8px";
      rightHandle.style.height = "100%";
      rightHandle.style.cursor = "ew-resize";
      const label = document.createElement("div");
      label.setAttribute("data-babel-helper-cut-label", "true");
      label.style.position = "absolute";
      label.style.left = "50%";
      label.style.top = "4px";
      label.style.transform = "translateX(-50%)";
      label.style.padding = "2px 6px";
      label.style.borderRadius = "999px";
      label.style.fontSize = "10px";
      label.style.fontWeight = "700";
      label.style.fontFamily = "ui-monospace, SFMono-Regular, Consolas, monospace";
      label.style.color = "#f8fafc";
      label.style.pointerEvents = "none";
      label.style.whiteSpace = "nowrap";
      const modeBadge = document.createElement("div");
      modeBadge.setAttribute("data-babel-helper-cut-mode", "true");
      modeBadge.textContent = "Selection";
      modeBadge.style.position = "absolute";
      modeBadge.style.left = "6px";
      modeBadge.style.top = "4px";
      modeBadge.style.padding = "2px 6px";
      modeBadge.style.borderRadius = "999px";
      modeBadge.style.fontSize = "10px";
      modeBadge.style.fontWeight = "700";
      modeBadge.style.fontFamily = "ui-monospace, SFMono-Regular, Consolas, monospace";
      modeBadge.style.color = "#e0f2fe";
      modeBadge.style.background = "rgba(3, 105, 161, 0.88)";
      modeBadge.style.pointerEvents = "none";
      modeBadge.style.whiteSpace = "nowrap";
      preview.appendChild(leftHandle);
      preview.appendChild(rightHandle);
      preview.appendChild(label);
      preview.appendChild(modeBadge);
      draft.container.appendChild(preview);
      rememberCutContainer(draft.container);
      const zoomSignature = getLaneZoomSignature(draft.container);
      const hostMarker = ensureSelectionHostMarker(draft.container);
      helper.state.cutPreview = {
        pointerId: draft.pointerId,
        sourceRegion: draft.sourceRegion,
        container: draft.container,
        containerRect: draft.containerRect,
        regionLeftPx: draft.regionLeftPx,
        regionRightPx: draft.regionRightPx,
        leftPx,
        rightPx,
        element: preview,
        zoomSignature,
        hostMarker,
        timeRange: null,
        timeRangeRequest: null,
        dragMode: "create",
        dragStartClientX: draft.startClientX,
        originLeftPx: leftPx,
        originRightPx: rightPx
      };
      clearCutDraft();
      startCutPreviewZoomWatcher(helper.state.cutPreview);
      updatePreviewElement();
      void refreshPreviewTimeRange(helper.state.cutPreview);
    }
    function beginPreviewDrag(event) {
      if (event.button !== 0) {
        if (event.button === 1) {
          const previewElement2 = getPreviewHostFromEvent(event);
          if (previewElement2 instanceof HTMLElement && helper.state.cutPreview) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }
        }
        return false;
      }
      const previewElement = getPreviewHostFromEvent(event);
      const preview = helper.state.cutPreview;
      if (!(previewElement instanceof HTMLElement) || !preview) {
        return false;
      }
      const previewRect = previewElement.getBoundingClientRect();
      const localX = event.clientX - previewRect.left;
      const nearLeftEdge = localX <= CUT_PREVIEW_HANDLE_HIT_WIDTH;
      const nearRightEdge = localX >= previewRect.width - CUT_PREVIEW_HANDLE_HIT_WIDTH;
      preview.pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      preview.dragStartClientX = event.clientX;
      preview.originLeftPx = preview.leftPx;
      preview.originRightPx = preview.rightPx;
      helper.stopSelectionLoop();
      if (nearLeftEdge && !nearRightEdge) {
        preview.dragMode = "resize-left";
      } else if (nearRightEdge) {
        preview.dragMode = "resize-right";
      } else {
        preview.dragMode = "locked";
      }
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    function updatePreviewDrag(event) {
      const preview = helper.state.cutPreview;
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      if (!preview || preview.pointerId !== pointerId || !preview.dragMode) {
        return false;
      }
      const dx = event.clientX - preview.dragStartClientX;
      preview.timeRange = null;
      preview.timeRangeRequest = null;
      const minWidth = CUT_PREVIEW_MIN_WIDTH;
      if (preview.dragMode === "create") {
        const currentX = clamp(
          event.clientX - preview.containerRect.left,
          preview.regionLeftPx,
          preview.regionRightPx
        );
        const startX = clamp(
          preview.dragStartClientX - preview.containerRect.left,
          preview.regionLeftPx,
          preview.regionRightPx
        );
        preview.leftPx = Math.min(startX, currentX);
        preview.rightPx = Math.max(preview.leftPx + minWidth, currentX);
        preview.rightPx = Math.min(preview.rightPx, preview.regionRightPx);
      } else if (preview.dragMode === "resize-left") {
        preview.leftPx = clamp(
          preview.originLeftPx + dx,
          preview.regionLeftPx,
          preview.rightPx - minWidth
        );
      } else if (preview.dragMode === "resize-right") {
        preview.rightPx = clamp(
          preview.originRightPx + dx,
          preview.leftPx + minWidth,
          preview.regionRightPx
        );
      } else if (preview.dragMode === "locked") {
      } else {
        return false;
      }
      updatePreviewElement();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    function endPreviewDrag(event) {
      const preview = helper.state.cutPreview;
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      if (!preview || preview.pointerId !== pointerId || !preview.dragMode) {
        return false;
      }
      preview.dragMode = null;
      void refreshPreviewTimeRange(preview, { force: true });
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    function getRegionDraft(event) {
      if (event.button !== 0 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return null;
      }
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      let sourceRegion = null;
      let container = null;
      for (const node of path) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        if (node.hasAttribute(CUT_PREVIEW_ATTR)) {
          return null;
        }
        if (getRegionHandleElement(node)) {
          return null;
        }
        if (!sourceRegion && isRegionBody(node)) {
          sourceRegion = node;
          if (node.parentElement instanceof HTMLElement) {
            container = node.parentElement;
          }
        }
        if (!container && getRegionElements(node).length) {
          container = node;
        }
        if (!container && helper.state.cutLastContainer instanceof HTMLElement && (node === helper.state.cutLastContainer || helper.state.cutLastContainer.contains(node))) {
          container = helper.state.cutLastContainer;
        }
      }
      if (!(container instanceof HTMLElement)) {
        return null;
      }
      const containerRect = container.getBoundingClientRect();
      if (containerRect.width <= 0) {
        return null;
      }
      rememberCutContainer(container);
      return {
        pointerId: typeof event.pointerId === "number" ? event.pointerId : 1,
        sourceRegion,
        container,
        containerRect,
        regionLeftPx: 0,
        regionRightPx: containerRect.width,
        startClientX: clamp(event.clientX, containerRect.left, containerRect.right)
      };
    }
    function dispatchSplitClick(target, clientX, clientY) {
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const useMeta = /\bMac\b/i.test(navigator.platform || "");
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          button: 0,
          buttons: 0,
          detail: 1,
          ctrlKey: !useMeta,
          metaKey: useMeta
        })
      );
    }
    function getRegionElements(container) {
      if (!(container instanceof HTMLElement)) {
        return [];
      }
      return Array.from(container.children).filter((child) => isRegionBody(child));
    }
    function getRegionBounds(region, containerRect) {
      if (!(region instanceof HTMLElement)) {
        return null;
      }
      const rect = region.getBoundingClientRect();
      return {
        region,
        rect,
        leftPx: rect.left - containerRect.left,
        rightPx: rect.right - containerRect.left,
        startText: getRegionTimeText(region, ".wavesurfer-region-tooltip-start"),
        endText: getRegionTimeText(region, ".wavesurfer-region-tooltip-end")
      };
    }
    function collectRegionSnapshot(container) {
      const containerRect = container instanceof HTMLElement ? container.getBoundingClientRect() : null;
      if (!containerRect || containerRect.width <= 0) {
        return null;
      }
      const bounds = getRegionElements(container).map((region) => getRegionBounds(region, containerRect)).filter(Boolean).sort((left, right) => left.leftPx - right.leftPx);
      if (!bounds.length) {
        return null;
      }
      return {
        containerRect,
        bounds
      };
    }
    function getSnapshotSignature(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.bounds)) {
        return "";
      }
      return snapshot.bounds.map((entry) => {
        const left = Math.round(entry.leftPx * 10) / 10;
        const right = Math.round(entry.rightPx * 10) / 10;
        return left + ":" + right;
      }).join("|");
    }
    async function waitForRegionRefresh(container, previousSignature) {
      const updated = await helper.waitFor(() => {
        const snapshot = collectRegionSnapshot(container);
        if (!snapshot) {
          return null;
        }
        return getSnapshotSignature(snapshot) !== previousSignature ? snapshot : null;
      }, 900, 40);
      return updated || collectRegionSnapshot(container);
    }
    function collectOverlapPlan(snapshot, cutLeftPx, cutRightPx) {
      if (!snapshot || !Array.isArray(snapshot.bounds) || !snapshot.bounds.length) {
        return null;
      }
      const tolerance = 1;
      const overlapping = snapshot.bounds.filter((entry) => entry.rightPx > cutLeftPx + tolerance && entry.leftPx < cutRightPx - tolerance);
      if (!overlapping.length) {
        return {
          overlapping: [],
          toDelete: [],
          trimLeft: null,
          trimRight: null,
          splitRequired: false,
          splitRegion: null
        };
      }
      let trimLeft = null;
      let trimRight = null;
      let splitRegion = null;
      const toDelete = [];
      for (const entry of overlapping) {
        const coversLeft = entry.leftPx < cutLeftPx - tolerance && entry.rightPx > cutLeftPx + tolerance;
        const coversRight = entry.leftPx < cutRightPx - tolerance && entry.rightPx > cutRightPx + tolerance;
        const fullyInside = entry.leftPx >= cutLeftPx - tolerance && entry.rightPx <= cutRightPx + tolerance;
        if (coversLeft && coversRight) {
          splitRegion = entry;
        } else if (coversLeft) {
          trimLeft = entry;
        } else if (coversRight) {
          trimRight = entry;
        } else if (fullyInside) {
          toDelete.push(entry);
        }
      }
      return {
        overlapping,
        toDelete,
        trimLeft,
        trimRight,
        splitRequired: Boolean(splitRegion),
        splitRegion
      };
    }
    function findReconciliationTargets(snapshot, cutLeftPx, cutRightPx, options) {
      const settings = options || {};
      const includePrevious = settings.includePrevious !== false;
      const includeNext = settings.includeNext !== false;
      const containerRect = snapshot && snapshot.containerRect ? snapshot.containerRect : settings.containerRect || null;
      if (!containerRect) {
        return null;
      }
      const bounds = snapshot && Array.isArray(snapshot.bounds) ? snapshot.bounds : [];
      let previous = null;
      let next = null;
      if (includePrevious) {
        for (const entry of bounds) {
          if (entry.leftPx >= cutLeftPx - 1) {
            continue;
          }
          if (!previous || entry.rightPx > previous.rightPx) {
            previous = entry;
          }
        }
      }
      if (includeNext) {
        for (const entry of bounds) {
          if (entry.rightPx <= cutRightPx + 1) {
            continue;
          }
          next = entry;
          break;
        }
      }
      return {
        containerRect,
        previous,
        next
      };
    }
    function getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex, options) {
      const rows = helper.getTranscriptRows();
      if (!rows.length || sourceRowIndex < 0 || sourceRowIndex >= rows.length) {
        return null;
      }
      const settings = options || {};
      const sourceSpeakerKey = typeof settings.speakerKey === "string" && settings.speakerKey || helper.getRowSpeakerKey(sourceRow);
      const pairMatchesSpeaker = (leftRow2, rightRow2) => {
        if (!(leftRow2 instanceof HTMLTableRowElement) || !(rightRow2 instanceof HTMLTableRowElement)) {
          return false;
        }
        if (!helper.rowsShareSpeaker(leftRow2, rightRow2)) {
          return false;
        }
        return !sourceSpeakerKey || helper.getRowSpeakerKey(leftRow2) === sourceSpeakerKey;
      };
      let leftRow = null;
      for (let index = Math.min(sourceRowIndex, rows.length - 1); index >= 0; index -= 1) {
        const candidate = rows[index];
        if (candidate instanceof HTMLTableRowElement && (!sourceSpeakerKey || helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)) {
          leftRow = candidate;
          break;
        }
      }
      let rightRow = null;
      for (let index = Math.max(0, sourceRowIndex + 1); index < rows.length; index += 1) {
        const candidate = rows[index];
        if (candidate instanceof HTMLTableRowElement && (!sourceSpeakerKey || helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)) {
          rightRow = candidate;
          break;
        }
      }
      if (!pairMatchesSpeaker(leftRow, rightRow)) {
        return null;
      }
      return {
        leftRow,
        rightRow
      };
    }
    async function waitForSmartSplitRows(sourceRow, sourceRowIndex, previousRowCount, options) {
      if (sourceRowIndex < 0 || !Number.isFinite(previousRowCount)) {
        return null;
      }
      return helper.waitFor(() => {
        const rows = helper.getTranscriptRows();
        if (rows.length < previousRowCount + 1) {
          return null;
        }
        return getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex, options);
      }, 1200, 40);
    }
    function captureRowSnapshot() {
      return helper.getTranscriptRows().map((row) => {
        const labels = getRowTimeLabels(row) || {
          startText: "",
          endText: ""
        };
        return {
          row,
          speakerKey: helper.getRowSpeakerKey(row),
          startText: labels.startText,
          endText: labels.endText,
          text: helper.getRowTextValue(row).trim()
        };
      });
    }
    function getRowSignature(entry) {
      if (!entry) {
        return "";
      }
      return [entry.speakerKey || "", entry.startText || "", entry.endText || "", entry.text || ""].join("|");
    }
    function findNewDuplicateSplitRows(previousRows, options) {
      const previousList = Array.isArray(previousRows) ? previousRows : [];
      const previousSignatures = new Set(previousList.map((entry) => getRowSignature(entry)));
      const settings = options || {};
      const speakerKey = typeof settings.speakerKey === "string" && settings.speakerKey ? settings.speakerKey : "";
      const rows = speakerKey ? helper.getTranscriptRows().filter((row) => helper.getRowSpeakerKey(row) === speakerKey) : helper.getTranscriptRows();
      for (let index = 0; index < rows.length - 1; index += 1) {
        const leftRow = rows[index];
        const rightRow = rows[index + 1];
        if (!helper.rowsShareSpeaker(leftRow, rightRow)) {
          continue;
        }
        const pairSpeakerKey = helper.getRowSpeakerKey(leftRow);
        if (speakerKey && pairSpeakerKey !== speakerKey) {
          continue;
        }
        const leftText = helper.getRowTextValue(leftRow).trim();
        const rightText = helper.getRowTextValue(rightRow).trim();
        if (!leftText || leftText !== rightText) {
          continue;
        }
        const leftLabels = getRowTimeLabels(leftRow);
        const rightLabels = getRowTimeLabels(rightRow);
        const leftSignature = getRowSignature({
          speakerKey: pairSpeakerKey,
          startText: leftLabels ? leftLabels.startText : "",
          endText: leftLabels ? leftLabels.endText : "",
          text: leftText
        });
        const rightSignature = getRowSignature({
          speakerKey: pairSpeakerKey,
          startText: rightLabels ? rightLabels.startText : "",
          endText: rightLabels ? rightLabels.endText : "",
          text: rightText
        });
        if (previousSignatures.has(leftSignature) && previousSignatures.has(rightSignature)) {
          continue;
        }
        const leftRange = getRowTimeRange(leftRow);
        const rightRange = getRowTimeRange(rightRow);
        if (!leftRange || !rightRange) {
          continue;
        }
        const leftDuration = leftRange.endSeconds - leftRange.startSeconds;
        const rightDuration = rightRange.endSeconds - rightRange.startSeconds;
        const totalDuration = leftDuration + rightDuration;
        if (!(leftDuration > 0) || !(rightDuration > 0) || !(totalDuration > 0)) {
          continue;
        }
        return {
          leftRow,
          rightRow,
          speakerKey: pairSpeakerKey,
          sourceText: leftText,
          ratio: leftDuration / totalDuration
        };
      }
      return null;
    }
    async function applySmartSplitFromDuplicateRows(context) {
      if (!context || !Number.isFinite(context.rowCount)) {
        return false;
      }
      const detected = await helper.waitFor(() => {
        const rows = helper.getTranscriptRows();
        if (rows.length < context.rowCount + 1) {
          return null;
        }
        return findNewDuplicateSplitRows(context.rows, {
          speakerKey: context.speakerKey
        });
      }, 1200, 40);
      if (!detected) {
        return false;
      }
      return helper.applySmartSplitToRows(
        detected.leftRow,
        detected.rightRow,
        detected.sourceText,
        detected.ratio
      );
    }
    async function waitForSmartSplitTextReady(rows, sourceText) {
      if (!rows || !sourceText) {
        return null;
      }
      return helper.waitFor(() => {
        const leftText = helper.getRowTextValue(rows.leftRow).trim();
        const rightText = helper.getRowTextValue(rows.rightRow).trim();
        if (!leftText && !rightText) {
          return null;
        }
        if (leftText === sourceText || rightText === sourceText || leftText === rightText) {
          return {
            leftText,
            rightText,
            duplicated: true
          };
        }
        return {
          leftText,
          rightText,
          duplicated: false
        };
      }, 800, 40);
    }
    async function applySmartSplit(plan) {
      if (!plan || !plan.sourceText) {
        return false;
      }
      const rows = await waitForSmartSplitRows(plan.sourceRow, plan.sourceRowIndex, plan.rowCount, {
        speakerKey: plan.speakerKey,
        sourceSpeakerIndex: plan.sourceSpeakerIndex
      });
      if (!rows) {
        return false;
      }
      const parts = helper.splitTextByWordRatio(plan.sourceText, plan.ratio);
      if (!parts.wordCount) {
        return false;
      }
      const readyState = await waitForSmartSplitTextReady(rows, plan.sourceText);
      if (readyState && readyState.duplicated) {
        await helper.sleep(80);
      }
      const applyOnce = () => helper.applySmartSplitToRows(rows.leftRow, rows.rightRow, plan.sourceText, plan.ratio);
      if (!applyOnce()) {
        return false;
      }
      await helper.sleep(140);
      const leftCurrent = helper.getRowTextValue(rows.leftRow).trim();
      const rightCurrent = helper.getRowTextValue(rows.rightRow).trim();
      if (leftCurrent !== parts.firstText || rightCurrent !== parts.secondText) {
        return applyOnce();
      }
      return true;
    }
    function buildSmartSplitPlanForRegion(entry, pivotPx, container) {
      if (!entry) {
        return null;
      }
      const speakerKey = getSpeakerKeyForContainer(container);
      let sourceRow = findRowByTimeLabels(entry.startText, entry.endText, {
        speakerKey
      });
      if (!(sourceRow instanceof HTMLTableRowElement) && container instanceof HTMLElement) {
        const laneTimeScale = getLaneTimeScale(container);
        if (laneTimeScale && Number.isFinite(laneTimeScale.secondsPerPx) && laneTimeScale.secondsPerPx > 0) {
          const startSeconds = laneTimeScale.offsetSeconds + entry.leftPx * laneTimeScale.secondsPerPx;
          const endSeconds = laneTimeScale.offsetSeconds + entry.rightPx * laneTimeScale.secondsPerPx;
          sourceRow = findRowByTimeRange(startSeconds, endSeconds, {
            speakerKey
          });
        }
      }
      if (!(sourceRow instanceof HTMLTableRowElement)) {
        return null;
      }
      const rows = helper.getTranscriptRows();
      const sourceRowIndex = rows.indexOf(sourceRow);
      if (sourceRowIndex < 0) {
        return null;
      }
      const sameSpeakerRows = speakerKey ? rows.filter((row) => helper.getRowSpeakerKey(row) === speakerKey) : rows;
      const sourceSpeakerIndex = sameSpeakerRows.indexOf(sourceRow);
      const sourceText = helper.getRowTextValue(sourceRow).trim();
      if (!sourceText) {
        return null;
      }
      const width = entry.rightPx - entry.leftPx;
      const ratio = width > 0 ? clamp((pivotPx - entry.leftPx) / width, 0, 1) : 0.5;
      return {
        sourceRow,
        sourceRowIndex,
        sourceSpeakerIndex,
        rowCount: rows.length,
        speakerKey,
        sourceText,
        pivotPx,
        ratio
      };
    }
    function getHandle(region, side) {
      if (!(region instanceof HTMLElement)) {
        return null;
      }
      const selector = side === "left" ? '[part~="region-handle-left"]' : '[part~="region-handle-right"]';
      const handle = region.querySelector(selector);
      return handle instanceof HTMLElement ? handle : null;
    }
    async function dragHandleToClientX(handle, targetClientX) {
      if (!(handle instanceof HTMLElement) || !handle.isConnected) {
        return false;
      }
      const rect = handle.getBoundingClientRect();
      const startClientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const doc = handle.ownerDocument;
      const base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientY,
        button: 0
      };
      if (typeof PointerEvent === "function") {
        handle.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...base,
            clientX: startClientX,
            buttons: 1,
            pointerId: 1,
            pointerType: "mouse"
          })
        );
      }
      handle.dispatchEvent(
        new MouseEvent("mousedown", {
          ...base,
          clientX: startClientX,
          buttons: 1
        })
      );
      await helper.sleep(16);
      if (typeof PointerEvent === "function") {
        doc.dispatchEvent(
          new PointerEvent("pointermove", {
            ...base,
            clientX: targetClientX,
            buttons: 1,
            pointerId: 1,
            pointerType: "mouse"
          })
        );
      }
      doc.dispatchEvent(
        new MouseEvent("mousemove", {
          ...base,
          clientX: targetClientX,
          buttons: 1
        })
      );
      await helper.sleep(16);
      if (typeof PointerEvent === "function") {
        doc.dispatchEvent(
          new PointerEvent("pointerup", {
            ...base,
            clientX: targetClientX,
            buttons: 0,
            pointerId: 1,
            pointerType: "mouse"
          })
        );
      }
      doc.dispatchEvent(
        new MouseEvent("mouseup", {
          ...base,
          clientX: targetClientX,
          buttons: 0
        })
      );
      return true;
    }
    helper.commitCutPreview = async function commitCutPreview(options) {
      const preview = helper.state.cutPreview;
      if (!preview || helper.state.cutCommitPending) {
        return false;
      }
      helper.stopSelectionLoop();
      const settings = options || {};
      const useSmartSplit = Boolean(settings.smartSplit);
      if (cancelCutPreviewIfZoomChanged()) {
        return false;
      }
      const timeRange = await ensurePreviewTimeRange(preview);
      const duration = timeRange && Number.isFinite(timeRange.startSeconds) && Number.isFinite(timeRange.endSeconds) && timeRange.endSeconds > timeRange.startSeconds ? timeRange.endSeconds - timeRange.startSeconds : null;
      const safetyMargin = getPreviewCommitSafetySeconds(preview);
      const requiredDuration = CUT_PREVIEW_MIN_SECONDS + safetyMargin;
      if (!Number.isFinite(duration) || duration < requiredDuration) {
        return false;
      }
      const commitPlan = {
        container: preview.container,
        containerRect: preview.container instanceof HTMLElement ? preview.container.getBoundingClientRect() : preview.containerRect,
        leftPx: preview.leftPx,
        rightPx: preview.rightPx
      };
      const containerRect = commitPlan.containerRect;
      if (!(commitPlan.container instanceof HTMLElement) || containerRect.width <= 0) {
        return false;
      }
      const beforeSnapshot = collectRegionSnapshot(commitPlan.container);
      const initialOverlapPlan = collectOverlapPlan(beforeSnapshot, commitPlan.leftPx, commitPlan.rightPx);
      if (!beforeSnapshot || !initialOverlapPlan || !initialOverlapPlan.overlapping.length) {
        return false;
      }
      const smartSplitPlan = useSmartSplit && initialOverlapPlan.splitRequired && initialOverlapPlan.overlapping.length === 1 && initialOverlapPlan.splitRegion ? buildSmartSplitPlanForRegion(
        initialOverlapPlan.splitRegion,
        (commitPlan.leftPx + commitPlan.rightPx) / 2,
        commitPlan.container
      ) : null;
      const smartSplitFallbackContext = useSmartSplit && initialOverlapPlan.splitRequired && initialOverlapPlan.overlapping.length === 1 ? {
        rowCount: helper.getTranscriptRows().length,
        speakerKey: getSpeakerKeyForContainer(commitPlan.container),
        rows: captureRowSnapshot()
      } : null;
      const previewElement = preview.element instanceof HTMLElement ? preview.element : null;
      const originalOpacity = previewElement ? previewElement.style.opacity : "";
      if (previewElement) {
        previewElement.style.pointerEvents = "none";
        previewElement.style.opacity = "0.72";
      }
      helper.state.cutCommitPending = true;
      try {
        const liveContainerRect = commitPlan.container.getBoundingClientRect();
        if (initialOverlapPlan.splitRequired) {
          const splitClientX = liveContainerRect.left + commitPlan.leftPx;
          const splitClientY = liveContainerRect.top + liveContainerRect.height / 2;
          const splitTarget = initialOverlapPlan.splitRegion ? initialOverlapPlan.splitRegion.region : null;
          if (!(splitTarget instanceof HTMLElement) || !splitTarget.isConnected) {
            return false;
          }
          dispatchSplitClick(splitTarget, splitClientX, splitClientY);
        }
        const deleteTargets = initialOverlapPlan.toDelete.slice();
        for (const entry of deleteTargets) {
          const deleted = await deleteRegionByTimeLabels(entry.startText, entry.endText, {
            speakerKey: getSpeakerKeyForContainer(commitPlan.container)
          });
          if (!deleted) {
            return false;
          }
          await helper.sleep(80);
        }
        const shouldTrimPrevious = Boolean(initialOverlapPlan.trimLeft || initialOverlapPlan.splitRequired);
        const shouldTrimNext = Boolean(initialOverlapPlan.trimRight || initialOverlapPlan.splitRequired);
        const refreshedSnapshot = initialOverlapPlan.splitRequired || deleteTargets.length ? await waitForRegionRefresh(
          commitPlan.container,
          getSnapshotSignature(beforeSnapshot)
        ) : collectRegionSnapshot(commitPlan.container);
        const overlapPlan = collectOverlapPlan(refreshedSnapshot, commitPlan.leftPx, commitPlan.rightPx);
        if ((shouldTrimPrevious || shouldTrimNext) && (!overlapPlan || !refreshedSnapshot)) {
          return false;
        }
        const liveSnapshot = findReconciliationTargets(
          refreshedSnapshot,
          commitPlan.leftPx,
          commitPlan.rightPx,
          {
            includePrevious: shouldTrimPrevious,
            includeNext: shouldTrimNext,
            containerRect: refreshedSnapshot ? refreshedSnapshot.containerRect : commitPlan.container.getBoundingClientRect()
          }
        );
        if (!liveSnapshot || !liveSnapshot.containerRect) {
          return false;
        }
        if (shouldTrimPrevious && !liveSnapshot.previous || shouldTrimNext && !liveSnapshot.next) {
          return false;
        }
        const targetStartClientX = liveSnapshot.containerRect.left + commitPlan.leftPx;
        const targetEndClientX = liveSnapshot.containerRect.left + commitPlan.rightPx;
        if (shouldTrimPrevious && liveSnapshot.previous) {
          const previousRightHandle = getHandle(liveSnapshot.previous.region, "right");
          if (!(previousRightHandle instanceof HTMLElement)) {
            return false;
          }
          const movedPrevious = await dragHandleToClientX(previousRightHandle, targetStartClientX);
          if (!movedPrevious) {
            return false;
          }
          await helper.sleep(48);
        }
        if (shouldTrimNext && liveSnapshot.next) {
          const nextLeftHandle = getHandle(liveSnapshot.next.region, "left");
          if (!(nextLeftHandle instanceof HTMLElement)) {
            return false;
          }
          const movedNext = await dragHandleToClientX(nextLeftHandle, targetEndClientX);
          if (!movedNext) {
            return false;
          }
        }
        if (smartSplitPlan) {
          await helper.sleep(64);
          void applySmartSplit(smartSplitPlan);
        } else if (smartSplitFallbackContext) {
          await helper.sleep(64);
          void applySmartSplitFromDuplicateRows(smartSplitFallbackContext);
        }
        helper.clearCutPreview();
        return true;
      } finally {
        helper.state.cutCommitPending = false;
        const currentPreview = helper.state.cutPreview;
        if (currentPreview && currentPreview.element === previewElement && previewElement) {
          previewElement.style.pointerEvents = "auto";
          previewElement.style.opacity = originalOpacity;
        }
      }
    };
    helper.handleCutPreviewKeydown = function handleCutPreviewKeydown(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return false;
        }
      }
      if (!helper.state.cutPreview) {
        if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === "KeyL") {
          setSelectionLoopDebug("no-preview-key");
        }
        return false;
      }
      if (cancelCutPreviewIfZoomChanged()) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (helper.state.cutCommitPending) {
        if (event.key === "Escape" || event.key.toLowerCase() === "s" || event.key.toLowerCase() === "l" || event.key === "Delete" || event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
        return false;
      }
      if (event.key === "Escape") {
        helper.clearCutPreview();
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === "KeyS") {
        event.preventDefault();
        event.stopPropagation();
        void helper.commitCutPreview({
          smartSplit: true
        });
        return true;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && event.code === "KeyS") {
        event.preventDefault();
        event.stopPropagation();
        void helper.commitCutPreview();
        return true;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === "KeyL") {
        event.preventDefault();
        event.stopPropagation();
        void helper.startSelectionLoop();
        return true;
      }
      if (event.key === "Delete" || event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    };
    function handlePointerDown(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return;
        }
      }
      if (helper.state.cutCommitPending) {
        return;
      }
      captureSmartSplitClickDraft(event);
      if (beginPreviewDrag(event)) {
        return;
      }
      const draft = getRegionDraft(event);
      if (!draft) {
        return;
      }
      if (helper.state.cutPreview) {
        helper.clearCutPreview();
      }
      helper.state.cutDraft = draft;
      event.preventDefault();
      event.stopPropagation();
    }
    function handlePointerMove(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return;
        }
      }
      if (helper.state.cutCommitPending) {
        return;
      }
      if (updatePreviewDrag(event)) {
        return;
      }
      const draft = helper.state.cutDraft;
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      if (!draft || draft.pointerId !== pointerId) {
        return;
      }
      const currentX = clamp(event.clientX, draft.containerRect.left, draft.containerRect.right);
      if (Math.abs(currentX - draft.startClientX) < CUT_PREVIEW_DRAG_THRESHOLD) {
        return;
      }
      createPreviewFromDraft(draft, currentX);
      event.preventDefault();
      event.stopPropagation();
    }
    function handlePointerEnd(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return;
        }
      }
      if (helper.state.cutCommitPending) {
        return;
      }
      if (endPreviewDrag(event)) {
        return;
      }
      const draft = helper.state.cutDraft;
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      if (draft && draft.pointerId === pointerId) {
        clearCutDraft();
        event.preventDefault();
        event.stopPropagation();
      }
    }
    function getSmartSplitClickDraft(event) {
      if (!isSmartSplitClickEvent(event)) {
        return null;
      }
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      let sourceRegion = null;
      let container = null;
      for (const node of path) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        if (node.hasAttribute(CUT_PREVIEW_ATTR)) {
          return null;
        }
        if (!sourceRegion && isRegionHandle(node)) {
          const owningRegion = getOwningRegionBody(node);
          if (owningRegion) {
            sourceRegion = owningRegion;
            if (owningRegion.parentElement instanceof HTMLElement) {
              container = owningRegion.parentElement;
            }
          }
          continue;
        }
        if (!sourceRegion && isRegionBody(node)) {
          sourceRegion = node;
          if (node.parentElement instanceof HTMLElement) {
            container = node.parentElement;
          }
        }
        if (!container && getRegionElements(node).length) {
          container = node;
        }
        if (!container && node instanceof HTMLElement && node.parentElement instanceof HTMLElement && getRegionElements(node.parentElement).length) {
          container = node.parentElement;
        }
      }
      if (!(container instanceof HTMLElement) && helper.state.cutLastContainer instanceof HTMLElement && helper.state.cutLastContainer.isConnected) {
        container = helper.state.cutLastContainer;
      }
      if (!(container instanceof HTMLElement)) {
        return null;
      }
      const snapshot = collectRegionSnapshot(container);
      if (!snapshot) {
        return null;
      }
      const localX = clamp(event.clientX - snapshot.containerRect.left, 0, snapshot.containerRect.width);
      let entry = sourceRegion instanceof HTMLElement ? snapshot.bounds.find((candidate) => candidate.region === sourceRegion) || null : null;
      if (!entry) {
        const tolerance = 2;
        entry = snapshot.bounds.find(
          (candidate) => localX >= candidate.leftPx - tolerance && localX <= candidate.rightPx + tolerance
        ) || null;
      }
      if (!entry) {
        let bestEntry = null;
        let bestDistance = Infinity;
        for (const candidate of snapshot.bounds) {
          const center = (candidate.leftPx + candidate.rightPx) / 2;
          const distance = Math.abs(center - localX);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestEntry = candidate;
          }
        }
        entry = bestEntry;
      }
      if (!entry) {
        return null;
      }
      const pivotPx = clamp(localX, entry.leftPx, entry.rightPx);
      return buildSmartSplitPlanForRegion(entry, pivotPx, container);
    }
    function captureSmartSplitClickDraft(event) {
      if (!isSmartSplitClickEvent(event)) {
        helper.state.smartSplitClickDraft = null;
        helper.state.smartSplitClickContext = null;
        return null;
      }
      const draft = getSmartSplitClickDraft(event);
      helper.state.smartSplitClickContext = {
        rowCount: helper.getTranscriptRows().length,
        speakerKey: draft && typeof draft.speakerKey === "string" && draft.speakerKey || getSpeakerKeyForContainer(helper.state.cutLastContainer),
        rows: captureRowSnapshot()
      };
      helper.state.smartSplitClickDraft = draft || null;
      return draft;
    }
    function handleSmartSplitClick(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return;
        }
      }
      if (helper.state.cutCommitPending) {
        return;
      }
      const context = helper.state.smartSplitClickContext;
      const draft = (isSmartSplitClickEvent(event) ? helper.state.smartSplitClickDraft : null) || getSmartSplitClickDraft(event);
      helper.state.smartSplitClickDraft = null;
      helper.state.smartSplitClickContext = null;
      if (!draft) {
        if (isSmartSplitClickEvent(event)) {
          if (context) {
            void applySmartSplitFromDuplicateRows(context);
          }
        }
        return;
      }
      void applySmartSplit(draft);
    }
    helper.bindCutPreview = function bindCutPreview() {
      if (helper.state.cutListenersBound) {
        return;
      }
      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("pointermove", handlePointerMove, true);
      document.addEventListener("pointerup", handlePointerEnd, true);
      document.addEventListener("pointercancel", handlePointerEnd, true);
      document.addEventListener("click", handleSmartSplitClick, true);
      helper.state.cutListenersBound = true;
    };
    helper.unbindCutPreview = function unbindCutPreview() {
      if (!helper.state.cutListenersBound) {
        return;
      }
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("pointerup", handlePointerEnd, true);
      document.removeEventListener("pointercancel", handlePointerEnd, true);
      document.removeEventListener("click", handleSmartSplitClick, true);
      helper.state.cutListenersBound = false;
    };
  }

  // src/services/magnifier-service.ts
  function registerMagnifierService(helper) {
    if (!helper || helper.__magnifierRegistered) {
      return;
    }
    helper.__magnifierRegistered = true;
    const MAGNIFIER_ATTR = "data-babel-helper-magnifier";
    const HOST_MARKER_ATTR = "data-babel-helper-magnifier-host";
    const MOUNT_MARKER_ATTR = "data-babel-helper-magnifier-mount";
    const BRIDGE_REQUEST_EVENT = "babel-helper-magnifier-request";
    const BRIDGE_RESPONSE_EVENT = "babel-helper-magnifier-response";
    const BRIDGE_SCRIPT_PATH3 = "dist/content/magnifier-bridge.js";
    const SCALE = 3;
    const WIDTH = 180;
    const MAX_HEIGHT = 150;
    const INSET = 6;
    const BRIDGE_TIMEOUT_MS = 700;
    let bridgeInjected = false;
    let bridgeLoadPromise = null;
    let bridgeRequestId = 0;
    let markerId = 0;
    helper.state.magnifier = null;
    helper.state.magnifierDrag = null;
    helper.config.hotkeysHelpRows.unshift([
      "Drag Segment Edge",
      `Show ${SCALE}x waveform magnifier while trimming`
    ]);
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }
    function nextMarker(prefix) {
      markerId += 1;
      return prefix + "-" + Date.now() + "-" + markerId;
    }
    function parseSeconds(value) {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const normalized = trimmed.toLowerCase();
      const timestampMatch = normalized.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
      if (timestampMatch) {
        const parts = timestampMatch[0].split(":");
        let total2 = 0;
        for (const part of parts) {
          const numeric2 = Number(part);
          if (!Number.isFinite(numeric2)) {
            return null;
          }
          total2 = total2 * 60 + numeric2;
        }
        return total2;
      }
      let total = 0;
      let foundUnit = false;
      const unitPattern = /(-?\d+(?:\.\d+)?)\s*([hms])/g;
      for (const match of normalized.matchAll(unitPattern)) {
        const numeric2 = Number(match[1]);
        if (!Number.isFinite(numeric2)) {
          return null;
        }
        foundUnit = true;
        const unit = match[2];
        if (unit === "h") {
          total += numeric2 * 3600;
        } else if (unit === "m") {
          total += numeric2 * 60;
        } else {
          total += numeric2;
        }
      }
      if (foundUnit) {
        return total;
      }
      const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
      if (!numericMatch) {
        return null;
      }
      const numeric = Number(numericMatch[0]);
      return Number.isFinite(numeric) ? numeric : null;
    }
    function getPartTokens(element) {
      const part = element instanceof Element ? element.getAttribute("part") : "";
      return part ? part.split(/\s+/).filter(Boolean) : [];
    }
    function getHandleSide(element) {
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      const tokens = getPartTokens(element);
      if (tokens.includes("region-handle-left") || tokens.includes("region-handle") && tokens.includes("region-handle-left")) {
        return "left";
      }
      if (tokens.includes("region-handle-right") || tokens.includes("region-handle") && tokens.includes("region-handle-right")) {
        return "right";
      }
      return null;
    }
    function getOwningRegion(element) {
      let current = element instanceof HTMLElement ? element : null;
      while (current instanceof HTMLElement) {
        const tokens = getPartTokens(current);
        if (tokens.includes("region")) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }
    function isWaveformScope(scope) {
      if (!scope || typeof scope.querySelector !== "function") {
        return false;
      }
      return Boolean(
        scope.querySelector('[part="regions-container"]') && scope.querySelector('[part="hover"]') && scope.querySelector('[part="wrapper"]') && scope.querySelector('[part="scroll"]')
      );
    }
    function getWaveformScopeFromNode(node) {
      let current = node instanceof HTMLElement ? node : null;
      while (current instanceof HTMLElement) {
        if (current.shadowRoot && isWaveformScope(current.shadowRoot)) {
          return current.shadowRoot;
        }
        if (isWaveformScope(current)) {
          return current;
        }
        current = current.parentElement;
      }
      const root = node && typeof node.getRootNode === "function" ? node.getRootNode() : null;
      if (root instanceof ShadowRoot && isWaveformScope(root)) {
        return root;
      }
      return null;
    }
    function getWaveformContextFromEvent(event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const node of path) {
        const scope = getWaveformScopeFromNode(node);
        if (!scope) {
          continue;
        }
        const container = scope.querySelector('[part="regions-container"]');
        const host = scope instanceof ShadowRoot ? scope.host : null;
        if (container instanceof HTMLElement && host instanceof HTMLElement) {
          return {
            scope,
            container,
            host
          };
        }
      }
      return null;
    }
    function getHoverData(scope, containerRect) {
      if (!scope || typeof scope.querySelector !== "function") {
        return null;
      }
      const hover = scope.querySelector('[part="hover"]');
      if (!(hover instanceof HTMLElement) || !hover.isConnected) {
        return null;
      }
      const transform = hover.style.transform || "";
      const match = transform.match(/translateX\((-?\d+(?:\.\d+)?)px\)/i);
      if (!match) {
        return null;
      }
      const hoverStyle = window.getComputedStyle(hover);
      if (Number(hoverStyle.opacity || "1") <= 0) {
        return null;
      }
      const label = hover.querySelector('[part="hover-label"]');
      const text = helper.normalizeText(label);
      const timeSeconds = parseSeconds(text);
      if (!Number.isFinite(timeSeconds)) {
        return null;
      }
      return {
        x: clamp(Number(match[1]), 0, containerRect.width),
        text,
        timeSeconds
      };
    }
    function getRegionBoundaryTime(region, side) {
      if (!(region instanceof HTMLElement)) {
        return null;
      }
      const selector = side === "left" ? ".wavesurfer-region-tooltip-start" : ".wavesurfer-region-tooltip-end";
      const node = region.querySelector(selector);
      const text = helper.normalizeText(node);
      const timeSeconds = parseSeconds(text);
      if (!Number.isFinite(timeSeconds)) {
        return null;
      }
      return {
        text,
        timeSeconds
      };
    }
    function getDragContextFromEvent(event) {
      if (!event || event.button !== 0) {
        return null;
      }
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const node of path) {
        const side = getHandleSide(node);
        if (!side) {
          continue;
        }
        const handle = node instanceof HTMLElement ? node : null;
        const region = getOwningRegion(handle);
        const waveform = getWaveformContextFromEvent(event);
        if (handle instanceof HTMLElement && region instanceof HTMLElement && waveform) {
          return {
            pointerId: typeof event.pointerId === "number" ? event.pointerId : 1,
            handle,
            region,
            side,
            scope: waveform.scope,
            container: waveform.container,
            host: waveform.host
          };
        }
      }
      return null;
    }
    function getDragData(drag, containerRect) {
      if (!drag || !(drag.handle instanceof HTMLElement) || !(drag.region instanceof HTMLElement) || !(drag.container instanceof HTMLElement) || !drag.handle.isConnected || !drag.region.isConnected) {
        return null;
      }
      const rect = drag.handle.getBoundingClientRect();
      const x = clamp(rect.left + rect.width / 2 - containerRect.left, 0, containerRect.width);
      const boundary = getRegionBoundaryTime(drag.region, drag.side);
      if (boundary) {
        return {
          x,
          text: boundary.text,
          timeSeconds: boundary.timeSeconds
        };
      }
      const hover = getHoverData(drag.scope, containerRect);
      if (hover) {
        return {
          x,
          text: hover.text,
          timeSeconds: hover.timeSeconds
        };
      }
      return null;
    }
    function injectBridge3() {
      if (window.__babelHelperMagnifierBridge) {
        bridgeInjected = true;
        return Promise.resolve(true);
      }
      if (bridgeInjected) {
        return Promise.resolve(true);
      }
      if (bridgeLoadPromise) {
        return bridgeLoadPromise;
      }
      bridgeLoadPromise = new Promise((resolve) => {
        const parent = document.documentElement || document.head || document.body;
        if (!parent || typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") {
          bridgeLoadPromise = null;
          resolve(false);
          return;
        }
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH3);
        script.async = false;
        script.onload = () => {
          script.remove();
          bridgeInjected = true;
          resolve(true);
        };
        script.onerror = () => {
          script.remove();
          bridgeLoadPromise = null;
          resolve(false);
        };
        parent.appendChild(script);
      });
      return bridgeLoadPromise;
    }
    async function callBridge(operation, payload) {
      const ready = await injectBridge3();
      if (!ready) {
        return null;
      }
      return new Promise((resolve) => {
        bridgeRequestId += 1;
        const id = "request-" + bridgeRequestId;
        let settled = false;
        const finish = (result) => {
          if (settled) {
            return;
          }
          settled = true;
          window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
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
        const timeoutId = window.setTimeout(
          () => finish(null),
          BRIDGE_TIMEOUT_MS
        );
        window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
        window.dispatchEvent(
          new CustomEvent(BRIDGE_REQUEST_EVENT, {
            detail: {
              id,
              operation,
              payload: payload || {}
            }
          })
        );
      });
    }
    function setStatus(magnifier, text) {
      if (magnifier && magnifier.badge instanceof HTMLElement) {
        magnifier.badge.textContent = text;
      }
    }
    function renderRegions(magnifier, entries, windowStart, windowEnd, width, height) {
      if (!(magnifier.regionsLayer instanceof HTMLElement)) {
        return;
      }
      magnifier.regionsLayer.replaceChildren();
      const span = windowEnd - windowStart;
      if (!(span > 0)) {
        return;
      }
      for (const entry of entries) {
        const visibleStart = Math.max(windowStart, entry.start);
        const visibleEnd = Math.min(windowEnd, entry.end);
        if (visibleEnd <= visibleStart) {
          continue;
        }
        const region = document.createElement("div");
        region.style.position = "absolute";
        region.style.top = "0";
        region.style.left = (visibleStart - windowStart) / span * width + "px";
        region.style.width = Math.max(2, (visibleEnd - visibleStart) / span * width) + "px";
        region.style.height = height + "px";
        region.style.boxSizing = "border-box";
        region.style.pointerEvents = "none";
        region.style.borderRadius = entry.borderRadius;
        region.style.backgroundColor = entry.backgroundColor;
        region.style.borderLeft = entry.borderLeft;
        region.style.borderRight = entry.borderRight;
        region.style.filter = entry.filter;
        magnifier.regionsLayer.appendChild(region);
      }
    }
    function createMagnifier(context) {
      const element = document.createElement("div");
      element.setAttribute(MAGNIFIER_ATTR, "true");
      element.style.position = "absolute";
      element.style.top = INSET + "px";
      element.style.left = INSET + "px";
      element.style.width = WIDTH + "px";
      element.style.height = "80px";
      element.style.zIndex = "9";
      element.style.pointerEvents = "none";
      element.style.overflow = "hidden";
      element.style.border = "1px solid rgba(15, 23, 42, 0.78)";
      element.style.borderRadius = "6px";
      element.style.background = "rgba(255, 255, 255, 0.98)";
      element.style.boxShadow = "0 10px 20px rgba(15, 23, 42, 0.20)";
      const viewport = document.createElement("div");
      viewport.style.position = "absolute";
      viewport.style.inset = "0";
      viewport.style.pointerEvents = "none";
      viewport.style.overflow = "hidden";
      element.appendChild(viewport);
      const mount = document.createElement("div");
      mount.style.position = "absolute";
      mount.style.inset = "0";
      mount.style.pointerEvents = "none";
      viewport.appendChild(mount);
      const regionsLayer = document.createElement("div");
      regionsLayer.style.position = "absolute";
      regionsLayer.style.inset = "0";
      regionsLayer.style.pointerEvents = "none";
      regionsLayer.style.zIndex = "3";
      viewport.appendChild(regionsLayer);
      const badge = document.createElement("div");
      badge.style.position = "absolute";
      badge.style.left = "6px";
      badge.style.top = "5px";
      badge.style.padding = "2px 6px";
      badge.style.borderRadius = "999px";
      badge.style.fontSize = "10px";
      badge.style.fontWeight = "700";
      badge.style.lineHeight = "1.2";
      badge.style.fontFamily = "ui-monospace, SFMono-Regular, Consolas, monospace";
      badge.style.color = "#e2e8f0";
      badge.style.background = "rgba(15, 23, 42, 0.82)";
      badge.style.zIndex = "5";
      badge.textContent = `${SCALE}x`;
      element.appendChild(badge);
      context.container.appendChild(element);
      const hostMarker = nextMarker("host");
      const mountMarker = nextMarker("mount");
      context.host.setAttribute(HOST_MARKER_ATTR, hostMarker);
      mount.setAttribute(MOUNT_MARKER_ATTR, mountMarker);
      return {
        scope: context.scope,
        container: context.container,
        host: context.host,
        element,
        mount,
        regionsLayer,
        badge,
        hostMarker,
        mountMarker,
        bridgeInstanceId: null,
        syncPending: false,
        syncQueued: false
      };
    }
    async function disposeMagnifier(magnifier) {
      if (!magnifier) {
        return;
      }
      if (magnifier.bridgeInstanceId) {
        await callBridge("destroy", {
          instanceId: magnifier.bridgeInstanceId
        });
      }
    }
    helper.clearMagnifier = function clearMagnifier() {
      const magnifier = helper.state.magnifier;
      if (!magnifier) {
        return;
      }
      void disposeMagnifier(magnifier);
      if (magnifier.host instanceof HTMLElement) {
        magnifier.host.removeAttribute(HOST_MARKER_ATTR);
      }
      if (magnifier.mount instanceof HTMLElement) {
        magnifier.mount.removeAttribute(MOUNT_MARKER_ATTR);
      }
      if (magnifier.element instanceof HTMLElement && magnifier.element.isConnected) {
        magnifier.element.remove();
      }
      helper.state.magnifier = null;
    };
    function ensureMagnifier(context) {
      const current = helper.state.magnifier;
      if (current && current.scope === context.scope && current.container === context.container && current.host === context.host && current.element instanceof HTMLElement && current.element.isConnected) {
        return current;
      }
      helper.clearMagnifier();
      const next = createMagnifier(context);
      helper.state.magnifier = next;
      return next;
    }
    async function syncMagnifier(magnifier) {
      if (!magnifier || helper.state.magnifier !== magnifier) {
        return;
      }
      if (magnifier.syncPending) {
        magnifier.syncQueued = true;
        return;
      }
      magnifier.syncPending = true;
      try {
        if (!(magnifier.container instanceof HTMLElement) || !(magnifier.host instanceof HTMLElement) || !(magnifier.mount instanceof HTMLElement) || !magnifier.container.isConnected || !magnifier.host.isConnected || !magnifier.mount.isConnected) {
          return;
        }
        const containerRect = magnifier.container.getBoundingClientRect();
        const drag = helper.state.magnifierDrag;
        const target = getDragData(drag, containerRect);
        if (!target || containerRect.width <= 0 || containerRect.height <= 0) {
          setStatus(magnifier, `${SCALE} waiting`);
          return;
        }
        const width = Math.min(
          WIDTH,
          Math.max(80, Math.round(containerRect.width - INSET * 2))
        );
        const height = Math.max(
          48,
          Math.min(MAX_HEIGHT, Math.round(containerRect.height - INSET * 2))
        );
        const left = clamp(
          target.x - width / 2,
          INSET,
          Math.max(INSET, containerRect.width - width - INSET)
        );
        magnifier.element.style.left = left + "px";
        magnifier.element.style.top = INSET + "px";
        magnifier.element.style.width = width + "px";
        magnifier.element.style.height = height + "px";
        if (!magnifier.bridgeInstanceId) {
          const ensureResult = await callBridge("ensure", {
            hostMarker: magnifier.hostMarker,
            mountMarker: magnifier.mountMarker,
            height,
            scale: SCALE
          });
          if (!ensureResult || !ensureResult.ok || !ensureResult.id) {
            setStatus(magnifier, `${SCALE} unavailable`);
            return;
          }
          magnifier.bridgeInstanceId = ensureResult.id;
        }
        let updateResult = await callBridge("update", {
          instanceId: magnifier.bridgeInstanceId,
          time: target.timeSeconds,
          width,
          height,
          scale: SCALE
        });
        if ((!updateResult || !updateResult.ok) && magnifier.bridgeInstanceId) {
          await callBridge("destroy", {
            instanceId: magnifier.bridgeInstanceId
          });
          magnifier.bridgeInstanceId = null;
          const retryEnsure = await callBridge("ensure", {
            hostMarker: magnifier.hostMarker,
            mountMarker: magnifier.mountMarker,
            height,
            scale: SCALE
          });
          if (retryEnsure && retryEnsure.ok && retryEnsure.id) {
            magnifier.bridgeInstanceId = retryEnsure.id;
            updateResult = await callBridge("update", {
              instanceId: magnifier.bridgeInstanceId,
              time: target.timeSeconds,
              width,
              height,
              scale: SCALE
            });
          }
        }
        if (!updateResult || !updateResult.ok) {
          setStatus(magnifier, `${SCALE} unavailable`);
          return;
        }
        setStatus(magnifier, `${SCALE}x @ ` + target.text);
        renderRegions(
          magnifier,
          Array.isArray(updateResult.regions) ? updateResult.regions : [],
          Number(updateResult.windowStart) || 0,
          Number(updateResult.windowEnd) || 0,
          width,
          height
        );
      } finally {
        if (!magnifier || helper.state.magnifier !== magnifier) {
          return;
        }
        magnifier.syncPending = false;
        if (magnifier.syncQueued) {
          magnifier.syncQueued = false;
          void syncMagnifier(magnifier);
        }
      }
    }
    function showMagnifier(context) {
      const magnifier = ensureMagnifier(context);
      void syncMagnifier(magnifier);
    }
    function handlePointerDown(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return;
        }
      }
      const drag = getDragContextFromEvent(event);
      helper.state.magnifierDrag = drag;
      if (drag) {
        showMagnifier(drag);
      }
    }
    function handlePointerMove(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return;
        }
      }
      const drag = helper.state.magnifierDrag;
      if (!drag) {
        return;
      }
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      if (drag.pointerId !== pointerId) {
        return;
      }
      if (!event.buttons) {
        helper.state.magnifierDrag = null;
        helper.clearMagnifier();
        return;
      }
      showMagnifier(drag);
    }
    function handlePointerEnd(event) {
      if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
        if (!helper.runtime.isSessionInteractive()) {
          return;
        }
      }
      const drag = helper.state.magnifierDrag;
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
      if (drag && drag.pointerId === pointerId) {
        helper.state.magnifierDrag = null;
        helper.clearMagnifier();
      }
    }
    helper.bindMagnifier = function bindMagnifier() {
      if (helper.state.magnifierListenersBound) {
        return;
      }
      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("pointermove", handlePointerMove, true);
      document.addEventListener("pointerup", handlePointerEnd, true);
      document.addEventListener("pointercancel", handlePointerEnd, true);
      helper.state.magnifierListenersBound = true;
    };
    helper.unbindMagnifier = function unbindMagnifier() {
      if (!helper.state.magnifierListenersBound) {
        return;
      }
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("pointerup", handlePointerEnd, true);
      document.removeEventListener("pointercancel", handlePointerEnd, true);
      helper.state.magnifierListenersBound = false;
    };
  }

  // src/services/minimap-service.ts
  function registerMinimapService(helper) {
    if (!helper || helper.__minimapRegistered) {
      return;
    }
    helper.__minimapRegistered = true;
    const MINIMAP_ATTR = "data-babel-helper-minimap";
    const HOST_ATTR = "data-babel-helper-minimap-host";
    const BRIDGE_REQUEST_EVENT = "babel-helper-magnifier-request";
    const BRIDGE_RESPONSE_EVENT = "babel-helper-magnifier-response";
    const BRIDGE_SCRIPT_PATH3 = "dist/content/magnifier-bridge.js";
    const BRIDGE_TIMEOUT_MS = 700;
    const MINIMAP_HEIGHT = 44;
    const MINIMAP_MAX_TRACKS = 2;
    const MUTATION_DEBOUNCE_MS = 220;
    let bridgeInjected = false;
    let bridgeLoadPromise = null;
    let bridgeRequestId = 0;
    let markerId = 0;
    helper.state.minimap = null;
    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }
    function nextMarker(prefix) {
      markerId += 1;
      return prefix + "-" + Date.now() + "-" + markerId;
    }
    function injectBridge3() {
      if (window.__babelHelperMagnifierBridge) {
        bridgeInjected = true;
        return Promise.resolve(true);
      }
      if (bridgeInjected) {
        return Promise.resolve(true);
      }
      if (bridgeLoadPromise) {
        return bridgeLoadPromise;
      }
      bridgeLoadPromise = new Promise((resolve) => {
        const parent = document.documentElement || document.head || document.body;
        if (!parent || typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getURL !== "function") {
          bridgeLoadPromise = null;
          resolve(false);
          return;
        }
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH3);
        script.async = false;
        script.onload = () => {
          script.remove();
          bridgeInjected = true;
          resolve(true);
        };
        script.onerror = () => {
          script.remove();
          bridgeLoadPromise = null;
          resolve(false);
        };
        parent.appendChild(script);
      });
      return bridgeLoadPromise;
    }
    async function callBridge(operation, payload) {
      const ready = await injectBridge3();
      if (!ready) {
        return null;
      }
      return new Promise((resolve) => {
        bridgeRequestId += 1;
        const id = "minimap-request-" + bridgeRequestId;
        let settled = false;
        const finish = (result) => {
          if (settled) {
            return;
          }
          settled = true;
          window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
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
        const timeoutId = window.setTimeout(() => finish(null), BRIDGE_TIMEOUT_MS);
        window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
        window.dispatchEvent(
          new CustomEvent(BRIDGE_REQUEST_EVENT, {
            detail: {
              id,
              operation,
              payload: payload || {}
            }
          })
        );
      });
    }
    function discoverWaveformHosts() {
      return Array.from(document.querySelectorAll("div")).filter((node) => {
        if (!(node instanceof HTMLDivElement) || !(node.shadowRoot instanceof ShadowRoot) || !helper.isVisible(node)) {
          return false;
        }
        const wrapper = node.shadowRoot.querySelector('[part="wrapper"]');
        const scroll = node.shadowRoot.querySelector('[part="scroll"]');
        return Boolean(
          wrapper instanceof HTMLElement && scroll instanceof HTMLElement && helper.isVisible(scroll)
        );
      });
    }
    function resolveWaveformHosts() {
      const stamped = Array.from(document.querySelectorAll("div[" + HOST_ATTR + "]")).filter((node) => {
        if (!(node instanceof HTMLDivElement) || !node.isConnected || !helper.isVisible(node)) {
          return false;
        }
        if (!(node.shadowRoot instanceof ShadowRoot)) {
          return false;
        }
        const wrapper = node.shadowRoot.querySelector('[part="wrapper"]');
        const scroll = node.shadowRoot.querySelector('[part="scroll"]');
        return Boolean(
          wrapper instanceof HTMLElement && scroll instanceof HTMLElement && helper.isVisible(scroll)
        );
      });
      if (stamped.length) {
        return stamped.slice(0, MINIMAP_MAX_TRACKS);
      }
      return discoverWaveformHosts().slice(0, MINIMAP_MAX_TRACKS);
    }
    function getScrollElement(host) {
      if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) {
        return null;
      }
      const scroll = host.shadowRoot.querySelector('[part="scroll"]');
      return scroll instanceof HTMLElement ? scroll : null;
    }
    function findPlaceholder() {
      const toolbar = document.querySelector(".flex.w-full.items-center.justify-start.gap-2");
      if (!(toolbar instanceof HTMLElement)) {
        return null;
      }
      const existing = toolbar.querySelector("[" + MINIMAP_ATTR + "]");
      if (existing instanceof HTMLElement) {
        return existing;
      }
      const minimap = document.createElement("div");
      minimap.setAttribute(MINIMAP_ATTR, "true");
      minimap.style.position = "relative";
      minimap.style.flex = "1 1 0";
      minimap.style.minWidth = "180px";
      minimap.style.height = MINIMAP_HEIGHT + "px";
      minimap.style.boxSizing = "border-box";
      minimap.style.border = "1px solid #cbd5e1";
      minimap.style.borderRadius = "6px";
      minimap.style.overflow = "hidden";
      minimap.style.background = "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)";
      minimap.style.cursor = "pointer";
      minimap.style.userSelect = "none";
      minimap.style.touchAction = "none";
      minimap.style.minHeight = MINIMAP_HEIGHT + "px";
      minimap.style.alignSelf = "stretch";
      toolbar.appendChild(minimap);
      return minimap;
    }
    function createTrackLane() {
      const lane = document.createElement("div");
      lane.style.position = "absolute";
      lane.style.left = "0";
      lane.style.width = "100%";
      lane.style.boxSizing = "border-box";
      lane.style.overflow = "hidden";
      lane.style.pointerEvents = "none";
      const tint = document.createElement("div");
      tint.style.position = "absolute";
      tint.style.inset = "0";
      tint.style.background = "rgba(148, 163, 184, 0.08)";
      lane.appendChild(tint);
      const waveform = document.createElement("canvas");
      waveform.style.position = "absolute";
      waveform.style.inset = "0";
      waveform.style.width = "100%";
      waveform.style.height = "100%";
      waveform.style.pointerEvents = "none";
      waveform.style.zIndex = "1";
      waveform.style.display = "block";
      lane.appendChild(waveform);
      const regions = document.createElement("div");
      regions.style.position = "absolute";
      regions.style.inset = "0";
      regions.style.pointerEvents = "none";
      regions.style.zIndex = "2";
      lane.appendChild(regions);
      return {
        lane,
        waveform,
        regions
      };
    }
    function layoutTrackLanes(minimap, count) {
      const lanes = minimap.lanes;
      const visibleCount = Math.max(1, Math.min(count || 1, lanes.length));
      const laneHeight = 100 / visibleCount;
      for (let index = 0; index < lanes.length; index += 1) {
        const lane = lanes[index];
        if (index >= visibleCount) {
          lane.lane.style.display = "none";
          lane.regions.replaceChildren();
          if (lane.waveform instanceof HTMLCanvasElement) {
            const ctx = lane.waveform.getContext("2d");
            if (ctx) {
              ctx.clearRect(0, 0, lane.waveform.width, lane.waveform.height);
            }
          }
          continue;
        }
        lane.lane.style.display = "block";
        lane.lane.style.top = index * laneHeight + "%";
        lane.lane.style.height = laneHeight + "%";
        lane.lane.style.borderTop = index === 0 ? "0" : "1px solid rgba(148, 163, 184, 0.28)";
      }
    }
    function renderRegions(regionRoot, entries, duration) {
      regionRoot.replaceChildren();
      if (!(duration > 0) || !Array.isArray(entries) || !entries.length) {
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const entry of entries) {
        const start = Number(entry && entry.start);
        const end = Number(entry && entry.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          continue;
        }
        const left = clamp(start / duration * 100, 0, 100);
        const width = clamp((end - start) / duration * 100, 0.35, 100);
        const region = document.createElement("div");
        region.style.position = "absolute";
        region.style.left = left + "%";
        region.style.top = "3px";
        region.style.bottom = "3px";
        region.style.width = width + "%";
        region.style.minWidth = "1px";
        region.style.boxSizing = "border-box";
        region.style.borderRadius = entry.borderRadius || "2px";
        region.style.backgroundColor = entry.backgroundColor || "rgba(176, 131, 255, 0.25)";
        region.style.opacity = "0.7";
        region.style.borderLeft = entry.borderLeft || "";
        region.style.borderRight = entry.borderRight || "";
        region.style.filter = entry.filter || "";
        fragment.appendChild(region);
      }
      regionRoot.appendChild(fragment);
    }
    function drawMinimapWaveform(canvas, peaks) {
      if (!(canvas instanceof HTMLCanvasElement)) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w) {
        canvas.width = w;
      }
      if (canvas.height !== h) {
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.clearRect(0, 0, w, h);
      if (!Array.isArray(peaks) || !peaks.length) {
        return;
      }
      let maxP = 0;
      for (let i = 0; i < peaks.length; i += 1) {
        const v = Math.abs(Number(peaks[i]) || 0);
        if (v > maxP) {
          maxP = v;
        }
      }
      const scale = maxP > 0 ? 1 / maxP : 1;
      const mid = h / 2;
      const n = peaks.length;
      const barW = w / n;
      ctx.fillStyle = "rgba(71, 85, 105, 0.55)";
      for (let i = 0; i < n; i += 1) {
        const amp = Math.min(1, Math.abs(Number(peaks[i]) || 0) * scale) * mid * 0.9;
        const x = i * barW;
        ctx.fillRect(x, mid - amp, Math.max(1, barW + 0.5), amp * 2);
      }
    }
    function setViewport(minimap, leftRatio, widthRatio) {
      if (!(widthRatio > 0)) {
        minimap.viewport.style.display = "none";
        return;
      }
      minimap.viewport.style.display = "block";
      minimap.viewport.style.left = clamp(leftRatio * 100, 0, 100) + "%";
      minimap.viewport.style.width = clamp(widthRatio * 100, 0, 100) + "%";
    }
    function setPlayhead(minimap, time, duration) {
      minimap.playhead.style.display = "none";
    }
    function clearRender(minimap) {
      minimap.fullSyncOk = false;
      layoutTrackLanes(minimap, 1);
      minimap.viewport.style.display = "none";
      minimap.playhead.style.display = "none";
      for (const lane of minimap.lanes) {
        lane.regions.replaceChildren();
        if (lane.waveform instanceof HTMLCanvasElement) {
          const ctx = lane.waveform.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, lane.waveform.width, lane.waveform.height);
          }
        }
      }
    }
    function ensureContainer(minimap) {
      const container = findPlaceholder();
      if (!(container instanceof HTMLElement)) {
        return false;
      }
      if (minimap.container !== container) {
        minimap.container = container;
        container.replaceChildren();
        container.appendChild(minimap.surface);
        if (minimap.resizeObserver) {
          minimap.resizeObserver.disconnect();
          minimap.resizeObserver.observe(container);
        }
        minimap.hostSignature = "";
      }
      return true;
    }
    function scheduleSync(minimap = helper.state.minimap) {
      if (!minimap || minimap.destroyed) {
        return;
      }
      if (minimap.rafId) {
        return;
      }
      minimap.rafId = window.requestAnimationFrame(() => {
        minimap.rafId = 0;
        void syncMinimap(minimap);
      });
    }
    function scheduleViewportUpdate(minimap = helper.state.minimap) {
      if (!minimap || minimap.destroyed) {
        return;
      }
      if (!minimap.fullSyncOk) {
        scheduleSync(minimap);
        return;
      }
      if (minimap.viewportRafId) {
        return;
      }
      minimap.viewportRafId = window.requestAnimationFrame(() => {
        minimap.viewportRafId = 0;
        void updateMinimapViewportOnly(minimap);
      });
    }
    async function updateMinimapViewportOnly(minimap) {
      if (!minimap || minimap.destroyed || !minimap.fullSyncOk) {
        return;
      }
      if (minimap.syncPending) {
        return;
      }
      if (!ensureContainer(minimap)) {
        return;
      }
      if (!minimap.hostMarkers[0]) {
        scheduleSync(minimap);
        return;
      }
      minimap.syncPending = true;
      try {
        const hostMarker = minimap.hostMarkers[0];
        const result = await callBridge("minimap-data", {
          hostMarker,
          viewportOnly: true
        });
        if (!result || !result.ok) {
          minimap.fullSyncOk = false;
          scheduleSync(minimap);
          return;
        }
        const duration = Number(result.duration) || 0;
        if (minimap.duration > 0 && duration > 0 && Math.abs(duration - minimap.duration) > 1) {
          scheduleSync(minimap);
          return;
        }
        const totalWidth = Number(result.totalWidth) || 0;
        const visibleWidth = Number(result.visibleWidth) || 0;
        const scrollLeft = Number(result.scrollLeft) || 0;
        if (totalWidth > 0 && visibleWidth > 0) {
          const leftRatio = scrollLeft / totalWidth;
          const widthRatio = visibleWidth / totalWidth;
          setViewport(minimap, leftRatio, widthRatio);
        } else {
          minimap.viewport.style.display = "none";
        }
        setPlayhead(minimap, Number(result.currentTime) || 0, duration || minimap.duration);
      } catch (_error) {
        minimap.fullSyncOk = false;
        scheduleSync(minimap);
      } finally {
        minimap.syncPending = false;
        if (minimap.syncQueued) {
          minimap.syncQueued = false;
          scheduleSync(minimap);
        }
      }
    }
    function disconnectHostObservers(minimap) {
      for (const dispose of minimap.scrollDisposers) {
        dispose();
      }
      minimap.scrollDisposers = [];
      if (minimap.resizeObserver) {
        minimap.resizeObserver.disconnect();
        minimap.resizeObserver.observe(minimap.container);
      }
    }
    function bindHostObservers(minimap, hosts) {
      const signature = hosts.map((host, index) => {
        const marker = host.getAttribute(HOST_ATTR) || nextMarker("minimap-host-" + index);
        host.setAttribute(HOST_ATTR, marker);
        return marker;
      }).join("|");
      if (signature === minimap.hostSignature) {
        return;
      }
      minimap.hostSignature = signature;
      minimap.hostMarkers = hosts.map((host) => host.getAttribute(HOST_ATTR) || "");
      disconnectHostObservers(minimap);
      for (const host of hosts) {
        const scroll = getScrollElement(host);
        if (scroll instanceof HTMLElement) {
          const onScroll = () => scheduleViewportUpdate(minimap);
          scroll.addEventListener("scroll", onScroll, { passive: true });
          minimap.scrollDisposers.push(() => {
            scroll.removeEventListener("scroll", onScroll);
          });
          if (minimap.resizeObserver) {
            minimap.resizeObserver.observe(scroll);
          }
        }
        if (minimap.resizeObserver) {
          minimap.resizeObserver.observe(host);
        }
      }
    }
    function createMinimap() {
      const container = findPlaceholder();
      if (!(container instanceof HTMLElement)) {
        return null;
      }
      const surface = document.createElement("div");
      surface.style.position = "absolute";
      surface.style.inset = "0";
      surface.style.pointerEvents = "auto";
      surface.style.overflow = "hidden";
      const lanes = [];
      for (let index = 0; index < MINIMAP_MAX_TRACKS; index += 1) {
        const lane = createTrackLane();
        surface.appendChild(lane.lane);
        lanes.push(lane);
      }
      const viewport = document.createElement("div");
      viewport.style.position = "absolute";
      viewport.style.top = "0";
      viewport.style.bottom = "0";
      viewport.style.left = "0";
      viewport.style.width = "0";
      viewport.style.display = "none";
      viewport.style.pointerEvents = "none";
      viewport.style.background = "rgba(14, 165, 233, 0.12)";
      viewport.style.border = "1px solid rgba(2, 132, 199, 0.9)";
      viewport.style.boxSizing = "border-box";
      viewport.style.zIndex = "5";
      surface.appendChild(viewport);
      const playhead = document.createElement("div");
      playhead.style.position = "absolute";
      playhead.style.top = "0";
      playhead.style.bottom = "0";
      playhead.style.width = "2px";
      playhead.style.marginLeft = "-1px";
      playhead.style.display = "none";
      playhead.style.background = "#ef4444";
      playhead.style.boxShadow = "0 0 0 1px rgba(255, 255, 255, 0.7)";
      playhead.style.pointerEvents = "none";
      playhead.style.zIndex = "6";
      surface.appendChild(playhead);
      const state = {
        container,
        surface,
        lanes,
        viewport,
        playhead,
        syncPending: false,
        syncQueued: false,
        rafId: 0,
        destroyed: false,
        hostSignature: "",
        hostMarkers: [],
        scrollDisposers: [],
        pointerActive: false,
        duration: 0,
        navigatePendingTime: null,
        navigateInFlight: false,
        resizeObserver: null,
        mutationObserver: null,
        onWindowResize: null,
        viewportRafId: 0,
        fullSyncOk: false,
        mutationDebounceTimer: 0
      };
      container.replaceChildren();
      container.appendChild(surface);
      const updateFromPointer = (event) => {
        const rect = state.container.getBoundingClientRect();
        if (!(rect.width > 0) || !(state.duration > 0) || !state.hostMarkers[0]) {
          return;
        }
        const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        queueNavigate(state, ratio * state.duration);
      };
      surface.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        state.pointerActive = true;
        if (typeof surface.setPointerCapture === "function") {
          try {
            surface.setPointerCapture(event.pointerId);
          } catch (_error) {
          }
        }
        updateFromPointer(event);
        event.preventDefault();
      });
      surface.addEventListener("pointermove", (event) => {
        if (!state.pointerActive || !(event.buttons & 1)) {
          return;
        }
        updateFromPointer(event);
        event.preventDefault();
      });
      const releasePointer = (event) => {
        if (!state.pointerActive) {
          return;
        }
        state.pointerActive = false;
        if (typeof surface.releasePointerCapture === "function") {
          try {
            surface.releasePointerCapture(event.pointerId);
          } catch (_error) {
          }
        }
      };
      surface.addEventListener("pointerup", releasePointer);
      surface.addEventListener("pointercancel", releasePointer);
      if (typeof ResizeObserver === "function") {
        state.resizeObserver = new ResizeObserver(() => {
          scheduleSync(state);
        });
        state.resizeObserver.observe(container);
      } else {
        state.onWindowResize = () => scheduleSync(state);
        window.addEventListener("resize", state.onWindowResize, true);
      }
      if (document.body instanceof HTMLElement && typeof MutationObserver === "function") {
        const requestDebouncedFullSync = () => {
          if (state.mutationDebounceTimer) {
            window.clearTimeout(state.mutationDebounceTimer);
          }
          state.mutationDebounceTimer = window.setTimeout(() => {
            state.mutationDebounceTimer = 0;
            scheduleSync(state);
          }, MUTATION_DEBOUNCE_MS);
        };
        state.mutationObserver = new MutationObserver(requestDebouncedFullSync);
        state.mutationObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden"]
        });
      }
      return state;
    }
    function queueNavigate(minimap, time) {
      if (!minimap || minimap.destroyed || !(time >= 0) || !minimap.hostMarkers[0]) {
        return;
      }
      minimap.navigatePendingTime = time;
      if (minimap.navigateInFlight) {
        return;
      }
      minimap.navigateInFlight = true;
      void (async () => {
        try {
          while (minimap.navigatePendingTime != null && !minimap.destroyed) {
            const nextTime = minimap.navigatePendingTime;
            minimap.navigatePendingTime = null;
            await callBridge("navigate-source", {
              hostMarker: minimap.hostMarkers[0],
              time: nextTime
            });
          }
        } finally {
          minimap.navigateInFlight = false;
          scheduleSync(minimap);
        }
      })();
    }
    async function syncMinimap(minimap) {
      if (!minimap || minimap.destroyed) {
        return;
      }
      if (minimap.syncPending) {
        minimap.syncQueued = true;
        return;
      }
      minimap.syncPending = true;
      try {
        if (!ensureContainer(minimap)) {
          clearRender(minimap);
          return;
        }
        const hosts = resolveWaveformHosts();
        if (!hosts.length) {
          disconnectHostObservers(minimap);
          minimap.hostMarkers = [];
          minimap.hostSignature = "";
          clearRender(minimap);
          return;
        }
        bindHostObservers(minimap, hosts);
        const containerRect = minimap.container.getBoundingClientRect();
        const peakBins = clamp(
          Math.ceil((Number(containerRect.width) || 180) * Math.min(2, window.devicePixelRatio || 1)),
          128,
          1200
        );
        const tracks = [];
        for (let index = 0; index < hosts.length; index += 1) {
          const host = hosts[index];
          const hostMarker = host.getAttribute(HOST_ATTR) || nextMarker("minimap-host-" + index);
          host.setAttribute(HOST_ATTR, hostMarker);
          const result = await callBridge("minimap-data", {
            hostMarker,
            peakBins
          });
          if (result && result.ok) {
            tracks.push(result);
          }
        }
        if (!tracks.length) {
          clearRender(minimap);
          return;
        }
        const duration = tracks.reduce((max, track) => Math.max(max, Number(track.duration) || 0), 0);
        minimap.duration = duration;
        layoutTrackLanes(minimap, tracks.length);
        for (let index = 0; index < minimap.lanes.length; index += 1) {
          const lane = minimap.lanes[index];
          const track = tracks[index];
          drawMinimapWaveform(lane.waveform, track && track.peaks ? track.peaks : []);
          renderRegions(lane.regions, track ? track.regions : [], duration);
        }
        const primary = tracks[0];
        const totalWidth = Number(primary.totalWidth) || 0;
        const visibleWidth = Number(primary.visibleWidth) || 0;
        const scrollLeft = Number(primary.scrollLeft) || 0;
        if (totalWidth > 0 && visibleWidth > 0) {
          const leftRatio = scrollLeft / totalWidth;
          const widthRatio = visibleWidth / totalWidth;
          setViewport(minimap, leftRatio, widthRatio);
        } else {
          minimap.viewport.style.display = "none";
        }
        setPlayhead(minimap, Number(primary.currentTime) || 0, duration);
        minimap.fullSyncOk = true;
      } catch (_error) {
        clearRender(minimap);
      } finally {
        minimap.syncPending = false;
        if (minimap.syncQueued) {
          minimap.syncQueued = false;
          scheduleSync(minimap);
        }
      }
    }
    helper.clearMinimap = function clearMinimap() {
      const minimap = helper.state.minimap;
      if (!minimap) {
        return;
      }
      minimap.destroyed = true;
      if (minimap.rafId) {
        window.cancelAnimationFrame(minimap.rafId);
        minimap.rafId = 0;
      }
      if (minimap.viewportRafId) {
        window.cancelAnimationFrame(minimap.viewportRafId);
        minimap.viewportRafId = 0;
      }
      if (minimap.mutationDebounceTimer) {
        window.clearTimeout(minimap.mutationDebounceTimer);
        minimap.mutationDebounceTimer = 0;
      }
      disconnectHostObservers(minimap);
      if (minimap.resizeObserver) {
        minimap.resizeObserver.disconnect();
      }
      if (minimap.mutationObserver) {
        minimap.mutationObserver.disconnect();
      }
      if (typeof minimap.onWindowResize === "function") {
        window.removeEventListener("resize", minimap.onWindowResize, true);
      }
      if (minimap.container instanceof HTMLElement) {
        minimap.container.replaceChildren();
      }
      helper.state.minimap = null;
    };
    helper.bindMinimap = function bindMinimap() {
      if (helper.state.minimap) {
        scheduleSync(helper.state.minimap);
        return;
      }
      const minimap = createMinimap();
      if (!minimap) {
        return;
      }
      helper.state.minimap = minimap;
      scheduleSync(minimap);
    };
    helper.unbindMinimap = function unbindMinimap() {
      const minimap = helper.state.minimap;
      if (!minimap) {
        return;
      }
      if (minimap.viewportRafId) {
        window.cancelAnimationFrame(minimap.viewportRafId);
        minimap.viewportRafId = 0;
      }
      if (minimap.mutationDebounceTimer) {
        window.clearTimeout(minimap.mutationDebounceTimer);
        minimap.mutationDebounceTimer = 0;
      }
      disconnectHostObservers(minimap);
      if (minimap.mutationObserver) {
        minimap.mutationObserver.disconnect();
        minimap.mutationObserver = null;
      }
      if (typeof minimap.onWindowResize === "function") {
        window.removeEventListener("resize", minimap.onWindowResize, true);
        minimap.onWindowResize = null;
      }
    };
  }

  // src/features/custom-linter-feature.ts
  var BRIDGE_SCRIPT_PATH = "dist/content/linter-bridge.js";
  var TOGGLE_EVENT = "babel-helper-linter-bridge-toggle";
  var BRIDGE_SCRIPT_ATTR = "data-babel-helper-linter-bridge";
  var AUTOFIX_REQUEST_EVENT = "babel-helper-linter-autofix";
  var AUTOFIX_RESPONSE_EVENT = "babel-helper-linter-autofix-response";
  var AUTOFIX_TIMEOUT_MS = 2e3;
  function setBridgeEnabled(enabled) {
    window.dispatchEvent(
      new CustomEvent(TOGGLE_EVENT, {
        detail: {
          enabled
        }
      })
    );
  }
  function injectBridge() {
    if (document.querySelector(`script[${BRIDGE_SCRIPT_ATTR}="true"]`)) {
      return Promise.resolve(true);
    }
    const chromeApi = globalThis.chrome;
    if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.getURL !== "function") {
      return Promise.resolve(false);
    }
    const root = document.documentElement || document.head || document.body;
    if (!(root instanceof HTMLElement)) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.setAttribute(BRIDGE_SCRIPT_ATTR, "true");
      script.src = chromeApi.runtime.getURL(BRIDGE_SCRIPT_PATH);
      script.async = false;
      script.onload = () => {
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        resolve(false);
      };
      root.appendChild(script);
    });
  }
  function requestAutoFix(scope) {
    return new Promise((resolve) => {
      let settled = false;
      const handleResponse = (event) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener(AUTOFIX_RESPONSE_EVENT, handleResponse, true);
        window.clearTimeout(timeoutId);
        const detail = event.detail || {};
        resolve(detail);
      };
      const timeoutId = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener(AUTOFIX_RESPONSE_EVENT, handleResponse, true);
        resolve({ ok: false, reason: "timeout" });
      }, AUTOFIX_TIMEOUT_MS);
      window.addEventListener(AUTOFIX_RESPONSE_EVENT, handleResponse, true);
      window.dispatchEvent(
        new CustomEvent(AUTOFIX_REQUEST_EVENT, {
          detail: { scope }
        })
      );
    });
  }
  function createCustomLinterFeature() {
    let startPromise = null;
    let bridgeReady = false;
    async function ensureBridgeReady(ctx) {
      if (!startPromise) {
        startPromise = injectBridge();
      }
      const ready = await startPromise;
      if (!ready) {
        startPromise = null;
        bridgeReady = false;
        ctx.logger.warn("Custom linter bridge did not load");
        return false;
      }
      bridgeReady = true;
      return true;
    }
    return {
      id: "custom-linter",
      async start(ctx) {
        const ready = await ensureBridgeReady(ctx);
        if (!ready) {
          return;
        }
        setBridgeEnabled(true);
      },
      async onLoaded(ctx) {
        if (!bridgeReady) {
          const ready = await ensureBridgeReady(ctx);
          if (!ready) {
            return;
          }
        }
        setBridgeEnabled(true);
      },
      stop() {
        bridgeReady = false;
        setBridgeEnabled(false);
      }
    };
  }

  // src/hooks/selected-number-to-skaz.ts
  var INTEGER_PATTERN = /^-?\d+$/;
  var DECIMAL_COMMA_PATTERN = /^-?\d+,\d+$/;
  var SLASH_FRACTION_PATTERN = /^-?\d+\s*\/\s*[1-9]\d*$/;
  var INTEGER_RANGE_PATTERN = /^-?\d+(?:\s*-\s*-?\d+)+$/;
  var PERCENT_PATTERN = /^(-?\d+)\s*%$/;
  var MAX_SUPPORTED_DIGITS = 12;
  var HUNDREDS = [
    "\u0441\u0442\u043E",
    "\u0434\u0432\u0435\u0441\u0442\u0438",
    "\u0442\u0440\u0438\u0441\u0442\u0430",
    "\u0447\u0435\u0442\u044B\u0440\u0435\u0441\u0442\u0430",
    "\u043F\u044F\u0442\u044C\u0441\u043E\u0442",
    "\u0448\u0435\u0441\u0442\u044C\u0441\u043E\u0442",
    "\u0441\u0435\u043C\u044C\u0441\u043E\u0442",
    "\u0432\u043E\u0441\u0435\u043C\u044C\u0441\u043E\u0442",
    "\u0434\u0435\u0432\u044F\u0442\u044C\u0441\u043E\u0442"
  ];
  var TENS = [
    "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0442\u0440\u0438\u0434\u0446\u0430\u0442\u044C",
    "\u0441\u043E\u0440\u043E\u043A",
    "\u043F\u044F\u0442\u044C\u0434\u0435\u0441\u044F\u0442",
    "\u0448\u0435\u0441\u0442\u044C\u0434\u0435\u0441\u044F\u0442",
    "\u0441\u0435\u043C\u044C\u0434\u0435\u0441\u044F\u0442",
    "\u0432\u043E\u0441\u0435\u043C\u044C\u0434\u0435\u0441\u044F\u0442",
    "\u0434\u0435\u0432\u044F\u043D\u043E\u0441\u0442\u043E"
  ];
  var TEENS = [
    "\u0434\u0435\u0441\u044F\u0442\u044C",
    "\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044C",
    "\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044C"
  ];
  var UNITS_MALE = [
    "\u043E\u0434\u0438\u043D",
    "\u0434\u0432\u0430",
    "\u0442\u0440\u0438",
    "\u0447\u0435\u0442\u044B\u0440\u0435",
    "\u043F\u044F\u0442\u044C",
    "\u0448\u0435\u0441\u0442\u044C",
    "\u0441\u0435\u043C\u044C",
    "\u0432\u043E\u0441\u0435\u043C\u044C",
    "\u0434\u0435\u0432\u044F\u0442\u044C"
  ];
  var UNITS_FEMALE = [
    "\u043E\u0434\u043D\u0430",
    "\u0434\u0432\u0435",
    "\u0442\u0440\u0438",
    "\u0447\u0435\u0442\u044B\u0440\u0435",
    "\u043F\u044F\u0442\u044C",
    "\u0448\u0435\u0441\u0442\u044C",
    "\u0441\u0435\u043C\u044C",
    "\u0432\u043E\u0441\u0435\u043C\u044C",
    "\u0434\u0435\u0432\u044F\u0442\u044C"
  ];
  var SCALE_FORMS = [
    ["", "", ""],
    ["\u0442\u044B\u0441\u044F\u0447\u0430", "\u0442\u044B\u0441\u044F\u0447\u0438", "\u0442\u044B\u0441\u044F\u0447"],
    ["\u043C\u0438\u043B\u043B\u0438\u043E\u043D", "\u043C\u0438\u043B\u043B\u0438\u043E\u043D\u0430", "\u043C\u0438\u043B\u043B\u0438\u043E\u043D\u043E\u0432"],
    ["\u043C\u0438\u043B\u043B\u0438\u0430\u0440\u0434", "\u043C\u0438\u043B\u043B\u0438\u0430\u0440\u0434\u0430", "\u043C\u0438\u043B\u043B\u0438\u0430\u0440\u0434\u043E\u0432"]
  ];
  var SPOKEN_DIGIT_WORDS = /* @__PURE__ */ new Map([
    ["\u043D\u043E\u043B\u044C", "0"],
    ["\u043E\u0434\u0438\u043D", "1"],
    ["\u043E\u0434\u043D\u0430", "1"],
    ["\u0434\u0432\u0430", "2"],
    ["\u0434\u0432\u0435", "2"],
    ["\u0442\u0440\u0438", "3"],
    ["\u0447\u0435\u0442\u044B\u0440\u0435", "4"],
    ["\u043F\u044F\u0442\u044C", "5"],
    ["\u0448\u0435\u0441\u0442\u044C", "6"],
    ["\u0441\u0435\u043C\u044C", "7"],
    ["\u0432\u043E\u0441\u0435\u043C\u044C", "8"],
    ["\u0434\u0435\u0432\u044F\u0442\u044C", "9"]
  ]);
  var DIGIT_WORDS = ["\u043D\u043E\u043B\u044C", "\u043E\u0434\u0438\u043D", "\u0434\u0432\u0430", "\u0442\u0440\u0438", "\u0447\u0435\u0442\u044B\u0440\u0435", "\u043F\u044F\u0442\u044C", "\u0448\u0435\u0441\u0442\u044C", "\u0441\u0435\u043C\u044C", "\u0432\u043E\u0441\u0435\u043C\u044C", "\u0434\u0435\u0432\u044F\u0442\u044C"];
  var FRACTION_DENOMINATORS = /* @__PURE__ */ new Map([
    [2, { singular: "\u0432\u0442\u043E\u0440\u0430\u044F", plural: "\u0432\u0442\u043E\u0440\u044B\u0445", forms: ["\u0432\u0442\u043E\u0440\u0430\u044F", "\u0432\u0442\u043E\u0440\u0443\u044E", "\u0432\u0442\u043E\u0440\u043E\u0439", "\u0432\u0442\u043E\u0440\u044B\u0445", "\u0432\u0442\u043E\u0440\u044B\u0435"] }],
    [3, { singular: "\u0442\u0440\u0435\u0442\u044C\u044F", plural: "\u0442\u0440\u0435\u0442\u044C\u0438\u0445", forms: ["\u0442\u0440\u0435\u0442\u044C\u044F", "\u0442\u0440\u0435\u0442\u044C\u044E", "\u0442\u0440\u0435\u0442\u044C\u0435\u0439", "\u0442\u0440\u0435\u0442\u044C\u0438\u0445", "\u0442\u0440\u0435\u0442\u044C\u0438"] }],
    [4, { singular: "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0430\u044F", plural: "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u044B\u0445", pluralFew: "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0438", forms: ["\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0430\u044F", "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0443\u044E", "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u043E\u0439", "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u044B\u0445", "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u044B\u0435", "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0438", "\u0447\u0435\u0442\u0432\u0435\u0440\u0442\u0435\u0439"] }],
    [5, { singular: "\u043F\u044F\u0442\u0430\u044F", plural: "\u043F\u044F\u0442\u044B\u0445", forms: ["\u043F\u044F\u0442\u0430\u044F", "\u043F\u044F\u0442\u0443\u044E", "\u043F\u044F\u0442\u043E\u0439", "\u043F\u044F\u0442\u044B\u0445", "\u043F\u044F\u0442\u044B\u0435"] }],
    [6, { singular: "\u0448\u0435\u0441\u0442\u0430\u044F", plural: "\u0448\u0435\u0441\u0442\u044B\u0445", forms: ["\u0448\u0435\u0441\u0442\u0430\u044F", "\u0448\u0435\u0441\u0442\u0443\u044E", "\u0448\u0435\u0441\u0442\u043E\u0439", "\u0448\u0435\u0441\u0442\u044B\u0445", "\u0448\u0435\u0441\u0442\u044B\u0435"] }],
    [7, { singular: "\u0441\u0435\u0434\u044C\u043C\u0430\u044F", plural: "\u0441\u0435\u0434\u044C\u043C\u044B\u0445", forms: ["\u0441\u0435\u0434\u044C\u043C\u0430\u044F", "\u0441\u0435\u0434\u044C\u043C\u0443\u044E", "\u0441\u0435\u0434\u044C\u043C\u043E\u0439", "\u0441\u0435\u0434\u044C\u043C\u044B\u0445", "\u0441\u0435\u0434\u044C\u043C\u044B\u0435"] }],
    [8, { singular: "\u0432\u043E\u0441\u044C\u043C\u0430\u044F", plural: "\u0432\u043E\u0441\u044C\u043C\u044B\u0445", forms: ["\u0432\u043E\u0441\u044C\u043C\u0430\u044F", "\u0432\u043E\u0441\u044C\u043C\u0443\u044E", "\u0432\u043E\u0441\u044C\u043C\u043E\u0439", "\u0432\u043E\u0441\u044C\u043C\u044B\u0445", "\u0432\u043E\u0441\u044C\u043C\u044B\u0435"] }],
    [9, { singular: "\u0434\u0435\u0432\u044F\u0442\u0430\u044F", plural: "\u0434\u0435\u0432\u044F\u0442\u044B\u0445", forms: ["\u0434\u0435\u0432\u044F\u0442\u0430\u044F", "\u0434\u0435\u0432\u044F\u0442\u0443\u044E", "\u0434\u0435\u0432\u044F\u0442\u043E\u0439", "\u0434\u0435\u0432\u044F\u0442\u044B\u0445", "\u0434\u0435\u0432\u044F\u0442\u044B\u0435"] }],
    [10, { singular: "\u0434\u0435\u0441\u044F\u0442\u0430\u044F", plural: "\u0434\u0435\u0441\u044F\u0442\u044B\u0445", forms: ["\u0434\u0435\u0441\u044F\u0442\u0430\u044F", "\u0434\u0435\u0441\u044F\u0442\u0443\u044E", "\u0434\u0435\u0441\u044F\u0442\u043E\u0439", "\u0434\u0435\u0441\u044F\u0442\u044B\u0445", "\u0434\u0435\u0441\u044F\u0442\u044B\u0435"] }],
    [11, { singular: "\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u043E\u0434\u0438\u043D\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [12, { singular: "\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0434\u0432\u0435\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [13, { singular: "\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0442\u0440\u0438\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [14, { singular: "\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0447\u0435\u0442\u044B\u0440\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [15, { singular: "\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u043F\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [16, { singular: "\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0448\u0435\u0441\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [17, { singular: "\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [18, { singular: "\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0432\u043E\u0441\u0435\u043C\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [19, { singular: "\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0434\u0435\u0432\u044F\u0442\u043D\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }],
    [20, { singular: "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u0430\u044F", plural: "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044B\u0445", forms: ["\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u0430\u044F", "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u0443\u044E", "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u043E\u0439", "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044B\u0445", "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044B\u0435"] }]
  ]);
  function dispatchInputEvent(element) {
    element.dispatchEvent(
      typeof InputEvent === "function" ? new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        data: null,
        inputType: "insertText"
      }) : new Event("input", {
        bubbles: true,
        cancelable: false
      })
    );
  }
  function setTextControlValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (typeof setter === "function") {
      setter.call(element, value);
    } else {
      element.value = value;
    }
  }
  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) {
      return true;
    }
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    return ["text", "search", "url", "tel", "password", "email", "number"].includes(element.type || "text");
  }
  function pickPluralForm(value, one, twoToFour, many) {
    const absolute = Math.abs(value);
    const mod10 = absolute % 10;
    const mod100 = absolute % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return one;
    }
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
      return twoToFour;
    }
    return many;
  }
  function threeDigitToWords(value, isFeminine = false) {
    const parts = [];
    const hundreds = Math.floor(value / 100);
    const remainder = value % 100;
    const tens = Math.floor(remainder / 10);
    const units = remainder % 10;
    if (hundreds > 0) {
      parts.push(HUNDREDS[hundreds - 1]);
    }
    if (remainder >= 10 && remainder <= 19) {
      parts.push(TEENS[remainder - 10]);
      return parts.join(" ");
    }
    if (tens >= 2) {
      parts.push(TENS[tens - 2]);
    }
    if (units > 0) {
      parts.push((isFeminine ? UNITS_FEMALE : UNITS_MALE)[units - 1]);
    }
    return parts.join(" ");
  }
  function integerTextToRussianWords(numberText, lastTriadFeminine = false) {
    let signPrefix = "";
    let digits = numberText;
    if (digits.startsWith("-")) {
      signPrefix = "\u043C\u0438\u043D\u0443\u0441 ";
      digits = digits.slice(1);
    }
    digits = digits.replace(/^0+/, "");
    if (!digits) {
      return `${signPrefix}\u043D\u043E\u043B\u044C`;
    }
    if (digits.length > MAX_SUPPORTED_DIGITS) {
      return "";
    }
    const triads = [];
    while (digits.length > 0) {
      triads.unshift(digits.slice(-3));
      digits = digits.slice(0, -3);
    }
    const parts = [];
    for (let index = 0; index < triads.length; index += 1) {
      const triadValue = Number(triads[index]);
      if (!triadValue) {
        continue;
      }
      const scaleIndex = triads.length - index - 1;
      const isFeminine = scaleIndex === 1 || scaleIndex === 0 && lastTriadFeminine;
      const triadWords = threeDigitToWords(triadValue, isFeminine);
      if (!triadWords) {
        continue;
      }
      if (scaleIndex > 0) {
        const [one, twoToFour, many] = SCALE_FORMS[scaleIndex];
        parts.push(`${triadWords} ${pickPluralForm(triadValue, one, twoToFour, many)}`);
      } else {
        parts.push(triadWords);
      }
    }
    if (!parts.length) {
      return `${signPrefix}\u043D\u043E\u043B\u044C`;
    }
    return `${signPrefix}${parts.join(" ")}`;
  }
  function chooseFractionDenominatorWord(denominator, numerator) {
    const spec = FRACTION_DENOMINATORS.get(denominator);
    if (!spec) {
      return null;
    }
    const absolute = Math.abs(numerator);
    const mod10 = absolute % 10;
    const mod100 = absolute % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return spec.singular;
    }
    if (spec.pluralFew && mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
      return spec.pluralFew;
    }
    return spec.plural;
  }
  function buildSkazFromSlashFraction(selectedText) {
    const trimmed = selectedText.trim();
    if (!SLASH_FRACTION_PATTERN.test(trimmed)) {
      return null;
    }
    const match = trimmed.match(/^(-?\d+)\s*\/\s*(\d+)$/);
    if (!match) {
      return null;
    }
    const numeratorText = match[1];
    const denominatorValue = Number(match[2]);
    if (!Number.isInteger(denominatorValue) || denominatorValue < 2 || denominatorValue > 20) {
      return null;
    }
    const numeratorValue = Number(numeratorText);
    if (!Number.isInteger(numeratorValue)) {
      return null;
    }
    const numeratorWords = integerTextToRussianWords(numeratorText, true);
    const denominatorWord = chooseFractionDenominatorWord(denominatorValue, numeratorValue);
    if (!numeratorWords || !denominatorWord) {
      return null;
    }
    return `${trimmed} {\u0421\u041A\u0410\u0417: ${numeratorWords} ${denominatorWord}}`;
  }
  function formatGroupedIntegerText(numberText) {
    if (!INTEGER_PATTERN.test(numberText)) {
      return numberText;
    }
    const sign = numberText.startsWith("-") ? "-" : "";
    const digits = sign ? numberText.slice(1) : numberText;
    if (digits.length <= 3 || digits.length > 1 && digits.startsWith("0")) {
      return numberText;
    }
    const groupedDigits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return `${sign}${groupedDigits}`;
  }
  function formatGroupedDecimalText(numberText) {
    if (!DECIMAL_COMMA_PATTERN.test(numberText)) {
      return numberText;
    }
    const sign = numberText.startsWith("-") ? "-" : "";
    const unsigned = sign ? numberText.slice(1) : numberText;
    const [integerPart, fractionPart] = unsigned.split(",");
    const groupedIntegerPart = formatGroupedIntegerText(`${sign}${integerPart}`);
    const normalizedIntegerPart = sign && groupedIntegerPart.startsWith("-") ? groupedIntegerPart.slice(1) : groupedIntegerPart;
    return `${sign}${normalizedIntegerPart},${fractionPart}`;
  }
  function decimalCommaTextToRussianWords(numberText) {
    if (!DECIMAL_COMMA_PATTERN.test(numberText)) {
      return "";
    }
    const signPrefix = numberText.startsWith("-") ? "\u043C\u0438\u043D\u0443\u0441 " : "";
    const unsigned = signPrefix ? numberText.slice(1) : numberText;
    const [integerPart, fractionPart] = unsigned.split(",");
    const integerWords = numberTextToRussianWords(integerPart);
    if (!integerWords) {
      return "";
    }
    const fractionWords = fractionPart.split("").map((digit) => DIGIT_WORDS[Number(digit)] ?? "").filter(Boolean);
    if (!fractionWords.length || fractionWords.length !== fractionPart.length) {
      return "";
    }
    return `${signPrefix}${integerWords} \u0438 ${fractionWords.join(" ")}`;
  }
  function numberTextToRussianWords(numberText) {
    return integerTextToRussianWords(numberText, false);
  }
  function buildExpandedSkazText(selectedText) {
    const trimmed = selectedText.trim();
    if (!trimmed) {
      return null;
    }
    if (DECIMAL_COMMA_PATTERN.test(trimmed)) {
      const words2 = decimalCommaTextToRussianWords(trimmed);
      if (!words2) {
        return null;
      }
      return `${formatGroupedDecimalText(trimmed)} {\u0421\u041A\u0410\u0417: ${words2}}`;
    }
    if (!INTEGER_PATTERN.test(trimmed)) {
      return null;
    }
    const words = numberTextToRussianWords(trimmed);
    if (!words) {
      return null;
    }
    return `${formatGroupedIntegerText(trimmed)} {\u0421\u041A\u0410\u0417: ${words}}`;
  }
  function buildExpandedSkazForNumericPattern(selectedText) {
    const trimmed = selectedText.trim();
    if (!trimmed) {
      return null;
    }
    const percentMatch = trimmed.match(PERCENT_PATTERN);
    if (percentMatch) {
      const digits = percentMatch[1];
      const words2 = numberTextToRussianWords(digits);
      if (!words2) {
        return null;
      }
      const percentWord = pickPluralForm(Number(digits), "\u043F\u0440\u043E\u0446\u0435\u043D\u0442", "\u043F\u0440\u043E\u0446\u0435\u043D\u0442\u0430", "\u043F\u0440\u043E\u0446\u0435\u043D\u0442\u043E\u0432");
      return `${formatGroupedIntegerText(digits)} % {\u0421\u041A\u0410\u0417: ${words2} ${percentWord}}`;
    }
    if (!INTEGER_RANGE_PATTERN.test(trimmed)) {
      return null;
    }
    const parts = trimmed.split(/\s*-\s*/);
    const words = parts.map((part) => numberTextToRussianWords(part));
    if (words.some((part) => !part)) {
      return null;
    }
    return `${parts.map((part) => formatGroupedIntegerText(part)).join("-")} {\u0421\u041A\u0410\u0417: ${words.join(" ")}}`;
  }
  function buildSkazFromSpokenDigitSequence(selectedText) {
    const trimmed = selectedText.trim();
    if (!trimmed) {
      return null;
    }
    const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
      return null;
    }
    const digits = tokens.map((token) => SPOKEN_DIGIT_WORDS.get(token) ?? "");
    if (digits.some((token) => !token)) {
      return null;
    }
    return `${digits.join("-")} {\u0421\u041A\u0410\u0417: ${trimmed}}`;
  }
  function buildAutoConvertedNumberText(selectedText) {
    return buildExpandedSkazText(selectedText) ?? buildSkazFromSlashFraction(selectedText) ?? buildExpandedSkazForNumericPattern(selectedText) ?? buildSkazFromSpokenDigitSequence(selectedText);
  }
  function replaceSelectionInTextControl(control, replacement, cursorOffset) {
    const start = typeof control.selectionStart === "number" ? control.selectionStart : null;
    const end = typeof control.selectionEnd === "number" ? control.selectionEnd : null;
    if (start === null || end === null || start === end) {
      return false;
    }
    const nextValue = `${control.value.slice(0, start)}${replacement}${control.value.slice(end)}`;
    setTextControlValue(control, nextValue);
    control.focus({ preventScroll: true });
    const cursor = start + (cursorOffset ?? replacement.length);
    try {
      control.setSelectionRange(cursor, cursor);
    } catch (_error) {
    }
    dispatchInputEvent(control);
    return true;
  }
  function replaceDocumentSelection(replacement) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
      return false;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(replacement);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  function getSelectedTextFromTextControl(control) {
    const start = typeof control.selectionStart === "number" ? control.selectionStart : null;
    const end = typeof control.selectionEnd === "number" ? control.selectionEnd : null;
    if (start === null || end === null || start === end) {
      return "";
    }
    return control.value.slice(start, end);
  }
  function autoConvertSelectedNumberText(target) {
    const targetNode = target ?? null;
    let activeTarget = null;
    if (isTextControl(targetNode)) {
      activeTarget = targetNode;
    } else if (isTextControl(document.activeElement)) {
      activeTarget = document.activeElement;
    }
    if (activeTarget) {
      const selectedText2 = getSelectedTextFromTextControl(activeTarget);
      const replacement2 = buildAutoConvertedNumberText(selectedText2);
      if (!replacement2) {
        return false;
      }
      return replaceSelectionInTextControl(activeTarget, replacement2);
    }
    const selection = window.getSelection();
    const selectedText = selection?.toString() ?? "";
    const replacement = buildAutoConvertedNumberText(selectedText);
    if (!replacement) {
      return false;
    }
    return replaceDocumentSelection(replacement);
  }
  function convertSelectionWithDigit(target, digit) {
    if (!isTextControl(target)) {
      return false;
    }
    const selectedText = getSelectedTextFromTextControl(target);
    if (!selectedText || selectedText.trim().length === 0) {
      return false;
    }
    const replacement = `${digit} {\u0421\u041A\u0410\u0417: ${selectedText}}`;
    return replaceSelectionInTextControl(target, replacement, digit.length);
  }

  // src/core/lifecycle.ts
  function registerLifecycle(helper) {
    if (!helper || helper.__mainInitialized) {
      return;
    }
    helper.__mainInitialized = true;
    const ROUTE_REFRESH_DELAY_MS = 80;
    const ROUTE_REFRESH_MAX_ATTEMPTS = 12;
    const ROUTE_REFRESH_MAX_WINDOW_MS = 1200;
    function isFeatureEnabled(featureKey) {
      if (typeof helper.isFeatureEnabled === "function") {
        return helper.isFeatureEnabled(featureKey);
      }
      return true;
    }
    function isTranscriptionRoute() {
      return /^\/transcription(?:\/|$)/.test(window.location.pathname || "");
    }
    function isReadOnlyFeedbackRoute() {
      const params = new URLSearchParams(window.location.search || "");
      const displayFeedback = params.get("displayFeedback");
      if (displayFeedback === "true") {
        return true;
      }
      return Boolean(
        params.has("reviewActionId") && displayFeedback != null && displayFeedback !== "false"
      );
    }
    function hasTranscriptSurface() {
      return Boolean(document.querySelector(helper.config.rowTextareaSelector));
    }
    helper.runtime.isSessionInteractive = function isSessionInteractive() {
      return Boolean(
        isTranscriptionRoute() && !isReadOnlyFeedbackRoute() && hasTranscriptSurface()
      );
    };
    function resetRouteRefreshWindow() {
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = Date.now();
      helper.state.onLoadedCalled = false;
    }
    function startHotkeysEnhanceFrame() {
      if (!isFeatureEnabled("hotkeysHelp")) {
        return;
      }
      if (helper.state.hotkeysEnhanceFrame) {
        return;
      }
      helper.state.hotkeysEnhanceFrame = window.requestAnimationFrame(() => {
        helper.state.hotkeysEnhanceFrame = 0;
        helper.enhanceHotkeysDialog();
      });
    }
    function stopHotkeysEnhanceFrame() {
      if (!helper.state.hotkeysEnhanceFrame) {
        return;
      }
      window.cancelAnimationFrame(helper.state.hotkeysEnhanceFrame);
      helper.state.hotkeysEnhanceFrame = 0;
    }
    function stopHotkeysObserver() {
      const observer = helper.state.hotkeysObserver;
      if (observer && typeof observer.disconnect === "function") {
        observer.disconnect();
      }
      helper.state.hotkeysObserver = null;
    }
    function stopRouteRecoveryObserver() {
      const observer = helper.state.routeRecoveryObserver;
      if (observer && typeof observer.disconnect === "function") {
        observer.disconnect();
      }
      helper.state.routeRecoveryObserver = null;
    }
    function isHotkeysMutationCandidate(node) {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      if (node.matches('[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]')) {
        return true;
      }
      return Boolean(
        node.querySelector('[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]')
      );
    }
    function startHotkeysObserver() {
      if (!isFeatureEnabled("hotkeysHelp")) {
        stopHotkeysObserver();
        return;
      }
      stopHotkeysObserver();
      if (!(document.body instanceof HTMLElement) || typeof MutationObserver !== "function") {
        return;
      }
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type !== "childList" || !mutation.addedNodes.length) {
            continue;
          }
          for (const node of mutation.addedNodes) {
            if (isHotkeysMutationCandidate(node)) {
              startHotkeysEnhanceFrame();
              return;
            }
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      helper.state.hotkeysObserver = observer;
    }
    function startRouteRecoveryObserver() {
      if (helper.state.routeRecoveryObserver || !(document.body instanceof HTMLElement)) {
        return;
      }
      if (typeof MutationObserver !== "function") {
        return;
      }
      const observer = new MutationObserver(() => {
        if (!isTranscriptionRoute() || isReadOnlyFeedbackRoute()) {
          return;
        }
        if (!hasTranscriptSurface()) {
          return;
        }
        stopRouteRecoveryObserver();
        resetRouteRefreshWindow();
        helper.runtime.scheduleRouteRefresh("recovery-observer");
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["placeholder"],
        childList: true,
        subtree: true
      });
      helper.state.routeRecoveryObserver = observer;
    }
    function tryDeleteCurrentRow(event) {
      const row = helper.getCurrentRow({ allowFallback: false });
      if (!row) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      void helper.runRowAction("deleteSegment", {
        row,
        allowFallback: false
      });
      return true;
    }
    function matchPlaybackRewindShortcut(event) {
      const shortcuts = Array.isArray(helper.config.playbackRewindShortcuts) ? helper.config.playbackRewindShortcuts : [];
      function matchesShortcutCode(shortcut) {
        const eventKeyCode = Number.isFinite(Number(event.keyCode)) ? Number(event.keyCode) : null;
        if (Array.isArray(shortcut.codes) && shortcut.codes.includes(event.code)) {
          return true;
        }
        if (shortcut.code && shortcut.code === event.code) {
          return true;
        }
        if (eventKeyCode != null && Number.isFinite(Number(shortcut.keyCode))) {
          return Number(shortcut.keyCode) === eventKeyCode;
        }
        return false;
      }
      return shortcuts.find(
        (shortcut) => shortcut && matchesShortcutCode(shortcut) && Boolean(shortcut.ctrlKey) === Boolean(event.ctrlKey) && Boolean(shortcut.altKey) === Boolean(event.altKey) && Boolean(shortcut.shiftKey) === Boolean(event.shiftKey) && Boolean(shortcut.metaKey) === Boolean(event.metaKey) && Number.isFinite(Number(shortcut.seconds))
      ) || null;
    }
    function updateRightShiftState(event) {
      if (event.code === "ShiftRight") {
        helper.state.rightShiftPressed = event.type === "keydown";
        return;
      }
      if (!event.shiftKey) {
        helper.state.rightShiftPressed = false;
      }
    }
    function isRightShiftSegmentNavigationShortcut(event) {
      return Boolean(
        isFeatureEnabled("rowActions") && helper.state.rightShiftPressed && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")
      );
    }
    function shouldSuppressNativeArrowHotkey(event) {
      if (!isFeatureEnabled("disableNativeArrowSeek")) {
        return false;
      }
      if (!helper.runtime.isSessionInteractive()) {
        return false;
      }
      if (event.defaultPrevented) {
        return false;
      }
      if (event.altKey) {
        return false;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return false;
      }
      if (event.ctrlKey || event.metaKey) {
        return true;
      }
      return !event.shiftKey;
    }
    function handleNativeArrowSuppress(event) {
      updateRightShiftState(event);
      if (isRightShiftSegmentNavigationShortcut(event)) {
        const offset = event.key === "ArrowRight" ? 1 : -1;
        const handled = typeof helper.moveFocus === "function" && helper.moveFocus(offset);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (handled && helper.analytics) {
          helper.analytics.record("hotkey:segment-nav", {
            direction: offset > 0 ? "next" : "previous",
            via: "right-shift-arrow"
          });
        }
        return;
      }
      if (!shouldSuppressNativeArrowHotkey(event)) {
        return;
      }
      event.stopImmediatePropagation();
      if (helper.analytics) {
        helper.analytics.record("hotkey:arrow-suppressed", { key: event.key, ctrlKey: event.ctrlKey });
      }
    }
    function handleGlobalKeyup(event) {
      updateRightShiftState(event);
    }
    function handleWindowBlur() {
      helper.state.rightShiftPressed = false;
    }
    helper.handleKeydown = function handleKeydown(event) {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if (isFeatureEnabled("timelineSelection") && typeof helper.handleCutPreviewKeydown === "function" && helper.handleCutPreviewKeydown(event)) {
        if (helper.analytics) {
          helper.analytics.record("hotkey:cut-preview", { key: event.key, code: event.code });
        }
        return;
      }
      if (isFeatureEnabled("focusToggle") && event.key === "Escape") {
        if (typeof helper.handleEscapeWorkflow === "function" && helper.handleEscapeWorkflow()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (isFeatureEnabled("rowActions") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === "KeyD" && !helper.isEditable(event.target instanceof HTMLElement ? event.target : null)) {
        if (tryDeleteCurrentRow(event)) {
          if (helper.analytics) {
            helper.analytics.record("hotkey:delete", { key: "D" });
          }
          return;
        }
      }
      const rewindShortcut = isFeatureEnabled("rowActions") ? matchPlaybackRewindShortcut(event) : null;
      if (rewindShortcut) {
        const handled2 = typeof helper.seekPlaybackBySeconds === "function" && helper.seekPlaybackBySeconds(-Number(rewindShortcut.seconds));
        if (handled2) {
          event.preventDefault();
          event.stopPropagation();
          if (helper.analytics) {
            helper.analytics.record("hotkey:rewind", { seconds: Number(rewindShortcut.seconds), code: event.code });
          }
        }
        return;
      }
      if (isFeatureEnabled("selectedNumberToSkaz") && event.code.startsWith("Digit") && !event.ctrlKey && !event.altKey && !event.metaKey) {
        const target = event.target;
        if (isTextControl(target)) {
          const selectedText = getSelectedTextFromTextControl(target);
          if (selectedText && selectedText.trim().length > 0) {
            const handled2 = convertSelectionWithDigit(target, event.key);
            if (handled2) {
              event.preventDefault();
              event.stopPropagation();
              if (helper.analytics) {
                helper.analytics.record("hotkey:number-entry-immediate", { key: event.key });
              }
              return;
            }
          }
        }
      }
      if (isFeatureEnabled("selectedNumberToSkaz") && event.code === "KeyA" && event.altKey && !event.shiftKey && !event.metaKey) {
        const handled2 = autoConvertSelectedNumberText(event.target);
        if (handled2) {
          event.preventDefault();
          event.stopPropagation();
          if (helper.analytics) {
            helper.analytics.record("hotkey:selected-number-auto-convert", {
              ctrlKey: event.ctrlKey
            });
          }
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || !event.altKey) {
        return;
      }
      let handled = false;
      if (isFeatureEnabled("rowActions") && isFeatureEnabled("speakerWorkflowHotkeys") && !event.shiftKey && event.code === "Digit1" && typeof helper.switchSpeakerWorkflow === "function") {
        handled = true;
        void helper.switchSpeakerWorkflow("Speaker 1");
        if (helper.analytics) {
          helper.analytics.record("hotkey:speaker-switch", { speaker: "Speaker 1" });
        }
      } else if (isFeatureEnabled("rowActions") && isFeatureEnabled("speakerWorkflowHotkeys") && !event.shiftKey && event.code === "Digit2" && typeof helper.switchSpeakerWorkflow === "function") {
        handled = true;
        void helper.switchSpeakerWorkflow("Speaker 2");
        if (helper.analytics) {
          helper.analytics.record("hotkey:speaker-switch", { speaker: "Speaker 2" });
        }
      } else if (isFeatureEnabled("rowActions") && isFeatureEnabled("speakerWorkflowHotkeys") && event.code === "Backquote" && typeof helper.resetSpeakerWorkflow === "function") {
        handled = true;
        void helper.resetSpeakerWorkflow();
        if (helper.analytics) {
          helper.analytics.record("hotkey:speaker-reset", {});
        }
      } else if (isFeatureEnabled("textMove") && !event.shiftKey && event.code === "BracketLeft") {
        handled = helper.moveTextToAdjacentSegment(-1);
        if (handled && helper.analytics) {
          helper.analytics.record("hotkey:text-move", { direction: "left" });
        }
      } else if (isFeatureEnabled("textMove") && !event.shiftKey && event.code === "BracketRight") {
        handled = helper.moveTextToAdjacentSegment(1);
        if (handled && helper.analytics) {
          helper.analytics.record("hotkey:text-move", { direction: "right" });
        }
      } else if (isFeatureEnabled("rowActions") && event.shiftKey && event.key === "ArrowUp") {
        handled = true;
        void helper.runRowAction("mergePrevious");
        if (helper.analytics) {
          helper.analytics.record("hotkey:merge", { direction: "previous" });
        }
      } else if (isFeatureEnabled("rowActions") && event.shiftKey && event.key === "ArrowDown") {
        handled = true;
        void helper.runRowAction("mergeNext");
        if (helper.analytics) {
          helper.analytics.record("hotkey:merge", { direction: "next" });
        }
      } else if (isFeatureEnabled("customLinter") && event.code === "KeyF") {
        handled = true;
        const scope = event.shiftKey ? "all" : "current";
        void requestAutoFix(scope).then((result) => {
          if (helper.analytics) {
            helper.analytics.record("hotkey:lint-autofix", { scope, ...result });
          }
        });
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    function handleRowFocusIn(event) {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const row = target.closest("tr");
      if (row && row.querySelector(helper.config.rowTextareaSelector)) {
        const rowChanged = helper.state.currentRow && helper.state.currentRow !== row;
        if (rowChanged) {
          helper.state.cursorBaseline = null;
        }
        helper.setCurrentRow(row);
        if (helper.analytics) {
          const rowId = typeof helper.getRowIdentity === "function" ? helper.getRowIdentity(row)?.annotationId ?? null : null;
          helper.analytics.record("row:focus-in", {
            rowId,
            rowChanged,
            isTextarea: target instanceof HTMLTextAreaElement
          });
        }
      }
    }
    function handleRowPointerDown(event) {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const row = target.closest("tr");
      if (row && row.querySelector(helper.config.rowTextareaSelector)) {
        helper.setCurrentRow(row);
      }
    }
    function handleCursorBaselineUpdate(event) {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || !target.matches(helper.config.rowTextareaSelector)) {
        return;
      }
      const pos = target.selectionStart;
      if (typeof pos === "number") {
        const prevBaseline = helper.state.cursorBaseline;
        helper.state.cursorBaseline = pos;
        if (helper.analytics && event.type === "input") {
          helper.analytics.recordTextEdit({
            cursorPos: pos,
            textLength: (target.value || "").length,
            prevBaseline
          });
        }
        if (helper.analytics && prevBaseline !== pos && event.type !== "input") {
          helper.analytics.record("cursor:baseline-update", {
            pos,
            prevBaseline,
            eventType: event.type,
            textLength: (target.value || "").length
          });
        }
      }
    }
    function schedulePlaybackRowSync() {
      if (helper.state.playbackRowSyncInFlight || typeof helper.syncCurrentRowToPlayback !== "function") {
        return;
      }
      helper.state.playbackRowSyncInFlight = true;
      void helper.syncCurrentRowToPlayback().finally(() => {
        helper.state.playbackRowSyncInFlight = false;
      });
    }
    helper.bindRowTracking = function bindRowTracking() {
      if (helper.state.rowTrackingBound) {
        return;
      }
      document.addEventListener("focusin", handleRowFocusIn, true);
      document.addEventListener("pointerdown", handleRowPointerDown, true);
      document.addEventListener("input", handleCursorBaselineUpdate, true);
      document.addEventListener("keyup", handleCursorBaselineUpdate, true);
      document.addEventListener("pointerup", handleCursorBaselineUpdate, true);
      schedulePlaybackRowSync();
      helper.state.playbackRowSyncTimer = window.setInterval(schedulePlaybackRowSync, 250);
      helper.state.rowTrackingBound = true;
    };
    helper.unbindRowTracking = function unbindRowTracking() {
      if (!helper.state.rowTrackingBound) {
        return;
      }
      document.removeEventListener("focusin", handleRowFocusIn, true);
      document.removeEventListener("pointerdown", handleRowPointerDown, true);
      document.removeEventListener("input", handleCursorBaselineUpdate, true);
      document.removeEventListener("keyup", handleCursorBaselineUpdate, true);
      document.removeEventListener("pointerup", handleCursorBaselineUpdate, true);
      if (helper.state.playbackRowSyncTimer != null) {
        window.clearInterval(helper.state.playbackRowSyncTimer);
        helper.state.playbackRowSyncTimer = null;
      }
      helper.state.playbackRowSyncInFlight = false;
      helper.state.lastPlaybackRow = null;
      helper.state.lastPlaybackRowIdentity = null;
      helper.state.rowTrackingBound = false;
    };
    function bindGlobalListeners() {
      if (helper.state.keydownBound) {
        return;
      }
      window.addEventListener("keydown", handleNativeArrowSuppress, true);
      window.addEventListener("keyup", handleGlobalKeyup, true);
      window.addEventListener("blur", handleWindowBlur, true);
      document.addEventListener("keydown", helper.handleKeydown, true);
      helper.state.keydownBound = true;
      helper.state.nativeArrowSuppressBound = true;
    }
    function patchHistoryMethod(name) {
      const current = window.history[name];
      if (typeof current !== "function") {
        return;
      }
      if (current.__babelHelperPatched) {
        return;
      }
      const original = current.__babelHelperOriginal || current;
      function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        resetRouteRefreshWindow();
        helper.runtime.scheduleRouteRefresh("route-change");
        return result;
      }
      patchedHistoryMethod.__babelHelperPatched = true;
      patchedHistoryMethod.__babelHelperOriginal = original;
      window.history[name] = patchedHistoryMethod;
    }
    function ensureHistoryPatches() {
      if (typeof window.history.pushState === "function" && !window.history.pushState.__babelHelperPatched) {
        patchHistoryMethod("pushState");
      }
      if (typeof window.history.replaceState === "function" && !window.history.replaceState.__babelHelperPatched) {
        patchHistoryMethod("replaceState");
      }
    }
    var URL_POLL_INTERVAL_MS = 500;
    var lastPolledHref = "";
    var urlPollTimer = 0;
    function startUrlPolling() {
      if (urlPollTimer) {
        return;
      }
      lastPolledHref = window.location.href;
      urlPollTimer = window.setInterval(function pollUrl() {
        ensureHistoryPatches();
        var currentHref = window.location.href;
        if (currentHref !== lastPolledHref) {
          lastPolledHref = currentHref;
          handleRouteEvent("url-poll");
        }
      }, URL_POLL_INTERVAL_MS);
    }
    function handleRouteEvent(reason) {
      lastPolledHref = window.location.href;
      resetRouteRefreshWindow();
      helper.runtime.scheduleRouteRefresh(reason);
      if (helper.analytics) {
        helper.analytics.record("session:route-change", {
          reason,
          url: window.location.href
        });
      }
    }
    function handlePopState() {
      handleRouteEvent("popstate");
    }
    function handlePageShow() {
      handleRouteEvent("pageshow");
    }
    function bindRouteWatchers() {
      if (helper.state.routeWatchBound) {
        return;
      }
      patchHistoryMethod("pushState");
      patchHistoryMethod("replaceState");
      window.addEventListener("popstate", handlePopState, true);
      window.addEventListener("pageshow", handlePageShow, true);
      startUrlPolling();
      helper.state.routeWatchBound = true;
    }
    function clearSessionFeatures() {
      stopHotkeysObserver();
      stopHotkeysEnhanceFrame();
      if (typeof helper.resetCutState === "function") {
        helper.resetCutState();
      } else if (typeof helper.clearCutPreview === "function") {
        helper.clearCutPreview();
      }
      if (typeof helper.clearMagnifier === "function") {
        helper.clearMagnifier();
      }
      if (typeof helper.unbindZoomPersistence === "function") {
        helper.unbindZoomPersistence();
      }
      if (typeof helper.setCurrentRow === "function") {
        helper.setCurrentRow(null);
      }
      if (helper.state.sessionActive && helper.analytics) {
        helper.analytics.record("session:end", {
          url: window.location.href,
          summary: helper.analytics.getSummary()
        });
      }
      helper.state.sessionActive = false;
    }
    function bindSessionFeatures() {
      const wasSessionActive = Boolean(helper.state.sessionActive);
      stopRouteRecoveryObserver();
      if (isFeatureEnabled("hotkeysHelp")) {
        if (typeof helper.enhanceHotkeysDialog === "function") {
          helper.enhanceHotkeysDialog();
        }
        startHotkeysObserver();
      } else {
        stopHotkeysObserver();
        stopHotkeysEnhanceFrame();
      }
      if (isFeatureEnabled("timelineSelection") && isFeatureEnabled("timelineZoomDefaults") && typeof helper.bindZoomPersistence === "function") {
        helper.bindZoomPersistence();
      }
      if (!wasSessionActive && isFeatureEnabled("timelineSelection") && isFeatureEnabled("timelineZoomDefaults") && typeof helper.applySavedZoomDefault === "function") {
        void helper.applySavedZoomDefault();
      }
      helper.state.sessionActive = true;
      if (!wasSessionActive && helper.analytics) {
        helper.analytics.record("session:start", {
          url: window.location.href
        });
      }
    }
    helper.runtime.scheduleRouteRefresh = function scheduleRouteRefresh(reason) {
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshTimer = window.setTimeout(() => {
        helper.state.routeRefreshTimer = 0;
        void helper.runtime.refreshRouteSession(reason || "scheduled");
      }, ROUTE_REFRESH_DELAY_MS);
    };
    helper.runtime.refreshRouteSession = function refreshRouteSession(reason) {
      if (!isTranscriptionRoute()) {
        clearSessionFeatures();
        stopRouteRecoveryObserver();
        helper.runtime.clearRuntimeTimer();
        helper.state.routeRefreshAttempts = 0;
        helper.state.routeRefreshWindowStartedAt = 0;
        return false;
      }
      if (isReadOnlyFeedbackRoute()) {
        clearSessionFeatures();
        startRouteRecoveryObserver();
        helper.runtime.clearRuntimeTimer();
        helper.state.routeRefreshAttempts = 0;
        helper.state.routeRefreshWindowStartedAt = 0;
        return false;
      }
      if (hasTranscriptSurface()) {
        bindSessionFeatures();
        if (!helper.state.onLoadedCalled) {
          helper.state.onLoadedCalled = true;
          if (typeof helper.runtime.onLoaded === "function") {
            void helper.runtime.onLoaded();
          }
        }
        helper.runtime.clearRuntimeTimer();
        helper.state.routeRefreshAttempts = 0;
        helper.state.routeRefreshWindowStartedAt = 0;
        return true;
      }
      startRouteRecoveryObserver();
      const startedAt = helper.state.routeRefreshWindowStartedAt || Date.now();
      if (!helper.state.routeRefreshWindowStartedAt) {
        helper.state.routeRefreshWindowStartedAt = startedAt;
      }
      helper.state.routeRefreshAttempts += 1;
      if (helper.state.routeRefreshAttempts >= ROUTE_REFRESH_MAX_ATTEMPTS || Date.now() - startedAt >= ROUTE_REFRESH_MAX_WINDOW_MS) {
        helper.runtime.clearRuntimeTimer();
        return false;
      }
      helper.runtime.scheduleRouteRefresh(reason === "await-surface" ? reason : "await-surface");
      return false;
    };
    helper.init = function init() {
      if (helper.state.runtimeBound) {
        return;
      }
      helper.state.runtimeBound = true;
      bindRouteWatchers();
      bindGlobalListeners();
      helper.bindRowTracking();
      if (isFeatureEnabled("timelineSelection") && typeof helper.bindCutPreview === "function") {
        helper.bindCutPreview();
      }
      if (isFeatureEnabled("magnifier") && typeof helper.bindMagnifier === "function") {
        helper.bindMagnifier();
      }
      resetRouteRefreshWindow();
      void helper.runtime.refreshRouteSession("init");
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", helper.init, { once: true });
    } else {
      helper.init();
    }
  }

  // src/core/disposables.ts
  function createDisposerStack() {
    const disposers = [];
    return {
      add(disposer) {
        disposers.push(disposer);
      },
      flush() {
        while (disposers.length) {
          const disposer = disposers.pop();
          try {
            disposer?.();
          } catch (_error) {
          }
        }
      }
    };
  }

  // src/features/hotkeys-help-feature.ts
  function createHotkeysHelpFeature() {
    return {
      id: "hotkeys-help",
      register(ctx) {
        if (!Array.isArray(ctx.config.hotkeysHelpRows)) {
          ctx.config.hotkeysHelpRows = [];
        }
      }
    };
  }

  // src/features/row-actions-feature.ts
  function createRowActionsFeature() {
    return {
      id: "row-actions",
      register(ctx) {
        if (typeof ctx.services.rows.getTranscriptRows !== "function") {
          ctx.logger.warn("Row service is missing getTranscriptRows");
        }
      }
    };
  }

  // src/features/text-move-feature.ts
  function createTextMoveFeature() {
    return {
      id: "text-move"
    };
  }

  // src/features/focus-toggle-feature.ts
  function createFocusToggleFeature() {
    return {
      id: "focus-toggle"
    };
  }

  // src/features/timeline-selection-feature.ts
  function createTimelineSelectionFeature() {
    return {
      id: "timeline-selection"
    };
  }

  // src/features/magnifier-feature.ts
  function createMagnifierFeature() {
    return {
      id: "magnifier"
    };
  }

  // src/features/minimap-feature.ts
  function createMinimapFeature() {
    return {
      id: "minimap",
      start: async (context) => {
      },
      onLoaded: async (context) => {
        context.services.minimap.bindMinimap();
      },
      stop: async (context) => {
        context.services.minimap.unbindMinimap();
        context.services.minimap.clearMinimap();
      }
    };
  }

  // src/features/quick-region-autocomplete-feature.ts
  var BRIDGE_SCRIPT_PATH2 = "dist/content/quick-region-autocomplete-bridge.js";
  var TOGGLE_EVENT2 = "babel-helper-quick-region-autocomplete-toggle";
  var BRIDGE_SCRIPT_ATTR2 = "data-babel-helper-quick-region-autocomplete-bridge";
  function setBridgeEnabled2(enabled) {
    window.dispatchEvent(
      new CustomEvent(TOGGLE_EVENT2, {
        detail: {
          enabled
        }
      })
    );
  }
  function injectBridge2() {
    if (document.querySelector(`script[${BRIDGE_SCRIPT_ATTR2}="true"]`)) {
      return Promise.resolve(true);
    }
    const chromeApi = globalThis.chrome;
    if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.getURL !== "function") {
      return Promise.resolve(false);
    }
    const root = document.documentElement || document.head || document.body;
    if (!(root instanceof HTMLElement)) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.setAttribute(BRIDGE_SCRIPT_ATTR2, "true");
      script.src = chromeApi.runtime.getURL(BRIDGE_SCRIPT_PATH2);
      script.async = false;
      script.onload = () => {
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        resolve(false);
      };
      root.appendChild(script);
    });
  }
  function createQuickRegionAutocompleteFeature() {
    let startPromise = null;
    return {
      id: "quick-region-autocomplete",
      async start(ctx) {
        if (!startPromise) {
          startPromise = injectBridge2();
        }
        const ready = await startPromise;
        if (!ready) {
          startPromise = null;
          ctx.logger.warn("Quick region autocomplete bridge did not load");
          return;
        }
        setBridgeEnabled2(true);
      },
      stop() {
        setBridgeEnabled2(false);
      }
    };
  }

  // src/features/wavesurfer-tooltip-ellipsis-feature.ts
  var STYLE_ID = "babel-helper-wavesurfer-tooltip-ellipsis";
  var WAVESURFER_TOOLTIP_ELLIPSIS_CSS = `
  .wavesurfer-region-label-tooltip > span {
    width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`.trim();
  function createWavesurferTooltipEllipsisFeature() {
    return {
      id: "wavesurfer-tooltip-ellipsis",
      start() {
        if (!(document.head instanceof HTMLHeadElement)) {
          return;
        }
        let style = document.getElementById(STYLE_ID);
        if (!(style instanceof HTMLStyleElement)) {
          style = document.createElement("style");
          style.id = STYLE_ID;
          document.head.appendChild(style);
        }
        style.textContent = WAVESURFER_TOOLTIP_ELLIPSIS_CSS;
      },
      stop() {
        document.getElementById(STYLE_ID)?.remove();
      }
    };
  }

  // src/features/index.ts
  var FEATURE_ID_TO_SETTING_KEY = {
    "hotkeys-help": "hotkeysHelp",
    "row-actions": "rowActions",
    "text-move": "textMove",
    "quick-region-autocomplete": "quickRegionAutocomplete",
    "focus-toggle": "focusToggle",
    "timeline-selection": "timelineSelection",
    magnifier: "magnifier",
    minimap: "minimap",
    "custom-linter": "customLinter",
    "wavesurfer-tooltip-ellipsis": "wavesurferTooltipEllipsis"
  };
  function createFeatureModules(featureSettings) {
    const modules = [
      createHotkeysHelpFeature(),
      createRowActionsFeature(),
      createTextMoveFeature(),
      createFocusToggleFeature(),
      createTimelineSelectionFeature(),
      createMagnifierFeature(),
      createMinimapFeature(),
      createCustomLinterFeature(),
      createQuickRegionAutocompleteFeature(),
      createWavesurferTooltipEllipsisFeature()
    ];
    return modules.filter((module) => {
      const settingKey = FEATURE_ID_TO_SETTING_KEY[module.id];
      if (!settingKey) {
        return true;
      }
      return featureSettings[settingKey];
    });
  }

  // src/core/analytics-store.ts
  var DEFAULT_MAX_EVENTS = 2e3;
  var STORAGE_KEY = "babel_helper_analytics";
  var PERSIST_DEBOUNCE_MS = 5e3;
  var TEXT_EDIT_SAMPLE_INTERVAL_MS = 2e3;
  function createAnalyticsStore(options) {
    const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    const events = [];
    let seq = 0;
    let persistTimer = null;
    let lastTextEditTs = 0;
    const escCycle = {
      blurAt: null,
      blurHrt: null,
      blurPlaybackTime: null,
      blurState: null,
      blurRowId: null,
      blurCursorPos: null,
      blurTextLength: null
    };
    const counters = {
      sessionStartedAt: Date.now(),
      totalEscPresses: 0,
      escStates: {},
      escCycleDurations: [],
      blurDurations: [],
      totalTextEdits: 0,
      totalTextMoves: 0,
      totalMerges: 0,
      totalSmartSplits: 0,
      totalSeeks: 0,
      totalFocusRestores: 0,
      proportionalRestoreCount: 0,
      fallbackRestoreCount: 0,
      ghostCursorStarts: 0
    };
    function record(type, data) {
      seq += 1;
      const event = {
        seq,
        type,
        ts: Date.now(),
        hrt: typeof performance !== "undefined" ? performance.now() : 0,
        data
      };
      events.push(event);
      if (events.length > maxEvents) {
        events.shift();
      }
      updateCounters(event);
      schedulePersist();
      return event;
    }
    function updateCounters(event) {
      const { type, data } = event;
      if (type === "hotkey:escape") {
        counters.totalEscPresses += 1;
      }
      if (type.startsWith("esc:state")) {
        const stateKey = type.split(":")[1] || type;
        counters.escStates[stateKey] = (counters.escStates[stateKey] || 0) + 1;
      }
      if (type === "timing:esc-cycle" && data && typeof data.durationMs === "number") {
        counters.escCycleDurations.push(data.durationMs);
        if (counters.escCycleDurations.length > 100) {
          counters.escCycleDurations.shift();
        }
      }
      if (type === "focus:blur" && data && typeof data.durationSinceRestoreMs === "number") {
        counters.blurDurations.push(data.durationSinceRestoreMs);
        if (counters.blurDurations.length > 100) {
          counters.blurDurations.shift();
        }
      }
      if (type === "text:edit") counters.totalTextEdits += 1;
      if (type === "text:move-left" || type === "text:move-right") counters.totalTextMoves += 1;
      if (type === "text:merge-previous" || type === "text:merge-next") counters.totalMerges += 1;
      if (type === "text:smart-split") counters.totalSmartSplits += 1;
      if (type === "playback:seek") counters.totalSeeks += 1;
      if (type === "focus:restore" || type === "focus:restore-proportional" || type === "focus:restore-fallback") {
        counters.totalFocusRestores += 1;
      }
      if (type === "focus:restore-proportional") counters.proportionalRestoreCount += 1;
      if (type === "focus:restore-fallback") counters.fallbackRestoreCount += 1;
      if (type === "ghost:start") counters.ghostCursorStarts += 1;
    }
    function startEscCycle(state, data) {
      escCycle.blurAt = Date.now();
      escCycle.blurHrt = typeof performance !== "undefined" ? performance.now() : 0;
      escCycle.blurState = state;
      escCycle.blurPlaybackTime = data?.playbackTime ?? null;
      escCycle.blurRowId = data?.rowId ?? null;
      escCycle.blurCursorPos = data?.cursorPos ?? null;
      escCycle.blurTextLength = data?.textLength ?? null;
    }
    function endEscCycle(restoreData) {
      if (escCycle.blurAt === null) return;
      const now = Date.now();
      const hrtNow = typeof performance !== "undefined" ? performance.now() : 0;
      const durationMs = escCycle.blurHrt !== null && hrtNow > 0 ? hrtNow - escCycle.blurHrt : now - escCycle.blurAt;
      record("timing:esc-cycle", {
        durationMs: Math.round(durationMs),
        blurState: escCycle.blurState,
        blurPlaybackTime: escCycle.blurPlaybackTime,
        restorePlaybackTime: restoreData?.playbackTime ?? null,
        blurCursorPos: escCycle.blurCursorPos,
        restoreCursorPos: restoreData?.cursorPos ?? null,
        proportional: restoreData?.proportional ?? false,
        blurRowId: escCycle.blurRowId,
        restoreRowId: restoreData?.rowId ?? null,
        sameRow: escCycle.blurRowId != null && escCycle.blurRowId === restoreData?.rowId,
        blurTextLength: escCycle.blurTextLength
      });
      escCycle.blurAt = null;
      escCycle.blurHrt = null;
      escCycle.blurPlaybackTime = null;
      escCycle.blurState = null;
      escCycle.blurRowId = null;
      escCycle.blurCursorPos = null;
      escCycle.blurTextLength = null;
    }
    function recordTextEdit(data) {
      const now = Date.now();
      if (now - lastTextEditTs < TEXT_EDIT_SAMPLE_INTERVAL_MS) return;
      lastTextEditTs = now;
      record("text:edit", data);
    }
    function schedulePersist() {
      if (persistTimer !== null) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistToStorage();
      }, PERSIST_DEBOUNCE_MS);
    }
    async function persistToStorage() {
      try {
        const chromeApi = globalThis.chrome;
        if (!chromeApi?.storage?.local) return;
        const payload = {
          version: 1,
          persistedAt: Date.now(),
          summary: getSummary(),
          // Only persist last 500 events to keep storage small
          recentEvents: events.slice(-500)
        };
        await new Promise((resolve) => {
          chromeApi.storage.local.set({ [STORAGE_KEY]: payload }, () => {
            resolve();
          });
        });
      } catch (_e) {
      }
    }
    function getSummary() {
      const avgEscCycle = counters.escCycleDurations.length > 0 ? Math.round(counters.escCycleDurations.reduce((a, b) => a + b, 0) / counters.escCycleDurations.length) : null;
      const avgBlurTime = counters.blurDurations.length > 0 ? Math.round(counters.blurDurations.reduce((a, b) => a + b, 0) / counters.blurDurations.length) : null;
      return {
        sessionStartedAt: counters.sessionStartedAt,
        totalEscPresses: counters.totalEscPresses,
        escStateDistribution: { ...counters.escStates },
        avgEscCycleDurationMs: avgEscCycle,
        totalTextEdits: counters.totalTextEdits,
        totalTextMoves: counters.totalTextMoves,
        totalMerges: counters.totalMerges,
        totalSmartSplits: counters.totalSmartSplits,
        totalSeeks: counters.totalSeeks,
        totalFocusRestores: counters.totalFocusRestores,
        proportionalRestoreCount: counters.proportionalRestoreCount,
        fallbackRestoreCount: counters.fallbackRestoreCount,
        ghostCursorStarts: counters.ghostCursorStarts,
        avgTimeInBlurredStateMs: avgBlurTime,
        eventCount: events.length
      };
    }
    function getEvents(filter) {
      let result = events;
      if (filter?.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        const typeSet = new Set(types);
        result = result.filter((e) => typeSet.has(e.type));
      }
      if (filter?.last && filter.last > 0) {
        result = result.slice(-filter.last);
      }
      return result;
    }
    function getEscWorkflowHistory(count = 20) {
      return getEvents({ type: [
        "esc:state1:focused-playing",
        "esc:state2:unfocused-playing",
        "esc:state3:focused-notplaying",
        "esc:state4:unfocused-notplaying",
        "timing:esc-cycle"
      ], last: count });
    }
    function getRecentTimeline(count = 50) {
      return events.slice(-count);
    }
    function dump() {
      const summary = getSummary();
      console.group("[babel-analytics] Session Summary");
      console.table(summary);
      console.groupEnd();
      console.group("[babel-analytics] Esc Workflow History (last 20)");
      console.table(getEscWorkflowHistory());
      console.groupEnd();
      console.group("[babel-analytics] Recent Timeline (last 50)");
      console.table(getRecentTimeline());
      console.groupEnd();
    }
    const store = {
      record,
      recordTextEdit,
      startEscCycle,
      endEscCycle,
      getSummary,
      getEvents,
      getEscWorkflowHistory,
      getRecentTimeline,
      dump,
      get escCycle() {
        return escCycle;
      },
      get eventCount() {
        return events.length;
      },
      get allEvents() {
        return events.slice();
      }
    };
    try {
      window.__babelAnalytics = store;
    } catch (_e) {
    }
    return store;
  }

  // src/core/kernel.ts
  function cloneSettings(settings) {
    return normalizeExtensionSettings(settings);
  }
  function createHelperKernel() {
    const state = createState();
    let settings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);
    const config = createConfig(settings.features);
    const analytics = createAnalyticsStore();
    const helper = {
      config,
      settings,
      state,
      analytics,
      isFeatureEnabled(featureKey) {
        return Boolean(helper.settings?.features?.[featureKey]);
      },
      runtime: {
        clearRuntimeTimer() {
          const timer = helper.state.routeRefreshTimer;
          if (timer) {
            window.clearTimeout(timer);
          }
          helper.state.routeRefreshTimer = 0;
        },
        scheduleRouteRefresh() {
          return false;
        },
        refreshRouteSession() {
          return false;
        },
        isSessionInteractive() {
          return false;
        },
        onLoaded() {
          return runFeatures("onLoaded");
        }
      },
      isEditable,
      isVisible,
      normalizeText,
      setEditableValue,
      dispatchClick,
      sleep,
      waitFor
    };
    function applySettings(nextSettings) {
      settings = cloneSettings(nextSettings);
      helper.settings = settings;
      const nextConfig = createConfig(settings.features);
      Object.assign(helper.config, nextConfig);
    }
    function registerServices() {
      registerRowService(helper);
      if (helper.isFeatureEnabled("hotkeysHelp")) {
        registerHotkeysHelpService(helper);
      }
      if (helper.isFeatureEnabled("timelineSelection")) {
        registerTimelineSelectionService(helper);
      }
      if (helper.isFeatureEnabled("magnifier")) {
        registerMagnifierService(helper);
      }
      if (helper.isFeatureEnabled("minimap")) {
        registerMinimapService(helper);
      }
    }
    const services = {
      session: {
        isInteractive: () => helper.runtime.isSessionInteractive()
      },
      rows: helper,
      actions: helper,
      focus: helper,
      hotkeysHelp: helper,
      timelineSelection: helper,
      smartSplit: helper,
      magnifier: helper,
      minimap: helper,
      bridge: helper
    };
    const logger = createLogger("kernel");
    const disposerStack = createDisposerStack();
    const featureContext = {
      helper,
      services,
      state,
      config,
      runtime: helper.runtime,
      onDispose: (disposer) => disposerStack.add(disposer),
      logger
    };
    let features = [];
    const runFeatures = async (method) => {
      for (const feature of features) {
        const fn = feature[method];
        if (typeof fn === "function") {
          await fn(featureContext);
        }
      }
    };
    return {
      helper,
      async start() {
        const loadedSettings = await loadExtensionSettings();
        applySettings(loadedSettings);
        registerServices();
        features = createFeatureModules(helper.settings.features);
        await runFeatures("register");
        await runFeatures("start");
        registerLifecycle(helper);
      },
      async onLoaded() {
        await runFeatures("onLoaded");
      },
      async stop() {
        await runFeatures("stop");
        disposerStack.flush();
        if (typeof helper.unbindCutPreview === "function") {
          helper.unbindCutPreview();
        }
        if (typeof helper.unbindMagnifier === "function") {
          helper.unbindMagnifier();
        }
        if (typeof helper.unbindZoomPersistence === "function") {
          helper.unbindZoomPersistence();
        }
        if (typeof helper.unbindRowTracking === "function") {
          helper.unbindRowTracking();
        }
      }
    };
  }

  // src/content/entry.ts
  function boot() {
    const kernel = createHelperKernel();
    void kernel.start();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
//# sourceMappingURL=entry.js.map
