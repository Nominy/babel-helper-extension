import { installNativeRenderPerformance } from './native-render-performance';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';

function reportFailure(boundary: string, reason: string): void {
  console.error('[Babel Helper] Native optimization stopped:', boundary, reason);
  const show = () => showNativeAutomationFailure(`Native ${boundary.replace(/-/g, ' ')}`, reason);
  if (document.documentElement) show();
  else document.addEventListener('DOMContentLoaded', show, { once: true });
}

try {
  installNativeRenderPerformance({
    onStatus({ boundary, state, reason }) {
      if (state === 'unsupported') {
        reportFailure(boundary, reason || 'The required native boundary is unavailable');
      }
    }
  });
} catch (error) {
  reportFailure('rendering hooks', error instanceof Error ? error.message : String(error));
}
