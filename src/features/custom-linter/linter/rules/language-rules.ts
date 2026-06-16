import type { CustomLinterRuleFactory } from './types';

export const createLanguageRules: CustomLinterRuleFactory = (deps) => [
  {
    id: 'incorrect-interjection-forms',
    reason: deps.reasons.incorrectInterjectionForms,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.incorrectInterjectionForms,
      'Incorrect interjection forms',
      'dictionary spelling'
    ],
    getMatches: (entry) => deps.getIncorrectInterjectionFormMatches(entry.text),
    fix: (text) => deps.normalizeIncorrectInterjectionForms(text)
  },
  {
    id: 'highlighted-words',
    reason: deps.reasons.highlightedWord,
    severity: deps.highlightedWordRuleSeverity,
    markers: [
      deps.reasons.highlightedWord,
      'Highlighted word requires clearance'
    ],
    getMatches: (entry, context) =>
      deps.getHighlightedWordMatches(entry.text, context.textContext)
  },
  {
    id: 'sentence-boundary-capitalization',
    reason: deps.reasons.sentenceBoundaryCapitalization,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.sentenceBoundaryCapitalization,
      'Words after clear sentence endings',
      'must start uppercase'
    ],
    getMatches: (entry) => deps.getSentenceBoundaryCapitalizationMatches(entry.text),
    fix: (text) => deps.fixSentenceBoundaryCapitalization(text)
  },
  {
    id: 'polite-pronoun-case',
    reason: deps.reasons.politePronounCase,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.politePronounCase,
      'Russian polite pronouns',
      'must be lowercase mid-sentence'
    ],
    getMatches: (entry) => deps.getPolitePronounCaseMatches(entry.text),
    fix: (text) => deps.fixPolitePronounCase(text)
  },
  {
    id: 'segment-start-capitalization',
    reason: deps.reasons.segmentStartCapitalization,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.segmentStartCapitalization,
      'Segments must start with uppercase',
      'segments starting with ...'
    ],
    getMatches: (entry, context) =>
      deps.hasSegmentStartCapitalizationViolation(
        entry,
        context.annotationEntries,
        context.index
      )
        ? deps.getSegmentStartCapitalizationMatches(entry)
        : [],
    fix: (text, context) =>
      deps.fixSegmentStartCapitalization(text, context.previousSameSpeakerText || '')
  }
];
