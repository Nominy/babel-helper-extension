import type { FeatureModule } from '../core/types';

export const TAG_DROPDOWN_KEYBOARD_ATTRIBUTE = 'data-babel-helper-native-tag-dropdown-keyboard';

export function createNativeTagDropdownKeyboardFeature(): FeatureModule {
  return {
    id: 'native-tag-dropdown-keyboard',
    activate() {
      document.documentElement.setAttribute(TAG_DROPDOWN_KEYBOARD_ATTRIBUTE, 'true');
    },
    onLoaded() {
      document.documentElement.setAttribute(TAG_DROPDOWN_KEYBOARD_ATTRIBUTE, 'true');
    },
    deactivate() {
      document.documentElement.removeAttribute(TAG_DROPDOWN_KEYBOARD_ATTRIBUTE);
    },
    stop() {
      document.documentElement.removeAttribute(TAG_DROPDOWN_KEYBOARD_ATTRIBUTE);
    },
  };
}
