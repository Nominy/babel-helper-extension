// @ts-nocheck
import {
  DEFAULT_HIGHLIGHTED_WORDS,
  normalizeHighlightedWords,
} from "../core/highlighted-words";
import {
  applyRuleFixes,
  buildRegistryIssues,
  getVisibleTooltipEntries,
} from "../features/custom-linter/linter/rule-registry";
import {
  createTranscriptTextContext,
  getEnclosingGenericTagRange as getContextEnclosingGenericTagRange,
  isRangeInsideGenericTag as isContextRangeInsideGenericTag,
} from "../features/custom-linter/linter/text-context";
import { createCustomLinterRules } from "../features/custom-linter/linter/rules";
import { BABEL_ROW_TEXTAREA_SELECTOR } from "../core/babel-editor-contract";

export function initLinterBridge() {
  if (window.__babelHelperLinterBridge) {
    return;
  }

  const TOGGLE_EVENT = "babel-helper-linter-bridge-toggle";
  const CONFIG_EVENT = "babel-helper-linter-bridge-config";
  const TEARDOWN_EVENT = "babel-helper-bridge-teardown";
  const LINT_PATH = "/api/trpc/transcriptions.lintAnnotations";
  const SAVE_ANNOTATIONS_PATH =
    "/api/trpc/transcriptions.saveAnnotationsByReviewActionId";
  const COMMA_RULE_REASON = 'Commas must be formatted as ", "';
  const PERIOD_SPACING_RULE_REASON =
    'Periods must be spaced as "." followed by one space.';
  const NATIVE_LEADING_TRAILING_SPACES_REASON =
    "Extra spaces at the end or beginning of segments are not allowed.";
  const NATIVE_DOUBLE_SPACES_REASON = "Double spaces are not allowed.";
  const QUOTE_BALANCE_RULE_REASON = "Double quotes must be balanced.";
  const UNICODE_QUOTE_RULE_REASON =
    'Use ASCII double quote (") instead of typographic or Unicode quote variants.';
  const CURLY_SPACING_RULE_REASON =
    'Curly tags must be formatted as "TEXT {TAG: OTHER}".';
  const ANGLE_TAG_SPACING_RULE_REASON =
    'Angle tags must be formatted as standalone "TEXT <TAG> OTHER" tokens.';
  const SQUARE_BRACKET_TAG_SPACING_RULE_REASON =
    'Square bracket tags must be formatted as standalone "TEXT [TAG] OTHER" tokens.';
  const CURLY_TAG_TRAILING_PUNCTUATION_RULE_REASON =
    "Punctuation after curly tags must move before the tag.";
  const ANGLE_TAG_TRAILING_PUNCTUATION_RULE_REASON =
    "Punctuation should be inside style tags.";
  const SQUARE_BRACKET_TAG_TRAILING_PUNCTUATION_RULE_REASON =
    "Punctuation after square bracket tags must move before the tag.";
  const UNICODE_DASH_RULE_REASON =
    'Use ASCII hyphen "-" instead of typographic or Unicode dash variants.';
  const COMMA_BEFORE_DASH_RULE_REASON =
    "Commas before dash separators should be removed.";
  const FREE_MID_SENTENCE_DOUBLE_DASH_RULE_REASON =
    "Free-floating mid-sentence double dash must be a single dash.";
  const DOUBLE_DASH_PUNCTUATION_RULE_REASON =
    "Punctuation immediately after double dash is typically avoided.";
  const SINGLE_DASH_PUNCTUATION_RULE_REASON =
    "Punctuation immediately after single dash is typically avoided.";
  const INCORRECT_INTERJECTION_FORMS_RULE_REASON =
    "Incorrect interjection forms must use dictionary spelling.";
  const SENTENCE_BOUNDARY_CAPITALIZATION_RULE_REASON =
    "Words after clear sentence endings ., ?, ! must start uppercase.";
  const POLITE_PRONOUN_CASE_RULE_REASON =
    'Russian polite pronouns like "вы" / "ваш" must be lowercase mid-sentence.';
  const TERMINAL_PUNCTUATION_RULE_REASON =
    'Segments must end with one of: ?, ..., !, -, --, ", or .';
  const SEGMENT_START_CAPITALIZATION_RULE_REASON =
    "Segments must start with uppercase unless they continue the same speaker after --/...; segments starting with ... must continue with lowercase.";
  const HIGHLIGHTED_WORD_RULE_REASON =
    "Highlighted word requires clearance before use.";
  const RULE_SEVERITY = "error";
  const HIGHLIGHTED_WORD_RULE_SEVERITY = "warning";
  const HIGHLIGHT_STYLE_ID = "babel-helper-linter-highlight-style";
  const HIGHLIGHT_MARK_ATTR = "data-babel-helper-linter-highlight";
  const HIGHLIGHT_OVERLAY_ATTR = "data-babel-helper-linter-overlay";
  const HIGHLIGHT_SWATCH_ATTR = "data-babel-helper-linter-swatch";
  const HIGHLIGHT_PREVIEW_ATTR = "data-babel-helper-linter-preview";
  const HIGHLIGHT_OBSERVER_DELAY_MS = 50;
  const NATIVE_LINT_AUGMENT_GLOBAL = "__babelHelperLinterAugmentNativeIssues";
  const NATIVE_LINT_PATCH_MARK = "__babelHelperLinterWebpackPatched";
  const NATIVE_LINT_STATE_SYNC_DELAY_MS = 1750;
  const HIGHLIGHTED_WORD_CLEARANCE_STORAGE_KEY =
    "babel-helper-highlighted-word-clearances:v1";
  const AUTO_LINT_MAX_ATTEMPTS = 20;
  const AUTO_LINT_RETRY_DELAY_MS = 100;
  const ROW_TEXTAREA_SELECTOR = BABEL_ROW_TEXTAREA_SELECTOR;
  const UNICODE_DOUBLE_QUOTE_PATTERN =
    /[\u00AB\u00BB\u201C\u201D\u201E\u201F\u2039\u203A\u275D\u275E\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02]/gu;
  const UNICODE_DASH_PATTERN =
    /[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/gu;
  const POLITE_PRONOUN_PATTERN =
    /(^|[^\p{L}\p{N}\p{M}])(вы|вас|вам|вами|ваш(?:а|е|и|его|ему|им|ем|у|ей|ею|их|ими)?)(?=$|[^\p{L}\p{N}\p{M}])/giu;

  const fallbackFetch = (
    window.fetch.__babelHelperLinterOriginal || window.fetch
  ).bind(window);
  let upstreamFetch = fallbackFetch;
  let forwardingFetch = 0;
  let enabled = false;
  let autoLintAttemptCount = 0;
  let autoLintTimer = 0;
  let fetchPatchTimer = 0;
  let highlightObserver = null;
  let highlightTimer = 0;
  let applyingHighlights = false;
  let currentHighlightIssues = [];
  let highlightedRow = null;
  let nativeLintStateTimer = 0;
  let nativeLintStateObserver = null;
  let nativeLinterWebpackPatchInstalled = false;
  let nativeLinterWebpackOriginalPush = null;
  let textareaVisibilityObserver = null;
  let textareaMountObserver = null;
  const autoLintTriggeredRoutes = new Set();
  const routeLintCallCounts = new Map();
  const clearedHighlightedWordKeys = new Set();
  let highlightedWordClearancesLoaded = false;
  let highlightedWordClearanceTaskKey = "";
  const debugState = {
    totalLintCalls: 0,
    last: null,
    autoLint: null,
    nativeLint: null,
    nativeLintDispatch: null,
    customRuleErrors: [],
  };
  let highlightedWordsEnabled = true;
  let highlightedWords = normalizeHighlightedWords(DEFAULT_HIGHLIGHTED_WORDS);
  let disabledCustomLinterRuleIds = [];
  const INTERJECTION_CORRECTION_SPECS = [
    { canonical: "а", variants: ["аа", "а-а", "а-а-а"] },
    { canonical: "ага", variants: ["ага-а", "агаа"] },
    { canonical: "Ам", variants: ["А-м", "а-ам"] },
    { canonical: "ах", variants: ["ахх", "а-а-ах"] },
    { canonical: "блин", variants: ["бли-ин"] },
    { canonical: "Вау", variants: ["уау"] },
    { canonical: "вот", variants: ["вооот"] },
    { canonical: "ей-богу", variants: ["ейбогу", "ей богу"] },
    { canonical: "м-да", variants: ["мда", "мдя"] },
    { canonical: "мгм", variants: ["мм-гм", "мхм"] },
    { canonical: "м", variants: ["мм", "Ммм", "м-м-м"] },
    { canonical: "Н-да", variants: ["Нда"] },
    { canonical: "ну", variants: ["нууу", "ну-у"] },
    { canonical: "Ну да", variants: ["Ну, да"] },
    { canonical: "о да", variants: ["о, да"] },
    { canonical: "о нет", variants: ["о, нет"] },
    { canonical: "ой", variants: ["оой", "ойй"] },
    { canonical: "окей", variants: ["о'кей"] },
    { canonical: "ох", variants: ["охх"] },
    { canonical: "у", variants: ["у-у"] },
    { canonical: "угу", variants: ["у-г-у", "угуу"] },
    { canonical: "ух", variants: ["ухх"] },
    { canonical: "фу", variants: ["фу-у"] },
    { canonical: "ха-ха", variants: ["хахаха"] },
    { canonical: "ха", variants: ["ха-а", "хаха"] },
    { canonical: "хм", variants: ["хмм", "гм"] },
    { canonical: "чёрт", variants: ["чорт"] },
    { canonical: "э", variants: ["э-э", "эээ", "ээ", "э…э"] },
    { canonical: "эх", variants: ["э-эх", "эхх"] },
    { canonical: "о", variants: ["оо", "о-о"] },
  ];

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

  function isPostRequestPath(input, init, path) {
    const method = getRequestMethod(input, init);
    if (method !== "POST") {
      return false;
    }

    const rawUrl = getRequestUrl(input);
    return typeof rawUrl === "string" && rawUrl.indexOf(path) !== -1;
  }

  function isLintRequest(input, init) {
    return isPostRequestPath(input, init, LINT_PATH);
  }

  function isSaveAnnotationsRequest(input, init) {
    return isPostRequestPath(input, init, SAVE_ANNOTATIONS_PATH);
  }

  function isTranscriptionsRequest(input) {
    const rawUrl = getRequestUrl(input);
    return (
      typeof rawUrl === "string" &&
      rawUrl.indexOf("/api/trpc/transcriptions.") !== -1
    );
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

  function withRequestBodyText(input, init, bodyText) {
    if (typeof bodyText !== "string") {
      return { input, init };
    }

    if (input instanceof Request && (!init || init.body === undefined)) {
      try {
        return {
          input: new Request(input, { body: bodyText }),
          init: undefined,
        };
      } catch (_error) {
        return {
          input,
          init: { ...(init || {}), body: bodyText },
        };
      }
    }

    return {
      input,
      init: { ...(init || {}), body: bodyText },
    };
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

  function readStringArrayProp(source, keys) {
    for (const key of keys) {
      const value = source && typeof source === "object" ? source[key] : null;
      if (Array.isArray(value)) {
        return value.filter((item) => typeof item === "string");
      }
    }

    return [];
  }

  function readAnnotationMetadata(source) {
    const direct =
      source && typeof source.metadata === "object" && source.metadata
        ? source.metadata
        : null;
    if (direct) {
      return direct;
    }

    const annotation =
      source && source.annotation && typeof source.annotation === "object"
        ? source.annotation
        : null;
    return annotation &&
      typeof annotation.metadata === "object" &&
      annotation.metadata
      ? annotation.metadata
      : null;
  }

  function readAssertedWarnings(source) {
    const metadata = readAnnotationMetadata(source);
    return readStringArrayProp(metadata, ["assertedWarnings"]);
  }

  function isHelperWarningReason(reason) {
    return reason === HIGHLIGHTED_WORD_RULE_REASON;
  }

  function getAnnotationEntryFromObject(source, inheritedReviewActionId = "") {
    if (!source || typeof source !== "object") {
      return null;
    }

    const annotationId = readStringProp(source, ["annotationId", "id"]);
    const text = readStringProp(source, [
      "text",
      "content",
      "value",
      "segmentText",
    ]);
    if (!annotationId || typeof text !== "string") {
      return null;
    }

    return {
      annotationId,
      reviewActionId:
        readStringProp(source, ["reviewActionId", "actionId"]) ||
        inheritedReviewActionId ||
        "",
      text,
      assertedWarnings: readAssertedWarnings(source),
    };
  }

  function extractAnnotationEntries(root) {
    if (!root || typeof root !== "object") {
      return [];
    }

    function normalizeSpeakerKey(value) {
      return typeof value === "string" ? value.trim() : "";
    }

    function readSpeakerKey(source) {
      if (!source || typeof source !== "object") {
        return "";
      }

      const direct = readStringProp(source, [
        "processedRecordingId",
        "trackLabel",
        "speakerKey",
        "speakerId",
        "speakerName",
        "speaker",
      ]);
      if (direct) {
        return normalizeSpeakerKey(direct);
      }

      const annotation =
        source.annotation && typeof source.annotation === "object"
          ? source.annotation
          : null;
      const nested = readStringProp(annotation, [
        "processedRecordingId",
        "trackLabel",
        "speakerKey",
        "speakerId",
        "speakerName",
        "speaker",
      ]);
      return normalizeSpeakerKey(nested);
    }

    const seen = new Set();
    const orderedEntries = [];
    const entryById = new Map();

    function visit(current, inheritedReviewActionId = "") {
      if (!current || typeof current !== "object" || seen.has(current)) {
        return;
      }

      seen.add(current);

      if (Array.isArray(current)) {
        for (const item of current) {
          visit(item, inheritedReviewActionId);
        }
        return;
      }

      const reviewActionId =
        readStringProp(current, ["reviewActionId", "actionId"]) ||
        inheritedReviewActionId;
      const annotationEntry = getAnnotationEntryFromObject(
        current,
        reviewActionId,
      );
      if (annotationEntry) {
        const speakerKey = readSpeakerKey(current);
        const existing = entryById.get(annotationEntry.annotationId);
        if (existing) {
          existing.text = annotationEntry.text;
          if (!existing.reviewActionId && annotationEntry.reviewActionId) {
            existing.reviewActionId = annotationEntry.reviewActionId;
          }
          if (annotationEntry.assertedWarnings.length) {
            existing.assertedWarnings = annotationEntry.assertedWarnings;
          }
          if (!existing.speakerKey && speakerKey) {
            existing.speakerKey = speakerKey;
          }
        } else {
          const entry = {
            annotationId: annotationEntry.annotationId,
            reviewActionId: annotationEntry.reviewActionId,
            text: annotationEntry.text,
            speakerKey,
            assertedWarnings: annotationEntry.assertedWarnings,
          };
          entryById.set(annotationEntry.annotationId, entry);
          orderedEntries.push(entry);
        }
      }

      for (const value of Object.values(current)) {
        if (value && typeof value === "object") {
          visit(value, reviewActionId);
        }
      }
    }

    visit(root);
    return orderedEntries;
  }

  function hasCommaSpacingViolation(text) {
    if (typeof text !== "string" || text.indexOf(",") === -1) {
      return false;
    }

    return (
      /\s+,/.test(text) ||
      /(?<!\d),(?![\d ]|$)/.test(text) ||
      /, {2,}/.test(text)
    );
  }

  function isStandalonePeriodAt(
    text,
    index,
    textContext = createTranscriptTextContext(text),
  ) {
    if (typeof text !== "string" || text[index] !== ".") {
      return false;
    }

    const prevChar = index > 0 ? text[index - 1] : "";
    const nextChar = index + 1 < text.length ? text[index + 1] : "";
    if (prevChar === "." || nextChar === ".") {
      return false;
    }

    if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
      return false;
    }

    return !textContext.isRangeInsideGenericTag(index, index + 1);
  }

  function shouldPeriodHaveFollowingSpaceBefore(char) {
    return typeof char === "string" && /[\p{L}\p{N}<{\[]/u.test(char);
  }

  function getPeriodSpacingParts(
    text,
    textContext = createTranscriptTextContext(text),
  ) {
    if (typeof text !== "string" || text.indexOf(".") === -1) {
      return [];
    }

    const parts = [];
    for (let index = 0; index < text.length; index += 1) {
      if (!isStandalonePeriodAt(text, index, textContext)) {
        continue;
      }

      const hasSpaceBefore = index > 0 && /[ \t]/.test(text[index - 1]);
      let nextIndex = index + 1;
      while (nextIndex < text.length && /[ \t]/.test(text[nextIndex])) {
        nextIndex += 1;
      }

      const shouldHaveSpaceAfter = shouldPeriodHaveFollowingSpaceBefore(
        text[nextIndex],
      );
      const hasExactlyOneSpaceAfter =
        nextIndex === index + 2 && text[index + 1] === " ";
      const hasBadSpaceAfter = shouldHaveSpaceAfter && !hasExactlyOneSpaceAfter;

      if (hasSpaceBefore || hasBadSpaceAfter) {
        parts.push({
          start: hasSpaceBefore ? index - 1 : index,
          end: hasBadSpaceAfter ? Math.max(index + 1, nextIndex) : index + 1,
        });
      }
    }

    return parts;
  }

  function hasPeriodSpacingViolation(text) {
    return getPeriodSpacingParts(text).length > 0;
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

  function normalizeUnicodeDoubleQuoteVariants(text) {
    if (typeof text !== "string") {
      return text;
    }

    UNICODE_DOUBLE_QUOTE_PATTERN.lastIndex = 0;
    if (!UNICODE_DOUBLE_QUOTE_PATTERN.test(text)) {
      return text;
    }

    UNICODE_DOUBLE_QUOTE_PATTERN.lastIndex = 0;
    return text.replace(UNICODE_DOUBLE_QUOTE_PATTERN, '"');
  }

  function hasUnicodeQuoteViolation(text) {
    return (
      typeof text === "string" &&
      normalizeUnicodeDoubleQuoteVariants(text) !== text
    );
  }

  function hasUnbalancedDoubleQuotes(text) {
    return (
      getQuoteIndices(normalizeUnicodeDoubleQuoteVariants(text)).length % 2 ===
      1
    );
  }

  function isWordCharacter(char) {
    return typeof char === "string" && /[\p{L}\p{N}]/u.test(char);
  }

  function getEnclosingGenericTagRange(text, index) {
    return getContextEnclosingGenericTagRange(text, index);
  }

  function isRangeInsideGenericTag(text, start, end) {
    return isContextRangeInsideGenericTag(text, start, end);
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getLetterCaseShape(text) {
    if (typeof text !== "string" || !text) {
      return "mixed";
    }

    const letters = Array.from(text).filter((char) => /[\p{L}]/u.test(char));
    if (!letters.length) {
      return "mixed";
    }

    const allUpper = letters.every((char) => char === char.toLocaleUpperCase());
    if (allUpper) {
      return "upper";
    }

    const allLower = letters.every((char) => char === char.toLocaleLowerCase());
    if (allLower) {
      return "lower";
    }

    const [first, ...rest] = letters;
    if (
      first === first.toLocaleUpperCase() &&
      rest.every((char) => char === char.toLocaleLowerCase())
    ) {
      return "title";
    }

    return "mixed";
  }

  function applyLetterCaseShape(text, shape) {
    if (typeof text !== "string" || !text) {
      return text;
    }

    if (shape === "upper") {
      return text.toLocaleUpperCase();
    }

    if (shape === "lower") {
      return text.toLocaleLowerCase();
    }

    if (shape === "title") {
      let applied = false;
      let result = "";
      for (const char of text) {
        if (!/[\p{L}]/u.test(char)) {
          result += char;
          continue;
        }

        if (!applied) {
          result += char.toLocaleUpperCase();
          applied = true;
        } else {
          result += char.toLocaleLowerCase();
        }
      }

      return result;
    }

    return text;
  }

  const INTERJECTION_CORRECTIONS = INTERJECTION_CORRECTION_SPECS.flatMap(
    (entry) =>
      entry.variants.map((variant) => ({
        canonical: entry.canonical,
        variant,
      })),
  )
    .sort((left, right) => right.variant.length - left.variant.length)
    .map((entry) => ({
      canonical: entry.canonical,
      pattern: new RegExp(
        `(^|[^\\p{L}\\p{N}\\p{M}])(${escapeRegExp(entry.variant)})(?=$|[^\\p{L}\\p{N}\\p{M}])`,
        "giu",
      ),
    }));

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
      const nextCharAfterOpen =
        openIndex + 1 < text.length ? text[openIndex + 1] : "";
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

  function hasDoubleDashPunctuationViolation(text) {
    if (typeof text !== "string" || text.indexOf("--") === -1) {
      return false;
    }

    const pattern = /--[.,?!:;]/gu;
    let match;
    while ((match = pattern.exec(text))) {
      if (
        !isRangeInsideGenericTag(
          text,
          match.index,
          match.index + match[0].length,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  function getFreeMidSentenceDoubleDashParts(
    text,
    textContext = createTranscriptTextContext(text),
  ) {
    if (typeof text !== "string" || text.indexOf("--") === -1) {
      return [];
    }

    const parts = [];
    for (
      let index = text.indexOf("--");
      index !== -1;
      index = text.indexOf("--", index + 2)
    ) {
      if (text[index - 1] === "-" || text[index + 2] === "-") {
        continue;
      }

      if (
        textContext.isRangeInsideGenericTag(index, index + 2) ||
        isInsideOpenQuoteAt(text, index)
      ) {
        continue;
      }

      if (
        !/[ \t]/.test(text[index - 1] || "") ||
        !/[ \t]/.test(text[index + 2] || "")
      ) {
        continue;
      }

      let start = index - 1;
      while (start > 0 && /[ \t]/.test(text[start - 1])) {
        start -= 1;
      }

      let end = index + 3;
      while (end < text.length && /[ \t]/.test(text[end])) {
        end += 1;
      }

      if (start === 0 || end >= text.length) {
        continue;
      }

      parts.push({
        start,
        end,
        dashStart: index,
        dashEnd: index + 2,
      });
    }

    return parts;
  }

  function hasFreeMidSentenceDoubleDashViolation(text) {
    return getFreeMidSentenceDoubleDashParts(text).length > 0;
  }

  function hasUnicodeDashViolation(text) {
    if (typeof text !== "string") {
      return false;
    }

    UNICODE_DASH_PATTERN.lastIndex = 0;
    return UNICODE_DASH_PATTERN.test(text);
  }

  function hasSingleDashPunctuationViolation(text) {
    if (typeof text !== "string" || text.indexOf("-") === -1) {
      return false;
    }

    const pattern = /(?<!-)-[.,?!:;]/gu;
    let match;
    while ((match = pattern.exec(text))) {
      if (
        !isRangeInsideGenericTag(
          text,
          match.index,
          match.index + match[0].length,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  function normalizeIncorrectInterjectionForms(text) {
    if (typeof text !== "string" || !text) {
      return text;
    }

    let result = text;
    for (const correction of INTERJECTION_CORRECTIONS) {
      correction.pattern.lastIndex = 0;
      result = result.replace(
        correction.pattern,
        (_match, prefix, matchedVariant) => {
          const caseShape = getLetterCaseShape(matchedVariant);
          return prefix + applyLetterCaseShape(correction.canonical, caseShape);
        },
      );
    }

    return result;
  }

  function hasIncorrectInterjectionFormsViolation(text) {
    return (
      typeof text === "string" &&
      normalizeIncorrectInterjectionForms(text) !== text
    );
  }

  function hasHighlightedWordViolation(text) {
    return getHighlightedWordMatches(text).length > 0;
  }

  function hasTerminalPunctuationViolation(text) {
    if (typeof text !== "string") {
      return false;
    }

    const trimmed = normalizeUnicodeDoubleQuoteVariants(
      stripTrailingTagTokens(text),
    );
    if (!trimmed) {
      return false;
    }

    return !/(?:\.\.\.|--|[.,?!:;"-])$/.test(trimmed);
  }

  function isUppercaseLetter(char) {
    return (
      typeof char === "string" &&
      /[\p{L}]/u.test(char) &&
      char === char.toLocaleUpperCase() &&
      char !== char.toLocaleLowerCase()
    );
  }

  function isLowercaseLetter(char) {
    return (
      typeof char === "string" &&
      /[\p{L}]/u.test(char) &&
      char === char.toLocaleLowerCase() &&
      char !== char.toLocaleUpperCase()
    );
  }

  function findFirstLetterIndex(text, startIndex = 0) {
    if (typeof text !== "string") {
      return -1;
    }

    for (let index = Math.max(0, startIndex); index < text.length; index += 1) {
      if (/[\p{L}]/u.test(text[index])) {
        return index;
      }
    }

    return -1;
  }

  function skipLeadingCapitalizationTokens(text, startIndex = 0) {
    if (typeof text !== "string") {
      return startIndex;
    }

    let index = Math.max(0, startIndex);
    while (index < text.length) {
      const char = text[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }

      if (char === "[" || char === "{") {
        const closeChar = char === "[" ? "]" : "}";
        const closeIndex = text.indexOf(closeChar, index + 1);
        if (closeIndex === -1) {
          break;
        }

        index = closeIndex + 1;
        continue;
      }

      if (char === "<") {
        const closeIndex = text.indexOf(">", index + 1);
        if (closeIndex === -1) {
          break;
        }

        index = closeIndex + 1;
        continue;
      }

      break;
    }

    return index;
  }

  function getCapitalizationContentStart(text, startIndex = 0) {
    return skipLeadingCapitalizationTokens(text, startIndex);
  }

  function countPerf(name, detail) {
    try {
      window.__babelHelperPerf?.count?.(name, detail);
    } catch (_error) {
      // Perf counters must never break page-world bridge cleanup/restart paths.
    }
  }

  function startsWithNumericToken(text, startIndex = 0) {
    if (typeof text !== "string") {
      return false;
    }

    let index = Math.max(0, startIndex);
    while (index < text.length) {
      const nextIndex = skipLeadingCapitalizationTokens(text, index);
      if (nextIndex !== index) {
        index = nextIndex;
        continue;
      }

      const char = text[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }

      return /\p{N}/u.test(char);
    }

    return false;
  }

  function skipSentenceBoundaryTokens(text, startIndex = 0) {
    if (typeof text !== "string") {
      return startIndex;
    }

    let index = Math.max(0, startIndex);
    while (index < text.length) {
      const char = text[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }

      if (/["'“”«»„‟‘’()\u00BB\u201D\u2019]/u.test(char)) {
        index += 1;
        continue;
      }

      const nextIndex = skipLeadingCapitalizationTokens(text, index);
      if (nextIndex !== index) {
        index = nextIndex;
        continue;
      }

      break;
    }

    return index;
  }

  function stripTrailingTagTokens(text) {
    if (typeof text !== "string") {
      return "";
    }

    let result = text.trimEnd();
    while (result) {
      const lastChar = result[result.length - 1];
      if (lastChar === "]") {
        const openIndex = result.lastIndexOf("[");
        if (openIndex === -1) {
          break;
        }

        result = result.slice(0, openIndex).trimEnd();
        continue;
      }

      if (lastChar === "}") {
        const openIndex = result.lastIndexOf("{");
        if (openIndex === -1) {
          break;
        }

        result = result.slice(0, openIndex).trimEnd();
        continue;
      }

      if (lastChar === ">") {
        const openIndex = result.lastIndexOf("<");
        if (openIndex === -1) {
          break;
        }

        result = result.slice(0, openIndex).trimEnd();
        continue;
      }

      break;
    }

    return result;
  }

  function stripTrailingContinuationClosers(text) {
    if (typeof text !== "string") {
      return "";
    }

    let result = stripTrailingTagTokens(text);
    while (result) {
      const lastChar = result[result.length - 1];
      if (!/[\s"')\]\}\u00BB\u201D\u2019]/u.test(lastChar)) {
        break;
      }

      result = result.slice(0, -1).trimEnd();
    }

    return result;
  }

  function endsWithLowercaseContinuationMarker(text) {
    return /(?:\.\.\.|--)$/.test(stripTrailingContinuationClosers(text));
  }

  function previousSameSpeakerAllowsLowercase(annotationEntries, index) {
    const current = annotationEntries[index];
    if (!current || !current.speakerKey) {
      return false;
    }

    for (let pointer = index - 1; pointer >= 0; pointer -= 1) {
      const candidate = annotationEntries[pointer];
      if (!candidate || candidate.speakerKey !== current.speakerKey) {
        continue;
      }

      return endsWithLowercaseContinuationMarker(candidate.text);
    }

    return false;
  }

  function findSentenceBoundaryLowercaseIndices(text) {
    if (typeof text !== "string" || !text) {
      return [];
    }

    const indices = [];
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (!/[.?!]/.test(char)) {
        continue;
      }

      if (
        char === "." &&
        (text[index - 1] === "." || text[index + 1] === ".")
      ) {
        continue;
      }

      const directSpeechAuthorIndex =
        getRussianDirectSpeechAuthorContinuationLetterIndex(text, index);
      if (
        directSpeechAuthorIndex !== -1 &&
        isLowercaseLetter(text[directSpeechAuthorIndex])
      ) {
        continue;
      }

      const letterIndex = findFirstLetterIndex(
        text,
        skipSentenceBoundaryTokens(text, index + 1),
      );
      if (letterIndex === -1) {
        continue;
      }

      if (isLowercaseLetter(text[letterIndex])) {
        indices.push(letterIndex);
      }
    }

    return indices;
  }

  function getRussianDirectSpeechAuthorContinuationLetterIndex(
    text,
    boundaryIndex,
  ) {
    if (typeof text !== "string" || boundaryIndex < 0) {
      return -1;
    }

    if (!/[?!]/.test(text[boundaryIndex])) {
      return -1;
    }

    let index = boundaryIndex + 1;
    while (index < text.length && /[?!]/.test(text[index])) {
      index += 1;
    }

    const insideOpenQuote = isInsideOpenQuoteAt(text, boundaryIndex);
    while (index < text.length) {
      const char = text[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }

      if (/["\u00BB\u201D]/u.test(char)) {
        index += 1;
        break;
      }

      if (insideOpenQuote && char === "-") {
        break;
      }

      return -1;
    }

    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }

    if (text[index] !== "-") {
      return -1;
    }

    const authorStartIndex = skipLeadingCapitalizationTokens(text, index + 1);

    return findFirstLetterIndex(text, authorStartIndex);
  }

  function isInsideOpenQuoteAt(text, index) {
    if (typeof text !== "string" || index < 0) {
      return false;
    }

    const normalizedText = normalizeUnicodeDoubleQuoteVariants(text);
    let quoteCount = 0;
    for (let pointer = 0; pointer < index; pointer += 1) {
      if (normalizedText[pointer] === '"') {
        quoteCount += 1;
      }
    }

    return quoteCount % 2 === 1;
  }

  function hasDoubleDashOutsideQuoteOrGenericTagViolation(text) {
    if (typeof text !== "string" || text.indexOf("--") === -1) {
      return false;
    }

    let index = text.indexOf("--");
    while (index !== -1) {
      if (
        !isRangeInsideGenericTag(text, index, index + 2) &&
        !isInsideOpenQuoteAt(text, index)
      ) {
        return true;
      }

      index = text.indexOf("--", index + 2);
    }

    return false;
  }

  function hasSentenceBoundaryCapitalizationViolation(text) {
    return findSentenceBoundaryLowercaseIndices(text).length > 0;
  }

  function getEnclosingInlineTagRange(text, index) {
    return getEnclosingGenericTagRange(text, index);
  }

  function isInsideInlineTag(text, index) {
    return getEnclosingInlineTagRange(text, index) !== null;
  }

  function isInsidePairedInlineTagContent(text, index) {
    if (typeof text !== "string" || index < 0 || index >= text.length) {
      return false;
    }

    const before = text.slice(0, index);
    const openMatch = before.match(/<([A-Za-zА-Яа-яЁё0-9_-]+)>[^<>]*$/u);
    if (!openMatch) {
      return false;
    }

    const tagName = openMatch[1];
    const closePattern = new RegExp(
      `^([^<>]*?)<\\/${escapeRegExp(tagName)}>`,
      "u",
    );
    return closePattern.test(text.slice(index));
  }

  function skipBackwardIgnorableTokens(text, pointer) {
    let current = pointer;
    while (current >= 0) {
      while (current >= 0 && /\s/.test(text[current])) {
        current -= 1;
      }

      const tagRange = getEnclosingInlineTagRange(text, current);
      if (tagRange) {
        current = tagRange.start - 1;
        continue;
      }

      while (
        current >= 0 &&
        /["')\]\}\u00BB\u201D\u2019]/u.test(text[current])
      ) {
        current -= 1;
        while (current >= 0 && /\s/.test(text[current])) {
          current -= 1;
        }
      }

      const closingTagMatch = text.slice(0, current + 1).match(/<\/[^>]+>$/u);
      if (closingTagMatch) {
        current -= closingTagMatch[0].length;
        continue;
      }

      break;
    }

    return current;
  }

  function getPolitePronounCaseExpectation(text, tokenIndex) {
    if (typeof text !== "string" || tokenIndex < 0) {
      return "neutral";
    }

    if (
      isInsideInlineTag(text, tokenIndex) ||
      isInsidePairedInlineTagContent(text, tokenIndex)
    ) {
      return "neutral";
    }

    const firstLetterIndex = findFirstLetterIndex(
      text,
      skipLeadingCapitalizationTokens(text),
    );
    if (firstLetterIndex !== -1 && tokenIndex === firstLetterIndex) {
      return "neutral";
    }

    let pointer = skipBackwardIgnorableTokens(text, tokenIndex - 1);

    if (pointer < 0) {
      return "neutral";
    }

    if (text.slice(0, pointer + 1).endsWith("...")) {
      return "neutral";
    }

    if (pointer >= 1 && text[pointer] === "-" && text[pointer - 1] === "-") {
      return "neutral";
    }

    if (text[pointer] === "-") {
      return "neutral";
    }

    if (/[.?!:]/.test(text[pointer])) {
      return "neutral";
    }

    return "lower";
  }

  function getPolitePronounTargetToken(text, tokenIndex, token) {
    const normalizedToken = (token || "").toLocaleLowerCase();
    const expectation = getPolitePronounCaseExpectation(text, tokenIndex);

    if (expectation === "lower") {
      return normalizedToken;
    }

    return token;
  }

  function hasPolitePronounCaseViolation(text) {
    if (typeof text !== "string" || !text) {
      return false;
    }

    POLITE_PRONOUN_PATTERN.lastIndex = 0;
    let match;
    while ((match = POLITE_PRONOUN_PATTERN.exec(text))) {
      const prefix = match[1] || "";
      const token = match[2] || "";
      const tokenIndex = match.index + prefix.length;
      const targetToken = getPolitePronounTargetToken(text, tokenIndex, token);
      if (token && targetToken && token !== targetToken) {
        return true;
      }
    }

    return false;
  }

  function hasSegmentStartCapitalizationViolation(
    entry,
    annotationEntries,
    index,
  ) {
    if (!entry || typeof entry.text !== "string") {
      return false;
    }

    const trimmed = entry.text.trim();
    if (!trimmed) {
      return false;
    }

    const contentStartIndex = getCapitalizationContentStart(trimmed);
    if (trimmed.startsWith("...", contentStartIndex)) {
      if (startsWithNumericToken(trimmed, contentStartIndex + 3)) {
        return false;
      }

      const ellipsisLetterIndex = findFirstLetterIndex(
        trimmed,
        getCapitalizationContentStart(trimmed, contentStartIndex + 3),
      );
      if (ellipsisLetterIndex === -1) {
        return false;
      }

      return isUppercaseLetter(trimmed[ellipsisLetterIndex]);
    }

    const firstLetterIndex = findFirstLetterIndex(trimmed, contentStartIndex);
    if (firstLetterIndex === -1) {
      return false;
    }

    if (!isLowercaseLetter(trimmed[firstLetterIndex])) {
      return false;
    }

    return !previousSameSpeakerAllowsLowercase(annotationEntries, index);
  }

  function clampTextRange(text, start, end) {
    if (
      typeof text !== "string" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      return null;
    }

    const clampedStart = Math.max(0, Math.min(text.length, start));
    const clampedEnd = Math.max(clampedStart, Math.min(text.length, end));
    if (clampedEnd <= clampedStart) {
      return null;
    }

    return {
      start: clampedStart,
      end: clampedEnd,
      text: text.slice(clampedStart, clampedEnd),
    };
  }

  function compactMatches(matches) {
    if (!Array.isArray(matches) || !matches.length) {
      return [];
    }

    const seen = new Set();
    const compacted = [];
    for (const match of matches) {
      if (
        !match ||
        typeof match.text !== "string" ||
        !match.text ||
        !Number.isFinite(match.start) ||
        !Number.isFinite(match.end)
      ) {
        continue;
      }

      const key = `${match.start}\u0000${match.end}\u0000${match.text}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      compacted.push(match);
    }

    return compacted.slice(0, 8);
  }

  function collectRegexMatches(text, pattern, groupIndex = 0) {
    if (typeof text !== "string" || !pattern) {
      return [];
    }

    pattern.lastIndex = 0;
    const matches = [];
    let match;
    while ((match = pattern.exec(text))) {
      const token = match[groupIndex] || match[0] || "";
      if (token) {
        const tokenOffset = groupIndex > 0 ? match[0].indexOf(token) : 0;
        const start = match.index + Math.max(0, tokenOffset);
        const range = clampTextRange(text, start, start + token.length);
        if (range) {
          matches.push(range);
        }
      }

      if (match[0] === "") {
        pattern.lastIndex += 1;
      }
    }

    return compactMatches(matches);
  }

  function collectRegexMatchesOutsideGenericTags(
    text,
    pattern,
    groupIndex = 0,
    textContext = createTranscriptTextContext(text),
  ) {
    return collectRegexMatches(text, pattern, groupIndex).filter(
      (match) => !textContext.isRangeInsideGenericTag(match.start, match.end),
    );
  }

  function getUnicodeQuoteMatches(text) {
    return collectRegexMatches(text, UNICODE_DOUBLE_QUOTE_PATTERN);
  }

  function getUnicodeDashMatches(text) {
    return collectRegexMatches(text, UNICODE_DASH_PATTERN);
  }

  function getDoubleDashPunctuationMatches(text, textContext) {
    return collectRegexMatchesOutsideGenericTags(
      text,
      /--[.,?!:;]+/gu,
      0,
      textContext,
    );
  }

  function getFreeMidSentenceDoubleDashMatches(text, textContext) {
    return compactMatches(
      getFreeMidSentenceDoubleDashParts(text, textContext)
        .map((part) => clampTextRange(text, part.dashStart, part.dashEnd))
        .filter(Boolean),
    );
  }

  function getSingleDashPunctuationMatches(text, textContext) {
    return collectRegexMatchesOutsideGenericTags(
      text,
      /(?<!-)-[.,?!:;]+/gu,
      0,
      textContext,
    );
  }

  function getCommaBeforeDashParts(
    text,
    textContext = createTranscriptTextContext(text),
  ) {
    if (
      typeof text !== "string" ||
      text.indexOf(",") === -1 ||
      text.indexOf("-") === -1
    ) {
      return [];
    }

    const parts = [];
    for (
      let commaStart = text.indexOf(",");
      commaStart !== -1;
      commaStart = text.indexOf(",", commaStart + 1)
    ) {
      if (!hasNonTagTextBeforeCurlyTag(text, commaStart)) {
        continue;
      }

      let dashStart = commaStart + 1;
      while (dashStart < text.length && /[ \t]/.test(text[dashStart])) {
        dashStart += 1;
      }

      if (text[dashStart] !== "-") {
        continue;
      }

      const dashEnd =
        text[dashStart + 1] === "-" ? dashStart + 2 : dashStart + 1;
      if (text[dashEnd] === "-" || !/[ \t]/.test(text[dashEnd] || "")) {
        continue;
      }

      let nextIndex = dashEnd;
      while (nextIndex < text.length && /[ \t]/.test(text[nextIndex])) {
        nextIndex += 1;
      }

      if (
        nextIndex >= text.length ||
        textContext.isRangeInsideGenericTag(commaStart, dashEnd)
      ) {
        continue;
      }

      parts.push({ commaStart, dashStart });
    }

    return parts;
  }

  function getCommaBeforeDashMatches(text, textContext) {
    return compactMatches(
      getCommaBeforeDashParts(text, textContext)
        .map((part) => clampTextRange(text, part.commaStart, part.dashStart))
        .filter(Boolean),
    );
  }

  function getIncorrectInterjectionFormMatches(text) {
    return compactMatches(
      INTERJECTION_CORRECTIONS.flatMap((correction) =>
        collectRegexMatches(text, correction.pattern, 2),
      ),
    );
  }

  function getHighlightedWordPattern(word) {
    const escaped = escapeRegExp(word).replace(/\s+/g, "\\s+");
    return new RegExp(
      `(?<![\\p{L}\\p{N}\\p{M}_])${escaped}(?![\\p{L}\\p{N}\\p{M}_])`,
      "giu",
    );
  }

  function getHighlightedWordMatches(
    text,
    textContext = createTranscriptTextContext(text),
  ) {
    if (!highlightedWordsEnabled || !highlightedWords.length) {
      return [];
    }

    return compactMatches(
      highlightedWords.flatMap((word) =>
        collectRegexMatchesOutsideGenericTags(
          text,
          getHighlightedWordPattern(word),
          0,
          textContext,
        ),
      ),
    );
  }

  function getHighlightedWordClearanceKey(entry) {
    if (!entry || typeof entry.text !== "string") {
      return "";
    }

    const matchSignature = getHighlightedWordMatches(entry.text)
      .map(
        (match) =>
          `${match.start}:${match.end}:${String(match.text || "").toLocaleLowerCase()}`,
      )
      .join("|");
    if (!matchSignature) {
      return "";
    }

    return [
      getRouteKey(),
      entry.reviewActionId || "",
      entry.annotationId || "",
      entry.text,
      matchSignature,
    ].join("\u0000");
  }

  function getHighlightedWordClearanceTaskKey(entry) {
    return (entry && entry.reviewActionId) || getRouteKey() || "";
  }

  function loadHighlightedWordClearances(entry) {
    const taskKey = getHighlightedWordClearanceTaskKey(entry);
    if (
      highlightedWordClearancesLoaded &&
      highlightedWordClearanceTaskKey === taskKey
    ) {
      return;
    }

    highlightedWordClearancesLoaded = true;
    highlightedWordClearanceTaskKey = taskKey;
    clearedHighlightedWordKeys.clear();
    try {
      const raw = window.localStorage.getItem(
        HIGHLIGHTED_WORD_CLEARANCE_STORAGE_KEY,
      );
      const parsed = safeJsonParse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.taskKey === taskKey &&
        Array.isArray(parsed.keys)
      ) {
        parsed.keys
          .filter((key) => typeof key === "string" && key)
          .slice(-1000)
          .forEach((key) => clearedHighlightedWordKeys.add(key));
      } else if (raw) {
        persistHighlightedWordClearances();
      }
    } catch (_error) {
      // localStorage can be blocked; in-memory clearance still works.
    }
  }

  function persistHighlightedWordClearances() {
    try {
      const keys = Array.from(clearedHighlightedWordKeys).slice(-1000);
      window.localStorage.setItem(
        HIGHLIGHTED_WORD_CLEARANCE_STORAGE_KEY,
        JSON.stringify({
          taskKey: highlightedWordClearanceTaskKey || getRouteKey() || "",
          keys,
        }),
      );
    } catch (_error) {
      // Ignore storage quota/privacy failures.
    }
  }

  function isHighlightedWordCleared(entry) {
    loadHighlightedWordClearances(entry);
    const key = getHighlightedWordClearanceKey(entry);
    return Boolean(key && clearedHighlightedWordKeys.has(key));
  }

  function markHighlightedWordCleared(entry) {
    loadHighlightedWordClearances(entry);
    const key = getHighlightedWordClearanceKey(entry);
    if (!key || clearedHighlightedWordKeys.has(key)) {
      return false;
    }

    clearedHighlightedWordKeys.add(key);
    persistHighlightedWordClearances();
    return true;
  }

  function unmarkHighlightedWordCleared(entry) {
    loadHighlightedWordClearances(entry);
    const key = getHighlightedWordClearanceKey(entry);
    if (!key || !clearedHighlightedWordKeys.has(key)) {
      return false;
    }

    clearedHighlightedWordKeys.delete(key);
    persistHighlightedWordClearances();
    return true;
  }

  function ensureHelperAssertedWarning(entry, target) {
    if (
      !entry ||
      !target ||
      typeof target !== "object" ||
      !hasHighlightedWordViolation(entry.text) ||
      !isHighlightedWordCleared(entry)
    ) {
      return false;
    }

    const metadata =
      target.metadata && typeof target.metadata === "object"
        ? target.metadata
        : {};
    const assertedWarnings = Array.isArray(metadata.assertedWarnings)
      ? metadata.assertedWarnings
      : [];
    if (assertedWarnings.includes(HIGHLIGHTED_WORD_RULE_REASON)) {
      return false;
    }

    if (metadata !== target.metadata) {
      target.metadata = metadata;
    }
    metadata.assertedWarnings = assertedWarnings.concat(
      HIGHLIGHTED_WORD_RULE_REASON,
    );
    return true;
  }

  function applyHighlightedWordClearancesToPayload(root) {
    if (!root || typeof root !== "object") {
      return false;
    }

    const seen = new Set();
    let changed = false;

    function visit(value, inheritedReviewActionId = "") {
      if (!value || typeof value !== "object" || seen.has(value)) {
        return;
      }

      seen.add(value);

      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, inheritedReviewActionId));
        return;
      }

      const reviewActionId =
        readStringProp(value, ["reviewActionId", "actionId"]) ||
        inheritedReviewActionId;
      const entry = getAnnotationEntryFromObject(value, reviewActionId);
      if (entry && ensureHelperAssertedWarning(entry, value)) {
        changed = true;
      }

      Object.values(value).forEach((nested) => visit(nested, reviewActionId));
    }

    visit(root);
    return changed;
  }

  function getCommaSpacingMatches(text) {
    return collectRegexMatches(text, /\s+,|,(?![\d ]|$)|, {2,}/gu);
  }

  function getPeriodSpacingMatches(text) {
    return compactMatches(
      getPeriodSpacingParts(text)
        .map((part) => clampTextRange(text, part.start, part.end))
        .filter(Boolean),
    );
  }

  function getLeadingTrailingSpaceMatches(text) {
    if (typeof text !== "string" || !text) {
      return [];
    }

    const matches = [];
    const leadingMatch = text.match(/^[ \t]+/);
    if (leadingMatch) {
      matches.push(clampTextRange(text, 0, leadingMatch[0].length));
    }

    const trailingMatch = text.match(/[ \t]+$/);
    if (trailingMatch) {
      matches.push(
        clampTextRange(
          text,
          text.length - trailingMatch[0].length,
          text.length,
        ),
      );
    }

    return compactMatches(matches.filter(Boolean));
  }

  function getDoubleSpaceMatches(text) {
    return collectRegexMatches(text, /(\S)( {2,})(?=\S)/gu, 2);
  }

  function getUnbalancedDoubleQuoteMatches(text) {
    const indices = getQuoteIndices(normalizeUnicodeDoubleQuoteVariants(text));
    return compactMatches(
      indices
        .map((index) => clampTextRange(text, index, index + 1))
        .filter(Boolean),
    );
  }

  function getCurlySpacingMatches(text) {
    if (typeof text !== "string") {
      return [];
    }

    const matches = [];
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
        matches.push(clampTextRange(text, index, index + 1));
        continue;
      }

      const openIndex = stack.pop();
      const prevChar = openIndex > 0 ? text[openIndex - 1] : "";
      const nextCharAfterOpen =
        openIndex + 1 < text.length ? text[openIndex + 1] : "";
      const prevCharBeforeClose = index > 0 ? text[index - 1] : "";
      const nextChar = index + 1 < text.length ? text[index + 1] : "";

      if (/\s/.test(nextCharAfterOpen) || isWordCharacter(prevChar)) {
        matches.push(
          clampTextRange(text, Math.max(0, openIndex - 1), openIndex + 2),
        );
      }

      if (/\s/.test(prevCharBeforeClose) || isWordCharacter(nextChar)) {
        matches.push(
          clampTextRange(
            text,
            Math.max(0, index - 1),
            Math.min(text.length, index + 2),
          ),
        );
      }
    }

    for (const openIndex of stack) {
      matches.push(clampTextRange(text, openIndex, openIndex + 1));
    }

    return compactMatches(matches.filter(Boolean));
  }

  function normalizeAngleTagText(text) {
    if (typeof text !== "string" || text.length < 2) {
      return text;
    }

    const inner = text
      .slice(1, -1)
      .trim()
      .replace(/^\/\s+/u, "/");
    return `<${inner}>`;
  }

  function normalizeSquareBracketTagText(text) {
    if (typeof text !== "string" || text.length < 2) {
      return text;
    }

    const inner = text
      .slice(1, -1)
      .trim()
      .replace(/^\/\s+/u, "/");
    return `[${inner}]`;
  }

  function getAngleTagSpacingParts(text) {
    if (typeof text !== "string" || text.indexOf("<") === -1) {
      return [];
    }

    const parts = [];
    const tagPattern = /<[^<>\r\n]*>/gu;
    let match;
    while ((match = tagPattern.exec(text))) {
      const tag = match[0];
      const start = match.index;
      const end = tagPattern.lastIndex;
      const prevChar = start > 0 ? text[start - 1] : "";
      const nextChar = end < text.length ? text[end] : "";
      if (
        normalizeAngleTagText(tag) !== tag ||
        (prevChar && !/\s/.test(prevChar)) ||
        (nextChar && !/\s/.test(nextChar))
      ) {
        parts.push({ start, end });
      }
    }

    return parts;
  }

  function hasAngleTagSpacingViolation(text) {
    return getAngleTagSpacingParts(text).length > 0;
  }

  function getAngleTagSpacingMatches(text) {
    return compactMatches(
      getAngleTagSpacingParts(text)
        .map((part) => clampTextRange(text, part.start, part.end))
        .filter(Boolean),
    );
  }

  function getSquareBracketTagSpacingParts(text) {
    if (typeof text !== "string" || text.indexOf("[") === -1) {
      return [];
    }

    const parts = [];
    const tagPattern = /\[[^[\]\r\n]*\]/gu;
    let match;
    while ((match = tagPattern.exec(text))) {
      const tag = match[0];
      const start = match.index;
      const end = tagPattern.lastIndex;
      const prevChar = start > 0 ? text[start - 1] : "";
      const nextChar = end < text.length ? text[end] : "";
      if (
        normalizeSquareBracketTagText(tag) !== tag ||
        (prevChar && !/\s/.test(prevChar)) ||
        (nextChar && !/\s/.test(nextChar))
      ) {
        parts.push({ start, end });
      }
    }

    return parts;
  }

  function getSquareBracketTagSpacingMatches(text) {
    return compactMatches(
      getSquareBracketTagSpacingParts(text)
        .map((part) => clampTextRange(text, part.start, part.end))
        .filter(Boolean),
    );
  }

  function isCurlyTagTrailingPunctuationChar(char) {
    return typeof char === "string" && /[.,?!:;"]/.test(char);
  }

  function isSquareBracketTagTrailingPunctuationChar(char) {
    return typeof char === "string" && /[.,?!:;-]/.test(char);
  }

  function hasNonTagTextBeforeCurlyTag(text, openIndex) {
    if (typeof text !== "string" || openIndex <= 0) {
      return false;
    }

    const visibleBefore = text
      .slice(0, openIndex)
      .replace(/\{[^{}\r\n]*\}|\[[^[\]\r\n]*\]|<[^<>\r\n]*>/gu, "");
    return /[\p{L}\p{N}]/u.test(visibleBefore);
  }

  function hasNonTagTextAfterAngleTag(text, tagEnd) {
    if (typeof text !== "string" || tagEnd >= text.length) {
      return false;
    }

    const visibleAfter = text
      .slice(tagEnd)
      .replace(/\{[^{}\r\n]*\}|\[[^[\]\r\n]*\]|<[^<>\r\n]*>/gu, "");
    return /[\p{L}\p{N}]/u.test(visibleAfter);
  }

  function getCurlyTagTrailingPunctuationParts(text) {
    if (typeof text !== "string" || text.indexOf("}") === -1) {
      return [];
    }

    const parts = [];
    const tagPattern = /\{[^{}\r\n]*\}/gu;
    let match;
    while ((match = tagPattern.exec(text))) {
      const openIndex = match.index;
      const tagEnd = tagPattern.lastIndex;
      if (!hasNonTagTextBeforeCurlyTag(text, openIndex)) {
        continue;
      }

      let punctuationStart = tagEnd;
      while (
        punctuationStart < text.length &&
        /[ \t]/.test(text[punctuationStart])
      ) {
        punctuationStart += 1;
      }

      let punctuationEnd = punctuationStart;
      while (
        punctuationEnd < text.length &&
        isCurlyTagTrailingPunctuationChar(text[punctuationEnd])
      ) {
        punctuationEnd += 1;
      }

      if (punctuationEnd > punctuationStart) {
        parts.push({
          openIndex,
          tagEnd,
          punctuationStart,
          punctuationEnd,
        });
      }
    }

    return parts;
  }

  function getCurlyTagTrailingPunctuationMatches(text) {
    return compactMatches(
      getCurlyTagTrailingPunctuationParts(text)
        .map((part) =>
          clampTextRange(text, part.punctuationStart, part.punctuationEnd),
        )
        .filter(Boolean),
    );
  }

  function getSquareBracketTagTrailingPunctuationParts(text) {
    if (typeof text !== "string" || text.indexOf("]") === -1) {
      return [];
    }

    const parts = [];
    const tagPattern = /\[[^[\]\r\n]*\]/gu;
    let match;
    while ((match = tagPattern.exec(text))) {
      const openIndex = match.index;
      const tagEnd = tagPattern.lastIndex;
      if (!hasNonTagTextBeforeCurlyTag(text, openIndex)) {
        continue;
      }

      let punctuationStart = tagEnd;
      while (
        punctuationStart < text.length &&
        /[ \t]/.test(text[punctuationStart])
      ) {
        punctuationStart += 1;
      }

      let punctuationEnd = punctuationStart;
      while (
        punctuationEnd < text.length &&
        isSquareBracketTagTrailingPunctuationChar(text[punctuationEnd])
      ) {
        punctuationEnd += 1;
      }

      if (punctuationEnd > punctuationStart) {
        parts.push({
          openIndex,
          tagEnd,
          punctuationStart,
          punctuationEnd,
        });
      }
    }

    return parts;
  }

  function getSquareBracketTagTrailingPunctuationMatches(text) {
    return compactMatches(
      getSquareBracketTagTrailingPunctuationParts(text)
        .map((part) =>
          clampTextRange(text, part.punctuationStart, part.punctuationEnd),
        )
        .filter(Boolean),
    );
  }

  function getAngleTagTrailingPunctuationParts(text) {
    if (typeof text !== "string" || text.indexOf("<") === -1) {
      return [];
    }

    const parts = [];
    const closingTagPattern = /<\/[^<>\r\n]*>/gu;
    let match;
    while ((match = closingTagPattern.exec(text))) {
      const tagStart = match.index;
      const tagEnd = closingTagPattern.lastIndex;
      if (!hasNonTagTextBeforeCurlyTag(text, tagStart)) {
        continue;
      }

      let punctuationStart = tagEnd;
      while (
        punctuationStart < text.length &&
        /[ \t]/.test(text[punctuationStart])
      ) {
        punctuationStart += 1;
      }

      let punctuationEnd = punctuationStart;
      while (
        punctuationEnd < text.length &&
        isCurlyTagTrailingPunctuationChar(text[punctuationEnd])
      ) {
        punctuationEnd += 1;
      }

      if (punctuationEnd > punctuationStart) {
        parts.push({
          kind: "closing",
          tagStart,
          tagEnd,
          punctuationStart,
          punctuationEnd,
        });
      }
    }

    const openingTagPattern = /<(?!\/)[^<>\r\n]*>/gu;
    while ((match = openingTagPattern.exec(text))) {
      const tagStart = match.index;
      const tagEnd = openingTagPattern.lastIndex;
      if (!hasNonTagTextAfterAngleTag(text, tagEnd)) {
        continue;
      }

      let punctuationEnd = tagStart;
      while (punctuationEnd > 0 && /[ \t]/.test(text[punctuationEnd - 1])) {
        punctuationEnd -= 1;
      }

      if (text[punctuationEnd - 1] !== '"') {
        continue;
      }

      let punctuationStart = punctuationEnd - 1;
      while (punctuationStart > 0 && text[punctuationStart - 1] === '"') {
        punctuationStart -= 1;
      }

      if (punctuationStart > 0 && !/[ \t]/.test(text[punctuationStart - 1])) {
        continue;
      }

      parts.push({
        kind: "opening",
        tagStart,
        tagEnd,
        punctuationStart,
        punctuationEnd,
      });
    }

    return parts.sort(
      (left, right) => left.punctuationStart - right.punctuationStart,
    );
  }

  function getAngleTagTrailingPunctuationMatches(text) {
    return compactMatches(
      getAngleTagTrailingPunctuationParts(text)
        .map((part) =>
          clampTextRange(text, part.punctuationStart, part.punctuationEnd),
        )
        .filter(Boolean),
    );
  }

  function getSentenceBoundaryCapitalizationMatches(text) {
    return compactMatches(
      findSentenceBoundaryLowercaseIndices(text)
        .map((index) => clampTextRange(text, index, index + 1))
        .filter(Boolean),
    );
  }

  function getPolitePronounCaseMatches(text) {
    if (typeof text !== "string" || !text) {
      return [];
    }

    const matches = [];
    POLITE_PRONOUN_PATTERN.lastIndex = 0;
    let match;
    while ((match = POLITE_PRONOUN_PATTERN.exec(text))) {
      const prefix = match[1] || "";
      const token = match[2] || "";
      const tokenIndex = match.index + prefix.length;
      const targetToken = getPolitePronounTargetToken(text, tokenIndex, token);
      if (token && targetToken && token !== targetToken) {
        matches.push(
          clampTextRange(text, tokenIndex, tokenIndex + token.length),
        );
      }
    }

    return compactMatches(matches.filter(Boolean));
  }

  function getTerminalPunctuationMatches(text) {
    if (typeof text !== "string") {
      return [];
    }

    const trimmed = stripTrailingTagTokens(text);
    if (!trimmed) {
      return [];
    }

    const end = trimmed.length;
    const start = Math.max(0, end - 1);
    return compactMatches([clampTextRange(text, start, end)].filter(Boolean));
  }

  function getSegmentStartCapitalizationMatches(entry) {
    if (!entry || typeof entry.text !== "string") {
      return [];
    }

    const text = entry.text;
    const leadingWhitespace = text.match(/^\s*/)?.[0].length || 0;
    const trimmed = text.trim();
    if (!trimmed) {
      return [];
    }

    const contentStartIndex = getCapitalizationContentStart(trimmed);
    if (trimmed.startsWith("...", contentStartIndex)) {
      const localIndex = findFirstLetterIndex(
        trimmed,
        getCapitalizationContentStart(trimmed, contentStartIndex + 3),
      );
      return compactMatches(
        [
          clampTextRange(
            text,
            leadingWhitespace + localIndex,
            leadingWhitespace + localIndex + 1,
          ),
        ].filter(Boolean),
      );
    }

    const localIndex = findFirstLetterIndex(trimmed, contentStartIndex);
    return compactMatches(
      [
        clampTextRange(
          text,
          leadingWhitespace + localIndex,
          leadingWhitespace + localIndex + 1,
        ),
      ].filter(Boolean),
    );
  }

  function getCustomLintRules() {
    return createCustomLinterRules({
      reasons: {
        nativeLeadingTrailingSpaces: NATIVE_LEADING_TRAILING_SPACES_REASON,
        nativeDoubleSpaces: NATIVE_DOUBLE_SPACES_REASON,
        comma: COMMA_RULE_REASON,
        periodSpacing: PERIOD_SPACING_RULE_REASON,
        quoteBalance: QUOTE_BALANCE_RULE_REASON,
        unicodeQuote: UNICODE_QUOTE_RULE_REASON,
        curlySpacing: CURLY_SPACING_RULE_REASON,
        angleTagSpacing: ANGLE_TAG_SPACING_RULE_REASON,
        squareBracketTagSpacing: SQUARE_BRACKET_TAG_SPACING_RULE_REASON,
        curlyTagTrailingPunctuation: CURLY_TAG_TRAILING_PUNCTUATION_RULE_REASON,
        angleTagTrailingPunctuation: ANGLE_TAG_TRAILING_PUNCTUATION_RULE_REASON,
        squareBracketTagTrailingPunctuation:
          SQUARE_BRACKET_TAG_TRAILING_PUNCTUATION_RULE_REASON,
        unicodeDash: UNICODE_DASH_RULE_REASON,
        commaBeforeDash: COMMA_BEFORE_DASH_RULE_REASON,
        freeMidSentenceDoubleDash: FREE_MID_SENTENCE_DOUBLE_DASH_RULE_REASON,
        doubleDashPunctuation: DOUBLE_DASH_PUNCTUATION_RULE_REASON,
        singleDashPunctuation: SINGLE_DASH_PUNCTUATION_RULE_REASON,
        incorrectInterjectionForms: INCORRECT_INTERJECTION_FORMS_RULE_REASON,
        highlightedWord: HIGHLIGHTED_WORD_RULE_REASON,
        sentenceBoundaryCapitalization:
          SENTENCE_BOUNDARY_CAPITALIZATION_RULE_REASON,
        politePronounCase: POLITE_PRONOUN_CASE_RULE_REASON,
        terminalPunctuation: TERMINAL_PUNCTUATION_RULE_REASON,
        segmentStartCapitalization: SEGMENT_START_CAPITALIZATION_RULE_REASON,
      },
      ruleSeverity: RULE_SEVERITY,
      highlightedWordRuleSeverity: HIGHLIGHTED_WORD_RULE_SEVERITY,
      getLeadingTrailingSpaceMatches,
      fixLeadingTrailingSpaces,
      getDoubleSpaceMatches,
      fixDoubleSpaces,
      getCommaSpacingMatches,
      fixCommaSpacing,
      getPeriodSpacingMatches,
      fixPeriodSpacing,
      hasUnbalancedDoubleQuotes,
      getUnbalancedDoubleQuoteMatches,
      getUnicodeQuoteMatches,
      fixUnicodeQuotes,
      hasCurlySpacingViolation,
      getCurlySpacingMatches,
      fixCurlySpacing,
      getAngleTagSpacingMatches,
      fixAngleTagSpacing,
      getSquareBracketTagSpacingMatches,
      fixSquareBracketTagSpacing,
      getCurlyTagTrailingPunctuationMatches,
      fixCurlyTagTrailingPunctuation,
      getAngleTagTrailingPunctuationMatches,
      fixAngleTagTrailingPunctuation,
      getSquareBracketTagTrailingPunctuationMatches,
      fixSquareBracketTagTrailingPunctuation,
      getUnicodeDashMatches,
      fixUnicodeDashes,
      getCommaBeforeDashMatches,
      fixCommaBeforeDash,
      getFreeMidSentenceDoubleDashMatches,
      fixFreeMidSentenceDoubleDash,
      getDoubleDashPunctuationMatches,
      fixDoubleDashPunctuation,
      getSingleDashPunctuationMatches,
      fixSingleDashPunctuation,
      getIncorrectInterjectionFormMatches,
      normalizeIncorrectInterjectionForms,
      getHighlightedWordMatches,
      getSentenceBoundaryCapitalizationMatches,
      fixSentenceBoundaryCapitalization,
      getPolitePronounCaseMatches,
      fixPolitePronounCase,
      hasTerminalPunctuationViolation,
      getTerminalPunctuationMatches,
      fixTerminalPunctuation,
      hasSegmentStartCapitalizationViolation,
      getSegmentStartCapitalizationMatches,
      fixSegmentStartCapitalization,
    });
  }

  function normalizeDisabledCustomLinterRuleIds(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const availableRuleIds = new Set(getCustomLintRules().map((rule) => rule.id));
    const disabledRuleIds = [];
    const seen = new Set();
    for (const id of value) {
      if (typeof id !== "string" || !availableRuleIds.has(id) || seen.has(id)) {
        continue;
      }

      seen.add(id);
      disabledRuleIds.push(id);
    }

    return disabledRuleIds;
  }

  function makeCustomIssue(entry, rule, matches) {
    return {
      annotationId: entry.annotationId,
      reviewActionId: entry.reviewActionId || "",
      reason: rule.reason,
      severity: rule.severity,
      babelHelper: {
        matches: compactMatches(matches),
        sourceText: typeof entry.text === "string" ? entry.text : "",
      },
    };
  }

  function recordCustomLinterRuleError(error, rule, entry) {
    const errors = Array.isArray(debugState.customRuleErrors)
      ? debugState.customRuleErrors
      : [];
    const details = {
      ruleId: rule && typeof rule.id === "string" ? rule.id : "",
      reason: rule && typeof rule.reason === "string" ? rule.reason : "",
      annotationId:
        entry && typeof entry.annotationId === "string"
          ? entry.annotationId
          : "",
      message: String(error && error.message ? error.message : error),
      recordedAt: Date.now(),
    };
    errors.push(details);
    debugState.customRuleErrors = errors.slice(-20);
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error("[Babel Helper] Custom linter rule failed", {
        ...details,
        error,
      });
    }
  }

  function buildCustomIssues(annotationEntries) {
    return buildRegistryIssues(
      annotationEntries,
      getCustomLintRules(),
      makeCustomIssue,
      {
        createTextContext: createTranscriptTextContext,
        disabledRuleIds: disabledCustomLinterRuleIds,
        onRuleError: recordCustomLinterRuleError,
      },
    );
  }

  function isHelperInjectedIssue(issue) {
    return Boolean(
      issue &&
      typeof issue === "object" &&
      issue.babelHelper &&
      typeof issue.babelHelper === "object",
    );
  }

  function getLintIssueKey(issue) {
    if (!isLintIssueLike(issue)) {
      return "";
    }

    return [
      issue.annotationId || "",
      issue.reason || "",
      issue.severity || "",
    ].join("\u0000");
  }

  function mergeNativeAndHelperIssues(nativeIssues, helperIssues) {
    const merged = [];
    const seen = new Set();
    for (const issue of Array.isArray(nativeIssues) ? nativeIssues : []) {
      if (!isLintIssueLike(issue) || isHelperInjectedIssue(issue)) {
        continue;
      }

      const key = getLintIssueKey(issue);
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(issue);
    }

    for (const issue of Array.isArray(helperIssues) ? helperIssues : []) {
      if (!isLintIssueLike(issue)) {
        continue;
      }

      const key = getLintIssueKey(issue);
      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(issue);
    }

    return merged;
  }

  function areLintIssueArraysEqual(left, right) {
    const leftItems = Array.isArray(left) ? left : [];
    const rightItems = Array.isArray(right) ? right : [];
    if (leftItems.length !== rightItems.length) {
      return false;
    }

    return leftItems.every((issue, index) => {
      const other = rightItems[index];
      if (getLintIssueKey(issue) !== getLintIssueKey(other)) {
        return false;
      }

      return isHelperInjectedIssue(issue) === isHelperInjectedIssue(other);
    });
  }

  function setCurrentNativeHelperIssues(
    annotationEntries,
    helperIssues,
    reason,
  ) {
    currentHighlightIssues = Array.isArray(helperIssues) ? helperIssues : [];
    if (currentHighlightIssues.length) {
      startHighlightObserver();
    }
    scheduleLinterHighlights();
    debugState.nativeLint = {
      changed: currentHighlightIssues.length > 0,
      reason,
      route: getRouteKey(),
      annotationCount: Array.isArray(annotationEntries)
        ? annotationEntries.length
        : 0,
      issueCount: currentHighlightIssues.length,
      syncedAt: Date.now(),
    };
  }

  function augmentNativeLintIssues(_linter, annotations, nativeIssues) {
    if (!enabled) {
      return nativeIssues;
    }

    const annotationEntries = extractAnnotationEntries(annotations);
    const helperIssues = buildCustomIssues(annotationEntries);
    setCurrentNativeHelperIssues(
      annotationEntries,
      helperIssues,
      "native-linter-augment",
    );
    return mergeNativeAndHelperIssues(nativeIssues, helperIssues);
  }

  window[NATIVE_LINT_AUGMENT_GLOBAL] = augmentNativeLintIssues;

  function patchNativeLinterModuleFactory(factory) {
    if (
      typeof factory !== "function" ||
      factory.__babelHelperNativeLinterPatched
    ) {
      return factory;
    }

    const source = Function.prototype.toString.call(factory);
    if (
      source.indexOf("class eR") === -1 ||
      source.indexOf("lintAnnotations(e)") === -1
    ) {
      return factory;
    }

    const needle =
      "if(i.length>0)for(let n of i){let a=n.implementation.call(this,e);t.push(...a.map(e=>({...e,severity:n.severity})))}return t}constructor";
    if (source.indexOf(needle) === -1) {
      debugState.nativeLintPatch = {
        changed: false,
        reason: "lint-annotations-needle-not-found",
        checkedAt: Date.now(),
      };
      return factory;
    }

    const replacement = `if(i.length>0)for(let n of i){let a=n.implementation.call(this,e);t.push(...a.map(e=>({...e,severity:n.severity})))}if("function"==typeof window["${NATIVE_LINT_AUGMENT_GLOBAL}"]){try{t=window["${NATIVE_LINT_AUGMENT_GLOBAL}"](this,e,t)||t}catch(e){}}return t}constructor`;
    try {
      const patched = (0, eval)(`(${source.replace(needle, replacement)})`);
      patched.__babelHelperNativeLinterPatched = true;
      patched.__babelHelperNativeLinterOriginal = factory;
      debugState.nativeLintPatch = {
        changed: true,
        reason: "module-factory",
        patchedAt: Date.now(),
      };
      return patched;
    } catch (error) {
      debugState.nativeLintPatch = {
        changed: false,
        reason: "module-factory-eval-failed",
        error: String(error && error.message ? error.message : error),
        checkedAt: Date.now(),
      };
      return factory;
    }
  }

  function patchWebpackChunkEntry(entry) {
    if (!Array.isArray(entry) || !entry[1] || typeof entry[1] !== "object") {
      return false;
    }

    let changed = false;
    for (const key of Object.keys(entry[1])) {
      const currentFactory = entry[1][key];
      const patchedFactory = patchNativeLinterModuleFactory(currentFactory);
      if (patchedFactory !== currentFactory) {
        entry[1][key] = patchedFactory;
        changed = true;
      }
    }
    return changed;
  }

  function installNativeLinterWebpackPatch() {
    const chunkName = "webpackChunk_N_E";
    const chunk = (window[chunkName] = window[chunkName] || []);
    if (!Array.isArray(chunk)) {
      return false;
    }

    for (const entry of chunk) {
      patchWebpackChunkEntry(entry);
    }

    if (chunk[NATIVE_LINT_PATCH_MARK]) {
      nativeLinterWebpackOriginalPush =
        nativeLinterWebpackOriginalPush ||
        chunk.push?.__babelHelperNativeLinterOriginalPush ||
        null;
      nativeLinterWebpackPatchInstalled = true;
      return false;
    }

    const originalPush =
      nativeLinterWebpackOriginalPush ||
      chunk.push.__babelHelperNativeLinterOriginalPush ||
      chunk.push;
    if (typeof originalPush !== "function") {
      return false;
    }

    const patchedPush = function babelHelperNativeLinterPatchedPush(
      ...entries
    ) {
      for (const entry of entries) {
        patchWebpackChunkEntry(entry);
      }
      return originalPush.apply(this, entries);
    };
    patchedPush.__babelHelperNativeLinterOriginalPush = originalPush;
    chunk.push = patchedPush;
    chunk[NATIVE_LINT_PATCH_MARK] = true;
    nativeLinterWebpackOriginalPush = originalPush;
    nativeLinterWebpackPatchInstalled = true;
    debugState.nativeLintPatch = {
      changed: true,
      reason: "webpack-push",
      patchedAt: Date.now(),
    };
    return true;
  }

  function getReactInternalValue(element, prefix) {
    if (
      !(element instanceof Element) ||
      typeof prefix !== "string" ||
      !prefix
    ) {
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

  function getNativeReviewSeedElement() {
    return (
      document.querySelector(ROW_TEXTAREA_SELECTOR) ||
      document.querySelector("tbody tr")
    );
  }

  function findNativeReviewFiber() {
    let current = getReactFiber(getNativeReviewSeedElement());
    while (current && typeof current === "object") {
      const props = current.memoizedProps || current.pendingProps || {};
      if (
        props &&
        typeof props === "object" &&
        typeof props.reviewActionId === "string" &&
        Array.isArray(props.annotations) &&
        Array.isArray(props.linterErrors)
      ) {
        return current;
      }

      current = current.return;
    }

    return null;
  }

  function isNativeAnnotationArray(value) {
    return (
      Array.isArray(value) &&
      value.some(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.content === "string" &&
          item.type === "transcription",
      )
    );
  }

  function getNativeReviewHooks(fiber) {
    let current = fiber && fiber.memoizedState;
    let index = 0;
    let annotationHook = null;
    while (current && typeof current === "object" && index < 120) {
      if (!annotationHook && isNativeAnnotationArray(current.memoizedState)) {
        annotationHook = { hook: current, index };
      } else if (
        annotationHook &&
        Array.isArray(current.memoizedState) &&
        current.queue &&
        typeof current.queue.dispatch === "function" &&
        !isNativeAnnotationArray(current.memoizedState)
      ) {
        return {
          annotationHook,
          lintHook: { hook: current, index },
        };
      }

      current = current.next;
      index += 1;
    }

    return null;
  }

  function augmentNativeLintDispatchValue(value, hooks, reason) {
    if (!Array.isArray(value) || !hooks || !hooks.annotationHook) {
      return value;
    }

    const annotations = hooks.annotationHook.hook.memoizedState;
    const annotationEntries = extractAnnotationEntries(annotations);
    if (!annotationEntries.length) {
      return value;
    }

    const helperIssues = buildCustomIssues(annotationEntries);
    const mergedIssues = mergeNativeAndHelperIssues(value, helperIssues);
    setCurrentNativeHelperIssues(annotationEntries, helperIssues, reason);
    debugState.nativeLintDispatch = {
      changed: !areLintIssueArraysEqual(value, mergedIssues),
      reason,
      route: getRouteKey(),
      nativeIssueCount: value.length,
      helperIssueCount: helperIssues.length,
      mergedIssueCount: mergedIssues.length,
      syncedAt: Date.now(),
    };
    return areLintIssueArraysEqual(value, mergedIssues) ? value : mergedIssues;
  }

  function recordNativeLintDispatchError(error, reason) {
    debugState.nativeLintDispatch = {
      changed: false,
      reason,
      route: getRouteKey(),
      error: String(error && error.message ? error.message : error),
      syncedAt: Date.now(),
    };
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error("[Babel Helper] Native lint dispatch augmentation failed", {
        reason,
        error,
      });
    }
  }

  function patchNativeLintDispatch(hooks, reason) {
    const queue = hooks && hooks.lintHook && hooks.lintHook.hook.queue;
    if (!queue || typeof queue.dispatch !== "function") {
      return false;
    }

    if (queue.dispatch.__babelHelperNativeLintDispatchPatched) {
      return true;
    }

    const originalDispatch =
      queue.dispatch.__babelHelperNativeLintDispatchOriginal || queue.dispatch;
    const patchedDispatch = function babelHelperNativeLintDispatch(action) {
      const resolveHooks = () =>
        getNativeReviewHooks(findNativeReviewFiber()) || hooks;

      if (typeof action === "function") {
        return originalDispatch.call(
          this,
          function babelHelperNativeLintDispatchUpdater(previousValue) {
            const nextValue = action(previousValue);
            try {
              return augmentNativeLintDispatchValue(
                nextValue,
                resolveHooks(),
                "native-lint-dispatch-updater",
              );
            } catch (error) {
              recordNativeLintDispatchError(
                error,
                "native-lint-dispatch-updater",
              );
              return nextValue;
            }
          },
        );
      }

      let nextAction = action;
      try {
        nextAction = augmentNativeLintDispatchValue(
          action,
          resolveHooks(),
          "native-lint-dispatch",
        );
      } catch (error) {
        recordNativeLintDispatchError(error, "native-lint-dispatch");
      }
      return originalDispatch.call(this, nextAction);
    };
    patchedDispatch.__babelHelperNativeLintDispatchPatched = true;
    patchedDispatch.__babelHelperNativeLintDispatchOriginal = originalDispatch;
    queue.dispatch = patchedDispatch;
    debugState.nativeLintDispatch = {
      changed: false,
      reason: `${reason}-dispatch-patched`,
      route: getRouteKey(),
      patchedAt: Date.now(),
    };
    return true;
  }

  function getNativeAnnotationEntriesFromState() {
    const hooks = getNativeReviewHooks(findNativeReviewFiber());
    if (!hooks || !hooks.annotationHook || !hooks.annotationHook.hook) {
      return [];
    }

    return extractAnnotationEntries(hooks.annotationHook.hook.memoizedState);
  }

  function syncNativeLintState(reason) {
    if (!enabled) {
      return false;
    }

    const fiber = findNativeReviewFiber();
    const hooks = getNativeReviewHooks(fiber);
    if (!hooks) {
      debugState.nativeLint = {
        changed: false,
        reason: "native-react-hooks-not-found",
        source: reason,
        route: getRouteKey(),
        syncedAt: Date.now(),
      };
      return false;
    }

    const dispatchPatched = patchNativeLintDispatch(hooks, reason);
    const annotations = hooks.annotationHook.hook.memoizedState;
    const nativeIssues = Array.isArray(
      hooks.lintHook.hook.queue.lastRenderedState,
    )
      ? hooks.lintHook.hook.queue.lastRenderedState
      : hooks.lintHook.hook.memoizedState;
    const annotationEntries = extractAnnotationEntries(annotations);
    const helperIssues = buildCustomIssues(annotationEntries);
    const mergedIssues = mergeNativeAndHelperIssues(nativeIssues, helperIssues);
    setCurrentNativeHelperIssues(annotationEntries, helperIssues, reason);

    if (!areLintIssueArraysEqual(nativeIssues, mergedIssues)) {
      hooks.lintHook.hook.queue.dispatch(mergedIssues);
      debugState.nativeLint.dispatched = true;
      debugState.nativeLint.nativeIssueCount = Array.isArray(nativeIssues)
        ? nativeIssues.length
        : 0;
      debugState.nativeLint.mergedIssueCount = mergedIssues.length;
      debugState.nativeLint.annotationHookIndex = hooks.annotationHook.index;
      debugState.nativeLint.lintHookIndex = hooks.lintHook.index;
      debugState.nativeLint.dispatchPatched = dispatchPatched;
      return true;
    }

    debugState.nativeLint.dispatched = false;
    debugState.nativeLint.nativeIssueCount = Array.isArray(nativeIssues)
      ? nativeIssues.length
      : 0;
    debugState.nativeLint.mergedIssueCount = mergedIssues.length;
    debugState.nativeLint.annotationHookIndex = hooks.annotationHook.index;
    debugState.nativeLint.lintHookIndex = hooks.lintHook.index;
    debugState.nativeLint.dispatchPatched = dispatchPatched;
    return false;
  }

  function scheduleNativeLintStateSync(reason) {
    if (!enabled) {
      return;
    }

    if (nativeLintStateTimer) {
      window.clearTimeout(nativeLintStateTimer);
    }

    nativeLintStateTimer = window.setTimeout(() => {
      nativeLintStateTimer = 0;
      syncNativeLintState(reason);
    }, NATIVE_LINT_STATE_SYNC_DELAY_MS);
  }

  function isLintIssueLike(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.annotationId === "string" &&
      typeof value.reason === "string" &&
      typeof value.severity === "string",
    );
  }

  function isDoubleDashOutsideQuoteOrTagReason(reason) {
    if (typeof reason !== "string") {
      return false;
    }

    const normalized = reason.toLocaleLowerCase();
    return (
      normalized.includes("double-dash-outside-quote-or-tag") ||
      (normalized.includes("double") &&
        normalized.includes("dash") &&
        normalized.includes("quote") &&
        normalized.includes("tag") &&
        (normalized.includes("outside") || normalized.includes("only")))
    );
  }

  function getDoubleDashOutsideQuoteOrTagSuppressionIds(annotationEntries) {
    const ids = new Set();
    if (!Array.isArray(annotationEntries)) {
      return ids;
    }

    for (const entry of annotationEntries) {
      if (
        entry &&
        typeof entry.annotationId === "string" &&
        typeof entry.text === "string" &&
        entry.text.indexOf("--") !== -1 &&
        !hasDoubleDashOutsideQuoteOrGenericTagViolation(entry.text)
      ) {
        ids.add(entry.annotationId);
      }
    }

    return ids;
  }

  function removeSuppressedIssuesFromArray(target, shouldSuppressIssue) {
    if (!Array.isArray(target) || typeof shouldSuppressIssue !== "function") {
      return false;
    }

    let changed = false;
    for (let index = target.length - 1; index >= 0; index -= 1) {
      const issue = target[index];
      if (isLintIssueLike(issue) && shouldSuppressIssue(issue)) {
        target.splice(index, 1);
        changed = true;
      }
    }

    return changed;
  }

  function filterSuppressedIssuesInPayload(root, shouldSuppressIssue) {
    if (
      !root ||
      typeof root !== "object" ||
      typeof shouldSuppressIssue !== "function"
    ) {
      return false;
    }

    const queue = [root];
    const seen = new Set();
    let changed = false;
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) {
        continue;
      }

      seen.add(current);

      if (Array.isArray(current)) {
        if (removeSuppressedIssuesFromArray(current, shouldSuppressIssue)) {
          changed = true;
        }

        for (const item of current) {
          if (item && typeof item === "object") {
            queue.push(item);
          }
        }
        continue;
      }

      for (const nested of Object.values(current)) {
        if (nested && typeof nested === "object") {
          queue.push(nested);
        }
      }
    }

    return changed;
  }

  function appendIssuesToArray(target, additionalIssues) {
    if (
      !Array.isArray(target) ||
      !Array.isArray(additionalIssues) ||
      !additionalIssues.length
    ) {
      return false;
    }

    const existing = new Set();
    for (const item of target) {
      if (!isLintIssueLike(item)) {
        continue;
      }

      existing.add(
        item.annotationId + "\u0000" + item.reason + "\u0000" + item.severity,
      );
    }

    let appended = 0;
    for (const issue of additionalIssues) {
      const key =
        issue.annotationId +
        "\u0000" +
        issue.reason +
        "\u0000" +
        issue.severity;
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

      const candidate =
        value.result && value.result.data && value.result.data.json;
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
    const seen = new Set();
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

  function rewriteJsonPayload(payload, additionalIssues, shouldSuppressIssue) {
    const filtered = filterSuppressedIssuesInPayload(
      payload,
      shouldSuppressIssue,
    );
    const appended = augmentJsonPayload(payload, additionalIssues);
    return filtered || appended;
  }

  function rewriteIssuesInCompactJsonlFrame(
    payload,
    additionalIssues,
    shouldSuppressIssue,
  ) {
    if (!payload || typeof payload !== "object") {
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

      if (removeSuppressedIssuesFromArray(candidate, shouldSuppressIssue)) {
        changed = true;
      }

      if (appendIssuesToArray(candidate, additionalIssues)) {
        changed = true;
      }
    }

    return changed;
  }

  function getHighlightColor(index, total) {
    const count = Math.max(1, total || 1);
    const hue = Math.round((index * 360) / count) % 360;
    return `hsl(${hue} 82% 46% / 0.2)`;
  }

  function ensureHighlightStyle() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
[${HIGHLIGHT_MARK_ATTR}] {
  border-radius: 2px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  color: inherit;
  padding: 0 1px;
}
[${HIGHLIGHT_OVERLAY_ATTR}] {
  color: transparent;
  pointer-events: none;
  position: absolute;
  z-index: 2;
}
[${HIGHLIGHT_OVERLAY_ATTR}] [${HIGHLIGHT_MARK_ATTR}] {
  color: transparent;
}
[${HIGHLIGHT_SWATCH_ATTR}] {
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
  height: 10px;
  pointer-events: none;
  position: absolute;
  width: 10px;
  z-index: 3;
}
[${HIGHLIGHT_PREVIEW_ATTR}] {
  display: block;
  margin-top: 4px;
  line-height: 1.35;
  max-width: min(760px, 80vw);
  white-space: normal;
}
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeHighlightStyle() {
    const style = document.getElementById(HIGHLIGHT_STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  function unwrapHighlightMarks(root = document) {
    const marks = root.querySelectorAll
      ? root.querySelectorAll(`[${HIGHLIGHT_MARK_ATTR}]`)
      : [];
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) {
        continue;
      }

      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    }

    const previews = root.querySelectorAll
      ? root.querySelectorAll(`[${HIGHLIGHT_PREVIEW_ATTR}]`)
      : [];
    for (const preview of previews) {
      preview.remove();
    }

    const overlays = root.querySelectorAll
      ? root.querySelectorAll(`[${HIGHLIGHT_OVERLAY_ATTR}]`)
      : [];
    for (const overlay of overlays) {
      overlay.remove();
    }

    const swatches = root.querySelectorAll
      ? root.querySelectorAll(`[${HIGHLIGHT_SWATCH_ATTR}]`)
      : [];
    for (const swatch of swatches) {
      swatch.remove();
    }
  }

  function isHighlightableTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.nodeValue) {
      return false;
    }

    const parent = node.parentElement;
    if (!parent) {
      return false;
    }

    if (
      parent.closest(
        "script, style, textarea, input, select, option, mark, [" +
          HIGHLIGHT_MARK_ATTR +
          "]",
      )
    ) {
      return false;
    }

    return true;
  }

  function highlightTextInElement(root, token, color) {
    if (!(root instanceof HTMLElement) || typeof token !== "string" || !token) {
      return false;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      if (isHighlightableTextNode(walker.currentNode)) {
        textNodes.push(walker.currentNode);
      }
    }

    let changed = false;
    for (const node of textNodes) {
      const text = node.nodeValue || "";
      const index = text.indexOf(token);
      if (index === -1) {
        continue;
      }

      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + token.length);
      const mark = document.createElement("mark");
      mark.setAttribute(HIGHLIGHT_MARK_ATTR, "true");
      mark.style.backgroundColor = color;
      range.surroundContents(mark);
      changed = true;
    }

    return changed;
  }

  function normalizeIssueHighlightRange(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const start = Number(value.start);
    const end = Number(value.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    const range = {
      start,
      end,
    };
    if (typeof value.text === "string" && value.text) {
      range.text = value.text;
    }

    return range;
  }

  function compactHighlightRanges(ranges) {
    if (!Array.isArray(ranges) || !ranges.length) {
      return [];
    }

    const seen = new Set();
    const compacted = [];
    for (const range of ranges) {
      const normalized = normalizeIssueHighlightRange(range);
      if (!normalized) {
        continue;
      }

      const key = `${normalized.start}\u0000${normalized.end}\u0000${normalized.text || ""}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      compacted.push(normalized);
    }

    return compacted.slice(0, 8);
  }

  function getIssueRangeCandidates(issue) {
    if (!issue || typeof issue !== "object") {
      return [];
    }

    const helper =
      issue.babelHelper && typeof issue.babelHelper === "object"
        ? issue.babelHelper
        : {};
    const candidates = [];
    for (const source of [
      helper.matches,
      helper.ranges,
      issue.matches,
      issue.ranges,
    ]) {
      if (Array.isArray(source)) {
        candidates.push(...source);
      }
    }

    candidates.push(issue);
    return candidates;
  }

  function getIssueSourceText(issue) {
    const helper =
      issue && issue.babelHelper && typeof issue.babelHelper === "object"
        ? issue.babelHelper
        : null;
    return helper && typeof helper.sourceText === "string"
      ? helper.sourceText
      : "";
  }

  function getIssueHighlightEntries(issues, rowText = "") {
    if (!Array.isArray(issues)) {
      return [];
    }

    return issues
      .map((issue) => {
        const sourceText = getIssueSourceText(issue);
        if (rowText && sourceText && sourceText !== rowText) {
          return null;
        }

        const ranges = compactHighlightRanges(getIssueRangeCandidates(issue));
        return {
          reason: issue && typeof issue.reason === "string" ? issue.reason : "",
          matches: ranges.map((range) => range.text || "").filter(Boolean),
          ranges,
        };
      })
      .filter(
        (entry) =>
          entry &&
          entry.reason &&
          (entry.matches.length || entry.ranges.length),
      );
  }

  function getHoveredRowText() {
    const row =
      highlightedRow instanceof HTMLTableRowElement ? highlightedRow : null;
    if (!row) {
      return "";
    }

    const textarea = row.querySelector(ROW_TEXTAREA_SELECTOR);
    if (textarea instanceof HTMLTextAreaElement) {
      return textarea.value || "";
    }

    return row.innerText || "";
  }

  function getHighlightRuleKey(reason) {
    if (typeof reason !== "string") {
      return "";
    }

    if (
      reason === NATIVE_LEADING_TRAILING_SPACES_REASON ||
      reason.includes("Extra spaces at the end or beginning")
    ) {
      return "native-leading-trailing-spaces";
    }

    if (
      reason === NATIVE_DOUBLE_SPACES_REASON ||
      reason.includes("Double spaces") ||
      reason.includes("double spaces")
    ) {
      return "native-double-spaces";
    }

    if (
      reason === POLITE_PRONOUN_CASE_RULE_REASON ||
      reason.includes("Russian polite pronouns") ||
      reason.includes("must be lowercase mid-sentence")
    ) {
      return "polite-pronoun-case";
    }

    if (
      reason === COMMA_RULE_REASON ||
      reason.includes("Commas must be formatted")
    ) {
      return "comma-spacing";
    }

    if (
      reason === SENTENCE_BOUNDARY_CAPITALIZATION_RULE_REASON ||
      reason.includes("Words after clear sentence endings") ||
      reason.includes("must start uppercase")
    ) {
      return "sentence-boundary-capitalization";
    }

    return reason;
  }

  function mergeHighlightEntries(entries) {
    if (!Array.isArray(entries)) {
      return [];
    }

    const merged = [];
    const byRuleKey = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry.reason !== "string" || !entry.reason) {
        continue;
      }

      const ruleKey = getHighlightRuleKey(entry.reason);
      let target = byRuleKey.get(ruleKey);
      if (!target) {
        target = {
          reason: entry.reason,
          aliases: [entry.reason],
          matches: [],
          ranges: [],
        };
        byRuleKey.set(ruleKey, target);
        merged.push(target);
      } else if (!target.aliases.includes(entry.reason)) {
        target.aliases.push(entry.reason);
      }

      if (Array.isArray(entry.matches)) {
        for (const match of entry.matches) {
          if (
            typeof match === "string" &&
            match &&
            !target.matches.includes(match)
          ) {
            target.matches.push(match);
          }
        }
      }

      if (Array.isArray(entry.ranges)) {
        for (const range of entry.ranges) {
          if (
            range &&
            Number.isFinite(range.start) &&
            Number.isFinite(range.end)
          ) {
            target.ranges.push(range);
          }
        }
      }
    }

    return merged.filter(
      (entry) => entry.matches.length || entry.ranges.length,
    );
  }

  function getNativeTooltipHighlightEntries(rowText = getHoveredRowText()) {
    if (!document.body) {
      return [];
    }

    if (!rowText) {
      return [];
    }

    const bodyText = document.body.innerText || "";
    return getVisibleTooltipEntries(rowText, bodyText, getCustomLintRules(), {
      createTextContext: createTranscriptTextContext,
      disabledRuleIds: disabledCustomLinterRuleIds,
    });
  }

  function findReasonTextNode(reason) {
    if (typeof reason !== "string" || !reason) {
      return null;
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        isHighlightableTextNode(node) &&
        (node.nodeValue || "").includes(reason)
      ) {
        return node;
      }
    }

    return null;
  }

  function findNativeReasonTextNode(reasonPrefix) {
    if (typeof reasonPrefix !== "string" || !reasonPrefix) {
      return null;
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = node.nodeValue || "";
      if (isHighlightableTextNode(node) && value.includes(reasonPrefix)) {
        return node;
      }
    }

    return null;
  }

  function appendPreviewLine(reasonElement, tokens, color) {
    if (!(reasonElement instanceof HTMLElement) || !tokens.length) {
      return null;
    }

    const container =
      reasonElement.closest("li, [role='listitem'], tr, div") || reasonElement;
    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const preview = document.createElement("span");
    preview.setAttribute(HIGHLIGHT_PREVIEW_ATTR, "true");
    preview.textContent = tokens.join(" ... ");
    preview.style.color = "inherit";
    preview.style.opacity = "0.92";
    container.appendChild(preview);
    for (const token of tokens) {
      highlightTextInElement(preview, token, color);
    }

    return preview;
  }

  function addReasonSwatch(reasonNode, color) {
    if (!reasonNode || reasonNode.nodeType !== Node.TEXT_NODE) {
      return false;
    }

    const parent = reasonNode.parentNode;
    if (!parent) {
      return false;
    }

    const swatch = document.createElement("span");
    swatch.setAttribute(HIGHLIGHT_SWATCH_ATTR, "true");
    swatch.style.backgroundColor = getOpaqueHighlightColor(color);
    swatch.style.display = "inline-block";
    swatch.style.marginRight = "6px";
    swatch.style.position = "static";
    swatch.style.verticalAlign = "-1px";
    parent.insertBefore(swatch, reasonNode);
    return true;
  }

  function appendTextRange(parent, text) {
    if (!text) {
      return;
    }

    parent.appendChild(document.createTextNode(text));
  }

  function getOpaqueHighlightColor(color) {
    if (typeof color !== "string") {
      return "hsl(0 82% 46% / 1)";
    }

    return color.replace(/\/\s*0?\.\d+\)/, "/ 1)");
  }

  function appendRowColorSwatch(textarea, color) {
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const row = textarea.closest("tr");
    const parent =
      row instanceof HTMLElement
        ? row
        : textarea.parentElement instanceof HTMLElement
          ? textarea.parentElement
          : null;
    if (!(parent instanceof HTMLElement)) {
      return false;
    }

    const parentStyle = window.getComputedStyle(parent);
    if (parentStyle.position === "static") {
      parent.style.position = "relative";
    }

    const textareaRect = textarea.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const swatch = document.createElement("span");
    swatch.setAttribute(HIGHLIGHT_SWATCH_ATTR, "true");
    swatch.style.backgroundColor = getOpaqueHighlightColor(color);
    swatch.style.left = `${textareaRect.right - parentRect.left - 16 + parent.scrollLeft}px`;
    swatch.style.top = `${textareaRect.top - parentRect.top + 6 + parent.scrollTop}px`;
    parent.appendChild(swatch);
    return true;
  }

  function applyTextareaOverlayEntries(textarea, entries) {
    if (!(textarea instanceof HTMLTextAreaElement) || !Array.isArray(entries)) {
      return false;
    }

    const text = textarea.value || "";
    const validRanges = entries
      .flatMap((entry) =>
        Array.isArray(entry.ranges)
          ? entry.ranges.map((range) => ({
              range,
              color: entry.color,
            }))
          : [],
      )
      .filter(({ range }) => {
        return (
          range &&
          Number.isFinite(range.start) &&
          Number.isFinite(range.end) &&
          range.end > range.start
        );
      })
      .map(({ range, color }) => ({
        start: Math.max(0, Math.min(text.length, range.start)),
        end: Math.max(0, Math.min(text.length, range.end)),
        color,
      }))
      .filter((range) => range.end > range.start)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    if (!validRanges.length) {
      return false;
    }

    const parent = textarea.parentElement;
    if (!(parent instanceof HTMLElement)) {
      return false;
    }

    const parentStyle = window.getComputedStyle(parent);
    if (parentStyle.position === "static") {
      parent.style.position = "relative";
    }

    const textareaRect = textarea.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const textareaStyle = window.getComputedStyle(textarea);
    const overlay = document.createElement("div");
    overlay.setAttribute(HIGHLIGHT_OVERLAY_ATTR, "true");
    overlay.style.left = `${textareaRect.left - parentRect.left + parent.scrollLeft}px`;
    overlay.style.top = `${textareaRect.top - parentRect.top + parent.scrollTop}px`;
    overlay.style.width = `${textareaRect.width}px`;
    overlay.style.height = `${textareaRect.height}px`;
    overlay.style.padding = textareaStyle.padding;
    overlay.style.border = textareaStyle.border;
    overlay.style.font = textareaStyle.font;
    overlay.style.letterSpacing = textareaStyle.letterSpacing;
    overlay.style.lineHeight = textareaStyle.lineHeight;
    overlay.style.whiteSpace = "pre-wrap";
    overlay.style.overflowWrap = "break-word";
    overlay.style.overflow = "hidden";
    overlay.style.boxSizing = textareaStyle.boxSizing;
    overlay.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;

    let pointer = 0;
    for (const range of validRanges) {
      if (range.end <= pointer) {
        continue;
      }

      const start = Math.max(pointer, Math.min(text.length, range.start));
      const end = Math.max(start, Math.min(text.length, range.end));
      appendTextRange(overlay, text.slice(pointer, start));
      const mark = document.createElement("mark");
      mark.setAttribute(HIGHLIGHT_MARK_ATTR, "true");
      mark.style.backgroundColor = range.color;
      mark.textContent = text.slice(start, end);
      overlay.appendChild(mark);
      pointer = end;
    }
    appendTextRange(overlay, text.slice(pointer));

    parent.appendChild(overlay);
    return true;
  }

  function hideVisibleNativeLintTooltips() {
    const tooltipTextParts = [
      NATIVE_LEADING_TRAILING_SPACES_REASON,
      NATIVE_DOUBLE_SPACES_REASON,
      COMMA_RULE_REASON,
      PERIOD_SPACING_RULE_REASON,
      QUOTE_BALANCE_RULE_REASON,
      UNICODE_QUOTE_RULE_REASON,
      CURLY_SPACING_RULE_REASON,
      ANGLE_TAG_SPACING_RULE_REASON,
      SQUARE_BRACKET_TAG_SPACING_RULE_REASON,
      CURLY_TAG_TRAILING_PUNCTUATION_RULE_REASON,
      ANGLE_TAG_TRAILING_PUNCTUATION_RULE_REASON,
      SQUARE_BRACKET_TAG_TRAILING_PUNCTUATION_RULE_REASON,
      UNICODE_DASH_RULE_REASON,
      COMMA_BEFORE_DASH_RULE_REASON,
      FREE_MID_SENTENCE_DOUBLE_DASH_RULE_REASON,
      DOUBLE_DASH_PUNCTUATION_RULE_REASON,
      SINGLE_DASH_PUNCTUATION_RULE_REASON,
      INCORRECT_INTERJECTION_FORMS_RULE_REASON,
      HIGHLIGHTED_WORD_RULE_REASON,
      SENTENCE_BOUNDARY_CAPITALIZATION_RULE_REASON,
      POLITE_PRONOUN_CASE_RULE_REASON,
      TERMINAL_PUNCTUATION_RULE_REASON,
      SEGMENT_START_CAPITALIZATION_RULE_REASON,
      "Words after clear sentence endings",
      "must start uppercase",
      "Commas must be formatted",
      "Incorrect interjection forms",
      "dictionary spelling",
      "Highlighted word requires clearance",
    ];
    const candidates = document.querySelectorAll(
      '[role="tooltip"], [data-radix-popper-content-wrapper]',
    );
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }
      if (candidate.querySelector("main, table, textarea, input")) {
        continue;
      }

      const text = candidate.innerText || "";
      if (!tooltipTextParts.some((part) => text.includes(part))) {
        continue;
      }

      candidate.style.display = "none";
    }
  }

  function applyLinterHighlightsNow() {
    if (!document.body) {
      return;
    }

    applyingHighlights = true;
    try {
      unwrapHighlightMarks(document);
      const rowText = getHoveredRowText();
      const entries = mergeHighlightEntries(
        getIssueHighlightEntries(currentHighlightIssues, rowText).concat(
          getNativeTooltipHighlightEntries(rowText),
        ),
      );
      if (!entries.length) {
        return;
      }

      ensureHighlightStyle();
      const coloredEntries = entries.map((entry, index) => ({
        ...entry,
        color: getHighlightColor(index, entries.length),
      }));
      const textarea =
        highlightedRow instanceof HTMLTableRowElement
          ? highlightedRow.querySelector(ROW_TEXTAREA_SELECTOR)
          : null;
      applyTextareaOverlayEntries(textarea, coloredEntries);

      const swatchedReasonNodes = new Set();
      coloredEntries.forEach((entry) => {
        const reasonNode = (
          Array.isArray(entry.aliases) ? entry.aliases : [entry.reason]
        )
          .map(
            (reason) =>
              findReasonTextNode(reason) || findNativeReasonTextNode(reason),
          )
          .find(Boolean);
        if (!reasonNode || swatchedReasonNodes.has(reasonNode)) {
          return;
        }

        swatchedReasonNodes.add(reasonNode);
        addReasonSwatch(reasonNode, entry.color);
      });
    } finally {
      applyingHighlights = false;
    }
  }

  function scheduleLinterHighlights() {
    if (highlightTimer) {
      window.clearTimeout(highlightTimer);
    }

    highlightTimer = window.setTimeout(() => {
      highlightTimer = 0;
      applyLinterHighlightsNow();
    }, HIGHLIGHT_OBSERVER_DELAY_MS);
  }

  function startHighlightObserver() {
    if (highlightObserver || !document.body) {
      return;
    }

    highlightObserver = new MutationObserver(() => {
      if (!applyingHighlights) {
        scheduleLinterHighlights();
      }
    });
    highlightObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    countPerf("observer.start", { name: "linter-highlight" });
  }

  function handleHighlightPointerOver(event) {
    const target = event && event.target;
    const row = target instanceof Element ? target.closest("tr") : null;
    if (row instanceof HTMLTableRowElement) {
      highlightedRow = row;
      startHighlightObserver();
      scheduleLinterHighlights();
    }
  }

  function handleHighlightPointerOut(event) {
    const relatedTarget = event && event.relatedTarget;
    if (
      highlightedRow &&
      relatedTarget instanceof Node &&
      highlightedRow.contains(relatedTarget)
    ) {
      return;
    }

    highlightedRow = null;
    disconnectHighlightObserver();
    scheduleLinterHighlights();
  }

  function disconnectHighlightObserver() {
    if (highlightObserver) {
      highlightObserver.disconnect();
      highlightObserver = null;
    }
  }

  function findActiveHighlightedWordIssueForRow(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const rowText = getRowTextValue(row);
    return (
      currentHighlightIssues.find(
        (issue) =>
          issue &&
          issue.reason === HIGHLIGHTED_WORD_RULE_REASON &&
          getIssueSourceText(issue) === rowText,
      ) || null
    );
  }

  function isNativeLintStatusTrigger(element) {
    return (
      element instanceof HTMLElement &&
      element.classList.contains("cursor-pointer") &&
      Array.from(element.children).some(
        (child) =>
          child instanceof HTMLElement &&
          String(child.className || "").includes("bg-yellow"),
      )
    );
  }

  function isNativeLintSuccessTrigger(element) {
    return (
      element instanceof HTMLElement &&
      element.classList.contains("cursor-pointer") &&
      Array.from(element.children).some(
        (child) =>
          child instanceof HTMLElement &&
          String(child.className || "").includes("bg-green"),
      )
    );
  }

  function rememberNativeHighlightedWordWarningUndo(warningTrigger) {
    if (!(warningTrigger instanceof HTMLElement)) {
      return false;
    }

    const row = warningTrigger.closest("tr");
    const issue = findActiveHighlightedWordIssueForRow(row);
    if (!issue) {
      return false;
    }

    return unmarkHighlightedWordCleared({
      annotationId: issue.annotationId || "",
      reviewActionId:
        typeof issue.reviewActionId === "string" ? issue.reviewActionId : "",
      text: getIssueSourceText(issue),
    });
  }

  function observeNativeHighlightedWordWarningClick(event) {
    const target = event && event.target;
    const warningTrigger =
      target instanceof Element ? target.closest(".cursor-pointer") : null;
    if (!isNativeLintStatusTrigger(warningTrigger)) {
      if (isNativeLintSuccessTrigger(warningTrigger)) {
        if (rememberNativeHighlightedWordWarningUndo(warningTrigger)) {
          scheduleNativeLintStateSync("highlighted-word-unclearance");
        }
      }
      return false;
    }

    const row = warningTrigger.closest("tr");
    const issue = findActiveHighlightedWordIssueForRow(row);
    if (!issue) {
      return false;
    }

    markHighlightedWordCleared({
      annotationId: issue.annotationId || "",
      reviewActionId:
        typeof issue.reviewActionId === "string" ? issue.reviewActionId : "",
      text: getIssueSourceText(issue),
    });
    scheduleNativeLintStateSync("highlighted-word-clearance");
    scheduleLinterHighlights();
    return true;
  }

  function handleHighlightClick(event) {
    observeNativeHighlightedWordWarningClick(event);

    const target = event && event.target;
    const row = target instanceof Element ? target.closest("tr") : null;
    if (row instanceof HTMLTableRowElement) {
      highlightedRow = row;
      hideVisibleNativeLintTooltips();
      startHighlightObserver();
      scheduleLinterHighlights();
    }
  }

  function stopHighlightObserver() {
    if (highlightTimer) {
      window.clearTimeout(highlightTimer);
      highlightTimer = 0;
    }
    if (highlightObserver) {
      disconnectHighlightObserver();
    }
    currentHighlightIssues = [];
    unwrapHighlightMarks(document);
    removeHighlightStyle();
  }

  function removeCurrentHighlightedWordIssues() {
    const nextIssues = currentHighlightIssues.filter(
      (issue) => !isHelperWarningReason(issue && issue.reason),
    );
    const changed = nextIssues.length !== currentHighlightIssues.length;
    currentHighlightIssues = nextIssues;
    return changed;
  }

  function isCompactJsonlFramePayload(payload) {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const frame = payload.json;
    return (
      Array.isArray(frame) &&
      frame.length >= 3 &&
      typeof frame[0] === "number" &&
      Array.isArray(frame[2])
    );
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
        payload: plainParsed,
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
      payload: prefixedParsed,
    };
  }

  function cloneResponseWithBody(response, bodyText) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  function tryRewriteJsonText(rawText, additionalIssues, shouldSuppressIssue) {
    const parsed = safeJsonParse(rawText);
    if (parsed == null) {
      return null;
    }

    if (!rewriteJsonPayload(parsed, additionalIssues, shouldSuppressIssue)) {
      return null;
    }

    return JSON.stringify(parsed);
  }

  function tryRewriteJsonLines(rawText, additionalIssues, shouldSuppressIssue) {
    const lines = rawText.split(/\r?\n/);
    if (lines.length < 2) {
      return null;
    }

    const parsedLines = lines.map(parseJsonlLine);
    const hasCompactFrames = parsedLines.some(
      (entry) => entry && isCompactJsonlFramePayload(entry.payload),
    );

    let changed = false;
    const mapped = lines.map((line, index) => {
      const parsed = parsedLines[index];
      if (!parsed) {
        return line;
      }

      const lineChanged = hasCompactFrames
        ? rewriteIssuesInCompactJsonlFrame(
            parsed.payload,
            additionalIssues,
            shouldSuppressIssue,
          )
        : rewriteJsonPayload(
            parsed.payload,
            additionalIssues,
            shouldSuppressIssue,
          );
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

  function tryApplyHighlightedWordClearancesJsonText(rawText) {
    const parsed = safeJsonParse(rawText);
    if (parsed == null) {
      return null;
    }

    if (!applyHighlightedWordClearancesToPayload(parsed)) {
      return null;
    }

    return JSON.stringify(parsed);
  }

  function tryApplyHighlightedWordClearancesJsonLines(rawText) {
    const lines = rawText.split(/\r?\n/);
    if (lines.length < 2) {
      return null;
    }

    let changed = false;
    const mapped = lines.map((line) => {
      const parsed = parseJsonlLine(line);
      if (!parsed) {
        return line;
      }

      if (!applyHighlightedWordClearancesToPayload(parsed.payload)) {
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
    return (
      String(window.location.pathname || "") +
      String(window.location.search || "")
    );
  }

  let currentRouteKey = getRouteKey();

  function getRouteLintCallCount(routeKey) {
    if (!routeKey) {
      return 0;
    }

    return routeLintCallCounts.get(routeKey) || 0;
  }

  function recordLintCallForRoute(routeKey) {
    if (!routeKey) {
      return;
    }

    routeLintCallCounts.set(routeKey, getRouteLintCallCount(routeKey) + 1);
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findLintTriggerTextarea() {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLTextAreaElement &&
      activeElement.matches(ROW_TEXTAREA_SELECTOR) &&
      isElementVisible(activeElement)
    ) {
      return activeElement;
    }

    const activeRowTextarea = document.querySelector(
      `tbody tr.bg-neutral-100.ring-1.ring-neutral-300 ${ROW_TEXTAREA_SELECTOR}`,
    );
    if (
      activeRowTextarea instanceof HTMLTextAreaElement &&
      isElementVisible(activeRowTextarea)
    ) {
      return activeRowTextarea;
    }

    const visibleTextarea = Array.from(
      document.querySelectorAll(ROW_TEXTAREA_SELECTOR),
    ).find(
      (node) => node instanceof HTMLTextAreaElement && isElementVisible(node),
    );
    if (visibleTextarea instanceof HTMLTextAreaElement) {
      return visibleTextarea;
    }

    const fallbackTextarea = document.querySelector(ROW_TEXTAREA_SELECTOR);
    return fallbackTextarea instanceof HTMLTextAreaElement
      ? fallbackTextarea
      : null;
  }

  function stopTextareaVisibilityObservers() {
    if (
      textareaVisibilityObserver &&
      typeof textareaVisibilityObserver.disconnect === "function"
    ) {
      textareaVisibilityObserver.disconnect();
    }
    if (
      textareaMountObserver &&
      typeof textareaMountObserver.disconnect === "function"
    ) {
      textareaMountObserver.disconnect();
    }

    textareaVisibilityObserver = null;
    textareaMountObserver = null;
  }

  function nodeTouchesTranscriptRows(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    return (
      node.matches?.("tbody tr") ||
      node.matches?.(ROW_TEXTAREA_SELECTOR) ||
      Boolean(node.querySelector?.("tbody tr")) ||
      Boolean(node.querySelector?.(ROW_TEXTAREA_SELECTOR))
    );
  }

  function startNativeLintStateObserver() {
    if (
      nativeLintStateObserver ||
      !(document.body instanceof HTMLElement) ||
      typeof MutationObserver !== "function"
    ) {
      return;
    }

    nativeLintStateObserver = new MutationObserver((mutations) => {
      const shouldSync = mutations.some((mutation) =>
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          nodeTouchesTranscriptRows,
        ),
      );
      if (shouldSync) {
        scheduleNativeLintStateSync("dom-mutation");
      }
    });
    nativeLintStateObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function stopNativeLintStateObserver() {
    if (nativeLintStateTimer) {
      window.clearTimeout(nativeLintStateTimer);
      nativeLintStateTimer = 0;
    }
    if (nativeLintStateObserver) {
      nativeLintStateObserver.disconnect();
      nativeLintStateObserver = null;
    }
  }

  function handleNativeLintTextareaInput(event) {
    const target = event && event.target;
    if (
      target instanceof HTMLTextAreaElement &&
      target.matches(ROW_TEXTAREA_SELECTOR)
    ) {
      scheduleNativeLintStateSync("textarea-input");
    }
  }

  function handleVisibleTextarea(routeKey, reason) {
    if (!enabled) {
      return;
    }

    const activeRouteKey = getRouteKey();
    if (
      !activeRouteKey ||
      activeRouteKey !== routeKey ||
      autoLintTriggeredRoutes.has(activeRouteKey)
    ) {
      return;
    }

    stopTextareaVisibilityObservers();
    scheduleInitialNativeLintTrigger(reason);
  }

  function observeTextareaCandidate(candidate, routeKey, reason) {
    if (
      !(candidate instanceof HTMLTextAreaElement) ||
      !candidate.matches(ROW_TEXTAREA_SELECTOR) ||
      !textareaVisibilityObserver
    ) {
      return;
    }

    if (isElementVisible(candidate)) {
      handleVisibleTextarea(routeKey, reason);
      return;
    }

    textareaVisibilityObserver.observe(candidate);
  }

  function startTextareaVisibilityObserver(reason) {
    if (!enabled || typeof IntersectionObserver !== "function") {
      return;
    }

    const routeKey = getRouteKey();
    if (!routeKey || autoLintTriggeredRoutes.has(routeKey)) {
      return;
    }

    stopTextareaVisibilityObservers();

    textareaVisibilityObserver = new IntersectionObserver((entries) => {
      if (
        !entries.some(
          (entry) => entry.isIntersecting || entry.intersectionRatio > 0,
        )
      ) {
        return;
      }

      handleVisibleTextarea(routeKey, reason);
    });

    for (const textarea of document.querySelectorAll(ROW_TEXTAREA_SELECTOR)) {
      observeTextareaCandidate(textarea, routeKey, reason);
      if (!textareaVisibilityObserver) {
        return;
      }
    }

    if (
      !(document.body instanceof HTMLElement) ||
      typeof MutationObserver !== "function"
    ) {
      return;
    }

    textareaMountObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }

          if (node.matches?.(ROW_TEXTAREA_SELECTOR)) {
            observeTextareaCandidate(node, routeKey, reason);
          }

          for (const textarea of node.querySelectorAll?.(
            ROW_TEXTAREA_SELECTOR,
          ) || []) {
            observeTextareaCandidate(textarea, routeKey, reason);
            if (!textareaVisibilityObserver) {
              return;
            }
          }
        }
      }
    });

    textareaMountObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function dispatchInputEvent(target, inputType, data) {
    try {
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType, data }),
      );
    } catch (_error) {
      target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function triggerLintViaNoOpInput() {
    const textarea = findLintTriggerTextarea();
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return {
        ok: false,
        reason: "textarea-not-found",
      };
    }

    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (typeof valueSetter !== "function") {
      return {
        ok: false,
        reason: "value-setter-unavailable",
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
        reason: "textarea-noop-input",
      };
    } catch (error) {
      return {
        ok: false,
        reason: "textarea-noop-throw",
        error: String(error && error.message ? error.message : error),
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

    stopTextareaVisibilityObservers();

    const attempt = () => {
      if (!enabled) {
        return;
      }

      const activeRouteKey = getRouteKey();
      if (!activeRouteKey || autoLintTriggeredRoutes.has(activeRouteKey)) {
        return;
      }

      if (getRouteLintCallCount(activeRouteKey) > 0) {
        autoLintTriggeredRoutes.add(activeRouteKey);
        stopTextareaVisibilityObservers();
        debugState.autoLint = {
          changed: true,
          reason: "already-linted",
          route: activeRouteKey,
          attempts: autoLintAttemptCount,
          source: reason,
        };
        return;
      }

      autoLintAttemptCount += 1;
      const kick = triggerLintViaNoOpInput();
      if (kick.ok) {
        debugState.autoLint = {
          changed: false,
          reason: kick.reason,
          route: activeRouteKey,
          attempts: autoLintAttemptCount,
          source: reason,
        };
      } else {
        debugState.autoLint = {
          changed: false,
          reason: kick.reason,
          route: activeRouteKey,
          attempts: autoLintAttemptCount,
          source: reason,
          error: kick.error,
        };
      }

      if (autoLintAttemptCount >= AUTO_LINT_MAX_ATTEMPTS) {
        syncNativeLintState("native-lint-fallback");
        autoLintTriggeredRoutes.add(activeRouteKey);
        debugState.autoLint = {
          changed: false,
          reason: "native-lint-fallback",
          route: activeRouteKey,
          attempts: autoLintAttemptCount,
          source: reason,
          helperIssueCount:
            debugState.nativeLint && debugState.nativeLint.issueCount,
          mergedIssueCount:
            debugState.nativeLint && debugState.nativeLint.mergedIssueCount,
        };
        stopTextareaVisibilityObservers();
        return;
      }

      autoLintTimer = window.setTimeout(attempt, AUTO_LINT_RETRY_DELAY_MS);
    };

    autoLintAttemptCount = 0;
    autoLintTimer = window.setTimeout(attempt, AUTO_LINT_RETRY_DELAY_MS);
  }

  function notifyRouteChange(source) {
    const nextRouteKey = getRouteKey();
    if (!nextRouteKey || nextRouteKey === currentRouteKey) {
      return;
    }

    currentRouteKey = nextRouteKey;
    startTextareaVisibilityObserver(`${source}-textarea-visible`);
    scheduleInitialNativeLintTrigger(source);
    scheduleNativeLintStateSync(source);
  }

  function patchHistoryMethod(methodName) {
    const historyMethod = window.history && window.history[methodName];
    if (
      typeof historyMethod !== "function" ||
      historyMethod.__babelHelperLinterPatched
    ) {
      return;
    }

    const originalHistoryMethod =
      historyMethod.__babelHelperLinterOriginal || historyMethod;
    const wrapped = function patchedHistoryMethod(...args) {
      const result = originalHistoryMethod.apply(this, args);
      window.setTimeout(() => notifyRouteChange(`history-${methodName}`), 0);
      return result;
    };

    wrapped.__babelHelperLinterPatched = true;
    wrapped.__babelHelperLinterOriginal = originalHistoryMethod;
    window.history[methodName] = wrapped;
  }

  function restoreHistoryMethod(methodName) {
    const historyMethod = window.history && window.history[methodName];
    if (
      historyMethod &&
      historyMethod.__babelHelperLinterPatched &&
      typeof historyMethod.__babelHelperLinterOriginal === "function"
    ) {
      window.history[methodName] = historyMethod.__babelHelperLinterOriginal;
    }
  }

  async function maybeAugmentLintResponse(
    response,
    annotationEntries,
    routeKey,
  ) {
    debugState.totalLintCalls += 1;
    recordLintCallForRoute(routeKey);
    if (!(response instanceof Response)) {
      debugState.last = {
        changed: false,
        reason: "non-response",
        issueCount: 0,
      };
      return response;
    }

    if (!annotationEntries.length) {
      debugState.last = {
        changed: false,
        reason: "no-annotation-entries",
        issueCount: currentHighlightIssues.length,
      };
      return response;
    }

    const additionalIssues = buildCustomIssues(annotationEntries);
    const suppressionIds =
      getDoubleDashOutsideQuoteOrTagSuppressionIds(annotationEntries);
    const shouldSuppressIssue = (issue) =>
      suppressionIds.has(issue.annotationId) &&
      isDoubleDashOutsideQuoteOrTagReason(issue.reason);
    if (!additionalIssues.length && suppressionIds.size === 0) {
      setCurrentNativeHelperIssues(
        annotationEntries,
        [],
        "legacy-lint-response-no-custom-issues",
      );
      scheduleLinterHighlights();
      debugState.last = {
        changed: false,
        reason: "no-custom-issues",
        issueCount: 0,
      };
      return response;
    }

    setCurrentNativeHelperIssues(
      annotationEntries,
      additionalIssues,
      "legacy-lint-response",
    );

    let responseText = "";
    try {
      responseText = await response.clone().text();
    } catch (_error) {
      debugState.last = {
        changed: false,
        reason: "response-read-failed",
        issueCount: additionalIssues.length,
        suppressedCandidateCount: suppressionIds.size,
      };
      return response;
    }

    if (!responseText) {
      debugState.last = {
        changed: false,
        reason: "empty-response-text",
        issueCount: additionalIssues.length,
        suppressedCandidateCount: suppressionIds.size,
      };
      return response;
    }

    const asJsonText = tryRewriteJsonText(
      responseText,
      additionalIssues,
      shouldSuppressIssue,
    );
    if (typeof asJsonText === "string") {
      debugState.last = {
        changed: true,
        reason: "json",
        issueCount: additionalIssues.length,
        suppressedCandidateCount: suppressionIds.size,
      };
      return cloneResponseWithBody(response, asJsonText);
    }

    const asJsonLinesText = tryRewriteJsonLines(
      responseText,
      additionalIssues,
      shouldSuppressIssue,
    );
    if (typeof asJsonLinesText === "string") {
      debugState.last = {
        changed: true,
        reason: "jsonl",
        issueCount: additionalIssues.length,
        suppressedCandidateCount: suppressionIds.size,
        responsePreview: asJsonLinesText.slice(0, 240),
      };
      return cloneResponseWithBody(response, asJsonLinesText);
    }

    debugState.last = {
      changed: false,
      reason: "no-target-found",
      issueCount: additionalIssues.length,
      suppressedCandidateCount: suppressionIds.size,
      responsePreview: responseText.slice(0, 240),
    };
    return response;
  }

  async function maybeAugmentHighlightedWordClearanceResponse(response) {
    if (!(response instanceof Response)) {
      return response;
    }

    let responseText = "";
    try {
      responseText = await response.clone().text();
    } catch (_error) {
      return response;
    }

    if (!responseText) {
      return response;
    }

    const asJsonText = tryApplyHighlightedWordClearancesJsonText(responseText);
    if (typeof asJsonText === "string") {
      return cloneResponseWithBody(response, asJsonText);
    }

    const asJsonLinesText =
      tryApplyHighlightedWordClearancesJsonLines(responseText);
    if (typeof asJsonLinesText === "string") {
      return cloneResponseWithBody(response, asJsonLinesText);
    }

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

  function stripHelperAssertedWarningsFromPayload(payload, options = {}) {
    let changed = false;
    const strippedReviewActionIds = new Set();
    const seen = new Set();

    function visit(value, inheritedReviewActionId = "") {
      if (!value || typeof value !== "object" || seen.has(value)) {
        return;
      }

      seen.add(value);

      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, inheritedReviewActionId));
        return;
      }

      const reviewActionId =
        readStringProp(value, ["reviewActionId", "actionId"]) ||
        inheritedReviewActionId;
      const metadata =
        value.metadata && typeof value.metadata === "object"
          ? value.metadata
          : null;
      const assertedWarnings =
        metadata && Array.isArray(metadata.assertedWarnings)
          ? metadata.assertedWarnings
          : null;
      if (assertedWarnings) {
        const nextWarnings = assertedWarnings.filter(
          (reason) => !isHelperWarningReason(reason),
        );
        if (nextWarnings.length !== assertedWarnings.length) {
          changed = true;
          const entry = getAnnotationEntryFromObject(value, reviewActionId);
          const strippedReviewActionId =
            (entry && entry.reviewActionId) ||
            readStringProp(value, ["reviewActionId", "actionId"]);
          if (strippedReviewActionId) {
            strippedReviewActionIds.add(strippedReviewActionId);
          }
          if (options.recordClearance && entry) {
            markHighlightedWordCleared(entry);
          }
          if (nextWarnings.length) {
            metadata.assertedWarnings = nextWarnings;
          } else {
            delete metadata.assertedWarnings;
          }
        }
      }

      Object.values(value).forEach((nested) => visit(nested, reviewActionId));
    }

    visit(payload);

    return {
      changed,
      strippedReviewActionIds,
    };
  }

  async function sanitizeHelperAssertedWarningsRequest(
    input,
    init,
    options = {},
  ) {
    const bodyText = await readRequestBodyText(input, init);
    const bodyPayload = safeJsonParse(bodyText);
    if (!bodyPayload || typeof bodyPayload !== "object") {
      return { input, init, changed: false, payload: null };
    }

    const result = stripHelperAssertedWarningsFromPayload(bodyPayload, options);
    if (!result.changed) {
      return { input, init, changed: false, payload: bodyPayload };
    }

    return {
      ...withRequestBodyText(input, init, JSON.stringify(bodyPayload)),
      changed: true,
      payload: bodyPayload,
    };
  }

  async function callUpstreamFetch(input, init) {
    forwardingFetch += 1;
    try {
      return await upstreamFetch(input, init);
    } finally {
      forwardingFetch = Math.max(0, forwardingFetch - 1);
    }
  }

  async function babelHelperLinterPatchedFetch(input, init) {
    if (forwardingFetch > 0) {
      return fallbackFetch(input, init);
    }

    if (!enabled) {
      return callUpstreamFetch(input, init);
    }

    if (isSaveAnnotationsRequest(input, init)) {
      const sanitized = await sanitizeHelperAssertedWarningsRequest(
        input,
        init,
        {
          recordClearance: true,
        },
      );
      const response = await callUpstreamFetch(sanitized.input, sanitized.init);
      return maybeAugmentHighlightedWordClearanceResponse(response);
    }

    if (!isLintRequest(input, init)) {
      const response = await callUpstreamFetch(input, init);
      if (isTranscriptionsRequest(input)) {
        return maybeAugmentHighlightedWordClearanceResponse(response);
      }

      return response;
    }

    const routeKey = getRouteKey();
    const requestAnnotationEntries = await getAnnotationEntriesFromRequest(
      input,
      init,
    );
    const annotationEntries = requestAnnotationEntries.length
      ? requestAnnotationEntries
      : getNativeAnnotationEntriesFromState();
    const sanitized = await sanitizeHelperAssertedWarningsRequest(input, init, {
      recordClearance: true,
    });
    const response = await callUpstreamFetch(sanitized.input, sanitized.init);
    return maybeAugmentLintResponse(response, annotationEntries, routeKey);
  }

  function installFetchPatch(reason) {
    const currentFetch = window.fetch;
    if (
      currentFetch === babelHelperLinterPatchedFetch ||
      currentFetch?.__babelHelperLinterPatched ||
      typeof currentFetch !== "function"
    ) {
      return false;
    }

    upstreamFetch = currentFetch.bind(window);
    window.fetch = babelHelperLinterPatchedFetch;
    window.fetch.__babelHelperLinterPatched = true;
    window.fetch.__babelHelperLinterOriginal = upstreamFetch;
    debugState.fetchPatch = {
      reason,
      upstreamName: currentFetch.name || "",
      patchedAt: Date.now(),
    };
    return true;
  }

  installFetchPatch("init");
  fetchPatchTimer = window.setInterval(() => {
    installFetchPatch("watchdog");
  }, 1000);

  function handleToggle(event) {
    const nextEnabled = Boolean(event && event.detail && event.detail.enabled);
    enabled = nextEnabled;
    if (!enabled && autoLintTimer) {
      window.clearTimeout(autoLintTimer);
      autoLintTimer = 0;
    }
    if (!enabled) {
      stopTextareaVisibilityObservers();
      stopNativeLintStateObserver();
      stopHighlightObserver();
    }
    if (enabled) {
      installNativeLinterWebpackPatch();
      installFetchPatch("toggle-enable");
      startNativeLintStateObserver();
      startTextareaVisibilityObserver("toggle-enable-textarea-visible");
      scheduleInitialNativeLintTrigger("toggle-enable");
      scheduleNativeLintStateSync("toggle-enable");
    }
  }

  function handleConfig(event) {
    const detail = event && event.detail ? event.detail : {};
    highlightedWordsEnabled = detail.highlightedWordsEnabled !== false;
    highlightedWords = normalizeHighlightedWords(detail.highlightedWords);
    disabledCustomLinterRuleIds = normalizeDisabledCustomLinterRuleIds(
      detail.disabledCustomLinterRuleIds,
    );
    if (!highlightedWordsEnabled) {
      removeCurrentHighlightedWordIssues();
    }
    if (enabled) {
      scheduleNativeLintStateSync("config");
      scheduleLinterHighlights();
    }
  }

  function handlePopState() {
    notifyRouteChange("popstate");
  }

  function dispose() {
    enabled = false;
    if (autoLintTimer) {
      window.clearTimeout(autoLintTimer);
      autoLintTimer = 0;
    }
    if (fetchPatchTimer) {
      window.clearInterval(fetchPatchTimer);
      fetchPatchTimer = 0;
    }
    stopTextareaVisibilityObservers();
    stopNativeLintStateObserver();
    stopHighlightObserver();
    restoreHistoryMethod("pushState");
    restoreHistoryMethod("replaceState");
    const chunk = window.webpackChunk_N_E;
    if (
      Array.isArray(chunk) &&
      nativeLinterWebpackOriginalPush &&
      chunk.push?.__babelHelperNativeLinterOriginalPush ===
        nativeLinterWebpackOriginalPush
    ) {
      chunk.push = nativeLinterWebpackOriginalPush;
      try {
        delete chunk[NATIVE_LINT_PATCH_MARK];
      } catch (_error) {
        chunk[NATIVE_LINT_PATCH_MARK] = false;
      }
    }
    const restoreFetch = upstreamFetch;
    upstreamFetch = fallbackFetch;
    if (
      window.fetch === babelHelperLinterPatchedFetch ||
      window.fetch?.__babelHelperLinterPatched
    ) {
      window.fetch = restoreFetch;
    }
    window.removeEventListener(TOGGLE_EVENT, handleToggle, true);
    window.removeEventListener(CONFIG_EVENT, handleConfig, true);
    window.removeEventListener("input", handleNativeLintTextareaInput, true);
    window.removeEventListener("change", handleNativeLintTextareaInput, true);
    window.removeEventListener("pointerover", handleHighlightPointerOver, true);
    window.removeEventListener("pointerout", handleHighlightPointerOut, true);
    window.removeEventListener("click", handleHighlightClick, true);
    window.removeEventListener("popstate", handlePopState, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    if (window[NATIVE_LINT_AUGMENT_GLOBAL] === augmentNativeLintIssues) {
      delete window[NATIVE_LINT_AUGMENT_GLOBAL];
    }
    delete window.__babelHelperLinterBridge;
  }

  window.addEventListener(TOGGLE_EVENT, handleToggle, true);
  window.addEventListener(CONFIG_EVENT, handleConfig, true);
  window.addEventListener("input", handleNativeLintTextareaInput, true);
  window.addEventListener("change", handleNativeLintTextareaInput, true);
  window.addEventListener("pointerover", handleHighlightPointerOver, true);
  window.addEventListener("pointerout", handleHighlightPointerOut, true);
  window.addEventListener("click", handleHighlightClick, true);

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", handlePopState, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  installNativeLinterWebpackPatch();
  startNativeLintStateObserver();
  startTextareaVisibilityObserver("boot-textarea-visible");
  scheduleInitialNativeLintTrigger("boot");
  scheduleNativeLintStateSync("boot");

  // ---------------------------------------------------------------------------
  // Auto-fix functions
  // ---------------------------------------------------------------------------

  const AUTOFIX_REQUEST_EVENT = "babel-helper-linter-autofix";
  const AUTOFIX_RESPONSE_EVENT = "babel-helper-linter-autofix-response";
  function fixLeadingTrailingSpaces(text) {
    if (typeof text !== "string" || !text) {
      return text;
    }

    return text.replace(/^[ \t]+|[ \t]+$/g, "");
  }

  function fixDoubleSpaces(text) {
    if (typeof text !== "string" || text.indexOf("  ") === -1) {
      return text;
    }

    // Only collapse repeated in-line spaces between non-space characters.
    // Leading/trailing whitespace is handled separately.
    return text.replace(/(\S) {2,}(?=\S)/g, "$1 ");
  }

  function fixCommaSpacing(text) {
    if (typeof text !== "string" || text.indexOf(",") === -1) {
      return text;
    }

    let result = text;
    // Remove whitespace before commas: "word ,next" -> "word,next"
    result = result.replace(/\s+,/g, ",");
    // Ensure exactly one space after comma (except when followed by digit,
    // end of string, or already a single space). Handle digits specially:
    // "1,000" should stay as-is but "word,next" -> "word, next".
    result = result.replace(/,(?![\d ]|$)/g, ", ");
    // Collapse multiple spaces after comma to single space: ",  x" -> ", x"
    result = result.replace(/, {2,}/g, ", ");

    return result;
  }

  function fixPeriodSpacing(text) {
    if (typeof text !== "string" || text.indexOf(".") === -1) {
      return text;
    }

    const textContext = createTranscriptTextContext(text);
    let result = "";
    for (let index = 0; index < text.length; index += 1) {
      if (!isStandalonePeriodAt(text, index, textContext)) {
        result += text[index];
        continue;
      }

      result = result.replace(/[ \t]+$/u, "");
      result += ".";

      let nextIndex = index + 1;
      while (nextIndex < text.length && /[ \t]/.test(text[nextIndex])) {
        nextIndex += 1;
      }

      if (shouldPeriodHaveFollowingSpaceBefore(text[nextIndex])) {
        result += " ";
        index = nextIndex - 1;
      }
    }

    return result;
  }

  function fixUnicodeQuotes(text) {
    return normalizeUnicodeDoubleQuoteVariants(text);
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

    // Fix spacing inside curly braces: trim leading/trailing spaces inside { }
    let result = text.replace(/\{\s+/g, "{").replace(/\s+\}/g, "}");

    // Ensure space before opening brace if preceded by a word character
    result = result.replace(/([\p{L}\p{N}])\{/gu, "$1 {");
    // Ensure space after closing brace if followed by a word character
    result = result.replace(/\}([\p{L}\p{N}])/gu, "} $1");

    return result;
  }

  function fixAngleTagSpacing(text) {
    if (typeof text !== "string" || text.indexOf("<") === -1) {
      return text;
    }

    const tagPattern = /<[^<>\r\n]*>/gu;
    let result = "";
    let cursor = 0;
    let match;
    while ((match = tagPattern.exec(text))) {
      const tagStart = match.index;
      const tagEnd = tagPattern.lastIndex;
      result += text.slice(cursor, tagStart);

      const hasContentBefore = result.trimEnd().length > 0;
      result = result.replace(/[ \t]+$/u, "");
      if (hasContentBefore) {
        result += " ";
      }

      result += normalizeAngleTagText(match[0]);

      cursor = tagEnd;
      while (cursor < text.length && /[ \t]/.test(text[cursor])) {
        cursor += 1;
      }

      if (cursor < text.length) {
        result += " ";
      }
    }

    return result + text.slice(cursor);
  }

  function fixSquareBracketTagSpacing(text) {
    if (typeof text !== "string" || text.indexOf("[") === -1) {
      return text;
    }

    const tagPattern = /\[[^[\]\r\n]*\]/gu;
    let result = "";
    let cursor = 0;
    let match;
    while ((match = tagPattern.exec(text))) {
      const tagStart = match.index;
      const tagEnd = tagPattern.lastIndex;
      result += text.slice(cursor, tagStart);

      const hasContentBefore = result.trimEnd().length > 0;
      result = result.replace(/[ \t]+$/u, "");
      if (hasContentBefore) {
        result += " ";
      }

      result += normalizeSquareBracketTagText(match[0]);

      cursor = tagEnd;
      while (cursor < text.length && /[ \t]/.test(text[cursor])) {
        cursor += 1;
      }

      if (cursor < text.length) {
        result += " ";
      }
    }

    return result + text.slice(cursor);
  }

  function fixUnicodeDashes(text) {
    if (typeof text !== "string") {
      return text;
    }

    UNICODE_DASH_PATTERN.lastIndex = 0;
    if (!UNICODE_DASH_PATTERN.test(text)) {
      return text;
    }

    UNICODE_DASH_PATTERN.lastIndex = 0;
    return text.replace(UNICODE_DASH_PATTERN, "-");
  }

  function fixCurlyTagTrailingPunctuation(text) {
    const parts = getCurlyTagTrailingPunctuationParts(text);
    if (!parts.length) {
      return text;
    }

    let result = "";
    let cursor = 0;
    for (const part of parts) {
      if (part.openIndex < cursor) {
        continue;
      }

      result += text.slice(cursor, part.openIndex);
      result = result.replace(/[ \t]+$/u, "");
      result +=
        text.slice(part.punctuationStart, part.punctuationEnd) +
        " " +
        text.slice(part.openIndex, part.tagEnd);
      cursor = part.punctuationEnd;
    }

    return result + text.slice(cursor);
  }

  function fixSquareBracketTagTrailingPunctuation(text) {
    const parts = getSquareBracketTagTrailingPunctuationParts(text);
    if (!parts.length) {
      return text;
    }

    let result = "";
    let cursor = 0;
    for (const part of parts) {
      if (part.openIndex < cursor) {
        continue;
      }

      result += text.slice(cursor, part.openIndex);
      result = result.replace(/[ \t]+$/u, "");
      result +=
        text.slice(part.punctuationStart, part.punctuationEnd) +
        " " +
        text.slice(part.openIndex, part.tagEnd);
      cursor = part.punctuationEnd;
      while (cursor < text.length && /[ \t]/.test(text[cursor])) {
        cursor += 1;
      }
      if (cursor < text.length) {
        result += " ";
      }
    }

    return result + text.slice(cursor);
  }

  function fixAngleTagTrailingPunctuation(text) {
    const parts = getAngleTagTrailingPunctuationParts(text);
    if (!parts.length) {
      return text;
    }

    let result = "";
    let cursor = 0;
    for (const part of parts) {
      const partStart =
        part.kind === "opening" ? part.punctuationStart : part.tagStart;
      if (partStart < cursor) {
        continue;
      }

      if (part.kind === "opening") {
        result += text.slice(cursor, part.punctuationStart);
        result = result.replace(/[ \t]+$/u, "");
        if (result.trimEnd().length > 0) {
          result += " ";
        }
        result +=
          text.slice(part.tagStart, part.tagEnd) +
          " " +
          text.slice(part.punctuationStart, part.punctuationEnd);
        cursor = part.tagEnd;
        while (cursor < text.length && /[ \t]/.test(text[cursor])) {
          cursor += 1;
        }
      } else {
        result += text.slice(cursor, part.tagStart);
        result = result.replace(/[ \t]+$/u, "");
        result +=
          text.slice(part.punctuationStart, part.punctuationEnd) +
          " " +
          text.slice(part.tagStart, part.tagEnd);
        cursor = part.punctuationEnd;
      }
    }

    return result + text.slice(cursor);
  }

  function fixCommaBeforeDash(text) {
    const parts = getCommaBeforeDashParts(text);
    if (!parts.length) {
      return text;
    }

    let result = "";
    let cursor = 0;
    for (const part of parts) {
      if (part.commaStart < cursor) {
        continue;
      }

      result += text.slice(cursor, part.commaStart);
      result = result.replace(/[ \t]+$/u, "");
      if (result.trimEnd().length > 0) {
        result += " ";
      }
      cursor = part.dashStart;
    }

    return result + text.slice(cursor);
  }

  function fixFreeMidSentenceDoubleDash(text) {
    const parts = getFreeMidSentenceDoubleDashParts(text);
    if (!parts.length) {
      return text;
    }

    let result = "";
    let cursor = 0;
    for (const part of parts) {
      if (part.start < cursor) {
        continue;
      }

      result += text.slice(cursor, part.start) + " - ";
      cursor = part.end;
    }

    return result + text.slice(cursor);
  }

  function fixDoubleDashPunctuation(text) {
    if (typeof text !== "string" || text.indexOf("--") === -1) {
      return text;
    }

    // Remove punctuation immediately after double dash
    return text.replace(/--[.,?!:;]+/g, (match, offset) =>
      isRangeInsideGenericTag(text, offset, offset + match.length)
        ? match
        : "--",
    );
  }

  function fixSingleDashPunctuation(text) {
    if (typeof text !== "string" || text.indexOf("-") === -1) {
      return text;
    }

    // Remove punctuation immediately after single dash
    // A single dash is a '-' not preceded by '-' and not followed by '-'
    return text.replace(/(?<!-)-(?!-)[.,?!:;]+/g, (match, offset) =>
      isRangeInsideGenericTag(text, offset, offset + match.length)
        ? match
        : "-",
    );
  }

  function fixTerminalPunctuation(text) {
    if (typeof text !== "string") {
      return text;
    }

    const trimmed = stripTrailingTagTokens(text);
    if (!trimmed || /(?:\.\.\.|--|[.,?!:;"-])$/.test(trimmed)) {
      return text;
    }

    const insertionIndex = trimmed.length;
    return text.slice(0, insertionIndex) + "." + text.slice(insertionIndex);
  }

  function fixSentenceBoundaryCapitalization(text) {
    if (typeof text !== "string" || !text) {
      return text;
    }

    const indices = findSentenceBoundaryLowercaseIndices(text);
    if (!indices.length) {
      return text;
    }

    let result = text;
    for (let index = indices.length - 1; index >= 0; index -= 1) {
      const letterIndex = indices[index];
      result = replaceCharAt(
        result,
        letterIndex,
        result[letterIndex].toLocaleUpperCase(),
      );
    }

    return result;
  }

  function fixPolitePronounCase(text) {
    if (typeof text !== "string" || !text) {
      return text;
    }

    POLITE_PRONOUN_PATTERN.lastIndex = 0;
    return text.replace(
      POLITE_PRONOUN_PATTERN,
      (match, prefix, token, offset) =>
        `${prefix || ""}${getPolitePronounTargetToken(
          text,
          offset + (prefix || "").length,
          token || "",
        )}`,
    );
  }

  function replaceCharAt(text, index, nextChar) {
    if (
      typeof text !== "string" ||
      index < 0 ||
      index >= text.length ||
      typeof nextChar !== "string"
    ) {
      return text;
    }

    return text.slice(0, index) + nextChar + text.slice(index + 1);
  }

  function fixSegmentStartCapitalization(text, previousSameSpeakerText) {
    if (typeof text !== "string") {
      return text;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return text;
    }

    const contentStartIndex = getCapitalizationContentStart(text);
    if (text.startsWith("...", contentStartIndex)) {
      const ellipsisContentStartIndex = getCapitalizationContentStart(
        text,
        contentStartIndex + 3,
      );
      if (startsWithNumericToken(text, ellipsisContentStartIndex)) {
        return text;
      }

      const letterIndex = findFirstLetterIndex(text, ellipsisContentStartIndex);
      if (letterIndex === -1 || !isUppercaseLetter(text[letterIndex])) {
        return text;
      }

      return replaceCharAt(
        text,
        letterIndex,
        text[letterIndex].toLocaleLowerCase(),
      );
    }

    const letterIndex = findFirstLetterIndex(text, contentStartIndex);
    if (letterIndex === -1 || !isLowercaseLetter(text[letterIndex])) {
      return text;
    }

    if (endsWithLowercaseContinuationMarker(previousSameSpeakerText)) {
      return text;
    }

    return replaceCharAt(
      text,
      letterIndex,
      text[letterIndex].toLocaleUpperCase(),
    );
  }

  function applyAllFixes(text) {
    if (typeof text !== "string") {
      return text;
    }

    const broadTextRules = getCustomLintRules().filter(
      (rule) =>
        rule.id !== "polite-pronoun-case" &&
        rule.id !== "segment-start-capitalization",
    );
    return applyRuleFixes(text, broadTextRules, {}, {
      disabledRuleIds: disabledCustomLinterRuleIds,
    });
  }

  function getRowSpeakerKey(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return "";
    }

    const speakerCell = row.children[1];
    return speakerCell instanceof HTMLElement
      ? speakerCell.innerText.trim()
      : "";
  }

  function getRowTextValue(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return "";
    }

    const textarea = row.querySelector(ROW_TEXTAREA_SELECTOR);
    return textarea instanceof HTMLTextAreaElement ? textarea.value || "" : "";
  }

  function getPreviousSameSpeakerText(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return "";
    }

    const speakerKey = getRowSpeakerKey(row);
    if (!speakerKey) {
      return "";
    }

    let current = row.previousElementSibling;
    while (current) {
      if (
        current instanceof HTMLTableRowElement &&
        getRowSpeakerKey(current) === speakerKey
      ) {
        return getRowTextValue(current);
      }

      current = current.previousElementSibling;
    }

    return "";
  }

  function setTextareaValue(textarea, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (typeof valueSetter === "function") {
      valueSetter.call(textarea, value);
    } else {
      textarea.value = value;
    }

    try {
      textarea.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: null,
        }),
      );
    } catch (_error) {
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function autoFixTextarea(textarea, options = {}) {
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return { fixed: false, reason: "not-textarea" };
    }

    const original = textarea.value || "";
    const previousSameSpeakerText =
      options && typeof options.previousSameSpeakerText === "string"
        ? options.previousSameSpeakerText
        : "";
    let fixed = applyAllFixes(original);
    fixed = fixPolitePronounCase(fixed);
    fixed = fixSegmentStartCapitalization(fixed, previousSameSpeakerText);
    if (fixed === original) {
      return { fixed: false, reason: "no-changes" };
    }

    // Preserve selection relative to text changes
    const selStart = textarea.selectionStart;
    const selEnd = textarea.selectionEnd;

    setTextareaValue(textarea, fixed);

    // Restore caret at a reasonable position (clamp to new length)
    const clampedStart = Math.min(selStart, fixed.length);
    const clampedEnd = Math.min(selEnd, fixed.length);
    try {
      textarea.setSelectionRange(clampedStart, clampedEnd);
    } catch (_error) {
      // Ignore selection errors
    }

    return { fixed: true, reason: "applied", original, result: fixed };
  }

  function autoFixRow(row) {
    if (!(row instanceof HTMLElement)) {
      return { fixed: false, reason: "not-element" };
    }

    const textarea = row.querySelector(ROW_TEXTAREA_SELECTOR);
    return autoFixTextarea(textarea, {
      previousSameSpeakerText: getPreviousSameSpeakerText(row),
    });
  }

  function autoFixAll() {
    const textareas = document.querySelectorAll(ROW_TEXTAREA_SELECTOR);
    let fixedCount = 0;
    let totalCount = 0;

    for (const textarea of textareas) {
      totalCount += 1;
      const row =
        textarea instanceof HTMLTextAreaElement ? textarea.closest("tr") : null;
      const result = autoFixTextarea(textarea, {
        previousSameSpeakerText: row ? getPreviousSameSpeakerText(row) : "",
      });
      if (result.fixed) {
        fixedCount += 1;
      }
    }

    return { fixedCount, totalCount };
  }

  function autoFixCurrent() {
    // Fix the textarea that is currently focused, or the first one in the
    // active row (detected by Babel's active-row styling).
    const active = document.activeElement;
    if (
      active instanceof HTMLTextAreaElement &&
      active.matches(ROW_TEXTAREA_SELECTOR)
    ) {
      const row = active.closest("tr");
      return autoFixTextarea(active, {
        previousSameSpeakerText: row ? getPreviousSameSpeakerText(row) : "",
      });
    }

    // Fall back to the row with Babel's active highlight
    const activeRow = document.querySelector(
      "tbody tr.bg-neutral-100.ring-1.ring-neutral-300",
    );
    if (activeRow) {
      return autoFixRow(activeRow);
    }

    // Last resort: first textarea
    const first = document.querySelector(ROW_TEXTAREA_SELECTOR);
    const row =
      first instanceof HTMLTextAreaElement ? first.closest("tr") : null;
    return autoFixTextarea(first, {
      previousSameSpeakerText: row ? getPreviousSameSpeakerText(row) : "",
    });
  }

  window.addEventListener(
    AUTOFIX_REQUEST_EVENT,
    (event) => {
      if (!enabled) {
        window.dispatchEvent(
          new CustomEvent(AUTOFIX_RESPONSE_EVENT, {
            detail: { ok: false, reason: "disabled" },
          }),
        );
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

      // Re-trigger lint after fixes so the linter UI updates
      scheduleInitialNativeLintTrigger("autofix");
      scheduleNativeLintStateSync("autofix");

      window.dispatchEvent(
        new CustomEvent(AUTOFIX_RESPONSE_EVENT, {
          detail: { ok: true, scope, ...result },
        }),
      );
    },
    true,
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
    applyAllFixes,
    fixLeadingTrailingSpaces,
    fixDoubleSpaces,
    fixPeriodSpacing,
    fixUnicodeQuotes,
    fixAngleTagSpacing,
    fixSquareBracketTagSpacing,
    fixUnicodeDashes,
    fixAngleTagTrailingPunctuation,
    fixSquareBracketTagTrailingPunctuation,
    fixCommaBeforeDash,
    fixFreeMidSentenceDoubleDash,
    fixDoubleDashPunctuation,
    fixSingleDashPunctuation,
    normalizeIncorrectInterjectionForms,
    fixPolitePronounCase,
    fixTerminalPunctuation,
    fixSentenceBoundaryCapitalization,
    fixSegmentStartCapitalization,
    dispose,
  };
}

initLinterBridge();
