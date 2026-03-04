"use strict";
(() => {
  // src/core/settings.ts
  var SETTINGS_STORAGE_KEY = "settings";
  var DEFAULT_FEATURE_SETTINGS = {
    hotkeysHelp: true,
    rowActions: true,
    speakerWorkflowHotkeys: true,
    textMove: true,
    focusToggle: true,
    timelineSelection: true,
    timelineZoomDefaults: true,
    magnifier: true
  };
  var DEFAULT_EXTENSION_SETTINGS = {
    features: DEFAULT_FEATURE_SETTINGS
  };
  var FEATURE_KEYS = [
    "hotkeysHelp",
    "rowActions",
    "speakerWorkflowHotkeys",
    "textMove",
    "focusToggle",
    "timelineSelection",
    "timelineZoomDefaults",
    "magnifier"
  ];
  var FEATURE_META = {
    hotkeysHelp: {
      label: "Hotkeys Help",
      description: "Enhances the keyboard shortcuts dialog with Babel Helper hints."
    },
    rowActions: {
      label: "Row Actions",
      description: "Enable Delete, D, and Alt + Shift + Arrow merge shortcuts."
    },
    speakerWorkflowHotkeys: {
      label: "Speaker Workflow Hotkeys",
      description: "Enable Alt + 1/2 speaker switch and Alt + ~ reset workflow shortcuts."
    },
    textMove: {
      label: "Text Move",
      description: "Enable Alt + [ and Alt + ] to move text between adjacent segments."
    },
    focusToggle: {
      label: "Focus Toggle",
      description: "Enable Esc to blur and restore the active transcript textarea."
    },
    timelineSelection: {
      label: "Timeline Selection",
      description: "Enable Alt + Drag cut preview and S/Shift + S/L timeline actions."
    },
    timelineZoomDefaults: {
      label: "Timeline Zoom Defaults",
      description: "Remember last timeline zoom and apply it when a transcription session starts."
    },
    magnifier: {
      label: "Magnifier",
      description: "Show live waveform magnifier while dragging timeline segment edges."
    }
  };
  function getExtensionStorage() {
    const chromeApi = globalThis.chrome;
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
      return null;
    }
    return chromeApi.storage.local;
  }
  function normalizeExtensionSettings(source) {
    const incoming = source && typeof source === "object" && source !== null ? source : {};
    const rawFeatures = incoming.features && typeof incoming.features === "object" ? incoming.features : {};
    const features = {};
    for (const key of FEATURE_KEYS) {
      const value = rawFeatures[key];
      features[key] = typeof value === "boolean" ? value : DEFAULT_FEATURE_SETTINGS[key];
    }
    return {
      features
    };
  }
  async function loadExtensionSettings() {
    const storage = getExtensionStorage();
    if (!storage || typeof storage.get !== "function") {
      return normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS);
    }
    return new Promise((resolve) => {
      storage.get(SETTINGS_STORAGE_KEY, (items) => {
        const runtime = globalThis.chrome;
        if (runtime?.runtime?.lastError) {
          resolve(normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS));
          return;
        }
        resolve(normalizeExtensionSettings(items?.[SETTINGS_STORAGE_KEY]));
      });
    });
  }
  async function saveExtensionSettings(settings) {
    const normalized = normalizeExtensionSettings(settings);
    const storage = getExtensionStorage();
    if (!storage || typeof storage.set !== "function") {
      return normalized;
    }
    return new Promise((resolve) => {
      storage.set({ [SETTINGS_STORAGE_KEY]: normalized }, () => {
        resolve(normalized);
      });
    });
  }

  // src/options/options.ts
  function requireElement(selector) {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      throw new Error("Missing required element: " + selector);
    }
    return element;
  }
  function getFeatureInputs() {
    const inputs = {};
    for (const key of FEATURE_KEYS) {
      const input = document.querySelector(`input[name="${key}"]`);
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Missing feature checkbox: " + key);
      }
      inputs[key] = input;
    }
    return inputs;
  }
  function renderFeatureCards(list) {
    const fragment = document.createDocumentFragment();
    for (const key of FEATURE_KEYS) {
      const card = document.createElement("label");
      card.className = "feature-card";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = key;
      input.className = "feature-toggle";
      const details = document.createElement("div");
      details.className = "feature-details";
      const title = document.createElement("div");
      title.className = "feature-title";
      title.textContent = FEATURE_META[key].label;
      const description = document.createElement("div");
      description.className = "feature-description";
      description.textContent = FEATURE_META[key].description;
      details.appendChild(title);
      details.appendChild(description);
      card.appendChild(input);
      card.appendChild(details);
      fragment.appendChild(card);
    }
    list.replaceChildren(fragment);
  }
  function applySettingsToInputs(settings, inputs) {
    for (const key of FEATURE_KEYS) {
      inputs[key].checked = Boolean(settings.features[key]);
    }
  }
  function readSettingsFromInputs(inputs) {
    const features = {};
    for (const key of FEATURE_KEYS) {
      features[key] = inputs[key].checked;
    }
    return {
      features
    };
  }
  function setStatus(statusElement, message) {
    statusElement.textContent = message;
  }
  async function boot() {
    const featureList = requireElement('[data-role="feature-list"]');
    const statusElement = requireElement('[data-role="status"]');
    const resetButton = requireElement('[data-role="reset"]');
    renderFeatureCards(featureList);
    const inputs = getFeatureInputs();
    try {
      const settings = await loadExtensionSettings();
      applySettingsToInputs(settings, inputs);
      setStatus(statusElement, "Loaded");
    } catch (_error) {
      setStatus(statusElement, "Could not load settings.");
    }
    const save = async () => {
      setStatus(statusElement, "Saving...");
      try {
        const next = readSettingsFromInputs(inputs);
        const persisted = await saveExtensionSettings(next);
        applySettingsToInputs(persisted, inputs);
        setStatus(statusElement, "Saved. Reload dashboard tabs to apply changes.");
      } catch (_error) {
        setStatus(statusElement, "Could not save settings.");
      }
    };
    for (const key of FEATURE_KEYS) {
      inputs[key].addEventListener("change", () => {
        void save();
      });
    }
    resetButton.addEventListener("click", () => {
      for (const key of FEATURE_KEYS) {
        inputs[key].checked = true;
      }
      void save();
    });
  }
  void boot();
})();
//# sourceMappingURL=options.js.map
