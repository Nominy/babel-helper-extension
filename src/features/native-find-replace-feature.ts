import type { FeatureContext, FeatureModule } from '../core/types';
import { NATIVE_COMPATIBILITY_CHANGE_EVENT, NATIVE_FIND_REPLACE_ATTRIBUTE } from '../core/native-compatibility';
import { REPLACEMENT_MESSAGE_TYPE, parseReplacementRules } from '../core/replacement-rules';
import type { NativeFindReplaceClient } from '../services/native-find-replace-client';

interface ReplacementHelper extends NativeFindReplaceClient {
  state: { nativeSessionAdmission?: object | null };
  runtime: { isSessionInteractive(): boolean };
}
type MessageListener = (message: unknown, sender: { id?: string; url?: string }, respond: (response: unknown) => void) => boolean | undefined;
declare const chrome: {
  runtime: {
    id: string;
    getURL(path: string): string;
    onMessage: { addListener(listener: MessageListener): void; removeListener(listener: MessageListener): void };
  };
};

/** Only the extension popup may request native replacements; no page UI or DOM observer. */
export function createNativeFindReplaceFeature(): FeatureModule {
  let helper: ReplacementHelper;
  let active = false;
  let busy = false;

  async function execute(message: unknown): Promise<unknown> {
    if (!active || !helper.runtime.isSessionInteractive() || !helper.state.nativeSessionAdmission) {
      throw new Error('Open a writable Babel transcription task first.');
    }
    if (!message || typeof message !== 'object' || !('operation' in message)) throw new Error('Invalid replacement command.');
    if (message.operation === 'status') return helper.getNativeReplacementStatus();
    if (message.operation !== 'run' && message.operation !== 'recover') throw new Error('Unknown replacement command.');
    if (!('sessionId' in message) || typeof message.sessionId !== 'string' || !message.sessionId) {
      throw new Error('Reopen the replacement menu for the current task.');
    }
    const sessionId = message.sessionId;
    const rules = message.operation === 'run'
      ? parseReplacementRules('rules' in message ? message.rules : undefined) : null;
    const admission = helper.state.nativeSessionAdmission;
    const editor = document.activeElement?.closest<HTMLElement>('[data-slate-editor="true"]');
    // The Chrome popup need not blur the focused DOM element. Use Babel's own
    // blur handler, then let its queued React commit finish before the request.
    editor?.blur();
    await Promise.resolve();
    if (!active || admission !== helper.state.nativeSessionAdmission || !helper.runtime.isSessionInteractive()) {
      throw new Error('The native editor session changed before replacement.');
    }
    return rules ? helper.runNativeReplacementRules({ sessionId, rules })
      : helper.recoverNativeReplacementRules({ sessionId });
  }

  const onMessage: MessageListener = (message, sender, respond) => {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== REPLACEMENT_MESSAGE_TYPE) return;
    if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('popup.html')) {
      respond({ ok: false, error: 'Replacement commands must come from the Helper popup.' });
      return false;
    }
    if (busy) { respond({ ok: false, error: 'A replacement command is already running.' }); return false; }
    busy = true;
    void execute(message).then(respond, (error: unknown) => {
      respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { busy = false; });
    return true;
  };

  function activate(ctx: FeatureContext): void {
    helper = ctx.helper;
    if (!active) { chrome.runtime.onMessage.addListener(onMessage); active = true; }
    document.documentElement.setAttribute(NATIVE_FIND_REPLACE_ATTRIBUTE, 'true');
    window.dispatchEvent(new Event(NATIVE_COMPATIBILITY_CHANGE_EVENT));
  }
  function stop(): void {
    if (active) chrome.runtime.onMessage.removeListener(onMessage);
    active = false;
    document.documentElement.removeAttribute(NATIVE_FIND_REPLACE_ATTRIBUTE);
    window.dispatchEvent(new Event(NATIVE_COMPATIBILITY_CHANGE_EVENT));
  }
  return { id: 'native-find-replace', activate, onLoaded: activate, deactivate: stop, stop };
}
