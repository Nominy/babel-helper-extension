// @ts-nocheck
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
  const BRIDGE_REQUEST_EVENT = 'babel-helper-magnifier-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-magnifier-response';
  const BRIDGE_SCRIPT_PATH = 'dist/content/magnifier-bridge.js';
  const BRIDGE_TIMEOUT_MS = 700;
  const SAVE_DEBOUNCE_MS = 220;

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;
  let rowObserver = null;
  let persistTimer = 0;
  let defaultsLoaded = false;
  let cachedDefaults = null;
  let applyingSavedScales = false;
  let controlsBound = false;
  let activeEditor = null;

  function isFeatureEnabled(featureKey) {
    if (typeof helper.isFeatureEnabled === 'function') {
      return helper.isFeatureEnabled(featureKey);
    }

    return true;
  }

  function getTargetMax() {
    return EXTENDED_MAX;
  }

  function injectBridge() {
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
      if (
        !parent ||
        typeof chrome === 'undefined' ||
        !chrome.runtime ||
        typeof chrome.runtime.getURL !== 'function'
      ) {
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH);
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
    const ready = await injectBridge();
    if (!ready) {
      return null;
    }

    return new Promise((resolve) => {
      bridgeRequestId += 1;
      const id = 'waveform-scale-' + bridgeRequestId;
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
    const sliders = Array.from(
      document.querySelectorAll<HTMLElement>('[role="slider"][data-orientation="vertical"]')
    );

    return sliders
      .map((slider, index) => {
        const lane = slider.closest('div.flex.h-full') || slider.closest('div');
        const heading = lane?.querySelector('h3');
        const label = heading instanceof HTMLElement ? helper.normalizeText(heading) : '';
        const key = label || 'lane-' + index;
        return {
          index,
          key,
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
    if (applyingSavedScales) {
      return;
    }

    const defaults = await ensureDefaults();
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
    const normalized = normalizeWaveformScaleValue(value);
    if (!Number.isFinite(normalized)) {
      return false;
    }

    const result = await callBridge('waveform-scale-set', {
      index: row.index,
      value: normalized,
      max: getTargetMax()
    });

    if (!result || !result.ok) {
      return false;
    }

    row.slider.setAttribute('aria-valuenow', String(result.current ?? normalized));
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
    root.style.border = '1px solid rgba(100, 116, 139, 0.35)';
    root.style.borderRadius = '999px';
    root.style.background = 'rgba(255, 255, 255, 0.98)';
    root.style.boxShadow = '0 6px 20px rgba(15, 23, 42, 0.16)';
    root.style.zIndex = '6';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.3';
    input.max = String(getTargetMax());
    input.step = '0.1';
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', row.label + ' waveform scale');
    input.value = formatInputValue(row.slider.getAttribute('aria-valuenow'));
    input.style.width = '100%';
    input.style.height = '100%';
    input.style.border = '0';
    input.style.outline = 'none';
    input.style.borderRadius = '999px';
    input.style.padding = '0 18px 0 10px';
    input.style.fontSize = '12px';
    input.style.fontWeight = '700';
    input.style.textAlign = 'center';
    input.style.background = 'transparent';
    input.style.color = '#0f172a';
    input.style.appearance = 'textfield';
    input.style.MozAppearance = 'textfield';

    const suffix = document.createElement('span');
    suffix.textContent = 'x';
    suffix.style.position = 'absolute';
    suffix.style.right = '9px';
    suffix.style.top = '50%';
    suffix.style.transform = 'translateY(-50%)';
    suffix.style.fontSize = '11px';
    suffix.style.fontWeight = '700';
    suffix.style.color = '#475569';
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

  async function applySavedScales() {
    const defaults = await ensureDefaults();
    const savedScales = defaults.waveformScales || {};
    const rows = getWaveformScaleRows();
    if (!rows.length) {
      return false;
    }

    applyingSavedScales = true;
    try {
      for (const row of rows) {
        const saved = normalizeWaveformScaleValue(savedScales[row.key]);
        if (!Number.isFinite(saved)) {
          continue;
        }

        await setScaleForRow(row, saved);
      }
    } finally {
      applyingSavedScales = false;
    }

    return true;
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

    if (!(document.body instanceof HTMLElement) || typeof MutationObserver !== 'function') {
      return;
    }

    rowObserver = new MutationObserver(() => {
      queuePersistCurrentScales();
    });

    rowObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-valuenow']
    });
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
    if (!isFeatureEnabled('waveformScaleUnlock')) {
      helper.unbindWaveformScaleUnlock();
      return false;
    }

    void callBridge('waveform-scale-unlock-enable', {
      max: getTargetMax()
    }).then(() => {
      bindUiObservers();
      void applySavedScales();
    });
    return true;
  };

  helper.unbindWaveformScaleUnlock = function unbindWaveformScaleUnlock() {
    unbindUiObservers();
    void callBridge('waveform-scale-unlock-disable', {});
  };
}
