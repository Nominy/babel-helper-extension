export type BaselineResetFailure = { ok: false; reason: string; message?: string };
export type BaselineResetSummary = { ok: true; level: 0 | 1; segmentCount: number; reviewActionId: string; baselineReviewActionId: string };
export type PreparedBaselineReset = BaselineResetSummary & { token: string };
type Bridge = (operation: string, payload: unknown, timeoutMs?: number) => Promise<unknown>;

function failure(value: unknown): BaselineResetFailure | null {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'baseline-service-unavailable' };
  if (!('ok' in value) || value.ok !== true) {
    return { ok: false, reason: 'reason' in value && typeof value.reason === 'string' ? value.reason : 'baseline-request-rejected',
      ...('message' in value && typeof value.message === 'string' ? { message: value.message } : {}) };
  }
  return null;
}

function summary(value: unknown, expected: string): value is BaselineResetSummary {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<BaselineResetSummary>;
  return data.ok === true && (data.level === 0 || data.level === 1) && Number.isSafeInteger(data.segmentCount) && data.segmentCount! >= 0 &&
    data.reviewActionId === expected && typeof data.baselineReviewActionId === 'string' && Boolean(data.baselineReviewActionId) && data.baselineReviewActionId !== expected;
}

export function createNativeBaselineResetClient(callBridge: Bridge) {
  return {
    async prepareBaselineReset(request: { expectedReviewActionId: string }): Promise<PreparedBaselineReset | BaselineResetFailure> {
      const value = await callBridge('prepare-baseline-reset', { ...request, deadlineAt: Date.now() + 23_000 }, 25_000);
      const error = failure(value);
      if (error) return error;
      if (!summary(value, request.expectedReviewActionId) || !('token' in value) || typeof value.token !== 'string' || !value.token) {
        if (value && typeof value === 'object' && 'token' in value && typeof value.token === 'string') {
          await callBridge('discard-baseline-reset', { token: value.token });
        }
        return { ok: false, reason: 'baseline-response-invalid' };
      }
      return { ok: true, token: value.token, level: value.level, segmentCount: value.segmentCount,
        reviewActionId: value.reviewActionId, baselineReviewActionId: value.baselineReviewActionId };
    },
    async applyBaselineReset(request: { token: string; expectedReviewActionId: string }): Promise<BaselineResetSummary | BaselineResetFailure> {
      const value = await callBridge('apply-baseline-reset', { ...request, deadlineAt: Date.now() + 7_000 }, 9_000);
      const error = failure(value);
      if (error) return error;
      if (!summary(value, request.expectedReviewActionId)) return { ok: false, reason: 'baseline-response-invalid' };
      return { ok: true, level: value.level, segmentCount: value.segmentCount,
        reviewActionId: value.reviewActionId, baselineReviewActionId: value.baselineReviewActionId };
    },
    async discardBaselineReset(request: { token: string }): Promise<{ ok: true } | BaselineResetFailure> {
      const value = await callBridge('discard-baseline-reset', request);
      return failure(value) || { ok: true };
    }
  };
}
