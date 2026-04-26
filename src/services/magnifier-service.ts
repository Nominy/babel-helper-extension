// @ts-nocheck
export function registerMagnifierService(helper: any) {
  if (!helper || helper.__magnifierRegistered) {
    return;
  }

  helper.__magnifierRegistered = true;

  const MAGNIFIER_ATTR = "data-babel-helper-magnifier";
  const HOST_MARKER_ATTR = "data-babel-helper-magnifier-host";
  const MOUNT_MARKER_ATTR = "data-babel-helper-magnifier-mount";
  const BRIDGE_REQUEST_EVENT = "babel-helper-magnifier-request";
  const BRIDGE_RESPONSE_EVENT = "babel-helper-magnifier-response";
  const BRIDGE_SCRIPT_PATH = "dist/content/magnifier-bridge.js";
  const SCALE = 3;
  const WIDTH = 180;
  const MAX_HEIGHT = 150;
  const INSET = 6;
  const BRIDGE_TIMEOUT_MS = 700;

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;
  let markerId = 0;

  helper.state.magnifier = null;
  helper.state.magnifierDrag = null;
  helper.config.hotkeysHelpRows.unshift([
    "Drag Segment Edge",
    `Show ${SCALE}x waveform magnifier while trimming`,
  ]);

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function nextMarker(prefix) {
    markerId += 1;
    return prefix + "-" + Date.now() + "-" + markerId;
  }

  function parseSeconds(value) {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = trimmed.toLowerCase();

    const timestampMatch = normalized.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
    if (timestampMatch) {
      const parts = timestampMatch[0].split(":");
      let total = 0;
      for (const part of parts) {
        const numeric = Number(part);
        if (!Number.isFinite(numeric)) {
          return null;
        }
        total = total * 60 + numeric;
      }
      return total;
    }

    let total = 0;
    let foundUnit = false;
    const unitPattern = /(-?\d+(?:\.\d+)?)\s*([hms])/g;
    for (const match of normalized.matchAll(unitPattern)) {
      const numeric = Number(match[1]);
      if (!Number.isFinite(numeric)) {
        return null;
      }

      foundUnit = true;
      const unit = match[2];
      if (unit === "h") {
        total += numeric * 3600;
      } else if (unit === "m") {
        total += numeric * 60;
      } else {
        total += numeric;
      }
    }

    if (foundUnit) {
      return total;
    }

    const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!numericMatch) {
      return null;
    }

    const numeric = Number(numericMatch[0]);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function getPartTokens(element) {
    const part = element instanceof Element ? element.getAttribute("part") : "";
    return part ? part.split(/\s+/).filter(Boolean) : [];
  }

  function getHandleSide(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const tokens = getPartTokens(element);
    if (
      tokens.includes("region-handle-left") ||
      (tokens.includes("region-handle") && tokens.includes("region-handle-left"))
    ) {
      return "left";
    }

    if (
      tokens.includes("region-handle-right") ||
      (tokens.includes("region-handle") && tokens.includes("region-handle-right"))
    ) {
      return "right";
    }

    return null;
  }

  function getOwningRegion(element) {
    let current = element instanceof HTMLElement ? element : null;
    while (current instanceof HTMLElement) {
      const tokens = getPartTokens(current);
      if (tokens.includes("region")) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  function isWaveformScope(scope) {
    if (!scope || typeof scope.querySelector !== "function") {
      return false;
    }

    return Boolean(
      scope.querySelector('[part="regions-container"]') &&
      scope.querySelector('[part="hover"]') &&
      scope.querySelector('[part="wrapper"]') &&
      scope.querySelector('[part="scroll"]'),
    );
  }

  function getWaveformScopeFromNode(node) {
    let current = node instanceof HTMLElement ? node : null;
    while (current instanceof HTMLElement) {
      if (current.shadowRoot && isWaveformScope(current.shadowRoot)) {
        return current.shadowRoot;
      }

      if (isWaveformScope(current)) {
        return current;
      }

      current = current.parentElement;
    }

    const root =
      node && typeof node.getRootNode === "function"
        ? node.getRootNode()
        : null;
    if (root instanceof ShadowRoot && isWaveformScope(root)) {
      return root;
    }

    return null;
  }

  function getWaveformContextFromEvent(event) {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      const scope = getWaveformScopeFromNode(node);
      if (!scope) {
        continue;
      }

      const container = scope.querySelector('[part="regions-container"]');
      const host = scope instanceof ShadowRoot ? scope.host : null;
      if (container instanceof HTMLElement && host instanceof HTMLElement) {
        return {
          scope,
          container,
          host,
        };
      }
    }

    return null;
  }

  function getHoverData(scope, containerRect) {
    if (!scope || typeof scope.querySelector !== "function") {
      return null;
    }

    const hover = scope.querySelector('[part="hover"]');
    if (!(hover instanceof HTMLElement) || !hover.isConnected) {
      return null;
    }

    const transform = hover.style.transform || "";
    const match = transform.match(/translateX\((-?\d+(?:\.\d+)?)px\)/i);
    if (!match) {
      return null;
    }

    const hoverStyle = window.getComputedStyle(hover);
    if (Number(hoverStyle.opacity || "1") <= 0) {
      return null;
    }

    const label = hover.querySelector('[part="hover-label"]');
    const text = helper.normalizeText(label);
    const timeSeconds = parseSeconds(text);
    if (!Number.isFinite(timeSeconds)) {
      return null;
    }

    return {
      x: clamp(Number(match[1]), 0, containerRect.width),
      text,
      timeSeconds,
    };
  }

  function getRegionBoundaryTime(region, side) {
    if (!(region instanceof HTMLElement)) {
      return null;
    }

    const selector =
      side === "left"
        ? ".wavesurfer-region-tooltip-start"
        : ".wavesurfer-region-tooltip-end";
    const node = region.querySelector(selector);
    const text = helper.normalizeText(node);
    const timeSeconds = parseSeconds(text);
    if (!Number.isFinite(timeSeconds)) {
      return null;
    }

    return {
      text,
      timeSeconds,
    };
  }

  function getDragContextFromEvent(event) {
    if (!event || event.button !== 0) {
      return null;
    }

    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      const side = getHandleSide(node);
      if (!side) {
        continue;
      }

      const handle = node instanceof HTMLElement ? node : null;
      const region = getOwningRegion(handle);
      const waveform = getWaveformContextFromEvent(event);
      if (
        handle instanceof HTMLElement &&
        region instanceof HTMLElement &&
        waveform
      ) {
        return {
          pointerId: typeof event.pointerId === "number" ? event.pointerId : 1,
          handle,
          region,
          side,
          scope: waveform.scope,
          container: waveform.container,
          host: waveform.host,
        };
      }
    }

    return null;
  }

  function getDragData(drag, containerRect) {
    if (
      !drag ||
      !(drag.handle instanceof HTMLElement) ||
      !(drag.region instanceof HTMLElement) ||
      !(drag.container instanceof HTMLElement) ||
      !drag.handle.isConnected ||
      !drag.region.isConnected
    ) {
      return null;
    }

    const rect = drag.handle.getBoundingClientRect();
    const x = clamp(rect.left + rect.width / 2 - containerRect.left, 0, containerRect.width);
    const boundary = getRegionBoundaryTime(drag.region, drag.side);
    if (boundary) {
      return {
        x,
        text: boundary.text,
        timeSeconds: boundary.timeSeconds,
      };
    }

    const hover = getHoverData(drag.scope, containerRect);
    if (hover) {
      return {
        x,
        text: hover.text,
        timeSeconds: hover.timeSeconds,
      };
    }

    return null;
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
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        typeof chrome.runtime.getURL !== "function"
      ) {
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }

      const script = document.createElement("script");
      try {
        script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH);
      } catch (_error) {
        script.remove();
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }
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
      const id = "request-" + bridgeRequestId;
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

      const timeoutId = window.setTimeout(
        () => finish(null),
        BRIDGE_TIMEOUT_MS,
      );
      window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
      window.dispatchEvent(
        new CustomEvent(BRIDGE_REQUEST_EVENT, {
          detail: {
            id,
            operation,
            payload: payload || {},
          },
        }),
      );
    });
  }

  function setStatus(magnifier, text) {
    if (magnifier && magnifier.badge instanceof HTMLElement) {
      magnifier.badge.textContent = text;
    }
  }

  function renderRegions(
    magnifier,
    entries,
    windowStart,
    windowEnd,
    width,
    height,
  ) {
    if (!(magnifier.regionsLayer instanceof HTMLElement)) {
      return;
    }

    magnifier.regionsLayer.replaceChildren();
    const span = windowEnd - windowStart;
    if (!(span > 0)) {
      return;
    }

    for (const entry of entries) {
      const visibleStart = Math.max(windowStart, entry.start);
      const visibleEnd = Math.min(windowEnd, entry.end);
      if (visibleEnd <= visibleStart) {
        continue;
      }

      const region = document.createElement("div");
      region.style.position = "absolute";
      region.style.top = "0";
      region.style.left = ((visibleStart - windowStart) / span) * width + "px";
      region.style.width =
        Math.max(2, ((visibleEnd - visibleStart) / span) * width) + "px";
      region.style.height = height + "px";
      region.style.boxSizing = "border-box";
      region.style.pointerEvents = "none";
      region.style.borderRadius = entry.borderRadius;
      region.style.backgroundColor = entry.backgroundColor;
      region.style.borderLeft = entry.borderLeft;
      region.style.borderRight = entry.borderRight;
      region.style.filter = entry.filter;
      magnifier.regionsLayer.appendChild(region);
    }
  }

  function createMagnifier(context) {
    const element = document.createElement("div");
    element.setAttribute(MAGNIFIER_ATTR, "true");
    element.style.position = "absolute";
    element.style.top = INSET + "px";
    element.style.left = INSET + "px";
    element.style.width = WIDTH + "px";
    element.style.height = "80px";
    element.style.zIndex = "9";
    element.style.pointerEvents = "none";
    element.style.overflow = "hidden";
    element.style.border = "1px solid rgba(15, 23, 42, 0.78)";
    element.style.borderRadius = "6px";
    element.style.background = "rgba(255, 255, 255, 0.98)";
    element.style.boxShadow = "0 10px 20px rgba(15, 23, 42, 0.20)";

    const viewport = document.createElement("div");
    viewport.style.position = "absolute";
    viewport.style.inset = "0";
    viewport.style.pointerEvents = "none";
    viewport.style.overflow = "hidden";
    element.appendChild(viewport);

    const mount = document.createElement("div");
    mount.style.position = "absolute";
    mount.style.inset = "0";
    mount.style.pointerEvents = "none";
    viewport.appendChild(mount);

    const regionsLayer = document.createElement("div");
    regionsLayer.style.position = "absolute";
    regionsLayer.style.inset = "0";
    regionsLayer.style.pointerEvents = "none";
    regionsLayer.style.zIndex = "3";
    viewport.appendChild(regionsLayer);

    const badge = document.createElement("div");
    badge.style.position = "absolute";
    badge.style.left = "6px";
    badge.style.top = "5px";
    badge.style.padding = "2px 6px";
    badge.style.borderRadius = "999px";
    badge.style.fontSize = "10px";
    badge.style.fontWeight = "700";
    badge.style.lineHeight = "1.2";
    badge.style.fontFamily =
      "ui-monospace, SFMono-Regular, Consolas, monospace";
    badge.style.color = "#e2e8f0";
    badge.style.background = "rgba(15, 23, 42, 0.82)";
    badge.style.zIndex = "5";
    badge.textContent = `${SCALE}x`;
    element.appendChild(badge);

    context.container.appendChild(element);

    const hostMarker = nextMarker("host");
    const mountMarker = nextMarker("mount");
    context.host.setAttribute(HOST_MARKER_ATTR, hostMarker);
    mount.setAttribute(MOUNT_MARKER_ATTR, mountMarker);

    return {
      scope: context.scope,
      container: context.container,
      host: context.host,
      element,
      mount,
      regionsLayer,
      badge,
      hostMarker,
      mountMarker,
      bridgeInstanceId: null,
      syncPending: false,
      syncQueued: false,
    };
  }

  async function disposeMagnifier(magnifier) {
    if (!magnifier) {
      return;
    }

    if (magnifier.bridgeInstanceId) {
      await callBridge("destroy", {
        instanceId: magnifier.bridgeInstanceId,
      });
    }
  }

  helper.clearMagnifier = function clearMagnifier() {
    const magnifier = helper.state.magnifier;
    if (!magnifier) {
      return;
    }

    void disposeMagnifier(magnifier);

    if (magnifier.host instanceof HTMLElement) {
      magnifier.host.removeAttribute(HOST_MARKER_ATTR);
    }
    if (magnifier.mount instanceof HTMLElement) {
      magnifier.mount.removeAttribute(MOUNT_MARKER_ATTR);
    }
    if (
      magnifier.element instanceof HTMLElement &&
      magnifier.element.isConnected
    ) {
      magnifier.element.remove();
    }

    helper.state.magnifier = null;
  };

  function ensureMagnifier(context) {
    const current = helper.state.magnifier;
    if (
      current &&
      current.scope === context.scope &&
      current.container === context.container &&
      current.host === context.host &&
      current.element instanceof HTMLElement &&
      current.element.isConnected
    ) {
      return current;
    }

    helper.clearMagnifier();
    const next = createMagnifier(context);
    helper.state.magnifier = next;
    return next;
  }

  async function syncMagnifier(magnifier) {
    if (!magnifier || helper.state.magnifier !== magnifier) {
      return;
    }

    if (magnifier.syncPending) {
      magnifier.syncQueued = true;
      return;
    }

    magnifier.syncPending = true;

    try {
      if (
        !(magnifier.container instanceof HTMLElement) ||
        !(magnifier.host instanceof HTMLElement) ||
        !(magnifier.mount instanceof HTMLElement) ||
        !magnifier.container.isConnected ||
        !magnifier.host.isConnected ||
        !magnifier.mount.isConnected
      ) {
        return;
      }

      const containerRect = magnifier.container.getBoundingClientRect();
      const drag = helper.state.magnifierDrag;
      const target = getDragData(drag, containerRect);
      if (!target || containerRect.width <= 0 || containerRect.height <= 0) {
        setStatus(magnifier, `${SCALE} waiting`);
        return;
      }

      const width = Math.min(
        WIDTH,
        Math.max(80, Math.round(containerRect.width - INSET * 2)),
      );
      const height = Math.max(
        48,
        Math.min(MAX_HEIGHT, Math.round(containerRect.height - INSET * 2)),
      );
      const left = clamp(
        target.x - width / 2,
        INSET,
        Math.max(INSET, containerRect.width - width - INSET),
      );

      magnifier.element.style.left = left + "px";
      magnifier.element.style.top = INSET + "px";
      magnifier.element.style.width = width + "px";
      magnifier.element.style.height = height + "px";

      if (!magnifier.bridgeInstanceId) {
        const ensureResult = await callBridge("ensure", {
          hostMarker: magnifier.hostMarker,
          mountMarker: magnifier.mountMarker,
          height,
          scale: SCALE,
        });

        if (!ensureResult || !ensureResult.ok || !ensureResult.id) {
          setStatus(magnifier, `${SCALE} unavailable`);
          return;
        }

        magnifier.bridgeInstanceId = ensureResult.id;
      }

      let updateResult = await callBridge("update", {
        instanceId: magnifier.bridgeInstanceId,
        time: target.timeSeconds,
        width,
        height,
        scale: SCALE,
      });

      if ((!updateResult || !updateResult.ok) && magnifier.bridgeInstanceId) {
        await callBridge("destroy", {
          instanceId: magnifier.bridgeInstanceId,
        });
        magnifier.bridgeInstanceId = null;

        const retryEnsure = await callBridge("ensure", {
          hostMarker: magnifier.hostMarker,
          mountMarker: magnifier.mountMarker,
          height,
          scale: SCALE,
        });
        if (retryEnsure && retryEnsure.ok && retryEnsure.id) {
          magnifier.bridgeInstanceId = retryEnsure.id;
          updateResult = await callBridge("update", {
            instanceId: magnifier.bridgeInstanceId,
            time: target.timeSeconds,
            width,
            height,
            scale: SCALE,
          });
        }
      }

      if (!updateResult || !updateResult.ok) {
        setStatus(magnifier, `${SCALE} unavailable`);
        return;
      }

      setStatus(magnifier, `${SCALE}x @ ` + target.text);
      renderRegions(
        magnifier,
        Array.isArray(updateResult.regions) ? updateResult.regions : [],
        Number(updateResult.windowStart) || 0,
        Number(updateResult.windowEnd) || 0,
        width,
        height,
      );
    } finally {
      if (!magnifier || helper.state.magnifier !== magnifier) {
        return;
      }

      magnifier.syncPending = false;
      if (magnifier.syncQueued) {
        magnifier.syncQueued = false;
        void syncMagnifier(magnifier);
      }
    }
  }

  function showMagnifier(context) {
    const magnifier = ensureMagnifier(context);
    void syncMagnifier(magnifier);
  }

  function handlePointerDown(event) {
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

    const drag = getDragContextFromEvent(event);
    helper.state.magnifierDrag = drag;
    if (drag) {
      showMagnifier(drag);
    }
  }

  function handlePointerMove(event) {
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

    const drag = helper.state.magnifierDrag;
    if (!drag) {
      return;
    }

    const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
    if (drag.pointerId !== pointerId) {
      return;
    }

    if (!event.buttons) {
      helper.state.magnifierDrag = null;
      helper.clearMagnifier();
      return;
    }

    showMagnifier(drag);
  }

  function handlePointerEnd(event) {
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === "function") {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

    const drag = helper.state.magnifierDrag;
    const pointerId = typeof event.pointerId === "number" ? event.pointerId : 1;
    if (drag && drag.pointerId === pointerId) {
      helper.state.magnifierDrag = null;
      helper.clearMagnifier();
    }
  }

  helper.bindMagnifier = function bindMagnifier() {
    if (helper.state.magnifierListenersBound) {
      return;
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("pointerup", handlePointerEnd, true);
    document.addEventListener("pointercancel", handlePointerEnd, true);
    helper.state.magnifierListenersBound = true;
  };

  helper.unbindMagnifier = function unbindMagnifier() {
    if (!helper.state.magnifierListenersBound) {
      return;
    }

    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("pointermove", handlePointerMove, true);
    document.removeEventListener("pointerup", handlePointerEnd, true);
    document.removeEventListener("pointercancel", handlePointerEnd, true);
    helper.state.magnifierListenersBound = false;
  };
}




