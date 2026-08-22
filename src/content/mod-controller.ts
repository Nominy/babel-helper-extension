import {
  BABEL_MOD_CONTROLLER_EVENT,
  BABEL_MOD_HOST_READY_EVENT,
  CONTROLLER_PROTOCOL_VERSION,
  isHostReadyDetail,
  type ControllerTransition,
  type ControllerTransitionType
} from '../mod-platform/protocol';

export type ModControllerSettings = Readonly<object>;

export interface ModControllerEventDetail extends ControllerTransition {
  readonly href: string;
  readonly settings: ModControllerSettings;
}

export interface ModControllerOptions {
  target?: EventTarget;
  generation?: number;
  initialSettings?: ModControllerSettings;
  getHref?: () => string;
}

type SessionOperation = () => void | boolean | Promise<void | boolean>;
type StopOperation = () => void | Promise<void>;

type ControllerPhase = 'created' | 'started' | 'ready' | 'active' | 'stopping' | 'stopped';

const GENERATION_STATE_KEY = '__babelHelperModGeneration';
const EMPTY_SETTINGS: ModControllerSettings = Object.freeze({});

type GenerationHost = typeof globalThis & {
  __babelHelperModGeneration?: number;
};

function cloneData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Mod controller payloads must be serializable.');
  }
  return JSON.parse(serialized) as T;
}

function settingsKey(settings: ModControllerSettings): string {
  return JSON.stringify(settings) || '{}';
}

function allocateGeneration(): number {
  const host = globalThis as GenerationHost;
  const previous = Number.isSafeInteger(host[GENERATION_STATE_KEY])
    ? Number(host[GENERATION_STATE_KEY])
    : 0;
  const clockGeneration = Date.now() * 1000;
  const generation = Math.max(previous + 1, clockGeneration);
  host[GENERATION_STATE_KEY] = generation;
  return generation;
}

function getDefaultTarget(): EventTarget {
  if (typeof window !== 'undefined') {
    return window;
  }
  return new EventTarget();
}

function getDefaultHref(): string {
  return typeof window === 'undefined' ? '' : window.location.href;
}

function createDataEvent(detail: ModControllerEventDetail): Event {
  if (typeof CustomEvent === 'function') {
    return new CustomEvent(BABEL_MOD_CONTROLLER_EVENT, { detail });
  }

  const event = new Event(BABEL_MOD_CONTROLLER_EVENT) as Event & {
    detail?: ModControllerEventDetail;
  };
  event.detail = detail;
  return event;
}

export function createModController(options: ModControllerOptions = {}) {
  const target = options.target || getDefaultTarget();
  const generation = options.generation ?? allocateGeneration();
  const getHref = options.getHref || getDefaultHref;
  let phase: ControllerPhase = 'created';
  let revision = 0;
  let settingsRevision = 1;
  let settings = cloneData(options.initialSettings || EMPTY_SETTINGS);
  let serializedSettings = settingsKey(settings);
  let sessionTransition = 0;
  let stopPromise: Promise<void> | null = null;
  let sessionTransitionTail: Promise<void> = Promise.resolve();
  const onHostReady = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isHostReadyDetail(detail) || phase === 'created' || phase === 'stopped') {
      return;
    }

    const replayType: ControllerTransitionType =
      phase === 'active'
        ? 'session:activate'
        : phase === 'ready'
          ? 'extension:ready'
          : phase === 'started'
            ? 'extension:start'
            : 'extension:stop';
    publish(replayType, 'host-ready-replay');
  };
  target.addEventListener(BABEL_MOD_HOST_READY_EVENT, onHostReady);

  function isCurrentGeneration(): boolean {
    if (options.generation != null) {
      return phase !== 'stopped';
    }
    return (globalThis as GenerationHost)[GENERATION_STATE_KEY] === generation;
  }
  function isStoppingOrStopped(): boolean {
    return phase === 'stopping' || phase === 'stopped';
  }

  function publish(type: ControllerTransitionType, reason: string) {
    if (!isCurrentGeneration() && type !== 'extension:stop') {
      return false;
    }

    revision += 1;
    const detail: ModControllerEventDetail = {
      protocolVersion: CONTROLLER_PROTOCOL_VERSION,
      generation,
      revision,
      settingsRevision,
      type,
      reason,
      href: getHref(),
      settings: cloneData(settings)
    };
    target.dispatchEvent(createDataEvent(detail));
    return true;
  }

  function start(reason = 'kernel-start') {
    if (phase !== 'created') {
      return false;
    }
    phase = 'started';
    return publish('extension:start', reason);
  }

  function ready(reason = 'kernel-ready') {
    if (phase === 'created') {
      start('kernel-start');
    }
    if (phase !== 'started') {
      return false;
    }
    phase = 'ready';
    return publish('extension:ready', reason);
  }

  function updateSettings(nextSettings: ModControllerSettings, reason = 'settings-update') {
    if (isStoppingOrStopped()) {
      return false;
    }

    const nextSnapshot = cloneData(nextSettings);
    const nextSerialized = settingsKey(nextSnapshot);
    if (nextSerialized === serializedSettings) {
      return false;
    }

    settings = nextSnapshot;
    serializedSettings = nextSerialized;
    settingsRevision += 1;
    if (phase === 'created') {
      return true;
    }
    return publish('settings:update', reason);
  }

  function enqueueSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = sessionTransitionTail.then(operation);
    sessionTransitionTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function activateSession(reason: string, operation: SessionOperation) {
    if (phase === 'created' || phase === 'started' || isStoppingOrStopped()) {
      return Promise.resolve(false);
    }

    const transition = ++sessionTransition;
    return enqueueSessionTransition(async () => {
      if (
        transition !== sessionTransition ||
        !isCurrentGeneration() ||
        isStoppingOrStopped()
      ) {
        return false;
      }
      const committed = await operation();
      if (
        committed === false ||
        transition !== sessionTransition ||
        !isCurrentGeneration() ||
        isStoppingOrStopped()
      ) {
        return false;
      }
      if (phase === 'active') {
        return true;
      }

      phase = 'active';
      publish('session:activate', reason);
      return true;
    });
  }

  function deactivateSession(reason: string, operation: SessionOperation) {
    if (isStoppingOrStopped()) {
      return Promise.resolve(false);
    }

    ++sessionTransition;
    return enqueueSessionTransition(async () => {
      const committed = await operation();
      if (
        committed === false ||
        !isCurrentGeneration() ||
        isStoppingOrStopped()
      ) {
        return false;
      }
      if (phase !== 'active') {
        return true;
      }

      phase = 'ready';
      publish('session:deactivate', reason);
      return true;
    });
  }

  function stop(reason = 'kernel-stop', operation: StopOperation = () => {}) {
    if (stopPromise) {
      return stopPromise;
    }

    ++sessionTransition;
    const wasActive = phase === 'active';
    phase = 'stopping';
    stopPromise = enqueueSessionTransition(async () => {
      try {
        await operation();
      } finally {
        if (wasActive) {
          publish('session:deactivate', reason);
        }
        publish('extension:stop', reason);
        target.removeEventListener(BABEL_MOD_HOST_READY_EVENT, onHostReady);
        phase = 'stopped';
      }
    });
    return stopPromise;
  }

  return {
    generation,
    get revision() {
      return revision;
    },
    get settingsRevision() {
      return settingsRevision;
    },
    get phase() {
      return phase;
    },
    isCurrentGeneration,
    start,
    ready,
    updateSettings,
    activateSession,
    deactivateSession,
    stop
  };
}

export type ModController = ReturnType<typeof createModController>;
