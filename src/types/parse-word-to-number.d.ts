declare module '@alordash/parse-word-to-number' {
  export function parseString(value: string, errorLimit?: number): string;

  const parseWordToNumber: {
    parseString: typeof parseString;
  };

  export default parseWordToNumber;
}
