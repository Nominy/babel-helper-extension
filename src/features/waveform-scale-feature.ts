// @ts-nocheck
import { themeRoot, applyComponent } from '@nominy/babel-extension-frontend';

import { createMagnifierBridgeClient } from '../services/bridge-client-service';
import { captureL0TaskGuard } from '../services/l0-timing-identity';
import {
  loadWorkflowDefaults,
  updateWorkflowDefaults,
  normalizeWaveformScaleValue
} from '../core/workflow-defaults';

export function registerWaveformScaleService(helper: any) {
  if (!helper || helper.__waveformScaleRegistered) {
    return;
  }

  helper.__waveformScaleRegistered = true;

  const EXTENDED_MAX = 1000;
  const EDITOR_ATTR = 'data-babel-helper-waveform-scale-editor';
  const SAVE_DEBOUNCE_MS = 220;

  const callBridge = createMagnifierBridgeClient('waveform-scale-');
  let rowObserver = null;
  let persistTimer = 0;
  let defaultsLoaded = false;
  let cachedDefaults = null;
  let applyingSavedScales = false;
  let controlsBound = false;
  let activeEditor = null;
  let scalesRestored = false;
  let bindingPending = false;
  let bindingRevision = 0;

  function isFeatureEnabled(featureKey) {
    if (typeof helper.isFeatureEnabled === 'function') {
      return helper.isFeatureEnabled(featureKey);
    }

    return true;
  }

  function getTargetMax() {
    return EXTENDED_MAX;
  }

  function clearPersistTimer() {
    if (persistTimer) {
      window.clearTimeout(persistTimer);
      persistTimer = 0;
    }
  }

  async function ensureDefaults() {
    if (defaultsLoaded && cachedDefaults) {
      return cachedDefaults;
    }

    const loaded = await loadWorkflowDefaults();
    cachedDefaults = loaded;
    defaultsLoaded = true;
    return loaded;
  }

  function getWaveformScaleRows() {
    const snapshot = helper.getEditorSnapshot();
    const sliders = Array.from(
      document.querySelectorAll<HTMLElement>('[role="slider"][data-orientation="vertical"]')
    );

    return sliders
      .map((slider, index) => {
        const lane = slider.closest('div.flex.h-full') || slider.closest('div');
        const heading = lane?.querySelector('h3');
        const label = heading instanceof HTMLElement ? helper.normalizeText(heading) : '';
        const key = label || 'lane-' + index;
        const tracks = (snapshot?.tracks || []).filter(track => track.label === label);
        return {
          index,
          key,
          trackId: tracks.length === 1 ? tracks[0].id : '',
          reviewActionId: snapshot?.reviewActionId || '',
          label: label || 'Lane ' + (index + 1),
          slider,
          lane: lane instanceof HTMLElement ? lane : slider.parentElement
        };
      })
      .filter((row) => row.slider instanceof HTMLElement && row.lane instanceof HTMLElement);
  }

  function formatInputValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return '';
    }

    if (Math.abs(numeric - Math.round(numeric)) < 0.001) {
      return String(Math.round(numeric));
    }

    return String(Math.round(numeric * 1000) / 1000);
  }

  async function persistCurrentScales() {
    if (!controlsBound || !scalesRestored || applyingSavedScales) {
      return;
    }

    const defaults = await ensureDefaults();
    if (!controlsBound || !scalesRestored || applyingSavedScales) return;
    const nextScales = {
      ...(defaults.waveformScales || {})
    };

    for (const row of getWaveformScaleRows()) {
      nextScales[row.key] = normalizeWaveformScaleValue(row.slider.getAttribute('aria-valuenow'));
    }

    const saved = await updateWorkflowDefaults((currentDefaults) => ({
      ...currentDefaults,
      waveformScales: {
        ...(currentDefaults.waveformScales || {}),
        ...nextScales
      }
    }));
    cachedDefaults = saved;
    defaultsLoaded = true;
  }

  function queuePersistCurrentScales() {
    clearPersistTimer();
    persistTimer = window.setTimeout(() => {
      persistTimer = 0;
      void persistCurrentScales();
    }, SAVE_DEBOUNCE_MS);
  }

  async function setScaleForRow(row, value) {
    const isCurrentTask = captureL0TaskGuard();
    if (!isFeatureEnabled('waveformScaleUnlock') || !row.slider.isConnected || !row.trackId || !row.reviewActionId) return false;
    const normalized = normalizeWaveformScaleValue(value);
    if (!Number.isFinite(normalized)) {
      return false;
    }

    const result = await callBridge('waveform-scale-set', {
      trackId: row.trackId,
      reviewActionId: row.reviewActionId,
      value: normalized,
      max: getTargetMax()
    });

    if (!result || !result.ok || !isCurrentTask() || !isFeatureEnabled('waveformScaleUnlock') || !row.slider.isConnected) {
      return false;
    }

    if (!applyingSavedScales) scalesRestored = true;
    queuePersistCurrentScales();
    return true;
  }

  function closeScaleEditor() {
    if (activeEditor && activeEditor.root instanceof HTMLElement && activeEditor.root.isConnected) {
      activeEditor.root.remove();
    }
    activeEditor = null;
  }

  async function commitScaleEditor() {
    if (!activeEditor) {
      return false;
    }

    const { row, input } = activeEditor;
    const nextValue = input instanceof HTMLInputElement ? input.value : '';
    const applied = await setScaleForRow(row, nextValue);
    closeScaleEditor();
    return applied;
  }

  function openScaleEditor(row) {
    closeScaleEditor();

    const wrapper = row.slider.parentElement;
    if (!(wrapper instanceof HTMLElement)) {
      return;
    }

    const root = document.createElement('div');
    applyComponent(root, 'row');
    themeRoot(root, 'white');
    root.setAttribute(EDITOR_ATTR, row.key);
    root.style.position = 'absolute';
    root.style.left = '50%';
    root.style.top = '-10px';
    root.style.transform = 'translate(-50%, -100%)';
    root.style.display = 'flex';
    root.style.alignItems = 'center';
    root.style.justifyContent = 'center';
    root.style.width = '72px';
    root.style.height = '28px';
    root.style.zIndex = '6';

    const input = document.createElement('input');
    applyComponent(input, 'input');
    input.type = 'number';
    input.min = '0.3';
    input.max = String(getTargetMax());
    input.step = '0.1';
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', row.label + ' waveform scale');
    input.value = formatInputValue(row.slider.getAttribute('aria-valuenow'));
    input.style.width = '100%';
    input.style.height = '100%';
    input.style.outline = 'none';
    input.style.padding = '0 18px 0 10px';
    input.style.textAlign = 'center';
    input.style.appearance = 'textfield';
    input.style.MozAppearance = 'textfield';

    const suffix = document.createElement('span');
    applyComponent(suffix, 'meta');
    suffix.textContent = 'x';
    suffix.style.position = 'absolute';
    suffix.style.right = '9px';
    suffix.style.top = '50%';
    suffix.style.transform = 'translateY(-50%)';
    suffix.style.pointerEvents = 'none';

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commitScaleEditor();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeScaleEditor();
      }
    });
    input.addEventListener('blur', () => {
      void commitScaleEditor();
    });

    root.appendChild(input);
    root.appendChild(suffix);
    wrapper.appendChild(root);
    activeEditor = { row, root, input };

    input.focus({ preventScroll: true });
    input.select();
  }

  async function applySavedScales(revision) {
    const isCurrentTask = captureL0TaskGuard();
    const isCurrentBinding = () => revision === bindingRevision && isCurrentTask() && isFeatureEnabled('waveformScaleUnlock');
    applyingSavedScales = true;
    clearPersistTimer();
    try {
      const defaults = await ensureDefaults();
      // getEditorSnapshot starts its first refresh asynchronously. Await the
      // committed recording IDs before issuing any saved-scale mutation.
      const snapshot = await helper.refreshEditorSnapshot('waveform-scale-restore');
      if (!isCurrentBinding() || !snapshot) return false;
      const rows = getWaveformScaleRows();
      if (!rows.length) return false;
      const savedScales = defaults.waveformScales || {};
      for (const row of rows) {
        if (!isCurrentBinding()) return false;
        const saved = normalizeWaveformScaleValue(savedScales[row.key]);
        if (!Number.isFinite(saved)) continue;
        if (!await setScaleForRow(row, saved)) return false;
      }
      if (!isCurrentBinding()) return false;
      scalesRestored = true;
      return true;
    } finally {
      if (revision === bindingRevision) applyingSavedScales = false;
    }
  }

  function handleDocumentInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('[role="slider"][data-orientation="vertical"]')) {
      syncInputsFromSliders();
      queuePersistCurrentScales();
    }
  }

  function handleDocumentChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.matches('[role="slider"][data-orientation="vertical"]')) {
      queuePersistCurrentScales();
    }
  }

  function handleDocumentDoubleClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const slider = target.closest('[role="slider"][data-orientation="vertical"]');
    if (!(slider instanceof HTMLElement)) {
      return;
    }

    const row = getWaveformScaleRows().find((entry) => entry.slider === slider) || null;
    if (!row) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openScaleEditor(row);
  }

  function bindUiObservers() {
    if (controlsBound) {
      return;
    }

    controlsBound = true;
    document.addEventListener('input', handleDocumentInput, true);
    document.addEventListener('change', handleDocumentChange, true);
    document.addEventListener('dblclick', handleDocumentDoubleClick, true);

    if (typeof MutationObserver !== 'function') {
      return;
    }

    rowObserver = new MutationObserver(() => {
      queuePersistCurrentScales();
    });

    const firstRow = getWaveformScaleRows()[0];
    const observerRoot =
      firstRow?.lane?.closest('main') ||
      firstRow?.lane?.parentElement ||
      document.querySelector('main');
    if (!(observerRoot instanceof HTMLElement)) {
      return;
    }

    rowObserver.observe(observerRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-valuenow']
    });
    helper.perf?.count?.('observer.start', { name: 'waveform-scale', root: observerRoot.tagName });
  }

  function unbindUiObservers() {
    clearPersistTimer();

    if (rowObserver && typeof rowObserver.disconnect === 'function') {
      rowObserver.disconnect();
    }

    rowObserver = null;

    if (controlsBound) {
      document.removeEventListener('input', handleDocumentInput, true);
      document.removeEventListener('change', handleDocumentChange, true);
      document.removeEventListener('dblclick', handleDocumentDoubleClick, true);
    }

    controlsBound = false;
    closeScaleEditor();
  }

  helper.bindWaveformScaleUnlock = function bindWaveformScaleUnlock() {
    const isCurrentTask = captureL0TaskGuard();
    if (!isFeatureEnabled('waveformScaleUnlock')) {
      helper.unbindWaveformScaleUnlock();
      return false;
    }
    if (controlsBound || bindingPending) return true;
    const revision = ++bindingRevision;
    bindingPending = true;

    void callBridge('waveform-scale-unlock-enable', {
      max: getTargetMax()
    }).then(async result => {
      if (revision !== bindingRevision || !isCurrentTask() ||
          !isFeatureEnabled('waveformScaleUnlock') || !result?.ok) return;
      bindUiObservers();
      await applySavedScales(revision);
    }).finally(() => {
      if (revision === bindingRevision) bindingPending = false;
    });
    return true;
  };

  helper.unbindWaveformScaleUnlock = function unbindWaveformScaleUnlock() {
    bindingRevision += 1;
    bindingPending = false;
    scalesRestored = false;
    applyingSavedScales = false;
    unbindUiObservers();
    void callBridge('waveform-scale-unlock-disable', {});
  };
}
