export const MOD_API_VERSION = 1 as const;
export const CONTROLLER_PROTOCOL_VERSION = 1 as const;

export const BABEL_MOD_GLOBAL_NAME = 'BabelMods' as const;
export const BABEL_MOD_QUEUE_NAME = '__BABEL_MOD_QUEUE__' as const;
export const BABEL_MOD_CONTROLLER_EVENT = 'babel-mods:controller' as const;
export const BABEL_MOD_HOST_READY_EVENT = 'babel-mods:host-ready' as const;

export const CONTROLLER_TRANSITION_TYPES = [
  'extension:start',
  'extension:ready',
  'extension:stop',
  'settings:update',
  'session:activate',
  'session:deactivate'
] as const;

export type ControllerTransitionType = (typeof CONTROLLER_TRANSITION_TYPES)[number];

/**
 * The controller channel is deliberately data-only. Functions and object
 * identities belong to the MAIN-world API and must never be put in detail.
 */
export interface ControllerTransition {
  readonly protocolVersion: typeof CONTROLLER_PROTOCOL_VERSION;
  readonly generation: number;
  readonly revision: number;
  readonly settingsRevision: number;
  readonly type: ControllerTransitionType;
  readonly reason: string;
  readonly settings?: unknown;
  readonly sessionToken?: string;
  readonly href?: string;
}

export interface HostReadyDetail {
  readonly protocolVersion: typeof CONTROLLER_PROTOCOL_VERSION;
  readonly apiVersion: typeof MOD_API_VERSION;
  readonly generation: number;
  readonly internalsVersion: string;
}

const CONTROLLER_TRANSITION_TYPE: Record<ControllerTransitionType, true> = {
  'extension:start': true,
  'extension:ready': true,
  'extension:stop': true,
  'settings:update': true,
  'session:activate': true,
  'session:deactivate': true
};

export function isControllerTransition(value: unknown): value is ControllerTransition {
  if (!isRecord(value)) return false;

  return (
    value.protocolVersion === CONTROLLER_PROTOCOL_VERSION &&
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.settingsRevision === 'number' &&
    Number.isSafeInteger(value.settingsRevision) &&
    value.settingsRevision >= 0 &&
    typeof value.type === 'string' &&
    Object.prototype.hasOwnProperty.call(CONTROLLER_TRANSITION_TYPE, value.type) &&
    typeof value.reason === 'string' &&
    (value.href === undefined || typeof value.href === 'string') &&
    (value.sessionToken === undefined || typeof value.sessionToken === 'string')
  );
}

export function isHostReadyDetail(value: unknown): value is HostReadyDetail {
  if (!isRecord(value)) return false;

  return (
    value.protocolVersion === CONTROLLER_PROTOCOL_VERSION &&
    value.apiVersion === MOD_API_VERSION &&
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    typeof value.internalsVersion === 'string'
  );
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}
