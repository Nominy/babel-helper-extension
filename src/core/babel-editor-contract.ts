export const BABEL_EDITOR_CONTRACT_VERSION = 'recovered-81835-2026-06-21';

export const BABEL_ROW_TEXTAREA_SELECTOR = 'textarea[placeholder="What was said…"]';

export const BABEL_TABLE_COLUMN_INDEX = {
  id: 0,
  speaker: 1,
  start: 2,
  end: 3,
  text: 4,
  linter: 5,
  actions: 6
} as const;

export const BABEL_ACTIVE_ROW_CLASS_TOKENS = [
  'bg-neutral-100',
  'ring-1',
  'ring-neutral-300'
] as const;

export const BABEL_ROW_ACTION_LABELS = {
  insertAbove: 'Add Segment Above',
  insertBelow: 'Add Segment Below',
  mergePrevious: 'Merge With Above',
  mergeNext: 'Merge With Below',
  deleteSegment: 'Delete'
} as const;

export type BabelRowActionName = keyof typeof BABEL_ROW_ACTION_LABELS;

export type BabelEditorRowSnapshot = {
  index: number;
  annotationId: string;
  processedRecordingId: string | null;
  speakerKey: string;
  speakerLabel: string;
  startText: string;
  endText: string;
  startSeconds: number | null;
  endSeconds: number | null;
  text: string;
  isActive: boolean;
};

export type BabelEditorTrackSnapshot = {
  id: string;
  label: string;
  collapsed: boolean | null;
};

export type BabelEditorPlaybackSnapshot = {
  currentTime: number | null;
  duration: number | null;
  paused: boolean | null;
  rate: number | null;
  source: string;
};

export type BabelEditorSnapshot = {
  contractVersion: typeof BABEL_EDITOR_CONTRACT_VERSION;
  capturedAt: number;
  routeKey: string;
  activeRowId: string | null;
  rows: BabelEditorRowSnapshot[];
  tracks: BabelEditorTrackSnapshot[];
  playback: BabelEditorPlaybackSnapshot;
};

export function normalizeBabelContractText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function parseBabelDisplayedTime(value: unknown): number | null {
  const text = normalizeBabelContractText(value);
  if (!text) {
    return null;
  }

  const parts = text.split(':');
  if (parts.length < 2) {
    return null;
  }

  let total = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] || '';
    const isLast = index === parts.length - 1;
    const match = isLast ? /^([0-5]\d)(?:\.(\d{1,3}))?$/.exec(part) : /^(\d{1,3})$/.exec(part);
    if (!match) {
      return null;
    }

    const whole = Number(match[1]);
    if (!Number.isFinite(whole)) {
      return null;
    }

    if (!isLast && index > 0 && whole > 59) {
      return null;
    }

    total = total * 60 + whole;
    if (isLast && match[2]) {
      total += Number(`0.${match[2]}`);
    }
  }

  return Number(total.toFixed(3));
}

export function getBabelRowActionLabel(actionName: string): string | null {
  return Object.prototype.hasOwnProperty.call(BABEL_ROW_ACTION_LABELS, actionName)
    ? BABEL_ROW_ACTION_LABELS[actionName as BabelRowActionName]
    : null;
}

export function getBabelRowActionNameForLabel(label: unknown): BabelRowActionName | null {
  const normalized = normalizeBabelContractText(label);
  for (const [actionName, actionLabel] of Object.entries(BABEL_ROW_ACTION_LABELS)) {
    if (normalized === actionLabel) {
      return actionName as BabelRowActionName;
    }
  }
  return null;
}

export function isBabelActiveRowClassList(classList: Iterable<string> | null | undefined): boolean {
  if (!classList) {
    return false;
  }

  const classes = new Set(Array.from(classList));
  return BABEL_ACTIVE_ROW_CLASS_TOKENS.every((token) => classes.has(token));
}
