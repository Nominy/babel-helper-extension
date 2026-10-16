import { installNativeRenderPerformance } from './native-render-performance';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';
import { createNativeEditorAdapter } from './native-render-editor';
import { selectEditorAdapterFactory } from './editor-mode-adapter';
import { getActiveEditorMode } from '../core/editor-mode';

function reportFailure(boundary: string, reason: string): void {
  const mode = getActiveEditorMode() === 'classic' ? 'Classic' : 'Native';
  console.error(`[Babel Helper] ${mode} rendering stopped:`, boundary, reason);
  const show = () => showNativeAutomationFailure(`${mode} ${boundary.replace(/-/g, ' ')}`, reason);
  if (document.documentElement) show();
  else document.addEventListener('DOMContentLoaded', show, { once: true });
}

try {
  installNativeRenderPerformance({
    adapterFactory: (report, nativeRequire) => selectEditorAdapterFactory(createNativeEditorAdapter)(report, nativeRequire),
    onStatus({ boundary, state, reason }) {
      if (state === 'unsupported') {
        reportFailure(boundary, reason || 'The required native boundary is unavailable');
      }
    }
  });
} catch (error) {
  reportFailure('rendering hooks', error instanceof Error ? error.message : String(error));
}
