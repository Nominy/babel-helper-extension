// @ts-nocheck
import { themeRoot, applyComponent } from '@nominy/babel-extension-frontend';

import { createMagnifierBridgeClient } from '../services/bridge-client-service';
import type { FeatureModule } from '../core/types';

export function registerMagnifierService(helper: any) {
  if (!helper || helper.__magnifierRegistered) {
    return;
  }

  helper.__magnifierRegistered = true;

  const MAGNIFIER_ATTR = "data-babel-helper-magnifier";
  const HOST_MARKER_ATTR = "data-babel-helper-magnifier-host";
  const MOUNT_MARKER_ATTR = "data-babel-helper-magnifier-mount";
  const SCALE = 3;
  const WIDTH = 180;
  const MAX_HEIGHT = 150;
  const INSET = 6;

  const callBridge = createMagnifierBridgeClient('request-');
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
      const regionId = getPartTokens(region).find((token) => token !== "region");
      if (
        handle instanceof HTMLElement &&
        region instanceof HTMLElement && regionId &&
        waveform
      ) {
        return {
          pointerId: typeof event.pointerId === "number" ? event.pointerId : 1,
          handle,
          region,
          regionId,
          side,
          scope: waveform.scope,
          container: waveform.container,
          host: waveform.host,
        };
      }
    }

    return null;
  }

  function getDragPosition(drag, containerRect) {
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

    const rect = drag.region.getBoundingClientRect();
    const boundary = drag.side === "left" ? rect.left : rect.right;
    return clamp(boundary - containerRect.left, 0, containerRect.width);
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

    const span = windowEnd - windowStart;
    const visible = new Set();
    if (!(span > 0)) entries = [];

    for (const entry of entries) {
      const visibleStart = Math.max(windowStart, entry.start);
      const visibleEnd = Math.min(windowEnd, entry.end);
      if (visibleEnd <= visibleStart) {
        continue;
      }

      visible.add(entry.id);
      let overlay = magnifier.regionNodes.get(entry.id);
      if (!overlay) {
        const node = document.createElement("div");
        node.setAttribute("data-babel-helper-magnifier-region", entry.id);
        node.style.position = "absolute";
        node.style.top = "0";
        node.style.boxSizing = "border-box";
        node.style.pointerEvents = "none";
        overlay = { node, entry: {} };
        magnifier.regionNodes.set(entry.id, overlay);
        magnifier.regionsLayer.appendChild(node);
      }
      const region = overlay.node;
      region.style.left = ((visibleStart - windowStart) / span) * width + "px";
      region.style.width =
        Math.max(2, ((visibleEnd - visibleStart) / span) * width) + "px";
      if (overlay.height !== height) {
        region.style.height = height + "px";
        overlay.height = height;
      }
      for (const key of ["borderRadius", "backgroundColor", "borderLeft", "borderRight", "filter"]) {
        if (overlay.entry[key] !== entry[key]) region.style[key] = entry[key];
      }
      overlay.entry = entry;
    }
    for (const [id, overlay] of magnifier.regionNodes) {
      if (visible.has(id)) continue;
      overlay.node.remove();
      magnifier.regionNodes.delete(id);
    }
  }

  function createMagnifier(context) {
    const element = document.createElement("div");
    themeRoot(element, "white");
    applyComponent(element, "surface");
    element.setAttribute(MAGNIFIER_ATTR, "true");
    element.style.position = "absolute";
    element.style.top = INSET + "px";
    element.style.left = INSET + "px";
    element.style.width = WIDTH + "px";
    element.style.height = "80px";
    element.style.zIndex = "9";
    element.style.pointerEvents = "none";
    element.style.overflow = "hidden";

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
    applyComponent(badge, "badge");
    badge.style.position = "absolute";
    badge.style.left = "6px";
    badge.style.top = "5px";
    badge.style.padding = "2px 6px";
    badge.style.fontFamily =
      "ui-monospace, SFMono-Regular, Consolas, monospace";
    badge.style.zIndex = "5";
    badge.textContent = `${SCALE}x`;
    element.appendChild(badge);

    context.container.appendChild(element);
    themeRoot(element, "white");

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
      regionNodes: new Map(),
      badge,
      hostMarker,
      mountMarker,
      bridgeInstanceId: null,
      syncPending: false,
      syncQueued: false,
      syncFrame: null,
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
    if (magnifier.syncFrame !== null) {
      window.cancelAnimationFrame(magnifier.syncFrame);
      magnifier.syncFrame = null;
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
    const route = location.href;
    const drag = helper.state.magnifierDrag;

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
      if (!drag || drag.host !== magnifier.host) return;
      const x = getDragPosition(drag, containerRect);
      if (x === null || containerRect.width <= 0 || containerRect.height <= 0) {
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
        x - width / 2,
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
        if (helper.state.magnifier !== magnifier || !magnifier.host.isConnected ||
            location.href !== route || helper.state.magnifierDrag !== drag) {
          if (ensureResult?.id) void callBridge("destroy", { instanceId: ensureResult.id });
          return;
        }

        if (!ensureResult || !ensureResult.ok || !ensureResult.id) {
          setStatus(magnifier, `${SCALE} unavailable`);
          return;
        }

        magnifier.bridgeInstanceId = ensureResult.id;
      }

      const updateResult = await callBridge("update", {
        instanceId: magnifier.bridgeInstanceId,
        regionId: drag.regionId,
        side: drag.side,
        width,
        height,
        scale: SCALE,
      });
      if (helper.state.magnifier !== magnifier || !magnifier.host.isConnected ||
          location.href !== route || helper.state.magnifierDrag !== drag) return;

      if (!updateResult || !updateResult.ok) {
        if (updateResult?.reason === "stale-source") {
          const retiredId = magnifier.bridgeInstanceId;
          magnifier.bridgeInstanceId = null;
          await callBridge("destroy", { instanceId: retiredId });
          if (helper.state.magnifier !== magnifier || location.href !== route ||
              helper.state.magnifierDrag !== drag) return;
          // The next drag event acquires current ownership; other failures are not retried.
        }
        setStatus(magnifier, `${SCALE} unavailable`);
        return;
      }

      setStatus(magnifier, `${SCALE}x @ ${updateResult.time.toFixed(3)}s`);
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
        scheduleMagnifierSync(magnifier);
      }
    }
  }

  function scheduleMagnifierSync(magnifier) {
    if (magnifier.syncFrame !== null) return;
    // Capture sees pointermove before WaveSurfer's document drag listener.
    // Read its live bounds on the next frame, after native resize has run.
    magnifier.syncFrame = window.requestAnimationFrame(() => {
      magnifier.syncFrame = null;
      void syncMagnifier(magnifier);
    });
  }

  function showMagnifier(context) {
    const magnifier = ensureMagnifier(context);
    scheduleMagnifierSync(magnifier);
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
    helper.state.magnifierDrag = null;
    helper.clearMagnifier();
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

export function createMagnifierFeature(): FeatureModule {
  return {
    id: 'magnifier',
    activate(context) {
      context.helper.bindMagnifier();
    },
    onLoaded(context) {
      context.helper.bindMagnifier();
    },
    deactivate(context) {
      context.helper.unbindMagnifier();
    },
    stop(context) {
      context.helper.unbindMagnifier();
    }
  };
}
