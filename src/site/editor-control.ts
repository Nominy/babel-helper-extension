import { BABEL_ROW_EDITOR_SELECTOR, BABEL_TRANSCRIPT_ROW_SELECTOR } from '../core/babel-editor-contract';

const REQUEST_EVENT = 'babel-helper:editor-control';
const RESULT_ATTRIBUTE = 'data-babel-helper-editor-result';
let requestId = 0;
const controls = new WeakMap<HTMLElement, { control: EditorControl; reviewActionId: string }>();
const EDITOR_CONTROL_BRAND = Symbol.for('babel-helper.native-editor-control');

export type NativeEditorState = {
  ok: boolean;
  annotationId?: string;
  reviewActionId?: string;
  processedRecordingId?: string | null;
  trackLabel?: string;
  startSeconds?: number | null;
  endSeconds?: number | null;
  isActive?: boolean;
  text: string;
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
  readOnly: boolean;
  rect?: { top: number; left: number; width: number; height: number; bottom: number; right: number };
};

export type NativeTurnIdentity = Omit<NativeEditorState, 'text' | 'start' | 'end' | 'direction' | 'rect'>;

export type NativeSessionState = {
  ok: boolean;
  reviewActionId: string;
  readOnly: boolean;
  routeKey: string;
};

function request<T = NativeEditorState>(row: HTMLElement, operation: string, payload: Record<string, unknown> = {}): T | null {
  if (!row.isConnected || (operation === 'session'
    ? row !== row.ownerDocument.documentElement
    : !row.matches(BABEL_TRANSCRIPT_ROW_SELECTOR))) return null;
  const id = `editor-control-${++requestId}`;
  row.removeAttribute(RESULT_ATTRIBUTE);
  row.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
    bubbles: true,
    detail: JSON.stringify({ id, annotationId: row.dataset.annotationId, operation, ...payload })
  }));
  const raw = row.getAttribute(RESULT_ATTRIBUTE);
  row.removeAttribute(RESULT_ATTRIBUTE);
  if (!raw) return null;
  const result = JSON.parse(raw);
  return result?.id === id && result.ok ? result : null;
}

export function readTurnState(row: HTMLElement): NativeEditorState | null {
  return request(row, 'read');
}

export function readTurnIdentity(row: HTMLElement): NativeTurnIdentity | null {
  return request<NativeTurnIdentity>(row, 'identity');
}

export function readNativeSessionState(documentRef: Document = document): NativeSessionState | null {
  const root = documentRef.documentElement;
  if (!(root instanceof HTMLElement)) return null;
  const state = request<NativeSessionState>(root, 'session');
  if (!state || typeof state.reviewActionId !== 'string' || !state.reviewActionId ||
      typeof state.readOnly !== 'boolean' ||
      state.routeKey !== `${documentRef.location?.pathname || ''}${documentRef.location?.search || ''}`) return null;
  const publishedTaskId = root.getAttribute('data-babel-review-action-id') || '';
  return !publishedTaskId || publishedTaskId === state.reviewActionId ? state : null;
}

export type EditorReplacementOptions = {
  start?: number;
  end?: number;
  direction?: string;
  focus?: boolean;
};

/** A turn identity and native operations, not an emulated DOM text input. */
export class EditorControl {
  readonly [EDITOR_CONTROL_BRAND] = true;
  private readonly annotationId: string;
  private readonly routeKey: string;
  private readonly reviewActionId: string;

  constructor(readonly row: HTMLElement, state: NativeTurnIdentity | null = readTurnIdentity(row)) {
    this.annotationId = row.dataset.annotationId || '';
    this.routeKey = row.ownerDocument.location?.href || '';
    this.reviewActionId = state?.reviewActionId || '';
  }

  get element(): HTMLElement | null {
    return this.isConnected ? this.row.querySelector<HTMLElement>(BABEL_ROW_EDITOR_SELECTOR) : null;
  }
  get isConnected(): boolean {
    return this.row.isConnected && this.row.dataset.annotationId === this.annotationId &&
      (this.row.ownerDocument.location?.href || '') === this.routeKey;
  }
  private invoke(operation: string, payload: Record<string, unknown> = {}) {
    return this.isConnected ? request(this.row, operation, { reviewActionId: this.reviewActionId, ...payload }) : null;
  }
  get state(): NativeEditorState | null { return this.invoke('read'); }
  get value(): string { return this.state?.text ?? ''; }
  get selectionStart(): number { return this.state?.start ?? 0; }
  get selectionEnd(): number { return this.state?.end ?? 0; }
  get selectionDirection(): 'forward' | 'backward' | 'none' { return this.state?.direction ?? 'none'; }
  get readOnly(): boolean { return this.state?.readOnly !== false; }

  focus(options: FocusOptions & { activateRow?: boolean } = {}): boolean {
    return Boolean(this.invoke('focus', options as Record<string, unknown>));
  }
  blur(): void {
    this.element?.blur();
  }
  replaceValue(text: string, options: EditorReplacementOptions = {}): boolean {
    return Boolean(this.invoke('replace', { text, ...options }));
  }
  setSelectionRange(start: number, end = start, direction = 'none'): boolean {
    return Boolean(this.invoke('select', { start, end, direction }));
  }
  selectAll(): boolean {
    return Boolean(this.invoke('select', { selectAll: true }));
  }
  pageSelection(direction: 'up' | 'down', extend: boolean): boolean {
    return Boolean(this.invoke('pageSelection', { direction, extend }));
  }
  synchronizeSelection(source: 'input' | 'selectionchange' | 'intent' = 'input'): boolean {
    return Boolean(this.invoke('syncSelection', { source }));
  }
  getCaretRect(offset: number): DOMRect | null {
    const rect = this.invoke('caretRect', { start: offset })?.rect;
    return rect ? new DOMRect(rect.left, rect.top, rect.width, rect.height) : null;
  }
  getOffsetAtPoint(x: number, y: number): number | null {
    return this.invoke('offsetAtPoint', { x, y })?.start ?? null;
  }
}

/** Entry, lazy-session and MAIN bundles each own a class constructor. */
export function isEditorControl(value: unknown): value is EditorControl {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EditorControl>;
  return candidate[EDITOR_CONTROL_BRAND] === true &&
    typeof candidate.replaceValue === 'function' &&
    typeof candidate.setSelectionRange === 'function' &&
    typeof candidate.selectAll === 'function' &&
    typeof candidate.synchronizeSelection === 'function';
}

export function getEditorControl(row: HTMLElement): EditorControl | null {
  if (!row?.matches(BABEL_TRANSCRIPT_ROW_SELECTOR) || !row.querySelector(BABEL_ROW_EDITOR_SELECTOR)) return null;
  const state = readTurnIdentity(row);
  if (!state || state.readOnly) return null;
  const cached = controls.get(row);
  if (cached?.control.isConnected && cached.reviewActionId === state.reviewActionId) return cached.control;
  const control = new EditorControl(row, state);
  controls.set(row, { control, reviewActionId: state.reviewActionId || '' });
  return control;
}

export function getEditorControlFromTarget(target: EventTarget | null): EditorControl | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest(BABEL_ROW_EDITOR_SELECTOR);
  const row = element?.closest<HTMLElement>(BABEL_TRANSCRIPT_ROW_SELECTOR);
  return row ? getEditorControl(row) : null;
}
