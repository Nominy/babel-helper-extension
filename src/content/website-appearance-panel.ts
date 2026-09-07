import { UI_STYLES, themeRoot, applyComponent } from '@nominy/babel-extension-frontend';
import {
  DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
  WEBSITE_CUSTOM_CSS_MAX_LENGTH,
  decodeWebsiteAppearanceShare,
  encodeWebsiteAppearanceShare,
  normalizeWebsiteAppearanceSettings,
  validateWebsiteCustomCss,
  type WebsiteAppearanceSettings,
  type WebsiteGradientSpeed
} from '../core/settings';

const PANEL_ATTRIBUTE = 'data-babel-helper-appearance-panel';
const COMMIT_DELAY_MS = 250;
// Only used where the target window has no animation frames at all.
const PREVIEW_FRAME_FALLBACK_MS = 16;
const SHORTCUT_LABEL = 'Alt + Shift + P';
const LAUNCHER_ATTRIBUTE = 'data-babel-helper-appearance-button';
const LAUNCHER_STYLE_ATTRIBUTE = 'data-babel-helper-appearance-button-style';
const DRAFTING_BUTTON_SELECTOR = '#babel-gold-drafting-magic-button';
const PLAY_ALL_BUTTON_SELECTOR = '[aria-label="Play all tracks"]';

type SettingKeyOfType<T> = {
  [K in keyof WebsiteAppearanceSettings]: WebsiteAppearanceSettings[K] extends T ? K : never;
}[keyof WebsiteAppearanceSettings];

type BooleanSettingKey = SettingKeyOfType<boolean>;
type NumberSettingKey = SettingKeyOfType<number>;
type ColorSettingKey = Exclude<SettingKeyOfType<string>, 'gradientSpeed' | 'customCss'>;

/** The two fixed-length colour tuples are edited slot by slot, like scalar dials. */
type ColorListKey = 'gradientColors' | 'speakerColors';
type ColorListIndex = 0 | 1 | 2;

type DialBase = { label: string; aria?: string };
type ColorDial = DialBase & { kind: 'color'; field: ColorSettingKey };
type ListColorDial = DialBase & {
  kind: 'list-color';
  field: string;
  list: ColorListKey;
  index: ColorListIndex;
};
type NumberDial = DialBase & {
  kind: 'number';
  field: NumberSettingKey;
  min: number;
  max: number;
  step: number;
};
type RangeDial = DialBase & {
  kind: 'range';
  field: NumberSettingKey;
  min: number;
  max: number;
  step: number;
  suffix: string;
};
type SelectDial = DialBase & {
  kind: 'select';
  field: 'gradientSpeed';
  options: ReadonlyArray<readonly [WebsiteGradientSpeed, string]>;
};
type Dial = ColorDial | ListColorDial | NumberDial | RangeDial | SelectDial;

type AppearanceGroup = {
  flag: BooleanSettingKey;
  legend: string;
  note?: string;
  dials: readonly Dial[];
};

const COLOR_LIST_INDEXES: readonly ColorListIndex[] = [0, 1, 2];

const TEXT_GROUP: AppearanceGroup = {
  flag: 'textEnabled',
  legend: 'Text',
  dials: [
    {
      kind: 'number',
      field: 'textSizePx',
      label: 'Editor',
      aria: 'Transcript editor text size in pixels',
      min: 10,
      max: 30,
      step: 1
    },
    {
      kind: 'number',
      field: 'tableTextSizePx',
      label: 'Table',
      aria: 'Transcript table text size in pixels',
      min: 10,
      max: 30,
      step: 1
    }
  ]
};

// The whole core palette is one grid: every other shade the theme uses is mixed
// from these entries at runtime, so there is nothing else to expose here.
const THEME_GROUP: AppearanceGroup = {
  flag: 'themeEnabled',
  legend: 'Theme',
  note: "Recolors the dashboard from one palette: surfaces, text, controls, status tints and the waveform.",
  dials: [
    { kind: 'color', field: 'pageColor', label: 'Page' },
    { kind: 'color', field: 'surfaceColor', label: 'Surface' },
    { kind: 'color', field: 'textColor', label: 'Text' },
    { kind: 'color', field: 'mutedTextColor', label: 'Muted' },
    { kind: 'color', field: 'accentColor', label: 'Accent' },
    { kind: 'color', field: 'accentTextColor', label: 'Accent text' },
    { kind: 'color', field: 'borderColor', label: 'Border' },
    { kind: 'color', field: 'waveColor', label: 'Waveform' },
    { kind: 'color', field: 'activeRowColor', label: 'Active row' },
    { kind: 'color', field: 'activeRowTextColor', label: 'Active row text' },
    { kind: 'color', field: 'dangerColor', label: 'Danger' },
    { kind: 'color', field: 'warningColor', label: 'Warning' },
    { kind: 'color', field: 'successColor', label: 'Success' },
    ...COLOR_LIST_INDEXES.map(
      (index): ListColorDial => ({
        kind: 'list-color',
        field: `speakerColor${index}`,
        list: 'speakerColors',
        index,
        label: `Speaker ${index + 1}`,
        aria: `Speaker ${index + 1} color`
      })
    )
  ]
};

const GRADIENT_GROUP: AppearanceGroup = {
  flag: 'gradientEnabled',
  legend: 'Gradient',
  dials: [
    ...COLOR_LIST_INDEXES.map(
      (index): ListColorDial => ({
        kind: 'list-color',
        field: `gradientColor${index}`,
        list: 'gradientColors',
        index,
        label: `Color ${index + 1}`
      })
    ),
    { kind: 'range', field: 'gradientAngle', label: 'Angle', min: 0, max: 360, step: 15, suffix: '°' },
    {
      kind: 'select',
      field: 'gradientSpeed',
      label: 'Speed',
      options: [
        ['slow', 'Slow'],
        ['balanced', 'Balanced'],
        ['fast', 'Fast']
      ]
    }
  ]
};

const GROUPS: readonly AppearanceGroup[] = [TEXT_GROUP, THEME_GROUP, GRADIENT_GROUP];

export type WebsiteAppearanceCommitResult = { saved: boolean; error?: string };

export type WebsiteAppearancePanelOptions = {
  getSettings: () => WebsiteAppearanceSettings;
  onPreview: (next: WebsiteAppearanceSettings) => void;
  onCommit: (next: WebsiteAppearanceSettings) => Promise<WebsiteAppearanceCommitResult>;
  targetDocument?: Document;
  targetWindow?: Window;
};

export type WebsiteAppearancePanel = {
  dispose(): void;
  open(): void;
  close(): void;
  toggle(): void;
  /**
   * Adopts settings written by another surface. Ignored while an edit of this
   * panel's own draft is pending, unsaved, or after disposal, so in-flight and
   * failed-to-save edits are never clobbered by a storage echo.
   */
  sync(next: WebsiteAppearanceSettings): void;
};

type Binding = {
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  apply: (next: WebsiteAppearanceSettings) => void;
  render: (settings: WebsiteAppearanceSettings) => void;
};

function cloneSettings(settings: WebsiteAppearanceSettings): WebsiteAppearanceSettings {
  return {
    ...settings,
    gradientColors: [...settings.gradientColors],
    speakerColors: [...settings.speakerColors]
  };
}

function isToggleShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === 'KeyP' &&
    !event.repeat &&
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

function isColorDial(dial: Dial): dial is ColorDial | ListColorDial {
  return dial.kind === 'color' || dial.kind === 'list-color';
}

function dialMarkup(dial: Dial): string {
  const aria = dial.aria ?? (isColorDial(dial) ? `${dial.label} color` : dial.label);
  switch (dial.kind) {
    case 'color':
    case 'list-color':
      return `<label>${dial.label} <input type="color" data-field="${dial.field}" aria-label="${aria}" class="bui-color"></label>`;
    case 'number':
      return `<label>${dial.label} <input type="number" min="${dial.min}" max="${dial.max}" step="${dial.step}" data-field="${dial.field}" aria-label="${aria}" class="bui-input"></label>`;
    case 'range':
      return `<label>${dial.label} <span class="slider"><input type="range" min="${dial.min}" max="${dial.max}" step="${dial.step}" data-field="${dial.field}" aria-label="${aria}" class="bui-range"><output data-output="${dial.field}"></output></span></label>`;
    case 'select':
      return `<label>${dial.label} <select data-field="${dial.field}" aria-label="${aria}" class="bui-select">${dial.options
        .map(([value, text]) => `<option value="${value}">${text}</option>`)
        .join('')}</select></label>`;
  }
}

function groupMarkup(group: AppearanceGroup): string {
  const note = group.note ? `<p class="hint note bui-hint">${group.note}</p>` : '';
  const colors = group.dials.filter(isColorDial);
  const grid = colors.length > 0 ? `<div class="colors">${colors.map(dialMarkup).join('')}</div>` : '';
  const others = group.dials.filter((dial) => !isColorDial(dial));
  return `<fieldset data-group="${group.flag}" class="bui-surface">
          <legend><label class="toggle bui-toggle"><input type="checkbox" data-field="${group.flag}" aria-label="Enable ${group.legend}" class="bui-checkbox">${group.legend}</label></legend>
          ${note}${grid}${others.map(dialMarkup).join('')}
        </fieldset>`;
}

export function createWebsiteAppearancePanel(
  options: WebsiteAppearancePanelOptions
): WebsiteAppearancePanel {
  const targetDocument = options.targetDocument ?? globalThis.document;
  const targetWindow = options.targetWindow ?? targetDocument?.defaultView ?? globalThis.window;
  if (!targetDocument || !targetWindow) {
    throw new Error('Website Appearance editor requires a document and window.');
  }

  const host = targetDocument.createElement('div');
  host.setAttribute(PANEL_ATTRIBUTE, '');
  host.hidden = true;
  const shadow = host.attachShadow({ mode: 'open' });
  const launcher = targetDocument.createElement('button');
  const launcherStyle = targetDocument.createElement('style');
  launcherStyle.setAttribute(LAUNCHER_STYLE_ATTRIBUTE, '');
  launcherStyle.textContent = '';
  themeRoot(launcher, '#d4b85b');
  applyComponent(launcher, 'icon-button', { variant: 'soft' });
  launcher.style.setProperty('--bui-accent-soft', '#fffcf0');
  launcher.type = 'button';
  launcher.setAttribute(LAUNCHER_ATTRIBUTE, '');
  launcher.setAttribute('aria-label', 'Website Appearance');
  launcher.title = `Website Appearance (${SHORTCUT_LABEL})`;
  launcher.textContent = '🖼️';
  launcher.style.width = '36px';
  launcher.style.height = '36px';
  launcher.style.minWidth = '36px';
  launcher.style.minHeight = '36px';
  launcher.style.flex = '0 0 36px';
  launcher.style.fontSize = '18px';
  launcher.style.display = 'inline-flex';
  launcher.style.alignItems = 'center';
  launcher.style.justifyContent = 'center';
  launcher.style.padding = '0';
  launcher.style.cursor = 'pointer';
  shadow.innerHTML = `
    <style>${UI_STYLES}
      :host { all: initial; position: fixed; z-index: 2147483647; inset: 16px 16px auto auto; width: min(360px,calc(100vw - 32px)); max-height: calc(100vh - 32px); }
      :host([hidden]) { display: none !important; }
      .panel { overflow: auto; max-height: calc(100vh - 32px); box-shadow: var(--bui-shadow); }
      header { position: sticky; top: 0; z-index: 1; }
      fieldset { display: grid; gap: 8px; min-width: 0; margin: 0; padding: 8px 10px; }
      legend { padding-inline: 4px; }
      label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; }
      label.stack { grid-template-columns: 1fr; }
      label.toggle { display: inline-flex; }
      .slider { display: inline-flex; align-items: center; gap: 6px; }
      .colors { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 6px 10px; }
      .colors label { grid-template-columns: 1fr 30px; }
      .row .grow { flex: 1 1 auto; min-width: 0; }
      .row > button { flex: 0 0 auto; }
      .advanced { display: grid; gap: 8px; }
      fieldset[data-group]:has(> legend .toggle > input:not(:checked)) { gap: 0; padding: 0 10px 3px; border-color: transparent; }
      fieldset[data-group]:has(> legend .toggle > input:not(:checked)) > :not(legend):not(.note) { display: none; }
      input[type='color'] { width: 30px; height: 26px; }
      input[type='number'] { width: 70px; }
      input[type='range'] { width: 132px; }
      select { min-width: 112px; }
      output { min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
      .status.invalid { color: var(--bui-danger); }
      .hint.warn, .status.warn { color: var(--bui-warning); }
    </style>
    <section data-bui-accent="white" class="panel bui-panel bui-root" role="dialog" aria-modal="false" aria-labelledby="appearance-panel-title">
      <header class="bui-header">
        <h2 id="appearance-panel-title" class="bui-title">Website Appearance</h2>
        <button class="icon-button bui-icon-button bui-button" type="button" data-action="close" aria-label="Close Website Appearance editor">×</button>
      </header>
      <div class="body bui-body">
        <label class="toggle master bui-toggle"><input type="checkbox" data-field="enabled" class="bui-checkbox">Enable custom appearance</label>
        <p class="hint bui-hint">Only the sections you enable are changed. Everything else keeps the site's own design.</p>
        <p class="hint warn bui-hint" id="master-hint" role="status" aria-live="polite">Turn on custom appearance to edit these sections.</p>
        ${groupMarkup(TEXT_GROUP)}
        ${groupMarkup(THEME_GROUP)}
        <details class="advanced" data-advanced>
          <summary class="bui-summary">Advanced</summary>
          ${groupMarkup(GRADIENT_GROUP)}
          <fieldset class="expert bui-surface">
            <legend><label class="toggle bui-toggle"><input type="checkbox" data-field="customCssEnabled" aria-label="Apply expert CSS" class="bui-checkbox">Expert CSS</label></legend>
            <label class="stack">Custom CSS<textarea data-field="customCss" maxlength="${WEBSITE_CUSTOM_CSS_MAX_LENGTH}" spellcheck="false" aria-describedby="custom-css-status" class="bui-textarea"></textarea></label>
            <p class="status bui-status" id="custom-css-status" role="status" aria-live="polite"></p>
          </fieldset>
          <fieldset class="sharing bui-surface">
            <legend>Theme sharing</legend>
            <label class="stack">Share string<input class="share bui-code bui-input" type="text" data-share="value" readonly spellcheck="false" aria-label="Website Appearance share string" aria-describedby="theme-status"></label>
            <div class="row bui-row">
              <button type="button" data-action="copy-share" class="bui-button">Copy</button>
              <input class="share grow bui-code bui-input" type="text" data-share="import" spellcheck="false" placeholder="Paste a theme string" aria-label="Website Appearance share string to import" aria-describedby="theme-status">
              <button type="button" data-action="import-share" class="bui-button">Import</button>
            </div>
            <p class="status bui-status" id="theme-status" role="status" aria-live="polite"></p>
          </fieldset>
        </details>
        <p class="status invalid bui-status" id="commit-status" role="status" aria-live="polite"></p>
        <footer class="bui-footer">
          <button type="button" data-action="reset" class="bui-button">Reset appearance</button>
          <span>Toggle <kbd class="bui-kbd">${SHORTCUT_LABEL}</kbd></span>
        </footer>
      </div>
    </section>
  `;

  const query = <T extends Element>(selector: string): T => {
    const match = shadow.querySelector<T>(selector);
    if (!match) {
      throw new Error(`Website Appearance editor is missing ${selector}.`);
    }
    return match;
  };

  const bindings: Binding[] = [];
  const outputs: Array<{ element: HTMLOutputElement; field: NumberSettingKey; suffix: string }> = [];
  const gatedGroups: Array<{
    flag: BooleanSettingKey;
    toggle: HTMLInputElement;
    dials: Array<HTMLInputElement | HTMLSelectElement>;
  }> = [];

  function bindCheckbox(field: BooleanSettingKey): HTMLInputElement {
    const element = query<HTMLInputElement>(`[data-field="${field}"]`);
    bindings.push({
      element,
      apply(next) {
        (next as unknown as Record<string, unknown>)[field] = element.checked;
      },
      render(settings) {
        element.checked = settings[field];
      }
    });
    return element;
  }

  function bindDial(dial: Dial): HTMLInputElement | HTMLSelectElement {
    if (dial.kind === 'select') {
      const element = query<HTMLSelectElement>(`[data-field="${dial.field}"]`);
      bindings.push({
        element,
        apply(next) {
          next.gradientSpeed = element.value as WebsiteGradientSpeed;
        },
        render(settings) {
          element.value = settings.gradientSpeed;
        }
      });
      return element;
    }

    const element = query<HTMLInputElement>(`[data-field="${dial.field}"]`);

    if (dial.kind === 'list-color') {
      const { list, index } = dial;
      bindings.push({
        element,
        apply(next) {
          next[list][index] = element.value;
        },
        render(settings) {
          element.value = settings[list][index];
        }
      });
      return element;
    }

    if (dial.kind === 'color') {
      const field = dial.field;
      bindings.push({
        element,
        apply(next) {
          next[field] = element.value;
        },
        render(settings) {
          element.value = settings[field];
        }
      });
      return element;
    }

    const { field, min, max } = dial;
    bindings.push({
      element,
      apply(next) {
        // A half-typed number ("", "2") must not be clamped into the draft; the
        // change handler re-renders the committed value once editing settles.
        const value = Number(element.value);
        if (element.value.trim() === '' || !Number.isFinite(value) || value < min || value > max) {
          return;
        }
        next[field] = value;
      },
      render(settings) {
        element.value = String(settings[field]);
      }
    });
    if (dial.kind === 'range') {
      outputs.push({ element: query<HTMLOutputElement>(`[data-output="${field}"]`), field, suffix: dial.suffix });
    }
    return element;
  }

  const enabledInput = bindCheckbox('enabled');
  for (const group of GROUPS) {
    gatedGroups.push({
      flag: group.flag,
      toggle: bindCheckbox(group.flag),
      dials: group.dials.map(bindDial)
    });
  }
  const customCssEnabledInput = bindCheckbox('customCssEnabled');

  const customCssInput = query<HTMLTextAreaElement>('[data-field="customCss"]');
  bindings.push({
    element: customCssInput,
    apply(next) {
      next.customCss = customCssInput.value;
    },
    render(settings) {
      customCssInput.value = settings.customCss;
    }
  });

  const bindingsByField: Record<string, Binding | undefined> = Object.create(null) as Record<
    string,
    Binding | undefined
  >;
  for (const binding of bindings) {
    const field = binding.element.getAttribute('data-field');
    if (field) {
      bindingsByField[field] = binding;
    }
  }

  const customCssStatus = query<HTMLElement>('#custom-css-status');
  const masterHint = query<HTMLElement>('#master-hint');
  const commitStatus = query<HTMLElement>('#commit-status');
  commitStatus.hidden = true;
  const advanced = query<HTMLDetailsElement>('[data-advanced]');
  const closeButton = query<HTMLButtonElement>('[data-action="close"]');
  const resetButton = query<HTMLButtonElement>('[data-action="reset"]');
  const shareValueInput = query<HTMLInputElement>('[data-share="value"]');
  const shareImportInput = query<HTMLInputElement>('[data-share="import"]');
  const themeStatus = query<HTMLElement>('#theme-status');
  themeStatus.hidden = true;
  const copyShareButton = query<HTMLButtonElement>('[data-action="copy-share"]');
  const importShareButton = query<HTMLButtonElement>('[data-action="import-share"]');

  let draft = cloneSettings(normalizeWebsiteAppearanceSettings(options.getSettings()));
  let disposed = false;
  let commitTimer: number | null = null;
  let pendingCommit: WebsiteAppearanceSettings | null = null;
  let unsavedDraft = false;
  let previouslyFocused: Element | null = null;
  let mountWaitBound = false;
  let mountObserver: MutationObserver | null = null;
  let previewFrame: number | null = null;
  let previewQueued = false;
  let shareStale = true;
  let launcherReadyBound = false;
  let launcherObserver: MutationObserver | null = null;

  function mountLauncherStyle() {
    if (launcherStyle.isConnected) {
      return;
    }
    const existing = targetDocument.querySelector(`style[${LAUNCHER_STYLE_ATTRIBUTE}]`);
    if (existing && existing !== launcherStyle) {
      return;
    }
    (targetDocument.head ?? targetDocument.documentElement)?.appendChild(launcherStyle);
  }

  function mountLauncher() {
    if (disposed) {
      return;
    }
    mountLauncherStyle();
    const anchor =
      targetDocument.querySelector(DRAFTING_BUTTON_SELECTOR) ??
      targetDocument.querySelector(PLAY_ALL_BUTTON_SELECTOR);
    const toolbar = anchor?.parentElement;
    if (!toolbar || (launcher.isConnected && launcher.parentElement === toolbar)) {
      return;
    }
    const existing = targetDocument.querySelector(`[${LAUNCHER_ATTRIBUTE}]`);
    if (existing && existing !== launcher) {
      return;
    }
    toolbar.appendChild(launcher);
  }

  function handleLauncherDocumentReady() {
    targetDocument.removeEventListener('DOMContentLoaded', handleLauncherDocumentReady);
    launcherReadyBound = false;
    mountLauncher();
  }

  function startLauncherMounting() {
    mountLauncher();
    if (targetDocument.readyState === 'loading') {
      launcherReadyBound = true;
      targetDocument.addEventListener('DOMContentLoaded', handleLauncherDocumentReady);
    }
    const MutationObserverConstructor =
      targetDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (MutationObserverConstructor) {
      const observer = new MutationObserverConstructor(mountLauncher);
      observer.observe(targetDocument, { childList: true, subtree: true });
      launcherObserver = observer;
    }
  }

  function stopLauncherMounting() {
    if (launcherReadyBound) {
      targetDocument.removeEventListener('DOMContentLoaded', handleLauncherDocumentReady);
      launcherReadyBound = false;
    }
    launcherObserver?.disconnect();
    launcherObserver = null;
  }

  function stopWaitingForMount() {
    if (mountWaitBound) {
      targetDocument.removeEventListener('DOMContentLoaded', mountHost);
      mountWaitBound = false;
    }
    mountObserver?.disconnect();
    mountObserver = null;
  }

  function waitForMount() {
    if (disposed || mountWaitBound) {
      return;
    }
    mountWaitBound = true;
    targetDocument.addEventListener('DOMContentLoaded', mountHost);
    const MutationObserverConstructor =
      targetDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (MutationObserverConstructor) {
      const observer = new MutationObserverConstructor(mountHost);
      observer.observe(targetDocument, { childList: true });
      mountObserver = observer;
    }
  }

  function mountHost() {
    if (disposed) {
      return;
    }
    if (host.isConnected) {
      stopWaitingForMount();
      if (!host.hidden) {
        enabledInput.focus();
      }
      return;
    }
    const parent = targetDocument.body ?? targetDocument.documentElement;
    if (!parent) {
      waitForMount();
      return;
    }
    parent.appendChild(host);
    stopWaitingForMount();
    if (!host.hidden) {
      enabledInput.focus();
    }
  }

  function updateDependentControls() {
    const master = draft.enabled;
    for (const group of gatedGroups) {
      group.toggle.disabled = !master;
      const groupEnabled = master && draft[group.flag];
      for (const element of group.dials) {
        element.disabled = !groupEnabled;
      }
    }
    customCssEnabledInput.disabled = !master;
    masterHint.hidden = master;
    // Advanced only ever unfolds itself: a live gradient or expert stylesheet
    // must never hide behind a collapsed section, but a reader who folded it
    // back keeps that choice.
    if (draft.gradientEnabled || draft.customCssEnabled) {
      advanced.open = true;
    }
  }

  function renderOutputs() {
    for (const entry of outputs) {
      entry.element.value = `${draft[entry.field]}${entry.suffix}`;
    }
  }

  function updateValidationStatus() {
    const result = validateWebsiteCustomCss(draft.customCss);
    const atLimit = result.valid && draft.customCss.length >= WEBSITE_CUSTOM_CSS_MAX_LENGTH;
    customCssStatus.textContent = atLimit
      ? `${result.message} Character limit of ${WEBSITE_CUSTOM_CSS_MAX_LENGTH.toLocaleString('en-US')} reached.`
      : result.message;
    customCssStatus.classList.toggle('invalid', !result.valid);
    customCssStatus.classList.toggle('warn', atLimit);
    customCssInput.setAttribute('aria-invalid', result.valid ? 'false' : 'true');
  }

  function setThemeStatus(message: string, invalid: boolean) {
    themeStatus.textContent = message;
    themeStatus.classList.toggle('invalid', invalid);
    themeStatus.hidden = message === '';
  }

  /**
   * The share string is derived from the whole draft, so it is rebuilt only
   * where it is about to be read: a render, a copy, or a commit.
   */
  function refreshShareValue() {
    if (!shareStale) {
      return;
    }
    shareStale = false;
    shareValueInput.value = encodeWebsiteAppearanceShare(draft);
  }

  function renderDraft() {
    for (const binding of bindings) {
      binding.render(draft);
    }
    renderOutputs();
    refreshShareValue();
    updateDependentControls();
    updateValidationStatus();
  }

  // Colour dials fire `input` continuously while a swatch is dragged. The draft
  // and the controls stay synchronous; the expensive page preview is coalesced
  // to one run per frame, and the latest draft always wins.
  const useFrames =
    typeof targetWindow.requestAnimationFrame === 'function' &&
    typeof targetWindow.cancelAnimationFrame === 'function';

  function cancelPreviewFrame() {
    if (previewFrame === null) {
      return;
    }
    if (useFrames) {
      targetWindow.cancelAnimationFrame(previewFrame);
    } else {
      targetWindow.clearTimeout(previewFrame);
    }
    previewFrame = null;
  }

  function emitPreview() {
    if (disposed || !previewQueued) {
      return;
    }
    previewQueued = false;
    options.onPreview(cloneSettings(draft));
  }

  function runPreviewFrame() {
    previewFrame = null;
    emitPreview();
  }

  function schedulePreview() {
    previewQueued = true;
    if (previewFrame !== null) {
      return;
    }
    previewFrame = useFrames
      ? targetWindow.requestAnimationFrame(runPreviewFrame)
      : targetWindow.setTimeout(runPreviewFrame, PREVIEW_FRAME_FALLBACK_MS);
  }

  /** Applies the trailing value of a drag, so no edit is ever dropped. */
  function flushPreview() {
    cancelPreviewFrame();
    emitPreview();
  }

  function cancelCommitTimer() {
    if (commitTimer !== null) {
      targetWindow.clearTimeout(commitTimer);
      commitTimer = null;
    }
  }

  function reportCommitResult(result: WebsiteAppearanceCommitResult) {
    if (disposed) {
      return;
    }
    unsavedDraft = !result.saved;
    commitStatus.textContent = result.saved ? '' : `Not saved: ${result.error ?? 'unknown error'}`;
    commitStatus.hidden = result.saved;
  }

  async function runCommit(next: WebsiteAppearanceSettings) {
    try {
      reportCommitResult(await options.onCommit(next));
    } catch (error) {
      reportCommitResult({ saved: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function flushCommit() {
    cancelCommitTimer();
    if (disposed || !pendingCommit) {
      return;
    }
    const next = pendingCommit;
    pendingCommit = null;
    // What is saved must be what the page shows, so the trailing preview lands
    // and the share string catches up before the write.
    flushPreview();
    refreshShareValue();
    void runCommit(cloneSettings(next));
  }

  function scheduleCommit(next: WebsiteAppearanceSettings) {
    pendingCommit = cloneSettings(next);
    cancelCommitTimer();
    commitTimer = targetWindow.setTimeout(flushCommit, COMMIT_DELAY_MS);
  }

  function preview(next: WebsiteAppearanceSettings, immediateCommit = false) {
    draft = cloneSettings(normalizeWebsiteAppearanceSettings(next));
    shareStale = true;
    schedulePreview();
    scheduleCommit(draft);
    if (immediateCommit) {
      flushCommit();
    }
  }

  function readChangedDraft(binding: Binding): WebsiteAppearanceSettings {
    const next = cloneSettings(draft);
    binding.apply(next);
    return next;
  }

  function bindingForEvent(event: Event): Binding | undefined {
    const field = (event.target as Element | null)?.getAttribute('data-field');
    return field ? bindingsByField[field] : undefined;
  }

  function handleInput(event: Event) {
    if (disposed) {
      return;
    }
    const binding = bindingForEvent(event);
    if (!binding) {
      return;
    }
    preview(readChangedDraft(binding));
    // Per-event work stays cheap: only the custom CSS field needs the validator,
    // and the share string is not recomputed while a dial is being dragged.
    renderOutputs();
    updateDependentControls();
    if (binding.element === customCssInput) {
      updateValidationStatus();
    }
  }

  function handleChange(event: Event) {
    if (disposed) {
      return;
    }
    const binding = bindingForEvent(event);
    if (!binding) {
      return;
    }
    preview(readChangedDraft(binding), true);
    renderDraft();
  }

  function restorePreviousFocus() {
    const focusTarget = previouslyFocused as HTMLElement | null;
    previouslyFocused = null;
    if (focusTarget?.isConnected && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
  }

  function open() {
    if (disposed || !host.hidden) {
      return;
    }
    draft = cloneSettings(normalizeWebsiteAppearanceSettings(options.getSettings()));
    renderDraft();
    previouslyFocused = targetDocument.activeElement;
    host.hidden = false;
    mountHost();
  }

  function close() {
    if (disposed || host.hidden) {
      return;
    }
    flushCommit();
    flushPreview();
    host.hidden = true;
    restorePreviousFocus();
  }

  function toggle() {
    if (host.hidden) {
      open();
    } else {
      close();
    }
  }

  function handleLauncherClick() {
    toggle();
  }

  function handleDocumentKeydown(event: KeyboardEvent) {
    if (disposed) {
      return;
    }
    if (isToggleShortcut(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggle();
      return;
    }
    if (host.hidden || event.key !== 'Escape') {
      return;
    }
    // Escape belongs to the page unless it was pressed inside the editor, so the
    // dashboard's own Escape workflows keep working while the panel stays open.
    const fromPanel =
      typeof event.composedPath === 'function'
        ? event.composedPath().includes(host)
        : event.target === host;
    if (!fromPanel) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }

  function sync(next: WebsiteAppearanceSettings) {
    if (disposed || unsavedDraft || pendingCommit !== null || commitTimer !== null) {
      return;
    }
    draft = cloneSettings(normalizeWebsiteAppearanceSettings(next));
    renderDraft();
  }

  function handleReset() {
    if (disposed) {
      return;
    }
    const defaults = cloneSettings(DEFAULT_WEBSITE_APPEARANCE_SETTINGS);
    preview(defaults, true);
    renderDraft();
    setThemeStatus('', false);
  }

  async function handleCopyShare() {
    if (disposed) {
      return;
    }
    refreshShareValue();
    const clipboard = (targetWindow.navigator as Navigator | undefined)?.clipboard;
    if (clipboard) {
      try {
        await clipboard.writeText(shareValueInput.value);
        if (!disposed) {
          setThemeStatus('Theme string copied to the clipboard.', false);
        }
        return;
      } catch {
        // Clipboard access can be denied; fall through to a manual copy.
      }
    }
    if (disposed) {
      return;
    }
    // The fallback only selects the text, so the user can still copy by hand.
    const selectable = shareValueInput as { select?: () => void };
    shareValueInput.focus();
    selectable.select?.();
    setThemeStatus('Clipboard blocked. The theme string is selected — copy it manually.', true);
  }

  function handleImportShare() {
    if (disposed) {
      return;
    }
    const pasted = shareImportInput.value.trim();
    if (pasted === '') {
      setThemeStatus('Paste a theme string to import.', true);
      return;
    }
    const imported = decodeWebsiteAppearanceShare(pasted);
    if (!imported) {
      setThemeStatus('That is not a valid Website Appearance theme string.', true);
      return;
    }
    preview(imported, true);
    renderDraft();
    shareImportInput.value = '';
    setThemeStatus('Theme string imported.', false);
  }

  shadow.addEventListener('input', handleInput);
  shadow.addEventListener('change', handleChange);
  closeButton.addEventListener('click', close);
  resetButton.addEventListener('click', handleReset);
  copyShareButton.addEventListener('click', handleCopyShare);
  importShareButton.addEventListener('click', handleImportShare);
  targetDocument.addEventListener('keydown', handleDocumentKeydown, true);
  launcher.addEventListener('click', handleLauncherClick);
  startLauncherMounting();
  mountHost();
  renderDraft();

  return {
    dispose() {
      if (disposed) {
        return;
      }
      const wasOpen = !host.hidden;
      disposed = true;
      cancelCommitTimer();
      cancelPreviewFrame();
      previewQueued = false;
      pendingCommit = null;
      stopWaitingForMount();
      stopLauncherMounting();
      targetDocument.removeEventListener('keydown', handleDocumentKeydown, true);
      shadow.removeEventListener('input', handleInput);
      shadow.removeEventListener('change', handleChange);
      closeButton.removeEventListener('click', close);
      resetButton.removeEventListener('click', handleReset);
      copyShareButton.removeEventListener('click', handleCopyShare);
      importShareButton.removeEventListener('click', handleImportShare);
      launcher.removeEventListener('click', handleLauncherClick);
      host.hidden = true;
      if (wasOpen) {
        restorePreviousFocus();
      }
      host.remove();
      launcher.remove();
      launcherStyle.remove();
    },
    open,
    close,
    toggle,
    sync
  };
}
