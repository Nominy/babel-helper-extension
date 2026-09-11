export type ShortcutModifier = 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey';
export interface ShortcutBinding {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  rightShift?: boolean;
  /** Original bindings sometimes accepted extra modifiers or matched logical keys. */
  ignoreModifiers?: ShortcutModifier[];
  key?: string;
}
export type ShortcutSettings = Record<string, ShortcutBinding[] | null>;
const MODIFIERS: ShortcutModifier[] = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'];
function binding(code: string, modifiers: Partial<ShortcutBinding> = {}): ShortcutBinding {
  return { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}
function action(id: string, label: string, code: string, modifiers: Partial<ShortcutBinding> = {}) {
  return { id, label, defaults: [binding(code, modifiers)] };
}
export const SHORTCUT_ACTIONS = [
  action('appearance.toggle', 'Toggle Website Appearance', 'KeyP', { altKey: true, shiftKey: true }),
  action('focus.toggle', 'Toggle editor focus workflow', 'Escape', { key: 'Escape', ignoreModifiers: MODIFIERS }),
  action('ghost.lane', 'Switch ghost cursor lane', 'Tab'),
  action('row.delete', 'Delete current segment', 'KeyD'),
  action('row.mergePrevious', 'Merge with previous segment', 'ArrowUp', { key: 'ArrowUp', altKey: true, shiftKey: true }),
  action('row.mergeNext', 'Merge with next segment', 'ArrowDown', { key: 'ArrowDown', altKey: true, shiftKey: true }),
  action('row.previous', 'Focus previous segment', 'ArrowLeft', { key: 'ArrowLeft', shiftKey: true, rightShift: true }),
  action('row.next', 'Focus next segment', 'ArrowRight', { key: 'ArrowRight', shiftKey: true, rightShift: true }),
  action('playback.rewind', 'Rewind playback one second', 'KeyX', { altKey: true }),
  action('playback.faster', 'Increase playback speed', 'Digit1', { shiftKey: true }),
  action('playback.slower', 'Decrease playback speed', 'Digit2', { shiftKey: true }),
  action('speaker.first', 'Switch to Speaker 1', 'Digit1', { altKey: true }),
  action('speaker.second', 'Switch to Speaker 2', 'Digit2', { altKey: true }),
  action('speaker.reset', 'Reset speaker lanes', 'Backquote', { altKey: true, ignoreModifiers: ['shiftKey'] }),
  action('text.previous', 'Move text to previous segment', 'BracketLeft', { altKey: true }),
  action('text.next', 'Move text to next segment', 'BracketRight', { altKey: true }),
  action('number.convert', 'Convert selected number to words', 'KeyA', { altKey: true, ignoreModifiers: ['ctrlKey'] }),
  action('lint.current', 'Fix lint in current segment', 'KeyF', { altKey: true }),
  action('lint.all', 'Fix lint in all segments', 'KeyF', { altKey: true, shiftKey: true }),
  action('warnings.acceptAll', 'Accept all linter warnings', 'KeyA', { altKey: true, shiftKey: true }),
  action('timeline.insert', 'Insert segment at caret', 'KeyC', { altKey: true }),
  action('timeline.autoSegment', 'Auto-segment visible silences', 'KeyS', { altKey: true, shiftKey: true }),
  action('timeline.transcribe', 'Transcribe current segment', 'KeyG', { altKey: true, shiftKey: true }),
  action('timeline.trimCurrent', 'Trim current segment to audio', 'KeyR', { altKey: true }),
  action('timeline.trimAll', 'Trim all segments to audio', 'KeyR', { altKey: true, shiftKey: true }),
  action('preview.cancel', 'Cancel timeline selection', 'Escape', { key: 'Escape', ignoreModifiers: MODIFIERS }),
  action('preview.commitLeft', 'Smart split timeline selection', 'KeyS'),
  action('preview.commit', 'Commit timeline selection', 'KeyS', { shiftKey: true }),
  action('preview.loop', 'Loop timeline selection', 'KeyL')
];
const MODIFIER_CODES = /^(?:Control|Alt|Shift|Meta)(?:Left|Right)$/;
const VALID_CODE = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Arrow(?:Left|Right|Up|Down)|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma)|Escape|Tab|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|IntlBackslash|IntlRo|IntlYen|Semicolon|Quote|Comma|Period|Slash|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|ContextMenu)$/;
const ACTIONS: Record<string, (typeof SHORTCUT_ACTIONS)[number]> = Object.fromEntries(SHORTCUT_ACTIONS.map(item => [item.id, item]));
export function normalizeShortcutSettings(source: unknown): ShortcutSettings {
  const result: ShortcutSettings = {};
  if (!source || typeof source !== 'object') return result;
  for (const { id } of SHORTCUT_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(source, id)) continue;
    const value = (source as Record<string, unknown>)[id];
    if (value === null || (Array.isArray(value) && value.length === 0)) {
      result[id] = null;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const normalized: ShortcutBinding[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || !VALID_CODE.test(raw.code) ||
          !MODIFIERS.every(modifier => typeof raw[modifier] === 'boolean')) continue;
      const next = binding(raw.code, Object.fromEntries(MODIFIERS.map(modifier => [modifier, raw[modifier]])));
      if (raw.rightShift === true && next.shiftKey) next.rightShift = true;
      if (typeof raw.key === 'string' && raw.key === raw.code) next.key = raw.key;
      if (Array.isArray(raw.ignoreModifiers)) {
        next.ignoreModifiers = MODIFIERS.filter(modifier => raw.ignoreModifiers.includes(modifier));
      }
      normalized.push(next);
    }
    // Corrupt records must not silently remove an existing shortcut.
    if (normalized.length === value.length) result[id] = normalized;
  }
  return result;
}

export function matchesShortcut(settings: ShortcutSettings | undefined, id: string, event: KeyboardEvent, rightShiftPressed = false): boolean {
  const bindings = settings && Object.prototype.hasOwnProperty.call(settings, id) ? settings[id] : ACTIONS[id]?.defaults;
  return Boolean(bindings?.some(item =>
    (item.key ? event.key === item.key : event.code === item.code) &&
    (!item.rightShift || rightShiftPressed) &&
    MODIFIERS.every(modifier => item.ignoreModifiers?.includes(modifier) || item[modifier] === Boolean(event[modifier]))
  ));
}

export function shortcutBindingFromEvent(event: KeyboardEvent): ShortcutBinding | null {
  if (event.isComposing || MODIFIER_CODES.test(event.code) || !VALID_CODE.test(event.code)) return null;
  return binding(event.code, { ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey });
}

export function formatShortcut(settings: ShortcutSettings | undefined, id: string): string {
  const bindings = settings && Object.prototype.hasOwnProperty.call(settings, id) ? settings[id] : ACTIONS[id]?.defaults;
  if (!bindings?.length) return 'Disabled';
  const names: Record<string, string> = { Backquote: '~', BracketLeft: '[', BracketRight: ']', Space: 'Space', Minus: '-', Equal: '=', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
  return bindings.map(item => [item.ctrlKey && 'Ctrl', item.altKey && 'Alt', item.shiftKey && (item.rightShift ? 'Right Shift' : 'Shift'), item.metaKey && 'Meta', names[item.code] || item.code.replace(/^(Key|Digit)/, '')].filter(Boolean).join(' + ')).join(' / ');
}
