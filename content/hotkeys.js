(function registerBabelHelperHotkeys() {
  const helper = window.__babelWorkflowHelper;
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
    wrapper.style.marginTop = '12px';
    wrapper.style.paddingTop = '12px';
    wrapper.style.borderTop = '1px solid rgba(148, 163, 184, 0.35)';

    const title = document.createElement('div');
    title.textContent = 'Babel Helper';
    title.style.fontWeight = '700';
    title.style.fontSize = '14px';
    title.style.marginBottom = '8px';
    wrapper.appendChild(title);

    for (const [shortcut, description] of helper.config.hotkeysHelpRows) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.gap = '12px';
      row.style.marginTop = '4px';

      const text = document.createElement('span');
      text.textContent = description;
      text.style.flex = '1';
      text.style.minWidth = '0';
      text.style.fontSize = '14px';
      text.style.color = 'rgb(51, 65, 85)';
      text.style.textAlign = 'left';

      const key = document.createElement('kbd');
      key.textContent = shortcut;
      key.style.marginLeft = 'auto';
      key.style.padding = '3px 8px';
      key.style.border = '1px solid rgb(226, 232, 240)';
      key.style.borderRadius = '8px';
      key.style.background = 'rgb(248, 250, 252)';
      key.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
      key.style.fontSize = '12px';
      key.style.fontWeight = '700';
      key.style.whiteSpace = 'nowrap';
      key.style.color = 'rgb(100, 116, 139)';

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
})();
