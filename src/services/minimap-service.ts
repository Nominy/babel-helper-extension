// @ts-nocheck
export function registerMinimapService(helper: any) {
  if (!helper || helper.__minimapRegistered) {
    return;
  }

  helper.__minimapRegistered = true;

  const MINIMAP_ATTR = 'data-babel-helper-minimap';
  const HOST_ATTR = 'data-babel-helper-minimap-host';
  const BRIDGE_REQUEST_EVENT = 'babel-helper-magnifier-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-magnifier-response';
  const BRIDGE_SCRIPT_PATH = 'dist/content/magnifier-bridge.js';
  const BRIDGE_TIMEOUT_MS = 700;
  const MINIMAP_HEIGHT = 44;
  const MINIMAP_MAX_TRACKS = 2;
  const MUTATION_DEBOUNCE_MS = 220;

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;
  let markerId = 0;

  helper.state.minimap = null;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function nextMarker(prefix) {
    markerId += 1;
    return prefix + '-' + Date.now() + '-' + markerId;
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
      const id = 'minimap-request-' + bridgeRequestId;
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

  function discoverWaveformHosts() {
    return Array.from(document.querySelectorAll('div')).filter((node) => {
      if (
        !(node instanceof HTMLDivElement) ||
        !(node.shadowRoot instanceof ShadowRoot) ||
        !helper.isVisible(node)
      ) {
        return false;
      }

      const wrapper = node.shadowRoot.querySelector('[part="wrapper"]');
      const scroll = node.shadowRoot.querySelector('[part="scroll"]');
      return Boolean(
        wrapper instanceof HTMLElement &&
          scroll instanceof HTMLElement &&
          helper.isVisible(scroll)
      );
    });
  }

  function resolveWaveformHosts() {
    const stamped = Array.from(document.querySelectorAll('div[' + HOST_ATTR + ']')).filter((node) => {
      if (!(node instanceof HTMLDivElement) || !node.isConnected || !helper.isVisible(node)) {
        return false;
      }
      if (!(node.shadowRoot instanceof ShadowRoot)) {
        return false;
      }
      const wrapper = node.shadowRoot.querySelector('[part="wrapper"]');
      const scroll = node.shadowRoot.querySelector('[part="scroll"]');
      return Boolean(
        wrapper instanceof HTMLElement &&
          scroll instanceof HTMLElement &&
          helper.isVisible(scroll)
      );
    });
    if (stamped.length) {
      return stamped.slice(0, MINIMAP_MAX_TRACKS);
    }
    return discoverWaveformHosts().slice(0, MINIMAP_MAX_TRACKS);
  }

  function getScrollElement(host) {
    if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) {
      return null;
    }

    const scroll = host.shadowRoot.querySelector('[part="scroll"]');
    return scroll instanceof HTMLElement ? scroll : null;
  }

  function findPlaceholder() {
    const toolbar = document.querySelector('.flex.w-full.items-center.justify-start.gap-2');
    if (!(toolbar instanceof HTMLElement)) {
      return null;
    }

    const existing = toolbar.querySelector('[' + MINIMAP_ATTR + ']');
    if (existing instanceof HTMLElement) {
      return existing;
    }

    const minimap = document.createElement('div');
    minimap.setAttribute(MINIMAP_ATTR, 'true');
    minimap.style.position = 'relative';
    minimap.style.flex = '1 1 0';
    minimap.style.minWidth = '180px';
    minimap.style.height = MINIMAP_HEIGHT + 'px';
    minimap.style.boxSizing = 'border-box';
    minimap.style.border = '1px solid #cbd5e1';
    minimap.style.borderRadius = '6px';
    minimap.style.overflow = 'hidden';
    minimap.style.background = 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)';
    minimap.style.cursor = 'pointer';
    minimap.style.userSelect = 'none';
    minimap.style.touchAction = 'none';
    minimap.style.minHeight = MINIMAP_HEIGHT + 'px';
    minimap.style.alignSelf = 'stretch';
    toolbar.appendChild(minimap);

    return minimap;
  }

  function createTrackLane() {
    const lane = document.createElement('div');
    lane.style.position = 'absolute';
    lane.style.left = '0';
    lane.style.width = '100%';
    lane.style.boxSizing = 'border-box';
    lane.style.overflow = 'hidden';
    lane.style.pointerEvents = 'none';

    const tint = document.createElement('div');
    tint.style.position = 'absolute';
    tint.style.inset = '0';
    tint.style.background = 'rgba(148, 163, 184, 0.08)';
    lane.appendChild(tint);

    const waveform = document.createElement('canvas');
    waveform.style.position = 'absolute';
    waveform.style.inset = '0';
    waveform.style.width = '100%';
    waveform.style.height = '100%';
    waveform.style.pointerEvents = 'none';
    waveform.style.zIndex = '1';
    waveform.style.display = 'block';
    lane.appendChild(waveform);

    const regions = document.createElement('div');
    regions.style.position = 'absolute';
    regions.style.inset = '0';
    regions.style.pointerEvents = 'none';
    regions.style.zIndex = '2';
    lane.appendChild(regions);

    return {
      lane,
      waveform,
      regions
    };
  }

  function layoutTrackLanes(minimap, count) {
    const lanes = minimap.lanes;
    const visibleCount = Math.max(1, Math.min(count || 1, lanes.length));
    const laneHeight = 100 / visibleCount;

    for (let index = 0; index < lanes.length; index += 1) {
      const lane = lanes[index];
      if (index >= visibleCount) {
        lane.lane.style.display = 'none';
        lane.regions.replaceChildren();
        if (lane.waveform instanceof HTMLCanvasElement) {
          const ctx = lane.waveform.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, lane.waveform.width, lane.waveform.height);
          }
        }
        continue;
      }

      lane.lane.style.display = 'block';
      lane.lane.style.top = index * laneHeight + '%';
      lane.lane.style.height = laneHeight + '%';
      lane.lane.style.borderTop = index === 0 ? '0' : '1px solid rgba(148, 163, 184, 0.28)';
    }
  }

  function renderRegions(regionRoot, entries, duration) {
    regionRoot.replaceChildren();
    if (!(duration > 0) || !Array.isArray(entries) || !entries.length) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const start = Number(entry && entry.start);
      const end = Number(entry && entry.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        continue;
      }

      const left = clamp((start / duration) * 100, 0, 100);
      const width = clamp(((end - start) / duration) * 100, 0.35, 100);
      const region = document.createElement('div');
      region.style.position = 'absolute';
      region.style.left = left + '%';
      region.style.top = '3px';
      region.style.bottom = '3px';
      region.style.width = width + '%';
      region.style.minWidth = '1px';
      region.style.boxSizing = 'border-box';
      region.style.borderRadius = entry.borderRadius || '2px';
      region.style.backgroundColor = entry.backgroundColor || 'rgba(176, 131, 255, 0.25)';
      region.style.opacity = '0.7';
      region.style.borderLeft = entry.borderLeft || '';
      region.style.borderRight = entry.borderRight || '';
      region.style.filter = entry.filter || '';
      fragment.appendChild(region);
    }

    regionRoot.appendChild(fragment);
  }

  function drawMinimapWaveform(canvas, peaks) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== w) {
      canvas.width = w;
    }
    if (canvas.height !== h) {
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, w, h);

    if (!Array.isArray(peaks) || !peaks.length) {
      return;
    }

    let maxP = 0;
    for (let i = 0; i < peaks.length; i += 1) {
      const v = Math.abs(Number(peaks[i]) || 0);
      if (v > maxP) {
        maxP = v;
      }
    }

    const scale = maxP > 0 ? 1 / maxP : 1;
    const mid = h / 2;
    const n = peaks.length;
    const barW = w / n;
    ctx.fillStyle = 'rgba(71, 85, 105, 0.55)';

    for (let i = 0; i < n; i += 1) {
      const amp = Math.min(1, Math.abs(Number(peaks[i]) || 0) * scale) * mid * 0.9;
      const x = i * barW;
      ctx.fillRect(x, mid - amp, Math.max(1, barW + 0.5), amp * 2);
    }
  }

  function setViewport(minimap, leftRatio, widthRatio) {
    if (!(widthRatio > 0)) {
      minimap.viewport.style.display = 'none';
      return;
    }

    minimap.viewport.style.display = 'block';
    minimap.viewport.style.left = clamp(leftRatio * 100, 0, 100) + '%';
    minimap.viewport.style.width = clamp(widthRatio * 100, 0, 100) + '%';
  }

  function setPlayhead(minimap, time, duration) {
    minimap.playhead.style.display = 'none';
  }

  function clearRender(minimap) {
    minimap.fullSyncOk = false;
    layoutTrackLanes(minimap, 1);
    minimap.viewport.style.display = 'none';
    minimap.playhead.style.display = 'none';
    for (const lane of minimap.lanes) {
      lane.regions.replaceChildren();
      if (lane.waveform instanceof HTMLCanvasElement) {
        const ctx = lane.waveform.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, lane.waveform.width, lane.waveform.height);
        }
      }
    }
  }

  function ensureContainer(minimap) {
    const container = findPlaceholder();
    if (!(container instanceof HTMLElement)) {
      return false;
    }

    if (minimap.container !== container) {
      minimap.container = container;
      container.replaceChildren();
      container.appendChild(minimap.surface);
      if (minimap.resizeObserver) {
        minimap.resizeObserver.disconnect();
        minimap.resizeObserver.observe(container);
      }
      minimap.hostSignature = '';
    }

    return true;
  }

  function scheduleSync(minimap = helper.state.minimap) {
    if (!minimap || minimap.destroyed) {
      return;
    }

    if (minimap.rafId) {
      return;
    }

    minimap.rafId = window.requestAnimationFrame(() => {
      minimap.rafId = 0;
      void syncMinimap(minimap);
    });
  }

  function scheduleViewportUpdate(minimap = helper.state.minimap) {
    if (!minimap || minimap.destroyed) {
      return;
    }
    if (!minimap.fullSyncOk) {
      scheduleSync(minimap);
      return;
    }
    if (minimap.viewportRafId) {
      return;
    }
    minimap.viewportRafId = window.requestAnimationFrame(() => {
      minimap.viewportRafId = 0;
      void updateMinimapViewportOnly(minimap);
    });
  }

  async function updateMinimapViewportOnly(minimap) {
    if (!minimap || minimap.destroyed || !minimap.fullSyncOk) {
      return;
    }
    if (minimap.syncPending) {
      return;
    }

    if (!ensureContainer(minimap)) {
      return;
    }

    if (!minimap.hostMarkers[0]) {
      scheduleSync(minimap);
      return;
    }

    minimap.syncPending = true;
    try {
      const hostMarker = minimap.hostMarkers[0];
      const result = await callBridge('minimap-data', {
        hostMarker,
        viewportOnly: true
      });
      if (!result || !result.ok) {
        minimap.fullSyncOk = false;
        scheduleSync(minimap);
        return;
      }

      const duration = Number(result.duration) || 0;
      if (minimap.duration > 0 && duration > 0 && Math.abs(duration - minimap.duration) > 1) {
        scheduleSync(minimap);
        return;
      }

      const totalWidth = Number(result.totalWidth) || 0;
      const visibleWidth = Number(result.visibleWidth) || 0;
      const scrollLeft = Number(result.scrollLeft) || 0;

      if (totalWidth > 0 && visibleWidth > 0) {
        const leftRatio = scrollLeft / totalWidth;
        const widthRatio = visibleWidth / totalWidth;
        setViewport(minimap, leftRatio, widthRatio);
      } else {
        minimap.viewport.style.display = 'none';
      }

      setPlayhead(minimap, Number(result.currentTime) || 0, duration || minimap.duration);
    } catch (_error) {
      minimap.fullSyncOk = false;
      scheduleSync(minimap);
    } finally {
      minimap.syncPending = false;
      if (minimap.syncQueued) {
        minimap.syncQueued = false;
        scheduleSync(minimap);
      }
    }
  }

  function disconnectHostObservers(minimap) {
    for (const dispose of minimap.scrollDisposers) {
      dispose();
    }
    minimap.scrollDisposers = [];

    if (minimap.resizeObserver) {
      minimap.resizeObserver.disconnect();
      minimap.resizeObserver.observe(minimap.container);
    }
  }

  function bindHostObservers(minimap, hosts) {
    const signature = hosts
      .map((host, index) => {
        const marker = host.getAttribute(HOST_ATTR) || nextMarker('minimap-host-' + index);
        host.setAttribute(HOST_ATTR, marker);
        return marker;
      })
      .join('|');

    if (signature === minimap.hostSignature) {
      return;
    }

    minimap.hostSignature = signature;
    minimap.hostMarkers = hosts.map((host) => host.getAttribute(HOST_ATTR) || '');

    disconnectHostObservers(minimap);

    for (const host of hosts) {
      const scroll = getScrollElement(host);
      if (scroll instanceof HTMLElement) {
        const onScroll = () => scheduleViewportUpdate(minimap);
        scroll.addEventListener('scroll', onScroll, { passive: true });
        minimap.scrollDisposers.push(() => {
          scroll.removeEventListener('scroll', onScroll);
        });
        if (minimap.resizeObserver) {
          minimap.resizeObserver.observe(scroll);
        }
      }

      if (minimap.resizeObserver) {
        minimap.resizeObserver.observe(host);
      }
    }
  }

  function createMinimap() {
    const container = findPlaceholder();
    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const surface = document.createElement('div');
    surface.style.position = 'absolute';
    surface.style.inset = '0';
    surface.style.pointerEvents = 'auto';
    surface.style.overflow = 'hidden';

    const lanes = [];
    for (let index = 0; index < MINIMAP_MAX_TRACKS; index += 1) {
      const lane = createTrackLane();
      surface.appendChild(lane.lane);
      lanes.push(lane);
    }

    const viewport = document.createElement('div');
    viewport.style.position = 'absolute';
    viewport.style.top = '0';
    viewport.style.bottom = '0';
    viewport.style.left = '0';
    viewport.style.width = '0';
    viewport.style.display = 'none';
    viewport.style.pointerEvents = 'none';
    viewport.style.background = 'rgba(14, 165, 233, 0.12)';
    viewport.style.border = '1px solid rgba(2, 132, 199, 0.9)';
    viewport.style.boxSizing = 'border-box';
    viewport.style.zIndex = '5';
    surface.appendChild(viewport);

    const playhead = document.createElement('div');
    playhead.style.position = 'absolute';
    playhead.style.top = '0';
    playhead.style.bottom = '0';
    playhead.style.width = '2px';
    playhead.style.marginLeft = '-1px';
    playhead.style.display = 'none';
    playhead.style.background = '#ef4444';
    playhead.style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.7)';
    playhead.style.pointerEvents = 'none';
    playhead.style.zIndex = '6';
    surface.appendChild(playhead);

    const state = {
      container,
      surface,
      lanes,
      viewport,
      playhead,
      syncPending: false,
      syncQueued: false,
      rafId: 0,
      destroyed: false,
      hostSignature: '',
      hostMarkers: [],
      scrollDisposers: [],
      pointerActive: false,
      duration: 0,
      navigatePendingTime: null,
      navigateInFlight: false,
      resizeObserver: null,
      mutationObserver: null,
      onWindowResize: null,
      viewportRafId: 0,
      fullSyncOk: false,
      mutationDebounceTimer: 0
    };

    container.replaceChildren();
    container.appendChild(surface);

    const updateFromPointer = (event) => {
      const rect = state.container.getBoundingClientRect();
      if (!(rect.width > 0) || !(state.duration > 0) || !state.hostMarkers[0]) {
        return;
      }

      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      queueNavigate(state, ratio * state.duration);
    };

    surface.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }

      state.pointerActive = true;
      if (typeof surface.setPointerCapture === 'function') {
        try {
          surface.setPointerCapture(event.pointerId);
        } catch (_error) {
          // Ignore pointer capture failures on detached nodes.
        }
      }
      updateFromPointer(event);
      event.preventDefault();
    });

    surface.addEventListener('pointermove', (event) => {
      if (!state.pointerActive || !(event.buttons & 1)) {
        return;
      }
      updateFromPointer(event);
      event.preventDefault();
    });

    const releasePointer = (event) => {
      if (!state.pointerActive) {
        return;
      }
      state.pointerActive = false;
      if (typeof surface.releasePointerCapture === 'function') {
        try {
          surface.releasePointerCapture(event.pointerId);
        } catch (_error) {
          // Ignore pointer capture failures on detached nodes.
        }
      }
    };

    surface.addEventListener('pointerup', releasePointer);
    surface.addEventListener('pointercancel', releasePointer);

    if (typeof ResizeObserver === 'function') {
      state.resizeObserver = new ResizeObserver(() => {
        scheduleSync(state);
      });
      state.resizeObserver.observe(container);
    } else {
      state.onWindowResize = () => scheduleSync(state);
      window.addEventListener('resize', state.onWindowResize, true);
    }

    if (document.body instanceof HTMLElement && typeof MutationObserver === 'function') {
      const requestDebouncedFullSync = () => {
        if (state.mutationDebounceTimer) {
          window.clearTimeout(state.mutationDebounceTimer);
        }
        state.mutationDebounceTimer = window.setTimeout(() => {
          state.mutationDebounceTimer = 0;
          scheduleSync(state);
        }, MUTATION_DEBOUNCE_MS);
      };
      state.mutationObserver = new MutationObserver(requestDebouncedFullSync);
      state.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
      });
    }

    return state;
  }

  function queueNavigate(minimap, time) {
    if (!minimap || minimap.destroyed || !(time >= 0) || !minimap.hostMarkers[0]) {
      return;
    }

    minimap.navigatePendingTime = time;
    if (minimap.navigateInFlight) {
      return;
    }

    minimap.navigateInFlight = true;
    void (async () => {
      try {
        while (minimap.navigatePendingTime != null && !minimap.destroyed) {
          const nextTime = minimap.navigatePendingTime;
          minimap.navigatePendingTime = null;
          await callBridge('navigate-source', {
            hostMarker: minimap.hostMarkers[0],
            time: nextTime
          });
        }
      } finally {
        minimap.navigateInFlight = false;
        scheduleSync(minimap);
      }
    })();
  }

  async function syncMinimap(minimap) {
    if (!minimap || minimap.destroyed) {
      return;
    }

    if (minimap.syncPending) {
      minimap.syncQueued = true;
      return;
    }

    minimap.syncPending = true;

    try {
      if (!ensureContainer(minimap)) {
        clearRender(minimap);
        return;
      }

      const hosts = resolveWaveformHosts();
      if (!hosts.length) {
        disconnectHostObservers(minimap);
        minimap.hostMarkers = [];
        minimap.hostSignature = '';
        clearRender(minimap);
        return;
      }

      bindHostObservers(minimap, hosts);

      const containerRect = minimap.container.getBoundingClientRect();
      const peakBins = clamp(
        Math.ceil((Number(containerRect.width) || 180) * Math.min(2, window.devicePixelRatio || 1)),
        128,
        1200
      );

      const tracks = [];
      for (let index = 0; index < hosts.length; index += 1) {
        const host = hosts[index];
        const hostMarker = host.getAttribute(HOST_ATTR) || nextMarker('minimap-host-' + index);
        host.setAttribute(HOST_ATTR, hostMarker);

        const result = await callBridge('minimap-data', {
          hostMarker,
          peakBins
        });
        if (result && result.ok) {
          tracks.push(result);
        }
      }

      if (!tracks.length) {
        clearRender(minimap);
        return;
      }

      const duration = tracks.reduce((max, track) => Math.max(max, Number(track.duration) || 0), 0);
      minimap.duration = duration;

      layoutTrackLanes(minimap, tracks.length);
      for (let index = 0; index < minimap.lanes.length; index += 1) {
        const lane = minimap.lanes[index];
        const track = tracks[index];
        drawMinimapWaveform(lane.waveform, track && track.peaks ? track.peaks : []);
        renderRegions(lane.regions, track ? track.regions : [], duration);
      }

      const primary = tracks[0];
      const totalWidth = Number(primary.totalWidth) || 0;
      const visibleWidth = Number(primary.visibleWidth) || 0;
      const scrollLeft = Number(primary.scrollLeft) || 0;

      if (totalWidth > 0 && visibleWidth > 0) {
        const leftRatio = scrollLeft / totalWidth;
        const widthRatio = visibleWidth / totalWidth;
        setViewport(minimap, leftRatio, widthRatio);
      } else {
        minimap.viewport.style.display = 'none';
      }

      setPlayhead(minimap, Number(primary.currentTime) || 0, duration);
      minimap.fullSyncOk = true;
    } catch (_error) {
      clearRender(minimap);
    } finally {
      minimap.syncPending = false;
      if (minimap.syncQueued) {
        minimap.syncQueued = false;
        scheduleSync(minimap);
      }
    }
  }

  helper.clearMinimap = function clearMinimap() {
    const minimap = helper.state.minimap;
    if (!minimap) {
      return;
    }

    minimap.destroyed = true;
    if (minimap.rafId) {
      window.cancelAnimationFrame(minimap.rafId);
      minimap.rafId = 0;
    }
    if (minimap.viewportRafId) {
      window.cancelAnimationFrame(minimap.viewportRafId);
      minimap.viewportRafId = 0;
    }
    if (minimap.mutationDebounceTimer) {
      window.clearTimeout(minimap.mutationDebounceTimer);
      minimap.mutationDebounceTimer = 0;
    }
    disconnectHostObservers(minimap);

    if (minimap.resizeObserver) {
      minimap.resizeObserver.disconnect();
    }
    if (minimap.mutationObserver) {
      minimap.mutationObserver.disconnect();
    }
    if (typeof minimap.onWindowResize === 'function') {
      window.removeEventListener('resize', minimap.onWindowResize, true);
    }

    if (minimap.container instanceof HTMLElement) {
      minimap.container.replaceChildren();
    }

    helper.state.minimap = null;
  };

  helper.bindMinimap = function bindMinimap() {
    if (helper.state.minimap) {
      scheduleSync(helper.state.minimap);
      return;
    }

    const minimap = createMinimap();
    if (!minimap) {
      return;
    }

    helper.state.minimap = minimap;
    scheduleSync(minimap);
  };

  helper.unbindMinimap = function unbindMinimap() {
    const minimap = helper.state.minimap;
    if (!minimap) {
      return;
    }

    if (minimap.viewportRafId) {
      window.cancelAnimationFrame(minimap.viewportRafId);
      minimap.viewportRafId = 0;
    }
    if (minimap.mutationDebounceTimer) {
      window.clearTimeout(minimap.mutationDebounceTimer);
      minimap.mutationDebounceTimer = 0;
    }
    disconnectHostObservers(minimap);
    if (minimap.mutationObserver) {
      minimap.mutationObserver.disconnect();
      minimap.mutationObserver = null;
    }
    if (typeof minimap.onWindowResize === 'function') {
      window.removeEventListener('resize', minimap.onWindowResize, true);
      minimap.onWindowResize = null;
    }
  };
}
