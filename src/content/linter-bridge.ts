// @ts-nocheck
export function initLinterBridge() {
  if (window.__babelHelperLinterBridge) {
    return;
  }

  const TOGGLE_EVENT = "babel-helper-linter-bridge-toggle";
  const TEARDOWN_EVENT = "babel-helper-bridge-teardown";
  const LINT_PATH = "/api/trpc/transcriptions.lintAnnotations";
  const COMMA_RULE_REASON = 'Commas must be formatted as ", "';
  const NATIVE_LEADING_TRAILING_SPACES_REASON =
    "Extra spaces at the end or beginning of segments are not allowed.";
  const NATIVE_DOUBLE_SPACES_REASON = "Double spaces are not allowed.";
  const QUOTE_BALANCE_RULE_REASON = "Double quotes must be balanced.";
  const QUOTE_PLACEMENT_RULE_REASON =
    "Double quotes must not have stray spaces inside or be glued to surrounding words.";
  const UNICODE_QUOTE_RULE_REASON =
    'Use ASCII double quote (") instead of typographic or Unicode quote variants.';
  const CURLY_SPACING_RULE_REASON =
    'Curly tags must be formatted as "TEXT {TAG: OTHER}".';
  const UNICODE_DASH_RULE_REASON =
    'Use ASCII hyphen "-" instead of typographic or Unicode dash variants.';
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
  const RULE_SEVERITY = "error";
  const HIGHLIGHT_STYLE_ID = "babel-helper-linter-highlight-style";
  const HIGHLIGHT_MARK_ATTR = "data-babel-helper-linter-highlight";
  const HIGHLIGHT_OVERLAY_ATTR = "data-babel-helper-linter-overlay";
  const HIGHLIGHT_SWATCH_ATTR = "data-babel-helper-linter-swatch";
  const HIGHLIGHT_PREVIEW_ATTR = "data-babel-helper-linter-preview";
  const HIGHLIGHT_OBSERVER_DELAY_MS = 50;
  const AUTO_LINT_MAX_ATTEMPTS = 20;
  const AUTO_LINT_RETRY_DELAY_MS = 100;
  const ROW_TEXTAREA_SELECTOR = 'textarea[placeholder^="What was said"]';
  const UNICODE_DOUBLE_QUOTE_PATTERN =
    /[\u00AB\u00BB\u201C\u201D\u201E\u201F\u2039\u203A\u275D\u275E\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02]/gu;
  const UNICODE_DASH_PATTERN =
    /[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/gu;
  const POLITE_PRONOUN_PATTERN =
    /(^|[^\p{L}\p{N}\p{M}])(вы|вас|вам|вами|ваш(?:а|е|и|его|ему|им|ем|у|ей|ею|их|ими)?)(?=$|[^\p{L}\p{N}\p{M}])/giu;

  const originalFetch = (
    window.fetch.__babelHelperLinterOriginal || window.fetch
  ).bind(window);
  let enabled = true;
  let autoLintAttemptCount = 0;
  let autoLintTimer = 0;
  let highlightObserver = null;
  let highlightTimer = 0;
  let applyingHighlights = false;
  let currentHighlightIssues = [];
  let highlightedRow = null;
  let textareaVisibilityObserver = null;
  let textareaMountObserver = null;
  const autoLintTriggeredRoutes = new Set();
  const routeLintCallCounts = new Map();
  const debugState = {
    totalLintCalls: 0,
    last: null,
    autoLint: null,
  };
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
    { canonical: "окей", variants: ["о'кей", "ОК"] },
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

    function visit(current) {
      if (!current || typeof current !== "object" || seen.has(current)) {
        return;
      }

      seen.add(current);

      if (Array.isArray(current)) {
        for (const item of current) {
          visit(item);
        }
        return;
      }

      const annotationId = readStringProp(current, ["annotationId", "id"]);
      const text = readStringProp(current, [
        "text",
        "content",
        "value",
        "segmentText",
      ]);
      if (annotationId && typeof text === "string") {
        const speakerKey = readSpeakerKey(current);
        const existing = entryById.get(annotationId);
        if (existing) {
          existing.text = text;
          if (!existing.speakerKey && speakerKey) {
            existing.speakerKey = speakerKey;
          }
        } else {
          const entry = {
            annotationId,
            text,
            speakerKey,
          };
          entryById.set(annotationId, entry);
          orderedEntries.push(entry);
        }
      }

      for (const value of Object.values(current)) {
        if (value && typeof value === "object") {
          visit(value);
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

  function hasQuotePlacementViolation(text) {
    const normalizedText = normalizeUnicodeDoubleQuoteVariants(text);
    const quoteIndices = getQuoteIndices(normalizedText);
    if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
      return false;
    }

    for (let index = 0; index < quoteIndices.length; index += 2) {
      const openIndex = quoteIndices[index];
      const closeIndex = quoteIndices[index + 1];
      const prevChar = openIndex > 0 ? normalizedText[openIndex - 1] : "";
      const nextCharAfterOpen =
        openIndex + 1 < normalizedText.length
          ? normalizedText[openIndex + 1]
          : "";
      const prevCharBeforeClose =
        closeIndex > 0 ? normalizedText[closeIndex - 1] : "";
      const nextChar =
        closeIndex + 1 < normalizedText.length
          ? normalizedText[closeIndex + 1]
          : "";

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

    return /--[.,?!:;]/.test(text);
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

    return /(?<!-)-[.,?!:;]/.test(text);
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

    return !/(?:\.\.\.|--|-|[?!."])$/.test(trimmed);
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

      if (char === "." && (text[index - 1] === "." || text[index + 1] === ".")) {
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

  function hasSentenceBoundaryCapitalizationViolation(text) {
    return findSentenceBoundaryLowercaseIndices(text).length > 0;
  }

  function getEnclosingInlineTagRange(text, index) {
    if (typeof text !== "string" || index < 0 || index >= text.length) {
      return null;
    }

    const openIndex = text.lastIndexOf("<", index);
    const closeBeforeIndex = text.lastIndexOf(">", index);
    if (openIndex === -1 || closeBeforeIndex > openIndex) {
      return null;
    }

    const closeIndex = text.indexOf(">", index);
    if (closeIndex === -1) {
      return null;
    }

    return {
      start: openIndex,
      end: closeIndex + 1,
    };
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

    if (trimmed.startsWith("...")) {
      if (startsWithNumericToken(trimmed, 3)) {
        return false;
      }

      const ellipsisLetterIndex = findFirstLetterIndex(
        trimmed,
        skipLeadingCapitalizationTokens(trimmed, 3),
      );
      if (ellipsisLetterIndex === -1) {
        return false;
      }

      return isUppercaseLetter(trimmed[ellipsisLetterIndex]);
    }

    const firstLetterIndex = findFirstLetterIndex(
      trimmed,
      skipLeadingCapitalizationTokens(trimmed),
    );
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
        const tokenOffset =
          groupIndex > 0 ? match[0].indexOf(token) : 0;
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

  function getCommaSpacingMatches(text) {
    return collectRegexMatches(text, /\s+,|,(?![\d ]|$)|, {2,}/gu);
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

  function getQuotePlacementMatches(text) {
    const normalizedText = normalizeUnicodeDoubleQuoteVariants(text);
    const quoteIndices = getQuoteIndices(normalizedText);
    if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
      return [];
    }

    const matches = [];
    for (let index = 0; index < quoteIndices.length; index += 2) {
      const openIndex = quoteIndices[index];
      const closeIndex = quoteIndices[index + 1];
      const prevChar = openIndex > 0 ? normalizedText[openIndex - 1] : "";
      const nextCharAfterOpen =
        openIndex + 1 < normalizedText.length
          ? normalizedText[openIndex + 1]
          : "";
      const prevCharBeforeClose =
        closeIndex > 0 ? normalizedText[closeIndex - 1] : "";
      const nextChar =
        closeIndex + 1 < normalizedText.length
          ? normalizedText[closeIndex + 1]
          : "";

      if (/\s/.test(nextCharAfterOpen)) {
        matches.push(clampTextRange(text, openIndex, openIndex + 2));
      }

      if (/\s/.test(prevCharBeforeClose)) {
        matches.push(clampTextRange(text, closeIndex - 1, closeIndex + 1));
      }

      if (isWordCharacter(prevChar)) {
        matches.push(clampTextRange(text, openIndex - 1, openIndex + 1));
      }

      if (isWordCharacter(nextChar)) {
        matches.push(clampTextRange(text, closeIndex, closeIndex + 2));
      }
    }

    return compactMatches(matches.filter(Boolean));
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
          clampTextRange(text, Math.max(0, index - 1), Math.min(text.length, index + 2)),
        );
      }
    }

    for (const openIndex of stack) {
      matches.push(clampTextRange(text, openIndex, openIndex + 1));
    }

    return compactMatches(matches.filter(Boolean));
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
        matches.push(clampTextRange(text, tokenIndex, tokenIndex + token.length));
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

    if (trimmed.startsWith("...")) {
      const localIndex = findFirstLetterIndex(
        trimmed,
        skipLeadingCapitalizationTokens(trimmed, 3),
      );
      return compactMatches(
        [clampTextRange(text, leadingWhitespace + localIndex, leadingWhitespace + localIndex + 1)].filter(Boolean),
      );
    }

    const localIndex = findFirstLetterIndex(
      trimmed,
      skipLeadingCapitalizationTokens(trimmed),
    );
    return compactMatches(
      [clampTextRange(text, leadingWhitespace + localIndex, leadingWhitespace + localIndex + 1)].filter(Boolean),
    );
  }

  function makeCustomIssue(entry, reason, matches) {
    return {
      annotationId: entry.annotationId,
      reason,
      severity: RULE_SEVERITY,
      babelHelper: {
        matches: compactMatches(matches),
      },
    };
  }

  function buildCustomIssues(annotationEntries) {
    const issues = [];
    for (let index = 0; index < annotationEntries.length; index += 1) {
      const entry = annotationEntries[index];
      if (!entry || typeof entry.annotationId !== "string") {
        continue;
      }

      if (hasCommaSpacingViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, COMMA_RULE_REASON, getCommaSpacingMatches(entry.text)));
      }

      if (hasUnbalancedDoubleQuotes(entry.text)) {
        issues.push(makeCustomIssue(entry, QUOTE_BALANCE_RULE_REASON, getUnbalancedDoubleQuoteMatches(entry.text)));
      } else if (hasQuotePlacementViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, QUOTE_PLACEMENT_RULE_REASON, getQuotePlacementMatches(entry.text)));
      }

      if (hasUnicodeQuoteViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, UNICODE_QUOTE_RULE_REASON, collectRegexMatches(entry.text, UNICODE_DOUBLE_QUOTE_PATTERN)));
      }

      if (hasCurlySpacingViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, CURLY_SPACING_RULE_REASON, getCurlySpacingMatches(entry.text)));
      }

      if (hasUnicodeDashViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, UNICODE_DASH_RULE_REASON, collectRegexMatches(entry.text, UNICODE_DASH_PATTERN)));
      }

      if (hasDoubleDashPunctuationViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, DOUBLE_DASH_PUNCTUATION_RULE_REASON, collectRegexMatches(entry.text, /--[.,?!:;]+/gu)));
      }

      if (hasSingleDashPunctuationViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, SINGLE_DASH_PUNCTUATION_RULE_REASON, collectRegexMatches(entry.text, /(?<!-)-[.,?!:;]+/gu)));
      }

      if (hasIncorrectInterjectionFormsViolation(entry.text)) {
        const interjectionMatches = INTERJECTION_CORRECTIONS.flatMap((correction) =>
          collectRegexMatches(entry.text, correction.pattern, 2),
        );
        issues.push(makeCustomIssue(entry, INCORRECT_INTERJECTION_FORMS_RULE_REASON, interjectionMatches));
      }

      if (hasSentenceBoundaryCapitalizationViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, SENTENCE_BOUNDARY_CAPITALIZATION_RULE_REASON, getSentenceBoundaryCapitalizationMatches(entry.text)));
      }

      if (hasPolitePronounCaseViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, POLITE_PRONOUN_CASE_RULE_REASON, getPolitePronounCaseMatches(entry.text)));
      }

      if (hasTerminalPunctuationViolation(entry.text)) {
        issues.push(makeCustomIssue(entry, TERMINAL_PUNCTUATION_RULE_REASON, getTerminalPunctuationMatches(entry.text)));
      }

      if (
        hasSegmentStartCapitalizationViolation(entry, annotationEntries, index)
      ) {
        issues.push(makeCustomIssue(entry, SEGMENT_START_CAPITALIZATION_RULE_REASON, getSegmentStartCapitalizationMatches(entry)));
      }
    }

    return issues;
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

  function appendIssuesToCompactJsonlFrame(payload, additionalIssues) {
    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray(additionalIssues) ||
      !additionalIssues.length
    ) {
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

  function getIssueHighlightEntries(issues) {
    if (!Array.isArray(issues)) {
      return [];
    }

    return issues
      .map((issue) => {
        const matches =
          issue &&
          issue.babelHelper &&
          Array.isArray(issue.babelHelper.matches)
            ? issue.babelHelper.matches
            : [];
        return {
          reason: issue && typeof issue.reason === "string" ? issue.reason : "",
          matches: matches
            .map((match) =>
              match && typeof match.text === "string" ? match.text : "",
            )
            .filter(Boolean),
        };
      })
      .filter((entry) => entry.reason && entry.matches.length);
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
          if (typeof match === "string" && match && !target.matches.includes(match)) {
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

  function getNativeTooltipHighlightEntries() {
    if (!document.body) {
      return [];
    }

    const rowText = getHoveredRowText();
    if (!rowText) {
      return [];
    }

    const entries = [];
    const bodyText = document.body.innerText || "";

    if (bodyText.includes("Extra spaces at the end or beginning")) {
      const matches = getLeadingTrailingSpaceMatches(rowText);
      if (matches.length) {
        entries.push({
          reason: NATIVE_LEADING_TRAILING_SPACES_REASON,
          matches: matches.map((match) => match.text).filter(Boolean),
          ranges: matches,
        });
      }
    }

    if (bodyText.includes("double spaces") || bodyText.includes("Double spaces")) {
      const matches = getDoubleSpaceMatches(rowText);
      if (matches.length) {
        entries.push({
          reason: NATIVE_DOUBLE_SPACES_REASON,
          matches: matches.map((match) => match.text).filter(Boolean),
          ranges: matches,
        });
      }
    }

    if (
      bodyText.includes("Words after clear sentence endings") ||
      bodyText.includes("must start uppercase")
    ) {
      const matches = getSentenceBoundaryCapitalizationMatches(rowText);
      if (matches.length) {
        entries.push({
          reason: "Words after clear sentence endings",
          matches: matches.map((match) => match.text).filter(Boolean),
          ranges: matches,
        });
      }
    }

    if (
      bodyText.includes("Russian polite pronouns") ||
      bodyText.includes("must be lowercase mid-sentence")
    ) {
      const matches = getPolitePronounCaseMatches(rowText);
      if (matches.length) {
        entries.push({
          reason: "Russian polite pronouns",
          matches: matches.map((match) => match.text).filter(Boolean),
          ranges: matches,
        });
      }
    }

    if (
      bodyText.includes("must be formatted") &&
      bodyText.includes('", "')
    ) {
      const matches = getCommaSpacingMatches(rowText);
      if (matches.length) {
        entries.push({
          reason: "Commas must be formatted",
          matches: matches.map((match) => match.text).filter(Boolean),
          ranges: matches,
        });
      }
    }

    return entries;
  }

  function findReasonTextNode(reason) {
    if (typeof reason !== "string" || !reason) {
      return null;
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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
      "Words after clear sentence endings",
      "must start uppercase",
      "Commas must be formatted",
    ];
    const candidates = document.querySelectorAll(
      '[role="tooltip"], [data-radix-popper-content-wrapper], body > div',
    );
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) {
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
      const entries = mergeHighlightEntries(
        getIssueHighlightEntries(currentHighlightIssues).concat(
          getNativeTooltipHighlightEntries(),
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
        const reasonNode = (Array.isArray(entry.aliases)
          ? entry.aliases
          : [entry.reason]
        )
          .map((reason) => findReasonTextNode(reason) || findNativeReasonTextNode(reason))
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
    const row =
      target instanceof Element ? target.closest("tr") : null;
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

  function handleHighlightClick(event) {
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
        ? appendIssuesToCompactJsonlFrame(parsed.payload, additionalIssues)
        : augmentJsonPayload(parsed.payload, additionalIssues);
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

    const additionalIssues = buildCustomIssues(annotationEntries);
    if (!additionalIssues.length) {
      currentHighlightIssues = [];
      scheduleLinterHighlights();
      debugState.last = {
        changed: false,
        reason: "no-custom-issues",
        issueCount: 0,
      };
      return response;
    }

    currentHighlightIssues = additionalIssues;
    startHighlightObserver();
    scheduleLinterHighlights();

    let responseText = "";
    try {
      responseText = await response.clone().text();
    } catch (_error) {
      debugState.last = {
        changed: false,
        reason: "response-read-failed",
        issueCount: additionalIssues.length,
      };
      return response;
    }

    if (!responseText) {
      debugState.last = {
        changed: false,
        reason: "empty-response-text",
        issueCount: additionalIssues.length,
      };
      return response;
    }

    const asJsonText = tryAugmentJsonText(responseText, additionalIssues);
    if (typeof asJsonText === "string") {
      debugState.last = {
        changed: true,
        reason: "json",
        issueCount: additionalIssues.length,
      };
      return cloneResponseWithBody(response, asJsonText);
    }

    const asJsonLinesText = tryAugmentJsonLines(responseText, additionalIssues);
    if (typeof asJsonLinesText === "string") {
      debugState.last = {
        changed: true,
        reason: "jsonl",
        issueCount: additionalIssues.length,
        responsePreview: asJsonLinesText.slice(0, 240),
      };
      return cloneResponseWithBody(response, asJsonLinesText);
    }

    debugState.last = {
      changed: false,
      reason: "no-target-found",
      issueCount: additionalIssues.length,
      responsePreview: responseText.slice(0, 240),
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

    const routeKey = getRouteKey();
    const annotationEntries = await getAnnotationEntriesFromRequest(
      input,
      init,
    );
    const response = await originalFetch(input, init);
    return maybeAugmentLintResponse(response, annotationEntries, routeKey);
  };
  window.fetch.__babelHelperLinterOriginal = originalFetch;

  function handleToggle(event) {
    const nextEnabled = Boolean(
      event && event.detail && event.detail.enabled,
    );
    enabled = nextEnabled;
    if (!enabled && autoLintTimer) {
      window.clearTimeout(autoLintTimer);
      autoLintTimer = 0;
    }
    if (!enabled) {
      stopTextareaVisibilityObservers();
      stopHighlightObserver();
    }
    if (enabled) {
      startTextareaVisibilityObserver("toggle-enable-textarea-visible");
      scheduleInitialNativeLintTrigger("toggle-enable");
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
    stopTextareaVisibilityObservers();
    stopHighlightObserver();
    restoreHistoryMethod("pushState");
    restoreHistoryMethod("replaceState");
    if (window.fetch && window.fetch.__babelHelperLinterOriginal) {
      window.fetch = window.fetch.__babelHelperLinterOriginal;
    }
    window.removeEventListener(TOGGLE_EVENT, handleToggle, true);
    window.removeEventListener("pointerover", handleHighlightPointerOver, true);
    window.removeEventListener("pointerout", handleHighlightPointerOut, true);
    window.removeEventListener("click", handleHighlightClick, true);
    window.removeEventListener("popstate", handlePopState, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    delete window.__babelHelperLinterBridge;
  }

  window.addEventListener(TOGGLE_EVENT, handleToggle, true);
  window.addEventListener("pointerover", handleHighlightPointerOver, true);
  window.addEventListener("pointerout", handleHighlightPointerOut, true);
  window.addEventListener("click", handleHighlightClick, true);

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", handlePopState, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  startTextareaVisibilityObserver("boot-textarea-visible");
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

  function fixQuotePlacement(text) {
    const quoteIndices = getQuoteIndices(text);
    if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
      return text;
    }

    // Process quote pairs from right to left so indices stay stable.
    let result = text;
    for (let index = quoteIndices.length - 2; index >= 0; index -= 2) {
      const openIndex = quoteIndices[index];
      const closeIndex = quoteIndices[index + 1];
      const inner = result.substring(openIndex + 1, closeIndex);
      const trimmedInner = inner.replace(/^\s+/, "").replace(/\s+$/, "");

      // Rebuild segment: before open + quote pair + after close
      const before = result.substring(0, openIndex);
      const after = result.substring(closeIndex + 1);

      // Ensure space before opening quote if preceded by a word character
      let prefix = before;
      if (prefix.length > 0 && isWordCharacter(prefix[prefix.length - 1])) {
        prefix = prefix + " ";
      }

      // Ensure space after closing quote if followed by a word character
      let suffix = after;
      if (suffix.length > 0 && isWordCharacter(suffix[0])) {
        suffix = " " + suffix;
      }

      result = prefix + '"' + trimmedInner + '"' + suffix;
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

  function fixDoubleDashPunctuation(text) {
    if (typeof text !== "string" || text.indexOf("--") === -1) {
      return text;
    }

    // Remove punctuation immediately after double dash
    return text.replace(/--[.,?!:;]+/g, "--");
  }

  function fixSingleDashPunctuation(text) {
    if (typeof text !== "string" || text.indexOf("-") === -1) {
      return text;
    }

    // Remove punctuation immediately after single dash
    // A single dash is a '-' not preceded by '-' and not followed by '-'
    return text.replace(/(?<!-)-(?!-)[.,?!:;]+/g, "-");
  }

  function fixTerminalPunctuation(text) {
    if (typeof text !== "string") {
      return text;
    }

    const trimmed = stripTrailingTagTokens(text);
    if (!trimmed || /(?:\.\.\.|--|[?!."-])$/.test(trimmed)) {
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

    if (trimmed.startsWith("...")) {
      const sourceIndex = text.indexOf("...");
      const contentStartIndex = skipLeadingCapitalizationTokens(
        text,
        sourceIndex === -1 ? 0 : sourceIndex + 3,
      );
      if (startsWithNumericToken(text, contentStartIndex)) {
        return text;
      }

      const letterIndex = findFirstLetterIndex(
        text,
        contentStartIndex,
      );
      if (letterIndex === -1 || !isUppercaseLetter(text[letterIndex])) {
        return text;
      }

      return replaceCharAt(
        text,
        letterIndex,
        text[letterIndex].toLocaleLowerCase(),
      );
    }

    const letterIndex = findFirstLetterIndex(
      text,
      skipLeadingCapitalizationTokens(text),
    );
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

    let result = text;
    result = fixLeadingTrailingSpaces(result);
    result = fixDoubleSpaces(result);
    result = fixCommaSpacing(result);
    result = fixUnicodeQuotes(result);
    result = fixQuotePlacement(result);
    result = fixCurlySpacing(result);
    result = fixUnicodeDashes(result);
    result = fixDoubleDashPunctuation(result);
    result = fixSingleDashPunctuation(result);
    result = normalizeIncorrectInterjectionForms(result);
    result = fixTerminalPunctuation(result);
    result = fixSentenceBoundaryCapitalization(result);
    return result;
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
    fixUnicodeQuotes,
    fixUnicodeDashes,
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

