// @ts-nocheck
import {
  DEFAULT_HIGHLIGHTED_WORDS,
  normalizeHighlightedWords,
} from "../../core/highlighted-words";
import {
  applyRuleFixes,
  createLateBoundLinterRuleResolver,
  getVisibleTooltipEntries,
} from "./linter/rule-registry";
import {
  createTranscriptTextContext,
  getEnclosingGenericTagRange as getContextEnclosingGenericTagRange,
  getNormalizedStutterMatches,
  isRangeInsideGenericTag as isContextRangeInsideGenericTag,
} from "./linter/text-context";
import { createCustomLinterRules } from "./linter/rules";
import { getUnnecessaryYoMatches, fixUnnecessaryYo } from "./linter/yo-orthography";
import { acquireFeedbackDraftGate, findBabelEditorFiber, readBabelTranscriptBindings } from '@nominy/babel-babel-runtime';
import { readNativeTurn, replaceNativeTurn, TRANSCRIPT_ROW_SELECTOR, TRANSCRIPT_EDITOR_SELECTOR } from '../../content/native-transcript';
import { showNativeAutomationFailure } from '../../ui/native-automation-failure';

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
  const ANGLE_TAG_SPACING_RULE_REASON =
    'Angle tags must be formatted as standalone "TEXT <TAG> OTHER" tokens.';
  const SQUARE_BRACKET_TAG_SPACING_RULE_REASON =
    'Square bracket tags must be formatted as standalone "TEXT [TAG] OTHER" tokens.';
  const CURLY_TAG_SPACING_RULE_REASON =
    'Curly tags must be formatted as "TEXT {TAG: OTHER}".';
  const CURLY_TAG_TRAILING_PUNCTUATION_RULE_REASON =
    "Punctuation after curly tags must move before the tag.";
  const ANGLE_TAG_TRAILING_PUNCTUATION_RULE_REASON =
    "Punctuation should be inside style tags.";
  const SQUARE_BRACKET_TAG_TRAILING_PUNCTUATION_RULE_REASON =
    "Punctuation after square bracket tags must move before the tag.";
  const UNICODE_DASH_RULE_REASON =
    'Use ASCII hyphen "-" instead of typographic or Unicode dash variants.';
  const FREE_MID_SENTENCE_DOUBLE_DASH_RULE_REASON =
    "Free-floating mid-sentence double dash must be a single dash.";
  const DOUBLE_DASH_PUNCTUATION_RULE_REASON =
    'Punctuation immediately after double dash is typically avoided, except in joined "--..." word fragments.';
  const SINGLE_DASH_PUNCTUATION_RULE_REASON =
    "Punctuation immediately after single dash is typically avoided.";
  const INCORRECT_INTERJECTION_FORMS_RULE_REASON =
    "Incorrect interjection forms must use dictionary spelling.";
  const UNNECESSARY_YO_RULE_REASON =
    "ё written in a word without meaning changes. Use е instead.";
  const NORMALIZED_STUTTERS_RULE_REASON =
    "Stutter fragments must match the beginning of the following word.";
  const SENTENCE_BOUNDARY_CAPITALIZATION_RULE_REASON =
    "Words after clear sentence endings ., ?, ! must start uppercase.";
  const POLITE_PRONOUN_CASE_RULE_REASON =
    'Russian polite pronouns like "вы" / "ваш" must be lowercase mid-sentence.';
  const TERMINAL_PUNCTUATION_RULE_REASON =
    'Segments must end with one of: ?, ..., !, -, --, ", ., or [неразборчиво].';
  const TERMINAL_INDECIPHERABLE_TAG_PATTERN = /\[неразборчиво\]\s*$/u;
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
  const NATIVE_LINT_STATE_SYNC_DELAY_MS = 1750;
  const NATIVE_LINT_RENDER_SYNC_DELAY_MS = 50;
  const HIGHLIGHTED_WORD_CLEARANCE_STORAGE_KEY =
    "babel-helper-highlighted-word-clearances:v1";
  const ROW_EDITOR_SELECTOR = TRANSCRIPT_EDITOR_SELECTOR;
  const HIGHLIGHT_TOOLTIP_SELECTOR = '[role="tooltip"], [data-radix-popper-content-wrapper]';
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
  let initialNativeLintQueued = false;
  let fetchPatchInstalled = false;
  let highlightObserver = null;
  let highlightPortalObserver = null;
  const highlightRoots = new Set();
  const paintedHighlightRoots = new Set();
  let highlightTimer = 0;
  let applyingHighlights = false;
  let currentHighlightIssues = [];
  let highlightedRow = null;
  let nativeLintStateTimer = 0;
  let nativeLintStateObserver = null;
  const nativeLintDispatchPatches = new Map();
  const autoLintTriggeredRoutes = new Set();
  const clearedHighlightedWordKeys = new Set();
  let highlightedWordClearancesLoaded = false;
  let highlightedWordClearanceTaskKey = "";
  let highlightedWordClearanceClickObserved = false;
  const debugState = {
    totalLintCalls: 0,
    last: null,
    autoLint: null,
    nativeLint: null,
    nativeLintDispatch: null,
    nativeReviewFiber: null,
    customRuleErrors: [],
    get feedbackDraftRestore() {
      return feedbackDraftGate.getDiagnostics();
    },
  };
  let highlightedWordsEnabled = true;
  let highlightedWords = normalizeHighlightedWords(DEFAULT_HIGHLIGHTED_WORDS);
  let disabledCustomLinterRuleIds = [];
  let pageLinterService = null;
  let pageLinterServiceDisposer = null;
  let builtInLintRules = null;
  let cachedRuleDefinitions = [];
  let cachedRowIssues = new Map();
  let cachedLintRoute = "";
  let nativeAnnotationEntries = [];
  let nativeAnnotationEntriesById = new Map();
  let nativeAnnotationOwner = null;
  let nativeAnnotationReviewActionId = "";
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

  function readSpeakerKey(source) {
    const keys = ["processedRecordingId", "trackLabel", "speakerKey", "speakerId", "speakerName", "speaker"];
    return (readStringProp(source, keys) || readStringProp(source?.annotation, keys) || "").trim();
  }

  function extractAnnotationEntries(root) {
    if (!root || typeof root !== "object") {
      return [];
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
  function clearCachedLintState() {
    cachedRowIssues.clear();
    cachedRuleDefinitions = [];
    nativeAnnotationEntries = [];
    nativeAnnotationEntriesById.clear();
    nativeAnnotationOwner = null;
    nativeAnnotationReviewActionId = "";
  }

  function getNativeLintAnnotationEntries(hooks) {
    const owner = hooks.annotationHook.hook.queue;
    if (nativeAnnotationOwner !== owner || nativeAnnotationReviewActionId !== hooks.reviewActionId) {
      clearCachedLintState();
      nativeAnnotationOwner = owner;
      nativeAnnotationReviewActionId = hooks.reviewActionId;
    }
    let entries = null;
    let entryIndex = 0;
    // This is the verified native annotations array, not a request payload.
    // Compare its values even if Babel reuses an object; never derive text from DOM.
    for (const annotation of hooks.annotationHook.hook.memoizedState) {
      const annotationId = readStringProp(annotation, ["annotationId", "id"]);
      const text = readStringProp(annotation, ["text", "content", "value", "segmentText"]);
      if (!annotationId || typeof text !== "string") continue;
      const reviewActionId = readStringProp(annotation, ["reviewActionId", "actionId"]) || "";
      const speakerKey = readSpeakerKey(annotation);
      const warnings = readAnnotationMetadata(annotation)?.assertedWarnings;
      const previous = nativeAnnotationEntriesById.get(annotationId);
      let warningsEqual = Boolean(previous);
      let warningIndex = 0;
      if (Array.isArray(warnings)) {
        for (const warning of warnings) {
          if (typeof warning !== "string") continue;
          if (previous?.assertedWarnings[warningIndex] !== warning) warningsEqual = false;
          warningIndex += 1;
        }
      }
      if (previous?.assertedWarnings.length !== warningIndex) warningsEqual = false;
      const entry = previous && previous.text === text && previous.reviewActionId === reviewActionId &&
        previous.speakerKey === speakerKey && warningsEqual ? previous :
        { annotationId, reviewActionId, text, speakerKey, assertedWarnings: readAssertedWarnings(annotation) };
      if (!entries && entry !== nativeAnnotationEntries[entryIndex]) {
        entries = nativeAnnotationEntries.slice(0, entryIndex);
      }
      entries?.push(entry);
      entryIndex += 1;
    }
    if (!entries && entryIndex === nativeAnnotationEntries.length) return nativeAnnotationEntries;
    nativeAnnotationEntries = entries || nativeAnnotationEntries.slice(0, entryIndex);
    nativeAnnotationEntriesById = new Map(nativeAnnotationEntries.map(entry => [entry.annotationId, entry]));
    return nativeAnnotationEntries;
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


  function hasDoubleDashPunctuationViolation(text) {
    if (typeof text !== "string" || text.indexOf("--") === -1) {
      return false;
    }

    const pattern = /--[.,?!:;]+/gu;
    let match;
    while ((match = pattern.exec(text))) {
      if (
        match[0] !== "--..." &&
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

    if (TERMINAL_INDECIPHERABLE_TAG_PATTERN.test(text)) {
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

  // First capitalizable letter at a sentence/segment start. A start that
  // begins with a number ("1-й", "2020 год") has no initial to capitalize, so
  // the scan stops at the first digit instead of skipping into the suffix.
  function findFirstLetterIndex(text, startIndex = 0) {
    if (typeof text !== "string") {
      return -1;
    }

    for (let index = Math.max(0, startIndex); index < text.length; index += 1) {
      const char = text[index];
      if (/[\p{L}]/u.test(char)) {
        return index;
      }
      if (/[\p{N}]/u.test(char)) {
        return -1;
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
    ).filter((match) => text.slice(match.start, match.end) !== "--...");
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
    highlightedWordClearanceClickObserved = false;
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
        highlightedWordClearanceClickObserved = parsed.clickObserved === true;
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
          clickObserved: highlightedWordClearanceClickObserved,
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

  // Proof that the native status-toggle selector works on this page: the click
  // observer has recorded at least one clearance for the task. Until then the
  // helper must not undo native acknowledgements on its own.
  function hasObservedHighlightedWordClearanceClick(entry) {
    loadHighlightedWordClearances(entry);
    return highlightedWordClearanceClickObserved;
  }

  function recordObservedHighlightedWordClearanceClick(entry) {
    loadHighlightedWordClearances(entry);
    if (highlightedWordClearanceClickObserved) {
      return;
    }

    highlightedWordClearanceClickObserved = true;
    persistHighlightedWordClearances();
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

  function getCurlyTagSpacingMatches(text) {
    if (typeof text !== "string" || text.indexOf("{") === -1) {
      return [];
    }

    return collectRegexMatches(
      text,
      /(?<=\S)\{[\p{L}\p{N}_-]+:[^{}\r\n]*\}/gu,
    );
  }

  function isCurlyTagTrailingPunctuationChar(char) {
    return typeof char === "string" && /[.,?!:;"]/.test(char);
  }

  function isSquareBracketTagTrailingPunctuationChar(char) {
    return typeof char === "string" && /[.,?!:;-]/.test(char);
  }

  function isCurlyTagTrailingPunctuationOpeningQuote(text, index) {
    if (typeof text !== "string" || text[index] !== '"') {
      return false;
    }
    const nextChar = index + 1 < text.length ? text[index + 1] : "";
    return /[\p{L}\p{N}{[<]/u.test(nextChar);
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

    const isEmotionProject = /emotion/i.test(window.location.href || "");
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
        if (isCurlyTagTrailingPunctuationOpeningQuote(text, punctuationEnd)) {
          break;
        }
        punctuationEnd += 1;
      }

      if (punctuationEnd > punctuationStart) {
        // Emotion wraps the spoken source separately from its SKAZ annotation.
        // Punctuation belongs after that first group, not before it.
        if (
          isEmotionProject &&
          !match[0].includes(":") &&
          /^[ \t]*\{(?:СКАЗ|SKAZ):[^{}\r\n]*\}/iu.test(
            text.slice(punctuationEnd),
          )
        ) {
          continue;
        }
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
        if (isCurlyTagTrailingPunctuationOpeningQuote(text, punctuationEnd)) {
          break;
        }
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

  function createBuiltInLintRules() {
    return createCustomLinterRules({
      reasons: {
        nativeLeadingTrailingSpaces: NATIVE_LEADING_TRAILING_SPACES_REASON,
        nativeDoubleSpaces: NATIVE_DOUBLE_SPACES_REASON,
        comma: COMMA_RULE_REASON,
        periodSpacing: PERIOD_SPACING_RULE_REASON,
        quoteBalance: QUOTE_BALANCE_RULE_REASON,
        unicodeQuote: UNICODE_QUOTE_RULE_REASON,
        angleTagSpacing: ANGLE_TAG_SPACING_RULE_REASON,
        squareBracketTagSpacing: SQUARE_BRACKET_TAG_SPACING_RULE_REASON,
        curlyTagSpacing: CURLY_TAG_SPACING_RULE_REASON,
        curlyTagTrailingPunctuation: CURLY_TAG_TRAILING_PUNCTUATION_RULE_REASON,
        angleTagTrailingPunctuation: ANGLE_TAG_TRAILING_PUNCTUATION_RULE_REASON,
        squareBracketTagTrailingPunctuation:
          SQUARE_BRACKET_TAG_TRAILING_PUNCTUATION_RULE_REASON,
        unicodeDash: UNICODE_DASH_RULE_REASON,
        freeMidSentenceDoubleDash: FREE_MID_SENTENCE_DOUBLE_DASH_RULE_REASON,
        doubleDashPunctuation: DOUBLE_DASH_PUNCTUATION_RULE_REASON,
        singleDashPunctuation: SINGLE_DASH_PUNCTUATION_RULE_REASON,
        incorrectInterjectionForms: INCORRECT_INTERJECTION_FORMS_RULE_REASON,
        unnecessaryYo: UNNECESSARY_YO_RULE_REASON,
        normalizedStutters: NORMALIZED_STUTTERS_RULE_REASON,
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
      getAngleTagSpacingMatches,
      fixAngleTagSpacing,
      getSquareBracketTagSpacingMatches,
      fixSquareBracketTagSpacing,
      getCurlyTagSpacingMatches,
      fixCurlyTagSpacing,
      getCurlyTagTrailingPunctuationMatches,
      fixCurlyTagTrailingPunctuation,
      getAngleTagTrailingPunctuationMatches,
      fixAngleTagTrailingPunctuation,
      getSquareBracketTagTrailingPunctuationMatches,
      fixSquareBracketTagTrailingPunctuation,
      getUnicodeDashMatches,
      fixUnicodeDashes,
      getFreeMidSentenceDoubleDashMatches,
      fixFreeMidSentenceDoubleDash,
      getDoubleDashPunctuationMatches,
      fixDoubleDashPunctuation,
      getSingleDashPunctuationMatches,
      fixSingleDashPunctuation,
      getIncorrectInterjectionFormMatches,
      normalizeIncorrectInterjectionForms,
      getUnnecessaryYoMatches,
      fixUnnecessaryYo,
      getNormalizedStutterMatches,
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

  function getExternalLintRules() {
    const rules = window.BabelMods?.registries?.get?.("linter.rules");
    return Array.isArray(rules) ? rules : [];
  }
  function getBuiltInLintRules() {
    return builtInLintRules ||= createBuiltInLintRules();
  }


  const resolveCustomLintRules = createLateBoundLinterRuleResolver(
    getBuiltInLintRules,
    getExternalLintRules,
  );

  function getCustomLintRules() {
    return resolveCustomLintRules();
  }

  function invokePageLinter(method, args, fallback) {
    const services = window.BabelMods?.unsafe?.services;
    if (
      pageLinterServiceDisposer &&
      services &&
      typeof services.invoke === "function"
    ) {
      return services.invoke("page.linter", method, ...args);
    }

    return fallback(...args);
  }

  function isPageLinterEnabled() {
    return Boolean(invokePageLinter("isEnabled", [], () => enabled));
  }

  function normalizeDisabledCustomLinterRuleIds(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const availableRuleIds = new Set(
      getBuiltInLintRules().map((rule) => rule.id),
    );
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
      highlights: compactMatches(matches).map(match => ({ start: match.start, end: match.end })),
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

  function buildBuiltInCustomIssues(annotationEntries) {
    if (!Array.isArray(annotationEntries)) return [];
    // Project-dependent rules read href (including Emotion mode).
    const route = `${getRouteKey()}\u0000${window.location.href || ""}`;
    if (cachedLintRoute !== route) {
      cachedRowIssues.clear();
      cachedRuleDefinitions = [];
      cachedLintRoute = route;
    }
    const builtIns = getBuiltInLintRules();
    const rulesChanged = builtIns.length !== cachedRuleDefinitions.length ||
      builtIns.some((rule, index) => {
        const previous = cachedRuleDefinitions[index];
        return !previous || previous.rule !== rule || previous.getMatches !== rule.getMatches ||
          previous.id !== rule.id || previous.reason !== rule.reason || previous.severity !== rule.severity;
      });
    if (rulesChanged) {
      cachedRowIssues.clear();
      cachedRuleDefinitions = builtIns.map(rule => ({
        rule, getMatches: rule.getMatches, id: rule.id, reason: rule.reason, severity: rule.severity,
      }));
    }
    const externalRules = getExternalLintRules();
    const rules = externalRules.length ? builtIns.concat(externalRules) : builtIns;
    const previousTextBySpeaker = new Map();
    const nextRows = new Map();
    const issues = [];
    for (let index = 0; index < annotationEntries.length; index += 1) {
      const entry = annotationEntries[index];
      if (!entry) continue;
      const previousText = entry.speakerKey ? previousTextBySpeaker.get(entry.speakerKey) : undefined;
      if (entry.speakerKey) previousTextBySpeaker.set(entry.speakerKey, entry.text);
      if (typeof entry.annotationId !== "string") continue;
      const previous = cachedRowIssues.get(entry.annotationId);
      const unchanged = previous && previous.text === entry.text &&
        previous.reviewActionId === entry.reviewActionId && previous.speakerKey === entry.speakerKey;
      const sameContinuation = unchanged && previous.previousText === previousText;
      if (sameContinuation && !previous.failed && !externalRules.length) {
        for (const issue of previous.issues) if (issue) issues.push(issue);
        nextRows.set(entry.annotationId, previous);
        continue;
      }
      let context;
      let record = previous;
      if (!unchanged || !sameContinuation || previous.failed) {
        record = {
          text: entry.text, reviewActionId: entry.reviewActionId, speakerKey: entry.speakerKey,
          previousText, issues: [], failed: false,
          textContext: unchanged ? previous.textContext : undefined,
        };
      }
      for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
        const rule = rules[ruleIndex];
        const builtIn = ruleIndex < builtIns.length;
        if (disabledCustomLinterRuleIds.includes(rule?.id)) continue;
        // Only shipped rules have known dependencies. Registry rules retain the
        // full transcript/index context and run every pass, including closed-over state.
        if (builtIn && unchanged && !previous.failed &&
            (rule.id !== "segment-start-capitalization" || sameContinuation)) {
          const issue = previous.issues[ruleIndex];
          record.issues[ruleIndex] = issue;
          if (issue) issues.push(issue);
          continue;
        }
        context ||= {
          annotationEntries, index,
          textContext: record.textContext ||= createTranscriptTextContext(entry.text),
          previousSameSpeakerText: previousText,
        };
        try {
          const matches = rule.getMatches(entry, context);
          if (!Array.isArray(matches)) {
            throw new TypeError(`Custom linter rule "${rule.id}" returned a non-array match result.`);
          }
          const issue = matches.length ? makeCustomIssue(entry, rule, matches) : null;
          if (builtIn) record.issues[ruleIndex] = issue;
          if (issue) issues.push(issue);
        } catch (error) {
          if (builtIn) record.failed = true;
          recordCustomLinterRuleError(error, rule, entry, context);
        }
      }
      nextRows.set(entry.annotationId, record);
    }
    cachedRowIssues = nextRows;
    return issues;
  }

  function buildCustomIssues(annotationEntries) {
    return invokePageLinter(
      "buildIssues",
      [annotationEntries],
      buildBuiltInCustomIssues,
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

  function haveSameIssueRanges(left, right) {
    const count = Array.isArray(left) ? left.length : 0;
    if (count !== (Array.isArray(right) ? right.length : 0)) return false;
    for (let index = 0; index < count; index += 1) {
      if (left[index]?.start !== right[index]?.start || left[index]?.end !== right[index]?.end ||
          left[index]?.text !== right[index]?.text) return false;
    }
    return true;
  }

  function areLintIssueArraysEqual(left, right) {
    const leftItems = Array.isArray(left) ? left : [];
    const rightItems = Array.isArray(right) ? right : [];
    if (leftItems.length !== rightItems.length) {
      return false;
    }

    return leftItems.every((issue, index) => {
      const other = rightItems[index];
      if (issue === other) return true;
      if (getLintIssueKey(issue) !== getLintIssueKey(other)) {
        return false;
      }

      if (isHelperInjectedIssue(issue) !== isHelperInjectedIssue(other)) return false;
      if (!isHelperInjectedIssue(issue)) return true;
      return issue.babelHelper.sourceText === other.babelHelper.sourceText &&
        haveSameIssueRanges(issue.babelHelper.matches, other.babelHelper.matches) &&
        haveSameIssueRanges(issue.highlights, other.highlights);
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

  function findNativeReviewFiber() {
    const fiber = findBabelEditorFiber();
    debugState.nativeReviewFiber = fiber ? "committed-root" : "not-found";
    return fiber;
  }

  function getNativeReviewHooks(fiber) {
    const binding = readBabelTranscriptBindings();
    if (!fiber || !binding || fiber.memoizedProps?.reviewActionId !== binding.reviewActionId) return null;
    let hook = fiber.memoizedState;
    let index = 0;
    const seen = new Set();
    while (hook && !seen.has(hook)) {
      seen.add(hook);
      // The committed panel and the native annotationsRef prove ownership.
      // The controller's incidental memo storage is not part of this contract:
      // current Babel can expose the same state without that controller memo.
      const dirty = hook.next, issues = dirty?.next, version = issues?.next, ref = version?.next;
      if (hook.memoizedState === binding.annotations && typeof hook.queue?.dispatch === 'function' &&
          typeof dirty?.memoizedState === 'boolean' && typeof dirty.queue?.dispatch === 'function' &&
          Array.isArray(issues?.memoizedState) && typeof issues.queue?.dispatch === 'function' &&
          typeof version?.memoizedState === 'number' &&
          ref?.memoizedState?.current === binding.annotations) {
        return { annotationHook: { hook, index }, lintHook: { hook: issues, index: index + 2 },
          reviewActionId: binding.reviewActionId };
      }
      hook = hook.next;
      index += 1;
    }
    return null;
  }

  function augmentNativeLintDispatchValue(value, hooks, reason) {
    if (!isPageLinterEnabled() || !Array.isArray(value) || !hooks || !hooks.annotationHook) {
      return value;
    }

    const annotationEntries = getNativeLintAnnotationEntries(hooks);

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
      const resolveHooks = () => {
        const latest = getNativeReviewHooks(findNativeReviewFiber());
        return latest?.reviewActionId === hooks.reviewActionId &&
          latest.lintHook.hook.queue === queue ? latest : null;
      };

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
    nativeLintDispatchPatches.set(queue, { originalDispatch, patchedDispatch });
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

    return getNativeLintAnnotationEntries(hooks);
  }

  // Strips the helper's warning reason from native annotation state when the
  // helper no longer considers the highlighted word cleared (text changed, or
  // the user un-acknowledged it). Fails open: a native acknowledgement is only
  // touched once the click observer has proven it can see clearances on this
  // task; otherwise native metadata stays exactly as Babel left it.
  function reconcileNativeHighlightedWordAcknowledgements(hooks, annotations) {
    let binding;
    for (const annotation of annotations) {
      if (!annotation.metadata?.assertedWarnings?.includes(HIGHLIGHTED_WORD_RULE_REASON)) continue;
      const entry = getAnnotationEntryFromObject(annotation);
      if (entry && hasObservedHighlightedWordClearanceClick(entry) && !isHighlightedWordCleared(entry)) {
        binding ??= readBabelTranscriptBindings();
        if (!binding || binding.readOnly || binding.reviewActionId !== hooks.reviewActionId ||
            typeof binding.controller?.toggleWarningAssertion !== 'function') return;
        binding.controller.toggleWarningAssertion(annotation.id, HIGHLIGHTED_WORD_RULE_REASON);
      }
    }
  }

  function stopNativeLintAutomation(error) {
    const reason = error instanceof Error ? error.message : String(error);
    setBuiltInEnabled(false);
    console.error('[Babel Helper] Custom linter automation stopped:', reason);
    showNativeAutomationFailure('Custom linter', reason);
  }

  function syncNativeLintState(reason) {
    if (!isPageLinterEnabled()) {
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
      if (document.querySelector('[data-transcript-scroll]')) {
        stopNativeLintAutomation(new Error('The committed native lint state could not be bound'));
      }
      return false;
    }

    const dispatchPatched = patchNativeLintDispatch(hooks, reason);
    const annotations = hooks.annotationHook.hook.memoizedState;
    reconcileNativeHighlightedWordAcknowledgements(hooks, annotations);
    const nativeIssues = Array.isArray(
      hooks.lintHook.hook.queue.lastRenderedState,
    )
      ? hooks.lintHook.hook.queue.lastRenderedState
      : hooks.lintHook.hook.memoizedState;
    const annotationEntries = getNativeLintAnnotationEntries(hooks);
    const helperIssues = buildCustomIssues(annotationEntries);
    const mergedIssues = mergeNativeAndHelperIssues(nativeIssues, helperIssues);
    setCurrentNativeHelperIssues(annotationEntries, helperIssues, reason);

    if (!areLintIssueArraysEqual(nativeIssues, mergedIssues)) {
      const queue = hooks.lintHook.hook.queue;
      const patch = nativeLintDispatchPatches.get(queue);
      // This pass already evaluated and merged every rule. Only bypass our own
      // augmentation wrapper; preserve another owner's current dispatch.
      const dispatch = queue.dispatch === patch?.patchedDispatch ? patch.originalDispatch : queue.dispatch;
      dispatch.call(queue, mergedIssues);
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
    return true;
  }

  function scheduleNativeLintStateSync(reason, delay = NATIVE_LINT_STATE_SYNC_DELAY_MS) {
    if (!isPageLinterEnabled()) {
      return;
    }

    if (nativeLintStateTimer) {
      window.clearTimeout(nativeLintStateTimer);
    }

    nativeLintStateTimer = window.setTimeout(() => {
      nativeLintStateTimer = 0;
      syncNativeLintState(reason);
    }, delay);
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
    return getRowTextValue(highlightedRow);
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

  function getBuiltInVisibleTooltipEntries(rowText, bodyText) {
    return getVisibleTooltipEntries(rowText, bodyText, getCustomLintRules(), {
      createTextContext: createTranscriptTextContext,
      disabledRuleIds: disabledCustomLinterRuleIds,
      onRuleError: recordCustomLinterRuleError,
    });
  }

  function getNativeTooltipHighlightEntries(rowText = getHoveredRowText()) {
    if (!document.body || !rowText) {
      return [];
    }

    const bodyText = Array.from(highlightRoots, root => root.innerText || "").join("\n");
    return invokePageLinter(
      "getVisibleTooltipEntries",
      [rowText, bodyText],
      getBuiltInVisibleTooltipEntries,
    );
  }

  function findReasonTextNode(reason) {
    if (typeof reason !== "string" || !reason) {
      return null;
    }

    for (const root of highlightRoots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (isHighlightableTextNode(node) && (node.nodeValue || "").includes(reason)) {
          return node;
        }
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


  function getOpaqueHighlightColor(color) {
    if (typeof color !== "string") {
      return "hsl(0 82% 46% / 1)";
    }

    return color.replace(/\/\s*0?\.\d+\)/, "/ 1)");
  }


  function applyEditorOverlayEntries(element, entries) {
    const row = element?.closest(TRANSCRIPT_ROW_SELECTOR);
    const state = row && readNativeTurn(row.getAttribute('data-annotation-id'));
    if (!state || !Array.isArray(entries)) return false;
    const segments = [];
    if (state.editor) {
      let start = 0;
      const nodes = element.querySelectorAll('[data-slate-node="text"]');
      state.editor.children[0]?.children.forEach((node, index) => {
        const text = node.text ?? node.raw ?? '';
        segments.push({ element: nodes[index], start, end: start + text.length, chip: typeof node.text !== 'string' });
        start += text.length;
      });
    } else {
      for (const node of element.querySelectorAll('[data-offset]')) {
        const start = Number(node.getAttribute('data-offset'));
        const chip = Number(node.getAttribute('data-chip')) || 0;
        segments.push({ element: node, start, end: start + (chip || node.textContent.length), chip: Boolean(chip) });
      }
    }
    if (window.getComputedStyle(row).position === 'static') row.style.position = 'relative';
    const parentRect = row.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.setAttribute(HIGHLIGHT_OVERLAY_ATTR, 'true');
    Object.assign(overlay.style, { left: '0', top: '0', width: '100%', height: '100%', overflow: 'hidden' });
    for (const entry of entries) for (const span of entry.ranges || []) {
      for (const segment of segments) {
        const start = Math.max(span.start, segment.start), end = Math.min(span.end, segment.end);
        if (!segment.element || end <= start) continue;
        const rects = [];
        if (segment.chip) rects.push(segment.element.getBoundingClientRect());
        else {
          const walker = document.createTreeWalker(segment.element, NodeFilter.SHOW_TEXT);
          let textNode, offset = segment.start;
          while ((textNode = walker.nextNode())) {
            const left = Math.max(start - offset, 0), right = Math.min(end - offset, textNode.length);
            if (right > left) {
              const range = document.createRange();
              range.setStart(textNode, left); range.setEnd(textNode, right);
              rects.push(...range.getClientRects());
            }
            offset += textNode.length;
          }
        }
        for (const rect of rects) {
          const mark = document.createElement('mark');
          mark.setAttribute(HIGHLIGHT_MARK_ATTR, 'true');
          mark.setAttribute('aria-hidden', 'true');
          Object.assign(mark.style, { position: 'absolute', backgroundColor: entry.color,
            left: `${rect.left - parentRect.left + row.scrollLeft}px`, top: `${rect.top - parentRect.top + row.scrollTop}px`,
            width: `${rect.width}px`, height: `${rect.height}px`, padding: '0' });
          overlay.appendChild(mark);
        }
      }
    }
    if (!overlay.childNodes.length) return false;
    row.appendChild(overlay);
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
      ANGLE_TAG_SPACING_RULE_REASON,
      SQUARE_BRACKET_TAG_SPACING_RULE_REASON,
      CURLY_TAG_TRAILING_PUNCTUATION_RULE_REASON,
      ANGLE_TAG_TRAILING_PUNCTUATION_RULE_REASON,
      SQUARE_BRACKET_TAG_TRAILING_PUNCTUATION_RULE_REASON,
      UNICODE_DASH_RULE_REASON,
      FREE_MID_SENTENCE_DOUBLE_DASH_RULE_REASON,
      DOUBLE_DASH_PUNCTUATION_RULE_REASON,
      SINGLE_DASH_PUNCTUATION_RULE_REASON,
      INCORRECT_INTERJECTION_FORMS_RULE_REASON,
      UNNECESSARY_YO_RULE_REASON,
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
      for (const root of paintedHighlightRoots) unwrapHighlightMarks(root);
      paintedHighlightRoots.clear();
      if (!(highlightedRow instanceof HTMLElement)) return;
      for (const root of highlightRoots) paintedHighlightRoots.add(root);
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
        highlightedRow instanceof HTMLElement
          ? highlightedRow.querySelector(ROW_EDITOR_SELECTOR) || highlightedRow.querySelector('[data-offset]')?.parentElement
          : null;
      applyEditorOverlayEntries(textarea, coloredEntries);

      const swatchedReasonNodes = new Set();
      coloredEntries.forEach((entry) => {
        const reasonNode = (
          Array.isArray(entry.aliases) ? entry.aliases : [entry.reason]
        )
          .map(findReasonTextNode)
          .find(Boolean);
        if (!reasonNode || swatchedReasonNodes.has(reasonNode)) {
          return;
        }

        swatchedReasonNodes.add(reasonNode);
        addReasonSwatch(reasonNode, entry.color);
      });
    } finally {
      // Discard only this synchronous pass's own overlay/swatch mutations.
      // Observing them would otherwise repaint the same highlights forever.
      highlightObserver?.takeRecords();
      highlightPortalObserver?.takeRecords();
      nativeLintStateObserver?.takeRecords();
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

  function refreshHighlightRoots() {
    highlightObserver.disconnect();
    highlightRoots.clear();
    if (!(highlightedRow instanceof HTMLElement)) return;
    highlightRoots.add(highlightedRow);
    for (const root of document.querySelectorAll(HIGHLIGHT_TOOLTIP_SELECTOR)) {
      if (!highlightedRow.contains(root)) highlightRoots.add(root);
    }
    for (const root of highlightRoots) {
      highlightObserver.observe(root, { childList: true, subtree: true, characterData: true });
    }
  }

  function startHighlightObserver() {
    if (!isPageLinterEnabled() || !document.body || !(highlightedRow instanceof HTMLElement)) return;
    if (highlightObserver) {
      if (!highlightRoots.has(highlightedRow)) refreshHighlightRoots();
      return;
    }
    highlightObserver = new MutationObserver(() => {
      if (!applyingHighlights) scheduleLinterHighlights();
    });
    // Captured native tooltips render inline in the row; the shared tooltip
    // wrapper uses a body portal without a container override. Watch only that
    // mount boundary, never playback or unrelated application subtrees.
    highlightPortalObserver = new MutationObserver(mutations => {
      if (applyingHighlights) return;
      const tooltipChanged = mutations.some(mutation =>
        [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
          node instanceof Element &&
          (node.matches(HIGHLIGHT_TOOLTIP_SELECTOR) || node.querySelector(HIGHLIGHT_TOOLTIP_SELECTOR))));
      if (tooltipChanged) {
        refreshHighlightRoots();
        scheduleLinterHighlights();
      }
    });
    highlightPortalObserver.observe(document.body, { childList: true });
    refreshHighlightRoots();
    countPerf("observer.start", { name: "linter-highlight" });
  }

  function handleHighlightPointerOver(event) {
    if (!isPageLinterEnabled()) return;
    const target = event && event.target;
    const row = target instanceof Element ? target.closest(TRANSCRIPT_ROW_SELECTOR) : null;
    if (row instanceof HTMLElement && row !== highlightedRow) {
      highlightedRow = row;
      startHighlightObserver();
      scheduleLinterHighlights();
    }
  }

  function handleHighlightPointerOut(event) {
    if (!highlightedRow) return;
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
    highlightPortalObserver?.disconnect();
    highlightPortalObserver = null;
    highlightRoots.clear();
  }

  function findActiveHighlightedWordIssueForRow(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const rowText = getRowTextValue(row);
    return (
      currentHighlightIssues.find(
        (issue) =>
          issue &&
          issue.annotationId === row.getAttribute('data-annotation-id') &&
          issue.reason === HIGHLIGHTED_WORD_RULE_REASON &&
          getIssueSourceText(issue) === rowText,
      ) || null
    );
  }

  function recordNativeWarningAcknowledgement(annotation, reviewActionId, reason) {
    if (!isPageLinterEnabled() || reason !== HIGHLIGHTED_WORD_RULE_REASON) return false;
    const binding = readBabelTranscriptBindings();
    if (!binding || binding.readOnly || binding.reviewActionId !== reviewActionId) return false;
    const current = binding.annotations.find((entry) => entry.id === annotation?.id);
    if (!current || current.content !== annotation.content) return false;
    const entry = getAnnotationEntryFromObject(annotation, reviewActionId);
    if (!entry) return false;
    markHighlightedWordCleared(entry);
    const pending = binding.pendingTextById[annotation.id];
    if (typeof pending === 'string' && pending !== entry.text) {
      markHighlightedWordCleared({ ...entry, text: pending });
    }
    recordObservedHighlightedWordClearanceClick(entry);
    scheduleNativeLintStateSync('native-warning-acknowledgement');
    scheduleLinterHighlights();
    return true;
  }

  function observeNativeHighlightedWordWarningClick(event) {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const label = button?.textContent?.trim();
    if (label !== 'My transcription is correct' && label !== 'Undo') return false;
    const row = button.closest(TRANSCRIPT_ROW_SELECTOR);
    const issue = findActiveHighlightedWordIssueForRow(row);
    if (!issue || readBabelTranscriptBindings()?.readOnly) return false;
    const card = label === 'Undo' ? button.closest('li') : button.parentElement?.parentElement;
    if (!card?.textContent.includes(HIGHLIGHTED_WORD_RULE_REASON)) return false;
    const entry = { annotationId: issue.annotationId || '', reviewActionId: issue.reviewActionId || '',
      text: getIssueSourceText(issue) };
    if (label === 'Undo') unmarkHighlightedWordCleared(entry);
    else markHighlightedWordCleared(entry);
    recordObservedHighlightedWordClearanceClick(entry);
    scheduleNativeLintStateSync('highlighted-word-clearance');
    scheduleLinterHighlights();
    return true;
  }

  function handleHighlightClick(event) {
    if (!isPageLinterEnabled()) return;
    observeNativeHighlightedWordWarningClick(event);

    const target = event && event.target;
    const row = target instanceof Element ? target.closest(TRANSCRIPT_ROW_SELECTOR) : null;
    if (row instanceof HTMLElement) {
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
    disconnectHighlightObserver();
    highlightedRow = null;
    currentHighlightIssues = [];
    for (const root of paintedHighlightRoots) unwrapHighlightMarks(root);
    paintedHighlightRoots.clear();
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




  function nodeTouchesTranscriptRows(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    return (
      node.matches?.(TRANSCRIPT_ROW_SELECTOR) ||
      node.matches?.(ROW_EDITOR_SELECTOR) ||
      Boolean(node.querySelector?.(TRANSCRIPT_ROW_SELECTOR)) ||
      Boolean(node.querySelector?.(ROW_EDITOR_SELECTOR))
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
      // Native lint callbacks retain the original React setter; replacing
      // queue.dispatch cannot intercept them. Reconcile their rendered cards
      // as well as edits, otherwise the later native lint erases Helper issues.
      const nativeIssueRender = mutations.some((mutation) =>
        mutation.type === 'childList' &&
        mutation.target instanceof Element &&
        mutation.target.closest(TRANSCRIPT_ROW_SELECTOR) &&
        !mutation.target.closest(ROW_EDITOR_SELECTOR),
      );
      const shouldSync = nativeIssueRender || mutations.some((mutation) =>
        mutation.type === 'characterData'
          ? Boolean(mutation.target.parentElement?.closest(TRANSCRIPT_ROW_SELECTOR))
          : Boolean(mutation.target instanceof Element &&
              mutation.target.closest(ROW_EDITOR_SELECTOR)) ||
            [...mutation.addedNodes, ...mutation.removedNodes].some(nodeTouchesTranscriptRows),
      );
      if (shouldSync) {
        scheduleNativeLintStateSync(
          nativeIssueRender ? "native-issue-render" : "dom-mutation",
          nativeIssueRender ? NATIVE_LINT_RENDER_SYNC_DELAY_MS : NATIVE_LINT_STATE_SYNC_DELAY_MS,
        );
      }
    });
    nativeLintStateObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
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
      target instanceof HTMLElement &&
      target.matches(ROW_EDITOR_SELECTOR)
    ) {
      scheduleNativeLintStateSync("textarea-input");
    }
  }




  function scheduleInitialNativeLintTrigger(reason) {
    if (!isPageLinterEnabled() || initialNativeLintQueued) return;
    const routeKey = getRouteKey();
    if (!routeKey || autoLintTriggeredRoutes.has(routeKey)) return;
    initialNativeLintQueued = true;
    queueMicrotask(() => {
      initialNativeLintQueued = false;
      if (!isPageLinterEnabled() || getRouteKey() !== routeKey ||
          autoLintTriggeredRoutes.has(routeKey)) return;
      try {
        const synced = syncNativeLintState("initial-native-lint");
        debugState.autoLint = {
          changed: synced && debugState.nativeLint.dispatched,
          reason: synced ? "native-lint-state-synchronized" :
            debugState.nativeLint?.reason || "native-react-hooks-not-found",
          route: routeKey,
          source: reason,
        };
        if (synced) autoLintTriggeredRoutes.add(routeKey);
      } catch (error) {
        stopNativeLintAutomation(error);
      }
    });
  }

  function handleNativeLinterCommit() {
    scheduleInitialNativeLintTrigger('native-editor-commit');
  }

  function handleNativeLinterSession(event) {
    if (typeof event.detail !== 'string') return;
    let status;
    try { status = JSON.parse(event.detail); } catch { return; }
    if (status?.href !== window.location.href || status.status !== 'ready') return;
    clearCachedLintState();
    stopHighlightObserver();
    autoLintTriggeredRoutes.delete(getRouteKey());
    scheduleInitialNativeLintTrigger('native-session-ready');
  }

  function notifyRouteChange(source) {
    const nextRouteKey = getRouteKey();
    if (!nextRouteKey || nextRouteKey === currentRouteKey) {
      return;
    }

    currentRouteKey = nextRouteKey;
    clearCachedLintState();
    stopHighlightObserver();
    scheduleInitialNativeLintTrigger(source);
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
    if (!isPageLinterEnabled() || routeKey !== getRouteKey()) return response;
    debugState.totalLintCalls += 1;
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
    if (!isPageLinterEnabled() || routeKey !== getRouteKey()) return response;

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

  // Removes helper-owned warning reasons before a payload reaches Babel's
  // server, and records each removed reason as a user clearance.
  function stripHelperAssertedWarningsFromPayload(payload) {
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
          // A helper reason leaving in a save/lint payload is a native
          // acknowledgement the user made; learn it here as well, so the
          // clearance survives even when the DOM click observer missed it.
          if (entry) {
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
  ) {
    const bodyText = await readRequestBodyText(input, init);
    const bodyPayload = safeJsonParse(bodyText);
    if (!bodyPayload || typeof bodyPayload !== "object") {
      return { input, init, changed: false, payload: null };
    }

    const result = stripHelperAssertedWarningsFromPayload(bodyPayload);
    if (!result.changed) {
      return { input, init, changed: false, payload: bodyPayload };
    }

    return {
      ...withRequestBodyText(input, init, JSON.stringify(bodyPayload)),
      changed: true,
      payload: bodyPayload,
    };
  }

  function callUpstreamFetch(input, init) {
    forwardingFetch += 1;
    try {
      return upstreamFetch(input, init);
    } finally {
      forwardingFetch = Math.max(0, forwardingFetch - 1);
    }
  }


  async function babelHelperLinterPatchedFetch(input, init) {
    if (forwardingFetch > 0) {
      return fallbackFetch(input, init);
    }


    return runLinterFetchPipeline(input, init);
  }

  async function runLinterFetchPipeline(input, init) {
    if (!isPageLinterEnabled()) {
      return callUpstreamFetch(input, init);
    }

    if (isSaveAnnotationsRequest(input, init)) {
      const sanitized = await sanitizeHelperAssertedWarningsRequest(
        input,
        init,
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
    const sanitized = await sanitizeHelperAssertedWarningsRequest(input, init);
    const response = await callUpstreamFetch(sanitized.input, sanitized.init);
    return maybeAugmentLintResponse(response, annotationEntries, routeKey);
  }

  function installFetchPatch() {
    const currentFetch = window.fetch;
    if (typeof currentFetch !== "function") {
      return;
    }

    // Bound exactly once, at install. A wrapper stacked on top of us later
    // (another page bridge) captures our wrapper as its original, so
    // re-binding upstream from window.fetch afterwards would close a cycle.
    // Installation therefore happens here only: never on a timer, never on
    // re-enable.
    upstreamFetch = currentFetch.bind(window);
    window.fetch = babelHelperLinterPatchedFetch;
    window.fetch.__babelHelperLinterPatched = true;
    window.fetch.__babelHelperLinterOriginal = upstreamFetch;
    fetchPatchInstalled = true;
    debugState.fetchPatch = {
      reason: "init",
      upstreamName: currentFetch.name || "",
      patchedAt: Date.now(),
    };
  }

  installFetchPatch();
  const feedbackDraftGate = acquireFeedbackDraftGate('babel-helper', true);

  function clearNativeHelperIssues() {
    const hooks = getNativeReviewHooks(findNativeReviewFiber());
    if (!hooks) return;
    const issues = hooks.lintHook.hook.memoizedState;
    const remaining = issues.filter(issue => !isHelperInjectedIssue(issue));
    if (remaining.length !== issues.length) hooks.lintHook.hook.queue.dispatch(remaining);
  }

  function setBuiltInEnabled(nextEnabled) {
    enabled = Boolean(nextEnabled);
    if (!enabled) {
      clearCachedLintState();
      clearNativeHelperIssues();
      stopNativeLintStateObserver();
      stopHighlightObserver();
    }
    if (enabled) {
      startNativeLintStateObserver();
      scheduleInitialNativeLintTrigger("toggle-enable");
    }
  }

  function handleToggle(event) {
    const nextEnabled = Boolean(event && event.detail && event.detail.enabled);
    invokePageLinter("setEnabled", [nextEnabled], setBuiltInEnabled);
  }

  function configureBuiltInLinter(detail = {}) {
    highlightedWordsEnabled = detail.highlightedWordsEnabled !== false;
    highlightedWords = normalizeHighlightedWords(detail.highlightedWords);
    disabledCustomLinterRuleIds = normalizeDisabledCustomLinterRuleIds(
      detail.disabledCustomLinterRuleIds,
    );
    clearCachedLintState();
    if (!highlightedWordsEnabled) {
      removeCurrentHighlightedWordIssues();
    }
    if (enabled) {
      scheduleNativeLintStateSync("config");
      scheduleLinterHighlights();
    }
  }

  function handleConfig(event) {
    const detail = event && event.detail ? event.detail : {};
    feedbackDraftGate.setEnabled(detail.feedbackDraftRestoreEnabled !== false);
    invokePageLinter("configure", [detail], configureBuiltInLinter);
  }

  function handlePopState() {
    notifyRouteChange("popstate");
  }

  function dispose() {
    enabled = false;
    clearCachedLintState();
    clearNativeHelperIssues();
    for (const [queue, patch] of nativeLintDispatchPatches) {
      if (queue.dispatch === patch.patchedDispatch) queue.dispatch = patch.originalDispatch;
    }
    nativeLintDispatchPatches.clear();
    feedbackDraftGate.dispose();
    stopNativeLintStateObserver();
    stopHighlightObserver();
    restoreHistoryMethod("pushState");
    restoreHistoryMethod("replaceState");
    // Only unwrap when we are on top. A foreign wrapper above us holds our
    // wrapper as its original, so we must stay in the chain; disabled state
    // already passes requests straight through to upstreamFetch.
    if (fetchPatchInstalled && window.fetch === babelHelperLinterPatchedFetch) {
      window.fetch = upstreamFetch;
      fetchPatchInstalled = false;
    }
    window.removeEventListener(TOGGLE_EVENT, handleToggle, true);
    window.removeEventListener(CONFIG_EVENT, handleConfig, true);
    window.removeEventListener(
      AUTOFIX_REQUEST_EVENT,
      handleAutoFixRequest,
      true,
    );
    window.removeEventListener("input", handleNativeLintTextareaInput, true);
    window.removeEventListener("change", handleNativeLintTextareaInput, true);
    window.removeEventListener("pointerover", handleHighlightPointerOver, true);
    window.removeEventListener("pointerout", handleHighlightPointerOut, true);
    window.removeEventListener("click", handleHighlightClick, true);
    window.removeEventListener("popstate", handlePopState, true);
    window.removeEventListener('babel-helper:native-editor-commit', handleNativeLinterCommit);
    window.removeEventListener('babel-helper:native-session-change', handleNativeLinterSession);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    const serviceDisposer = pageLinterServiceDisposer;
    pageLinterServiceDisposer = null;
    pageLinterService = null;
    if (typeof serviceDisposer === "function") {
      serviceDisposer();
    } else {
      serviceDisposer?.dispose?.();
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
  window.addEventListener('babel-helper:native-editor-commit', handleNativeLinterCommit);
  window.addEventListener('babel-helper:native-session-change', handleNativeLinterSession);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  startNativeLintStateObserver();
  scheduleInitialNativeLintTrigger("boot");

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

  function fixCurlyTagSpacing(text) {
    if (typeof text !== "string" || text.indexOf("{") === -1) {
      return text;
    }

    return text.replace(
      /(\S)(\{[\p{L}\p{N}_-]+:[^{}\r\n]*\})/gu,
      "$1 $2",
    );
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

    // Keep the joined "--..." sequence used between two heard fragments of
    // one word. Other punctuation immediately after a double dash is invalid.
    return text.replace(/--[.,?!:;]+/g, (match, offset) => {
      if (
        match === "--..." ||
        isRangeInsideGenericTag(text, offset, offset + match.length)
      ) {
        return match;
      }

      return "--";
    });
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

    if (TERMINAL_INDECIPHERABLE_TAG_PATTERN.test(text)) {
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

  function applyBuiltInFixes(text, context = {}) {
    if (typeof text !== "string") {
      return text;
    }

    const broadTextRules = getCustomLintRules().filter(
      (rule) =>
        rule.id !== "polite-pronoun-case" &&
        rule.id !== "segment-start-capitalization",
    );
    return applyRuleFixes(text, broadTextRules, context, {
      disabledRuleIds: disabledCustomLinterRuleIds,
      onRuleError: recordCustomLinterRuleError,
    });
  }

  function applyAllFixes(text, context = {}) {
    return invokePageLinter(
      "applyFixes",
      [text, context],
      applyBuiltInFixes,
    );
  }

  function getRowTextValue(row) {
    return row instanceof Element ? readNativeTurn(row.getAttribute('data-annotation-id'))?.text || '' : '';
  }

  function getPreviousSameSpeakerText(row) {
    const binding = readBabelTranscriptBindings();
    const annotation = binding?.annotations.find(turn => turn.id === row?.getAttribute('data-annotation-id'));
    if (!annotation) return '';
    const previous = binding.annotations.filter(turn => turn.type === 'transcription' &&
      turn.processedRecordingId === annotation.processedRecordingId &&
      turn.startTimeInSeconds < annotation.startTimeInSeconds)
      .sort((a, b) => b.startTimeInSeconds - a.startTimeInSeconds)[0];
    return previous ? readNativeTurn(previous.id, binding)?.text || '' : '';
  }

  function autoFixRow(row) {
    const annotationId = row?.getAttribute('data-annotation-id');
    const state = readNativeTurn(annotationId);
    if (!state) return { fixed: false, reason: 'row-not-found' };
    if (state.readOnly) return { fixed: false, reason: 'read-only' };
    const original = state.text;
    const previousSameSpeakerText = getPreviousSameSpeakerText(row);
    let fixed = applyAllFixes(original, { previousSameSpeakerText });
    fixed = fixPolitePronounCase(fixed);
    fixed = fixSegmentStartCapitalization(fixed, previousSameSpeakerText);
    if (fixed === original) return { fixed: false, reason: 'no-changes' };
    if (!replaceNativeTurn(annotationId, fixed, {
      start: Math.min(state.start, fixed.length), end: Math.min(state.end, fixed.length), direction: state.direction
    })) return { fixed: false, reason: 'native-edit-rejected' };
    return { fixed: true, reason: 'applied', original, result: fixed };
  }

  function autoFixAllBuiltIn() {
    if (!isPageLinterEnabled()) return { fixedCount: 0, totalCount: 0, reason: 'disabled' };
    let fixedCount = 0, totalCount = 0;
    for (const row of document.querySelectorAll(TRANSCRIPT_ROW_SELECTOR)) {
      totalCount += 1;
      if (autoFixRow(row).fixed) fixedCount += 1;
    }
    return { fixedCount, totalCount };
  }

  function autoFixCurrentBuiltIn() {
    if (!isPageLinterEnabled()) return { fixed: false, reason: 'disabled' };
    const active = document.activeElement?.closest(TRANSCRIPT_ROW_SELECTOR);
    const binding = readBabelTranscriptBindings();
    const rows = Array.from(document.querySelectorAll(TRANSCRIPT_ROW_SELECTOR));
    const row = active || rows.find(row => binding?.transcript?.activeIds?.has(row.getAttribute('data-annotation-id'))) || rows[0];
    return autoFixRow(row);
  }

  function autoFixAll() {
    return invokePageLinter("autoFixAll", [], autoFixAllBuiltIn);
  }

  function autoFixCurrent() {
    return invokePageLinter("autoFixCurrent", [], autoFixCurrentBuiltIn);
  }

  function handleAutoFixRequest(event) {
    const serviceEnabled = isPageLinterEnabled();
    if (!serviceEnabled) {
      window.dispatchEvent(
        new CustomEvent(AUTOFIX_RESPONSE_EVENT, {
          detail: { ok: false, reason: "disabled" },
        }),
      );
      return;
    }

    const detail = event && event.detail ? event.detail : {};
    const scope = detail.scope || "current";
    const result = scope === "all" ? autoFixAll() : autoFixCurrent();

    scheduleInitialNativeLintTrigger("autofix");
    scheduleNativeLintStateSync("autofix");

    window.dispatchEvent(
      new CustomEvent(AUTOFIX_RESPONSE_EVENT, {
        detail: { ok: true, scope, ...result },
      }),
    );
  }

  pageLinterService = {
    get enabled() {
      return enabled;
    },
    isEnabled() {
      return enabled;
    },
    setEnabled: setBuiltInEnabled,
    configure: configureBuiltInLinter,
    getRules: getCustomLintRules,
    buildIssues: buildBuiltInCustomIssues,
    getVisibleTooltipEntries: getBuiltInVisibleTooltipEntries,
    applyFixes: applyBuiltInFixes,
    autoFixCurrent: autoFixCurrentBuiltIn,
    autoFixAll: autoFixAllBuiltIn,
  };

  const pageServices = window.BabelMods?.unsafe?.services;
  if (pageServices && typeof pageServices.provide === "function") {
    pageLinterServiceDisposer = pageServices.provide(
      "page.linter",
      pageLinterService,
      { owner: "builtin:page.linter" },
    );
  }

  window.addEventListener(
    AUTOFIX_REQUEST_EVENT,
    handleAutoFixRequest,
    true,
  );

  window.__babelHelperLinterBridge = {
    version: 2,
    get enabled() {
      return isPageLinterEnabled();
    },
    get debug() {
      return debugState;
    },
    recordNativeWarningAcknowledgement,
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
    fixFreeMidSentenceDoubleDash,
    fixDoubleDashPunctuation,
    fixSingleDashPunctuation,
    normalizeIncorrectInterjectionForms,
    fixUnnecessaryYo,
    fixPolitePronounCase,
    fixTerminalPunctuation,
    fixSentenceBoundaryCapitalization,
    fixSegmentStartCapitalization,
    dispose,
  };
}

initLinterBridge();
