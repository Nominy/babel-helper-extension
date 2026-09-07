// @ts-nocheck
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerSelectionLoop(helper: any, api: Pick<TimelineModules, 'site' | 'selection'>) {
  const SELECTION_LOOP_HOST_ATTR = 'data-babel-helper-selection-loop-host';

  helper.state.selectionLoop = null;


  function setSelectionLoopDebug(stage, details) {
    const root = document.documentElement;
    if (!(root instanceof HTMLElement)) {
      return;
    }

    root.dataset.babelHelperSelectionLoopStage = stage || '';
    if (details && typeof details === 'object') {
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
    return 'selection-loop-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }


  function ensureSelectionHostMarker(container) {
    const host = api.site.getWaveformHostFromContainer(container);
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


  helper.stopSelectionLoop = function stopSelectionLoop() {
    const loop = helper.state.selectionLoop;
    if (!loop) {
      return;
    }

    if (loop.timer) {
      window.clearInterval(loop.timer);
    }

    if (loop.hostMarker) {
      void api.site.callSelectionBridge('loop-stop', {
        hostMarker: loop.hostMarker
      });
    }

    const activePreview = helper.state.cutPreview;
    const previewOwnsMarker =
      activePreview &&
      activePreview.hostMarker &&
      activePreview.hostMarker === loop.hostMarker;

    if (
      loop.host instanceof HTMLElement &&
      loop.hostMarker &&
      loop.host.getAttribute(SELECTION_LOOP_HOST_ATTR) === loop.hostMarker &&
      !previewOwnsMarker
    ) {
      loop.host.removeAttribute(SELECTION_LOOP_HOST_ATTR);
    }

    helper.state.selectionLoop = null;
  };


  helper.startSelectionLoop = async function startSelectionLoop() {
    const preview = helper.state.cutPreview;
    if (!preview || helper.state.cutCommitPending) {
      setSelectionLoopDebug(!preview ? 'no-preview' : 'commit-pending');
      return false;
    }

    const timeRange = await api.selection.ensurePreviewTimeRange(preview);
    if (!timeRange) {
      setSelectionLoopDebug('no-time-range');
      return false;
    }

    const existing = helper.state.selectionLoop;
    if (
      existing &&
      existing.preview === preview &&
      Math.abs(existing.startSeconds - timeRange.startSeconds) < 0.01 &&
      Math.abs(existing.endSeconds - timeRange.endSeconds) < 0.01
    ) {
      setSelectionLoopDebug('toggle-off', {
        startSeconds: timeRange.startSeconds,
        endSeconds: timeRange.endSeconds,
        kind: existing.kind || 'unknown'
      });
      helper.stopSelectionLoop();
      return true;
    }

    helper.stopSelectionLoop();

    const host = api.site.getWaveformHostFromContainer(preview.container);
    if (host instanceof HTMLElement) {
      const hostMarker =
        preview.hostMarker ||
        ensureSelectionHostMarker(preview.container);
      if (!hostMarker) {
        return false;
      }
      preview.hostMarker = hostMarker;
      const bridgeResult = await api.site.callSelectionBridge('loop-start', {
        hostMarker,
        startSeconds: timeRange.startSeconds,
        endSeconds: timeRange.endSeconds
      });
      if (bridgeResult && bridgeResult.ok) {
        helper.state.selectionLoop = {
          preview,
          host,
          kind: 'bridge',
          hostMarker,
          startSeconds: timeRange.startSeconds,
          endSeconds: timeRange.endSeconds,
          timer: null
        };
        setSelectionLoopDebug('started', {
          startSeconds: timeRange.startSeconds,
          endSeconds: timeRange.endSeconds,
          kind: 'bridge'
        });
        return true;
      }

      if (bridgeResult && bridgeResult.reason) {
        setSelectionLoopDebug('bridge-' + bridgeResult.reason);
      } else {
        setSelectionLoopDebug('bridge-failed');
      }
    }

    const playback = api.selection.getSelectionPlaybackTarget(preview);
    if (!playback) {
      setSelectionLoopDebug('no-playback');
      return false;
    }

    const loop = {
      preview,
      playback,
      kind: playback.kind || 'unknown',
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
        setSelectionLoopDebug('lost-preview');
        helper.stopSelectionLoop();
        return;
      }

      const currentRange = api.selection.getPreviewTimeRange(activePreview);
      if (!currentRange) {
        setSelectionLoopDebug('lost-range');
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
          setSelectionLoopDebug('escaped-range', {
            currentTime,
            startSeconds: loop.startSeconds,
            endSeconds: loop.endSeconds,
            delta
          });
          helper.stopSelectionLoop();
          return;
        }

        if (delta < -0.08 || delta > 0.35) {
          setSelectionLoopDebug('user-move', {
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
        const playResult =
          typeof loop.playback.playRange === 'function'
            ? loop.playback.playRange(loop.startSeconds, loop.endSeconds)
            : (loop.playback.setTime(loop.startSeconds), loop.playback.play());
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch(() => { });
        }
        loop.lastTime = loop.startSeconds;
        return;
      }

      loop.lastTime = currentTime;
    };

    if (
      !Number.isFinite(loop.lastTime) ||
      loop.lastTime < loop.startSeconds ||
      loop.lastTime > loop.endSeconds
    ) {
      loop.internalSeekUntil = Date.now() + 220;
      loop.lastTime = loop.startSeconds;
    }

    const playResult =
      typeof loop.playback.playRange === 'function'
        ? loop.playback.playRange(loop.startSeconds, loop.endSeconds)
        : (loop.playback.setTime(loop.startSeconds), loop.playback.play());
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => { });
    }

    loop.timer = window.setInterval(runTick, 40);
    helper.state.selectionLoop = loop;
    setSelectionLoopDebug('started', {
      startSeconds: loop.startSeconds,
      endSeconds: loop.endSeconds,
      kind: loop.playback.kind || 'unknown'
    });
    return true;
  };

  return { ensureSelectionHostMarker, SELECTION_LOOP_HOST_ATTR, setSelectionLoopDebug };
}
