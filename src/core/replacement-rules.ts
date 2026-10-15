export const REPLACEMENT_RULES_STORAGE_KEY = 'babelHelperReplacementRules';
export const REPLACEMENT_MESSAGE_TYPE = 'babel-helper:replacement-rules';

export interface ReplacementRule {
  id: string;
  find: string;
  replace: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  enabled: boolean;
}

export interface ReplacementStatus {
  ok: true;
  sessionId: string;
  segmentCount: number;
  canRecover: boolean;
}

export interface ReplacementResult extends ReplacementStatus {
  count: number;
  changedRows: number;
}

/** Validate the storage/message boundary without compiling unused expressions. */
export function parseReplacementRules(value: unknown): ReplacementRule[] {
  if (!Array.isArray(value)) throw new Error('Replacement rules must be an array.');
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !('id' in item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        !('find' in item) || typeof item.find !== 'string' || !item.find ||
        !('replace' in item) || typeof item.replace !== 'string' ||
        !('regex' in item) || typeof item.regex !== 'boolean' ||
        !('caseSensitive' in item) || typeof item.caseSensitive !== 'boolean' ||
        !('wholeWord' in item) || typeof item.wholeWord !== 'boolean' ||
        !('enabled' in item) || typeof item.enabled !== 'boolean') {
      throw new Error('Invalid replacement rule.');
    }
    ids.add(item.id);
    return { id: item.id, find: item.find, replace: item.replace,
      regex: item.regex, caseSensitive: item.caseSensitive, wholeWord: item.wholeWord, enabled: item.enabled };
  });
}

export function compileReplacementRule(rule: ReplacementRule): RegExp {
  let source = rule.regex ? rule.find : rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (rule.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(source, rule.caseSensitive ? 'gmu' : 'gmiu'); }
  catch (error) { throw new Error(`Invalid expression for “${rule.find}”: ${error instanceof Error ? error.message : String(error)}`); }
}

export interface CompiledReplacementRule {
  readonly expression: RegExp;
  readonly replace: string;
  readonly regex: boolean;
}

/** Compile the entire enabled batch before touching any native segment. */
export function compileReplacementRules(value: unknown): CompiledReplacementRule[] {
  return parseReplacementRules(value).filter(rule => rule.enabled).map(rule => ({
    expression: compileReplacementRule(rule), replace: rule.replace, regex: rule.regex
  }));
}

/** Apply a precompiled batch in saved order to raw text, including tag syntax. */
export function replaceTextWithRules(text: string, rules: readonly CompiledReplacementRule[]): { text: string; count: number } {
  let count = 0;
  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    text = text.replace(rule.expression, (...args: unknown[]) => {
      count++;
      if (!rule.regex) return rule.replace;
      const last = args[args.length - 1];
      const named = last !== null && typeof last === 'object' ? last : null;
      const captureEnd = args.length - (named ? 3 : 2);
      const offset = args[captureEnd];
      const input = args[captureEnd + 1];
      return rule.replace.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (token: string, group: string) => {
        if (group === '$') return '$';
        if (group === '`') return typeof input === 'string' && typeof offset === 'number' ? input.slice(0, offset) : token;
        if (group === "'") return typeof input === 'string' && typeof offset === 'number' && typeof args[0] === 'string'
          ? input.slice(offset + args[0].length) : token;
        if (group.startsWith('<')) {
          if (!named) return token;
          const capture: unknown = Reflect.get(named, group.slice(1, -1));
          return typeof capture === 'string' ? capture : '';
        }
        const index = group === '&' ? 0 : Number(group);
        if (index < captureEnd) {
          const capture = args[index];
          return typeof capture === 'string' ? capture : '';
        }
        // Like String.replace, $12 becomes capture 1 + "2" when capture 12 is absent.
        const first = Number(group[0]);
        if (group.length === 2 && first > 0 && first < captureEnd) {
          return `${typeof args[first] === 'string' ? args[first] : ''}${group[1]}`;
        }
        return token;
      });
    });
  }
  return { text, count };
}
