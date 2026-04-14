export type Disposer = () => void;

export interface FeatureContext {
  helper: any;
  services: ServiceRegistry;
  state: any;
  config: any;
  runtime: any;
  onDispose: (disposer: Disposer) => void;
  logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface FeatureModule {
  id: string;
  dependsOn?: string[];
  register?: (ctx: FeatureContext) => void;
  start?: (ctx: FeatureContext) => void | Promise<void>;
  onLoaded?: (ctx: FeatureContext) => void | Promise<void>;
  stop?: (ctx: FeatureContext) => void | Promise<void>;
}

export interface ServiceRegistry {
  session: any;
  rows: any;
  actions: any;
  focus: any;
  hotkeysHelp: any;
  timelineSelection: any;
  smartSplit: any;
  waveformScale: any;
  magnifier: any;
  minimap: any;
  bridge: any;
}

