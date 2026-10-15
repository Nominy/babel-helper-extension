import type { ReplacementRule, ReplacementStatus, ReplacementResult } from '../core/replacement-rules';

export interface NativeFindReplaceClient {
  getNativeReplacementStatus(): Promise<ReplacementStatus>;
  runNativeReplacementRules(request: { sessionId: string; rules: ReplacementRule[] }): Promise<ReplacementResult>;
  recoverNativeReplacementRules(request: { sessionId: string }): Promise<ReplacementResult>;
}

function parseStatus(value: unknown): ReplacementStatus {
  if (!value || typeof value !== 'object') throw new Error('Native replacement service did not respond.');
  if (!('ok' in value) || value.ok !== true) {
    const reason = 'error' in value ? value.error : 'reason' in value ? value.reason : null;
    throw new Error(typeof reason === 'string' ? reason : 'Native replacement command was rejected.');
  }
  if (!('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId ||
      !('segmentCount' in value) || typeof value.segmentCount !== 'number' || !Number.isSafeInteger(value.segmentCount) || value.segmentCount < 0 ||
      !('canRecover' in value) || typeof value.canRecover !== 'boolean') {
    throw new Error('Native replacement status is invalid.');
  }
  return { ok: true, sessionId: value.sessionId, segmentCount: value.segmentCount, canRecover: value.canRecover };
}

function parseResult(value: unknown): ReplacementResult {
  const status = parseStatus(value);
  if (!value || typeof value !== 'object' ||
      !('count' in value) || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0 ||
      !('changedRows' in value) || typeof value.changedRows !== 'number' || !Number.isSafeInteger(value.changedRows) || value.changedRows < 0) {
    throw new Error('Native replacement result is invalid.');
  }
  return { ...status, count: value.count, changedRows: value.changedRows };
}

export function createNativeFindReplaceClient(
  callBridge: (operation: string, payload: unknown) => Promise<unknown>
): NativeFindReplaceClient {
  return {
    async getNativeReplacementStatus() { return parseStatus(await callBridge('native-replacement-status', null)); },
    async runNativeReplacementRules(request) { return parseResult(await callBridge('run-native-replacement-rules', request)); },
    async recoverNativeReplacementRules(request) { return parseResult(await callBridge('recover-native-replacement-rules', request)); }
  };
}
