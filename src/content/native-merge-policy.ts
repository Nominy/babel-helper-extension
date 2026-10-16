// @ts-nocheck
import { findBabelEditorFiber, readBabelTranscriptBindings, subscribeBabelEditorCommits } from '@nominy/babel-babel-runtime';
import { findNativeDescendant, TRANSCRIPT_EDITOR_SELECTOR, TRANSCRIPT_ROW_SELECTOR } from './native-transcript';
import { resolveNativeAnnotationTransaction } from './native-annotation-transaction';

const gapHints = {
  above: "This speaker's previous turn is more than 2s away",
  below: "This speaker's next turn is more than 2s away"
};

export function readSameLaneMerge(binding, annotationId, direction) {
  if (!binding || binding.readOnly || binding.panel?.readOnly || binding.transcript?.readOnly) return { reason: 'read-only' };
  if (binding.panel?.lockSegments || binding.transcript?.lockSegments) return { reason: 'segments-locked' };
  if (binding.panel?.mode && binding.panel.mode !== 'transcription') return { reason: 'unsupported-mode' };
  if (direction !== 'above' && direction !== 'below') return { reason: 'invalid-direction' };
  const turn = binding.annotations.find(item => item.id === annotationId && item.type === 'transcription');
  if (!turn?.processedRecordingId) return { reason: 'row-not-found' };
  const lane = binding.annotations.filter(item => item.type === 'transcription' &&
    item.processedRecordingId === turn.processedRecordingId)
    .sort((left, right) => left.startTimeInSeconds - right.startTimeInSeconds);
  const neighbor = lane[lane.indexOf(turn) + (direction === 'above' ? -1 : 1)];
  if (!neighbor) return { reason: 'merge-disabled' };
  if (![turn, neighbor].every(item => Number.isFinite(item.startTimeInSeconds) &&
      Number.isFinite(item.endTimeInSeconds) && item.endTimeInSeconds >= item.startTimeInSeconds)) {
    return { reason: 'invalid-segment' };
  }
  return { turn, neighbor, direction, gap: direction === 'above'
    ? turn.startTimeInSeconds - neighbor.endTimeInSeconds
    : neighbor.startTimeInSeconds - turn.endTimeInSeconds };
}

/** One native command; no temporary timing changes and no secondary DOM model. */
export function executeSameLaneMerge(binding, pair, capability) {
  const { turn, neighbor } = pair;
  if (Object.hasOwn(binding.pendingTextById || {}, turn.id) ||
      Object.hasOwn(binding.pendingTextById || {}, neighbor.id)) {
    throw new Error('native-merge-pending-text');
  }
  const above = pair.direction === 'above';
  const merged = { ...turn,
    content: (above ? `${neighbor.content ?? ''} ${turn.content ?? ''}`
      : `${turn.content ?? ''} ${neighbor.content ?? ''}`).trim(),
    startTimeInSeconds: Math.min(turn.startTimeInSeconds, neighbor.startTimeInSeconds),
    endTimeInSeconds: Math.max(turn.endTimeInSeconds, neighbor.endTimeInSeconds),
    metadata: { ...turn.metadata, lowConfidenceResolved: true }, updatedAt: new Date().toISOString() };
  const neighborIndex = binding.annotations.indexOf(neighbor);
  capability.clearSegment(turn.id);
  capability.execute({
    do() {
      capability.writeAnnotations(annotations => {
        const next = [];
        for (const item of annotations) {
          if (item.id !== neighbor.id) next.push(item.id === turn.id ? merged : item);
        }
        return next;
      });
    },
    undo() {
      capability.writeAnnotations(annotations => {
        const restored = annotations.map(item => item.id === turn.id ? turn : item);
        restored.splice(Math.min(neighborIndex, restored.length), 0, neighbor);
        return restored;
      });
    }
  });
  return { ok: true, annotationId: turn.id, removedAnnotationId: neighbor.id };
}

const mergePolicyKey = Symbol.for('babel-helper.native-merge-policy/v1');

function installedMergeLease() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, mergePolicyKey);
  if (!descriptor) return null;
  const lease = descriptor.value;
  if (!descriptor.configurable || !('value' in descriptor) || lease?.version !== 1 ||
      typeof lease.owner !== 'symbol' || !lease.policy ||
      !['merge', 'reconcile', 'handleInteraction', 'dispose'].every(key => typeof lease.policy[key] === 'function')) {
    throw new Error('native-merge-policy-registry-unsupported');
  }
  return lease;
}

export function invokeNativeSameLaneMerge(binding, annotationId, direction) {
  const pair = readSameLaneMerge(binding, annotationId, direction);
  if (pair.reason) throw new Error(pair.reason);
  if (pair.gap <= 2) return binding.panel.onMergeAnnotations(annotationId, direction);
  const installed = installedMergeLease();
  if (!installed) throw new Error('native-merge-policy-unavailable');
  return installed.policy.merge(annotationId, direction, binding.reviewActionId);
}

function elementText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(elementText).join('');
  return value?.props ? elementText(value.props.children) : '';
}

function reconcileNativeMergeMenus({ binding, editor, patch, original, requestMerge, route, readBindings, findEditor, onFailure, closeMenus,
  annotationId = null, keyboardOnly = false }) {
  const panel = findNativeDescendant(editor, fiber => fiber.memoizedProps === binding.panel);
  if (!panel) throw new Error('native-merge-panel-unsupported');
  let capabilityValidated = false, eligibilityFound = false;
  const transcriptionCount = binding.annotations.filter(turn => turn.type === 'transcription').length;
  // The native panel's eligibility useMemo owns the menu records. Its inputs are
  // the current sorted transcription annotations and the real lock flag.
  // Keeping these records adapted preserves eligibility on playback renders
  // without touching the React commit hot path.
  for (let hook = panel.memoizedState; hook; hook = hook.next) {
    const state = hook.memoizedState;
    if (!Array.isArray(state) || state.length !== 2) continue;
    const [records, dependencies] = state;
    if (!records || typeof records !== 'object' || Array.isArray(records) ||
        !Array.isArray(dependencies) || dependencies.length !== 2 ||
        dependencies[1] !== Boolean(binding.panel.lockSegments) || !Array.isArray(dependencies[0]) ||
        dependencies[0].length !== transcriptionCount ||
        !dependencies[0].every(turn => binding.annotations.includes(turn) && turn.type === 'transcription')) continue;
    const turns = dependencies[0];
    if (!turns.length || Object.keys(records).length !== turns.length ||
        !turns.every(turn => typeof records[turn.id]?.canMergeAbove === 'boolean' &&
          typeof records[turn.id]?.canMergeBelow === 'boolean')) continue;
    eligibilityFound = true;
    for (const turn of turns) {
      const record = records[turn.id];
      for (const direction of ['above', 'below']) {
        const suffix = direction === 'above' ? 'Above' : 'Below';
        if (original(record, `merge${suffix}Hint`) !== gapHints[direction]) continue;
        const pair = readSameLaneMerge(binding, turn.id, direction);
        if (pair.reason || pair.gap <= 2) continue;
        if (!capabilityValidated) {
          resolveNativeAnnotationTransaction(editor, binding);
          capabilityValidated = true;
        }
        patch(record, `canMerge${suffix}`, true);
        patch(record, `merge${suffix}Hint`, undefined);
      }
    }
    break;
  }
  const menus = [];
  if (!keyboardOnly) findNativeDescendant(panel, fiber => {
    const props = fiber.memoizedProps;
    if (typeof props?.annotationId === 'string' && (!annotationId || props.annotationId === annotationId) &&
        typeof props.onMergeAbove === 'function' && typeof props.onMergeBelow === 'function' &&
        typeof props.canMergeAbove === 'boolean' && typeof props.canMergeBelow === 'boolean' &&
        typeof props.onDelete === 'function') menus.push(fiber);
    return Boolean(annotationId && menus.length);
  });
  for (const menu of menus) {
    const menuProps = menu.memoizedProps;
    const actions = {};
    for (const direction of ['above', 'below']) {
      const pair = readSameLaneMerge(binding, menuProps.annotationId, direction);
      const suffix = direction === 'above' ? 'Above' : 'Below';
      if (pair.reason || pair.gap <= 2 || original(menuProps, `canMerge${suffix}`) ||
          original(menuProps, `merge${suffix}Hint`) !== gapHints[direction]) continue;
      if (!eligibilityFound) throw new Error('native-merge-eligibility-unsupported');
      if (!capabilityValidated) {
        resolveNativeAnnotationTransaction(editor, binding);
        capabilityValidated = true;
      }
      actions[`Merge With ${suffix}`] = direction;
    }
    if (!Object.keys(actions).length) continue;
    const itemProps = new Set(), hintProps = new Set(), visited = new Set();
    function collect(value) {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) { for (const child of value) collect(child); return; }
      const props = value.props;
      if (!props) return;
      const label = elementText(props.children);
      if (actions[label] && typeof props.disabled === 'boolean' && typeof props.onClick === 'function') itemProps.add(props);
      if (actions[label] && Object.values(gapHints).includes(props.title)) hintProps.add(props);
      collect(props.children);
    }
    let openMenu = null;
    findNativeDescendant(menu, fiber => {
      collect(fiber.memoizedProps?.children);
      const props = fiber.memoizedProps;
      if (props?.open === true && typeof props.triggerId === 'string' && props.triggerRef &&
          typeof props.onOpenChange === 'function') {
        openMenu = props;
        closeMenus.add(props.onOpenChange);
      }
      return false;
    });
    for (const label of Object.keys(actions)) {
      if (![...itemProps].some(props => elementText(props.children) === label)) {
        throw new Error('native-merge-menu-elements-unsupported');
      }
    }
    for (const props of itemProps) {
      const direction = actions[elementText(props.children)];
      patch(props, 'disabled', false);
      patch(props, 'onClick', () => requestMerge(menuProps.annotationId, direction,
        binding.reviewActionId, editor, route));
    }
    for (const props of hintProps) patch(props, 'title', undefined);
    for (const direction of Object.values(actions)) {
      const suffix = direction === 'above' ? 'Above' : 'Below';
      patch(menuProps, `canMerge${suffix}`, true);
      patch(menuProps, `merge${suffix}Hint`, undefined);
      patch(menuProps, `onMerge${suffix}`, () => requestMerge(menuProps.annotationId, direction,
        binding.reviewActionId, editor, route));
    }
    // Radix owns disabled event closures and the roving-focus registry. Close
    // an already-mounted disabled menu through its own callback so reopening
    // mounts the adapted elements; DOM attributes cannot update that behavior.
    const mountedDisabled = findNativeDescendant(menu, fiber =>
      fiber.memoizedProps?.role === 'menuitem' && fiber.memoizedProps['aria-disabled'] === true &&
      actions[fiber.stateNode?.textContent?.trim()]);
    if (mountedDisabled) {
      if (!openMenu) throw new Error('native-merge-open-menu-unsupported');
      openMenu.onOpenChange(false);
    }
  }
  const handlers = binding.transcript?.handlers;
  const key = 'onMergeUp';
  if (Object.hasOwn(handlers || {}, key)) {
    const callback = original(handlers, key);
    const callbackSource = typeof callback === 'function' ? Function.prototype.toString.call(callback) : '';
    const direction = 'above';
    if (!callbackSource.includes(`"${direction}"`) || !callbackSource.includes("There's no ") ||
        !callbackSource.includes('within ')) {
      throw new Error('native-merge-keyboard-unsupported');
    }
    const nativeOperation = 'mergeUp';
    const currentOperation = binding.controller?.[nativeOperation];
    // The committed transcript owns this entrypoint, but may retain an older
    // closure. Match its native role, then execute only the current controller.
    if (typeof currentOperation !== 'function' ||
        Function.prototype.toString.call(currentOperation) !== callbackSource) {
      throw new Error('native-merge-keyboard-unsupported');
    }
    if (!capabilityValidated) {
      resolveNativeAnnotationTransaction(editor, binding);
      capabilityValidated = true;
    }
    patch(handlers, key, annotationId => {
      const current = readBindings();
      const currentEditor = findEditor();
      if (current?.reviewActionId !== binding.reviewActionId ||
          (currentEditor !== editor && currentEditor?.alternate !== editor) ||
          `${location.pathname}${location.search}` !== route) {
        onFailure(new Error('native-merge-stale-task'));
        return;
      }
      const pair = readSameLaneMerge(current, annotationId, direction);
      if (!pair.reason && pair.gap > 2) {
        requestMerge(annotationId, direction, binding.reviewActionId, editor, route);
      } else if ((!pair.reason || pair.reason === 'merge-disabled') &&
          current?.reviewActionId === binding.reviewActionId) {
        const operation = current.controller?.[nativeOperation];
        if (typeof operation !== 'function' || Function.prototype.toString.call(operation) !== callbackSource) {
          onFailure(new Error('native-merge-keyboard-unsupported'));
          return;
        }
        operation.call(current.controller, annotationId);
      }
    });
  }
  return capabilityValidated;
}

/**
 * Prepare from native menu/Backspace interactions; reconcile only on session
 * and setting transitions. Never call this from the playback commit loop.
 */
export function installNativeMergePolicy({ onFailure, isEnabled = () => true, readBindings = readBabelTranscriptBindings,
  findEditor = findBabelEditorFiber, subscribe = subscribeBabelEditorCommits }) {
  if (typeof onFailure !== 'function') throw new TypeError('Native merge failures require a visible reporter.');
  installedMergeLease()?.policy.dispose();
  if (Object.hasOwn(globalThis, mergePolicyKey)) throw new Error('native-merge-policy-registry-ownership-lost');
  const owner = Symbol('native-merge-policy-owner');
  let lease = null;
  let disposed = false;
  const patches = [];
  let ownership = new WeakMap();
  let prepared = null;
  const pending = new Set();
  const closeMenus = new Set();
  const route = () => `${location.pathname}${location.search}`;

  function merge(annotationId, direction, expectedTask, expectedRoot = null, expectedRoute = route()) {
    const binding = readBindings();
    const editor = findEditor();
    if (disposed || !binding || binding.reviewActionId !== expectedTask || route() !== expectedRoute ||
        (expectedRoot && editor !== expectedRoot && editor?.alternate !== expectedRoot)) {
      throw new Error('native-merge-stale-task');
    }
    const pair = readSameLaneMerge(binding, annotationId, direction);
    if (pair.reason) throw new Error(pair.reason);
    if (pair.gap <= 2) return binding.panel.onMergeAnnotations(annotationId, direction);
    if (!isEnabled()) return binding.panel.onMergeAnnotations(annotationId, direction);
    const scope = prepare(annotationId, true);
    if (!scope || scope.binding.annotations !== binding.annotations) throw new Error('native-merge-stale-transcript');
    if (!scope.restricted) throw new Error('native-merge-policy-unsupported');
    return executeSameLaneMerge(binding, pair, resolveNativeAnnotationTransaction(editor, binding));
  }

  function requestMerge(annotationId, direction, task, root, requestRoute) {
    const initial = readBindings();
    const pair = readSameLaneMerge(initial, annotationId, direction);
    if (pair.reason) { onFailure(new Error(pair.reason)); return; }
    const expected = [pair.turn, pair.neighbor].map(turn => ({ ...turn,
      content: initial.pendingTextById?.[turn.id] ?? turn.content }));
    let unsubscribe = null, deadline = null, finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      clearTimeout(deadline);
      pending.delete(cancel);
      if (error) onFailure(error);
    };
    const cancel = () => finish(new Error('native-merge-disposed'));
    const attempt = () => {
      try {
        const binding = readBindings();
        const editor = findEditor();
        if (disposed || binding?.reviewActionId !== task || route() !== requestRoute ||
            (editor !== root && editor?.alternate !== root)) throw new Error('native-merge-stale-task');
        const currentPair = readSameLaneMerge(binding, annotationId, direction);
        if (currentPair.reason) throw new Error(currentPair.reason);
        if (currentPair.neighbor.id !== pair.neighbor.id) throw new Error('native-merge-stale-neighbor');
        for (const expectedTurn of expected) {
          const current = binding.annotations.find(turn => turn.id === expectedTurn.id);
          if (!current || current.processedRecordingId !== expectedTurn.processedRecordingId ||
              current.startTimeInSeconds !== expectedTurn.startTimeInSeconds ||
              current.endTimeInSeconds !== expectedTurn.endTimeInSeconds ||
              (binding.pendingTextById?.[current.id] ?? current.content) !== expectedTurn.content) {
            throw new Error('native-merge-stale-transcript');
          }
          if (Object.hasOwn(binding.pendingTextById || {}, current.id)) return;
        }
        merge(annotationId, direction, task, root, requestRoute);
        finish();
      } catch (error) { finish(error); }
    };
    attempt();
    if (finished) return;
    pending.add(cancel);
    deadline = setTimeout(() => finish(new Error('native-merge-pending-text-timeout')), 1600);
    try { unsubscribe = subscribe(attempt); }
    catch (error) { finish(error); return; }
    attempt();
  }

  function restore() {
    for (const patch of patches.splice(0).reverse()) {
      if (patch.object[patch.key] === patch.value) patch.object[patch.key] = patch.original;
    }
    ownership = new WeakMap();
    prepared = null;
  }

  function original(object, key) {
    const lease = ownership.get(object)?.get(key);
    return lease ? lease.original : object[key];
  }

  function patch(object, key, value) {
    const previous = ownership.get(object)?.get(key);
    if (previous) {
      if (object[key] !== previous.value) throw new Error('native-merge-prop-ownership-lost');
      if (previous.value === value || (typeof previous.value === 'function' && typeof value === 'function')) return;
      previous.value = value;
      object[key] = value;
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.writable || !('value' in descriptor)) throw new Error('native-merge-props-unsupported');
    const lease = { object, key, value, original: object[key] };
    patches.push(lease);
    let fields = ownership.get(object);
    if (!fields) ownership.set(object, fields = new Map());
    fields.set(key, lease);
    object[key] = value;
  }

  function prepare(annotationId = null, keyboardOnly = false) {
    if (disposed || !isEnabled()) return null;
    const binding = readBindings(), editor = findEditor();
    if (!binding || !editor) return null;
    if (prepared && (prepared.annotations !== binding.annotations || prepared.task !== binding.reviewActionId ||
        (prepared.editor !== editor && prepared.editor !== editor.alternate))) restore();
    if (binding.readOnly || binding.transcript?.lockSegments || binding.panel?.lockSegments) {
      restore();
      return null;
    }
    try {
      const restricted = reconcileNativeMergeMenus({ binding, editor, patch, original, requestMerge, readBindings, findEditor, onFailure, closeMenus,
        route: route(), annotationId, keyboardOnly });
      prepared = { annotations: binding.annotations, task: binding.reviewActionId, editor, restricted };
    } catch (error) { restore(); throw error; }
    return { binding, editor, restricted: prepared.restricted };
  }

  function handleInteraction(event) {
    if (disposed || !isEnabled() || event.defaultPrevented) return;
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (typeof target?.closest !== 'function') return;
    if (event.type === 'keydown' && event.key === 'Backspace') {
      const editable = target.closest(TRANSCRIPT_EDITOR_SELECTOR);
      const id = editable?.closest(TRANSCRIPT_ROW_SELECTOR)?.getAttribute('data-annotation-id');
      if (id) {
        try { prepare(id, true); } catch (error) { onFailure(error); }
      }
      return;
    }
    const item = event.type === 'click' ? target.closest('[role="menuitem"]') : null;
    const trigger = (event.type === 'pointerdown' || (event.type === 'keydown' &&
      ['Enter', ' ', 'ArrowDown'].includes(event.key))) ? target.closest('[aria-haspopup="menu"]') : null;
    const element = item || trigger;
    if (!element) return;
    const fiberKey = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactFiber$'));
    let owner = fiberKey ? element[fiberKey] : null;
    while (owner && !(typeof owner.memoizedProps?.annotationId === 'string' &&
        typeof owner.memoizedProps.onMergeAbove === 'function' && typeof owner.memoizedProps.onMergeBelow === 'function')) {
      owner = owner.return;
    }
    if (!owner) return;
    const annotationId = owner.memoizedProps.annotationId;
    try {
      if (trigger) { prepare(annotationId); return; }
      const direction = item.textContent?.trim() === 'Merge With Above' ? 'above'
        : item.textContent?.trim() === 'Merge With Below' ? 'below' : null;
      if (!direction || !prepared?.restricted) return;
      const binding = readBindings(), editor = findEditor();
      if (!binding || !editor) return;
      const panel = findNativeDescendant(editor, fiber => fiber.memoizedProps === binding.panel);
      const menu = findNativeDescendant(panel, fiber => fiber.memoizedProps?.annotationId === annotationId &&
        typeof fiber.memoizedProps.onMergeAbove === 'function');
      if (!menu || !findNativeDescendant(menu, fiber => fiber.stateNode === item)) return;
      const pair = readSameLaneMerge(binding, annotationId, direction);
      if (pair.reason) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (pair.gap <= 2) return;
      resolveNativeAnnotationTransaction(editor, binding);
      const dropdown = findNativeDescendant(menu, fiber => {
        const props = fiber.memoizedProps;
        return props?.open === true && typeof props.triggerId === 'string' && props.triggerRef &&
          typeof props.onOpenChange === 'function';
      })?.memoizedProps;
      if (!dropdown) throw new Error('native-merge-open-menu-unsupported');
      // Radix has already translated pointer/Enter/Space selection into click.
      // Route only this owned gap action, then use its native close/focus path.
      event.preventDefault();
      event.stopImmediatePropagation();
      requestMerge(annotationId, direction, binding.reviewActionId, editor, route());
      dropdown.onOpenChange(false);
    } catch (error) { onFailure(error); }
  }

  function closeOwnedMenus() {
    closeMenus.clear();
    const editor = findEditor();
    if (!prepared || (editor !== prepared.editor && editor?.alternate !== prepared.editor)) return;
    const binding = readBindings();
    if (binding?.reviewActionId !== prepared.task) return;
    const panel = findNativeDescendant(editor, fiber => fiber.memoizedProps === binding.panel);
    findNativeDescendant(panel, menu => {
      if (typeof menu.memoizedProps?.annotationId !== 'string' ||
          typeof menu.memoizedProps.onMergeAbove !== 'function') return false;
      findNativeDescendant(menu, fiber => {
        const props = fiber.memoizedProps;
        if (props?.open === true && typeof props.triggerId === 'string' && props.triggerRef &&
            typeof props.onOpenChange === 'function') closeMenus.add(props.onOpenChange);
        return false;
      });
      return false;
    });
    for (const close of closeMenus) close(false);
    closeMenus.clear();
  }

  const policy = {
    merge,
    handleInteraction,
    reconcile() {
      const enabled = !disposed && isEnabled();
      if (!enabled) closeOwnedMenus();
      restore();
      closeMenus.clear();
      if (!enabled) return;
      prepare();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of Array.from(pending)) cancel();
      closeOwnedMenus();
      restore();
      closeMenus.clear();
      const current = Object.getOwnPropertyDescriptor(globalThis, mergePolicyKey);
      if (current?.value === lease && lease.owner === owner) delete globalThis[mergePolicyKey];
    }
  };
  lease = Object.freeze({ version: 1, owner, policy });
  Object.defineProperty(globalThis, mergePolicyKey, { configurable: true, value: lease });
  try { policy.reconcile(); }
  catch (error) { policy.dispose(); throw error; }
  return policy;
}
