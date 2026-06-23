type ChromeEventLike<Listener> = {
  addListener: (listener: Listener) => void;
  removeListener?: (listener: Listener) => void;
};

type ChromePortLike = {
  onMessage: ChromeEventLike<(message: GoldDraftingAiBrokerPortMessage | null | undefined) => void>;
  onDisconnect: ChromeEventLike<() => void>;
  postMessage: (message: Record<string, unknown>) => void;
  disconnect: () => void;
};

type ChromeRuntimeLike = {
  connect: (extensionId: string, connectInfo: { name: string }) => ChromePortLike;
  sendMessage: (
    extensionId: string,
    message: Record<string, unknown>,
    responseCallback: (response: GoldDraftingAiBrokerResult | null | undefined) => void
  ) => void;
  lastError?: { message?: string };
};

declare const chrome: {
  runtime: ChromeRuntimeLike;
};

export const AI_BROKER_EXTENSION_ID_ATTR = 'data-babel-gold-drafting-extension-id';

const GOLD_DRAFTING_PRODUCTION_EXTENSION_ID = 'difidgnhacblcogknnfbeedghjpccohh';
const AI_BROKER_EXTERNAL_MESSAGE_TYPE = 'babel-gold-drafting:ai-broker';
const AI_BROKER_PORT_NAME = 'babel-gold-drafting:ai-broker-port';
const AI_BROKER_CLIENT_BUILD = 'port-stream-postmortem-2026-06-23';
const AI_BROKER_CLIENT_BUILD_ATTR = 'data-babel-helper-ai-broker-build';
const AI_BROKER_VERSION = 1;
const PING_BROKER_TIMEOUT_MS = 5000;
const TRANSCRIBE_SEGMENT_BROKER_TIMEOUT_MS = 300000;
const REDISTRIBUTE_TEXT_BROKER_TIMEOUT_MS = 120000;
const GOLD_DRAFTING_BROKER_PORT_IDLE_TIMEOUT_MS = 20000;

export type GoldDraftingAiBrokerPayload = {
  operation: 'ping' | 'transcribeSegment' | 'redistributeText';
  [key: string]: unknown;
};

export type GoldDraftingAiBrokerResult = {
  ok: boolean;
  fallbackAllowed?: boolean;
  reason?: string;
  message?: string;
  [key: string]: unknown;
};

export type GoldDraftingAiBrokerEvent = {
  type: 'event';
  event: 'accepted' | 'capturing-audio' | 'calling-backend' | 'backend-waiting';
  operation?: GoldDraftingAiBrokerPayload['operation'];
  message?: string;
  elapsedMs?: number;
  [key: string]: unknown;
};

type GoldDraftingAiBrokerPortMessage =
  | GoldDraftingAiBrokerEvent
  | {
      type: 'result';
      response: GoldDraftingAiBrokerResult | null | undefined;
      [key: string]: unknown;
    }
  | {
      type: 'error';
      response?: GoldDraftingAiBrokerResult | null | undefined;
      reason?: string;
      message?: string;
      fallbackAllowed?: boolean;
      [key: string]: unknown;
    };

export type GoldDraftingAiBrokerOptions = {
  onEvent?: (event: GoldDraftingAiBrokerEvent) => void;
};

function hasChromeRuntime(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime) &&
    (typeof chrome.runtime.connect === 'function' || typeof chrome.runtime.sendMessage === 'function')
  );
}

function canUseGoldDraftingAiBrokerPort(): boolean {
  return hasChromeRuntime() && typeof chrome.runtime.connect === 'function';
}

function publishGoldDraftingAiBrokerClientBuild(): void {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }

  document.documentElement.setAttribute(AI_BROKER_CLIENT_BUILD_ATTR, AI_BROKER_CLIENT_BUILD);
}

function readGoldDraftingExtensionId(): string {
  if (typeof document === 'undefined' || !document.documentElement) {
    return '';
  }

  const rawExtensionId = document.documentElement.getAttribute(AI_BROKER_EXTENSION_ID_ATTR);
  const extensionId = typeof rawExtensionId === 'string' ? rawExtensionId.trim() : '';
  return extensionId || GOLD_DRAFTING_PRODUCTION_EXTENSION_ID;
}

publishGoldDraftingAiBrokerClientBuild();

function reportGoldDraftingAiBrokerFailure(
  payload: GoldDraftingAiBrokerPayload,
  extensionId: string,
  result: GoldDraftingAiBrokerResult
): void {
  if (typeof console === 'undefined' || typeof console.error !== 'function') {
    return;
  }

  console.error('[Babel Helper] Gold Drafting AI broker failed', {
    operation: payload.operation,
    extensionId,
    reason: result.reason || 'unknown',
    message: result.message || '',
    fallbackAllowed: result.fallbackAllowed !== false,
    response: result
  });
}

function getGoldDraftingAiBrokerTimeoutMs(payload: GoldDraftingAiBrokerPayload): number {
  if (payload.operation === 'transcribeSegment') {
    return TRANSCRIBE_SEGMENT_BROKER_TIMEOUT_MS;
  }
  if (payload.operation === 'redistributeText') {
    return REDISTRIBUTE_TEXT_BROKER_TIMEOUT_MS;
  }
  return PING_BROKER_TIMEOUT_MS;
}

function getGoldDraftingBrokerFailureReason(response: GoldDraftingAiBrokerResult): string {
  return typeof response.reason === 'string' && response.reason.trim()
    ? response.reason.trim()
    : 'gold-drafting-broker-empty-error-response';
}

function normalizeBrokerResponse(response: GoldDraftingAiBrokerResult | null | undefined): GoldDraftingAiBrokerResult {
  if (!response || typeof response !== 'object') {
    return {
      ok: false,
      reason: 'invalid-gold-drafting-broker-response',
      fallbackAllowed: true
    };
  }

  if (response.ok) {
    return response;
  }

  const reason = getGoldDraftingBrokerFailureReason(response);
  return {
    ...response,
    ok: false,
    reason,
    message:
      typeof response.message === 'string' && response.message.trim()
        ? response.message.trim()
        : `Gold Drafting broker returned an error response without a message. Reason: ${reason}.`,
    fallbackAllowed: response.fallbackAllowed !== false
  };
}

async function requestGoldDraftingAiBrokerViaPort(
  extensionId: string,
  payload: GoldDraftingAiBrokerPayload,
  options: GoldDraftingAiBrokerOptions
): Promise<GoldDraftingAiBrokerResult | null> {
  let port: ChromePortLike;
  try {
    port = chrome.runtime.connect(extensionId, { name: AI_BROKER_PORT_NAME });
  } catch (error) {
    const result = {
      ok: false,
      reason: 'gold-drafting-broker-connect-failed',
      message: error instanceof Error ? error.message : String(error),
      fallbackAllowed: true
    };
    reportGoldDraftingAiBrokerFailure(payload, extensionId, result);
    return result;
  }

  return new Promise((resolve) => {
    let settled = false;
    let idleTimeoutId: number | null = null;
    let lastBrokerActivity = 'opening-port';
    function resetGoldDraftingBrokerPortIdleTimeout(activity: string): void {
      lastBrokerActivity = activity;
      if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
      }
      idleTimeoutId = window.setTimeout(() => {
        finish({
          ok: false,
          reason: 'gold-drafting-broker-port-idle-timeout',
          message:
            `Gold Drafting AI broker port went silent for ${GOLD_DRAFTING_BROKER_PORT_IDLE_TIMEOUT_MS}ms while waiting for ${payload.operation}. Last broker activity: ${lastBrokerActivity}.`,
          fallbackAllowed: true
        });
      }, GOLD_DRAFTING_BROKER_PORT_IDLE_TIMEOUT_MS);
    }

    const finish = (result: GoldDraftingAiBrokerResult | null, disconnectPort = true) => {
      if (settled) {
        return;
      }
      settled = true;
      if (idleTimeoutId !== null) {
        window.clearTimeout(idleTimeoutId);
        idleTimeoutId = null;
      }
      const finalResult = result && !result.ok
        ? {
            ...result,
            operation: payload.operation,
            extensionId
          }
        : result;
      if (finalResult && !finalResult.ok) {
        reportGoldDraftingAiBrokerFailure(payload, extensionId, finalResult);
      }
      if (disconnectPort) {
        try {
          port.disconnect();
        } catch (_error) {
          // The port may already be closed by Chrome.
        }
      }
      resolve(finalResult);
    };

    try {
      resetGoldDraftingBrokerPortIdleTimeout('listeners-attached');
      port.onMessage.addListener((message) => {
        if (!message || typeof message !== 'object') {
          resetGoldDraftingBrokerPortIdleTimeout('invalid-message');
          finish({
            ok: false,
            reason: 'invalid-gold-drafting-broker-port-message',
            fallbackAllowed: true
          });
          return;
        }

        resetGoldDraftingBrokerPortIdleTimeout(
          message.type === 'event' && typeof message.event === 'string'
            ? message.event
            : String(message.type || 'unknown-message')
        );

        if (message.type === 'event') {
          try {
            options.onEvent?.(message);
          } catch (error) {
            if (typeof console !== 'undefined' && typeof console.error === 'function') {
              console.error('[Babel Helper] Gold Drafting AI broker progress handler failed', {
                operation: payload.operation,
                extensionId,
                errorName: error instanceof Error ? error.name : '',
                errorMessage: error instanceof Error ? error.message : String(error),
                error
              });
            }
          }
          return;
        }

        if (message.type === 'result') {
          finish(normalizeBrokerResponse(message.response));
          return;
        }

        if (message.type === 'error') {
          finish(
            normalizeBrokerResponse(
              message.response || {
                ok: false,
                reason: message.reason || 'gold-drafting-broker-error',
                message: message.message || 'Gold Drafting AI broker returned an error.',
                fallbackAllowed: message.fallbackAllowed !== false
              }
            )
          );
          return;
        }

        finish({
          ok: false,
          reason: 'unknown-gold-drafting-broker-port-message',
          fallbackAllowed: true
        });
      });

      port.onDisconnect.addListener(() => {
        const runtimeError = chrome.runtime.lastError;
        finish(
          {
            ok: false,
            reason: 'gold-drafting-broker-disconnected',
            message: runtimeError?.message || 'Gold Drafting AI broker port disconnected before returning a result.',
            fallbackAllowed: true
          },
          false
        );
      });

      port.postMessage({
        ...payload,
        type: AI_BROKER_EXTERNAL_MESSAGE_TYPE,
        version: AI_BROKER_VERSION
      });
      resetGoldDraftingBrokerPortIdleTimeout('request-posted');
    } catch (error) {
      finish({
        ok: false,
        reason: 'gold-drafting-broker-port-error',
        message: error instanceof Error ? error.message : String(error),
        fallbackAllowed: true
      });
    }
  });
}

async function requestGoldDraftingAiBrokerViaMessage(
  extensionId: string,
  payload: GoldDraftingAiBrokerPayload
): Promise<GoldDraftingAiBrokerResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutMs = getGoldDraftingAiBrokerTimeoutMs(payload);
    const finish = (result: GoldDraftingAiBrokerResult | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      if (result && !result.ok) {
        reportGoldDraftingAiBrokerFailure(payload, extensionId, result);
      }
      resolve(result);
    };
    const timeoutId = window.setTimeout(
      () =>
        finish({
          ok: false,
          reason: 'gold-drafting-broker-timeout',
          message: `Gold Drafting AI broker timed out after ${timeoutMs}ms.`,
          fallbackAllowed: true
        }),
      timeoutMs
    );

    try {
      if (typeof chrome.runtime.sendMessage !== 'function') {
        finish({
          ok: false,
          reason: 'gold-drafting-broker-send-message-unavailable',
          message: 'Chrome runtime sendMessage is unavailable for the Gold Drafting AI broker fallback.',
          fallbackAllowed: true
        });
        return;
      }

      chrome.runtime.sendMessage(
        extensionId,
        {
          ...payload,
          type: AI_BROKER_EXTERNAL_MESSAGE_TYPE,
          version: AI_BROKER_VERSION
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            finish({
              ok: false,
              reason: 'gold-drafting-broker-unavailable',
              message: runtimeError.message || 'Gold Drafting AI broker is unavailable.',
              fallbackAllowed: true
            });
            return;
          }

          finish(normalizeBrokerResponse(response));
        }
      );
    } catch (error) {
      finish({
        ok: false,
        reason: 'gold-drafting-broker-error',
        message: error instanceof Error ? error.message : String(error),
        fallbackAllowed: true
      });
    }
  });
}

export async function requestGoldDraftingAiBroker(
  payload: GoldDraftingAiBrokerPayload,
  options: GoldDraftingAiBrokerOptions = {}
): Promise<GoldDraftingAiBrokerResult | null> {
  publishGoldDraftingAiBrokerClientBuild();
  const extensionId = readGoldDraftingExtensionId();
  if (!extensionId) {
    reportGoldDraftingAiBrokerFailure(payload, extensionId, {
      ok: false,
      reason: 'gold-drafting-broker-marker-missing',
      message:
        'Gold Drafting did not publish its extension id on this page. Reload Gold Drafting and refresh the Babel tab.',
      fallbackAllowed: true
    });
    return null;
  }
  if (!hasChromeRuntime()) {
    reportGoldDraftingAiBrokerFailure(payload, extensionId, {
      ok: false,
      reason: 'chrome-runtime-unavailable',
      message: 'Chrome runtime messaging is unavailable in this Helper context.',
      fallbackAllowed: true
    });
    return null;
  }

  if (canUseGoldDraftingAiBrokerPort()) {
    return requestGoldDraftingAiBrokerViaPort(extensionId, payload, options);
  }

  return requestGoldDraftingAiBrokerViaMessage(extensionId, payload);
}
