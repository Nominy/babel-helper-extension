import { BABEL_ROW_TEXTAREA_SELECTOR } from '../core/babel-editor-contract';
import {
  WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT,
  normalizeWebsiteAppearanceSettings,
  validateWebsiteCustomCss,
  type WebsiteAppearanceSettings
} from '../core/settings';

const CUSTOM_STYLE_ID = 'babel-helper-website-custom-css';
const OWNER_ATTRIBUTE = 'data-babel-helper-owner';
const OWNER_VALUE = 'website-appearance';

const WAVEFORM_BRIDGE_SCRIPT_PATH = 'dist/content/waveform-theme-bridge.js';
const WAVEFORM_BRIDGE_SCRIPT_ATTRIBUTE = 'data-babel-helper-waveform-theme-bridge';
const WAVEFORM_CONFIG_EVENT = 'babel-helper-waveform-theme-config';

// One attribute per switch. The stylesheet gates every rule on the master attribute plus
// the attribute of the group that owns the rule, so a group that is off leaves the page
// untouched even while another group paints.
const APPEARANCE_ATTRIBUTE = 'data-babel-helper-appearance';
const TEXT_ATTRIBUTE = 'data-babel-helper-appearance-text';
const THEME_ATTRIBUTE = 'data-babel-helper-appearance-theme';
const GRADIENT_ATTRIBUTE = 'data-babel-helper-appearance-gradient';
const GRADIENT_SPEED_ATTRIBUTE = 'data-babel-helper-appearance-gradient-speed';

const ENABLED_VALUE = 'enabled';

// The transcript scope, stamped by this controller so the stylesheet can gate on a plain
// attribute. A `:has()` gate re-walks the transcript subtree for every rule it guards, and
// one palette custom property invalidates style for the whole document: marking the scope
// once from the runtime buys the same selector for a fraction of a recalc. These marks are
// gating only — never geometry, never a value the page can read a size out of.
const SCOPE_ATTRIBUTE = 'data-babel-helper-scope';
const TRANSCRIPT_SCOPE_VALUE = 'transcript';
const TRANSCRIPT_TABLE_SCOPE_VALUE = 'transcript-table';

// The transcript main is the one holding a row textarea; the transcript table is a table
// inside it that does. The table marker also answers to `textarea.w-full`, exactly as the
// sheet's `:has()` gate did, so a renamed placeholder cannot silently strip the table's
// palette while the rest of the transcript keeps it.
const TRANSCRIPT_MAIN_SELECTOR = 'main, [role="main"]';
const TRANSCRIPT_TABLE_SELECTOR = 'table';
const TRANSCRIPT_TABLE_TEXTAREA_SELECTOR = `${BABEL_ROW_TEXTAREA_SELECTOR}, textarea.w-full`;

// A route change swaps the transcript wholesale, so the marks are reconciled from a
// debounced observer instead of from apply: a burst of mutations coalesces into one
// bounded pass of selector matches, and a palette drag pays nothing for any of it.
const SCOPE_SYNC_DELAY_MS = 150;

// Text group: the only two dials that are not colors.
const TEXT_SIZE_VARIABLE = '--bh-text-size';
const TABLE_TEXT_SIZE_VARIABLE = '--bh-table-text-size';

// Gradient group.
const GRADIENT_COLOR_VARIABLES = [
  '--bh-gradient-color-1',
  '--bh-gradient-color-2',
  '--bh-gradient-color-3'
] as const;
const GRADIENT_ANGLE_VARIABLE = '--bh-gradient-angle';
const GRADIENT_DURATION_VARIABLE = '--bh-gradient-duration';

// Theme group. Every name below is derived from the stored palette by deriveThemeVariables:
// the palette holds fifteen values, this is the complete surface the stylesheet may read,
// and nothing here is ever persisted.
const THEME_VARIABLES = [
  '--bh-page',
  '--bh-surface',
  '--bh-surface-raised',
  '--bh-surface-hover',
  '--bh-text',
  '--bh-muted',
  '--bh-accent',
  '--bh-accent-text',
  '--bh-border',
  '--bh-active-row',
  '--bh-active-row-text',
  '--bh-wave',
  '--bh-danger',
  '--bh-warning',
  '--bh-success',
  '--bh-danger-tint',
  '--bh-warning-tint',
  '--bh-success-tint',
  '--bh-speaker-1',
  '--bh-speaker-2',
  '--bh-speaker-3',
  '--bh-speaker-1-tint',
  '--bh-speaker-2-tint',
  '--bh-speaker-3-tint',
  '--bh-scrollbar-thumb'
] as const;

// The dashboard resolves its own design tokens as hsl(var(--token)), so these carry bare
// space-separated HSL triplets rather than colors. They ride the theme group: one palette
// paints both the extension's own rules and the app's native token surface, so there is no
// separate switch and no token can drift away from the color it was derived from.
const APP_TOKEN_MAP = [
  ['pageColor', ['--background']],
  [
    'surfaceColor',
    ['--card', '--popover', '--sidebar', '--muted', '--secondary', '--accent']
  ],
  [
    'textColor',
    [
      '--foreground',
      '--card-foreground',
      '--popover-foreground',
      '--sidebar-foreground',
      '--secondary-foreground',
      '--accent-foreground'
    ]
  ],
  ['mutedTextColor', ['--muted-foreground']],
  ['accentColor', ['--primary', '--ring', '--sidebar-ring']],
  ['accentTextColor', ['--primary-foreground', '--destructive-foreground']],
  ['borderColor', ['--border', '--input', '--sidebar-border']],
  ['dangerColor', ['--destructive']]
] as const;

const APP_TOKEN_VARIABLES = APP_TOKEN_MAP.flatMap(([, tokens]) => [...tokens]);

const GRADIENT_DURATIONS = {
  slow: '24s',
  balanced: '14s',
  fast: '8s'
} as const;

// A raised surface is the surface pulled this far toward the text color; hovering pulls it
// one step further. Status tints are the status hue dropped onto the surface, and the
// scrollbar thumb is the border nudged toward the text so it stays visible on both ends of
// the lightness range.
const SURFACE_RAISED_MIX_PERCENT = 5;
const SURFACE_HOVER_MIX_PERCENT = 8;
const STATUS_TINT_SURFACE_PERCENT = 88;
const SCROLLBAR_THUMB_MIX_PERCENT = 15;
const SPEAKER_TINT_ALPHA = 0.25;

type Rgb = { red: number; green: number; blue: number };

function parseHexColor(color: string): Rgb {
  return {
    red: Number.parseInt(color.slice(1, 3), 16),
    green: Number.parseInt(color.slice(3, 5), 16),
    blue: Number.parseInt(color.slice(5, 7), 16)
  };
}

/** Clamped, zero-padded sRGB byte: a mix can land just outside 0..255 after rounding. */
function toHexChannel(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0');
}

/** `base` moved `percent` of the way toward `toward`, in sRGB, rounded per channel. */
function mixHexColors(base: string, toward: string, percent: number): string {
  const from = parseHexColor(base);
  const to = parseHexColor(toward);
  const weight = percent / 100;
  const red = toHexChannel(from.red + (to.red - from.red) * weight);
  const green = toHexChannel(from.green + (to.green - from.green) * weight);
  const blue = toHexChannel(from.blue + (to.blue - from.blue) * weight);
  return `#${red}${green}${blue}`;
}

function hexToRgba(color: string, alpha: number): string {
  const { red, green, blue } = parseHexColor(color);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function hexToHslTriplet(color: string): string {
  const { red: rawRed, green: rawGreen, blue: rawBlue } = parseHexColor(color);
  const red = rawRed / 255;
  const green = rawGreen / 255;
  const blue = rawBlue / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (chroma > 0) {
    // Pure black and pure white have no chroma, so this never divides by zero.
    saturation = chroma / (1 - Math.abs(2 * lightness - 1));
    if (max === red) {
      hue = ((green - blue) / chroma + (green < blue ? 6 : 0)) * 60;
    } else if (max === green) {
      hue = ((blue - red) / chroma + 2) * 60;
    } else {
      hue = ((red - green) / chroma + 4) * 60;
    }
  }
  const roundedHue = Math.round(hue) % 360;
  const roundedSaturation = Math.round(saturation * 100);
  const roundedLightness = Math.round(lightness * 100);
  return `${roundedHue} ${roundedSaturation}% ${roundedLightness}%`;
}

const CONTROLLED_ATTRIBUTES = [
  APPEARANCE_ATTRIBUTE,
  TEXT_ATTRIBUTE,
  THEME_ATTRIBUTE,
  GRADIENT_ATTRIBUTE,
  GRADIENT_SPEED_ATTRIBUTE
] as const;
const CONTROLLED_VARIABLES = [
  TEXT_SIZE_VARIABLE,
  TABLE_TEXT_SIZE_VARIABLE,
  ...GRADIENT_COLOR_VARIABLES,
  GRADIENT_ANGLE_VARIABLE,
  GRADIENT_DURATION_VARIABLE,
  ...THEME_VARIABLES,
  ...APP_TOKEN_VARIABLES
] as const;
type ControlledAttribute = (typeof CONTROLLED_ATTRIBUTES)[number];
type ControlledVariable = (typeof CONTROLLED_VARIABLES)[number];

type VariableState = {
  value: string;
  priority: string;
};

/**
 * Capture-and-restore bookkeeping for the attributes this controller writes on one
 * element: what the page carried before the first write, and what this controller last
 * wrote. The root switches and the transcript scope marks live on different elements but
 * obey one rule, so they share one shape and one pair of writers.
 */
type AttributeOwnership<Name extends string> = {
  element: HTMLElement;
  original: Partial<Record<Name, string | null>>;
  written: Partial<Record<Name, string>>;
};

type ScopeOwnership = AttributeOwnership<typeof SCOPE_ATTRIBUTE>;

type RootState = {
  root: HTMLElement;
  attributes: AttributeOwnership<ControlledAttribute>;
  originalVariables: Record<ControlledVariable, VariableState>;
  writtenVariables: Partial<Record<ControlledVariable, VariableState>>;
};

type DesiredState = {
  attributes: Partial<Record<ControlledAttribute, string>>;
  variables: Partial<Record<ControlledVariable, string>>;
};

type ChromeRuntimeHost = {
  runtime: {
    getURL: (path: string) => string;
  };
};

/** One speaker slot as it crosses into the page world. */
type SpeakerSlotConfig = {
  waveColor: string;
  progressColor: string;
  cursorColor: string;
  regionColor: string;
  regionBorderColor: string;
};

/**
 * The dials the lanes are made of, as they were last handed to the bridge. Everything a
 * config event can say is a pure function of these, so anything else the palette moves —
 * a surface, an accent, a border — has nothing to tell the page world.
 */
type WaveformConfigSnapshot = {
  enabled: boolean;
  waveColor: string;
  textColor: string;
  speakerColors: string[];
};

function readVariable(root: HTMLElement, name: ControlledVariable): VariableState {
  return {
    value: root.style.getPropertyValue(name),
    priority: root.style.getPropertyPriority(name)
  };
}

/**
 * Both writers read the element before they touch it. A read of an attribute is free, a
 * write is not: it invalidates style for the whole document. So a value that is already
 * there is left alone, which turns a drag frame that moves one dial into one or two
 * writes instead of the whole controlled surface. The capture rule is untouched: whatever
 * sits on the element when it is not what this controller last wrote is what a restore
 * has to put back, so an external change is recaptured rather than lost.
 */
function writeOwnedAttribute<Name extends string>(
  owned: AttributeOwnership<Name>,
  name: Name,
  value: string
) {
  const current = owned.element.getAttribute(name);
  if (
    Object.prototype.hasOwnProperty.call(owned.written, name) &&
    current === owned.written[name]
  ) {
    if (current === value) {
      return;
    }
  } else {
    owned.original[name] = current;
  }
  if (current !== value) {
    owned.element.setAttribute(name, value);
  }
  owned.written[name] = value;
}

function restoreOwnedAttribute<Name extends string>(
  owned: AttributeOwnership<Name>,
  name: Name
) {
  if (!Object.prototype.hasOwnProperty.call(owned.written, name)) {
    return;
  }
  const written = owned.written[name];
  delete owned.written[name];
  if (owned.element.getAttribute(name) !== written) {
    return;
  }
  const original = owned.original[name] ?? null;
  if (original === null) {
    owned.element.removeAttribute(name);
  } else {
    owned.element.setAttribute(name, original);
  }
}

function getChromeRuntime(): ChromeRuntimeHost | null {
  // Chrome exposes the extension API as a global that is absent from DOM typings.
  const globalWithChrome = globalThis as typeof globalThis & { chrome?: unknown };
  const chromeApi = globalWithChrome.chrome;
  if (!chromeApi || typeof chromeApi !== 'object' || !('runtime' in chromeApi)) {
    return null;
  }
  const runtime = chromeApi.runtime;
  if (!runtime || typeof runtime !== 'object' || !('getURL' in runtime)) {
    return null;
  }
  if (typeof runtime.getURL !== 'function') {
    return null;
  }
  // The guards above prove the extension runtime shape this module needs.
  const chromeRuntimeHost = chromeApi as ChromeRuntimeHost;
  return chromeRuntimeHost;
}

/**
 * Wavesurfer paints into a canvas and the regions plugin writes inline styles inside a
 * shadow root, so these five colors cannot be reached by CSS and cross into the page world
 * as plain data. Slots travel in order and a lane picks `lanes[(laneOrder - 1) % 3]`. The
 * wave is shared by every slot, the speaker hue drives progress and both region colors, and
 * the cursor rides the palette text color so it stays visible against the page.
 */
export function deriveSpeakerSlots(
  settings: WebsiteAppearanceSettings
): SpeakerSlotConfig[] {
  const slots: SpeakerSlotConfig[] = [];
  for (let slot = 0; slot < WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT; slot += 1) {
    const speaker = settings.speakerColors[slot];
    slots.push({
      waveColor: settings.waveColor,
      progressColor: speaker,
      cursorColor: settings.textColor,
      regionColor: speaker,
      regionBorderColor: speaker
    });
  }
  return slots;
}

/**
 * The whole `--bh-*` theme surface, derived from the fifteen stored palette values. Every
 * value is a pure function of the palette, so the same palette always produces the same
 * declarations and a disable can restore the page byte for byte.
 */
export function deriveThemeVariables(
  settings: WebsiteAppearanceSettings
): Record<(typeof THEME_VARIABLES)[number], string> {
  const surface = settings.surfaceColor;
  const text = settings.textColor;
  const [speakerOne, speakerTwo, speakerThree] = settings.speakerColors;
  return {
    '--bh-page': settings.pageColor,
    '--bh-surface': surface,
    '--bh-surface-raised': mixHexColors(surface, text, SURFACE_RAISED_MIX_PERCENT),
    '--bh-surface-hover': mixHexColors(surface, text, SURFACE_HOVER_MIX_PERCENT),
    '--bh-text': text,
    '--bh-muted': settings.mutedTextColor,
    '--bh-accent': settings.accentColor,
    '--bh-accent-text': settings.accentTextColor,
    '--bh-border': settings.borderColor,
    '--bh-active-row': settings.activeRowColor,
    '--bh-active-row-text': settings.activeRowTextColor,
    '--bh-wave': settings.waveColor,
    '--bh-danger': settings.dangerColor,
    '--bh-warning': settings.warningColor,
    '--bh-success': settings.successColor,
    '--bh-danger-tint': mixHexColors(
      settings.dangerColor,
      surface,
      STATUS_TINT_SURFACE_PERCENT
    ),
    '--bh-warning-tint': mixHexColors(
      settings.warningColor,
      surface,
      STATUS_TINT_SURFACE_PERCENT
    ),
    '--bh-success-tint': mixHexColors(
      settings.successColor,
      surface,
      STATUS_TINT_SURFACE_PERCENT
    ),
    '--bh-speaker-1': speakerOne,
    '--bh-speaker-2': speakerTwo,
    '--bh-speaker-3': speakerThree,
    '--bh-speaker-1-tint': hexToRgba(speakerOne, SPEAKER_TINT_ALPHA),
    '--bh-speaker-2-tint': hexToRgba(speakerTwo, SPEAKER_TINT_ALPHA),
    '--bh-speaker-3-tint': hexToRgba(speakerThree, SPEAKER_TINT_ALPHA),
    '--bh-scrollbar-thumb': mixHexColors(
      settings.borderColor,
      text,
      SCROLLBAR_THUMB_MIX_PERCENT
    )
  };
}

export function computeDesiredState(settings: WebsiteAppearanceSettings): DesiredState {
  const attributes: Partial<Record<ControlledAttribute, string>> = {
    [APPEARANCE_ATTRIBUTE]: ENABLED_VALUE
  };
  const variables: Partial<Record<ControlledVariable, string>> = {};

  if (settings.textEnabled) {
    attributes[TEXT_ATTRIBUTE] = ENABLED_VALUE;
    variables[TEXT_SIZE_VARIABLE] = `${settings.textSizePx}px`;
    variables[TABLE_TEXT_SIZE_VARIABLE] = `${settings.tableTextSizePx}px`;
  }

  if (settings.gradientEnabled) {
    attributes[GRADIENT_ATTRIBUTE] = ENABLED_VALUE;
    attributes[GRADIENT_SPEED_ATTRIBUTE] = settings.gradientSpeed;
    for (let index = 0; index < GRADIENT_COLOR_VARIABLES.length; index += 1) {
      variables[GRADIENT_COLOR_VARIABLES[index]] = settings.gradientColors[index];
    }
    variables[GRADIENT_ANGLE_VARIABLE] = `${settings.gradientAngle}deg`;
    variables[GRADIENT_DURATION_VARIABLE] = GRADIENT_DURATIONS[settings.gradientSpeed];
  }

  if (settings.themeEnabled) {
    attributes[THEME_ATTRIBUTE] = ENABLED_VALUE;
    const theme = deriveThemeVariables(settings);
    for (const name of THEME_VARIABLES) {
      variables[name] = theme[name];
    }
    for (const [dial, tokens] of APP_TOKEN_MAP) {
      const triplet = hexToHslTriplet(settings[dial]);
      for (const token of tokens) {
        variables[token] = triplet;
      }
    }
  }

  return { attributes, variables };
}

export function createWebsiteAppearanceController(targetDocument?: Document) {
  const resolvedDocument = targetDocument ?? globalThis.document;
  let disposed = false;
  let latestSettings: WebsiteAppearanceSettings | null = null;
  let rootState: RootState | null = null;
  let ownedCustomStyle: HTMLElement | null = null;
  let rootWaitBound = false;
  let rootObserver: MutationObserver | null = null;
  // One entry per marked element, so a transcript that is swapped out is restored to the
  // value the page had rather than to nothing.
  const scopeStamps = new Map<HTMLElement, ScopeOwnership>();
  let scopeObserver: MutationObserver | null = null;
  let scopeSyncTimer = 0;
  let waveformBridgeReady = false;
  let waveformBridgeScript: HTMLScriptElement | null = null;
  let lastWaveformConfig: WaveformConfigSnapshot | null = null;
  let validatedCustomCss: string | null = null;
  let validatedCustomCssValid = false;

  function restoreVariable(state: RootState, name: ControlledVariable) {
    const written = state.writtenVariables[name];
    if (!written) {
      return;
    }
    delete state.writtenVariables[name];
    const current = readVariable(state.root, name);
    if (current.value !== written.value || current.priority !== written.priority) {
      return;
    }
    const original = state.originalVariables[name];
    if (original.value === '' && original.priority === '') {
      state.root.style.removeProperty(name);
    } else {
      state.root.style.setProperty(name, original.value, original.priority);
    }
  }

  function restoreRootState() {
    if (!rootState) {
      return;
    }

    const state = rootState;
    rootState = null;
    for (const attribute of CONTROLLED_ATTRIBUTES) {
      restoreOwnedAttribute(state.attributes, attribute);
    }
    for (const variable of CONTROLLED_VARIABLES) {
      restoreVariable(state, variable);
    }
  }

  function prepareRoot(root: HTMLElement): RootState {
    if (rootState?.root !== root) {
      restoreRootState();
    }
    if (!rootState) {
      const original = {} as Record<ControlledAttribute, string | null>;
      const originalVariables = {} as Record<ControlledVariable, VariableState>;
      for (const attribute of CONTROLLED_ATTRIBUTES) {
        original[attribute] = root.getAttribute(attribute);
      }
      for (const variable of CONTROLLED_VARIABLES) {
        originalVariables[variable] = readVariable(root, variable);
      }
      rootState = {
        root,
        attributes: { element: root, original, written: {} },
        originalVariables,
        writtenVariables: {}
      };
    }
    return rootState;
  }

  // A variable write follows the same read-first rule as an attribute write; only the
  // priority makes it its own function.
  function writeVariable(state: RootState, name: ControlledVariable, value: string) {
    const currentValue = state.root.style.getPropertyValue(name);
    const currentPriority = state.root.style.getPropertyPriority(name);
    const previous = state.writtenVariables[name];
    if (
      previous &&
      previous.value === currentValue &&
      previous.priority === currentPriority
    ) {
      if (previous.value === value) {
        return;
      }
    } else {
      state.originalVariables[name] = { value: currentValue, priority: currentPriority };
    }
    // An equal value still has to be rewritten when the root carries it as important:
    // this controller never owns a priority, so the declaration itself must change.
    if (currentValue !== value || currentPriority !== '') {
      state.root.style.setProperty(name, value);
    }
    state.writtenVariables[name] = { value, priority: '' };
  }

  function removeOwnedCustomStyle() {
    const style = ownedCustomStyle;
    ownedCustomStyle = null;
    if (style?.getAttribute(OWNER_ATTRIBUTE) === OWNER_VALUE) {
      style.remove();
    }
  }

  function applyCustomStyle(css: string) {
    if (!resolvedDocument) {
      return;
    }

    if (ownedCustomStyle) {
      if (ownedCustomStyle.getAttribute(OWNER_ATTRIBUTE) !== OWNER_VALUE) {
        ownedCustomStyle = null;
      } else {
        const idWinner = resolvedDocument.getElementById(CUSTOM_STYLE_ID);
        if (idWinner && idWinner !== ownedCustomStyle) {
          removeOwnedCustomStyle();
          return;
        }
        if (idWinner === ownedCustomStyle) {
          if (ownedCustomStyle.textContent !== css) {
            ownedCustomStyle.textContent = css;
          }
          return;
        }
        // The element lost our id to someone else, so it can never be found again.
        removeOwnedCustomStyle();
      }
    }

    const existing = resolvedDocument.getElementById(CUSTOM_STYLE_ID);
    if (existing) {
      if (existing.getAttribute(OWNER_ATTRIBUTE) === OWNER_VALUE) {
        ownedCustomStyle = existing;
        if (ownedCustomStyle.textContent !== css) {
          ownedCustomStyle.textContent = css;
        }
      }
      return;
    }

    const parent = resolvedDocument.head ?? resolvedDocument.documentElement;
    if (!parent) {
      return;
    }
    const style = resolvedDocument.createElement('style');
    style.id = CUSTOM_STYLE_ID;
    style.setAttribute(OWNER_ATTRIBUTE, OWNER_VALUE);
    style.textContent = css;
    parent.appendChild(style);
    ownedCustomStyle = style;
  }

  function dispatchWaveformConfig(settings: WebsiteAppearanceSettings, enabled: boolean) {
    if (!waveformBridgeReady) {
      return;
    }
    const view = resolvedDocument?.defaultView ?? null;
    const eventTarget = view ?? globalThis;
    const CustomEventConstructor = view?.CustomEvent ?? globalThis.CustomEvent;
    if (typeof eventTarget.dispatchEvent !== 'function' || !CustomEventConstructor) {
      return;
    }
    eventTarget.dispatchEvent(
      new CustomEventConstructor(WAVEFORM_CONFIG_EVENT, {
        detail: {
          enabled,
          lanes: deriveSpeakerSlots(settings)
        }
      })
    );
    // Only a config that actually reached the page world may silence the next one.
    lastWaveformConfig = {
      enabled,
      waveColor: settings.waveColor,
      textColor: settings.textColor,
      speakerColors: settings.speakerColors.slice()
    };
  }

  function removeWaveformBridgeScript() {
    const script = waveformBridgeScript;
    waveformBridgeScript = null;
    script?.remove();
  }

  function ensureWaveformBridge() {
    if (disposed || waveformBridgeReady || waveformBridgeScript || !resolvedDocument) {
      return;
    }
    const parent =
      resolvedDocument.documentElement ?? resolvedDocument.head ?? resolvedDocument.body;
    const chromeRuntime = getChromeRuntime();
    if (!parent || !chromeRuntime) {
      return;
    }

    const script = resolvedDocument.createElement('script');
    script.setAttribute(WAVEFORM_BRIDGE_SCRIPT_ATTRIBUTE, 'true');
    try {
      script.src = chromeRuntime.runtime.getURL(WAVEFORM_BRIDGE_SCRIPT_PATH);
    } catch {
      return;
    }
    script.async = false;
    script.onload = () => {
      removeWaveformBridgeScript();
      if (disposed) {
        return;
      }
      waveformBridgeReady = true;
      // The bridge never replays events, so the live config must follow its load.
      if (latestSettings) {
        dispatchWaveformConfig(
          latestSettings,
          latestSettings.enabled && latestSettings.themeEnabled
        );
      }
    };
    script.onerror = removeWaveformBridgeScript;
    waveformBridgeScript = script;
    parent.appendChild(script);
  }

  function waveformConfigChanged(
    settings: WebsiteAppearanceSettings,
    enabled: boolean
  ): boolean {
    const last = lastWaveformConfig;
    if (
      !last ||
      last.enabled !== enabled ||
      last.waveColor !== settings.waveColor ||
      last.textColor !== settings.textColor
    ) {
      return true;
    }
    const speakers = settings.speakerColors;
    for (let slot = 0; slot < WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT; slot += 1) {
      if (last.speakerColors[slot] !== speakers[slot]) {
        return true;
      }
    }
    return false;
  }

  function syncWaveformTheme(settings: WebsiteAppearanceSettings) {
    // The palette owns the canvas colors, so the bridge is only ever injected once the
    // theme group is actually painting.
    const enabled = settings.enabled && settings.themeEnabled;
    if (enabled) {
      ensureWaveformBridge();
    }
    // Every other dial in the palette is CSS only: the canvas has nothing to redraw for
    // it, so a drag on a surface or accent color never crosses into the page world.
    if (waveformConfigChanged(settings, enabled)) {
      dispatchWaveformConfig(settings, enabled);
    }
  }

  function stopWaitingForRoot() {
    if (rootWaitBound && resolvedDocument) {
      resolvedDocument.removeEventListener('DOMContentLoaded', handleRootAvailable);
    }
    rootWaitBound = false;
    rootObserver?.disconnect();
    rootObserver = null;
  }

  function handleRootAvailable() {
    if (disposed || !latestSettings?.enabled || !resolvedDocument?.documentElement) {
      return;
    }
    stopWaitingForRoot();
    applyNormalizedSettings(latestSettings);
  }

  function waitForRoot() {
    if (disposed || rootWaitBound || !resolvedDocument) {
      return;
    }
    rootWaitBound = true;
    resolvedDocument.addEventListener('DOMContentLoaded', handleRootAvailable);

    const MutationObserverConstructor =
      resolvedDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (MutationObserverConstructor) {
      rootObserver = new MutationObserverConstructor(handleRootAvailable);
      rootObserver.observe(resolvedDocument, { childList: true });
    }
  }

  /**
   * Every main the page has, and inside each transcript main every table that holds a row
   * textarea. The pass is bounded by the mains and tables that exist — a dashboard has a
   * handful — and never by the rows, which is what the `:has()` gate this replaces had to
   * walk on every recalc.
   */
  function collectScopeTargets(): Map<HTMLElement, string> {
    const targets = new Map<HTMLElement, string>();
    const searchRoot = resolvedDocument?.body ?? resolvedDocument?.documentElement ?? null;
    if (!searchRoot || typeof searchRoot.querySelectorAll !== 'function') {
      return targets;
    }

    const mains = searchRoot.querySelectorAll<HTMLElement>(TRANSCRIPT_MAIN_SELECTOR);
    for (let index = 0; index < mains.length; index += 1) {
      const main = mains[index];
      if (!main.querySelector(BABEL_ROW_TEXTAREA_SELECTOR)) {
        continue;
      }
      if (!targets.has(main)) {
        targets.set(main, TRANSCRIPT_SCOPE_VALUE);
      }
      const tables = main.querySelectorAll<HTMLElement>(TRANSCRIPT_TABLE_SELECTOR);
      for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
        const table = tables[tableIndex];
        if (targets.has(table) || !table.querySelector(TRANSCRIPT_TABLE_TEXTAREA_SELECTOR)) {
          continue;
        }
        targets.set(table, TRANSCRIPT_TABLE_SCOPE_VALUE);
      }
    }
    return targets;
  }

  /**
   * Reconciles the marks against the live DOM: a mark the transcript no longer wants is
   * restored to the value the page had, and a mark that is missing, wrong, or was
   * overwritten from outside is rewritten. A transcript that has not moved costs reads
   * only, so a route change that mounts the same shape writes nothing.
   */
  function syncScopeStamps() {
    const targets = collectScopeTargets();
    for (const [element, owned] of scopeStamps) {
      if (targets.get(element) === owned.written[SCOPE_ATTRIBUTE]) {
        continue;
      }
      restoreOwnedAttribute(owned, SCOPE_ATTRIBUTE);
      scopeStamps.delete(element);
    }
    for (const [element, value] of targets) {
      let owned = scopeStamps.get(element);
      if (!owned) {
        owned = { element, original: {}, written: {} };
        scopeStamps.set(element, owned);
      }
      writeOwnedAttribute(owned, SCOPE_ATTRIBUTE, value);
    }
  }

  function restoreScopeStamps() {
    if (!scopeStamps.size) {
      return;
    }
    for (const owned of scopeStamps.values()) {
      restoreOwnedAttribute(owned, SCOPE_ATTRIBUTE);
    }
    scopeStamps.clear();
  }

  function cancelScopeSync() {
    if (!scopeSyncTimer) {
      return;
    }
    const view = resolvedDocument?.defaultView;
    if (view && typeof view.clearTimeout === 'function') {
      view.clearTimeout(scopeSyncTimer);
    } else {
      clearTimeout(scopeSyncTimer);
    }
    scopeSyncTimer = 0;
  }

  /** One pass per burst: a route change is hundreds of mutations and one reconciliation. */
  function scheduleScopeSync() {
    if (disposed || scopeSyncTimer || !scopeObserver) {
      return;
    }
    const run = () => {
      scopeSyncTimer = 0;
      if (disposed || !scopeObserver) {
        return;
      }
      syncScopeStamps();
    };
    const view = resolvedDocument?.defaultView;
    scopeSyncTimer =
      view && typeof view.setTimeout === 'function'
        ? view.setTimeout(run, SCOPE_SYNC_DELAY_MS)
        : setTimeout(run, SCOPE_SYNC_DELAY_MS);
  }

  function containsElement(nodes: NodeList): boolean {
    for (let index = 0; index < nodes.length; index += 1) {
      if (nodes[index].nodeType === 1) {
        return true;
      }
    }
    return false;
  }

  function scopeMutationsMatter(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        // A stamp of ours coming back through the observer has nothing to reconcile;
        // anyone else's hand on the attribute does.
        const target = mutation.target as HTMLElement;
        const owned = scopeStamps.get(target);
        if (
          owned &&
          target.getAttribute(SCOPE_ATTRIBUTE) === owned.written[SCOPE_ATTRIBUTE]
        ) {
          continue;
        }
        return true;
      }
      // The transcript only ever arrives and leaves as elements, so the text churn of
      // typing in a row must not cost a pass.
      if (containsElement(mutation.addedNodes) || containsElement(mutation.removedNodes)) {
        return true;
      }
    }
    return false;
  }

  function startScopeObserver() {
    if (disposed || scopeObserver || !resolvedDocument) {
      return;
    }
    const MutationObserverConstructor =
      resolvedDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    const target = resolvedDocument.body ?? resolvedDocument.documentElement;
    if (!MutationObserverConstructor || !target) {
      return;
    }
    const observer = new MutationObserverConstructor((mutations) => {
      if (scopeMutationsMatter(mutations)) {
        scheduleScopeSync();
      }
    });
    scopeObserver = observer;
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [SCOPE_ATTRIBUTE]
    });
  }

  function stopScopeObserver() {
    cancelScopeSync();
    scopeObserver?.disconnect();
    scopeObserver = null;
  }

  // A live observer is the whole apply-time check: while it is attached nothing can move
  // the transcript without scheduling its own pass, so a palette drag never touches the
  // DOM to find out that the marks are still right. Without a MutationObserver there is
  // nothing to trust, so the pass runs per apply rather than on a timer.
  function ensureTranscriptScope() {
    if (scopeObserver) {
      return;
    }
    startScopeObserver();
    syncScopeStamps();
  }

  function applyNormalizedSettings(settings: WebsiteAppearanceSettings) {
    syncWaveformTheme(settings);

    if (!settings.enabled) {
      stopWaitingForRoot();
      stopScopeObserver();
      restoreScopeStamps();
      restoreRootState();
      removeOwnedCustomStyle();
      return;
    }

    const root = resolvedDocument?.documentElement;
    if (!root) {
      stopScopeObserver();
      restoreScopeStamps();
      restoreRootState();
      removeOwnedCustomStyle();
      waitForRoot();
      return;
    }
    stopWaitingForRoot();
    ensureTranscriptScope();

    const state = prepareRoot(root);
    const desired = computeDesiredState(settings);
    for (const attribute of CONTROLLED_ATTRIBUTES) {
      const value = desired.attributes[attribute];
      if (value === undefined) {
        restoreOwnedAttribute(state.attributes, attribute);
      } else {
        writeOwnedAttribute(state.attributes, attribute, value);
      }
    }
    for (const variable of CONTROLLED_VARIABLES) {
      const value = desired.variables[variable];
      if (value === undefined) {
        restoreVariable(state, variable);
      } else {
        writeVariable(state, variable, value);
      }
    }

    // Validation is a character scan of the whole sheet and its verdict is a pure function
    // of the text, so a palette drag re-uses the answer the CSS field already earned.
    if (settings.customCss !== validatedCustomCss) {
      validatedCustomCss = settings.customCss;
      validatedCustomCssValid = validateWebsiteCustomCss(settings.customCss).valid;
    }
    if (settings.customCssEnabled && validatedCustomCssValid) {
      applyCustomStyle(settings.customCss);
    } else {
      removeOwnedCustomStyle();
    }
  }

  function apply(input: WebsiteAppearanceSettings) {
    if (disposed) {
      return;
    }
    latestSettings = normalizeWebsiteAppearanceSettings(input);
    applyNormalizedSettings(latestSettings);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    const finalSettings = latestSettings;
    latestSettings = null;
    stopWaitingForRoot();
    stopScopeObserver();
    restoreScopeStamps();
    restoreRootState();
    removeOwnedCustomStyle();
    removeWaveformBridgeScript();
    if (finalSettings) {
      dispatchWaveformConfig(finalSettings, false);
    }
    waveformBridgeReady = false;
  }

  return { apply, dispose };
}
