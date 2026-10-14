import { confirmDialog, UI_STYLES, themeRoot } from '@nominy/babel-extension-frontend';
import { isAudioEnhancementProgress, isAudioEnhancementStrength, type AudioEnhancementState } from '@nominy/babel-babel-runtime';
import type { FeatureContext, FeatureModule } from '../core/types';
import { requestGoldDraftingAiBroker } from '../services/gold-drafting-ai-broker';
import {
  AUDIO_ENHANCEMENT_COMMAND_SOURCE, AUDIO_ENHANCEMENT_EVENT_SOURCE,
  AudioEnhancementStreamAssembler, isAudioEnhancementState, isEnhancementSourceTrack, type EnhancementSourceTrack
} from '../services/audio-enhancement-stream';

const SCRIPT_PATH = 'dist/content/audio-enhancement-bridge.js';
const STRENGTH_KEYS: Record<string, true> = {
  ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true, Home: true, End: true, PageUp: true, PageDown: true
};
const STRENGTH_DEBOUNCE_MS = 200;
const FULL_STRENGTH_APPROVAL_PREFIX = 'babel-helper:audio-enhancement:full-strength-approved:';

interface EnhancementPageMessage {
  source?: unknown;
  type?: unknown;
  requestId?: unknown;
  state?: unknown;
  sessionId?: unknown;
  taskId?: unknown;
  tracks?: unknown;
}
interface HelperChromeWindow extends Window {
  chrome?: { runtime?: { getURL?: (path: string) => string } };
}

export function createAudioEnhancementFeature(): FeatureModule {
  let ctx: FeatureContext;
  let started = false;
  let active = false;
  let injection: Promise<void> | null = null;
  let injectionScript: HTMLScriptElement | null = null;
  let cancelInjection: (() => void) | null = null;
  let disablePromise: Promise<void> | null = null;
  let currentSession = '';
  let currentTask = '';
  let selectedVariant = '';
  let broker: AbortController | null = null;
  let assembler: AudioEnhancementStreamAssembler | null = null;
  let panel: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let state: AudioEnhancementState | null = null;
  let lastStateRevision = -1;
  let elapsedStartedAt: number | null = null;
  let elapsedInterval: number | null = null;
  let lifecycleRevision = 0;
  let localOriginalMix: number | null = null;
  let sliderPointerId: number | null = null;
  const heldSliderKeys = new Set<string>();
  let strengthTimeout: number | null = null;
  let sliderSession = '';
  let sliderTask = '';
  let sliderInteraction: 'pointer' | 'keyboard' | 'direct' | null = null;
  let strengthConfirmation: { controller: AbortController; href: string } | null = null;
  const fullStrengthApprovals = new Set<string>();
  const disabledRequests = new Map<string, () => void>();

  function post(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): void {
    window.postMessage({ source: AUDIO_ENHANCEMENT_COMMAND_SOURCE, type, ...payload }, window.location.origin, transfer);
  }

  function cancelStream(): void {
    broker?.abort();
    broker = null;
    assembler?.dispose();
    assembler = null;
  }

  function stopElapsed(): void {
    if (elapsedInterval !== null) window.clearInterval(elapsedInterval);
    elapsedInterval = null;
    elapsedStartedAt = null;
  }

  function renderElapsed(): void {
    const label = panel?.shadowRoot?.querySelector<HTMLElement>('[data-elapsed]');
    if (!label || elapsedStartedAt === null) return;
    const seconds = Math.max(0, Math.floor((performance.now() - elapsedStartedAt) / 1000));
    label.textContent = `Elapsed ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function startElapsed(reset = false): void {
    if (reset || elapsedStartedAt === null) elapsedStartedAt = performance.now();
    if (elapsedInterval === null) elapsedInterval = window.setInterval(renderElapsed, 1000);
    renderElapsed();
  }

  function clearStrengthTimeout(): void {
    if (strengthTimeout !== null) window.clearTimeout(strengthTimeout);
    strengthTimeout = null;
  }

  function cancelStrengthConfirmation(): void {
    const pending = strengthConfirmation;
    strengthConfirmation = null;
    pending?.controller.abort();
  }

  function handleSelectionNavigation(): void {
    if (strengthConfirmation && strengthConfirmation.href !== window.location.href) {
      cancelStrengthSelection();
      render();
    }
  }

  function cancelStrengthSelection(resetHeld = false): void {
    cancelStrengthConfirmation();
    clearStrengthTimeout();
    localOriginalMix = null;
    sliderSession = '';
    sliderTask = '';
    sliderInteraction = null;
    // Keep cancelled holds until release so their remaining events cannot select for a new task.
    if (resetHeld) {
      sliderPointerId = null;
      heldSliderKeys.clear();
    }
  }

  function canSelectStrength(): boolean {
    return active && started && ctx.helper.settings.features.audioEnhancement &&
      Boolean(currentSession && currentTask && state?.taskId === currentTask);
  }

  function sliderSelectionIsCurrent(): boolean {
    return canSelectStrength() && sliderSession === currentSession && sliderTask === currentTask;
  }

  function snapOriginalMix(value: number): number {
    return Math.round(value / 10) * 10;
  }
  function beginStrengthSelection(slider: HTMLInputElement, interaction: 'pointer' | 'keyboard' | 'direct'): void {
    cancelStrengthConfirmation();
    clearStrengthTimeout();
    sliderSession = currentSession;
    sliderTask = currentTask;
    sliderInteraction = interaction;
    localOriginalMix = snapOriginalMix(Number(slider.value));
  }

  function renderSlider(slider: HTMLInputElement): void {
    const originalMix = localOriginalMix ?? snapOriginalMix(100 - (state?.desiredStrength ?? 90));
    const value = String(originalMix);
    if (slider.value !== value) slider.value = value;
    slider.disabled = !state?.taskId;
    slider.setAttribute('aria-valuetext', `${100 - originalMix}% Enhanced, ${originalMix}% Original`);
    const label = panel?.shadowRoot?.querySelector<HTMLElement>('[data-selection]');
    if (label) label.title = selectionLabel(state?.strength ?? 0);
  }

  function hasFullStrengthApproval(taskId: string): boolean {
    if (fullStrengthApprovals.has(taskId)) return true;
    try {
      if (window.sessionStorage.getItem(FULL_STRENGTH_APPROVAL_PREFIX + taskId) === '1') {
        fullStrengthApprovals.add(taskId);
        return true;
      }
    } catch {
      // Blocked site storage must not bypass the warning.
    }
    return false;
  }

  function rememberFullStrengthApproval(taskId: string): void {
    fullStrengthApprovals.add(taskId);
    try {
      window.sessionStorage.setItem(FULL_STRENGTH_APPROVAL_PREFIX + taskId, '1');
    } catch {
      // The current page still remembers approval when tab storage is unavailable.
    }
  }

  async function commitStrengthSelection(): Promise<void> {
    clearStrengthTimeout();
    if (sliderPointerId !== null || heldSliderKeys.size) return;
    if (!sliderSelectionIsCurrent() || localOriginalMix === null) return;
    const strength = 100 - localOriginalMix;
    const sessionId = currentSession;
    const taskId = currentTask;
    const activation = lifecycleRevision;
    const desiredStrength = state?.desiredStrength;
    cancelStrengthSelection();
    if (!isAudioEnhancementStrength(strength) || strength === desiredStrength) return;
    if (strength === 100 && !hasFullStrengthApproval(taskId)) {
      // A pending warning is not a selection: keep the previous thumb and native audio.
      render();
      const pending = { controller: new AbortController(), href: window.location.href };
      strengthConfirmation = pending;
      try {
        const confirmed = await confirmDialog({
          title: 'Use 100% enhanced audio?',
          message: 'Full enhancement can suppress or remove speech, making some words inaudible. We recommend 90% enhanced / 10% Original to retain speech from the original recording.',
          confirmLabel: 'Use 100% enhanced',
          cancelLabel: 'Cancel',
          signal: pending.controller.signal
        });
        if (!confirmed || pending.controller.signal.aborted || strengthConfirmation !== pending ||
            !canSelectStrength() || lifecycleRevision !== activation ||
            currentSession !== sessionId || currentTask !== taskId ||
            window.location.href !== pending.href || state?.desiredStrength !== desiredStrength) return;
        rememberFullStrengthApproval(taskId);
      } finally {
        if (strengthConfirmation === pending) strengthConfirmation = null;
      }
    }
    post('select-strength', { sessionId, taskId, strength });
  }

  function queueStrengthSelection(): void {
    clearStrengthTimeout();
    if (!sliderSelectionIsCurrent() || localOriginalMix === null || sliderPointerId !== null || heldSliderKeys.size) return;
    strengthTimeout = window.setTimeout(() => {
      strengthTimeout = null;
      void commitStrengthSelection();
    }, STRENGTH_DEBOUNCE_MS);
  }

  function handleSliderPointerEnd(event: PointerEvent): void {
    if (event.pointerId !== sliderPointerId) return;
    sliderPointerId = null;
    if (event.type === 'pointercancel') {
      cancelStrengthSelection();
      render();
    } else if (sliderSelectionIsCurrent() && !heldSliderKeys.size) {
      clearStrengthTimeout();
      // Let the range's final input/change default action finish before the release fallback.
      strengthTimeout = window.setTimeout(() => {
        strengthTimeout = null;
        void commitStrengthSelection();
      }, 0);
    }
  }

  function selectionLabel(strength: number): string {
    return strength === 0 ? 'Original' : strength === 100 ? 'Enhanced' : `${strength}% Enhanced · ${100 - strength}% Original`;
  }

  function positionDetails(): void {
    const details = panel?.shadowRoot?.querySelector<HTMLElement>('[data-details]');
    if (!panel || !details?.matches(':popover-open')) return;
    const anchor = panel.getBoundingClientRect();
    const rect = details.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchor.left, window.innerWidth - rect.width - 12));
    const below = anchor.bottom + 6;
    const top = below + rect.height <= window.innerHeight - 12
      ? below : Math.max(12, anchor.top - rect.height - 6);
    details.style.left = `${left}px`;
    details.style.top = `${top}px`;
  }

  function render(): void {
    if (!active || !panel) return;
    const anchor = document.querySelector('[data-babel-helper-appearance-button]') ??
      document.querySelector('#babel-gold-drafting-magic-button') ??
      document.querySelector('[aria-label="Play all tracks"], [aria-label="Pause all tracks"]');
    const toolbar = anchor?.parentElement;
    if (toolbar && panel.parentElement !== toolbar) toolbar.appendChild(panel);
    const shadow = panel.shadowRoot!;
    const status = shadow.querySelector<HTMLElement>('[data-status]')!;
    renderSlider(shadow.querySelector<HTMLInputElement>('[data-strength]')!);
    const taskAvailable = Boolean(state?.taskId);
    const message = state?.message || (state?.status === 'ready'
      ? `${selectionLabel(state.strength)} audio selected`
      : 'Waiting for both native tracks…');
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('error', state?.status === 'error');
    const pending = taskAvailable && state?.status !== 'ready' && state?.status !== 'error';
    const progressPanel = shadow.querySelector<HTMLElement>('[data-progress-panel]')!;
    const progressBar = shadow.querySelector<HTMLProgressElement>('progress')!;
    const progressLabel = shadow.querySelector<HTMLElement>('[data-progress-label]')!;
    progressPanel.hidden = !pending;
    if (pending) {
      startElapsed();
      const progress = state?.progress;
      const countsKnown = Boolean(progress && progress.phase !== 'cache-lookup' && progress.phase !== 'cache-hit' && progress.totalChunks > 0);
      const fraction = progress && countsKnown
        ? (progress.trackIndex + progress.completedChunks / progress.totalChunks) / progress.trackCount : null;
      let stage = state?.status === 'switching' || state?.status === 'processing' && Boolean(state.model)
        ? state?.desiredStrength === 0 ? 'Restoring original audio' : `Loading ${selectionLabel(state?.desiredStrength ?? 90).toLowerCase()} audio into native players`
        : progress ? {
            queued: progress.backend === 'swarm' ? 'Waiting for remote inference' : 'Queued for local GPU',
            uploading: 'Uploading Original audio for remote inference',
            'cache-lookup': 'Checking local pair cache',
            'cache-hit': 'Reusing locally cached audio',
            'loading-model': 'Loading ZipEnhancer model',
            enhancing: 'Reducing noise',
            encoding: 'Encoding enhanced audio',
            transferring: 'Transferring enhanced audio'
          }[progress.phase] : state?.status === 'idle' ? 'Waiting for both native source tracks' : message;
      if (progress?.phase === 'enhancing' && fraction === 1) stage = 'Inference complete; encoding and native loading pending';
      const detail = progress ? ` · Track ${progress.trackIndex + 1}/${progress.trackCount}` : '';
      const counts = progress && countsKnown
        ? ` · ${progress.completedChunks}/${progress.totalChunks} inference windows · ${((fraction ?? 0) * 100).toFixed(1)}% inference` : '';
      const engine = progress?.backend === 'swarm' ? ' · Remote GPU'
        : progress?.backend === 'webgpu' ? ' · WebGPU (local)' : '';
      progressLabel.textContent = `${stage}${engine}${detail}${counts}${progress?.backendReason ? ` · ${progress.backendReason}` : ''}`;
      // A completed inference count is not a committed native audio selection.
      if (state?.status === 'processing' && progress?.phase === 'enhancing' && fraction !== null) progressBar.value = fraction;
      else progressBar.removeAttribute('value');
    } else {
      stopElapsed();
      progressBar.removeAttribute('value');
      progressLabel.textContent = '';
    }
    panel.title = message;
    panel.setAttribute('aria-busy', String(pending));
    const label = shadow.querySelector<HTMLElement>('[data-selection]')!;
    const selected = `${state?.strength ?? 0}%`;
    if (label.textContent !== selected) label.textContent = selected;
    label.setAttribute('aria-label', `${state?.strength ?? 0}% Enhanced`);
    const detailsButton = shadow.querySelector<HTMLButtonElement>('[data-details-button]')!;
    detailsButton.textContent = state?.status === 'error' ? '!' : pending ? '…' : 'i';
    detailsButton.setAttribute('aria-label', `ZipEnhancer details: ${message}`);
    detailsButton.classList.toggle('error', state?.status === 'error');
    positionDetails();
  }

  function ensurePanel(): void {
    if (panel) { render(); return; }
    panel = document.createElement('span');
    panel.setAttribute('data-babel-helper-audio-enhancement', '');
    panel.style.flex = '0 0 360px';
    const shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${UI_STYLES}
      :host { display: inline-flex; width: 360px; max-width: calc(100vw - 32px); height: 36px; }
      .audio { position: relative; display: grid; grid-template-columns: 76px minmax(0, 1fr) 34px 24px; align-items: center; gap: 6px; width: 100%; height: 36px; box-sizing: border-box; padding: 0 6px; }
      .brand { font-size: 11px; white-space: nowrap; }
      .choice { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px; direction: ltr; font-size: 10px; white-space: nowrap; }
      input[type="range"] { width: 100%; min-width: 0; margin: 0; accent-color: var(--bui-accent-ink); }
      .selection { font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .details-button { width: 24px; min-width: 0; height: 24px; min-height: 0; padding: 0; font-size: 12px; }
      .details { position: fixed; inset: auto; margin: 0; width: min(360px, calc(100vw - 24px)); max-height: min(360px, calc(100vh - 24px)); box-sizing: border-box; overflow: auto; padding: 10px; font-size: 12px; box-shadow: var(--bui-shadow); }
      .status, .progress-label { white-space: normal; overflow-wrap: anywhere; }
      .status { display: block; margin: 0; }
      .error { color: var(--bui-danger); }
      .progress-panel { display: grid; gap: 4px; margin-top: 6px; }
      .progress-panel[hidden] { display: none; }
      progress { position: absolute; left: 0; bottom: 0; width: 100%; min-width: 0; height: 2px; visibility: hidden; accent-color: var(--bui-accent-ink); }
      :host([aria-busy="true"]) progress { visibility: visible; }
      .elapsed { color: var(--bui-muted); font-variant-numeric: tabular-nums; }
    </style><span class="audio bui-root bui-surface" role="group" aria-label="ZipEnhancer audio selection">
      <strong class="brand">ZipEnhancer</strong>
      <span class="choice"><span>Enhanced</span>
      <input class="bui-range" type="range" data-strength min="0" max="100" step="10" value="10"
        aria-label="Original audio mix" aria-orientation="horizontal" aria-valuetext="90% Enhanced, 10% Original">
      <span>Original</span></span>
      <output class="selection" data-selection aria-label="0% Enhanced">0%</output>
      <button class="details-button bui-icon-button bui-button" type="button" data-details-button
        popovertarget="zipenhancer-details" aria-label="ZipEnhancer details">i</button>
      <progress aria-label="Noise reduction progress" max="1"></progress>
    </span>
    <div class="details bui-root bui-surface" id="zipenhancer-details" data-details popover="auto" role="dialog" aria-label="ZipEnhancer status">
      <span class="status bui-status" data-status role="status" aria-live="polite">Waiting for audio…</span>
      <span class="progress-panel" data-progress-panel hidden><span class="progress-label" data-progress-label></span>
        <span class="elapsed" data-elapsed></span></span>
    </div>`;
    themeRoot(shadow.querySelector<HTMLElement>('.bui-root')!);
    themeRoot(shadow.querySelector<HTMLElement>('[data-details]')!);
    shadow.querySelector<HTMLElement>('[data-details]')!.addEventListener('toggle', positionDetails);
    const slider = shadow.querySelector<HTMLInputElement>('[data-strength]')!;
    slider.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !canSelectStrength() || sliderPointerId !== null ||
          heldSliderKeys.size && !sliderSelectionIsCurrent()) return;
      sliderPointerId = event.pointerId;
      beginStrengthSelection(slider, 'pointer');
    });
    slider.addEventListener('input', () => {
      if (!canSelectStrength()) return;
      if ((sliderPointerId !== null || heldSliderKeys.size) && !sliderSelectionIsCurrent()) {
        renderSlider(slider);
        return;
      }
      if (!sliderSelectionIsCurrent()) beginStrengthSelection(slider, 'direct');
      const originalMix = Number(slider.value);
      if (!isAudioEnhancementStrength(originalMix)) return;
      localOriginalMix = snapOriginalMix(originalMix);
      renderSlider(slider);
      if (sliderPointerId === null && !heldSliderKeys.size && sliderInteraction !== 'pointer') queueStrengthSelection();
    });
    slider.addEventListener('change', () => {
      if (!sliderSelectionIsCurrent() || sliderPointerId !== null || heldSliderKeys.size) return;
      if (sliderInteraction === 'keyboard') queueStrengthSelection();
      else void commitStrengthSelection();
    });
    slider.addEventListener('keydown', event => {
      event.stopPropagation();
      if (!Object.prototype.hasOwnProperty.call(STRENGTH_KEYS, event.key) || !canSelectStrength()) return;
      if (!heldSliderKeys.size && sliderPointerId === null) beginStrengthSelection(slider, 'keyboard');
      clearStrengthTimeout();
      heldSliderKeys.add(event.key);
      // Native range defaults provide arrows, Home/End and assistive-technology interaction.
    });
    slider.addEventListener('keyup', event => {
      event.stopPropagation();
      if (!heldSliderKeys.delete(event.key)) return;
      queueStrengthSelection();
    });
    slider.addEventListener('blur', () => {
      heldSliderKeys.clear();
      if (sliderPointerId !== null) {
        cancelStrengthSelection();
        render();
      } else {
        void commitStrengthSelection();
      }
    });
    render();
  }

  async function dispatch(sessionId: string, taskId: string, tracks: EnhancementSourceTrack[]): Promise<void> {
    if (!active || currentSession !== sessionId || currentTask !== taskId || broker) return;
    if (tracks.length !== 2 || new Set(tracks.map(track => track.trackId)).size !== 2 ||
        tracks.some(track => !track.trackId || !/^[a-f0-9]{64}$/.test(track.sourceSha256) ||
          !Number.isSafeInteger(track.frameCount) || track.frameCount <= 0 || !Number.isSafeInteger(track.sampleRate) || track.sampleRate <= 0)) {
      post('error', { sessionId, taskId, message: 'Native source audio identity is invalid; original audio remains selected.' });
      return;
    }
    const controller = new AbortController();
    const stream = new AudioEnhancementStreamAssembler(tracks);
    broker = controller;
    assembler = stream;
    startElapsed(true);
    try {
      // Gold owns capture and inference. No source bytes cross the external broker request.
      const result = await requestGoldDraftingAiBroker({ operation: 'enhanceAudio', taskId }, {
        signal: controller.signal,
        onAudioChunk: chunk => stream.accept(chunk),
        onEvent: event => {
          if (!active || controller.signal.aborted || broker !== controller ||
              currentSession !== sessionId || currentTask !== taskId) return;
          if (event.progress !== undefined && (!isAudioEnhancementProgress(event.progress) ||
              event.progress.trackCount !== tracks.length || tracks[event.progress.trackIndex]?.trackId !== event.progress.trackId)) {
            post('error', { sessionId, taskId, message: 'Gold Drafting progress does not match the native source tracks.' });
            controller.abort();
            return;
          }
          post('progress', {
            sessionId, taskId, progress: event.progress,
            message: event.message || (event.progress?.backend === 'swarm' ? 'Enhancing both tracks on a remote GPU…' : 'Preparing ZipEnhancer…')
          });
        }
      });
      if (!active || controller.signal.aborted || currentSession !== sessionId || currentTask !== taskId) return;
      if (!result?.ok) throw new Error(result?.message || result?.reason || 'Gold Drafting is unavailable. Enable it to request audio enhancement.');
      const completed = await stream.finish(result, taskId);
      if (!active || controller.signal.aborted || currentSession !== sessionId || currentTask !== taskId) return;
      post('install', { sessionId, taskId, model: result.model, variantKey: completed.variantKey, tracks: completed.tracks,
        cacheStatus: completed.cacheStatus, cacheMessage: completed.cacheMessage },
        completed.tracks.map(track => track.bytes));
    } catch (error) {
      if (active && !controller.signal.aborted && currentSession === sessionId && currentTask === taskId) {
        post('error', { sessionId, taskId, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      stream.dispose();
      if (broker === controller) { broker = null; assembler = null; }
    }
  }

  function handleMessage(event: MessageEvent<unknown>): void {
    if (event.source !== window || event.origin !== window.location.origin || typeof event.data !== 'object' || event.data === null) return;
    const data = event.data as EnhancementPageMessage;
    if (data.source !== AUDIO_ENHANCEMENT_EVENT_SOURCE) return;
    if (data.type === 'disabled' && typeof data.requestId === 'string') { disabledRequests.get(data.requestId)?.(); return; }
    if (!active) return;
    if (data.type === 'state') {
      if (!isAudioEnhancementState(data.state) || typeof data.sessionId !== 'string') return;
      if (data.state.revision <= lastStateRevision) return;
      lastStateRevision = data.state.revision;
      const next = data.state;
      if (data.sessionId !== currentSession || next.taskId !== currentTask) {
        cancelStream();
        stopElapsed();
        cancelStrengthSelection();
        currentSession = data.sessionId;
        currentTask = next.taskId;
      }
      if (next.desiredStrength !== state?.desiredStrength) cancelStrengthConfirmation();
      state = next;
      const variant = `${currentSession}:${next.taskId}:${next.strength}:${next.variantKey}`;
      if (variant !== selectedVariant && next.status !== 'switching') {
        selectedVariant = variant;
        if (ctx.helper.settings.features.minimap) ctx.services.minimap.bindMinimap();
      }
      render();
      return;
    }
    if (data.type === 'sources-ready' && Array.isArray(data.tracks) &&
        typeof data.sessionId === 'string' && typeof data.taskId === 'string') {
      const tracks: unknown[] = data.tracks;
      if (!tracks.every(isEnhancementSourceTrack)) {
        post('error', { sessionId: data.sessionId, taskId: data.taskId, message: 'Native source audio identity is invalid.' });
        return;
      }
      void dispatch(data.sessionId, data.taskId, tracks);
    }
  }

  async function enable(): Promise<void> {
    if (disablePromise) await disablePromise;
    if (active || !started || !ctx.helper.settings.features.audioEnhancement) return;
    const activation = ++lifecycleRevision;
    active = true;
    window.addEventListener('message', handleMessage);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('popstate', handleSelectionNavigation);
    window.addEventListener('babel-helper-bridge-teardown', handlePageHide);
    window.addEventListener('pointerup', handleSliderPointerEnd, true);
    window.addEventListener('pointercancel', handleSliderPointerEnd, true);
    if (!observer) {
      observer = new MutationObserver(() => {
        handleSelectionNavigation();
        if (active) ensurePanel();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    ensurePanel();
    if (!injection) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      injection = promise;
      const chromeApi = (window as HelperChromeWindow).chrome;
      try {
        if (typeof chromeApi?.runtime?.getURL !== 'function') throw new Error('Helper cannot load the native audio bridge.');
        const script = document.createElement('script');
        injectionScript = script;
        cancelInjection = () => { script.remove(); injectionScript = null; resolve(); };
        script.src = chromeApi.runtime.getURL(SCRIPT_PATH);
        script.async = false;
        script.onload = () => { script.remove(); injectionScript = null; cancelInjection = null; resolve(); };
        script.onerror = () => { script.remove(); injectionScript = null; cancelInjection = null; reject(new Error('Native audio enhancement bridge failed to load.')); };
        (document.documentElement || document.head).appendChild(script);
      } catch (error) { reject(error); }
    }
    try {
      await injection;
      if (active && lifecycleRevision === activation) post('enable');
    } catch (error) {
      injection = null;
      if (!active || lifecycleRevision !== activation) return;
      stopElapsed();
      if (panel) {
        const status = panel.shadowRoot!.querySelector<HTMLElement>('[data-status]')!;
        status.textContent = error instanceof Error ? error.message : String(error);
        status.classList.add('error');
      }
    }
  }

  function disable(): Promise<void> {
    if (disablePromise) return disablePromise;
    ++lifecycleRevision;
    active = false;
    cancelStream();
    stopElapsed();
    cancelStrengthSelection(true);
    observer?.disconnect(); observer = null;
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('popstate', handleSelectionNavigation);
    window.removeEventListener('babel-helper-bridge-teardown', handlePageHide);
    window.removeEventListener('pointerup', handleSliderPointerEnd, true);
    window.removeEventListener('pointercancel', handleSliderPointerEnd, true);
    currentSession = ''; currentTask = ''; selectedVariant = ''; state = null;
    lastStateRevision = -1;
    panel?.remove(); panel = null;
    const pendingInjection = injectionScript !== null;
    if (pendingInjection) { cancelInjection?.(); cancelInjection = null; }
    const bridgeLoaded = injection !== null;
    injection = null;
    disablePromise = (async () => {
      if (bridgeLoaded) {
        const requestId = crypto.randomUUID();
        const { promise, resolve } = Promise.withResolvers<void>();
        // A loaded producer may still be restoring native buffers. Elapsed time
        // cannot prove it released the writer; only its correlated ack can.
        // A cancelled script injection never received enable and has no writer.
        const timeout = pendingInjection ? window.setTimeout(() => {
          disabledRequests.delete(requestId);
          resolve();
        }, 3000) : null;
        disabledRequests.set(requestId, () => {
          if (timeout !== null) window.clearTimeout(timeout);
          disabledRequests.delete(requestId);
          resolve();
        });
        post('dispose', { requestId });
        await promise;
      }
      window.removeEventListener('message', handleMessage);
    })().finally(() => { disablePromise = null; });
    return disablePromise;
  }

  function handlePageHide(): void {
    void disable();
  }

  return {
    id: 'audio-enhancement',
    start(context) {
      ctx = context;
      if (started) return;
      started = true;
    },
    onLoaded: enable,
    activate: enable,
    deactivate: disable,
    async stop() {
      started = false;
      await disable();
      cancelStream();
      stopElapsed();
      cancelStrengthSelection(true);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('popstate', handleSelectionNavigation);
      window.removeEventListener('babel-helper-bridge-teardown', handlePageHide);
      window.removeEventListener('pointerup', handleSliderPointerEnd, true);
      window.removeEventListener('pointercancel', handleSliderPointerEnd, true);
      observer?.disconnect(); observer = null;
      window.removeEventListener('message', handleMessage);
      panel?.remove(); panel = null;
      for (const resolve of disabledRequests.values()) resolve();
      disabledRequests.clear();
      started = false;
    }
  };
}
