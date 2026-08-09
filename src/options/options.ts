import {
  CUSTOM_LINTER_DEFAULTS_VERSION,
  CUSTOM_LINTER_RULE_SETTINGS,
  DEFAULT_EXTENSION_SETTINGS,
  FEATURE_KEYS,
  FEATURE_META,
  decodeGhostCursorSettingsShare,
  encodeGhostCursorSettingsShare,
  type ExtensionSettings,
  type FeatureSettingKey,
  type GhostCursorSettings,
  loadExtensionSettings,
  saveExtensionSettings
} from '../core/settings';
import { formatHighlightedWordsForTextarea, normalizeHighlightedWords } from '../core/highlighted-words';

type InputMap = Record<FeatureSettingKey, HTMLInputElement>;
type RuleInputMap = Record<string, HTMLInputElement>;
type GhostCursorInputMap = {
  gradientEnabled: HTMLInputElement;
  color: HTMLInputElement;
  gradientColor: HTMLInputElement;
  thickness: HTMLInputElement;
  thicknessValue: HTMLOutputElement;
  motion: HTMLSelectElement;
};


function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error('Missing required element: ' + selector);
  }

  return element as T;
}

function getFeatureInputs(): InputMap {
  const inputs = {} as InputMap;

  for (const key of FEATURE_KEYS) {
    const input = document.querySelector<HTMLInputElement>(`input[name="${key}"]`);
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Missing feature checkbox: ' + key);
    }

    inputs[key] = input;
  }

  return inputs;
}

function getGhostCursorInputs(): GhostCursorInputMap {
  return {
    gradientEnabled: requireElement<HTMLInputElement>('[data-role="ghost-cursor-gradient-enabled"]'),
    color: requireElement<HTMLInputElement>('[data-role="ghost-cursor-color"]'),
    gradientColor: requireElement<HTMLInputElement>('[data-role="ghost-cursor-gradient-color"]'),
    thickness: requireElement<HTMLInputElement>('[data-role="ghost-cursor-thickness"]'),
    thicknessValue: requireElement<HTMLOutputElement>('[data-role="ghost-cursor-thickness-value"]'),
    motion: requireElement<HTMLSelectElement>('[data-role="ghost-cursor-motion"]')
  };
}

function renderFeatureCards(list: HTMLElement) {
  const fragment = document.createDocumentFragment();

  for (const key of FEATURE_KEYS) {
    const card = document.createElement('label');
    card.className = 'feature-card';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = key;
    input.className = 'feature-toggle';

    const details = document.createElement('div');
    details.className = 'feature-details';

    const title = document.createElement('div');
    title.className = 'feature-title';
    title.textContent = FEATURE_META[key].label;

    const description = document.createElement('div');
    description.className = 'feature-description';
    description.textContent = FEATURE_META[key].description;

    details.appendChild(title);
    details.appendChild(description);

    if (key === 'customLinter' || key === 'proportionalCursorRestore') {
      const actions = document.createElement('div');
      actions.className = 'feature-actions';

      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'link-btn';
      actionButton.dataset.role =
        key === 'customLinter' ? 'manage-custom-linter-rules' : 'customize-ghost-cursor';
      actionButton.textContent = key === 'customLinter' ? 'Manage rules' : 'Customize ghost cursor';
      actions.appendChild(actionButton);
      details.appendChild(actions);
    }

    card.appendChild(input);
    card.appendChild(details);
    fragment.appendChild(card);
  }

  list.replaceChildren(fragment);
}

function renderCustomLinterRuleCards(list: HTMLElement): RuleInputMap {
  const inputs: RuleInputMap = {};
  const fragment = document.createDocumentFragment();

  for (const rule of CUSTOM_LINTER_RULE_SETTINGS) {
    const card = document.createElement('label');
    card.className = 'rule-card';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = `custom-linter-rule-${rule.id}`;
    input.className = 'rule-toggle';
    input.dataset.ruleId = rule.id;

    const details = document.createElement('span');

    const title = document.createElement('span');
    title.className = 'rule-title';
    title.textContent = rule.label;

    const description = document.createElement('span');
    description.className = 'rule-description';
    description.textContent = rule.description;

    details.appendChild(title);
    details.appendChild(description);
    card.appendChild(input);
    card.appendChild(details);
    fragment.appendChild(card);
    inputs[rule.id] = input;
  }

  list.replaceChildren(fragment);
  return inputs;
}

function applyGhostCursorSettingsToInputs(
  settings: GhostCursorSettings,
  inputs: GhostCursorInputMap
) {
  inputs.gradientEnabled.checked = settings.gradientEnabled;
  inputs.color.value = settings.color;
  inputs.gradientColor.value = settings.gradientColor;
  inputs.thickness.value = String(settings.thickness);
  inputs.thicknessValue.value = String(settings.thickness);
  inputs.thicknessValue.textContent = `${settings.thickness} px`;
  inputs.motion.value = settings.motion;
}

function readGhostCursorSettingsFromInputs(inputs: GhostCursorInputMap): GhostCursorSettings {
  return {
    gradientEnabled: inputs.gradientEnabled.checked,
    color: inputs.color.value,
    gradientColor: inputs.gradientColor.value,
    thickness: Number.parseInt(inputs.thickness.value, 10),
    motion: inputs.motion.value as GhostCursorSettings['motion']
  };
}

function applySettingsToInputs(
  settings: ExtensionSettings,
  inputs: InputMap,
  ruleInputs: RuleInputMap | undefined,
  highlightedWordsInput: HTMLTextAreaElement | undefined,
  highlightedWordsEnabledInput: HTMLInputElement | undefined,
  ghostCursorInputs: GhostCursorInputMap
) {
  for (const key of FEATURE_KEYS) {
    inputs[key].checked = Boolean(settings.features[key]);
  }

  if (ruleInputs) {
    const disabledRuleIds = new Set(settings.disabledCustomLinterRuleIds);
    for (const rule of CUSTOM_LINTER_RULE_SETTINGS) {
      if (ruleInputs[rule.id]) {
        ruleInputs[rule.id].checked = !disabledRuleIds.has(rule.id);
      }
    }
  }

  if (highlightedWordsEnabledInput) {
    highlightedWordsEnabledInput.checked = settings.highlightedWordsEnabled !== false;
  }

  if (highlightedWordsInput) {
    highlightedWordsInput.value = formatHighlightedWordsForTextarea(settings.highlightedWords);
  }

  applyGhostCursorSettingsToInputs(settings.ghostCursor, ghostCursorInputs);
}

function readSettingsFromInputs(
  inputs: InputMap,
  ruleInputs: RuleInputMap,
  highlightedWordsInput: HTMLTextAreaElement,
  highlightedWordsEnabledInput: HTMLInputElement,
  ghostCursorInputs: GhostCursorInputMap
): ExtensionSettings {
  const features = {} as ExtensionSettings['features'];
  for (const key of FEATURE_KEYS) {
    features[key] = inputs[key].checked;
  }

  return {
    features,
    highlightedWordsEnabled: highlightedWordsEnabledInput.checked,
    highlightedWords: normalizeHighlightedWords(highlightedWordsInput.value),
    disabledCustomLinterRuleIds: CUSTOM_LINTER_RULE_SETTINGS
      .filter((rule) => ruleInputs[rule.id] && !ruleInputs[rule.id].checked)
      .map((rule) => rule.id),
    customLinterDefaultsVersion: CUSTOM_LINTER_DEFAULTS_VERSION,
    ghostCursor: readGhostCursorSettingsFromInputs(ghostCursorInputs)
  };
}

function setStatus(statusElement: HTMLElement, message: string) {
  statusElement.textContent = message;
}

function downloadJson(data: unknown, filename: string) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function loadAnalyticsData(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chromeApi = (globalThis as { chrome?: any }).chrome;
    if (!chromeApi?.storage?.local) {
      reject(new Error('Chrome storage API not available'));
      return;
    }
    chromeApi.storage.local.get('babel_helper_analytics', (items: Record<string, unknown> | undefined) => {
      resolve(items?.['babel_helper_analytics'] ?? null);
    });
  });
}

async function boot() {
  const featureList = requireElement<HTMLElement>('[data-role="feature-list"]');
  const statusElement = requireElement<HTMLElement>('[data-role="status"]');
  const resetButton = requireElement<HTMLButtonElement>('[data-role="reset"]');
  const downloadButton = requireElement<HTMLButtonElement>('[data-role="download-logs"]');
  const highlightedWordsEnabledInput = requireElement<HTMLInputElement>('[data-role="highlighted-words-enabled"]');
  const highlightedWordsInput = requireElement<HTMLTextAreaElement>('[data-role="highlighted-words"]');
  const ghostCursorInputs = getGhostCursorInputs();
  const settingsHome = requireElement<HTMLElement>('[data-role="settings-home"]');
  const customLinterRulePage = requireElement<HTMLElement>('[data-role="custom-linter-rule-page"]');
  const customLinterRuleList = requireElement<HTMLElement>('[data-role="custom-linter-rule-list"]');
  const ghostCursorPage = requireElement<HTMLElement>('[data-role="ghost-cursor-page"]');
  const backFromGhostCursorButton = requireElement<HTMLButtonElement>('[data-role="back-from-ghost-cursor"]');
  const shareInput = requireElement<HTMLInputElement>('[data-role="ghost-cursor-share"]');
  const importShareInput = requireElement<HTMLInputElement>('[data-role="ghost-cursor-import-share"]');
  const copyShareButton = requireElement<HTMLButtonElement>('[data-role="ghost-cursor-copy-share"]');
  const importShareButton = requireElement<HTMLButtonElement>('[data-role="ghost-cursor-import-share-button"]');
  const refreshGhostCursorShare = (settings: GhostCursorSettings) => {
    shareInput.value = encodeGhostCursorSettingsShare(settings);
  };
  const shareStatus = statusElement;
  const backToSettingsButton = requireElement<HTMLButtonElement>('[data-role="back-to-settings"]');

  renderFeatureCards(featureList);
  const customizeGhostCursorButton = requireElement<HTMLButtonElement>('[data-role="customize-ghost-cursor"]');
  const inputs = getFeatureInputs();
  const ruleInputs = renderCustomLinterRuleCards(customLinterRuleList);
  const manageRulesButton = requireElement<HTMLButtonElement>('[data-role="manage-custom-linter-rules"]');

  try {
    const settings = await loadExtensionSettings();
    applySettingsToInputs(
      settings,
      inputs,
      ruleInputs,
      highlightedWordsInput,
      highlightedWordsEnabledInput,
      ghostCursorInputs
    );
    refreshGhostCursorShare(settings.ghostCursor);
    setStatus(statusElement, 'Loaded');
  } catch (_error) {
    setStatus(statusElement, 'Could not load settings.');
  }

  const save = async () => {
    setStatus(statusElement, 'Saving...');
    try {
      const next = readSettingsFromInputs(
        inputs,
        ruleInputs,
        highlightedWordsInput,
        highlightedWordsEnabledInput,
        ghostCursorInputs
      );
      const persisted = await saveExtensionSettings(next);
      applySettingsToInputs(
        persisted,
        inputs,
        ruleInputs,
        highlightedWordsInput,
        highlightedWordsEnabledInput,
        ghostCursorInputs
      );
      refreshGhostCursorShare(persisted.ghostCursor);
      setStatus(statusElement, 'Saved. Reload dashboard tabs to apply changes.');
    } catch (_error) {
      setStatus(statusElement, 'Could not save settings.');
    }
  };

  for (const key of FEATURE_KEYS) {
    inputs[key].addEventListener('change', () => {
      void save();
    });
  }

  for (const rule of CUSTOM_LINTER_RULE_SETTINGS) {
    ruleInputs[rule.id]?.addEventListener('change', () => {
      void save();
    });
  }

  highlightedWordsInput.addEventListener('change', () => {
    void save();
  });

  highlightedWordsEnabledInput.addEventListener('change', () => {
    void save();
  });

  for (const input of [
    ghostCursorInputs.gradientEnabled,
    ghostCursorInputs.color,
    ghostCursorInputs.gradientColor,
    ghostCursorInputs.motion
  ]) {
    input.addEventListener('change', () => {
      void save();
    });
  }
  ghostCursorInputs.thickness.addEventListener('input', () => {
    ghostCursorInputs.thicknessValue.textContent = `${ghostCursorInputs.thickness.value} px`;
  });
  ghostCursorInputs.thickness.addEventListener('change', () => {
    void save();
  });

  resetButton.addEventListener('click', () => {
    for (const key of FEATURE_KEYS) {
      inputs[key].checked = DEFAULT_EXTENSION_SETTINGS.features[key];
    }
    const disabledRuleIds = new Set(DEFAULT_EXTENSION_SETTINGS.disabledCustomLinterRuleIds);
    for (const rule of CUSTOM_LINTER_RULE_SETTINGS) {
      if (ruleInputs[rule.id]) {
        ruleInputs[rule.id].checked = !disabledRuleIds.has(rule.id);
      }
    }
    highlightedWordsEnabledInput.checked = DEFAULT_EXTENSION_SETTINGS.highlightedWordsEnabled;
    highlightedWordsInput.value = formatHighlightedWordsForTextarea(DEFAULT_EXTENSION_SETTINGS.highlightedWords);
    applyGhostCursorSettingsToInputs(DEFAULT_EXTENSION_SETTINGS.ghostCursor, ghostCursorInputs);
    void save();
  });

  manageRulesButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    settingsHome.hidden = true;
    customLinterRulePage.hidden = false;
  });

  backToSettingsButton.addEventListener('click', () => {
    customLinterRulePage.hidden = true;
    settingsHome.hidden = false;
  });
  customizeGhostCursorButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    settingsHome.hidden = true;
    ghostCursorPage.hidden = false;
  });
  backFromGhostCursorButton.addEventListener('click', () => {
    ghostCursorPage.hidden = true;
    settingsHome.hidden = false;
  });
  copyShareButton.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareInput.value);
      } else {
        shareInput.focus();
        shareInput.select();
        if (!document.execCommand('copy')) throw new Error('Copy unavailable');
      }
      shareStatus.textContent = 'Copied.';
    } catch {
      shareStatus.textContent = 'Copy unavailable; select the string to copy it.';
    }
  });
  importShareButton.addEventListener('click', () => {
    const decoded = decodeGhostCursorSettingsShare(importShareInput.value.trim());
    if (!decoded) {
      shareStatus.textContent = 'Invalid cursor share string.';
      return;
    }
    applyGhostCursorSettingsToInputs(decoded, ghostCursorInputs);
    shareStatus.textContent = 'Imported.';
    void save();
  });

  downloadButton.addEventListener('click', () => {
    setStatus(statusElement, 'Preparing download...');
    void loadAnalyticsData().then((data) => {
      if (!data) {
        setStatus(statusElement, 'No analytics data found.');
        return;
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadJson(data, `babel-analytics-${timestamp}.json`);
      setStatus(statusElement, 'Download started.');
    }).catch(() => {
      setStatus(statusElement, 'Could not read analytics data.');
    });
  });
}

void boot();
