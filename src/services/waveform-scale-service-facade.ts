import type { WaveformScaleService } from '../core/service-contracts';

type WaveformScaleServiceHelper = {
  bindWaveformScaleUnlock?: () => unknown;
  unbindWaveformScaleUnlock?: () => void;
};

export function createWaveformScaleServiceFacade(
  helper: WaveformScaleServiceHelper
): WaveformScaleService {
  return {
    bind() {
      return Boolean(helper.bindWaveformScaleUnlock?.());
    },
    unbind() {
      helper.unbindWaveformScaleUnlock?.();
    }
  };
}
