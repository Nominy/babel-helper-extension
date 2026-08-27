export type ServiceOptions = Readonly<Record<string, unknown>>;

export interface SessionService {
  isInteractive(): boolean;
}

export interface RowService {
  getTranscriptRows(): HTMLTableRowElement[];
}

export interface ActionMenuService {
  runRowAction(actionName: string, options?: unknown): unknown;
}

export interface FocusService {
  toggleEditorFocus(): unknown;
  focusRow(row: HTMLElement, options?: unknown): unknown;
}

export interface HotkeysHelpService {
  enhanceHotkeysDialog(): void;
}

export interface TimelineSelectionService {
  bind(): void;
  unbind(): void;
  clear(): void;
}

export interface SmartSplitService {
  commit(options?: unknown): unknown;
}

export interface TimestampEditService {
  snapshotTranscriptWithNativeBridge(): Promise<unknown>;
  setSegmentBoundaryTime(options: ServiceOptions): Promise<unknown>;
  splitSegmentAtTime(options: ServiceOptions): Promise<unknown>;
  mergeSegmentWithNativeAction(options: ServiceOptions): Promise<unknown>;
  createSegmentWithNativeAction(options: ServiceOptions): Promise<unknown>;
  deleteSegmentWithNativeAction(options: ServiceOptions): Promise<unknown>;
}

export interface WaveformScaleService {
  bind(): boolean;
  unbind(): void;
}

export interface MagnifierService {
  bind(): void;
  unbind(): void;
  clear(): void;
}

export interface MinimapService {
  bindMinimap(): void;
  unbindMinimap(): void;
  clearMinimap(): void;
}

export interface BridgeClientService {
  call(operation: string, payload?: unknown): unknown;
}

export interface BuiltinServiceMap {
  session: SessionService;
  rows: RowService;
  actions: ActionMenuService;
  focus: FocusService;
  hotkeysHelp: HotkeysHelpService;
  timelineSelection: TimelineSelectionService;
  smartSplit: SmartSplitService;
  timestampEdit: TimestampEditService;
  waveformScale: WaveformScaleService;
  magnifier: MagnifierService;
  minimap: MinimapService;
  bridge: BridgeClientService;
}

export const BUILTIN_SERVICE_KEYS = [
  'session',
  'rows',
  'actions',
  'focus',
  'hotkeysHelp',
  'timelineSelection',
  'smartSplit',
  'timestampEdit',
  'waveformScale',
  'magnifier',
  'minimap',
  'bridge'
] as const satisfies readonly (keyof BuiltinServiceMap)[];
