export interface WorkflowDefaults {
  lastZoomValue: number | null;
}

export const WORKFLOW_DEFAULTS_STORAGE_KEY = 'workflowDefaults';
export const MIN_ZOOM_VALUE = 10;
export const MAX_ZOOM_VALUE = 2000;

export const DEFAULT_WORKFLOW_DEFAULTS: WorkflowDefaults = {
  lastZoomValue: null
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

export function normalizeWorkflowDefaults(source: unknown): WorkflowDefaults {
  const incoming =
    source && typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};

  return {
    lastZoomValue: normalizeZoomValue(incoming.lastZoomValue)
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
