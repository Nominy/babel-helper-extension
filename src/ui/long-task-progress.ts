// @ts-nocheck
import type { TimelineModules } from '../services/timeline-selection-service';

export function createLongTaskProgress(helper: any, api: Pick<TimelineModules, 'site'>) {
  const LONG_TASK_PROGRESS_ID = 'babel-helper-long-task-progress';

  const L0_TRANSCRIPTION_FAILURE_DISMISS_MS = 18000;

  helper.state.longTaskProgress = null;


  function ensureLongTaskProgress() {
    let progress = helper.state.longTaskProgress;
    if (
      progress &&
      progress.root instanceof HTMLElement &&
      progress.fill instanceof HTMLElement &&
      progress.label instanceof HTMLElement &&
      progress.detail instanceof HTMLElement &&
      document.documentElement.contains(progress.root)
    ) {
      return progress;
    }

    const root = document.createElement('div');
    root.id = LONG_TASK_PROGRESS_ID;
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.style.position = 'fixed';
    root.style.right = '18px';
    root.style.bottom = '18px';
    root.style.width = '300px';
    root.style.maxWidth = 'calc(100vw - 36px)';
    root.style.padding = '12px 14px';
    root.style.border = '1px solid rgba(15, 23, 42, 0.14)';
    root.style.borderRadius = '8px';
    root.style.background = 'rgba(255, 255, 255, 0.96)';
    root.style.boxShadow = '0 16px 38px rgba(15, 23, 42, 0.18)';
    root.style.color = '#111827';
    root.style.font = '13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';

    const label = document.createElement('div');
    label.style.fontWeight = '650';
    label.style.marginBottom = '6px';

    const detail = document.createElement('div');
    detail.style.color = '#4b5563';
    detail.style.marginBottom = '8px';

    const track = document.createElement('div');
    track.style.height = '6px';
    track.style.overflow = 'hidden';
    track.style.borderRadius = '999px';
    track.style.background = '#e5e7eb';

    const fill = document.createElement('div');
    fill.style.width = '0%';
    fill.style.height = '100%';
    fill.style.borderRadius = '999px';
    fill.style.background = '#2563eb';
    fill.style.transition = 'width 120ms ease';

    track.appendChild(fill);
    root.appendChild(label);
    root.appendChild(detail);
    root.appendChild(track);
    document.body.appendChild(root);

    progress = { root, label, detail, fill };
    helper.state.longTaskProgress = progress;
    return progress;
  }


  function updateLongTaskProgress({ label, current, total, detail, percent }) {
    const progress = ensureLongTaskProgress();
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCurrent = api.site.clamp(Number(current) || 0, 0, safeTotal || 1);
    const safePercent = Number.isFinite(Number(percent))
      ? api.site.clamp(Math.round(Number(percent)), 0, 100)
      : safeTotal > 0
        ? Math.round((safeCurrent / safeTotal) * 100)
        : 0;

    progress.label.textContent = label || 'Working...';
    progress.detail.textContent =
      typeof detail === 'string' && detail
        ? detail
        : safeTotal > 0
          ? `${safeCurrent} / ${safeTotal} segments`
          : 'Preparing...';
    delete progress.root.dataset.babelHelperL0TranscriptionFailure;
    delete progress.root.dataset.babelHelperL0TranscriptionFailureToken;
    progress.fill.style.background = '#2563eb';
    progress.fill.style.width = `${safePercent}%`;
  }


  function showL0SegmentTranscriptionFailure(result) {
    const reason =
      result && typeof result.reason === 'string' && result.reason.trim()
        ? result.reason.trim()
        : 'l0-transcription-failed';
    const broker = result && result.broker && typeof result.broker === 'object' ? result.broker : null;
    const message =
      broker && typeof broker.message === 'string' && broker.message.trim()
        ? broker.message.trim()
        : 'Free L0 transcription did not return text.';
    updateLongTaskProgress({
      label: 'L0 transcription failed',
      current: 100,
      total: 100,
      percent: 100,
      detail: reason + '. ' + message
    });

    const progress = helper.state.longTaskProgress;
    if (progress && progress.fill instanceof HTMLElement) {
      progress.fill.style.background = '#dc2626';
    }
    if (progress && progress.root instanceof HTMLElement) {
      const dismissToken = Date.now() + '-' + Math.random().toString(36).slice(2);
      progress.root.dataset.babelHelperL0TranscriptionFailure = 'true';
      progress.root.dataset.babelHelperL0TranscriptionFailureToken = dismissToken;
      window.setTimeout(() => {
        if (
          helper.state.longTaskProgress === progress &&
          progress.root instanceof HTMLElement &&
          progress.root.dataset.babelHelperL0TranscriptionFailureToken === dismissToken
        ) {
          dismissLongTaskProgress();
        }
      }, L0_TRANSCRIPTION_FAILURE_DISMISS_MS);
    }
  }


  function dismissLongTaskProgress() {
    const progress = helper.state.longTaskProgress;
    helper.state.longTaskProgress = null;
    if (progress && progress.root instanceof HTMLElement) {
      progress.root.remove();
    }
  }


  function updateL0SegmentTranscriptionProgress(event, range) {
    const eventName = event && typeof event.event === 'string' ? event.event : '';
    const elapsedSeconds = Math.max(0, Math.round((Number(event && event.elapsedMs) || 0) / 1000));
    const durationSeconds =
      range && Number.isFinite(range.endSeconds - range.startSeconds)
        ? Math.max(0, range.endSeconds - range.startSeconds)
        : 0;
    const progress =
      eventName === 'accepted'
        ? { percent: 10, detail: 'Starting free L0 transcription' }
        : eventName === 'capturing-audio'
          ? { percent: 30, detail: `Capturing ${Math.round(durationSeconds)}s segment audio` }
          : eventName === 'calling-backend'
            ? { percent: 55, detail: 'Generating text with free L0' }
            : eventName === 'backend-waiting'
              ? { percent: Math.min(90, 55 + Math.floor(elapsedSeconds / 10)), detail: `Waiting for free L0... ${elapsedSeconds}s elapsed` }
              : { percent: 5, detail: 'Preparing free L0 transcription' };
    updateLongTaskProgress({
      label: 'Transcribing current segment',
      current: progress.percent,
      total: 100,
      percent: progress.percent,
      detail: progress.detail
    });
  }

  return { updateLongTaskProgress, dismissLongTaskProgress, updateL0SegmentTranscriptionProgress, showL0SegmentTranscriptionFailure };
}
