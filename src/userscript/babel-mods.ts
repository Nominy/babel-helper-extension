const API_VERSION = 1 as const;
const GLOBAL_NAME = 'BabelMods' as const;
const QUEUE_NAME = '__BABEL_MOD_QUEUE__' as const;
const PENDING_REGISTRATION = Symbol.for('babel-mods.pending-registration');

type Disposable = { dispose(): void | Promise<void> };

type ModDefinition = {
  id: string;
  apiVersion?: number;
  [key: string]: unknown;
};

type ModHost = {
  readonly apiVersion: number;
  register(definition: ModDefinition): Disposable;
};

type PendingDefinition = ModDefinition & {
  [PENDING_REGISTRATION]?: (handle: Disposable) => void;
};

type ModWindow = Window & typeof globalThis & {
  BabelMods?: ModHost;
  __BABEL_MOD_QUEUE__?: PendingDefinition[];
  BabelModsSDK?: BabelModsClient;
};

export interface BabelModsClient {
  readonly apiVersion: typeof API_VERSION;
  define<T extends ModDefinition>(definition: T): T & { apiVersion: typeof API_VERSION };
  register(definition: ModDefinition): Disposable;
  defineMod<T extends ModDefinition>(definition: T): T & { apiVersion: typeof API_VERSION };
  registerMod(definition: ModDefinition): Disposable;
  getHost(): ModHost | undefined;
  isCompatible(host?: Pick<ModHost, 'apiVersion'>): boolean;
  requireCompatible(host?: Pick<ModHost, 'apiVersion'>): ModHost;
}

function currentWindow(): ModWindow {
  return window as ModWindow;
}

function assertDefinition(definition: ModDefinition): void {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('A Babel mod definition must be an object.');
  }
  if (typeof definition.id !== 'string' || definition.id.trim() === '') {
    throw new TypeError('A Babel mod definition requires a non-empty id.');
  }
  if (definition.apiVersion !== undefined && definition.apiVersion !== API_VERSION) {
    throw new Error(
      `Mod ${definition.id} targets BabelMods API ${String(definition.apiVersion)}; this client supports API ${API_VERSION}.`
    );
  }
}

export function define<T extends ModDefinition>(definition: T): T & { apiVersion: typeof API_VERSION } {
  assertDefinition(definition);
  if (definition.apiVersion === API_VERSION) return definition as T & { apiVersion: typeof API_VERSION };
  return Object.assign({}, definition, { apiVersion: API_VERSION });
}

export function getHost(): ModHost | undefined {
  const host = currentWindow()[GLOBAL_NAME];
  return host && typeof host.register === 'function' ? host : undefined;
}

export function isCompatible(host: Pick<ModHost, 'apiVersion'> | undefined = getHost()): boolean {
  return host?.apiVersion === API_VERSION;
}

export function requireCompatible(host: Pick<ModHost, 'apiVersion'> | undefined = getHost()): ModHost {
  if (!host) throw new Error('The BabelMods host is not installed in this page.');
  if (!isCompatible(host)) {
    throw new Error(`BabelMods API ${String(host.apiVersion)} is incompatible with client API ${API_VERSION}.`);
  }
  return host as ModHost;
}

export function register(input: ModDefinition): Disposable {
  let definition = define(input);
  const host = getHost();
  if (host) return requireCompatible(host).register(definition);
  if (!Object.isExtensible(definition)) definition = Object.assign({}, definition);

  const target = currentWindow();
  const queue = target[QUEUE_NAME] ?? (target[QUEUE_NAME] = []);
  let connected: Disposable | undefined;
  let disposed = false;

  Object.defineProperty(definition, PENDING_REGISTRATION, {
    configurable: true,
    enumerable: false,
    value(handle: Disposable) {
      connected = handle;
      if (disposed) void handle.dispose();
    }
  });
  queue.push(definition);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      const index = queue.indexOf(definition);
      if (index >= 0) queue.splice(index, 1);
      if (connected) return connected.dispose();
    }
  };
}
export const defineMod = define;
export const registerMod = register;


export const BabelModsSDK: BabelModsClient = Object.freeze({
  apiVersion: API_VERSION,
  define,
  register,
  defineMod,
  registerMod,
  getHost,
  isCompatible,
  requireCompatible
});

if (typeof window !== 'undefined') {
  const target = currentWindow();
  const existing = target.BabelModsSDK;
  if (existing && existing.apiVersion !== API_VERSION) {
    throw new Error(`BabelModsSDK API ${String(existing.apiVersion)} is already installed.`);
  }
  target.BabelModsSDK = existing ?? BabelModsSDK;
}
