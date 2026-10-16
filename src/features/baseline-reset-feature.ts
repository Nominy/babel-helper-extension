import { applyComponent, confirmDialog, themeRoot } from '@nominy/babel-extension-frontend';
import type { FeatureContext, FeatureModule } from '../core/types';
import { BABEL_MOD_CONTROLLER_EVENT } from '../mod-platform/protocol';
import type { PreparedBaselineReset } from '../services/native-baseline-reset-client';
import { readNativeSessionState } from '../site/editor-control';

const HOST_SELECTOR = '[data-babel-helper-baseline-reset]';
const APPEARANCE_SELECTOR = '[data-babel-helper-appearance-button]';
const TOOLBAR_ANCHOR_SELECTOR = '#babel-gold-drafting-magic-button, [aria-label="Play all tracks"], [aria-label="Pause all tracks"]';
const SESSION_EVENTS = ['babel-helper:native-session-change', 'babel-helper:native-route-change', 'popstate', 'hashchange', 'pageshow', BABEL_MOD_CONTROLLER_EVENT];
const TEARDOWN_EVENTS = ['pagehide', 'babel-helper-bridge-teardown'];

type Session = { reviewActionId: string; href: string; admission: object; revision: unknown };
type Operation = Session & { controller: AbortController; token: string; discard: (payload: { token: string }) => unknown };

function isPreparedBaseline(value: unknown, reviewActionId: string): value is PreparedBaselineReset {
  return Boolean(value && typeof value === 'object' &&
    'ok' in value && value.ok === true && 'token' in value && typeof value.token === 'string' && value.token.length > 0 &&
    'level' in value && (value.level === 0 || value.level === 1) &&
    'segmentCount' in value && typeof value.segmentCount === 'number' && Number.isSafeInteger(value.segmentCount) && value.segmentCount >= 0 &&
    'reviewActionId' in value && value.reviewActionId === reviewActionId &&
    'baselineReviewActionId' in value && typeof value.baselineReviewActionId === 'string' &&
    value.baselineReviewActionId.length > 0 && value.baselineReviewActionId !== reviewActionId);
}

function failureMessage(result: unknown): string {
  if (result && typeof result === 'object') {
    if ('message' in result && typeof result.message === 'string' && result.message) return result.message;
    if ('reason' in result && typeof result.reason === 'string' && result.reason) return `Reset could not be completed (${result.reason}).`;
  }
  return 'The native editor did not confirm the reset. No save or submit was requested.';
}

/** The native bridge owns baseline selection and the single undoable replacement. */
export function createBaselineResetFeature(): FeatureModule {
  let navigation: EventTarget | undefined;
  let ctx: FeatureContext;
  let active = false;
  let operation: Operation | null = null;
  let session: Session | null = null;
  let observer: MutationObserver | null = null;
  let host: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  let notice: HTMLElement | null = null;
  let status: HTMLElement | null = null;

  function currentSession(): Session | null {
    if (!active || (ctx.helper.isFeatureEnabled?.('baselineReset') ?? ctx.helper.settings?.features?.baselineReset !== false) === false ||
        !ctx.helper.runtime?.isSessionInteractive?.()) return null;
    const native = readNativeSessionState();
    const admission = ctx.helper.state?.nativeSessionAdmission;
    if (!native || native.readOnly || !admission || admission.reviewActionId !== native.reviewActionId ||
        admission.href !== window.location.href) return null;
    return { reviewActionId: native.reviewActionId, href: window.location.href,
      admission, revision: ctx.helper.state.sessionLifecycleRevision };
  }

  function sameSession(left: Session | null, right: Session | null): boolean {
    return Boolean(left && right && left.reviewActionId === right.reviewActionId && left.href === right.href &&
      left.admission === right.admission && left.revision === right.revision);
  }

  function isCurrent(pending: Operation): boolean {
    return operation === pending && !pending.controller.signal.aborted && sameSession(pending, currentSession());
  }

  function discard(pending: Operation): void {
    const token = pending.token;
    pending.token = '';
    if (!token) return;
    try {
      void Promise.resolve(pending.discard({ token })).then(result => {
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
          throw new Error(failureMessage(result));
        }
      }).catch(error => {
        if (active && !operation && sameSession(pending, currentSession())) {
          showStatus(`The prepared reset could not be released: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      });
    } catch (error) {
      if (active && (!operation || operation === pending) && sameSession(pending, currentSession())) {
        showStatus(`The prepared reset could not be released: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  }

  function cancelOperation(): void {
    const pending = operation;
    operation = null;
    if (!pending) return;
    pending.controller.abort();
    discard(pending);
  }

  function clearStatus(): void {
    notice?.remove();
    notice = null;
    status = null;
  }

  function stopKeyPropagation(event: Event): void { event.stopPropagation(); }

  function showStatus(message: string, error = false): void {
    if (!active) return;
    if (!notice) {
      notice = document.createElement('div');
      notice.setAttribute('data-babel-helper-baseline-reset-notice', '');
      themeRoot(notice);
      applyComponent(notice, 'toast');
      Object.assign(notice.style, { position: 'fixed', zIndex: '2147483646', right: '16px', bottom: '16px',
        maxWidth: 'min(440px, calc(100vw - 32px))', padding: '12px', display: 'flex', alignItems: 'center', gap: '12px' });
      status = document.createElement('span');
      status.setAttribute('data-baseline-reset-status', '');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.style.overflowWrap = 'anywhere';
      applyComponent(status, 'status');
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.setAttribute('data-baseline-reset-dismiss', '');
      dismiss.setAttribute('aria-label', 'Dismiss reset status');
      dismiss.textContent = 'Dismiss';
      applyComponent(dismiss, 'button');
      dismiss.addEventListener('click', () => { clearStatus(); button?.focus(); });
      notice.addEventListener('keydown', stopKeyPropagation);
      notice.addEventListener('keyup', stopKeyPropagation);
      notice.append(status, dismiss);
      document.body.appendChild(notice);
    }
    status!.textContent = message;
    status!.setAttribute('data-tone', error ? 'danger' : 'neutral');
  }

  function mountButton(): void {
    const appearance = document.querySelector(APPEARANCE_SELECTOR);
    const anchor = appearance ?? document.querySelector(TOOLBAR_ANCHOR_SELECTOR);
    const toolbar = anchor?.parentElement;
    if (!toolbar) { host?.remove(); return; }
    if (!host) {
      if (document.querySelector(HOST_SELECTOR)) return;
      host = document.createElement('span');
      host.setAttribute('data-babel-helper-baseline-reset', '');
      Object.assign(host.style, { display: 'inline-flex', flex: '0 0 36px', width: '36px', height: '36px' });
      themeRoot(host);
      button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-baseline-reset-button', '');
      button.setAttribute('aria-label', 'Reset to L1/L0');
      button.title = 'Reset to L1/L0';
      applyComponent(button, 'icon-button', { variant: 'soft' });
      Object.assign(button.style, { width: '36px', height: '36px', minWidth: '36px', minHeight: '36px', padding: '0' });
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 11a9 9 0 1 1 2.7 7.4M3 4v7h7"/></svg>';
      button.addEventListener('keydown', stopKeyPropagation);
      button.addEventListener('keyup', stopKeyPropagation);
      button.addEventListener('click', () => { void reset(); });
      host.appendChild(button);
    }
    if (appearance) {
      if (appearance.nextSibling !== host) toolbar.insertBefore(host, appearance.nextSibling);
    } else if (host.parentElement !== toolbar) toolbar.appendChild(host);
  }

  function render(): void {
    if (!button) return;
    button.disabled = !session || Boolean(operation);
    button.setAttribute('aria-busy', String(Boolean(operation)));
  }

  function reconcile(): void {
    if (!active) return;
    const next = currentSession();
    if (!sameSession(session, next)) {
      cancelOperation();
      clearStatus();
    }
    session = next;
    mountButton();
    render();
  }

  async function reset(): Promise<void> {
    if (operation) return;
    reconcile();
    const selected = currentSession();
    if (!selected) return;
    const helper = ctx.helper;
    if (typeof helper.prepareBaselineReset !== 'function' || typeof helper.applyBaselineReset !== 'function' ||
        typeof helper.discardBaselineReset !== 'function') {
      showStatus('Reset is unavailable because the native baseline helper is not ready.', true);
      return;
    }
    const pending: Operation = { ...selected, controller: new AbortController(), token: '',
      discard: payload => helper.discardBaselineReset(payload) };
    operation = pending;
    let dialogOpened = false;
    render();
    showStatus('Loading the highest available baseline (L1, otherwise L0)…');
    try {
      const prepared: unknown = await helper.prepareBaselineReset({ expectedReviewActionId: pending.reviewActionId });
      // Retain even an invalid or late token solely to release its native plan.
      if (prepared && typeof prepared === 'object' && 'token' in prepared && typeof prepared.token === 'string') pending.token = prepared.token;
      if (!isCurrent(pending)) return;
      if (!isPreparedBaseline(prepared, pending.reviewActionId)) {
        showStatus(failureMessage(prepared), true);
        return;
      }
      clearStatus();
      dialogOpened = true;
      const confirmed = await confirmDialog({
        title: `Reset to L${prepared.level}?`,
        message: `Replace all current segments with the ${prepared.segmentCount} segment${prepared.segmentCount === 1 ? '' : 's'} from L${prepared.level}? The entire current transcript will be replaced, including segment layout, timestamps, speakers, and text. You can reverse this with the editor’s Undo. Your current task stays open; this does not save or submit it, and normal listening and submission rules still apply.`,
        confirmLabel: `Reset to L${prepared.level}`,
        cancelLabel: 'Cancel',
        signal: pending.controller.signal
      });
      if (!confirmed || !isCurrent(pending)) return;
      showStatus(`Restoring ${prepared.segmentCount} segment${prepared.segmentCount === 1 ? '' : 's'} from L${prepared.level}…`);
      const result: unknown = await helper.applyBaselineReset({ token: pending.token, expectedReviewActionId: pending.reviewActionId });
      if (!isCurrent(pending)) return;
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
        showStatus(failureMessage(result), true);
        return;
      }
      showStatus(`Restored ${prepared.segmentCount} segment${prepared.segmentCount === 1 ? '' : 's'} from L${prepared.level}. Use the editor’s Undo to reverse this. Not saved or submitted; normal listening and submission rules still apply.`);
    } catch (error) {
      if (isCurrent(pending)) showStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      discard(pending);
      if (operation === pending) {
        operation = null;
        session = currentSession();
        render();
        if (dialogOpened && session && (document.activeElement === document.body || document.activeElement === button)) button?.focus();
      }
    }
  }

  function deactivate(): void {
    active = false;
    cancelOperation();
    observer?.disconnect();
    observer = null;
    for (const event of SESSION_EVENTS) window.removeEventListener(event, reconcile, true);
    for (const event of TEARDOWN_EVENTS) window.removeEventListener(event, deactivate, true);
    navigation?.removeEventListener('currententrychange', reconcile);
    clearStatus();
    host?.remove();
    host = null;
    button = null;
    session = null;
  }

  function activate(context?: FeatureContext): void {
    if (context) ctx = context;
    if (!ctx || (ctx.helper.isFeatureEnabled?.('baselineReset') ?? ctx.helper.settings?.features?.baselineReset !== false) === false) return;
    if (!active) {
      active = true;
      for (const event of SESSION_EVENTS) window.addEventListener(event, reconcile, true);
      for (const event of TEARDOWN_EVENTS) window.addEventListener(event, deactivate, true);
      // Older DOM typings omit Chromium's Navigation API; native route events also cover it.
      navigation = (window as Window & { navigation?: EventTarget }).navigation;
      navigation?.addEventListener('currententrychange', reconcile);
      observer = new MutationObserver(reconcile);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    reconcile();
  }

  return { id: 'baseline-reset', start(context) { ctx = context; }, activate, onLoaded: activate, deactivate, stop: deactivate };
}
