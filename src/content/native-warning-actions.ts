import { findBabelEditorFiber, readBabelTranscriptBindings, subscribeBabelEditorCommits,
  type BabelNativeAnnotation, type BabelNativeTranscriptBindings } from '@nominy/babel-babel-runtime';

interface Warning { annotationId: string; reason: string; severity: string; signal?: unknown }
interface Root { alternate?: unknown }
interface Source { text: string | null; recording: string | null; start: number | null; end: number | null }
interface LinterWindow extends Window {
  __babelHelperLinterBridge?: {
    recordNativeWarningAcknowledgement(annotation: BabelNativeAnnotation, reviewActionId: string, reason: string): boolean;
  };
}
let running = false;

function assertions(annotation: BabelNativeAnnotation): string[] {
  const metadata = annotation.metadata as { assertedWarnings?: string[] } | undefined;
  return Array.isArray(metadata?.assertedWarnings) ? metadata.assertedWarnings : [];
}
function issues(binding: BabelNativeTranscriptBindings): Warning[] {
  if (!Array.isArray(binding.transcript.lintIssues)) throw new Error('Native warning issues are unavailable');
  return binding.transcript.lintIssues;
}
function source(binding: BabelNativeTranscriptBindings, annotation: BabelNativeAnnotation): Source {
  return { text: binding.pendingTextById[annotation.id] ?? annotation.content,
    recording: annotation.processedRecordingId, start: annotation.startTimeInSeconds, end: annotation.endTimeInSeconds };
}

/** Use the native history-backed assertion callback, even for unmounted issue cards.
 * Each callback closes over one committed annotation list: await its real commit
 * before resolving the next callback, never batch stale closures or toggle a reason twice. */
export async function acceptAllNativeWarnings(payload: { reviewActionId: string }) {
  if (running) return { ok: false, error: 'Native warning acknowledgement is already running', acceptedCount: 0 };
  running = true;
  let acceptedCount = 0;
  let unsubscribe: (() => void) | undefined;
  let timer: number | undefined;
  let waiting: { check(): void; reject(error: Error): void } | null = null;
  let stopped: Error | null = null;
  const stop = (error: Error) => { stopped = error; waiting?.reject(error); };
  const teardown = () => stop(new Error('Native warning acknowledgement was interrupted'));
  const route = window.location.href;
  const root = findBabelEditorFiber() as Root | null;
  const current = () => {
    if (stopped) throw stopped;
    const liveRoot = findBabelEditorFiber() as Root | null;
    const binding = readBabelTranscriptBindings();
    if (!root || !liveRoot || (root !== liveRoot && root.alternate !== liveRoot && liveRoot.alternate !== root) ||
        window.location.href !== route || !payload?.reviewActionId || binding?.reviewActionId !== payload.reviewActionId) {
      throw new Error('The native task changed during warning acknowledgement');
    }
    if (binding.readOnly || binding.panel.readOnly || binding.transcript.readOnly) {
      throw new Error('Native warning acknowledgement is unavailable in read-only mode');
    }
    if (typeof binding.controller?.toggleWarningAssertion !== 'function') {
      throw new Error('The native warning acknowledgement callback is unavailable');
    }
    return binding;
  };
  const checkCommit = () => waiting?.check();
  try {
    const initial = current();
    const annotations = new Map(initial.annotations.map(annotation => [annotation.id, annotation]));
    const plan = new Map<string, { source: Source; reasons: Set<string> }>();
    for (const issue of issues(initial)) {
      if (issue.severity !== 'warning' || issue.signal) continue;
      const annotation = annotations.get(issue.annotationId);
      if (!annotation || annotation.type !== 'transcription' || assertions(annotation).includes(issue.reason)) continue;
      let row = plan.get(annotation.id);
      if (!row) { row = { source: source(initial, annotation), reasons: new Set() }; plan.set(annotation.id, row); }
      row.reasons.add(issue.reason);
    }
    if (!plan.size) return { ok: true, acceptedCount };
    unsubscribe = subscribeBabelEditorCommits(checkCommit);
    window.addEventListener('babel-helper-bridge-teardown', teardown, true);
    window.addEventListener('babel-helper:native-session-change', checkCommit);
    window.addEventListener('babel-helper:native-route-change', checkCommit);
    timer = window.setTimeout(() => stop(new Error('Native warning acknowledgement timed out waiting for a commit')), 30_000);
    for (const [id, row] of plan) for (const reason of row.reasons) {
      const binding = current();
      const annotation = binding.annotations.find(entry => entry.id === id);
      const requireSource = (live: BabelNativeTranscriptBindings, value: BabelNativeAnnotation | undefined) => {
        if (!value) throw new Error('A warning annotation was removed');
        const now = source(live, value), expected = row.source;
        if (now.text !== expected.text || now.recording !== expected.recording || now.start !== expected.start || now.end !== expected.end) {
          throw new Error('A warning annotation changed during acknowledgement');
        }
      };
      requireSource(binding, annotation);
      if (assertions(annotation!).includes(reason)) continue;
      if (!issues(binding).some(issue => issue.annotationId === id && issue.reason === reason &&
          issue.severity === 'warning' && !issue.signal)) continue;
      await new Promise<void>((resolve, reject) => {
        waiting = { reject, check() {
          try {
            const live = current(), next = live.annotations.find(entry => entry.id === id);
            requireSource(live, next);
            if (assertions(next!).includes(reason)) { waiting = null; resolve(); }
          } catch (error) { waiting = null; reject(error); }
        } };
        try {
          binding.controller!.toggleWarningAssertion(id, reason);
          (window as LinterWindow).__babelHelperLinterBridge?.recordNativeWarningAcknowledgement(annotation!, binding.reviewActionId, reason);
        } catch (error) { waiting = null; reject(error); }
      });
      acceptedCount += 1;
    }
    return { ok: true, acceptedCount };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), acceptedCount };
  } finally {
    waiting = null;
    window.clearTimeout(timer);
    unsubscribe?.();
    window.removeEventListener('babel-helper-bridge-teardown', teardown, true);
    window.removeEventListener('babel-helper:native-session-change', checkCommit);
    window.removeEventListener('babel-helper:native-route-change', checkCommit);
    running = false;
  }
}
