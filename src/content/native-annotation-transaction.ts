// @ts-nocheck

/** Dependency identity is meaningful only in the current workbench's hooks. */
function currentMemoDependencies(editor, value) {
  for (let hook = editor?.memoizedState; hook; hook = hook.next) {
    const state = hook.memoizedState;
    if (Array.isArray(state) && state[0] === value && Array.isArray(state[1])) return state[1];
  }
  return null;
}

function source(callback) {
  return typeof callback === 'function' ? Function.prototype.toString.call(callback) : '';
}

/**
 * Read the current controller's unique native merge dependency chain. A cached
 * panel may retain onMergeAnnotations longer than BOTH React render slots, so
 * panel callback identity must not select a native writer or history owner.
 *
 * No hook indices, old-render callbacks, cached capabilities or raw setters.
 * Callers recheck task/access/source immediately before executing this command.
 */
export function resolveNativeAnnotationTransaction(editor, binding) {
  const dependencies = currentMemoDependencies(editor, binding.controller);
  if (!dependencies || typeof binding.controller?.mergeUp !== 'function') {
    throw new Error('native-annotation-controller-unsupported');
  }
  let candidate = null;
  for (const wrapper of dependencies) {
    if (typeof wrapper !== 'function' || !/\.clearSegment\(/.test(source(wrapper))) continue;
    const wrapperDeps = currentMemoDependencies(editor, wrapper);
    if (wrapperDeps?.length !== 2 || typeof wrapperDeps[0]?.clearSegment !== 'function') continue;
    const nativeMerge = wrapperDeps[1];
    const mergeSource = source(nativeMerge);
    // Text/track/time changes and splits are other controller dependencies.
    // Require the observed native two-argument directional union command.
    if (typeof nativeMerge !== 'function' || nativeMerge.length !== 2 ||
        !/["']above["']/.test(mergeSource) || !/Math\.min\(/.test(mergeSource) ||
        !/Math\.max\(/.test(mergeSource) || !/lowConfidenceResolved/.test(mergeSource) ||
        !/undo:\s*\(\)\s*=>/.test(mergeSource)) continue;
    const deps = currentMemoDependencies(editor, nativeMerge);
    if (deps?.length !== 3 || deps[0] !== binding.annotations ||
        typeof deps[1] !== 'function' || typeof deps[2] !== 'function') {
      throw new Error('native-annotation-command-unsupported');
    }
    if (candidate) {
      if (candidate.nativeMerge === nativeMerge && candidate.confidence === wrapperDeps[0]) continue;
      throw new Error('native-annotation-command-ambiguous');
    }
    candidate = { nativeMerge, confidence: wrapperDeps[0], execute: deps[1], writeAnnotations: deps[2] };
  }
  if (!candidate) throw new Error('native-annotation-command-unsupported');
  const { execute, writeAnnotations, confidence } = candidate;
  const historyDeps = currentMemoDependencies(editor, execute);
  if (typeof binding.history?.executeAndPush !== 'function' ||
      !/\.executeAndPush\(/.test(source(execute)) || !historyDeps?.some(value =>
        value?.executeAndPush === binding.history.executeAndPush)) {
    throw new Error('native-annotation-history-unsupported');
  }
  if (!/isSyncingAnnotationsToWaveSurferRef\.current/.test(source(writeAnnotations)) ||
      !/["']function["']\s*==\s*typeof/.test(source(writeAnnotations))) {
    throw new Error('native-annotation-region-writer-unsupported');
  }
  return { execute, writeAnnotations, clearSegment: confidence.clearSegment.bind(confidence) };
}
