import type { LinterRule } from '../rule-registry';
import { createLanguageRules } from './language-rules';
import { createPunctuationRules } from './punctuation-rules';
import { createSpacingRules } from './spacing-rules';
import type { CustomLinterRuleDependencies } from './types';

export type { CustomLinterRuleDependencies } from './types';

export function createCustomLinterRules(deps: CustomLinterRuleDependencies): LinterRule[] {
  return [
    ...createSpacingRules(deps),
    ...createPunctuationRules(deps),
    ...createLanguageRules(deps)
  ];
}
