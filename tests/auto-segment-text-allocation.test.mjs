import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function loadAllocatorModule() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/services/auto-segment-text-allocation.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

function joinedText(allocations) {
  return allocations.map((allocation) => allocation.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

test('auto-segment text allocator assigns sentence units by duration and preserves exact text', async () => {
  const { createAutoSegmentTextRedistributionDraft } = await loadAllocatorModule();
  const longSentence =
    'Да, конечно, я с удовольствием с тобой тему обсужу и надеюсь, что мы найдём спокойный способ начать откладывать деньги без резких движений.';
  const fullText = `Да. ${longSentence} Хорошо.`;
  const draft = createAutoSegmentTextRedistributionDraft({
    speakerKey: 'speaker-1',
    fullText,
    segments: [
      { id: 'short-yes', speakerKey: 'speaker-1', startSeconds: 10, endSeconds: 10.4 },
      { id: 'long-answer', speakerKey: 'speaker-1', startSeconds: 20, endSeconds: 29.8 },
      { id: 'short-ok', speakerKey: 'speaker-1', startSeconds: 35, endSeconds: 35.7 }
    ]
  });

  assert.equal(draft.ok, true);
  assert.deepEqual(draft.allocations.map((allocation) => allocation.text), ['Да.', longSentence, 'Хорошо.']);
  assert.equal(joinedText(draft.allocations), fullText);
});

test('auto-segment text allocator rejects mixed speaker groups', async () => {
  const { createAutoSegmentTextRedistributionDraft } = await loadAllocatorModule();
  const draft = createAutoSegmentTextRedistributionDraft({
    speakerKey: 'speaker-1',
    fullText: 'Да. Нет.',
    segments: [
      { id: 'one', speakerKey: 'speaker-1', startSeconds: 0, endSeconds: 1 },
      { id: 'two', speakerKey: 'speaker-2', startSeconds: 1, endSeconds: 2 }
    ]
  });

  assert.equal(draft.ok, false);
  assert.equal(draft.reason, 'mixed-speaker-group');
});

test('auto-segment text review applies only adjacent whole-sentence moves', async () => {
  const { applyAutoSegmentTextReview } = await loadAllocatorModule();
  const group = {
    speakerKey: 'speaker-1',
    fullText: 'Первое. Второе. Третье.',
    segments: [
      { id: 'one', speakerKey: 'speaker-1', startSeconds: 0, endSeconds: 2 },
      { id: 'two', speakerKey: 'speaker-1', startSeconds: 2, endSeconds: 4 }
    ]
  };
  const draftAllocations = [
    { id: 'one', text: 'Первое. Второе.' },
    { id: 'two', text: 'Третье.' }
  ];

  const result = applyAutoSegmentTextReview(group, draftAllocations, {
    acceptDraft: false,
    moves: [{ fromIndex: 1, toIndex: 2, sentenceCount: 1 }],
    notes: 'Move the trailing sentence.'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.allocations.map((allocation) => allocation.text), ['Первое.', 'Второе. Третье.']);
  assert.equal(joinedText(result.allocations), group.fullText);
});

test('auto-segment text review rejects non-adjacent or text-losing moves', async () => {
  const { applyAutoSegmentTextReview } = await loadAllocatorModule();
  const group = {
    speakerKey: 'speaker-1',
    fullText: 'Первое. Второе. Третье.',
    segments: [
      { id: 'one', speakerKey: 'speaker-1', startSeconds: 0, endSeconds: 1 },
      { id: 'two', speakerKey: 'speaker-1', startSeconds: 1, endSeconds: 2 },
      { id: 'three', speakerKey: 'speaker-1', startSeconds: 2, endSeconds: 3 }
    ]
  };
  const draftAllocations = [
    { id: 'one', text: 'Первое.' },
    { id: 'two', text: 'Второе.' },
    { id: 'three', text: 'Третье.' }
  ];

  const nonAdjacent = applyAutoSegmentTextReview(group, draftAllocations, {
    acceptDraft: false,
    moves: [{ fromIndex: 1, toIndex: 3, sentenceCount: 1 }],
    notes: ''
  });
  const tooManySentences = applyAutoSegmentTextReview(group, draftAllocations, {
    acceptDraft: false,
    moves: [{ fromIndex: 1, toIndex: 2, sentenceCount: 2 }],
    notes: ''
  });

  assert.equal(nonAdjacent.ok, false);
  assert.equal(nonAdjacent.reason, 'invalid-review-move');
  assert.equal(tooManySentences.ok, false);
  assert.equal(tooManySentences.reason, 'invalid-review-move');
});
