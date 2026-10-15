// @ts-nocheck
import { readBabelPlaybackBindings } from '@nominy/babel-babel-runtime';
import { setSpeakerWorkflow } from '../features/speaker-workflow';
import { installNativeSpeedFix } from '../features/playback-speed-hotkeys';
import { readNativePlaybackState, samePlaybackBindings, subscribeNativePlayback } from './native-playback-events';

export function initPlaybackBridge() {
  if (window.__babelHelperPlaybackBridge) {
    return;
  }

  const REQUEST_EVENT = 'babel-helper-playback-request';
  const RESPONSE_EVENT = 'babel-helper-playback-response';
  const SAMPLE_EVENT = 'babel-helper-playback-sample';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const SERVICE_ID = 'page.playback';
  const DEFAULT_PLAYBACK_SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2];

  const speedFix = installNativeSpeedFix();
  const subscriptions = new Map();
  const pendingCommands = new Set();


  function respond(id, result) {
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          id,
          result
        }
      })
    );
  }

  function normalizePlaybackSpeed(value) {
    const speed = Number(value);
    return Number.isFinite(speed) && speed > 0 && speed <= 4 ? speed : null;
  }

  const stateFromBindings = readNativePlaybackState;

  function getPlaybackState() {
    return stateFromBindings(readBabelPlaybackBindings());
  }

  function seekPlaybackBySeconds(deltaSeconds) {
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta) || delta === 0) return { ok: false, reason: 'invalid-delta' };
    const bindings = readBabelPlaybackBindings();
    const before = stateFromBindings(bindings);
    if (!before.ok || !bindings?.seekToTime) return { ok: false, reason: 'playback-unavailable' };
    const nextTime = Math.max(0, Math.min(before.duration > 0 ? before.duration : Infinity, before.currentTime + delta));
    bindings.seekToTime(nextTime);
    const after = stateFromBindings(bindings);
    return { ...after, ok: after.ok && Math.abs(after.currentTime - nextTime) < 0.1 };
  }

  async function setPlaybackPaused(paused) {
    const desired = Boolean(paused);
    const bindings = readBabelPlaybackBindings();
    const before = stateFromBindings(bindings);
    if (!before.ok || !bindings?.togglePlayPause) return { ok: false, reason: 'playback-unavailable' };
    if (before.paused === desired) return { ...before, changed: false, previousPaused: before.paused, via: 'noop' };
    const { promise, resolve } = Promise.withResolvers();
    let release = null;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      release?.();
      pendingCommands.delete(finish);
      resolve(result);
    };
    const deadline = window.setTimeout(() => finish({ ok: false, reason: 'native-playback-timeout', paused: null }), 500);
    pendingCommands.add(finish);
    try {
      release = subscribeNativePlayback(sample => {
        const current = readBabelPlaybackBindings();
        if (!samePlaybackBindings(bindings, current)) {
          finish({ ok: false, reason: current?.reviewActionId !== bindings.reviewActionId ? 'stale-task' : 'playback-replaced', paused: null });
        } else if (sample.fatal) {
          finish(sample);
        } else if (sample.ok && sample.paused === desired) {
          finish({ ...sample, changed: true, previousPaused: before.paused, via: 'native-event' });
        }
      }, speedFix.patchNativeSpeed, { includeHidden: true });
      // Subscribe before the one native toggle, including synchronous pause.
      bindings.togglePlayPause();
    } catch (error) {
      finish({ ok: false, reason: 'native-playback-subscription-failed', message: String(error), paused: null });
    }
    return promise;
  }

  function setPlaybackSpeed(speed) {
    const targetSpeed = normalizePlaybackSpeed(speed);
    if (targetSpeed == null) return { ok: false, reason: 'invalid-speed' };
    speedFix.patchNativeSpeed();
    const bindings = readBabelPlaybackBindings();
    const before = stateFromBindings(bindings);
    if (!before.ok || !bindings?.setSpeed) return { ok: false, reason: 'playback-unavailable' };
    bindings.setSpeed(String(targetSpeed));
    const after = stateFromBindings(bindings);
    return { ...after, ok: after.ok && Math.abs(after.playbackRate - targetSpeed) < 0.001,
      previousSpeed: before.playbackRate, nextSpeed: targetSpeed,
      changed: before.playbackRate !== targetSpeed, reactUpdated: true };
  }

  function adjustPlaybackSpeed(direction, steps) {
    const current = getPlaybackState();
    if (!current.ok) return current;
    const values = [...new Set((Array.isArray(steps) && steps.length ? steps : DEFAULT_PLAYBACK_SPEED_STEPS)
      .map(normalizePlaybackSpeed).filter(value => value != null))].sort((a, b) => a - b);
    if (!values.length) return { ok: false, reason: 'invalid-speed-steps' };
    const nextSpeed = Number(direction) > 0
      ? values.find(value => value > current.playbackRate + 0.001) ?? values.at(-1)
      : values.slice().reverse().find(value => value < current.playbackRate - 0.001) ?? values[0];
    return { ...setPlaybackSpeed(nextSpeed), direction: Number(direction) > 0 ? 1 : -1 };
  }

  const nativeService = {
    setSpeakerWorkflow,
    adjustPlaybackSpeed,
    getPlaybackState,
    seekPlaybackBySeconds,
    setPlaybackPaused,
    setPlaybackSpeed
  };
  const serviceRegistry = window.BabelMods?.unsafe?.services;
  if (
    !serviceRegistry ||
    typeof serviceRegistry.provide !== 'function' ||
    typeof serviceRegistry.invoke !== 'function'
  ) {
    throw new Error('BabelMods page service registry is unavailable');
  }
  const provider = serviceRegistry.provide(SERVICE_ID, nativeService, {
    owner: 'builtin:playback'
  });

  function invokeService(method, ...args) {
    return serviceRegistry.invoke(SERVICE_ID, method, ...args);
  }

  function handleRequest(event) {
    const detail = event.detail || {};
    const id = detail.id;
    const operation = detail.operation;
    const payload = detail.payload || {};
    if (!id) {
      return;
    }
    if (operation === 'unsubscribe') {
      subscriptions.get(payload.subscriptionId)?.();
      subscriptions.delete(payload.subscriptionId);
      respond(id, { ok: true });
      return;
    }
    if (operation === 'subscribe') {
      const subscriptionId = payload.subscriptionId;
      if (typeof subscriptionId !== 'string' || !subscriptionId) {
        respond(id, { ok: false, reason: 'invalid-subscription' });
        return;
      }
      subscriptions.get(subscriptionId)?.();
      try {
        const release = subscribeNativePlayback(sample => {
          if (disposed || subscriptions.get(subscriptionId) !== release) return;
          window.dispatchEvent(new CustomEvent(SAMPLE_EVENT, {
            detail: { subscriptionId, lifecycleRevision: payload.lifecycleRevision, href: payload.href, sample }
          }));
          if (sample.fatal) subscriptions.delete(subscriptionId);
        }, speedFix.patchNativeSpeed);
        subscriptions.set(subscriptionId, release);
        respond(id, { ok: true });
      } catch (error) {
        respond(id, { ok: false, reason: 'native-playback-subscription-failed', message: String(error) });
      }
      return;
    }
    if (operation !== 'state' && payload.reviewActionId &&
        payload.reviewActionId !== readBabelPlaybackBindings()?.reviewActionId) {
      respond(id, { ok: false, reason: 'stale-task' });
      return;
    }

    if (operation === 'seek') {
      respond(id, invokeService('seekPlaybackBySeconds', payload.deltaSeconds));
      return;
    }

    if (operation === 'state') {
      respond(id, invokeService('getPlaybackState'));
      return;
    }

    if (operation === 'set-paused' || operation === 'speaker-workflow') {
      const result = operation === 'set-paused'
        ? invokeService('setPlaybackPaused', payload.paused)
        : invokeService('setSpeakerWorkflow', payload.targetLabel);
      Promise.resolve(result).then(
        result => respond(id, result),
        error => respond(id, { ok: false, reason: 'native-playback-failed', message: String(error) })
      );
      return;
    }

    if (operation === 'adjust-speed') {
      respond(id, invokeService('adjustPlaybackSpeed', payload.direction, payload.steps));
      return;
    }
    if (operation === 'set-speed') {
      respond(id, invokeService('setPlaybackSpeed', payload.speed));
      return;
    }
    respond(id, { ok: false, reason: 'unknown-operation' });
  }

  let disposed = false;
  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const release of subscriptions.values()) release();
    subscriptions.clear();
    for (const finish of pendingCommands) finish({ ok: false, reason: 'playback-disposed', paused: null });
    speedFix.dispose();
    window.removeEventListener(REQUEST_EVENT, handleRequest, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    provider.dispose();
    if (window.__babelHelperPlaybackBridge === facade) {
      delete window.__babelHelperPlaybackBridge;
    }
  }

  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  const facade = {
    setSpeakerWorkflow: (...args) => invokeService('setSpeakerWorkflow', ...args),
    adjustPlaybackSpeed: (...args) => invokeService('adjustPlaybackSpeed', ...args),
    getPlaybackState: (...args) => invokeService('getPlaybackState', ...args),
    seekPlaybackBySeconds: (...args) => invokeService('seekPlaybackBySeconds', ...args),
    setPlaybackPaused: (...args) => invokeService('setPlaybackPaused', ...args),
    setPlaybackSpeed: (...args) => invokeService('setPlaybackSpeed', ...args),
    dispose
  };
  window.__babelHelperPlaybackBridge = facade;
}

initPlaybackBridge();
