import type { TextRange, TranscriptTextContext } from './text-context';

export type AnnotationEntry = {
  annotationId: string;
  reviewActionId?: string;
  text: string;
  speakerKey?: string;
  assertedWarnings?: string[];
};

export type LinterRuleContext = {
  annotationEntries: AnnotationEntry[];
  index: number;
  textContext?: TranscriptTextContext;
  previousSameSpeakerText?: string;
};

export type LinterRule = {
  id: string;
  reason: string;
  severity: string;
  markers: string[];
  getMatches(entry: AnnotationEntry, context: LinterRuleContext): TextRange[];
  fix?(text: string, context: Partial<LinterRuleContext>): string;
};

export type TooltipEntry = {
  reason: string;
  matches: string[];
  ranges: TextRange[];
};

type RegistryOptions = {
  createTextContext?: (text: string) => TranscriptTextContext;
  disabledRuleIds?: string[];
  onRuleError?: (
    error: unknown,
    rule: LinterRule,
    entry: AnnotationEntry,
    context: LinterRuleContext
  ) => void;
};

function isRuleEnabled(rule: LinterRule, options: RegistryOptions): boolean {
  if (!Array.isArray(options.disabledRuleIds) || !rule || typeof rule.id !== 'string') {
    return true;
  }

  return !options.disabledRuleIds.includes(rule.id);
}

function createRuleContext(
  entry: AnnotationEntry,
  annotationEntries: AnnotationEntry[],
  index: number,
  options: RegistryOptions
): LinterRuleContext {
  return {
    annotationEntries,
    index,
    textContext: options.createTextContext?.(entry.text)
  };
}

export function buildRegistryIssues<TIssue>(
  annotationEntries: AnnotationEntry[],
  rules: LinterRule[],
  makeIssue: (entry: AnnotationEntry, rule: LinterRule, matches: TextRange[]) => TIssue,
  options: RegistryOptions = {}
): TIssue[] {
  const issues: TIssue[] = [];
  if (!Array.isArray(annotationEntries) || !Array.isArray(rules)) {
    return issues;
  }

  for (let index = 0; index < annotationEntries.length; index += 1) {
    const entry = annotationEntries[index];
    if (!entry || typeof entry.annotationId !== 'string') {
      continue;
    }

    const context = createRuleContext(entry, annotationEntries, index, options);
    for (const rule of rules) {
      if (!isRuleEnabled(rule, options)) {
        continue;
      }

      let matches: TextRange[];
      try {
        const result = rule.getMatches(entry, context);
        if (!Array.isArray(result)) {
          throw new TypeError(`Custom linter rule "${rule.id}" returned a non-array match result.`);
        }
        matches = result;
      } catch (error) {
        options.onRuleError?.(error, rule, entry, context);
        continue;
      }

      if (!matches.length) {
        continue;
      }

      try {
        issues.push(makeIssue(entry, rule, matches));
      } catch (error) {
        options.onRuleError?.(error, rule, entry, context);
      }
    }
  }

  return issues;
}

export function getVisibleTooltipEntries(
  rowText: string,
  bodyText: string,
  rules: LinterRule[],
  options: RegistryOptions = {}
): TooltipEntry[] {
  if (!rowText || !Array.isArray(rules)) {
    return [];
  }

  const entry: AnnotationEntry = {
    annotationId: '',
    reviewActionId: '',
    text: rowText
  };
  const context = createRuleContext(entry, [entry], 0, options);
  const entries: TooltipEntry[] = [];

  for (const rule of rules) {
    if (!isRuleEnabled(rule, options)) {
      continue;
    }

    if (!rule.markers.some((marker) => bodyText.includes(marker))) {
      continue;
    }

    const ranges = rule.getMatches(entry, context);
    if (ranges.length) {
      entries.push({
        reason: rule.reason,
        matches: ranges.map((match) => match.text).filter(Boolean),
        ranges
      });
    }
  }

  return entries;
}

export function applyRuleFixes(
  text: string,
  rules: LinterRule[],
  context: Partial<LinterRuleContext> = {},
  options: RegistryOptions = {}
): string {
  if (typeof text !== 'string' || !Array.isArray(rules)) {
    return text;
  }

  let result = text;
  for (const rule of rules) {
    if (!isRuleEnabled(rule, options)) {
      continue;
    }

    if (typeof rule.fix === 'function') {
      result = rule.fix(result, context);
    }
  }

  return result;
}
