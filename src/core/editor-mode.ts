export type EditorMode = 'native' | 'classic';

export const SETTINGS_STORAGE_KEY = 'settings';
export const EDITOR_MODE_RUNTIME_KEY = '__babelHelperEditorMode';
export const EDITOR_MODE_REGISTRATION_ID = 'babel-helper-editor-mode';
export const EDITOR_MODE_SYNC_MESSAGE = 'babel-helper:sync-editor-mode';

export function normalizeEditorMode(value: unknown): EditorMode {
  return value === 'classic' ? 'classic' : 'native';
}

/** The MAIN-world selection is fixed for this document, never a live storage preference. */
export function getActiveEditorMode(target: object = globalThis): EditorMode | null {
  const value = Object.getOwnPropertyDescriptor(target, EDITOR_MODE_RUNTIME_KEY)?.value;
  return value === 'native' || value === 'classic' ? value : null;
}

export function publishActiveEditorMode(mode: EditorMode, target: object = globalThis): void {
  const current = Object.getOwnPropertyDescriptor(target, EDITOR_MODE_RUNTIME_KEY);
  if (current) {
    if (current.value !== mode) throw new Error('Editor mode is already selected. Refresh the page to change it.');
    return;
  }
  Object.defineProperty(target, EDITOR_MODE_RUNTIME_KEY, { value: mode });
}

type ModeSyncResponse = { ok: true; mode: EditorMode } | { ok: false; error: string };
type ModeMessagingRuntime = {
  lastError?: { message?: string };
  sendMessage(message: { type: string; mode: EditorMode }, callback: (response?: ModeSyncResponse) => void): void;
};
type ModeMessagingScope = { chrome?: { runtime?: ModeMessagingRuntime } };

/** Storage alone cannot acknowledge a document_start registration in another process. */
export async function confirmEditorModeRegistration(mode: EditorMode): Promise<void> {
  // Chrome supplies this extension-only API; the project does not include global Chrome typings.
  const scope = globalThis as ModeMessagingScope;
  const runtime = scope.chrome?.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') {
    throw new Error('Editor startup could not be confirmed: extension messaging is unavailable.');
  }
  await new Promise<void>((resolve, reject) => {
    const fail = (reason: string) => reject(new Error(`Editor startup could not be confirmed: ${reason}`));
    try {
      runtime.sendMessage({ type: EDITOR_MODE_SYNC_MESSAGE, mode }, (response) => {
        if (runtime.lastError) {
          fail(runtime.lastError.message || 'The background service worker did not respond.');
        } else if (!response || response.ok !== true) {
          fail(response?.ok === false ? response.error : 'The background service worker did not acknowledge the registration.');
        } else if (response.mode !== mode) {
          fail('The saved editor mode changed in another window.');
        } else {
          resolve();
        }
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
}
