import type { FeatureModule } from '../core/types';

export const SEGMENT_CLICK_SEEK_ATTRIBUTE = 'data-babel-helper-disable-segment-click-seek';

export function createNativeSegmentClickSeekFeature(): FeatureModule {
  return {
    id: 'disable-native-segment-click-seek',
    activate() {
      document.documentElement.setAttribute(SEGMENT_CLICK_SEEK_ATTRIBUTE, 'true');
    },
    onLoaded() {
      document.documentElement.setAttribute(SEGMENT_CLICK_SEEK_ATTRIBUTE, 'true');
    },
    deactivate() {
      document.documentElement.removeAttribute(SEGMENT_CLICK_SEEK_ATTRIBUTE);
    },
    stop() {
      document.documentElement.removeAttribute(SEGMENT_CLICK_SEEK_ATTRIBUTE);
    },
  };
}
