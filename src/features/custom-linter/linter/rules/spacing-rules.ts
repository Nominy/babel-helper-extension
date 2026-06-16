import type { CustomLinterRuleFactory } from './types';

export const createSpacingRules: CustomLinterRuleFactory = (deps) => [
  {
    id: 'leading-trailing-spaces',
    reason: deps.reasons.nativeLeadingTrailingSpaces,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.nativeLeadingTrailingSpaces,
      'Extra spaces at the end or beginning'
    ],
    getMatches: (entry) => deps.getLeadingTrailingSpaceMatches(entry.text),
    fix: (text) => deps.fixLeadingTrailingSpaces(text)
  },
  {
    id: 'double-spaces',
    reason: deps.reasons.nativeDoubleSpaces,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.nativeDoubleSpaces, 'Double spaces', 'double spaces'],
    getMatches: (entry) => deps.getDoubleSpaceMatches(entry.text),
    fix: (text) => deps.fixDoubleSpaces(text)
  },
  {
    id: 'comma-spacing',
    reason: deps.reasons.comma,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.comma, 'Commas must be formatted'],
    getMatches: (entry) => deps.getCommaSpacingMatches(entry.text),
    fix: (text) => deps.fixCommaSpacing(text)
  },
  {
    id: 'period-spacing',
    reason: deps.reasons.periodSpacing,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.periodSpacing, 'Periods must be spaced'],
    getMatches: (entry) => deps.getPeriodSpacingMatches(entry.text),
    fix: (text) => deps.fixPeriodSpacing(text)
  },
  {
    id: 'curly-spacing',
    reason: deps.reasons.curlySpacing,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.curlySpacing, 'Curly tags must be formatted'],
    getMatches: (entry) =>
      deps.hasCurlySpacingViolation(entry.text)
        ? deps.getCurlySpacingMatches(entry.text)
        : [],
    fix: (text) => deps.fixCurlySpacing(text)
  },
  {
    id: 'angle-tag-spacing',
    reason: deps.reasons.angleTagSpacing,
    severity: deps.ruleSeverity,
    markers: [deps.reasons.angleTagSpacing, 'Angle tags must be spaced'],
    getMatches: (entry) => deps.getAngleTagSpacingMatches(entry.text),
    fix: (text) => deps.fixAngleTagSpacing(text)
  },
  {
    id: 'square-bracket-tag-spacing',
    reason: deps.reasons.squareBracketTagSpacing,
    severity: deps.ruleSeverity,
    markers: [
      deps.reasons.squareBracketTagSpacing,
      'Square bracket tags must be spaced'
    ],
    getMatches: (entry) => deps.getSquareBracketTagSpacingMatches(entry.text),
    fix: (text) => deps.fixSquareBracketTagSpacing(text)
  }
];
