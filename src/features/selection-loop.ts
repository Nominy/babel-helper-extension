// @ts-nocheck
import type { TimelineModules } from '../services/timeline-selection-service';
import { captureL0TaskGuard } from '../services/l0-timing-identity';

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


  function showLoopFailure(preview, reason, message = '') {
    const text = 'Loop unavailable: ' + (message || reason || 'native playback unavailable');
    setSelectionLoopDebug(reason || 'bridge-failed', { message: text });
    const label = preview.element?.querySelector('[data-babel-helper-cut-label]');
    if (label instanceof HTMLElement) {
      label.textContent = text;
      label.style.display = 'block';
      label.setAttribute('role', 'status');
    }
  }

  helper.stopSelectionLoop = function stopSelectionLoop(notifyNative = true) {
    const loop = helper.state.selectionLoop;
    if (!loop) return;
    helper.state.selectionLoop = null;
    loop.unsubscribe?.();
    if (notifyNative && loop.hostMarker) {
      void api.site.callSelectionBridge('loop-stop', { hostMarker: loop.hostMarker })
        .then((result) => {
          if (!result?.ok && helper.state.cutPreview === loop.preview) {
            showLoopFailure(loop.preview, result?.reason, result?.message);
          }
        }).catch((error) => showLoopFailure(loop.preview, 'bridge-failed', String(error)));
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

    const isCurrentTask = captureL0TaskGuard({ includeAudioVariant: true });
    const timeRange = await api.selection.ensurePreviewTimeRange(preview);
    if (!timeRange || !isCurrentTask() || helper.state.cutPreview !== preview) {
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
    if (!(host instanceof HTMLElement)) {
      showLoopFailure(preview, 'missing-waveform-host');
      return false;
    }
    const hostMarker = preview.hostMarker || ensureSelectionHostMarker(preview.container);
    if (!hostMarker) {
      showLoopFailure(preview, 'missing-waveform-host');
      return false;
    }
    preview.hostMarker = hostMarker;
    const loop = {
      preview, host, hostMarker, kind: 'bridge',
      startSeconds: timeRange.startSeconds, endSeconds: timeRange.endSeconds,
      unsubscribe: null
    };
    const onLoopState = (event) => {
      if (event.detail?.hostMarker !== hostMarker || helper.state.selectionLoop !== loop) return;
      // Explicit stops already clear isolated ownership. A queued stop for the
      // previous range may arrive after this range has installed its listener.
      if (event.detail.reason === 'stopped') return;
      helper.stopSelectionLoop(false);
      const { reason, message } = event.detail;
      if (reason?.includes('failed')) showLoopFailure(preview, reason, message);
      else setSelectionLoopDebug(reason || 'stopped');
    };
    window.addEventListener('babel-helper-selection-loop-state', onLoopState);
    loop.unsubscribe = () => window.removeEventListener('babel-helper-selection-loop-state', onLoopState);
    helper.state.selectionLoop = loop;
    try {
      const result = await api.site.callSelectionBridge('loop-start', {
        hostMarker, startSeconds: timeRange.startSeconds, endSeconds: timeRange.endSeconds
      });
      if (helper.state.selectionLoop !== loop) return false;
      if (!isCurrentTask() || helper.state.cutPreview !== preview || !host.isConnected) {
        helper.stopSelectionLoop();
        return false;
      }
      if (!result?.ok) {
        helper.stopSelectionLoop();
        showLoopFailure(preview, result?.reason, result?.message);
        return false;
      }
      setSelectionLoopDebug('started', {
        startSeconds: timeRange.startSeconds, endSeconds: timeRange.endSeconds, kind: 'bridge'
      });
      return true;
    } catch (error) {
      if (helper.state.selectionLoop === loop) {
        helper.stopSelectionLoop();
        showLoopFailure(preview, 'bridge-failed', String(error?.message || error));
      }
      return false;
    }
  };

  return { ensureSelectionHostMarker, SELECTION_LOOP_HOST_ATTR, setSelectionLoopDebug };
}
