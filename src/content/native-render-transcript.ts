// @ts-nocheck
import { NativeIntervalIndex } from './native-render-algorithms';

/** Index only the native midpoint assignment; the panel still owns its body. */
export function createNativeTranscriptWords() {
  let source, index;
  return (machineWords, turns) => {
    if (source !== machineWords) {
      source = machineWords;
      index = new NativeIntervalIndex(machineWords, word => (word.start + word.end) / 2, word => (word.start + word.end) / 2);
    }
    const result = new Map();
    for (const turn of turns) {
      const start = turn.startTimeInSeconds ?? 0, end = turn.endTimeInSeconds ?? 0;
      result.set(turn.id, index.query(start, end, true).filter(word => {
        const midpoint = (word.start + word.end) / 2;
        return midpoint >= start && midpoint < end;
      }));
    }
    return result;
  };
}

export function sameNativeWordMap(native, indexed) {
  if (!(native instanceof Map) || native.size !== indexed.size) return false;
  for (const [id, words] of indexed) {
    const actual = native.get(id);
    if (!Array.isArray(actual) || actual.length !== words.length || words.some((word, index) => actual[index] !== word)) return false;
  }
  return true;
}
