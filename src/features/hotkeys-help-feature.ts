// @ts-nocheck
import { themeRoot, applyComponent } from '@nominy/babel-extension-frontend';

import type { FeatureModule } from '../core/types';

export function registerHotkeysHelpService(helper: any) {
  if (!helper || helper.__hotkeysRegistered) {
    return;
  }

  helper.__hotkeysRegistered = true;

  helper.findHotkeysHosts = function findHotkeysHosts() {
    const candidates = Array.from(
      document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]')
    );

    return candidates
      .filter((candidate) => candidate instanceof HTMLElement && helper.isVisible(candidate))
      .map((candidate) =>
        candidate.matches('[role="dialog"]') ? candidate : candidate.querySelector('[role="dialog"]') || candidate
      )
      .filter((candidate) => candidate instanceof HTMLElement && helper.isVisible(candidate))
      .filter((candidate) => {
        const text = helper.normalizeText(candidate);
        return helper.config.hotkeysDialogPatterns.some((pattern) => pattern.test(text));
      });
  };

  helper.buildHotkeysHelpBlock = function buildHotkeysHelpBlock() {
    const wrapper = document.createElement('div');
    wrapper.setAttribute(helper.config.hotkeysHelpMarker, 'true');
    themeRoot(wrapper, 'white');
    applyComponent(wrapper, 'body');
    wrapper.style.marginTop = '12px';
    wrapper.style.paddingTop = '12px';
    wrapper.style.borderTop = '1px solid rgba(148, 163, 184, 0.35)';

    const title = document.createElement('div');
    applyComponent(title, 'row');
    title.style.marginBottom = '8px';
    title.style.display = 'flex';
    title.style.alignItems = 'center';
    title.style.gap = '8px';
    title.style.flexWrap = 'wrap';

    const titleText = document.createElement('span');
    applyComponent(titleText, 'title');
    titleText.textContent = 'Babel Helper';

    const supportLink = document.createElement('a');
    applyComponent(supportLink, 'link');
    supportLink.classList.add('babel-helper-support-link');
    supportLink.href = 'https://ko-fi.com/naftsan';
    supportLink.target = '_blank';
    supportLink.rel = 'noopener noreferrer';
    supportLink.textContent = 'if this extension saves you time, consider supporting development on Ko-Fi';
    supportLink.style.textDecoration = 'none';
    supportLink.addEventListener('click', (event) => event.stopPropagation());

    title.appendChild(titleText);
    title.appendChild(supportLink);
    wrapper.appendChild(title);

    for (const [shortcut, description] of helper.config.hotkeysHelpRows) {
      const row = document.createElement('div');
    applyComponent(row, 'row');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.gap = '12px';
      row.style.marginTop = '4px';

      const text = document.createElement('span');
    applyComponent(text, 'meta');
      text.textContent = description;
      text.style.flex = '1';
      text.style.minWidth = '0';
      text.style.textAlign = 'left';

      const key = document.createElement('kbd');
    applyComponent(key, 'kbd');
      key.textContent = shortcut;
      key.style.marginLeft = 'auto';
      key.style.padding = '3px 8px';
      key.style.whiteSpace = 'nowrap';

      row.appendChild(text);
      row.appendChild(key);
      wrapper.appendChild(row);
    }

    return wrapper;
  };

  helper.enhanceHotkeysDialog = function enhanceHotkeysDialog() {
    for (const host of helper.findHotkeysHosts()) {
      if (
        !(host instanceof HTMLElement) ||
        host.querySelector('[' + helper.config.hotkeysHelpMarker + ']')
      ) {
        continue;
      }

      const contentTarget =
        host.querySelector('[data-slot="dialog-content"]') ||
        host.querySelector('[class*="overflow-y-auto"]') ||
        host.querySelector('[class*="overflow-auto"]') ||
        host.querySelector('[class*="max-h"]') ||
        host;
      if (contentTarget instanceof HTMLElement) {
        contentTarget.style.overflowY = 'auto';
        contentTarget.style.maxHeight = 'min(80vh, calc(100vh - 96px))';
      }
      contentTarget.appendChild(helper.buildHotkeysHelpBlock());
    }
  };
}

export function createHotkeysHelpFeature(): FeatureModule {
  return {
    id: 'hotkeys-help',
    register(ctx) {
      if (!Array.isArray(ctx.config.hotkeysHelpRows)) {
        ctx.config.hotkeysHelpRows = [];
      }
    }
  };
}
