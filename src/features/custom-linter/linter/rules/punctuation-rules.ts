import type { CustomLinterRuleFactory } from './types';

export const createPunctuationRules: CustomLinterRuleFactory = (deps) => [
  {
    id: 'quote-balance',
    reason: deps.reasons.quoteBalance,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.quoteBalance, 'Double quotes must be balanced'],
    getMatches: (entry) =>
      deps.hasUnbalancedDoubleQuotes(entry.text)
        ? deps.getUnbalancedDoubleQuoteMatches(entry.text)
        : []
  },
  {
    id: 'unicode-quotes',
    reason: deps.reasons.unicodeQuote,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.unicodeQuote,
      'typographic or Unicode quote'
    ],
    getMatches: (entry) => deps.getUnicodeQuoteMatches(entry.text),
    fix: (text) => deps.fixUnicodeQuotes(text)
  },
  {
    id: 'unicode-dashes',
    reason: deps.reasons.unicodeDash,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.unicodeDash, 'typographic or Unicode dash'],
    getMatches: (entry) => deps.getUnicodeDashMatches(entry.text),
    fix: (text) => deps.fixUnicodeDashes(text)
  },
  {
    id: 'curly-tag-trailing-punctuation',
    reason: deps.reasons.curlyTagTrailingPunctuation,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.curlyTagTrailingPunctuation,
      'Punctuation after curly tags'
    ],
    getMatches: (entry) => deps.getCurlyTagTrailingPunctuationMatches(entry.text),
    fix: (text) => deps.fixCurlyTagTrailingPunctuation(text)
  },
  {
    id: 'angle-tag-trailing-punctuation',
    reason: deps.reasons.angleTagTrailingPunctuation,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.angleTagTrailingPunctuation,
      'Punctuation should be inside style tags'
    ],
    getMatches: (entry) => deps.getAngleTagTrailingPunctuationMatches(entry.text),
    fix: (text) => deps.fixAngleTagTrailingPunctuation(text)
  },
  {
    id: 'square-bracket-tag-trailing-punctuation',
    reason: deps.reasons.squareBracketTagTrailingPunctuation,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.squareBracketTagTrailingPunctuation,
      'Punctuation after square bracket tags'
    ],
    getMatches: (entry) => deps.getSquareBracketTagTrailingPunctuationMatches(entry.text),
    fix: (text) => deps.fixSquareBracketTagTrailingPunctuation(text)
  },
  {
    id: 'free-mid-sentence-double-dash',
    reason: deps.reasons.freeMidSentenceDoubleDash,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.freeMidSentenceDoubleDash,
      'Free-floating double dash'
    ],
    getMatches: (entry, context) =>
      deps.getFreeMidSentenceDoubleDashMatches(entry.text, context.textContext),
    fix: (text) => deps.fixFreeMidSentenceDoubleDash(text)
  },
  {
    id: 'double-dash-punctuation',
    reason: deps.reasons.doubleDashPunctuation,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.doubleDashPunctuation,
      'Punctuation immediately after double dash'
    ],
    getMatches: (entry, context) =>
      deps.getDoubleDashPunctuationMatches(entry.text, context.textContext),
    fix: (text) => deps.fixDoubleDashPunctuation(text)
  },
  {
    id: 'single-dash-punctuation',
    reason: deps.reasons.singleDashPunctuation,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.singleDashPunctuation,
      'Punctuation immediately after single dash'
    ],
    getMatches: (entry, context) =>
      deps.getSingleDashPunctuationMatches(entry.text, context.textContext),
    fix: (text) => deps.fixSingleDashPunctuation(text)
  },
  {
    id: 'terminal-punctuation',
    reason: deps.reasons.terminalPunctuation,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.terminalPunctuation, 'Segments must end with one of'],
    getMatches: (entry) =>
      deps.hasTerminalPunctuationViolation(entry.text)
        ? deps.getTerminalPunctuationMatches(entry.text)
        : [],
    fix: (text) => deps.fixTerminalPunctuation(text)
  }
];
