import { test, expect } from '../../../shared/babel-extension-platform/packages/babel-extension-e2e/src/test.mjs';
import {
  feedbackCategoryKeys, seedFeedbackDraft, coldFeedbackReload, expectFeedbackRestored, expectFeedbackDiscarded,
} from '../../../shared/babel-extension-platform/packages/babel-extension-e2e/tests/e2e/native-helpers.mjs';
import { ready } from './helper-editing-utils.mjs';

// Canonical src/features/registry.ts setting keys -> executable browser scenario titles.
export const featureScenarios = {
  feedbackDraftRestore: [
    'feedbackDraftRestore: draft-first cold reload restores persisted L2 feedback and submission readiness',
    'feedbackDraftRestore: disabling the feature reproduces the captured-native draft-first loss',
  ],
};

// The captured native draft hook parses getOrCreateDraft exactly once with whatever input definitions
// it holds at that moment; both journeys force the draft to resolve before the cold definitions.

test(featureScenarios.feedbackDraftRestore[0], async ({ page, babel }) => {
  const persisted = await seedFeedbackDraft(babel);
  await ready(page);
  await coldFeedbackReload(page, babel, async ({ panel, loading, deliverDraft, deliverInputs }) => {
    await ready(page);
    await deliverDraft();
    // Helper holds the resolved draft: the native mutation must not complete before the definitions land.
    await expect(loading).toBeVisible();
    await deliverInputs();
    await expect(loading).toHaveCount(0);
    await expectFeedbackRestored(page, panel);
    // Released by observing the committed definitions in the native hook, not by the bounded fallback.
    await expect.poll(() => page.evaluate(() => window.__babelHelperLinterBridge?.debug?.feedbackDraftRestore?.last?.reason)).toBe('committed');
    expect((await babel.state()).feedbackDraft.inputResponses).toEqual(persisted);
  });
});

test(featureScenarios.feedbackDraftRestore[1], async ({ page, babel }) => {
  const persisted = await seedFeedbackDraft(babel);
  await ready(page);
  await babel.setExtensionSettings('helper', { features: { feedbackDraftRestore: false } });
  await coldFeedbackReload(page, babel, async ({ panel, loading, deliverDraft, deliverInputs }) => {
    await ready(page);
    await deliverDraft();
    // Unheld, the native draft mutation completes without definitions and discards the responses.
    await expect(loading).toHaveCount(0);
    await expect(panel.getByPlaceholder('Provide specific feedback...')).toHaveCount(feedbackCategoryKeys.length);
    await deliverInputs();
    await expectFeedbackDiscarded(page, panel);
    // The loss is client-side only: the persisted draft is untouched.
    expect((await babel.state()).feedbackDraft.inputResponses).toEqual(persisted);
  });
});
