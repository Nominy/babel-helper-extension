// @ts-nocheck
import { loadWorkflowDefaults, updateWorkflowDefaults, normalizeZoomValue } from '../core/workflow-defaults';
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerZoomPersistence(helper: any, api: Pick<TimelineModules, 'site'>) {
  const ZOOM_PERSIST_DEBOUNCE_MS = 240;

  let zoomPersistenceSlider = null;

  let zoomPersistenceObserver = null;

  let zoomPersistenceRootObserver = null;

  let zoomPersistenceTimer = 0;

  let zoomPersistenceApplying = false;

  let zoomPersistenceLoaded = false;

  let zoomPersistenceDefaults = null;

  let zoomPersistenceSaveChain = Promise.resolve();


  function clearZoomPersistenceTimer() {
    if (zoomPersistenceTimer) {
      window.clearTimeout(zoomPersistenceTimer);
      zoomPersistenceTimer = 0;
    }
  }


  function clearZoomPersistenceRootObserver() {
    if (zoomPersistenceRootObserver && typeof zoomPersistenceRootObserver.disconnect === 'function') {
      zoomPersistenceRootObserver.disconnect();
    }
    zoomPersistenceRootObserver = null;
  }


  function scheduleZoomPersistenceRootObserver() {
    if (zoomPersistenceRootObserver || typeof MutationObserver !== 'function') {
      return;
    }

    const root = document.body || document.documentElement;
    if (!(root instanceof HTMLElement)) {
      return;
    }

    zoomPersistenceRootObserver = new MutationObserver(() => {
      const slider = api.site.getZoomSliderElement();
      if (!(slider instanceof HTMLElement)) {
        return;
      }

      clearZoomPersistenceRootObserver();
      helper.bindZoomPersistence();
      if (typeof helper.applySavedZoomDefault === 'function') {
        void helper.applySavedZoomDefault().catch(() => { });
      }
    });

    zoomPersistenceRootObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-valuenow', 'aria-valuemax']
    });
  }


  function getNumericZoomValueFromSlider(slider) {
    if (!(slider instanceof HTMLElement)) {
      return null;
    }

    const numeric = Number(slider.getAttribute('aria-valuenow'));
    return Number.isFinite(numeric) ? numeric : null;
  }


  async function ensureZoomPersistenceDefaults() {
    if (zoomPersistenceLoaded && zoomPersistenceDefaults) {
      return zoomPersistenceDefaults;
    }

    const loaded = await loadWorkflowDefaults();
    zoomPersistenceDefaults = loaded;
    zoomPersistenceLoaded = true;
    return loaded;
  }


  async function persistZoomValue(value) {
    if (!api.site.isFeatureEnabled('timelineZoomDefaults')) {
      return;
    }

    const normalized = normalizeZoomValue(value);
    if (!Number.isFinite(normalized)) {
      return;
    }

    const defaults = await ensureZoomPersistenceDefaults();
    if (defaults.lastZoomValue === normalized) {
      return;
    }

    const saved = await updateWorkflowDefaults((currentDefaults) => ({
      ...currentDefaults,
      lastZoomValue: normalized
    }));
    zoomPersistenceDefaults = saved;
    zoomPersistenceLoaded = true;
  }


  function queuePersistZoomValue(value) {
    zoomPersistenceSaveChain = zoomPersistenceSaveChain
      .then(() => persistZoomValue(value))
      .catch(() => { });
  }


  function scheduleZoomPersistenceFromSlider(slider) {
    if (!api.site.isFeatureEnabled('timelineZoomDefaults')) {
      return;
    }

    if (zoomPersistenceApplying) {
      return;
    }

    const value = getNumericZoomValueFromSlider(slider);
    if (!Number.isFinite(value)) {
      return;
    }

    clearZoomPersistenceTimer();
    zoomPersistenceTimer = window.setTimeout(() => {
      zoomPersistenceTimer = 0;
      queuePersistZoomValue(value);
    }, ZOOM_PERSIST_DEBOUNCE_MS);
  }


  function getZoomValueCallbacks(slider) {
    if (!(slider instanceof HTMLElement)) {
      return [];
    }

    const callbacks = [];
    let node = api.site.getReactFiber(slider);
    let depth = 0;
    while (node && typeof node === 'object' && depth < 40) {
      const props = node.memoizedProps;
      if (props && typeof props === 'object' && typeof props.onValueChange === 'function') {
        callbacks.push(props.onValueChange);
      }

      node = node.return;
      depth += 1;
    }

    return callbacks;
  }


  async function applyZoomValueToSlider(value) {
    const slider = api.site.getZoomSliderElement();
    if (!(slider instanceof HTMLElement)) {
      return false;
    }

    const sliderMin = Number(slider.getAttribute('aria-valuemin'));
    const sliderMax = Number(slider.getAttribute('aria-valuemax'));
    if (!Number.isFinite(sliderMin) || !Number.isFinite(sliderMax) || sliderMax <= sliderMin) {
      return false;
    }

    const normalized = normalizeZoomValue(value);
    if (!Number.isFinite(normalized)) {
      return false;
    }

    const target = Math.min(sliderMax, Math.max(sliderMin, normalized));
    const current = getNumericZoomValueFromSlider(slider);
    if (Number.isFinite(current) && Math.abs(current - target) <= 0.5) {
      return true;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let invoked = false;
      const bridgeResult = await api.site.callSelectionBridge('zoom-set', {
        value: target
      });
      if (bridgeResult && bridgeResult.ok) {
        invoked = true;
      }

      if (!invoked) {
        const callbacks = getZoomValueCallbacks(slider);
        for (const callback of callbacks) {
          try {
            callback([target]);
            invoked = true;
          } catch (_error) {
            // Ignore callback shape mismatches; additional callbacks may still apply.
          }
        }
      }

      if (!invoked) {
        return false;
      }

      const settled = await helper.waitFor(() => {
        const refreshedSlider = api.site.getZoomSliderElement();
        const refreshedValue = getNumericZoomValueFromSlider(refreshedSlider);
        return Number.isFinite(refreshedValue) && Math.abs(refreshedValue - target) <= 1
          ? refreshedSlider
          : null;
      }, 240, 20);
      if (settled) {
        return true;
      }

      await helper.sleep(32);
    }

    return false;
  }


  helper.bindZoomPersistence = function bindZoomPersistence() {
    if (!api.site.isFeatureEnabled('timelineZoomDefaults')) {
      helper.unbindZoomPersistence();
      return false;
    }

    const slider = api.site.getZoomSliderElement();
    if (!(slider instanceof HTMLElement) || typeof MutationObserver !== 'function') {
      scheduleZoomPersistenceRootObserver();
      return false;
    }

    clearZoomPersistenceRootObserver();

    if (zoomPersistenceSlider === slider && zoomPersistenceObserver) {
      return true;
    }

    if (zoomPersistenceObserver && typeof zoomPersistenceObserver.disconnect === 'function') {
      zoomPersistenceObserver.disconnect();
    }

    zoomPersistenceSlider = slider;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'aria-valuenow') {
          scheduleZoomPersistenceFromSlider(slider);
          return;
        }
      }
    });

    observer.observe(slider, {
      attributes: true,
      attributeFilter: ['aria-valuenow']
    });

    zoomPersistenceObserver = observer;
    return true;
  };


  helper.unbindZoomPersistence = function unbindZoomPersistence() {
    clearZoomPersistenceTimer();
    clearZoomPersistenceRootObserver();

    if (zoomPersistenceObserver && typeof zoomPersistenceObserver.disconnect === 'function') {
      zoomPersistenceObserver.disconnect();
    }

    zoomPersistenceObserver = null;
    zoomPersistenceSlider = null;
  };


  helper.applySavedZoomDefault = async function applySavedZoomDefault() {
    if (!api.site.isFeatureEnabled('timelineZoomDefaults')) {
      return false;
    }

    const slider =
      api.site.getZoomSliderElement() ||
      (await helper.waitFor(() => api.site.getZoomSliderElement(), 1000, 50));
    if (!(slider instanceof HTMLElement)) {
      return false;
    }

    helper.bindZoomPersistence();

    const defaults = await ensureZoomPersistenceDefaults();
    const targetValue = normalizeZoomValue(defaults.lastZoomValue);
    if (!Number.isFinite(targetValue)) {
      return false;
    }

    const currentValue = getNumericZoomValueFromSlider(slider);
    if (Number.isFinite(currentValue) && Math.abs(currentValue - targetValue) <= 0.5) {
      return true;
    }

    zoomPersistenceApplying = true;
    clearZoomPersistenceTimer();
    try {
      // The decoded-waveform wait only defers the apply; when the bridge is
      // unavailable or the wait times out, fall back to the proven immediate
      // apply instead of leaving the saved default unapplied.
      const ready = await api.site.callSelectionBridge('zoom-ready', { timeoutMs: 30000 });
      if (
        ready?.reason === 'missing-slider' ||
        !slider.isConnected ||
        !api.site.isFeatureEnabled('timelineZoomDefaults')
      ) {
        return false;
      }

      return await applyZoomValueToSlider(targetValue);
    } finally {
      window.setTimeout(() => {
        zoomPersistenceApplying = false;
      }, 120);
    }
  };

  return {};
}
