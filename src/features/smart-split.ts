// @ts-nocheck
import { splitAutoSegmentTextAtFloorOffset } from './auto-segmentation/text-allocation';
import { getCurrentL0TimingIndex } from '../content/l0-timing-listener';
import { computeL0CompletedWordCharacterOffset } from '../services/l0-word-timing-alignment';
import { buildL0TimingLaneAliases, resolveL0TimingTrack } from '../services/l0-timing-identity';
import type { TimelineModules } from '../services/timeline-selection-service';

export function registerSmartSplit(helper: any, api: Pick<TimelineModules, 'site' | 'segmentation' | 'selection' | 'edge'>) {
  const CUT_PREVIEW_FAST_DUPLICATE_ROW_WAIT_MS = 180;

  const CUT_PREVIEW_SMART_SPLIT_ROW_WAIT_MS = 1200;

  const CUT_PREVIEW_DUPLICATE_ROW_POLL_MS = 40;

  helper.state.smartSplitClickDraft = null;

  helper.state.smartSplitClickContext = null;


  function isSmartSplitClickEvent(event) {
    return Boolean(
      event &&
      event.button === 0 &&
      !event.altKey &&
      event.shiftKey &&
      (event.ctrlKey || event.metaKey)
    );
  }


  function dispatchSplitClick(target, clientX, clientY, options) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const settings = options || {};
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
        shiftKey: Boolean(settings.shiftKey),
        ctrlKey: !useMeta,
        metaKey: useMeta
      })
    );
  }


  function getSmartSplitCursorTextOffset(row) {
    const ghostTarget =
      typeof helper.getGhostCursorTarget === 'function'
        ? helper.getGhostCursorTarget()
        : null;
    const activeTextarea =
      typeof helper.getActiveRowTextarea === 'function'
        ? helper.getActiveRowTextarea()
        : null;
    const activeRow =
      activeTextarea instanceof HTMLTextAreaElement
        ? activeTextarea.closest('tr')
        : null;
    const remembered = helper.state.lastBlur;
    const currentRow =
      typeof helper.getCurrentRow === 'function' ? helper.getCurrentRow() : null;
    const candidates = [
      ghostTarget,
      {
        row: activeRow,
        offset:
          activeTextarea instanceof HTMLTextAreaElement
            ? activeTextarea.selectionStart
            : null
      },
      {
        row: remembered && remembered.row,
        offset: remembered && remembered.selectionStart
      },
      {
        row: currentRow,
        offset: helper.state.cursorBaseline
      }
    ];
    for (const candidate of candidates) {
      if (
        candidate &&
        candidate.row === row &&
        Number.isFinite(candidate.offset) &&
        candidate.offset > 0
      ) {
        return candidate.offset;
      }
    }
    return null;
  }


  function buildSmartSplitPlanForRow(row, splitSeconds, speakerKey) {
    if (!(row instanceof HTMLTableRowElement) || !Number.isFinite(splitSeconds)) {
      return null;
    }

    const range = api.site.getRowTimeRange(row);
    if (
      !range ||
      splitSeconds <= range.startSeconds + api.segmentation.AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS ||
      splitSeconds >= range.endSeconds - api.segmentation.AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS
    ) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    const sourceRowIndex = rows.indexOf(row);
    if (sourceRowIndex < 0) {
      return null;
    }

    const sourceSpeakerKey =
      (typeof speakerKey === 'string' && speakerKey) || helper.getRowSpeakerKey(row);
    const sameSpeakerRows = sourceSpeakerKey
      ? rows.filter((candidate) => helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)
      : rows;
    const sourceSpeakerIndex = sameSpeakerRows.indexOf(row);
    const sourceText = helper.getRowTextValue(row).trim();
    if (!sourceText) {
      return null;
    }

    return {
      sourceRow: row,
      sourceRowIndex,
      sourceSpeakerIndex,
      rowCount: rows.length,
      speakerKey: sourceSpeakerKey,
      sourceText,
      ghostTextOffset: getSmartSplitCursorTextOffset(row),
      timingLaneAliases: api.segmentation.getL0TimingLaneAliases(row, sourceSpeakerKey),
      sourceRange: range,
      splitSeconds,
      pivotPx: 0,
      ratio: api.site.clamp(
        (splitSeconds - range.startSeconds) / (range.endSeconds - range.startSeconds),
        0,
        1
      )
    };
  }


  function getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex, options) {
    const rows = helper.getTranscriptRows();
    if (!rows.length || sourceRowIndex < 0 || sourceRowIndex >= rows.length) {
      return null;
    }

    const settings = options || {};
    const sourceSpeakerKey =
      (typeof settings.speakerKey === 'string' && settings.speakerKey) ||
      helper.getRowSpeakerKey(sourceRow);
    const pairMatchesSpeaker = (leftRow, rightRow) => {
      if (!(leftRow instanceof HTMLTableRowElement) || !(rightRow instanceof HTMLTableRowElement)) {
        return false;
      }

      if (!helper.rowsShareSpeaker(leftRow, rightRow)) {
        return false;
      }

      return !sourceSpeakerKey || helper.getRowSpeakerKey(leftRow) === sourceSpeakerKey;
    };

    let leftRow = null;
    for (let index = Math.min(sourceRowIndex, rows.length - 1); index >= 0; index -= 1) {
      const candidate = rows[index];
      if (
        candidate instanceof HTMLTableRowElement &&
        (!sourceSpeakerKey || helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)
      ) {
        leftRow = candidate;
        break;
      }
    }

    let rightRow = null;
    for (let index = Math.max(0, sourceRowIndex + 1); index < rows.length; index += 1) {
      const candidate = rows[index];
      if (
        candidate instanceof HTMLTableRowElement &&
        (!sourceSpeakerKey || helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)
      ) {
        rightRow = candidate;
        break;
      }
    }

    if (!pairMatchesSpeaker(leftRow, rightRow)) {
      return null;
    }

    return {
      leftRow,
      rightRow
    };
  }


  async function waitForSmartSplitRows(sourceRow, sourceRowIndex, previousRowCount, options) {
    if (sourceRowIndex < 0 || !Number.isFinite(previousRowCount)) {
      return null;
    }

    return helper.waitFor(() => {
      const rows = helper.getTranscriptRows();
      if (rows.length < previousRowCount + 1) {
        return null;
      }

      return getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex, options);
    }, 1200, 40);
  }


  function captureRowSnapshot() {
    return helper.getTranscriptRows().map((row) => {
      const labels = api.site.getRowTimeLabels(row) || {
        startText: '',
        endText: ''
      };
      return {
        row,
        speakerKey: helper.getRowSpeakerKey(row),
        startText: labels.startText,
        endText: labels.endText,
        text: helper.getRowTextValue(row).trim()
      };
    });
  }


  function getRowSignature(entry) {
    if (!entry) {
      return '';
    }

    return [entry.speakerKey || '', entry.startText || '', entry.endText || '', entry.text || ''].join('|');
  }


  function findNewDuplicateSplitRows(previousRows, options) {
    const previousList = Array.isArray(previousRows) ? previousRows : [];
    const previousSignatures = new Set(previousList.map((entry) => getRowSignature(entry)));
    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const rows = speakerKey
      ? helper.getTranscriptRows().filter((row) => helper.getRowSpeakerKey(row) === speakerKey)
      : helper.getTranscriptRows();

    for (let index = 0; index < rows.length - 1; index += 1) {
      const leftRow = rows[index];
      const rightRow = rows[index + 1];
      if (!helper.rowsShareSpeaker(leftRow, rightRow)) {
        continue;
      }

      const pairSpeakerKey = helper.getRowSpeakerKey(leftRow);
      if (speakerKey && pairSpeakerKey !== speakerKey) {
        continue;
      }

      const leftText = helper.getRowTextValue(leftRow).trim();
      const rightText = helper.getRowTextValue(rightRow).trim();
      if (!leftText || leftText !== rightText) {
        continue;
      }

      const leftLabels = api.site.getRowTimeLabels(leftRow);
      const rightLabels = api.site.getRowTimeLabels(rightRow);
      const leftSignature = getRowSignature({
        speakerKey: pairSpeakerKey,
        startText: leftLabels ? leftLabels.startText : '',
        endText: leftLabels ? leftLabels.endText : '',
        text: leftText
      });
      const rightSignature = getRowSignature({
        speakerKey: pairSpeakerKey,
        startText: rightLabels ? rightLabels.startText : '',
        endText: rightLabels ? rightLabels.endText : '',
        text: rightText
      });

      if (previousSignatures.has(leftSignature) && previousSignatures.has(rightSignature)) {
        continue;
      }

      const leftRange = api.site.getRowTimeRange(leftRow);
      const rightRange = api.site.getRowTimeRange(rightRow);
      if (!leftRange || !rightRange) {
        continue;
      }

      const leftDuration = leftRange.endSeconds - leftRange.startSeconds;
      const rightDuration = rightRange.endSeconds - rightRange.startSeconds;
      const totalDuration = leftDuration + rightDuration;
      if (!(leftDuration > 0) || !(rightDuration > 0) || !(totalDuration > 0)) {
        continue;
      }

      return {
        leftRow,
        rightRow,
        speakerKey: pairSpeakerKey,
        sourceText: leftText,
        timingLaneAliases: api.segmentation.getL0TimingLaneAliases(leftRow, pairSpeakerKey),
        sourceRange: {
          startSeconds: leftRange.startSeconds,
          endSeconds: rightRange.endSeconds
        },
        splitSeconds: leftRange.endSeconds,
        ratio: leftDuration / totalDuration
      };
    }

    return null;
  }


  async function waitForDuplicateSplitRows(previousRows, speakerKey, timeoutMs) {
    if (!Array.isArray(previousRows) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return null;
    }

    return helper.waitFor(
      () =>
        findNewDuplicateSplitRows(previousRows, {
          speakerKey
        }),
      timeoutMs,
      CUT_PREVIEW_DUPLICATE_ROW_POLL_MS
    );
  }


  function getSmartSplitTextParts(plan) {
    const fallback = helper.splitTextByWordRatio(plan.sourceText, plan.ratio);
    const timingIndex = getCurrentL0TimingIndex(helper.state, helper);
    const timingTrack = resolveL0TimingTrack(
      timingIndex,
      plan.timingLaneAliases || buildL0TimingLaneAliases({ speakerKey: plan.speakerKey })
    );
    const range = plan.sourceRange;
    if (
      timingTrack &&
      range &&
      Number.isFinite(plan.splitSeconds) &&
      plan.splitSeconds > range.startSeconds &&
      plan.splitSeconds < range.endSeconds
    ) {
      const completedOffset = computeL0CompletedWordCharacterOffset(
        plan.sourceText,
        timingTrack.tokens,
        range,
        plan.splitSeconds
      );
      if (completedOffset !== null) {
        return {
          ...splitAutoSegmentTextAtFloorOffset(
            plan.sourceText,
            completedOffset
          ),
          source: 'l0-completed-word'
        };
      }
    }
    if (
      Number.isFinite(plan.ghostTextOffset) &&
      plan.ghostTextOffset > 0 &&
      plan.ghostTextOffset < plan.sourceText.length
    ) {
      return splitAutoSegmentTextAtFloorOffset(
        plan.sourceText,
        plan.ghostTextOffset
      );
    }
    return { ...fallback, source: 'word-ratio' };
  }


  function applySmartSplitTextParts(leftRow, rightRow, parts) {
    const leftTextarea = helper.getRowTextarea(leftRow);
    const rightTextarea = helper.getRowTextarea(rightRow);
    if (
      !(leftTextarea instanceof HTMLTextAreaElement) ||
      !(rightTextarea instanceof HTMLTextAreaElement)
    ) {
      return false;
    }
    const wroteLeft = helper.setEditableValue(leftTextarea, parts.firstText);
    const wroteRight = helper.setEditableValue(rightTextarea, parts.secondText);
    return Boolean(wroteLeft && wroteRight);
  }


  async function applySmartSplitFromDuplicateRows(context) {
    if (!context || !Number.isFinite(context.rowCount)) {
      return false;
    }

    const detected = await waitForDuplicateSplitRows(
      context.rows,
      context.speakerKey,
      CUT_PREVIEW_SMART_SPLIT_ROW_WAIT_MS
    );

    if (!detected) {
      return false;
    }

    const parts = getSmartSplitTextParts(detected);
    return parts.wordCount
      ? applySmartSplitTextParts(detected.leftRow, detected.rightRow, parts)
      : false;
  }


  async function waitForSmartSplitTextReady(rows, sourceText) {
    if (!rows || !sourceText) {
      return null;
    }

    return helper.waitFor(() => {
      const leftText = helper.getRowTextValue(rows.leftRow).trim();
      const rightText = helper.getRowTextValue(rows.rightRow).trim();
      if (!leftText && !rightText) {
        return null;
      }

      // Let Babel finish its own duplicated-text write before we overwrite it.
      if (leftText === sourceText || rightText === sourceText || leftText === rightText) {
        return {
          leftText,
          rightText,
          duplicated: true
        };
      }

      return {
        leftText,
        rightText,
        duplicated: false
      };
    }, 800, 40);
  }


  async function applySmartSplit(plan) {
    if (!plan || !plan.sourceText) {
      return false;
    }

    const rows = await waitForSmartSplitRows(plan.sourceRow, plan.sourceRowIndex, plan.rowCount, {
      speakerKey: plan.speakerKey,
      sourceSpeakerIndex: plan.sourceSpeakerIndex
    });
    if (!rows) {
      return false;
    }

    const parts = getSmartSplitTextParts(plan);
    if (!parts.wordCount) {
      return false;
    }

    const readyState = await waitForSmartSplitTextReady(rows, plan.sourceText);
    if (readyState && readyState.duplicated) {
      await helper.sleep(80);
    }

    const applyOnce = () =>
      applySmartSplitTextParts(rows.leftRow, rows.rightRow, parts);

    if (!applyOnce()) {
      return false;
    }

    await helper.sleep(140);

    const leftCurrent = helper.getRowTextValue(rows.leftRow).trim();
    const rightCurrent = helper.getRowTextValue(rows.rightRow).trim();
    if (leftCurrent !== parts.firstText || rightCurrent !== parts.secondText) {
      return applyOnce();
    }
    return true;
  }


  function buildSmartSplitPlanForRegion(entry, pivotPx, container) {
    if (!entry) {
      return null;
    }

    const speakerKey = api.site.getSpeakerKeyForContainer(container);
    let sourceRow = api.site.findRowByTimeLabels(entry.startText, entry.endText, {
      speakerKey
    });

    if (!(sourceRow instanceof HTMLTableRowElement) && container instanceof HTMLElement) {
      const laneTimeScale = api.site.getLaneTimeScale(container);
      if (laneTimeScale && Number.isFinite(laneTimeScale.secondsPerPx) && laneTimeScale.secondsPerPx > 0) {
        const startSeconds = laneTimeScale.offsetSeconds + entry.leftPx * laneTimeScale.secondsPerPx;
        const endSeconds = laneTimeScale.offsetSeconds + entry.rightPx * laneTimeScale.secondsPerPx;
        sourceRow = api.site.findRowByTimeRange(startSeconds, endSeconds, {
          speakerKey
        });
      }
    }

    if (!(sourceRow instanceof HTMLTableRowElement)) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    const sourceRowIndex = rows.indexOf(sourceRow);
    if (sourceRowIndex < 0) {
      return null;
    }

    const sameSpeakerRows = speakerKey
      ? rows.filter((row) => helper.getRowSpeakerKey(row) === speakerKey)
      : rows;
    const sourceSpeakerIndex = sameSpeakerRows.indexOf(sourceRow);

    const sourceText = helper.getRowTextValue(sourceRow).trim();
    if (!sourceText) {
      return null;
    }

    const width = entry.rightPx - entry.leftPx;
    const ratio =
      width > 0 ? api.site.clamp((pivotPx - entry.leftPx) / width, 0, 1) : 0.5;
    const sourceRange = api.site.getRowTimeRange(sourceRow);
    if (!sourceRange) {
      return null;
    }
    const splitSeconds =
      sourceRange.startSeconds +
      ratio * (sourceRange.endSeconds - sourceRange.startSeconds);


    return {
      sourceRow,
      sourceRowIndex,
      sourceSpeakerIndex,
      rowCount: rows.length,
      speakerKey,
      sourceText,
      timingLaneAliases: api.segmentation.getL0TimingLaneAliases(sourceRow, speakerKey),
      ghostTextOffset: getSmartSplitCursorTextOffset(sourceRow),
      sourceRange,
      splitSeconds,
      pivotPx,
      ratio
    };
  }


  function getSmartSplitClickDraft(event) {
    if (
      !isSmartSplitClickEvent(event)
    ) {
      return null;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    let sourceRegion = null;
    let container = null;

    for (const node of path) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.hasAttribute(api.selection.CUT_PREVIEW_ATTR)) {
        return null;
      }

      if (!sourceRegion && api.site.isRegionHandle(node)) {
        const owningRegion = api.site.getOwningRegionBody(node);
        if (owningRegion) {
          sourceRegion = owningRegion;
          if (owningRegion.parentElement instanceof HTMLElement) {
            container = owningRegion.parentElement;
          }
        }
        continue;
      }

      if (!sourceRegion && api.site.isRegionBody(node)) {
        sourceRegion = node;
        if (node.parentElement instanceof HTMLElement) {
          container = node.parentElement;
        }
      }

      if (!container && api.site.getRegionElements(node).length) {
        container = node;
      }

      if (
        !container &&
        node instanceof HTMLElement &&
        node.parentElement instanceof HTMLElement &&
        api.site.getRegionElements(node.parentElement).length
      ) {
        container = node.parentElement;
      }
    }

    if (
      !(container instanceof HTMLElement) &&
      helper.state.cutLastContainer instanceof HTMLElement &&
      helper.state.cutLastContainer.isConnected
    ) {
      container = helper.state.cutLastContainer;
    }

    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const snapshot = api.site.collectRegionSnapshot(container);
    if (!snapshot) {
      return null;
    }

    const localX = api.site.clamp(event.clientX - snapshot.containerRect.left, 0, snapshot.containerRect.width);
    let entry =
      sourceRegion instanceof HTMLElement
        ? snapshot.bounds.find((candidate) => candidate.region === sourceRegion) || null
        : null;

    if (!entry) {
      const tolerance = 2;
      entry =
        snapshot.bounds.find(
          (candidate) =>
            localX >= candidate.leftPx - tolerance && localX <= candidate.rightPx + tolerance
        ) || null;
    }

    if (!entry) {
      let bestEntry = null;
      let bestDistance = Infinity;
      for (const candidate of snapshot.bounds) {
        const center = (candidate.leftPx + candidate.rightPx) / 2;
        const distance = Math.abs(center - localX);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEntry = candidate;
        }
      }
      entry = bestEntry;
    }

    if (!entry) {
      return null;
    }

    const pivotPx = api.site.clamp(localX, entry.leftPx, entry.rightPx);
    return buildSmartSplitPlanForRegion(entry, pivotPx, container);
  }


  function captureSmartSplitClickDraft(event) {
    if (!isSmartSplitClickEvent(event)) {
      helper.state.smartSplitClickDraft = null;
      helper.state.smartSplitClickContext = null;
      return null;
    }

    const draft = getSmartSplitClickDraft(event);
    helper.state.smartSplitClickContext = {
      rowCount: helper.getTranscriptRows().length,
      speakerKey:
        (draft && typeof draft.speakerKey === 'string' && draft.speakerKey) ||
        api.site.getSpeakerKeyForContainer(helper.state.cutLastContainer),
      rows: captureRowSnapshot()
    };

    helper.state.smartSplitClickDraft = draft || null;
    return draft;
  }


  function handleSmartSplitClick(event) {
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === 'function') {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

    if (helper.state.cutCommitPending) {
      return;
    }

    if (api.edge.isAltTimelineEdgeClickEvent(event) && api.selection.getTimelineLaneFromEvent(event)) {
      api.edge.suppressAltTimelineEdgeEvent(event);
      return;
    }

    const context = helper.state.smartSplitClickContext;
    const draft =
      (isSmartSplitClickEvent(event) ? helper.state.smartSplitClickDraft : null) ||
      getSmartSplitClickDraft(event);
    helper.state.smartSplitClickDraft = null;
    helper.state.smartSplitClickContext = null;
    if (!draft) {
      if (isSmartSplitClickEvent(event)) {
        if (context) {
          void applySmartSplitFromDuplicateRows(context);
        }
      }
      return;
    }
    void applySmartSplit(draft);
  }

  return { buildSmartSplitPlanForRow, applySmartSplit, captureRowSnapshot, buildSmartSplitPlanForRegion, dispatchSplitClick, waitForDuplicateSplitRows, CUT_PREVIEW_FAST_DUPLICATE_ROW_WAIT_MS, applySmartSplitFromDuplicateRows, captureSmartSplitClickDraft, handleSmartSplitClick };
}
