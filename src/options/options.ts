import { ensureUiStyles } from '@nominy/babel-extension-frontend';
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
import {
  SHORTCUT_ACTIONS,
  formatShortcut,
  normalizeShortcutSettings,
  shortcutBindingFromEvent,
  type ShortcutBinding,
  type ShortcutModifier,
  type ShortcutSettings
} from '../core/shortcuts';

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

function createShortcutEditor(onChange: () => void) {
  const list = requireElement<HTMLElement>('[data-role="shortcut-list"]');
  const status = requireElement<HTMLElement>('[data-role="shortcut-status"]');
  const resetAll = requireElement<HTMLButtonElement>('[data-role="reset-shortcuts"]');
  let settings: ShortcutSettings = {};
  let recording: { id: string; add: boolean; button: HTMLButtonElement; label: string; accessibleLabel: string } | null = null;
  let rightShiftPressed = false;
  const rows = new Map<string, { value: HTMLElement; warning: HTMLElement; status: HTMLElement }>();
  let recordedCode: string | null = null;
  const modifiers: ShortcutModifier[] = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'];

  function overlaps(left: ShortcutBinding[], right: ShortcutBinding[]): boolean {
    return left.some(a => right.some(b =>
      (a.key && b.key ? a.key === b.key : a.code === b.code) &&
      modifiers.every(modifier =>
        a.ignoreModifiers?.includes(modifier) ||
        b.ignoreModifiers?.includes(modifier) ||
        a[modifier] === b[modifier]
      )
    ));
  }

  function refresh() {
    for (const action of SHORTCUT_ACTIONS) {
      const row = rows.get(action.id)!;
      row.value.textContent = formatShortcut(settings, action.id);
      const bindings = settings[action.id] === undefined ? action.defaults : settings[action.id] ?? [];
      const conflicts = SHORTCUT_ACTIONS.filter(other => {
        if (other.id === action.id) return false;
        const otherBindings = settings[other.id] === undefined ? other.defaults : settings[other.id] ?? [];
        return overlaps(bindings, otherBindings);
      });
      const original = conflicts.length > 0 && settings[action.id] === undefined &&
        conflicts.every(other => settings[other.id] === undefined);
      row.warning.textContent = conflicts.length
        ? `${original ? 'Default context overlap (informational)' : 'Shortcut conflict'}: also used by ${conflicts.map(other => other.label).join(', ')}. Actions retain their existing contexts.`
        : '';
      row.warning.hidden = conflicts.length === 0;
      row.warning.style.color = original ? '' : 'var(--bui-warning)';
    }
  }

  function stopRecording() {
    if (recording) {
      recording.button.setAttribute('aria-pressed', 'false');
      recording.button.textContent = recording.label;
      recording.button.setAttribute('aria-label', recording.accessibleLabel);
      rows.get(recording.id)!.status.textContent = 'Recording cancelled. Shortcut unchanged.';
      recording = null;
    }
    rightShiftPressed = false;
  }

  for (const action of SHORTCUT_ACTIONS) {
    const card = document.createElement('fieldset');
    card.className = 'bui-card bui-stack';
    const title = document.createElement('legend');
    title.className = 'bui-label';
    title.textContent = action.label;
    const value = document.createElement('kbd');
    value.className = 'bui-kbd';
    value.id = `shortcut-${action.id}`;
    const warning = document.createElement('p');
    warning.className = 'bui-hint';
    warning.id = `shortcut-conflict-${action.id}`;
    warning.setAttribute('aria-live', 'polite');
    const rowStatus = document.createElement('p');
    rowStatus.className = 'bui-status';
    rowStatus.id = `shortcut-status-${action.id}`;
    rowStatus.setAttribute('role', 'status');
    rowStatus.setAttribute('aria-live', 'polite');
    const controls = document.createElement('div');
    controls.className = 'bui-row';
    for (const [operation, label] of [
      ['record', 'Record replacement'], ['add', 'Add alternative'], ['clear', 'Clear'], ['reset', 'Reset']
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bui-button';
      button.textContent = label;
      button.setAttribute('aria-label', `${label}: ${action.label}`);
      button.setAttribute('aria-describedby', `${value.id} ${warning.id} ${rowStatus.id} shortcuts-help`);
      if (operation === 'record' || operation === 'add') button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        if (recording?.button === button) {
          stopRecording();
          return;
        }
        stopRecording();
        if (operation === 'record' || operation === 'add') {
          recording = { id: action.id, add: operation === 'add', button, label, accessibleLabel: `${label}: ${action.label}` };
          button.setAttribute('aria-pressed', 'true');
          button.textContent = 'Cancel recording';
          button.setAttribute('aria-label', `Cancel recording: ${action.label}`);
          rowStatus.textContent = 'Recording… Press a key combination, click Cancel recording, or tap and release a modifier alone to cancel.';
          button.focus();
          return;
        }
        settings = { ...settings };
        if (operation === 'clear') settings[action.id] = null;
        else delete settings[action.id];
        refresh();
        rowStatus.textContent = `${action.label}: ${formatShortcut(settings, action.id)}.`;
        onChange();
      });
      controls.appendChild(button);
    }
    card.append(title, value, controls, rowStatus, warning);
    rows.set(action.id, { value, warning, status: rowStatus });
    list.appendChild(card);
  }

  document.addEventListener('keydown', event => {
    if (!recording) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === 'ShiftRight') rightShiftPressed = true;
    else if (!event.shiftKey) rightShiftPressed = false;
    if (event.repeat) return;
    const binding = shortcutBindingFromEvent(event);
    if (!binding) return;
    if (binding.shiftKey && rightShiftPressed) binding.rightShift = true;
    const { id, add, button } = recording;
    recordedCode = event.code;
    const action = SHORTCUT_ACTIONS.find(item => item.id === id)!;
    const previous = settings[id] === undefined ? action.defaults : settings[id] ?? [];
    const next = add ? [...previous, binding] : [binding];
    settings = normalizeShortcutSettings({ ...settings, [id]: next });
    stopRecording();
    refresh();
    rows.get(id)!.status.textContent = `${action.label}: ${formatShortcut(settings, id)}.`;
    button.focus();
    onChange();
  }, true);
  document.addEventListener('keyup', event => {
    if (event.code === 'ShiftRight' || !event.shiftKey) rightShiftPressed = false;
    if (event.code === recordedCode) {
      recordedCode = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (recording && /^(?:Control|Alt|Shift|Meta)(?:Left|Right)$/.test(event.code)) {
      stopRecording();
    }
  }, true);
  window.addEventListener('blur', () => {
    if (!recording) return;
    const rowStatus = rows.get(recording.id)!.status;
    stopRecording();
    rowStatus.textContent = 'Recording cancelled because this window lost focus.';
  });
  resetAll.addEventListener('click', () => {
    stopRecording();
    settings = {};
    refresh();
    status.textContent = 'All shortcuts restored to defaults.';
    onChange();
  });
  refresh();
  return {
    stopRecording,
    getSettings: () => settings,
    setSettings(next: ShortcutSettings) {
      stopRecording();
      settings = normalizeShortcutSettings(next);
      refresh();
    }
  };
}

function renderFeatureCards(list: HTMLElement) {
  const fragment = document.createDocumentFragment();

  for (const key of FEATURE_KEYS) {
    const card = document.createElement('label');
    card.className = 'feature-card bui-card bui-setting-toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = key;
    input.className = 'feature-toggle bui-checkbox';

    const details = document.createElement('div');
    details.className = 'feature-details bui-stack';

    const title = document.createElement('div');
    title.className = 'feature-title bui-label';
    title.textContent = FEATURE_META[key].label;

    const description = document.createElement('div');
    description.className = 'feature-description bui-hint';
    description.textContent = FEATURE_META[key].description;

    details.appendChild(title);
    details.appendChild(description);

    if (key === 'customLinter' || key === 'proportionalCursorRestore') {
      const actions = document.createElement('div');
      actions.className = 'feature-actions bui-row';

      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'link-btn bui-button';
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
    card.className = 'rule-card bui-card bui-setting-toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = `custom-linter-rule-${rule.id}`;
    input.className = 'rule-toggle bui-checkbox';
    input.dataset.ruleId = rule.id;

    const details = document.createElement('span');

    const title = document.createElement('span');
    title.className = 'rule-title bui-label';
    title.textContent = rule.label;

    const description = document.createElement('span');
    description.className = 'rule-description bui-hint';
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
  ghostCursorInputs: GhostCursorInputMap,
  websiteAppearance: ExtensionSettings['websiteAppearance'],
  shortcuts: ShortcutSettings
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
    ghostCursor: readGhostCursorSettingsFromInputs(ghostCursorInputs),
    websiteAppearance,
    shortcuts
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
  const shortcutsPage = requireElement<HTMLElement>('[data-role="shortcuts-page"]');
  const manageShortcutsButton = requireElement<HTMLButtonElement>('[data-role="manage-shortcuts"]');
  const backFromShortcutsButton = requireElement<HTMLButtonElement>('[data-role="back-from-shortcuts"]');
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

  let retainedWebsiteAppearance = DEFAULT_EXTENSION_SETTINGS.websiteAppearance;
  let initialShortcuts = DEFAULT_EXTENSION_SETTINGS.shortcuts;

  try {
    const { loaded, settings } = await loadExtensionSettings();
    retainedWebsiteAppearance = settings.websiteAppearance;
    initialShortcuts = settings.shortcuts;
    applySettingsToInputs(
      settings,
      inputs,
      ruleInputs,
      highlightedWordsInput,
      highlightedWordsEnabledInput,
      ghostCursorInputs
    );
    refreshGhostCursorShare(settings.ghostCursor);
    setStatus(statusElement, loaded ? 'Loaded' : 'Could not load settings.');
  } catch {
    setStatus(statusElement, 'Could not load settings.');
  }

  let saveQueue = Promise.resolve();
  const save = (websiteAppearanceOverride?: ExtensionSettings['websiteAppearance']) => {
    const formSettings = readSettingsFromInputs(
      inputs,
      ruleInputs,
      highlightedWordsInput,
      highlightedWordsEnabledInput,
      ghostCursorInputs,
      retainedWebsiteAppearance,
      shortcutEditor.getSettings()
    );
    const run = async () => {
      setStatus(statusElement, 'Saving...');
      try {
        if (websiteAppearanceOverride !== undefined) {
          retainedWebsiteAppearance = websiteAppearanceOverride;
        } else {
          const latest = await loadExtensionSettings();
          if (!latest.loaded) {
            throw new Error(latest.error ?? 'Could not load current settings.');
          }
          retainedWebsiteAppearance = latest.settings.websiteAppearance;
        }
        const persisted = await saveExtensionSettings({
          ...formSettings,
          websiteAppearance: retainedWebsiteAppearance
        });
        retainedWebsiteAppearance = persisted.websiteAppearance;
        applySettingsToInputs(
          persisted,
          inputs,
          ruleInputs,
          highlightedWordsInput,
          highlightedWordsEnabledInput,
          ghostCursorInputs
        );
        refreshGhostCursorShare(persisted.ghostCursor);
        setStatus(statusElement, 'Saved. Dashboard changes apply live.');
      } catch {
        setStatus(statusElement, 'Could not save settings.');
      }
    };

    saveQueue = saveQueue.then(run, run);
    return saveQueue;
  };
  const shortcutEditor = createShortcutEditor(() => { void save(); });
  shortcutEditor.setSettings(initialShortcuts);

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
    retainedWebsiteAppearance = DEFAULT_EXTENSION_SETTINGS.websiteAppearance;
    shortcutEditor.setSettings(DEFAULT_EXTENSION_SETTINGS.shortcuts);
    applySettingsToInputs(
      DEFAULT_EXTENSION_SETTINGS,
      inputs,
      ruleInputs,
      highlightedWordsInput,
      highlightedWordsEnabledInput,
      ghostCursorInputs
    );
    void save(DEFAULT_EXTENSION_SETTINGS.websiteAppearance);
  });

  manageShortcutsButton.addEventListener('click', () => {
    settingsHome.hidden = true;
    shortcutsPage.hidden = false;
    backFromShortcutsButton.focus();
  });
  backFromShortcutsButton.addEventListener('click', () => {
    shortcutEditor.stopRecording();
    shortcutsPage.hidden = true;
    settingsHome.hidden = false;
    manageShortcutsButton.focus();
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

ensureUiStyles();
