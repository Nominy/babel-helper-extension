// @ts-nocheck

/** Resolve exact value ownership across React's current/alternate render pair.
 * A memoized child can retain a callback from the other render even while its
 * parent has committed newer hooks. Its dependency chain still needs validation.
 */
export function readNativeMemoDependencies(editor, value) {
  for (let owner = editor, side = 0; owner && side < 2; owner = editor.alternate, side++) {
    for (let hook = owner.memoizedState; hook; hook = hook.next) {
      const state = hook.memoizedState;
      if (Array.isArray(state) && state[0] === value && Array.isArray(state[1])) return state[1];
    }
  }
  return null;
}

function source(callback) {
  return typeof callback === 'function' ? Function.prototype.toString.call(callback) : '';
}

/**
 * Resolve the native annotation transaction through its owned merge callback.
 * The current production merge exposes [annotations, history wrapper, writer]
 * as its useCallback dependencies. The wrapper's own dependency must identify
 * the same live history executor as the panel's external-store snapshot.
 *
 * No feature installation is required. Callers must recheck task/root/access
 * and source values immediately before executing; never retain this capability
 * across an await. The writer owns WaveSurfer region synchronization and save
 * state. clearSegment owns native low-confidence bookkeeping.
 */
export function resolveNativeAnnotationTransaction(editor, binding) {
  const wrapper = binding.panel.onMergeAnnotations;
  const wrapperDeps = readNativeMemoDependencies(editor, wrapper);
  if (wrapperDeps?.length !== 2 || typeof wrapperDeps[0]?.clearSegment !== 'function' ||
      !/\.clearSegment\(/.test(source(wrapper))) throw new Error('native-annotation-wrapper-unsupported');
  const nativeMerge = wrapperDeps[1];
  const deps = readNativeMemoDependencies(editor, nativeMerge);
  if (deps?.length !== 3 || deps[0] !== binding.annotations ||
      !/lowConfidenceResolved/.test(source(nativeMerge)) || !/undo:\s*\(\)\s*=>/.test(source(nativeMerge)) ||
      typeof deps[1] !== 'function' || typeof deps[2] !== 'function') {
    throw new Error('native-annotation-command-unsupported');
  }
  const execute = deps[1], writeAnnotations = deps[2];
  const historyDeps = readNativeMemoDependencies(editor, execute);
  if (typeof binding.history?.executeAndPush !== 'function' ||
      !/\.executeAndPush\(/.test(source(execute)) || !historyDeps?.some(value =>
        value?.executeAndPush === binding.history.executeAndPush)) {
    throw new Error('native-annotation-history-unsupported');
  }
  // A raw React state setter is insufficient: require the actual native writer
  // reached by the merge command, with its region-sync and updater branches.
  if (!/isSyncingAnnotationsToWaveSurferRef\.current/.test(source(writeAnnotations)) ||
      !/"function"\s*==\s*typeof/.test(source(writeAnnotations))) {
    throw new Error('native-annotation-region-writer-unsupported');
  }
  return { execute, writeAnnotations, clearSegment: wrapperDeps[0].clearSegment.bind(wrapperDeps[0]) };
}
