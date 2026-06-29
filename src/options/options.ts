import {
  CUSTOM_LINTER_RULE_SETTINGS,
  DEFAULT_EXTENSION_SETTINGS,
  FEATURE_KEYS,
  FEATURE_META,
  type ExtensionSettings,
  type FeatureSettingKey,
  loadExtensionSettings,
  saveExtensionSettings
} from '../core/settings';
import { formatHighlightedWordsForTextarea, normalizeHighlightedWords } from '../core/highlighted-words';

type InputMap = Record<FeatureSettingKey, HTMLInputElement>;
type RuleInputMap = Record<string, HTMLInputElement>;

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

    if (key === 'customLinter') {
      const actions = document.createElement('div');
      actions.className = 'feature-actions';

      const manageRulesButton = document.createElement('button');
      manageRulesButton.type = 'button';
      manageRulesButton.className = 'link-btn';
      manageRulesButton.dataset.role = 'manage-custom-linter-rules';
      manageRulesButton.textContent = 'Manage rules';
      actions.appendChild(manageRulesButton);
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

function applySettingsToInputs(
  settings: ExtensionSettings,
  inputs: InputMap,
  ruleInputs?: RuleInputMap,
  highlightedWordsInput?: HTMLTextAreaElement,
  highlightedWordsEnabledInput?: HTMLInputElement
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
}

function readSettingsFromInputs(
  inputs: InputMap,
  ruleInputs: RuleInputMap,
  highlightedWordsInput: HTMLTextAreaElement,
  highlightedWordsEnabledInput: HTMLInputElement
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
      .map((rule) => rule.id)
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
  const settingsHome = requireElement<HTMLElement>('[data-role="settings-home"]');
  const customLinterRulePage = requireElement<HTMLElement>('[data-role="custom-linter-rule-page"]');
  const customLinterRuleList = requireElement<HTMLElement>('[data-role="custom-linter-rule-list"]');
  const backToSettingsButton = requireElement<HTMLButtonElement>('[data-role="back-to-settings"]');

  renderFeatureCards(featureList);
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
      highlightedWordsEnabledInput
    );
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
        highlightedWordsEnabledInput
      );
      const persisted = await saveExtensionSettings(next);
      applySettingsToInputs(
        persisted,
        inputs,
        ruleInputs,
        highlightedWordsInput,
        highlightedWordsEnabledInput
      );
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
