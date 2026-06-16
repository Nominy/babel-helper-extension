import type { AnnotationEntry, LinterRule } from '../rule-registry';
import type { TextRange, TranscriptTextContext } from '../text-context';

export type CustomLinterReasons = {
  nativeLeadingTrailingSpaces: string;
  nativeDoubleSpaces: string;
  comma: string;
  periodSpacing: string;
  quoteBalance: string;
  unicodeQuote: string;
  curlySpacing: string;
  angleTagSpacing: string;
  squareBracketTagSpacing: string;
  curlyTagTrailingPunctuation: string;
  angleTagTrailingPunctuation: string;
  squareBracketTagTrailingPunctuation: string;
  unicodeDash: string;
  freeMidSentenceDoubleDash: string;
  doubleDashPunctuation: string;
  singleDashPunctuation: string;
  incorrectInterjectionForms: string;
  highlightedWord: string;
  sentenceBoundaryCapitalization: string;
  politePronounCase: string;
  terminalPunctuation: string;
  segmentStartCapitalization: string;
};

export type CustomLinterRuleDependencies = {
  reasons: CustomLinterReasons;
  ruleSeverity: string;
  highlightedWordRuleSeverity: string;
  getLeadingTrailingSpaceMatches(text: string): TextRange[];
  fixLeadingTrailingSpaces(text: string): string;
  getDoubleSpaceMatches(text: string): TextRange[];
  fixDoubleSpaces(text: string): string;
  getCommaSpacingMatches(text: string): TextRange[];
  fixCommaSpacing(text: string): string;
  getPeriodSpacingMatches(text: string): TextRange[];
  fixPeriodSpacing(text: string): string;
  hasUnbalancedDoubleQuotes(text: string): boolean;
  getUnbalancedDoubleQuoteMatches(text: string): TextRange[];
  getUnicodeQuoteMatches(text: string): TextRange[];
  fixUnicodeQuotes(text: string): string;
  hasCurlySpacingViolation(text: string): boolean;
  getCurlySpacingMatches(text: string): TextRange[];
  fixCurlySpacing(text: string): string;
  getAngleTagSpacingMatches(text: string): TextRange[];
  fixAngleTagSpacing(text: string): string;
  getSquareBracketTagSpacingMatches(text: string): TextRange[];
  fixSquareBracketTagSpacing(text: string): string;
  getCurlyTagTrailingPunctuationMatches(text: string): TextRange[];
  fixCurlyTagTrailingPunctuation(text: string): string;
  getAngleTagTrailingPunctuationMatches(text: string): TextRange[];
  fixAngleTagTrailingPunctuation(text: string): string;
  getSquareBracketTagTrailingPunctuationMatches(text: string): TextRange[];
  fixSquareBracketTagTrailingPunctuation(text: string): string;
  getUnicodeDashMatches(text: string): TextRange[];
  fixUnicodeDashes(text: string): string;
  getFreeMidSentenceDoubleDashMatches(text: string, textContext?: TranscriptTextContext): TextRange[];
  fixFreeMidSentenceDoubleDash(text: string): string;
  getDoubleDashPunctuationMatches(text: string, textContext?: TranscriptTextContext): TextRange[];
  fixDoubleDashPunctuation(text: string): string;
  getSingleDashPunctuationMatches(text: string, textContext?: TranscriptTextContext): TextRange[];
  fixSingleDashPunctuation(text: string): string;
  getIncorrectInterjectionFormMatches(text: string): TextRange[];
  normalizeIncorrectInterjectionForms(text: string): string;
  getHighlightedWordMatches(text: string, textContext?: TranscriptTextContext): TextRange[];
  getSentenceBoundaryCapitalizationMatches(text: string): TextRange[];
  fixSentenceBoundaryCapitalization(text: string): string;
  getPolitePronounCaseMatches(text: string): TextRange[];
  fixPolitePronounCase(text: string): string;
  hasTerminalPunctuationViolation(text: string): boolean;
  getTerminalPunctuationMatches(text: string): TextRange[];
  fixTerminalPunctuation(text: string): string;
  hasSegmentStartCapitalizationViolation(
    entry: AnnotationEntry,
    annotationEntries: AnnotationEntry[],
    index: number
  ): boolean;
  getSegmentStartCapitalizationMatches(entry: AnnotationEntry): TextRange[];
  fixSegmentStartCapitalization(text: string, previousSameSpeakerText: string): string;
};

export type CustomLinterRuleFactory = (deps: CustomLinterRuleDependencies) => LinterRule[];
