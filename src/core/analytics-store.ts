// Analytics store: non-invasive ring-buffer event logger for workflow analysis.
// Tracks Escape workflow transitions, text interactions, focus/blur cycles,
// ghost cursor lifecycle, playback state, keyboard shortcuts, and timing data.
//
// Design goals:
// - Zero impact on existing functionality (append-only logging)
// - Bounded memory via ring buffer (default 2000 events)
// - Session-scoped with optional chrome.storage persistence
// - Console-accessible for inspection: window.__babelAnalytics

// ---------------------------------------------------------------------------
// Event type definitions
// ---------------------------------------------------------------------------

export type AnalyticsEventType =
  // Escape workflow (4-state machine)
  | 'esc:state1:focused-playing'       // Esc while focused + playing -> pause
  | 'esc:state2:unfocused-playing'     // Esc while unfocused + playing -> restore focus + pause
  | 'esc:state3:focused-notplaying'    // Esc while focused + not playing -> blur + play
  | 'esc:state4:unfocused-notplaying'  // Esc while unfocused + not playing -> bootstrap + play
  | 'esc:queued'                       // Escape task queued
  | 'esc:playback-query'               // Playback state queried during Esc

  // Focus / blur
  | 'focus:blur'                       // Editor blurred (toggle out)
  | 'focus:restore'                    // Editor focus restored (toggle in)
  | 'focus:restore-proportional'       // Proportional cursor restore applied
  | 'focus:restore-fallback'           // Fallback focus (row lookup by time, etc.)
  | 'focus:restore-failed'             // Could not restore focus

  // Ghost cursor
  | 'ghost:start'                      // Ghost cursor started
  | 'ghost:stop'                       // Ghost cursor stopped
  | 'ghost:row-switch'                 // Ghost cursor switched to different row

  // Cursor / selection
  | 'cursor:baseline-update'           // cursorBaseline updated by user interaction
  | 'cursor:proportional-offset'       // Proportional offset computed
  | 'cursor:word-snap'                 // Word boundary snap applied

  // Text operations
  | 'text:move-left'                   // Alt+[ text move
  | 'text:move-right'                  // Alt+] text move
  | 'text:merge-previous'              // Alt+Shift+Up merge
  | 'text:merge-next'                  // Alt+Shift+Down merge
  | 'text:smart-split'                 // Smart split applied
  | 'text:edit'                        // User typed in textarea (sampled)

  // Playback
  | 'playback:pause'                   // Playback paused
  | 'playback:resume'                  // Playback resumed
  | 'playback:seek'                    // Playback seek (rewind)
  | 'playback:state-query'             // Playback state queried

  // Keyboard shortcuts
  | 'hotkey:escape'                    // Esc pressed
  | 'hotkey:delete'                    // Delete/D pressed
  | 'hotkey:speaker-switch'            // Alt+1/2 speaker switch
  | 'hotkey:speaker-reset'             // Alt+~ reset
  | 'hotkey:text-move'                 // Alt+[/] text move
  | 'hotkey:merge'                     // Alt+Shift+Arrow merge
  | 'hotkey:rewind'                    // Alt+X rewind
  | 'hotkey:cut-preview'               // Cut preview keydown (S/Shift+S/L)
  | 'hotkey:arrow-suppressed'          // Native arrow seek suppressed

  // Row tracking
  | 'row:focus-in'                     // Row focused via focusin
  | 'row:pointer-down'                 // Row tracked via pointerdown
  | 'row:set-current'                  // setCurrentRow called
  | 'row:identity-resolved'            // Row identity resolved after stale reference

  // Session
  | 'session:start'                    // Session became interactive
  | 'session:end'                      // Session became non-interactive
  | 'session:route-change'             // Route changed

  // Timing
  | 'timing:esc-cycle'                 // Full Esc cycle timing (blur -> listen -> restore)
  | 'timing:focus-restore'             // Time from Esc press to focus restored
  | 'timing:playback-bridge';          // Playback bridge call latency

export interface AnalyticsEvent {
  /** Monotonic sequence number */
  seq: number;
  /** Event type */
  type: AnalyticsEventType;
  /** Wall-clock timestamp (ms since epoch) */
  ts: number;
  /** High-resolution timestamp (performance.now) for timing */
  hrt: number;
  /** Arbitrary payload - kept small and serializable */
  data?: Record<string, unknown>;
}

export interface EscCycleState {
  /** When the current Esc cycle started (blur phase) */
  blurAt: number | null;
  blurHrt: number | null;
  /** Playback time at blur */
  blurPlaybackTime: number | null;
  /** Which Esc state triggered the blur */
  blurState: number | null;
  /** Row annotation ID at blur */
  blurRowId: string | null;
  /** Cursor position at blur */
  blurCursorPos: number | null;
  /** Text length at blur */
  blurTextLength: number | null;
}

export interface AnalyticsSessionSummary {
  sessionStartedAt: number;
  totalEscPresses: number;
  escStateDistribution: Record<string, number>;
  avgEscCycleDurationMs: number | null;
  totalTextEdits: number;
  totalTextMoves: number;
  totalMerges: number;
  totalSmartSplits: number;
  totalSeeks: number;
  totalFocusRestores: number;
  proportionalRestoreCount: number;
  fallbackRestoreCount: number;
  ghostCursorStarts: number;
  avgTimeInBlurredStateMs: number | null;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Analytics store implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_EVENTS = 2000;
const STORAGE_KEY = 'babel_helper_analytics';
const PERSIST_DEBOUNCE_MS = 5000;
const TEXT_EDIT_SAMPLE_INTERVAL_MS = 2000; // Don't log every keystroke

export function createAnalyticsStore(options?: { maxEvents?: number }) {
  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
  const events: AnalyticsEvent[] = [];
  let seq = 0;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTextEditTs = 0;

  // Esc cycle tracking
  const escCycle: EscCycleState = {
    blurAt: null,
    blurHrt: null,
    blurPlaybackTime: null,
    blurState: null,
    blurRowId: null,
    blurCursorPos: null,
    blurTextLength: null
  };

  // Session counters for quick summaries
  const counters = {
    sessionStartedAt: Date.now(),
    totalEscPresses: 0,
    escStates: {} as Record<string, number>,
    escCycleDurations: [] as number[],
    blurDurations: [] as number[],
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

  function record(type: AnalyticsEventType, data?: Record<string, unknown>): AnalyticsEvent {
    seq += 1;
    const event: AnalyticsEvent = {
      seq,
      type,
      ts: Date.now(),
      hrt: typeof performance !== 'undefined' ? performance.now() : 0,
      data
    };

    events.push(event);

    // Ring buffer: drop oldest when full
    if (events.length > maxEvents) {
      events.shift();
    }

    // Update counters
    updateCounters(event);

    // Schedule persistence
    schedulePersist();

    return event;
  }

  function updateCounters(event: AnalyticsEvent) {
    const { type, data } = event;

    if (type === 'hotkey:escape') {
      counters.totalEscPresses += 1;
    }

    if (type.startsWith('esc:state')) {
      const stateKey = type.split(':')[1] || type;
      counters.escStates[stateKey] = (counters.escStates[stateKey] || 0) + 1;
    }

    if (type === 'timing:esc-cycle' && data && typeof data.durationMs === 'number') {
      counters.escCycleDurations.push(data.durationMs as number);
      // Keep only last 100 for averaging
      if (counters.escCycleDurations.length > 100) {
        counters.escCycleDurations.shift();
      }
    }

    if (type === 'focus:blur' && data && typeof data.durationSinceRestoreMs === 'number') {
      counters.blurDurations.push(data.durationSinceRestoreMs as number);
      if (counters.blurDurations.length > 100) {
        counters.blurDurations.shift();
      }
    }

    if (type === 'text:edit') counters.totalTextEdits += 1;
    if (type === 'text:move-left' || type === 'text:move-right') counters.totalTextMoves += 1;
    if (type === 'text:merge-previous' || type === 'text:merge-next') counters.totalMerges += 1;
    if (type === 'text:smart-split') counters.totalSmartSplits += 1;
    if (type === 'playback:seek') counters.totalSeeks += 1;
    if (type === 'focus:restore' || type === 'focus:restore-proportional' || type === 'focus:restore-fallback') {
      counters.totalFocusRestores += 1;
    }
    if (type === 'focus:restore-proportional') counters.proportionalRestoreCount += 1;
    if (type === 'focus:restore-fallback') counters.fallbackRestoreCount += 1;
    if (type === 'ghost:start') counters.ghostCursorStarts += 1;
  }

  // --- Esc cycle helpers ---

  function startEscCycle(state: number, data?: {
    playbackTime?: number | null;
    rowId?: string | null;
    cursorPos?: number | null;
    textLength?: number | null;
  }) {
    escCycle.blurAt = Date.now();
    escCycle.blurHrt = typeof performance !== 'undefined' ? performance.now() : 0;
    escCycle.blurState = state;
    escCycle.blurPlaybackTime = data?.playbackTime ?? null;
    escCycle.blurRowId = data?.rowId ?? null;
    escCycle.blurCursorPos = data?.cursorPos ?? null;
    escCycle.blurTextLength = data?.textLength ?? null;
  }

  function endEscCycle(restoreData?: {
    playbackTime?: number | null;
    cursorPos?: number | null;
    proportional?: boolean;
    rowId?: string | null;
  }) {
    if (escCycle.blurAt === null) return;

    const now = Date.now();
    const hrtNow = typeof performance !== 'undefined' ? performance.now() : 0;
    const durationMs = escCycle.blurHrt !== null && hrtNow > 0
      ? hrtNow - escCycle.blurHrt
      : now - escCycle.blurAt;

    record('timing:esc-cycle', {
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

    // Reset
    escCycle.blurAt = null;
    escCycle.blurHrt = null;
    escCycle.blurPlaybackTime = null;
    escCycle.blurState = null;
    escCycle.blurRowId = null;
    escCycle.blurCursorPos = null;
    escCycle.blurTextLength = null;
  }

  // --- Text edit sampling ---

  function recordTextEdit(data?: Record<string, unknown>) {
    const now = Date.now();
    if (now - lastTextEditTs < TEXT_EDIT_SAMPLE_INTERVAL_MS) return;
    lastTextEditTs = now;
    record('text:edit', data);
  }

  // --- Persistence ---

  function schedulePersist() {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistToStorage();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function persistToStorage() {
    try {
      const chromeApi = (globalThis as { chrome?: any }).chrome;
      if (!chromeApi?.storage?.local) return;

      const payload = {
        version: 1,
        persistedAt: Date.now(),
        summary: getSummary(),
        // Only persist last 500 events to keep storage small
        recentEvents: events.slice(-500)
      };

      await new Promise<void>((resolve) => {
        chromeApi.storage.local.set({ [STORAGE_KEY]: payload }, () => {
          resolve();
        });
      });
    } catch (_e) {
      // Never let analytics persistence break anything
    }
  }

  // --- Summary ---

  function getSummary(): AnalyticsSessionSummary {
    const avgEscCycle = counters.escCycleDurations.length > 0
      ? Math.round(counters.escCycleDurations.reduce((a, b) => a + b, 0) / counters.escCycleDurations.length)
      : null;

    const avgBlurTime = counters.blurDurations.length > 0
      ? Math.round(counters.blurDurations.reduce((a, b) => a + b, 0) / counters.blurDurations.length)
      : null;

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

  // --- Query helpers ---

  function getEvents(filter?: { type?: AnalyticsEventType | AnalyticsEventType[]; last?: number }) {
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
      'esc:state1:focused-playing',
      'esc:state2:unfocused-playing',
      'esc:state3:focused-notplaying',
      'esc:state4:unfocused-notplaying',
      'timing:esc-cycle'
    ], last: count });
  }

  function getRecentTimeline(count = 50) {
    return events.slice(-count);
  }

  // --- Dump to console ---

  function dump() {
    const summary = getSummary();
    console.group('[babel-analytics] Session Summary');
    console.table(summary);
    console.groupEnd();

    console.group('[babel-analytics] Esc Workflow History (last 20)');
    console.table(getEscWorkflowHistory());
    console.groupEnd();

    console.group('[babel-analytics] Recent Timeline (last 50)');
    console.table(getRecentTimeline());
    console.groupEnd();
  }

  // --- Public API ---

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
    get escCycle() { return escCycle; },
    get eventCount() { return events.length; },
    get allEvents() { return events.slice(); }
  };

  // Expose on window for console access
  try {
    (window as any).__babelAnalytics = store;
  } catch (_e) {
    // Ignore if window not available
  }

  return store;
}

export type AnalyticsStore = ReturnType<typeof createAnalyticsStore>;
