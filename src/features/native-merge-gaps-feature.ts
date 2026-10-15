import type { FeatureModule } from '../core/types';
import { NATIVE_COMPATIBILITY_CHANGE_EVENT, NATIVE_MERGE_GAPS_ATTRIBUTE } from '../core/native-compatibility';

export function createNativeMergeGapsFeature(): FeatureModule {
  const enable = () => {
    document.documentElement.setAttribute(NATIVE_MERGE_GAPS_ATTRIBUTE, 'true');
    window.dispatchEvent(new Event(NATIVE_COMPATIBILITY_CHANGE_EVENT));
  };
  const disable = () => {
    document.documentElement.removeAttribute(NATIVE_MERGE_GAPS_ATTRIBUTE);
    window.dispatchEvent(new Event(NATIVE_COMPATIBILITY_CHANGE_EVENT));
  };
  return { id: 'native-merge-across-gaps', activate: enable, onLoaded: enable, deactivate: disable, stop: disable };
}
