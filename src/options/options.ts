import {
  FEATURE_KEYS,
  FEATURE_META,
  type ExtensionSettings,
  type FeatureSettingKey,
  loadExtensionSettings,
  saveExtensionSettings
} from '../core/settings';

type InputMap = Record<FeatureSettingKey, HTMLInputElement>;

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
    card.appendChild(input);
    card.appendChild(details);
    fragment.appendChild(card);
  }

  list.replaceChildren(fragment);
}

function applySettingsToInputs(settings: ExtensionSettings, inputs: InputMap) {
  for (const key of FEATURE_KEYS) {
    inputs[key].checked = Boolean(settings.features[key]);
  }
}

function readSettingsFromInputs(inputs: InputMap): ExtensionSettings {
  const features = {} as ExtensionSettings['features'];
  for (const key of FEATURE_KEYS) {
    features[key] = inputs[key].checked;
  }

  return {
    features
  };
}

function setStatus(statusElement: HTMLElement, message: string) {
  statusElement.textContent = message;
}

async function boot() {
  const featureList = requireElement<HTMLElement>('[data-role="feature-list"]');
  const statusElement = requireElement<HTMLElement>('[data-role="status"]');
  const resetButton = requireElement<HTMLButtonElement>('[data-role="reset"]');

  renderFeatureCards(featureList);
  const inputs = getFeatureInputs();

  try {
    const settings = await loadExtensionSettings();
    applySettingsToInputs(settings, inputs);
    setStatus(statusElement, 'Loaded');
  } catch (_error) {
    setStatus(statusElement, 'Could not load settings.');
  }

  const save = async () => {
    setStatus(statusElement, 'Saving...');
    try {
      const next = readSettingsFromInputs(inputs);
      const persisted = await saveExtensionSettings(next);
      applySettingsToInputs(persisted, inputs);
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

  resetButton.addEventListener('click', () => {
    for (const key of FEATURE_KEYS) {
      inputs[key].checked = true;
    }
    void save();
  });
}

void boot();
