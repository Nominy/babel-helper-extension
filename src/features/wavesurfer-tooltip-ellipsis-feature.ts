import type { FeatureModule } from '../core/types';

const STYLE_ID = 'babel-helper-wavesurfer-tooltip-ellipsis';

const WAVESURFER_TOOLTIP_ELLIPSIS_CSS = `
  .wavesurfer-region-label-tooltip > span {
    width: 200px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`.trim();

export function createWavesurferTooltipEllipsisFeature(): FeatureModule {
  const install = () => {
      if (!(document.head instanceof HTMLHeadElement)) {
        return;
      }

      let style = document.getElementById(STYLE_ID);
      if (!(style instanceof HTMLStyleElement)) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }

      style.textContent = WAVESURFER_TOOLTIP_ELLIPSIS_CSS;
  };
  return {
    id: 'wavesurfer-tooltip-ellipsis',
    start: install,
    activate: install,
    deactivate() {
      document.getElementById(STYLE_ID)?.remove();
    },
    stop() {
      document.getElementById(STYLE_ID)?.remove();
    }
  };
}
