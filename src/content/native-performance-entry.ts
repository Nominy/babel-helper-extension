import { installNativeRenderPerformance } from './native-render-performance';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';

function reportFailure(reason: string): void {
  console.error('[Babel Helper] Native rendering optimization stopped:', reason);
  const show = () => showNativeAutomationFailure('Native rendering optimization', reason);
  if (document.documentElement) show();
  else document.addEventListener('DOMContentLoaded', show, { once: true });
}

try {
  installNativeRenderPerformance({
    onStatus({ moduleId, state }: { moduleId: number; state: string }) {
      if (state === 'unsupported-native-factory-source') {
        reportFailure(`Babel module ${moduleId} does not match the verified editor version; its native implementation was left unchanged`);
      }
    }
  });
} catch (error) {
  reportFailure(error instanceof Error ? error.message : String(error));
}
