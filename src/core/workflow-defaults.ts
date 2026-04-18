export interface WorkflowDefaults {
  lastZoomValue: number | null;
  waveformScales: Record<string, number | null>;
}

export const WORKFLOW_DEFAULTS_STORAGE_KEY = 'workflowDefaults';
export const MIN_ZOOM_VALUE = 10;
export const MAX_ZOOM_VALUE = 2000;
export const MIN_WAVEFORM_SCALE_VALUE = 0.3;
export const MAX_WAVEFORM_SCALE_VALUE = 1000;

export const DEFAULT_WORKFLOW_DEFAULTS: WorkflowDefaults = {
  lastZoomValue: null,
  waveformScales: {}
};

function getExtensionStorage() {
  const chromeApi = (globalThis as { chrome?: any }).chrome;
  if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
    return null;
  }

  return chromeApi.storage.local;
}

export function normalizeZoomValue(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(MAX_ZOOM_VALUE, Math.max(MIN_ZOOM_VALUE, Math.round(numeric)));
}

export function normalizeWaveformScaleValue(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const clamped = Math.min(MAX_WAVEFORM_SCALE_VALUE, Math.max(MIN_WAVEFORM_SCALE_VALUE, numeric));
  return Math.round(clamped * 1000) / 1000;
}

function normalizeWaveformScaleMap(source: unknown): Record<string, number | null> {
  const incoming =
    source && typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
  const normalized: Record<string, number | null> = {};

  for (const [key, value] of Object.entries(incoming)) {
    const trimmedKey = typeof key === 'string' ? key.trim() : '';
    if (!trimmedKey) {
      continue;
    }

    normalized[trimmedKey] = normalizeWaveformScaleValue(value);
  }

  return normalized;
}

export function normalizeWorkflowDefaults(source: unknown): WorkflowDefaults {
  const incoming =
    source && typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};

  return {
    lastZoomValue: normalizeZoomValue(incoming.lastZoomValue),
    waveformScales: normalizeWaveformScaleMap(incoming.waveformScales)
  };
}

export async function loadWorkflowDefaults(): Promise<WorkflowDefaults> {
  const storage = getExtensionStorage();
  if (!storage || typeof storage.get !== 'function') {
    return normalizeWorkflowDefaults(DEFAULT_WORKFLOW_DEFAULTS);
  }

  return new Promise((resolve) => {
    storage.get(WORKFLOW_DEFAULTS_STORAGE_KEY, (items: Record<string, unknown> | undefined) => {
      const runtime = (globalThis as { chrome?: any }).chrome;
      if (runtime?.runtime?.lastError) {
        resolve(normalizeWorkflowDefaults(DEFAULT_WORKFLOW_DEFAULTS));
        return;
      }

      resolve(normalizeWorkflowDefaults(items?.[WORKFLOW_DEFAULTS_STORAGE_KEY]));
    });
  });
}

export async function saveWorkflowDefaults(defaults: WorkflowDefaults): Promise<WorkflowDefaults> {
  const normalized = normalizeWorkflowDefaults(defaults);
  const storage = getExtensionStorage();
  if (!storage || typeof storage.set !== 'function') {
    return normalized;
  }

  return new Promise((resolve) => {
    storage.set({ [WORKFLOW_DEFAULTS_STORAGE_KEY]: normalized }, () => {
      resolve(normalized);
    });
  });
}

let workflowDefaultsUpdateChain: Promise<WorkflowDefaults> = Promise.resolve(
  normalizeWorkflowDefaults(DEFAULT_WORKFLOW_DEFAULTS)
);

export async function updateWorkflowDefaults(
  updater: (defaults: WorkflowDefaults) => WorkflowDefaults | Promise<WorkflowDefaults>
): Promise<WorkflowDefaults> {
  workflowDefaultsUpdateChain = workflowDefaultsUpdateChain
    .catch(() => normalizeWorkflowDefaults(DEFAULT_WORKFLOW_DEFAULTS))
    .then(async () => {
      const current = await loadWorkflowDefaults();
      const next = await updater(current);
      return saveWorkflowDefaults(next);
    });

  return workflowDefaultsUpdateChain;
}
