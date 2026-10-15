// @ts-nocheck
import { NativeIntervalIndex } from './native-render-algorithms';

const componentTypes = new WeakMap();

/** Supplies indexed data to the verified native panel without replacing its body. */
export function prepareNativeTranscript(React, props, NativeTurn, tokenize) {
  let MemoNativeTurn = componentTypes.get(NativeTurn);
  if (!MemoNativeTurn) {
    MemoNativeTurn = React.memo(NativeTurn);
    componentTypes.set(NativeTurn, MemoNativeTurn);
  }
  const words = React.useMemo(() => {
    // Inclusive point queries are narrowed to the native half-open midpoint
    // rule below, retaining input order even when machine words overlap.
    return new NativeIntervalIndex(props.machineWords, word => (word.start + word.end) / 2, word => (word.start + word.end) / 2);
  }, [props.machineWords]);
  const issues = React.useMemo(() => {
    const grouped = new Map();
    for (const issue of props.lintIssues) {
      let list = grouped.get(issue.annotationId);
      if (!list) grouped.set(issue.annotationId, list = []);
      list.push(issue);
    }
    return grouped;
  }, [props.lintIssues]);
  const empty = React.useMemo(() => [], []);
  const rowCache = React.useMemo(() => new Map(), [props.playhead]);
  const indexed = React.useMemo(() => {
    const currentIds = new Set(), numbers = new Map(), machineWordsById = new Map(), lowConfidenceById = new Map();
    props.turns.forEach((turn, index) => {
      currentIds.add(turn.id);
      numbers.set(turn.id, index + 1);
      const text = typeof turn.content === 'string' ? turn.content : '';
      const start = turn.startTimeInSeconds ?? 0, end = turn.endTimeInSeconds ?? 0;
      const cached = rowCache.get(turn.id);
      const low = props.lowConfidence.getLowConfidenceIndices, acknowledgedIndices = props.lowConfidence.getAcknowledgedIndices;
      const tokens = cached?.text === text ? cached.tokens : tokenize(text);
      let lowConfidenceWords = cached?.lowConfidenceWords;
      if (!cached || cached.text !== text || cached.low !== low || cached.acknowledgedIndices !== acknowledgedIndices) {
        const acknowledged = new Set(acknowledgedIndices(turn.id));
        lowConfidenceWords = low(turn.id).filter(index => !acknowledged.has(index)).map(index => ({ index, word: tokens[index] ?? '' }));
      }
      const machineWords = cached && cached.start === start && cached.end === end && cached.words === words ? cached.machineWords :
        words.query(start, end, true).filter(word => { const midpoint = (word.start + word.end) / 2; return midpoint >= start && midpoint < end; });
      rowCache.set(turn.id, { text, tokens, start, end, low, acknowledgedIndices, words, lowConfidenceWords, machineWords });
      machineWordsById.set(turn.id, machineWords);
      lowConfidenceById.set(turn.id, lowConfidenceWords);
    });
    for (const id of rowCache.keys()) if (!currentIds.has(id)) rowCache.delete(id);
    return { numbers, words: machineWordsById, lowConfidenceWords: lowConfidenceById };
  }, [props.turns, props.lowConfidence.getLowConfidenceIndices, props.lowConfidence.getAcknowledgedIndices, words, rowCache]);
  const ordered = React.useMemo(() => [
    ...props.turns.map(turn => ({ kind: 'turn', time: turn.startTimeInSeconds ?? 0, turn })),
    ...props.ghosts.map(ghost => ({ kind: 'ghost', time: ghost.segmentInfo.startTimeInSeconds ?? 0, ghost }))
  ].sort((left, right) => left.time - right.time), [props.turns, props.ghosts]);
  return { ...indexed, issues, empty, ordered, Turn: MemoNativeTurn };
}
