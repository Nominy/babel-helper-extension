"use strict";
(() => {
  // src/content/linter-bridge.ts
  function initLinterBridge() {
    if (window.__babelHelperLinterBridge) {
      return;
    }
    const TOGGLE_EVENT = "babel-helper-linter-bridge-toggle";
    const LINT_PATH = "/api/trpc/transcriptions.lintAnnotations";
    const COMMA_RULE_REASON = 'Commas must be formatted as ", "';
    const QUOTE_BALANCE_RULE_REASON = "Double quotes must be balanced.";
    const QUOTE_PLACEMENT_RULE_REASON = "Double quotes must not have stray spaces inside or be glued to surrounding words.";
    const CURLY_SPACING_RULE_REASON = 'Curly tags must be formatted as "TEXT {TAG: OTHER}".';
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
      return /\s+,/.test(text) || /(?<!\d),(?![\d ]|$)/.test(text) || /, {2,}/.test(text);
    }
    function getQuoteIndices(text) {
      const indices = [];
      if (typeof text !== "string" || text.indexOf('"') === -1) {
        return indices;
      }
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '"') {
          indices.push(index);
        }
      }
      return indices;
    }
    function hasUnbalancedDoubleQuotes(text) {
      return getQuoteIndices(text).length % 2 === 1;
    }
    function isWordCharacter(char) {
      return typeof char === "string" && /[\p{L}\p{N}]/u.test(char);
    }
    function hasQuotePlacementViolation(text) {
      const quoteIndices = getQuoteIndices(text);
      if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
        return false;
      }
      for (let index = 0; index < quoteIndices.length; index += 2) {
        const openIndex = quoteIndices[index];
        const closeIndex = quoteIndices[index + 1];
        const prevChar = openIndex > 0 ? text[openIndex - 1] : "";
        const nextCharAfterOpen = openIndex + 1 < text.length ? text[openIndex + 1] : "";
        const prevCharBeforeClose = closeIndex > 0 ? text[closeIndex - 1] : "";
        const nextChar = closeIndex + 1 < text.length ? text[closeIndex + 1] : "";
        if (/\s/.test(nextCharAfterOpen) || /\s/.test(prevCharBeforeClose)) {
          return true;
        }
        if (isWordCharacter(prevChar) || isWordCharacter(nextChar)) {
          return true;
        }
      }
      return false;
    }
    function hasCurlySpacingViolation(text) {
      if (typeof text !== "string") {
        return false;
      }
      const hasOpen = text.indexOf("{") !== -1;
      const hasClose = text.indexOf("}") !== -1;
      if (!hasOpen && !hasClose) {
        return false;
      }
      if (hasOpen !== hasClose) {
        return true;
      }
      const stack = [];
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === "{") {
          stack.push(index);
          continue;
        }
        if (char !== "}") {
          continue;
        }
        if (!stack.length) {
          return true;
        }
        const openIndex = stack.pop();
        const prevChar = openIndex > 0 ? text[openIndex - 1] : "";
        const nextCharAfterOpen = openIndex + 1 < text.length ? text[openIndex + 1] : "";
        const prevCharBeforeClose = index > 0 ? text[index - 1] : "";
        const nextChar = index + 1 < text.length ? text[index + 1] : "";
        if (/\s/.test(nextCharAfterOpen) || /\s/.test(prevCharBeforeClose)) {
          return true;
        }
        if (isWordCharacter(prevChar) || isWordCharacter(nextChar)) {
          return true;
        }
      }
      return stack.length > 0;
    }
    function buildCustomIssues(annotationEntries) {
      const issues = [];
      for (const entry of annotationEntries) {
        if (!entry || typeof entry.annotationId !== "string") {
          continue;
        }
        if (hasCommaSpacingViolation(entry.text)) {
          issues.push({
            annotationId: entry.annotationId,
            reason: COMMA_RULE_REASON,
            severity: RULE_SEVERITY
          });
        }
        if (hasUnbalancedDoubleQuotes(entry.text)) {
          issues.push({
            annotationId: entry.annotationId,
            reason: QUOTE_BALANCE_RULE_REASON,
            severity: RULE_SEVERITY
          });
        } else if (hasQuotePlacementViolation(entry.text)) {
          issues.push({
            annotationId: entry.annotationId,
            reason: QUOTE_PLACEMENT_RULE_REASON,
            severity: RULE_SEVERITY
          });
        }
        if (hasCurlySpacingViolation(entry.text)) {
          issues.push({
            annotationId: entry.annotationId,
            reason: CURLY_SPACING_RULE_REASON,
            severity: RULE_SEVERITY
          });
        }
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
    const AUTOFIX_REQUEST_EVENT = "babel-helper-linter-autofix";
    const AUTOFIX_RESPONSE_EVENT = "babel-helper-linter-autofix-response";
    const ROW_TEXTAREA_SELECTOR = 'textarea[placeholder^="What was said"]';
    function fixCommaSpacing(text) {
      if (typeof text !== "string" || text.indexOf(",") === -1) {
        return text;
      }
      let result = text;
      result = result.replace(/\s+,/g, ",");
      result = result.replace(/,(?![\d ]|$)/g, ", ");
      result = result.replace(/, {2,}/g, ", ");
      return result;
    }
    function fixQuotePlacement(text) {
      const quoteIndices = getQuoteIndices(text);
      if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
        return text;
      }
      let result = text;
      for (let index = quoteIndices.length - 2; index >= 0; index -= 2) {
        const openIndex = quoteIndices[index];
        const closeIndex = quoteIndices[index + 1];
        const inner = result.substring(openIndex + 1, closeIndex);
        const trimmedInner = inner.replace(/^\s+/, "").replace(/\s+$/, "");
        const before = result.substring(0, openIndex);
        const after = result.substring(closeIndex + 1);
        let prefix = before;
        if (prefix.length > 0 && isWordCharacter(prefix[prefix.length - 1])) {
          prefix = prefix + " ";
        }
        let suffix = after;
        if (suffix.length > 0 && isWordCharacter(suffix[0])) {
          suffix = " " + suffix;
        }
        result = prefix + '"' + trimmedInner + '"' + suffix;
      }
      return result;
    }
    function fixCurlySpacing(text) {
      if (typeof text !== "string") {
        return text;
      }
      const hasOpen = text.indexOf("{") !== -1;
      const hasClose = text.indexOf("}") !== -1;
      if (!hasOpen || !hasClose) {
        return text;
      }
      let result = text.replace(/\{\s+/g, "{").replace(/\s+\}/g, "}");
      result = result.replace(/([\p{L}\p{N}])\{/gu, "$1 {");
      result = result.replace(/\}([\p{L}\p{N}])/gu, "} $1");
      return result;
    }
    function applyAllFixes(text) {
      if (typeof text !== "string") {
        return text;
      }
      let result = text;
      result = fixCommaSpacing(result);
      result = fixQuotePlacement(result);
      result = fixCurlySpacing(result);
      return result;
    }
    function setTextareaValue(textarea, value) {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (typeof valueSetter === "function") {
        valueSetter.call(textarea, value);
      } else {
        textarea.value = value;
      }
      try {
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
      } catch (_error) {
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function autoFixTextarea(textarea) {
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return { fixed: false, reason: "not-textarea" };
      }
      const original = textarea.value || "";
      const fixed = applyAllFixes(original);
      if (fixed === original) {
        return { fixed: false, reason: "no-changes" };
      }
      const selStart = textarea.selectionStart;
      const selEnd = textarea.selectionEnd;
      setTextareaValue(textarea, fixed);
      const clampedStart = Math.min(selStart, fixed.length);
      const clampedEnd = Math.min(selEnd, fixed.length);
      try {
        textarea.setSelectionRange(clampedStart, clampedEnd);
      } catch (_error) {
      }
      return { fixed: true, reason: "applied", original, result: fixed };
    }
    function autoFixRow(row) {
      if (!(row instanceof HTMLElement)) {
        return { fixed: false, reason: "not-element" };
      }
      const textarea = row.querySelector(ROW_TEXTAREA_SELECTOR);
      return autoFixTextarea(textarea);
    }
    function autoFixAll() {
      const textareas = document.querySelectorAll(ROW_TEXTAREA_SELECTOR);
      let fixedCount = 0;
      let totalCount = 0;
      for (const textarea of textareas) {
        totalCount += 1;
        const result = autoFixTextarea(textarea);
        if (result.fixed) {
          fixedCount += 1;
        }
      }
      return { fixedCount, totalCount };
    }
    function autoFixCurrent() {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.matches(ROW_TEXTAREA_SELECTOR)) {
        return autoFixTextarea(active);
      }
      const activeRow = document.querySelector("tbody tr.bg-neutral-100.ring-1.ring-neutral-300");
      if (activeRow) {
        return autoFixRow(activeRow);
      }
      const first = document.querySelector(ROW_TEXTAREA_SELECTOR);
      return autoFixTextarea(first);
    }
    window.addEventListener(
      AUTOFIX_REQUEST_EVENT,
      (event) => {
        if (!enabled) {
          window.dispatchEvent(new CustomEvent(AUTOFIX_RESPONSE_EVENT, {
            detail: { ok: false, reason: "disabled" }
          }));
          return;
        }
        const detail = event && event.detail ? event.detail : {};
        const scope = detail.scope || "current";
        let result;
        if (scope === "all") {
          result = autoFixAll();
        } else {
          result = autoFixCurrent();
        }
        scheduleInitialNativeLintTrigger("autofix");
        window.dispatchEvent(new CustomEvent(AUTOFIX_RESPONSE_EVENT, {
          detail: { ok: true, scope, ...result }
        }));
      },
      true
    );
    window.__babelHelperLinterBridge = {
      version: 2,
      get enabled() {
        return enabled;
      },
      get debug() {
        return debugState;
      },
      autoFixCurrent,
      autoFixAll,
      applyAllFixes
    };
  }
  initLinterBridge();
})();
//# sourceMappingURL=linter-bridge.js.map
