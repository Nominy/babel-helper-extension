import {
  EDITOR_MODE_REGISTRATION_ID,
  EDITOR_MODE_SYNC_MESSAGE,
  SETTINGS_STORAGE_KEY,
  normalizeEditorMode,
  type EditorMode
} from '../core/editor-mode';

type RegisteredScript = {
  id: string;
  matches?: string[];
  js?: string[];
  css?: string[];
  runAt?: string;
  world?: string;
  persistAcrossSessions?: boolean;
  allFrames?: boolean;
};
type ExtensionManifest = {
  content_scripts?: Array<{ matches?: string[]; js?: string[]; world?: string }>;
};
type StorageChange = { oldValue?: unknown; newValue?: unknown };
type ModeResponse = { ok: true; mode: EditorMode } | { ok: false; error: string };
type EditorModeChrome = {
  runtime: {
    id: string;
    getManifest(): ExtensionManifest;
    onInstalled: { addListener(listener: () => void): void };
    onStartup: { addListener(listener: () => void): void };
    onMessage: {
      addListener(listener: (message: unknown, sender: { id?: string }, respond: (response: ModeResponse) => void) => boolean | undefined): void;
    };
  };
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>> };
    onChanged: { addListener(listener: (changes: Record<string, StorageChange>, area: string) => void): void };
  };
  scripting: {
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<RegisteredScript[]>;
    registerContentScripts(scripts: RegisteredScript[]): Promise<void>;
    updateContentScripts(scripts: RegisteredScript[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  };
};

function storedMode(settings: unknown): EditorMode {
  return normalizeEditorMode(settings && typeof settings === 'object' && 'editorMode' in settings ? settings.editorMode : undefined);
}

/** Updates the next-document registration only; never injects into or reloads an open tab. */
export function installEditorModeBackground(api: EditorModeChrome): void {
  let pending: Promise<EditorMode | void> = Promise.resolve();

  function synchronize(expectedMode?: EditorMode): Promise<EditorMode> {
    const run = async (): Promise<EditorMode> => {
      const stored = await api.storage.local.get(SETTINGS_STORAGE_KEY);
      const mode = storedMode(stored[SETTINGS_STORAGE_KEY]);
      if (expectedMode !== undefined && expectedMode !== mode) {
        throw new Error('The saved editor mode changed in another window. Reopen settings before changing it again.');
      }
      const [registered] = await api.scripting.getRegisteredContentScripts({ ids: [EDITOR_MODE_REGISTRATION_ID] });
      if (mode === 'native') {
        // Native bootstrap is static, including the very first installation page.
        // Removing preparation affects future documents only, not an open editor.
        if (registered) await api.scripting.unregisterContentScripts({ ids: [EDITOR_MODE_REGISTRATION_ID] });
      } else {
        // The isolated runner rewrites these same matches to localhost. Production
        // permissions and activation remain limited to the Babel dashboard manifest.
        const matches = [...new Set(api.runtime.getManifest().content_scripts
          ?.filter((script) => script.world === 'MAIN' && script.js?.includes('dist/content/mod-host.js'))
          .flatMap((script) => script.matches ?? []) ?? [])];
        if (matches.length === 0) throw new Error('The manifest has no MAIN editor host matches.');
        const desired: RegisteredScript = {
          id: EDITOR_MODE_REGISTRATION_ID,
          matches,
          js: ['dist/content/classic-performance-entry.js'],
          css: ['dist/classic/editor.css'],
          runAt: 'document_start',
          world: 'MAIN',
          persistAcrossSessions: true,
          allFrames: false
        };
        if (!registered) {
          await api.scripting.registerContentScripts([desired]);
        } else if (
          registered.runAt !== desired.runAt || registered.world !== desired.world ||
          registered.persistAcrossSessions !== true || registered.allFrames === true ||
          JSON.stringify(registered.matches ?? []) !== JSON.stringify(desired.matches) ||
          JSON.stringify(registered.js ?? []) !== JSON.stringify(desired.js) ||
          JSON.stringify(registered.css ?? []) !== JSON.stringify(desired.css)
        ) {
          await api.scripting.updateContentScripts([desired]);
        }
      }
      const latest = await api.storage.local.get(SETTINGS_STORAGE_KEY);
      if (storedMode(latest[SETTINGS_STORAGE_KEY]) !== mode) {
        throw new Error('The saved editor mode changed while registration was in progress. Reopen Settings to confirm it.');
      }
      return mode;
    };
    const result = pending.then(run, run);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  function synchronizeFromEvent(): void {
    void synchronize().catch((error: unknown) => {
      console.error('[Babel Helper] Editor startup registration failed. Open Settings to apply the editor mode again.', error);
    });
  }

  api.runtime.onInstalled.addListener(synchronizeFromEvent);
  api.runtime.onStartup.addListener(synchronizeFromEvent);
  api.storage.onChanged.addListener((changes, area) => {
    const change = changes[SETTINGS_STORAGE_KEY];
    if (area === 'local' && change && storedMode(change.oldValue) !== storedMode(change.newValue)) {
      synchronizeFromEvent();
    }
  });
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== api.runtime.id || !message || typeof message !== 'object' ||
        !('type' in message) || message.type !== EDITOR_MODE_SYNC_MESSAGE) return;
    if (!('mode' in message) || (message.mode !== 'native' && message.mode !== 'classic')) {
      respond({ ok: false, error: 'Unknown editor mode.' });
      return;
    }
    void synchronize(message.mode).then(
      (mode) => respond({ ok: true, mode }),
      (error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  });
}

declare const chrome: EditorModeChrome;
installEditorModeBackground(chrome);
