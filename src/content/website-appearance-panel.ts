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
      return `<label>${dial.label} <input type="color" data-field="${dial.field}" aria-label="${aria}"></label>`;
    case 'number':
      return `<label>${dial.label} <input type="number" min="${dial.min}" max="${dial.max}" step="${dial.step}" data-field="${dial.field}" aria-label="${aria}"></label>`;
    case 'range':
      return `<label>${dial.label} <span class="slider"><input type="range" min="${dial.min}" max="${dial.max}" step="${dial.step}" data-field="${dial.field}" aria-label="${aria}"><output data-output="${dial.field}"></output></span></label>`;
    case 'select':
      return `<label>${dial.label} <select data-field="${dial.field}" aria-label="${aria}">${dial.options
        .map(([value, text]) => `<option value="${value}">${text}</option>`)
        .join('')}</select></label>`;
  }
}

function groupMarkup(group: AppearanceGroup): string {
  const note = group.note ? `<p class="hint note">${group.note}</p>` : '';
  const colors = group.dials.filter(isColorDial);
  const grid = colors.length > 0 ? `<div class="colors">${colors.map(dialMarkup).join('')}</div>` : '';
  const others = group.dials.filter((dial) => !isColorDial(dial));
  return `<fieldset data-group="${group.flag}">
          <legend><label class="toggle"><input type="checkbox" data-field="${group.flag}" aria-label="Enable ${group.legend}">${group.legend}</label></legend>
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
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        inset: 16px 16px auto auto;
        width: min(340px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        color: #111827;
        color-scheme: light;
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      :host([hidden]) { display: none !important; }
      *, *::before, *::after { box-sizing: border-box; }
      .panel {
        overflow: auto;
        max-height: calc(100vh - 32px);
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 18px 48px rgb(15 23 42 / 24%);
      }
      header {
        position: sticky;
        z-index: 1;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid #e2e8f0;
        background: #fff;
      }
      h2 { margin: 0; font-size: 15px; line-height: 1.2; }
      .body { display: grid; gap: 8px; padding: 12px; }
      .master { font-weight: 700; }
      .hint { margin: -4px 0 2px; color: #475569; font-size: 12px; }
      .hint.warn, .status.warn { color: #b45309; font-weight: 600; }
      [hidden] { display: none !important; }
      fieldset {
        display: grid;
        gap: 7px;
        min-width: 0;
        margin: 0;
        padding: 8px 9px 9px;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
      }
      legend { padding: 0 4px; color: #475569; font-weight: 700; }
      label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; }
      label.stack { grid-template-columns: 1fr; }
      label.toggle { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; }
      .slider { display: inline-flex; align-items: center; gap: 6px; }
      .colors { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 10px; }
      .colors label { grid-template-columns: 1fr 30px; font-size: 12px; }
      .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .row .grow { flex: 1 1 auto; min-width: 0; }
      .row .hint { margin: 0; }
      .row > button { flex: 0 0 auto; white-space: nowrap; }
      .share { font: 11px/1.45 ui-monospace, monospace; }
      .advanced { display: grid; gap: 8px; }
      .advanced > summary {
        color: #475569;
        font-weight: 700;
        cursor: pointer;
        list-style: none;
      }
      .advanced > summary::before { content: "▸ "; }
      .advanced[open] > summary::before { content: "▾ "; }
      .advanced > summary::-webkit-details-marker { display: none; }
      fieldset[data-group] { padding-top: 4px; }
      fieldset[data-group]:has(> legend .toggle > input:not(:checked)) {
        gap: 0;
        padding: 0 9px 3px;
        border-color: transparent;
      }
      fieldset[data-group]:has(> legend .toggle > input:not(:checked)) > :not(legend):not(.note) {
        display: none;
      }
      fieldset[data-group]:has(> legend .toggle > input:not(:checked)) > .note {
        margin: 0 0 2px;
      }
      input, select, textarea, button { font: inherit; }
      input[type='checkbox'] { width: 16px; height: 16px; margin: 0; accent-color: #0f766e; }
      input[type='color'] {
        width: 30px;
        height: 24px;
        padding: 1px;
        border: 1px solid #94a3b8;
        border-radius: 5px;
        background: #fff;
      }
      input[type='number'], input[type='text'], select, textarea {
        border: 1px solid #94a3b8;
        border-radius: 6px;
        background: #fff;
        color: #111827;
      }
      input[type='number'] { width: 70px; padding: 4px 6px; }
      select { min-width: 112px; padding: 4px 6px; }
      input[type='range'] { width: 132px; accent-color: #0f766e; }
      textarea { width: 100%; min-height: 76px; padding: 7px; resize: vertical; font: 12px/1.45 ui-monospace, monospace; }
      input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible,
      summary:focus-visible {
        outline: 2px solid #0f766e;
        outline-offset: 2px;
      }
      button {
        border: 1px solid #94a3b8;
        border-radius: 6px;
        padding: 5px 9px;
        background: #f8fafc;
        color: #0f172a;
        cursor: pointer;
      }
      button:hover { background: #f1f5f9; }
      .icon-button { min-width: 30px; padding: 4px 7px; font-size: 17px; line-height: 1; }
      output { min-width: 42px; color: #475569; text-align: right; font-variant-numeric: tabular-nums; }
      .status { margin: -2px 0 0; color: #047857; font-size: 12px; }
      .status.invalid { color: #b91c1c; }
      footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      kbd {
        border: 1px solid #cbd5e1;
        border-bottom-width: 2px;
        border-radius: 4px;
        padding: 2px 5px;
        background: #f8fafc;
        color: #334155;
        font: 11px/1.2 ui-monospace, monospace;
        white-space: nowrap;
      }
      [disabled] { opacity: .55; cursor: not-allowed; }
    </style>
    <section class="panel" role="dialog" aria-modal="false" aria-labelledby="appearance-panel-title">
      <header>
        <h2 id="appearance-panel-title">Website Appearance</h2>
        <button class="icon-button" type="button" data-action="close" aria-label="Close Website Appearance editor">×</button>
      </header>
      <div class="body">
        <label class="toggle master"><input type="checkbox" data-field="enabled">Enable custom appearance</label>
        <p class="hint">Only the sections you enable are changed. Everything else keeps the site's own design.</p>
        <p class="hint warn" id="master-hint" role="status" aria-live="polite">Turn on custom appearance to edit these sections.</p>
        ${groupMarkup(TEXT_GROUP)}
        ${groupMarkup(THEME_GROUP)}
        <details class="advanced" data-advanced>
          <summary>Advanced</summary>
          ${groupMarkup(GRADIENT_GROUP)}
          <fieldset class="expert">
            <legend><label class="toggle"><input type="checkbox" data-field="customCssEnabled" aria-label="Apply expert CSS">Expert CSS</label></legend>
            <label class="stack">Custom CSS<textarea data-field="customCss" maxlength="${WEBSITE_CUSTOM_CSS_MAX_LENGTH}" spellcheck="false" aria-describedby="custom-css-status"></textarea></label>
            <p class="status" id="custom-css-status" role="status" aria-live="polite"></p>
          </fieldset>
          <fieldset class="sharing">
            <legend>Theme sharing</legend>
            <label class="stack">Share string<input class="share" type="text" data-share="value" readonly spellcheck="false" aria-label="Website Appearance share string" aria-describedby="theme-status"></label>
            <div class="row">
              <button type="button" data-action="copy-share">Copy</button>
              <input class="share grow" type="text" data-share="import" spellcheck="false" placeholder="Paste a theme string" aria-label="Website Appearance share string to import" aria-describedby="theme-status">
              <button type="button" data-action="import-share">Import</button>
            </div>
            <p class="status" id="theme-status" role="status" aria-live="polite"></p>
          </fieldset>
        </details>
        <p class="status invalid" id="commit-status" role="status" aria-live="polite"></p>
        <footer>
          <button type="button" data-action="reset">Reset appearance</button>
          <span>Toggle <kbd>${SHORTCUT_LABEL}</kbd></span>
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
      targetDocument.removeEventListener('keydown', handleDocumentKeydown, true);
      shadow.removeEventListener('input', handleInput);
      shadow.removeEventListener('change', handleChange);
      closeButton.removeEventListener('click', close);
      resetButton.removeEventListener('click', handleReset);
      copyShareButton.removeEventListener('click', handleCopyShare);
      importShareButton.removeEventListener('click', handleImportShare);
      host.hidden = true;
      if (wasOpen) {
        restorePreviousFocus();
      }
      host.remove();
    },
    open,
    close,
    toggle,
    sync
  };
}
