"use strict";
(() => {
  // src/content/linter-bridge.ts
  function initLinterBridge() {
    if (window.__babelHelperLinterBridge) {
      return;
    }
    const TOGGLE_EVENT = "babel-helper-linter-bridge-toggle";
    const LINT_PATH = "/api/trpc/transcriptions.lintAnnotations";
    const RULE_REASON = 'Commas must be formatted as ", "';
    const RULE_SEVERITY = "error";
    const AUTO_LINT_MAX_ATTEMPTS = 20;
    const AUTO_LINT_RETRY_DELAY_MS = 250;
    const originalFetch = window.fetch.bind(window);
    let enabled = true;
    let autoLintAttemptCount = 0;
    let autoLintTimer = 0;
    const autoLintTriggeredRoutes = /* @__PURE__ */ new Set();
    const debugState = {
      totalLintCalls: 0,
      last: null,
      autoLint: null
    };
    function safeJsonParse(text) {
      if (typeof text !== "string") {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (_error) {
        return null;
      }
    }
    function getRequestUrl(input) {
      if (typeof input === "string") {
        return input;
      }
      if (input instanceof URL) {
        return input.toString();
      }
      if (input && typeof input.url === "string") {
        return input.url;
      }
      return "";
    }
    function getRequestMethod(input, init) {
      if (init && typeof init.method === "string" && init.method) {
        return init.method.toUpperCase();
      }
      if (input && typeof input.method === "string" && input.method) {
        return input.method.toUpperCase();
      }
      return "GET";
    }
    function isLintRequest(input, init) {
      const method = getRequestMethod(input, init);
      if (method !== "POST") {
        return false;
      }
      const rawUrl = getRequestUrl(input);
      return typeof rawUrl === "string" && rawUrl.indexOf(LINT_PATH) !== -1;
    }
    async function readRequestBodyText(input, init) {
      if (init && typeof init.body === "string") {
        return init.body;
      }
      if (input instanceof Request) {
        try {
          return await input.clone().text();
        } catch (_error) {
          return "";
        }
      }
      return "";
    }
    function readQueryInputPayload(urlString) {
      if (typeof urlString !== "string" || !urlString) {
        return null;
      }
      try {
        const url = new URL(urlString, window.location.origin);
        const encodedInput = url.searchParams.get("input");
        if (!encodedInput) {
          return null;
        }
        return safeJsonParse(encodedInput);
      } catch (_error) {
        return null;
      }
    }
    function readStringProp(source, keys) {
      for (const key of keys) {
        const value = source && typeof source === "object" ? source[key] : null;
        if (typeof value === "string" && value) {
          return value;
        }
      }
      return null;
    }
    function extractAnnotationEntries(root) {
      if (!root || typeof root !== "object") {
        return [];
      }
      const queue = [root];
      const seen = /* @__PURE__ */ new Set();
      const byAnnotationId = /* @__PURE__ */ new Map();
      while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== "object" || seen.has(current)) {
          continue;
        }
        seen.add(current);
        if (Array.isArray(current)) {
          for (const item of current) {
            queue.push(item);
          }
          continue;
        }
        const annotationId = readStringProp(current, ["annotationId", "id"]);
        const text = readStringProp(current, ["text", "content", "value", "segmentText"]);
        if (annotationId && typeof text === "string") {
          byAnnotationId.set(annotationId, text);
        }
        for (const value of Object.values(current)) {
          if (value && typeof value === "object") {
            queue.push(value);
          }
        }
      }
      return Array.from(byAnnotationId.entries()).map(([annotationId, text]) => ({
        annotationId,
        text
      }));
    }
    function hasCommaSpacingViolation(text) {
      if (typeof text !== "string" || text.indexOf(",") === -1) {
        return false;
      }
      return /\s+,/.test(text) || /,(?! |$)/.test(text) || /, {2,}/.test(text);
    }
    function buildCustomIssues(annotationEntries) {
      const issues = [];
      for (const entry of annotationEntries) {
        if (!entry || typeof entry.annotationId !== "string") {
          continue;
        }
        if (!hasCommaSpacingViolation(entry.text)) {
          continue;
        }
        issues.push({
          annotationId: entry.annotationId,
          reason: RULE_REASON,
          severity: RULE_SEVERITY
        });
      }
      return issues;
    }
    function isLintIssueLike(value) {
      return Boolean(
        value && typeof value === "object" && typeof value.annotationId === "string" && typeof value.reason === "string" && typeof value.severity === "string"
      );
    }
    function appendIssuesToArray(target, additionalIssues) {
      if (!Array.isArray(target) || !Array.isArray(additionalIssues) || !additionalIssues.length) {
        return false;
      }
      const existing = /* @__PURE__ */ new Set();
      for (const item of target) {
        if (!isLintIssueLike(item)) {
          continue;
        }
        existing.add(item.annotationId + "\0" + item.reason + "\0" + item.severity);
      }
      let appended = 0;
      for (const issue of additionalIssues) {
        const key = issue.annotationId + "\0" + issue.reason + "\0" + issue.severity;
        if (existing.has(key)) {
          continue;
        }
        target.push(issue);
        existing.add(key);
        appended += 1;
      }
      return appended > 0;
    }
    function appendIssuesAtTrpcPath(root, additionalIssues) {
      let changed = false;
      function visit(value) {
        if (!value || typeof value !== "object") {
          return;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            visit(item);
          }
          return;
        }
        const candidate = value.result && value.result.data && value.result.data.json;
        if (Array.isArray(candidate)) {
          if (appendIssuesToArray(candidate, additionalIssues)) {
            changed = true;
          }
        }
        for (const nested of Object.values(value)) {
          visit(nested);
        }
      }
      visit(root);
      return changed;
    }
    function appendIssuesByHeuristic(root, additionalIssues) {
      if (!root || typeof root !== "object") {
        return false;
      }
      const queue = [root];
      const seen = /* @__PURE__ */ new Set();
      let best = null;
      let bestScore = 0;
      while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== "object" || seen.has(current)) {
          continue;
        }
        seen.add(current);
        if (Array.isArray(current)) {
          for (const item of current) {
            if (item && typeof item === "object") {
              queue.push(item);
            }
          }
          continue;
        }
        for (const [key, nested] of Object.entries(current)) {
          if (Array.isArray(nested)) {
            let score = 0;
            if (key === "json") {
              score += 4;
            }
            if (nested.some(isLintIssueLike)) {
              score += 8;
            } else if (nested.length === 0) {
              score += 1;
            }
            if (score > bestScore) {
              bestScore = score;
              best = nested;
            }
          } else if (nested && typeof nested === "object") {
            queue.push(nested);
          }
        }
      }
      if (!best || bestScore < 4) {
        return false;
      }
      return appendIssuesToArray(best, additionalIssues);
    }
    function augmentJsonPayload(payload, additionalIssues) {
      if (!additionalIssues.length) {
        return false;
      }
      if (appendIssuesAtTrpcPath(payload, additionalIssues)) {
        return true;
      }
      return appendIssuesByHeuristic(payload, additionalIssues);
    }
    function appendIssuesToCompactJsonlFrame(payload, additionalIssues) {
      if (!payload || typeof payload !== "object" || !Array.isArray(additionalIssues) || !additionalIssues.length) {
        return false;
      }
      const frame = payload.json;
      if (!Array.isArray(frame) || frame.length < 3 || !Array.isArray(frame[2])) {
        return false;
      }
      let changed = false;
      for (const entry of frame[2]) {
        if (!Array.isArray(entry) || !entry.length) {
          continue;
        }
        const candidate = entry[0];
        if (!Array.isArray(candidate)) {
          continue;
        }
        if (appendIssuesToArray(candidate, additionalIssues)) {
          changed = true;
        }
      }
      return changed;
    }
    function isCompactJsonlFramePayload(payload) {
      if (!payload || typeof payload !== "object") {
        return false;
      }
      const frame = payload.json;
      return Array.isArray(frame) && frame.length >= 3 && typeof frame[0] === "number" && Array.isArray(frame[2]);
    }
    function parseJsonlLine(line) {
      if (typeof line !== "string") {
        return null;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        return null;
      }
      const plainParsed = safeJsonParse(trimmed);
      if (plainParsed != null) {
        return {
          prefix: "",
          payload: plainParsed
        };
      }
      const prefixedMatch = trimmed.match(/^(\d+):(.*)$/);
      if (!prefixedMatch) {
        return null;
      }
      const prefixedParsed = safeJsonParse(prefixedMatch[2]);
      if (prefixedParsed == null) {
        return null;
      }
      return {
        prefix: prefixedMatch[1] + ":",
        payload: prefixedParsed
      };
    }
    function cloneResponseWithBody(response, bodyText) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
    function tryAugmentJsonText(rawText, additionalIssues) {
      const parsed = safeJsonParse(rawText);
      if (parsed == null) {
        return null;
      }
      if (!augmentJsonPayload(parsed, additionalIssues)) {
        return null;
      }
      return JSON.stringify(parsed);
    }
    function tryAugmentJsonLines(rawText, additionalIssues) {
      const lines = rawText.split(/\r?\n/);
      if (lines.length < 2) {
        return null;
      }
      const parsedLines = lines.map(parseJsonlLine);
      const hasCompactFrames = parsedLines.some((entry) => entry && isCompactJsonlFramePayload(entry.payload));
      let changed = false;
      const mapped = lines.map((line, index) => {
        const parsed = parsedLines[index];
        if (!parsed) {
          return line;
        }
        const lineChanged = hasCompactFrames ? appendIssuesToCompactJsonlFrame(parsed.payload, additionalIssues) : augmentJsonPayload(parsed.payload, additionalIssues);
        if (!lineChanged) {
          return line;
        }
        changed = true;
        return parsed.prefix + JSON.stringify(parsed.payload);
      });
      if (!changed) {
        return null;
      }
      return mapped.join("\n");
    }
    function getRouteKey() {
      return String(window.location.pathname || "") + String(window.location.search || "");
    }
    function dispatchInputEvent(target, inputType, data) {
      try {
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
      } catch (_error) {
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    function triggerLintViaNoOpInput() {
      const textarea = document.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return {
          ok: false,
          reason: "textarea-not-found"
        };
      }
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (typeof valueSetter !== "function") {
        return {
          ok: false,
          reason: "value-setter-unavailable"
        };
      }
      const activeBefore = document.activeElement;
      const originalValue = textarea.value;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      try {
        try {
          textarea.focus({ preventScroll: true });
        } catch (_error) {
          textarea.focus();
        }
        valueSetter.call(textarea, originalValue + " ");
        dispatchInputEvent(textarea, "insertText", " ");
        valueSetter.call(textarea, originalValue);
        dispatchInputEvent(textarea, "deleteContentBackward", null);
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        if (typeof start === "number" && typeof end === "number") {
          textarea.setSelectionRange(start, end);
        }
        textarea.blur();
        if (activeBefore instanceof HTMLElement && activeBefore !== textarea) {
          try {
            activeBefore.focus({ preventScroll: true });
          } catch (_error) {
            activeBefore.focus();
          }
        }
        if (document.activeElement === textarea) {
          const sink = document.body || document.documentElement;
          if (sink instanceof HTMLElement) {
            const hadTabIndex = sink.hasAttribute("tabindex");
            if (!hadTabIndex) {
              sink.setAttribute("tabindex", "-1");
            }
            try {
              sink.focus({ preventScroll: true });
            } catch (_error) {
              sink.focus();
            }
            if (!hadTabIndex) {
              sink.removeAttribute("tabindex");
            }
          }
          textarea.blur();
        }
        return {
          ok: true,
          reason: "textarea-noop-input"
        };
      } catch (error) {
        return {
          ok: false,
          reason: "textarea-noop-throw",
          error: String(error && error.message ? error.message : error)
        };
      }
    }
    function scheduleInitialNativeLintTrigger(reason) {
      if (!enabled) {
        return;
      }
      const routeKey = getRouteKey();
      if (!routeKey || autoLintTriggeredRoutes.has(routeKey)) {
        return;
      }
      if (autoLintTimer) {
        window.clearTimeout(autoLintTimer);
        autoLintTimer = 0;
      }
      const attempt = () => {
        if (!enabled) {
          return;
        }
        const activeRouteKey = getRouteKey();
        if (!activeRouteKey || autoLintTriggeredRoutes.has(activeRouteKey)) {
          return;
        }
        if (debugState.totalLintCalls > 0) {
          autoLintTriggeredRoutes.add(activeRouteKey);
          debugState.autoLint = {
            changed: true,
            reason: "already-linted",
            route: activeRouteKey,
            attempts: autoLintAttemptCount,
            source: reason
          };
          return;
        }
        autoLintAttemptCount += 1;
        const kick = triggerLintViaNoOpInput();
        if (kick.ok) {
          autoLintTriggeredRoutes.add(activeRouteKey);
          debugState.autoLint = {
            changed: true,
            reason: kick.reason,
            route: activeRouteKey,
            attempts: autoLintAttemptCount,
            source: reason
          };
          return;
        }
        debugState.autoLint = {
          changed: false,
          reason: kick.reason,
          route: activeRouteKey,
          attempts: autoLintAttemptCount,
          source: reason,
          error: kick.error
        };
        if (autoLintAttemptCount >= AUTO_LINT_MAX_ATTEMPTS) {
          return;
        }
        autoLintTimer = window.setTimeout(attempt, AUTO_LINT_RETRY_DELAY_MS);
      };
      autoLintAttemptCount = 0;
      autoLintTimer = window.setTimeout(attempt, AUTO_LINT_RETRY_DELAY_MS);
    }
    async function maybeAugmentLintResponse(response, annotationEntries) {
      debugState.totalLintCalls += 1;
      if (!(response instanceof Response)) {
        debugState.last = {
          changed: false,
          reason: "non-response",
          issueCount: 0
        };
        return response;
      }
      const additionalIssues = buildCustomIssues(annotationEntries);
      if (!additionalIssues.length) {
        debugState.last = {
          changed: false,
          reason: "no-custom-issues",
          issueCount: 0
        };
        return response;
      }
      let responseText = "";
      try {
        responseText = await response.clone().text();
      } catch (_error) {
        debugState.last = {
          changed: false,
          reason: "response-read-failed",
          issueCount: additionalIssues.length
        };
        return response;
      }
      if (!responseText) {
        debugState.last = {
          changed: false,
          reason: "empty-response-text",
          issueCount: additionalIssues.length
        };
        return response;
      }
      const asJsonText = tryAugmentJsonText(responseText, additionalIssues);
      if (typeof asJsonText === "string") {
        debugState.last = {
          changed: true,
          reason: "json",
          issueCount: additionalIssues.length
        };
        return cloneResponseWithBody(response, asJsonText);
      }
      const asJsonLinesText = tryAugmentJsonLines(responseText, additionalIssues);
      if (typeof asJsonLinesText === "string") {
        debugState.last = {
          changed: true,
          reason: "jsonl",
          issueCount: additionalIssues.length,
          responsePreview: asJsonLinesText.slice(0, 240)
        };
        return cloneResponseWithBody(response, asJsonLinesText);
      }
      debugState.last = {
        changed: false,
        reason: "no-target-found",
        issueCount: additionalIssues.length,
        responsePreview: responseText.slice(0, 240)
      };
      return response;
    }
    async function getAnnotationEntriesFromRequest(input, init) {
      const bodyText = await readRequestBodyText(input, init);
      const bodyPayload = safeJsonParse(bodyText);
      if (bodyPayload && typeof bodyPayload === "object") {
        const entries = extractAnnotationEntries(bodyPayload);
        if (entries.length) {
          return entries;
        }
      }
      const urlPayload = readQueryInputPayload(getRequestUrl(input));
      if (urlPayload && typeof urlPayload === "object") {
        return extractAnnotationEntries(urlPayload);
      }
      return [];
    }
    window.fetch = async function babelHelperLinterPatchedFetch(input, init) {
      if (!enabled || !isLintRequest(input, init)) {
        return originalFetch(input, init);
      }
      const annotationEntries = await getAnnotationEntriesFromRequest(input, init);
      const response = await originalFetch(input, init);
      return maybeAugmentLintResponse(response, annotationEntries);
    };
    window.addEventListener(
      TOGGLE_EVENT,
      (event) => {
        const nextEnabled = Boolean(event && event.detail && event.detail.enabled);
        enabled = nextEnabled;
        if (enabled) {
          scheduleInitialNativeLintTrigger("toggle-enable");
        }
      },
      true
    );
    scheduleInitialNativeLintTrigger("boot");
    window.__babelHelperLinterBridge = {
      version: 1,
      get enabled() {
        return enabled;
      },
      get debug() {
        return debugState;
      }
    };
  }
  initLinterBridge();
})();
//# sourceMappingURL=linter-bridge.js.map
