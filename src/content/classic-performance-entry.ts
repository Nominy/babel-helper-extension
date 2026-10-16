import { createClassicEditorAdapter } from './classic-editor';
import { registerClassicEditorAdapter } from './editor-mode-adapter';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';

function reportFailure(boundary: string, reason: string): void {
  console.error('[Babel Helper] Classic editor stopped:', boundary, reason);
  const show = () => showNativeAutomationFailure(`Classic ${boundary.replace(/-/g, ' ')}`, reason);
  if (document.documentElement) show();
  else document.addEventListener('DOMContentLoaded', show, { once: true });
}

try {
  registerClassicEditorAdapter(createClassicEditorAdapter);
} catch (error) {
  reportFailure('rendering hooks', error instanceof Error ? error.message : String(error));
}
