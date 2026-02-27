(function registerBabelHelperCut() {
  const helper = window.__babelWorkflowHelper;
  if (!helper || helper.__cutRegistered) {
    return;
  }

  helper.__cutRegistered = true;

  const CUT_PREVIEW_ATTR = 'data-babel-helper-cut-preview';
  const CUT_PREVIEW_HANDLE_ATTR = 'data-babel-helper-cut-handle';
  const CUT_PREVIEW_MIN_SECONDS = 1;
  const CUT_PREVIEW_MIN_WIDTH = 8;
  const CUT_PREVIEW_DRAG_THRESHOLD = 5;
  const CUT_PREVIEW_HANDLE_HIT_WIDTH = 12;

  helper.state.cutDraft = null;
  helper.state.cutPreview = null;
  helper.state.cutCommitPending = false;
  helper.config.hotkeysHelpRows.unshift(['Alt + Drag', 'Create a cut preview inside a segment']);
  helper.config.hotkeysHelpRows.unshift(['Enter', 'Commit cut preview if it is at least 1 second']);

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function parseTimestamp(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split(':');
    if (parts.length < 2) {
      return null;
    }

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

  function getRegionPartTokens(element) {
    const part = element instanceof Element ? element.getAttribute('part') : '';
    return part ? part.split(/\s+/).filter(Boolean) : [];
  }

  function isRegionHandle(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const tokens = getRegionPartTokens(element);
    return (
      tokens.includes('region-handle') ||
      tokens.includes('region-handle-left') ||
      tokens.includes('region-handle-right')
    );
  }

  function isRegionBody(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const tokens = getRegionPartTokens(element);
    return tokens.includes('region');
  }

  function getPreviewHostFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (node instanceof HTMLElement && node.hasAttribute(CUT_PREVIEW_ATTR)) {
        return node;
      }
    }

    return null;
  }

  function parseRowDurationSeconds() {
    const row = helper.getCurrentRow();
    if (!(row instanceof HTMLTableRowElement) || row.children.length < 4) {
      return null;
    }

    const start = parseTimestamp(helper.normalizeText(row.children[2]));
    const end = parseTimestamp(helper.normalizeText(row.children[3]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    return end - start;
  }

  function getPreviewDurationSeconds(preview) {
    if (!preview) {
      return null;
    }

    const regionWidth = preview.regionRightPx - preview.regionLeftPx;
    if (regionWidth <= 0) {
      return null;
    }

    let sourceDuration = null;
    if (preview.sourceRegion instanceof HTMLElement) {
      const startTooltip = preview.sourceRegion.querySelector('.wavesurfer-region-tooltip-start');
      const endTooltip = preview.sourceRegion.querySelector('.wavesurfer-region-tooltip-end');
      const start = parseTimestamp(startTooltip ? startTooltip.textContent : '');
      const end = parseTimestamp(endTooltip ? endTooltip.textContent : '');
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        sourceDuration = end - start;
      }
    }

    if (!Number.isFinite(sourceDuration)) {
      sourceDuration = parseRowDurationSeconds();
    }

    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
      return null;
    }

    return sourceDuration * ((preview.rightPx - preview.leftPx) / regionWidth);
  }

  function updatePreviewElement() {
    const preview = helper.state.cutPreview;
    if (!preview || !(preview.element instanceof HTMLElement)) {
      return;
    }

    preview.element.style.left = preview.leftPx + 'px';
    preview.element.style.width = Math.max(CUT_PREVIEW_MIN_WIDTH, preview.rightPx - preview.leftPx) + 'px';

    const duration = getPreviewDurationSeconds(preview);
    const label = preview.element.querySelector('[data-babel-helper-cut-label]');
    const tooShort = Number.isFinite(duration) && duration < CUT_PREVIEW_MIN_SECONDS;
    preview.element.style.background = tooShort
      ? 'rgba(239, 68, 68, 0.18)'
      : 'rgba(14, 165, 233, 0.16)';
    preview.element.style.borderColor = tooShort ? 'rgba(220, 38, 38, 0.95)' : 'rgba(2, 132, 199, 0.95)';

    if (label instanceof HTMLElement) {
      label.textContent = Number.isFinite(duration)
        ? duration.toFixed(2) + 's'
        : 'Cut';
      label.style.background = tooShort ? 'rgba(127, 29, 29, 0.92)' : 'rgba(15, 23, 42, 0.82)';
    }
  }

  function clearCutDraft() {
    helper.state.cutDraft = null;
  }

  helper.clearCutPreview = function clearCutPreview() {
    const preview = helper.state.cutPreview;
    if (preview && preview.element && preview.element.isConnected) {
      preview.element.remove();
    }

    helper.state.cutPreview = null;
    helper.state.cutCommitPending = false;
    clearCutDraft();
  };

  function createPreviewFromDraft(draft, clientX) {
    const localX = clamp(clientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
    const startX = clamp(draft.startClientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
    const leftPx = Math.min(startX, localX);
    const rightPx = Math.max(startX, localX);

    const preview = document.createElement('div');
    preview.setAttribute(CUT_PREVIEW_ATTR, 'true');
    preview.style.position = 'absolute';
    preview.style.top = '0';
    preview.style.height = '100%';
    preview.style.boxSizing = 'border-box';
    preview.style.border = '2px solid rgba(2, 132, 199, 0.95)';
    preview.style.borderRadius = '3px';
    preview.style.pointerEvents = 'auto';
    preview.style.cursor = 'default';
    preview.style.zIndex = '6';
    preview.style.touchAction = 'none';

    const leftHandle = document.createElement('div');
    leftHandle.setAttribute(CUT_PREVIEW_HANDLE_ATTR, 'left');
    leftHandle.style.position = 'absolute';
    leftHandle.style.left = '0';
    leftHandle.style.top = '0';
    leftHandle.style.width = '8px';
    leftHandle.style.height = '100%';
    leftHandle.style.cursor = 'ew-resize';

    const rightHandle = document.createElement('div');
    rightHandle.setAttribute(CUT_PREVIEW_HANDLE_ATTR, 'right');
    rightHandle.style.position = 'absolute';
    rightHandle.style.right = '0';
    rightHandle.style.top = '0';
    rightHandle.style.width = '8px';
    rightHandle.style.height = '100%';
    rightHandle.style.cursor = 'ew-resize';

    const label = document.createElement('div');
    label.setAttribute('data-babel-helper-cut-label', 'true');
    label.style.position = 'absolute';
    label.style.left = '50%';
    label.style.top = '4px';
    label.style.transform = 'translateX(-50%)';
    label.style.padding = '2px 6px';
    label.style.borderRadius = '999px';
    label.style.fontSize = '10px';
    label.style.fontWeight = '700';
    label.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
    label.style.color = '#f8fafc';
    label.style.pointerEvents = 'none';
    label.style.whiteSpace = 'nowrap';

    preview.appendChild(leftHandle);
    preview.appendChild(rightHandle);
    preview.appendChild(label);
    draft.container.appendChild(preview);

    helper.state.cutPreview = {
      pointerId: draft.pointerId,
      sourceRegion: draft.sourceRegion,
      container: draft.container,
      containerRect: draft.containerRect,
      regionLeftPx: draft.regionLeftPx,
      regionRightPx: draft.regionRightPx,
      leftPx,
      rightPx,
      element: preview,
      dragMode: 'create',
      dragStartClientX: draft.startClientX,
      originLeftPx: leftPx,
      originRightPx: rightPx
    };

    clearCutDraft();
    updatePreviewElement();
  }

  function beginPreviewDrag(event) {
    const previewElement = getPreviewHostFromEvent(event);
    const preview = helper.state.cutPreview;
    if (!(previewElement instanceof HTMLElement) || !preview) {
      return false;
    }

    const previewRect = previewElement.getBoundingClientRect();
    const localX = event.clientX - previewRect.left;
    const nearLeftEdge = localX <= CUT_PREVIEW_HANDLE_HIT_WIDTH;
    const nearRightEdge = localX >= previewRect.width - CUT_PREVIEW_HANDLE_HIT_WIDTH;

    preview.pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    preview.dragStartClientX = event.clientX;
    preview.originLeftPx = preview.leftPx;
    preview.originRightPx = preview.rightPx;
    if (nearLeftEdge && !nearRightEdge) {
      preview.dragMode = 'resize-left';
    } else if (nearRightEdge) {
      preview.dragMode = 'resize-right';
    } else {
      preview.dragMode = 'locked';
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function updatePreviewDrag(event) {
    const preview = helper.state.cutPreview;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (!preview || preview.pointerId !== pointerId || !preview.dragMode) {
      return false;
    }

    const dx = event.clientX - preview.dragStartClientX;
    const minWidth = CUT_PREVIEW_MIN_WIDTH;
    if (preview.dragMode === 'create') {
      const currentX = clamp(
        event.clientX - preview.containerRect.left,
        preview.regionLeftPx,
        preview.regionRightPx
      );
      const startX = clamp(
        preview.dragStartClientX - preview.containerRect.left,
        preview.regionLeftPx,
        preview.regionRightPx
      );
      preview.leftPx = Math.min(startX, currentX);
      preview.rightPx = Math.max(preview.leftPx + minWidth, currentX);
      preview.rightPx = Math.min(preview.rightPx, preview.regionRightPx);
    } else if (preview.dragMode === 'resize-left') {
      preview.leftPx = clamp(
        preview.originLeftPx + dx,
        preview.regionLeftPx,
        preview.rightPx - minWidth
      );
    } else if (preview.dragMode === 'resize-right') {
      preview.rightPx = clamp(
        preview.originRightPx + dx,
        preview.leftPx + minWidth,
        preview.regionRightPx
      );
    } else if (preview.dragMode === 'locked') {
      // Absorb preview-body drags so they do not fall through to Babel.
    } else {
      return false;
    }

    updatePreviewElement();
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function endPreviewDrag(event) {
    const preview = helper.state.cutPreview;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (!preview || preview.pointerId !== pointerId || !preview.dragMode) {
      return false;
    }

    preview.dragMode = null;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function getRegionDraft(event) {
    if (
      event.button !== 0 ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return null;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    let sourceRegion = null;

    for (const node of path) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.hasAttribute(CUT_PREVIEW_ATTR)) {
        return null;
      }

      if (isRegionHandle(node)) {
        return null;
      }

      if (!sourceRegion && isRegionBody(node)) {
        sourceRegion = node;
      }
    }

    if (!(sourceRegion instanceof HTMLElement) || !(sourceRegion.parentElement instanceof HTMLElement)) {
      return null;
    }

    const regionRect = sourceRegion.getBoundingClientRect();
    const containerRect = sourceRegion.parentElement.getBoundingClientRect();
    if (regionRect.width <= CUT_PREVIEW_MIN_WIDTH || containerRect.width <= 0) {
      return null;
    }

    return {
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : 1,
      sourceRegion,
      container: sourceRegion.parentElement,
      containerRect,
      regionLeftPx: clamp(regionRect.left - containerRect.left, 0, containerRect.width),
      regionRightPx: clamp(regionRect.right - containerRect.left, 0, containerRect.width),
      startClientX: clamp(event.clientX, regionRect.left, regionRect.right)
    };
  }

  function dispatchSplitClick(target, clientX, clientY) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const useMeta = /\bMac\b/i.test(navigator.platform || '');
    target.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: 0,
        detail: 1,
        ctrlKey: !useMeta,
        metaKey: useMeta
      })
    );
  }

  function getRegionElements(container) {
    if (!(container instanceof HTMLElement)) {
      return [];
    }

    return Array.from(container.children).filter((child) => isRegionBody(child));
  }

  function getRegionBounds(region, containerRect) {
    if (!(region instanceof HTMLElement)) {
      return null;
    }

    const rect = region.getBoundingClientRect();
    return {
      region,
      rect,
      leftPx: rect.left - containerRect.left,
      rightPx: rect.right - containerRect.left
    };
  }

  function collectRegionSnapshot(container) {
    const containerRect = container instanceof HTMLElement ? container.getBoundingClientRect() : null;
    if (!containerRect || containerRect.width <= 0) {
      return null;
    }

    const bounds = getRegionElements(container)
      .map((region) => getRegionBounds(region, containerRect))
      .filter(Boolean)
      .sort((left, right) => left.leftPx - right.leftPx);

    if (!bounds.length) {
      return null;
    }

    return {
      containerRect,
      bounds
    };
  }

  function getSnapshotSignature(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.bounds)) {
      return '';
    }

    return snapshot.bounds
      .map((entry) => {
        const left = Math.round(entry.leftPx * 10) / 10;
        const right = Math.round(entry.rightPx * 10) / 10;
        return left + ':' + right;
      })
      .join('|');
  }

  async function waitForRegionRefresh(container, previousSignature) {
    const updated = await helper.waitFor(() => {
      const snapshot = collectRegionSnapshot(container);
      if (!snapshot) {
        return null;
      }

      return getSnapshotSignature(snapshot) !== previousSignature ? snapshot : null;
    }, 900, 40);

    return updated || collectRegionSnapshot(container);
  }

  function findReconciliationTargets(snapshot, cutLeftPx) {
    if (!snapshot || !Array.isArray(snapshot.bounds) || !snapshot.bounds.length) {
      return null;
    }

    let previous = null;
    let next = null;
    for (const entry of snapshot.bounds) {
      if (entry.rightPx <= cutLeftPx + 8) {
        previous = entry;
      }

      if (!next && entry.leftPx >= cutLeftPx - 8) {
        next = entry;
      }
    }

    if (!previous || !next) {
      return null;
    }

    return {
      containerRect: snapshot.containerRect,
      previous,
      next
    };
  }

  function getHandle(region, side) {
    if (!(region instanceof HTMLElement)) {
      return null;
    }

    const selector =
      side === 'left'
        ? '[part~="region-handle-left"]'
        : '[part~="region-handle-right"]';
    const handle = region.querySelector(selector);
    return handle instanceof HTMLElement ? handle : null;
  }

  async function dragHandleToClientX(handle, targetClientX) {
    if (!(handle instanceof HTMLElement) || !handle.isConnected) {
      return false;
    }

    const rect = handle.getBoundingClientRect();
    const startClientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const doc = handle.ownerDocument;

    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientY,
      button: 0
    };

    if (typeof PointerEvent === 'function') {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...base,
          clientX: startClientX,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse'
        })
      );
    }

    handle.dispatchEvent(
      new MouseEvent('mousedown', {
        ...base,
        clientX: startClientX,
        buttons: 1
      })
    );

    await helper.sleep(16);

    if (typeof PointerEvent === 'function') {
      doc.dispatchEvent(
        new PointerEvent('pointermove', {
          ...base,
          clientX: targetClientX,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse'
        })
      );
    }

    doc.dispatchEvent(
      new MouseEvent('mousemove', {
        ...base,
        clientX: targetClientX,
        buttons: 1
      })
    );

    await helper.sleep(16);

    if (typeof PointerEvent === 'function') {
      doc.dispatchEvent(
        new PointerEvent('pointerup', {
          ...base,
          clientX: targetClientX,
          buttons: 0,
          pointerId: 1,
          pointerType: 'mouse'
        })
      );
    }

    doc.dispatchEvent(
      new MouseEvent('mouseup', {
        ...base,
        clientX: targetClientX,
        buttons: 0
      })
    );

    return true;
  }

  helper.commitCutPreview = async function commitCutPreview() {
    const preview = helper.state.cutPreview;
    if (!preview || helper.state.cutCommitPending) {
      return false;
    }

    const duration = getPreviewDurationSeconds(preview);
    if (Number.isFinite(duration) && duration < CUT_PREVIEW_MIN_SECONDS) {
      return false;
    }

    const commitPlan = {
      sourceRegion: preview.sourceRegion,
      container: preview.container,
      containerRect:
        preview.container instanceof HTMLElement
          ? preview.container.getBoundingClientRect()
          : preview.containerRect,
      leftPx: preview.leftPx,
      rightPx: preview.rightPx
    };

    const target = commitPlan.sourceRegion;
    const containerRect = commitPlan.containerRect;
    if (!(target instanceof HTMLElement) || !target.isConnected || containerRect.width <= 0) {
      return false;
    }

    const beforeSnapshot = collectRegionSnapshot(commitPlan.container);
    if (!beforeSnapshot) {
      return false;
    }

    const previewElement = preview.element instanceof HTMLElement ? preview.element : null;
    const originalOpacity = previewElement ? previewElement.style.opacity : '';
    if (previewElement) {
      previewElement.style.pointerEvents = 'none';
      previewElement.style.opacity = '0.72';
    }

    helper.state.cutCommitPending = true;

    try {
      const splitClientX = containerRect.left + commitPlan.leftPx;
      const splitClientY = containerRect.top + containerRect.height / 2;
      dispatchSplitClick(target, splitClientX, splitClientY);

      const refreshedSnapshot = await waitForRegionRefresh(
        commitPlan.container,
        getSnapshotSignature(beforeSnapshot)
      );
      const neighbors = findReconciliationTargets(refreshedSnapshot, commitPlan.leftPx);
      if (!neighbors) {
        return false;
      }

      const previousRightHandle = getHandle(neighbors.previous.region, 'right');
      const nextLeftHandle = getHandle(neighbors.next.region, 'left');
      if (!(previousRightHandle instanceof HTMLElement) || !(nextLeftHandle instanceof HTMLElement)) {
        return false;
      }

      const nextContainerRect = neighbors.containerRect;
      const targetStartClientX = nextContainerRect.left + commitPlan.leftPx;
      const targetEndClientX = nextContainerRect.left + commitPlan.rightPx;

      const movedPrevious = await dragHandleToClientX(previousRightHandle, targetStartClientX);
      if (!movedPrevious) {
        return false;
      }

      await helper.sleep(48);

      const movedNext = await dragHandleToClientX(nextLeftHandle, targetEndClientX);
      if (!movedNext) {
        return false;
      }

      helper.clearCutPreview();
      return true;
    } finally {
      helper.state.cutCommitPending = false;
      const currentPreview = helper.state.cutPreview;
      if (currentPreview && currentPreview.element === previewElement && previewElement) {
        previewElement.style.pointerEvents = 'auto';
        previewElement.style.opacity = originalOpacity;
      }
    }
  };

  helper.handleCutPreviewKeydown = function handleCutPreviewKeydown(event) {
    if (!helper.state.cutPreview) {
      return false;
    }

    if (helper.state.cutCommitPending) {
      if (
        event.key === 'Escape' ||
        event.key === 'Enter' ||
        event.key === 'Delete' ||
        (event.altKey && !event.ctrlKey && !event.metaKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }

      return false;
    }

    if (event.key === 'Escape') {
      helper.clearCutPreview();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void helper.commitCutPreview();
      return true;
    }

    if (
      event.key === 'Delete' ||
      (event.altKey && !event.ctrlKey && !event.metaKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    return false;
  };

  function handlePointerDown(event) {
    if (helper.state.cutCommitPending) {
      return;
    }

    if (beginPreviewDrag(event)) {
      return;
    }

    const draft = getRegionDraft(event);
    if (!draft) {
      return;
    }

    if (helper.state.cutPreview) {
      helper.clearCutPreview();
    }

    helper.state.cutDraft = draft;
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerMove(event) {
    if (helper.state.cutCommitPending) {
      return;
    }

    if (updatePreviewDrag(event)) {
      return;
    }

    const draft = helper.state.cutDraft;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (!draft || draft.pointerId !== pointerId) {
      return;
    }

    const currentX = clamp(event.clientX, draft.containerRect.left, draft.containerRect.right);
    if (Math.abs(currentX - draft.startClientX) < CUT_PREVIEW_DRAG_THRESHOLD) {
      return;
    }

    createPreviewFromDraft(draft, currentX);
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerEnd(event) {
    if (helper.state.cutCommitPending) {
      return;
    }

    if (endPreviewDrag(event)) {
      return;
    }

    const draft = helper.state.cutDraft;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (draft && draft.pointerId === pointerId) {
      clearCutDraft();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  helper.bindCutPreview = function bindCutPreview() {
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', handlePointerEnd, true);
    document.addEventListener('pointercancel', handlePointerEnd, true);
  };
})();
