import { readFileSync } from 'node:fs';

const sources = JSON.parse(readFileSync(new URL('./native-factories.json', import.meta.url), 'utf8'));

export function nativeFactorySource(id) {
  const source = sources[id];
  if (typeof source !== 'string') throw new Error(`Missing captured native factory: ${id}`);
  return source;
}
