var __dirname = typeof __dirname === "string" ? __dirname : "/virtual";
"use strict";
(() => {
  // src/core/settings.ts
  var SETTINGS_STORAGE_KEY = "settings";
  var DEFAULT_FEATURE_SETTINGS = {
    hotkeysHelp: true,
    rowActions: true,
    speakerWorkflowHotkeys: true,
    selectedNumberToSkaz: true,
    textMove: true,
    quickRegionAutocomplete: true,
    disableNativeArrowSeek: true,
    focusToggle: true,
    timelineSelection: true,
    timelineZoomDefaults: true,
    magnifier: true,
    customLinter: true,
    proportionalCursorRestore: true,
    wavesurferTooltipEllipsis: true
  };
  var DEFAULT_EXTENSION_SETTINGS = {
    features: DEFAULT_FEATURE_SETTINGS
  };
  var FEATURE_KEYS = [
    "hotkeysHelp",
    "rowActions",
    "speakerWorkflowHotkeys",
    "selectedNumberToSkaz",
    "textMove",
    "quickRegionAutocomplete",
    "disableNativeArrowSeek",
    "focusToggle",
    "timelineSelection",
    "timelineZoomDefaults",
    "magnifier",
    "customLinter",
    "proportionalCursorRestore",
    "wavesurferTooltipEllipsis"
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
    selectedNumberToSkaz: {
      label: "Selected Number to SKAZ",
      description: "Enable Alt + A to auto-convert selected digits or Russian number words into `digits {\u0421\u041A\u0410\u0417: words}`."
    },
    textMove: {
      label: "Text Move",
      description: "Enable Alt + [ and Alt + ] to move text between adjacent segments."
    },
    quickRegionAutocomplete: {
      label: "Quick Region Autocomplete",
      description: "Reuse Babel tag autocomplete in quick region and row editors, including selected-text style tag wrapping."
    },
    disableNativeArrowSeek: {
      label: "Disable Native Arrow Seek",
      description: "Block Babel\u2019s bare Left/Right Arrow segment-jump hotkeys while keeping normal caret movement."
    },
    focusToggle: {
      label: "Focus Toggle",
      description: "Enable Esc to pause and blur the active transcript textarea, then resume and restore it."
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
    },
    customLinter: {
      label: "Custom Linter",
      description: "Inject helper rules into Babel lintAnnotations results so issues appear in native linter UI."
    },
    proportionalCursorRestore: {
      label: "Proportional Cursor Restore",
      description: "When restoring focus after Esc, advance cursor to the text position proportional to playback progress (never backward from your last edit position)."
    },
    wavesurferTooltipEllipsis: {
      label: "Wavesurfer Tooltip Ellipsis",
      description: "Truncate long Wavesurfer region tooltip labels with an ellipsis. Edit the template in src/features/wavesurfer-tooltip-ellipsis-feature.ts."
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
  function downloadJson(data, filename) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }
  async function loadAnalyticsData() {
    return new Promise((resolve, reject) => {
      const chromeApi = globalThis.chrome;
      if (!chromeApi?.storage?.local) {
        reject(new Error("Chrome storage API not available"));
        return;
      }
      chromeApi.storage.local.get("babel_helper_analytics", (items) => {
        resolve(items?.["babel_helper_analytics"] ?? null);
      });
    });
  }
  async function boot() {
    const featureList = requireElement('[data-role="feature-list"]');
    const statusElement = requireElement('[data-role="status"]');
    const resetButton = requireElement('[data-role="reset"]');
    const downloadButton = requireElement('[data-role="download-logs"]');
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
    downloadButton.addEventListener("click", () => {
      setStatus(statusElement, "Preparing download...");
      void loadAnalyticsData().then((data) => {
        if (!data) {
          setStatus(statusElement, "No analytics data found.");
          return;
        }
        const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        downloadJson(data, `babel-analytics-${timestamp}.json`);
        setStatus(statusElement, "Download started.");
      }).catch(() => {
        setStatus(statusElement, "Could not read analytics data.");
      });
    });
  }
  void boot();
})();
//# sourceMappingURL=options.js.map
