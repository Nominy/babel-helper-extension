var __dirname = typeof __dirname === "string" ? __dirname : "/virtual";
"use strict";
(() => {
  // src/content/timestamp-bridge.ts
  function initTimestampBridge() {
    if (window.__babelHelperTimestampBridge) {
      return;
    }
    const REQUEST_EVENT = "babel-helper-timestamp-request";
    const RESPONSE_EVENT = "babel-helper-timestamp-response";
    const ROW_TEXTAREA_SELECTOR = 'textarea[placeholder^="What was said"]';
    function safe(callback, fallbackValue) {
      try {
        const value = callback();
        return value == null ? fallbackValue : value;
      } catch (_error) {
        return fallbackValue;
      }
    }
    function sleep(ms) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
      });
    }
    async function waitFor(callback, timeoutMs = 1200, intervalMs = 40) {
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        const value = safe(() => callback(), null);
        if (value) {
          return value;
        }
        await sleep(intervalMs);
      }
      return null;
    }
    function respond(id, result) {
      window.dispatchEvent(
        new CustomEvent(RESPONSE_EVENT, {
          detail: {
            id,
            result
          }
        })
      );
    }
    function normalizeText(value) {
      return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    }
    function getReactInternalValue(element, prefix) {
      if (!(element instanceof Element) || typeof prefix !== "string" || !prefix) {
        return null;
      }
      for (const name of Object.getOwnPropertyNames(element)) {
        if (typeof name === "string" && name.indexOf(prefix) === 0) {
          return element[name];
        }
      }
      return null;
    }
    function getReactFiber(element) {
      return getReactInternalValue(element, "__reactFiber$");
    }
    function parseTimeValue(value) {
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
        let total2 = 0;
        for (const part of parts) {
          const numeric2 = Number(part);
          if (!Number.isFinite(numeric2)) {
            return null;
          }
          total2 = total2 * 60 + numeric2;
        }
        return total2;
      }
      let total = 0;
      let foundUnit = false;
      const unitPattern = /(-?\d+(?:\.\d+)?)\s*([hms])/g;
      for (const match of normalized.matchAll(unitPattern)) {
        const numeric2 = Number(match[1]);
        if (!Number.isFinite(numeric2)) {
          return null;
        }
        foundUnit = true;
        const unit = match[2];
        if (unit === "h") {
          total += numeric2 * 3600;
        } else if (unit === "m") {
          total += numeric2 * 60;
        } else {
          total += numeric2;
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
    function getTranscriptRows() {
      return Array.from(document.querySelectorAll("tbody tr")).filter(
        (row) => row instanceof HTMLTableRowElement && row.querySelector(ROW_TEXTAREA_SELECTOR)
      );
    }
    function getRowSpeakerKey(row) {
      if (!(row instanceof HTMLTableRowElement) || row.children.length < 2) {
        return "";
      }
      return normalizeText(row.children[1]?.textContent || "");
    }
    function getRowTimeLabels(row) {
      if (!(row instanceof HTMLTableRowElement) || row.children.length < 4) {
        return null;
      }
      return {
        startText: normalizeText(row.children[2]?.textContent || ""),
        endText: normalizeText(row.children[3]?.textContent || "")
      };
    }
    function getRowTimeRange(row) {
      const labels = getRowTimeLabels(row);
      if (!labels) {
        return null;
      }
      const startSeconds = parseTimeValue(labels.startText);
      const endSeconds = parseTimeValue(labels.endText);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return null;
      }
      return {
        startSeconds,
        endSeconds
      };
    }
    function findRowByTimeRange(startSeconds, endSeconds, options) {
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        return null;
      }
      const settings = options || {};
      const speakerKey = typeof settings.speakerKey === "string" && settings.speakerKey ? settings.speakerKey : "";
      const rows = getTranscriptRows();
      let bestRow = null;
      let bestScore = -Infinity;
      for (const row of rows) {
        if (speakerKey && getRowSpeakerKey(row) !== speakerKey) {
          continue;
        }
        const range = getRowTimeRange(row);
        if (!range) {
          continue;
        }
        const overlap = Math.max(
          0,
          Math.min(endSeconds, range.endSeconds) - Math.max(startSeconds, range.startSeconds)
        );
        const distance = Math.abs(range.startSeconds - startSeconds) + Math.abs(range.endSeconds - endSeconds);
        const score = overlap > 0 ? overlap * 100 - distance : -distance;
        if (score > bestScore) {
          bestScore = score;
          bestRow = row;
        }
      }
      return bestRow;
    }
    function findRowByTimeLabels(startText, endText, options) {
      if (!startText || !endText) {
        return null;
      }
      const settings = options || {};
      const speakerKey = typeof settings.speakerKey === "string" && settings.speakerKey ? settings.speakerKey : "";
      const rows = getTranscriptRows();
      const exactMatch = rows.find((row) => {
        if (speakerKey && getRowSpeakerKey(row) !== speakerKey) {
          return false;
        }
        const labels = getRowTimeLabels(row);
        return labels && labels.startText === startText && labels.endText === endText;
      }) || null;
      if (exactMatch) {
        return exactMatch;
      }
      const targetStart = parseTimeValue(startText);
      const targetEnd = parseTimeValue(endText);
      if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || targetEnd <= targetStart) {
        return null;
      }
      return findRowByTimeRange(targetStart, targetEnd, {
        speakerKey
      });
    }
    function findRowNearBoundary(side, targetSeconds, options) {
      if (!Number.isFinite(targetSeconds)) {
        return null;
      }
      const settings = options || {};
      const speakerKey = typeof settings.speakerKey === "string" && settings.speakerKey ? settings.speakerKey : "";
      const boundarySide = side === "left" ? "left" : "right";
      const rows = getTranscriptRows();
      let bestRow = null;
      let bestScore = Infinity;
      for (const row of rows) {
        if (!(row instanceof HTMLTableRowElement)) {
          continue;
        }
        if (speakerKey && getRowSpeakerKey(row) !== speakerKey) {
          continue;
        }
        const range = getRowTimeRange(row);
        if (!range) {
          continue;
        }
        const boundarySeconds = boundarySide === "left" ? range.startSeconds : range.endSeconds;
        let score = Math.abs(boundarySeconds - targetSeconds);
        if (range.startSeconds <= targetSeconds && range.endSeconds >= targetSeconds) {
          score -= 2;
        }
        if (boundarySide === "right") {
          if (range.startSeconds >= targetSeconds + 0.01) {
            score += 1e3;
          } else if (range.endSeconds < targetSeconds - 5) {
            score += 25;
          }
        } else if (range.endSeconds <= targetSeconds - 0.01) {
          score += 1e3;
        } else if (range.startSeconds > targetSeconds + 5) {
          score += 25;
        }
        if (score < bestScore) {
          bestScore = score;
          bestRow = row;
        }
      }
      return bestRow;
    }
    function resolveRowTimeChangeBinding(row) {
      if (!(row instanceof HTMLTableRowElement)) {
        return null;
      }
      let fiber = getReactFiber(row);
      if (!fiber) {
        fiber = getReactFiber(row.querySelector(ROW_TEXTAREA_SELECTOR));
      }
      let current = fiber;
      let depth = 0;
      while (current && typeof current === "object" && depth < 16) {
        const props = current.memoizedProps;
        const annotation = props && typeof props === "object" && props.annotation && typeof props.annotation === "object" ? props.annotation : null;
        const onTimeChange = props && typeof props === "object" && typeof props.onTimeChange === "function" ? props.onTimeChange : null;
        if (annotation && typeof annotation.id === "string" && annotation.id && onTimeChange) {
          return {
            annotationId: annotation.id,
            onTimeChange,
            startSeconds: Number(annotation.startTimeInSeconds),
            endSeconds: Number(annotation.endTimeInSeconds)
          };
        }
        current = current.return;
        depth += 1;
      }
      return null;
    }
    function findRowByAnnotationId(annotationId) {
      if (typeof annotationId !== "string" || !annotationId) {
        return null;
      }
      for (const row of getTranscriptRows()) {
        const binding = resolveRowTimeChangeBinding(row);
        if (binding && binding.annotationId === annotationId) {
          return row;
        }
      }
      return null;
    }
    async function setBoundaryTime(payload) {
      const side = payload && payload.side === "left" ? "left" : "right";
      const targetSeconds = Number(payload?.targetSeconds);
      if (!Number.isFinite(targetSeconds)) {
        return {
          ok: false,
          backend: "page-react-row-time-change",
          reason: "invalid-target"
        };
      }
      let row = (payload?.annotationId ? findRowByAnnotationId(payload.annotationId) : null) || findRowByTimeLabels(payload?.startText, payload?.endText, {
        speakerKey: payload?.speakerKey
      }) || findRowNearBoundary(side, targetSeconds, {
        speakerKey: payload?.speakerKey
      });
      if (!(row instanceof HTMLTableRowElement) && payload?.rowIdentity && typeof payload.rowIdentity === "object") {
        row = findRowByAnnotationId(payload.rowIdentity.annotationId || "");
      }
      if (!(row instanceof HTMLTableRowElement)) {
        return {
          ok: false,
          backend: "page-react-row-time-change",
          reason: "row-not-found"
        };
      }
      const binding = resolveRowTimeChangeBinding(row);
      if (!binding || typeof binding.onTimeChange !== "function" || typeof binding.annotationId !== "string" || !binding.annotationId) {
        return {
          ok: false,
          backend: "page-react-row-time-change",
          reason: "binding-not-found"
        };
      }
      const rowRange = getRowTimeRange(row);
      const currentStart = Number.isFinite(binding.startSeconds) ? binding.startSeconds : rowRange ? rowRange.startSeconds : null;
      const currentEnd = Number.isFinite(binding.endSeconds) ? binding.endSeconds : rowRange ? rowRange.endSeconds : null;
      if (!Number.isFinite(currentStart) || !Number.isFinite(currentEnd)) {
        return {
          ok: false,
          backend: "page-react-row-time-change",
          reason: "current-range-invalid"
        };
      }
      const nextRange = side === "left" ? {
        start: targetSeconds,
        end: currentEnd
      } : {
        start: currentStart,
        end: targetSeconds
      };
      if (!Number.isFinite(nextRange.start) || !Number.isFinite(nextRange.end) || nextRange.end <= nextRange.start) {
        return {
          ok: false,
          backend: "page-react-row-time-change",
          reason: "next-range-invalid"
        };
      }
      try {
        binding.onTimeChange(binding.annotationId, nextRange);
      } catch (error) {
        return {
          ok: false,
          backend: "page-react-row-time-change",
          reason: "apply-threw",
          message: error instanceof Error ? error.message : String(error || "")
        };
      }
      const updatedRow = await waitFor(() => {
        const candidate = findRowByAnnotationId(binding.annotationId) || findRowNearBoundary(side, targetSeconds, {
          speakerKey: payload?.speakerKey
        });
        if (!(candidate instanceof HTMLTableRowElement)) {
          return null;
        }
        const range = getRowTimeRange(candidate);
        if (!range) {
          return null;
        }
        const boundarySeconds = side === "left" ? range.startSeconds : range.endSeconds;
        return Math.abs(boundarySeconds - targetSeconds) <= 0.03 ? candidate : null;
      }, 1200, 40);
      if (!(updatedRow instanceof HTMLTableRowElement)) {
        return {
          ok: false,
          backend: "page-react-row-time-change",
          reason: "verify-timeout"
        };
      }
      const updatedLabels = getRowTimeLabels(updatedRow);
      const updatedRange = getRowTimeRange(updatedRow);
      return {
        ok: true,
        backend: "page-react-row-time-change",
        annotationId: binding.annotationId,
        side,
        targetSeconds,
        startText: updatedLabels?.startText || "",
        endText: updatedLabels?.endText || "",
        startSeconds: updatedRange?.startSeconds ?? null,
        endSeconds: updatedRange?.endSeconds ?? null
      };
    }
    window.addEventListener(REQUEST_EVENT, (event) => {
      const detail = event.detail || {};
      const id = detail.id;
      const operation = detail.operation;
      const payload = detail.payload || {};
      if (!id) {
        return;
      }
      if (operation === "set-boundary-time") {
        Promise.resolve(setBoundaryTime(payload)).then((result) => respond(id, result)).catch(
          (error) => respond(id, {
            ok: false,
            backend: "page-react-row-time-change",
            reason: "bridge-error",
            message: error instanceof Error ? error.message : String(error || "")
          })
        );
      }
    });
    window.__babelHelperTimestampBridge = {
      setBoundaryTime
    };
  }
  initTimestampBridge();
})();
//# sourceMappingURL=timestamp-bridge.js.map
