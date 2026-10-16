import type { FeatureModule } from '../core/types';

const STYLE_ID = 'babel-helper-hide-inline-issues';

export function createHideInlineIssuesFeature(): FeatureModule {
  const install = () => {
    if (!(document.head instanceof HTMLHeadElement)) return;
    let style = document.getElementById(STYLE_ID);
    if (!(style instanceof HTMLStyleElement)) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = 'section[data-annotation-id] [data-turn-issues] { display: none !important; }';
  };
  const remove = () => document.getElementById(STYLE_ID)?.remove();
  return {
    id: 'hide-inline-issues',
    start: install,
    activate: install,
    onLoaded: install,
    deactivate: remove,
    stop: remove
  };
}
