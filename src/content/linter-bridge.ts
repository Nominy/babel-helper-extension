// @ts-nocheck
export function initLinterBridge() {
  if (window.__babelHelperLinterBridge) {
    return;
  }

  const TOGGLE_EVENT = "babel-helper-linter-bridge-toggle";
  const LINT_PATH = "/api/trpc/transcriptions.lintAnnotations";
  const COMMA_RULE_REASON = 'Commas must be formatted as ", "';
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
  const AUTO_LINT_MAX_ATTEMPTS = 20;
  const AUTO_LINT_RETRY_DELAY_MS = 100;
  const ROW_TEXTAREA_SELECTOR = 'textarea[placeholder^="What was said"]';
  const UNICODE_DOUBLE_QUOTE_PATTERN =
    /[\u00AB\u00BB\u201C\u201D\u201E\u201F\u2039\u203A\u275D\u275E\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02]/gu;
  const UNICODE_DASH_PATTERN =
    /[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/gu;
  const POLITE_PRONOUN_PATTERN =
    /(^|[^\p{L}\p{N}\p{M}])(вы|вас|вам|вами|ваш(?:а|е|и|его|ему|им|ем|у|ей|ею|их|ими)?)(?=$|[^\p{L}\p{N}\p{M}])/giu;

  const originalFetch = window.fetch.bind(window);
  let enabled = true;
  let autoLintAttemptCount = 0;
  let autoLintTimer = 0;
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

  function endsWithLowercaseContinuationMarker(text) {
    return typeof text === "string" && /(?:\.\.\.|--)\s*$/.test(text);
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

  function getPolitePronounCaseExpectation(text, tokenIndex) {
    if (typeof text !== "string" || tokenIndex < 0) {
      return "neutral";
    }

    const firstLetterIndex = findFirstLetterIndex(
      text,
      skipLeadingCapitalizationTokens(text),
    );
    if (firstLetterIndex !== -1 && tokenIndex === firstLetterIndex) {
      return "neutral";
    }

    let pointer = tokenIndex - 1;
    while (pointer >= 0 && /\s/.test(text[pointer])) {
      pointer -= 1;
    }

    while (
      pointer >= 0 &&
      /["')\]\}\u00BB\u201D\u2019]/u.test(text[pointer])
    ) {
      pointer -= 1;
      while (pointer >= 0 && /\s/.test(text[pointer])) {
        pointer -= 1;
      }
    }

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

    if (/[.?!]/.test(text[pointer])) {
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

  function buildCustomIssues(annotationEntries) {
    const issues = [];
    for (let index = 0; index < annotationEntries.length; index += 1) {
      const entry = annotationEntries[index];
      if (!entry || typeof entry.annotationId !== "string") {
        continue;
      }

      if (hasCommaSpacingViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: COMMA_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasUnbalancedDoubleQuotes(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: QUOTE_BALANCE_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      } else if (hasQuotePlacementViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: QUOTE_PLACEMENT_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasUnicodeQuoteViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: UNICODE_QUOTE_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasCurlySpacingViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: CURLY_SPACING_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasUnicodeDashViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: UNICODE_DASH_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasDoubleDashPunctuationViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: DOUBLE_DASH_PUNCTUATION_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasSingleDashPunctuationViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: SINGLE_DASH_PUNCTUATION_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasIncorrectInterjectionFormsViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: INCORRECT_INTERJECTION_FORMS_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasSentenceBoundaryCapitalizationViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: SENTENCE_BOUNDARY_CAPITALIZATION_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasPolitePronounCaseViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: POLITE_PRONOUN_CASE_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (hasTerminalPunctuationViolation(entry.text)) {
        issues.push({
          annotationId: entry.annotationId,
          reason: TERMINAL_PUNCTUATION_RULE_REASON,
          severity: RULE_SEVERITY,
        });
      }

      if (
        hasSegmentStartCapitalizationViolation(entry, annotationEntries, index)
      ) {
        issues.push({
          annotationId: entry.annotationId,
          reason: SEGMENT_START_CAPITALIZATION_RULE_REASON,
          severity: RULE_SEVERITY,
        });
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

    const wrapped = function patchedHistoryMethod(...args) {
      const result = historyMethod.apply(this, args);
      window.setTimeout(() => notifyRouteChange(`history-${methodName}`), 0);
      return result;
    };

    wrapped.__babelHelperLinterPatched = true;
    window.history[methodName] = wrapped;
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
      debugState.last = {
        changed: false,
        reason: "no-custom-issues",
        issueCount: 0,
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

  window.addEventListener(
    TOGGLE_EVENT,
    (event) => {
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
      }
      if (enabled) {
        startTextareaVisibilityObserver("toggle-enable-textarea-visible");
        scheduleInitialNativeLintTrigger("toggle-enable");
      }
    },
    true,
  );

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener(
    "popstate",
    () => notifyRouteChange("popstate"),
    true,
  );

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
      const letterIndex = findFirstLetterIndex(
        text,
        skipLeadingCapitalizationTokens(
          text,
          sourceIndex === -1 ? 0 : sourceIndex + 3,
        ),
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
  };
}

initLinterBridge();

