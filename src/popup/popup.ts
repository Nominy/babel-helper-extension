import { applyComponent, ensureUiStyles } from '@nominy/babel-extension-frontend';
import {
  REPLACEMENT_MESSAGE_TYPE,
  REPLACEMENT_RULES_STORAGE_KEY,
  compileReplacementRule,
  parseReplacementRules,
  type ReplacementRule,
  type ReplacementStatus,
  type ReplacementResult
} from '../core/replacement-rules';
import './popup.css';

declare const chrome: {
  runtime: { openOptionsPage(): Promise<void> };
  storage: { local: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  } };
  tabs: {
    query(query: { active: true; currentWindow: true }): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, message: {
      type: string;
      operation: 'status' | 'run' | 'recover';
      sessionId?: string;
      rules?: ReplacementRule[];
    }): Promise<unknown>;
  };
};

function element<T extends HTMLElement>(id: string, kind: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof kind)) throw new Error(`Missing popup element: ${id}`);
  return value;
}

const settingsLink = element('settings', HTMLAnchorElement);
const taskStatus = element('task-status', HTMLParagraphElement);
const result = element('result', HTMLParagraphElement);
const errorStatus = element('error', HTMLParagraphElement);
const storageError = element('storage-error', HTMLParagraphElement);
const runAll = element('run-all', HTMLButtonElement);
const recover = element('recover', HTMLButtonElement);
const refreshTask = element('refresh-task', HTMLButtonElement);
const addRule = element('add-rule', HTMLButtonElement);
const reloadRules = element('reload-rules', HTMLButtonElement);
const emptyRules = element('empty-rules', HTMLParagraphElement);
const ruleList = element('rules', HTMLOListElement);
const editor = element('rule-editor', HTMLFormElement);
const editorHeading = element('editor-heading', HTMLHeadingElement);
const editorFields = element('editor-fields', HTMLFieldSetElement);
const findInput = element('find', HTMLTextAreaElement);
const replaceInput = element('replace', HTMLTextAreaElement);
const regexInput = element('regex', HTMLInputElement);
const caseInput = element('case-sensitive', HTMLInputElement);
const wordInput = element('whole-word', HTMLInputElement);
const enabledInput = element('enabled', HTMLInputElement);
const cancelEdit = element('cancel-edit', HTMLButtonElement);

let rules: ReplacementRule[] = [];
let storageReady = false;
let busy = true;
let tabId: number | null = null;
let nativeStatus: ReplacementStatus | null = null;
let editingId: string | null = null;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showMessage(target: HTMLElement, text: string): void {
  target.textContent = text;
  target.hidden = !text;
}

function parseStatus(value: unknown): ReplacementStatus {
  if (value && typeof value === 'object' && 'ok' in value && value.ok === false &&
      'error' in value && typeof value.error === 'string' && value.error) {
    throw new Error(value.error);
  }
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true ||
      !('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId ||
      !('segmentCount' in value) || typeof value.segmentCount !== 'number' ||
      !Number.isSafeInteger(value.segmentCount) || value.segmentCount < 0 ||
      !('canRecover' in value) || typeof value.canRecover !== 'boolean') {
    throw new Error('The native task returned an invalid status.');
  }
  return { ok: true, sessionId: value.sessionId, segmentCount: value.segmentCount, canRecover: value.canRecover };
}

function parseResult(value: unknown, sessionId: string): ReplacementResult {
  const status = parseStatus(value);
  if (status.sessionId !== sessionId) throw new Error('The native task changed. Refresh task status before continuing.');
  if (!value || typeof value !== 'object' ||
      !('count' in value) || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0 ||
      !('changedRows' in value) || typeof value.changedRows !== 'number' ||
      !Number.isSafeInteger(value.changedRows) || value.changedRows < 0 || value.changedRows > status.segmentCount) {
    throw new Error('The native task returned an invalid result.');
  }
  return { ...status, count: value.count, changedRows: value.changedRows };
}

function refreshControls(): void {
  const editing = !editor.hidden;
  addRule.disabled = busy || !storageReady || editing;
  reloadRules.disabled = busy || editing;
  runAll.disabled = busy || editing || !storageReady || !nativeStatus || !rules.some(rule => rule.enabled);
  recover.disabled = busy || editing || !nativeStatus?.canRecover;
  refreshTask.disabled = busy || tabId === null;
  editorFields.disabled = busy;
  ruleList.setAttribute('aria-busy', String(busy));
  renderRules();
}

async function perform(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  showMessage(errorStatus, '');
  refreshControls();
  try {
    await operation();
  } catch (error) {
    showMessage(errorStatus, message(error));
  } finally {
    busy = false;
    refreshControls();
  }
}

function rowButton(label: string, text: string, disabled: boolean, action: () => void): HTMLButtonElement {
  const button = applyComponent(document.createElement('button'), 'button', { size: 'sm' });
  button.type = 'button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', action);
  return button;
}

function renderRules(): void {
  ruleList.replaceChildren();
  emptyRules.hidden = !storageReady || rules.length !== 0;
  const locked = busy || !storageReady || !editor.hidden;
  for (const [index, rule] of rules.entries()) {
    const number = index + 1;
    const row = applyComponent(document.createElement('li'), 'card');
    const summary = document.createElement('p');
    summary.className = 'rule-summary';
    summary.textContent = `${number}. ${rule.find} → ${rule.replace || '(empty replacement)'}`;
    const flags = applyComponent(document.createElement('p'), 'hint');
    flags.textContent = [rule.regex ? 'Regex' : 'Literal', rule.caseSensitive ? 'Case-sensitive' : 'Ignore case',
      rule.wholeWord ? 'Unicode whole-word' : 'Any position'].join(' · ');
    const controls = document.createElement('div');
    controls.className = 'popup-actions';
    const enabledLabel = document.createElement('label');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled;
    enabled.disabled = locked;
    enabled.setAttribute('aria-label', `Enable rule ${number}`);
    enabled.addEventListener('change', () => {
      const checked = enabled.checked;
      void perform(() => saveRules(rules.map(item => item.id === rule.id ? { ...item, enabled: checked } : item)));
    });
    enabledLabel.append(enabled, ' Enabled');
    controls.append(enabledLabel,
      rowButton(`Run rule ${number}`, 'Run', locked || !nativeStatus || !rule.enabled,
        () => void perform(() => mutateNative('run', [rule]))),
      rowButton(`Edit rule ${number}`, 'Edit', locked, () => openEditor(rule)),
      rowButton(`Delete rule ${number}`, 'Delete', locked,
        () => void perform(() => saveRules(rules.filter(item => item.id !== rule.id)))),
      rowButton(`Move rule ${number} up`, 'Up', locked || index === 0,
        () => void perform(() => moveRule(index, -1))),
      rowButton(`Move rule ${number} down`, 'Down', locked || index === rules.length - 1,
        () => void perform(() => moveRule(index, 1))));
    row.append(summary, flags, controls);
    ruleList.append(row);
  }
}

async function loadRules(): Promise<void> {
  try {
    const saved = await chrome.storage.local.get(REPLACEMENT_RULES_STORAGE_KEY);
    const value = saved[REPLACEMENT_RULES_STORAGE_KEY];
    rules = value === undefined ? [] : parseReplacementRules(value);
    storageReady = true;
    showMessage(storageError, '');
  } catch (error) {
    storageReady = false;
    showMessage(storageError, `Saved rules could not be loaded: ${message(error)} Stored data was not changed. Fix the stored data or storage access, then reload saved rules.`);
  }
}

async function saveRules(next: ReplacementRule[]): Promise<void> {
  if (!storageReady) throw new Error('Load saved rules successfully before changing them.');
  const validated = parseReplacementRules(next);
  try {
    await chrome.storage.local.set({ [REPLACEMENT_RULES_STORAGE_KEY]: validated });
  } catch (error) {
    showMessage(storageError, `Rules were not saved: ${message(error)}`);
    throw new Error('Save failed. Your previous saved rules are unchanged; try saving again.');
  }
  rules = validated;
  showMessage(storageError, '');
  showMessage(result, 'Rules saved.');
}

async function moveRule(index: number, direction: -1 | 1): Promise<void> {
  const next = [...rules];
  [next[index], next[index + direction]] = [next[index + direction], next[index]];
  await saveRules(next);
}

function openEditor(rule?: ReplacementRule): void {
  if (busy || !storageReady) return;
  editingId = rule?.id ?? null;
  editorHeading.textContent = rule ? 'Edit rule' : 'Add rule';
  findInput.value = rule?.find ?? '';
  replaceInput.value = rule?.replace ?? '';
  regexInput.checked = rule?.regex ?? false;
  caseInput.checked = rule?.caseSensitive ?? false;
  wordInput.checked = rule?.wholeWord ?? false;
  enabledInput.checked = rule?.enabled ?? true;
  editor.hidden = false;
  showMessage(errorStatus, '');
  refreshControls();
  findInput.focus();
}

function closeEditor(): void {
  editor.hidden = true;
  editingId = null;
}

function showNativeStatus(status: ReplacementStatus): void {
  nativeStatus = status;
  taskStatus.textContent = `Native task ready: ${status.segmentCount} segments. Only enabled rules run.`;
  delete taskStatus.dataset.tone;
}

function nativeUnavailable(error: unknown): void {
  nativeStatus = null;
  taskStatus.textContent = `Native task unavailable: ${message(error)} Open an active Babel transcription task with Replacement Rules enabled, then refresh task status or reopen this menu. Saved rules can still be edited here.`;
  taskStatus.dataset.tone = 'danger';
}

async function readNativeStatus(): Promise<void> {
  nativeStatus = null;
  if (tabId === null) {
    nativeUnavailable(new Error('There is no active browser tab.'));
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: REPLACEMENT_MESSAGE_TYPE, operation: 'status' });
    showNativeStatus(parseStatus(response));
  } catch (error) {
    nativeUnavailable(error);
  }
}

async function captureNativeTask(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tabs[0]?.id;
    tabId = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null;
    await readNativeStatus();
  } catch (error) {
    nativeUnavailable(error);
  }
}

async function mutateNative(operation: 'run' | 'recover', selected?: ReplacementRule[]): Promise<void> {
  const status = nativeStatus;
  const target = tabId;
  if (!status || target === null) throw new Error('Refresh task status successfully before running or recovering.');
  if (operation === 'recover' && !status.canRecover) throw new Error('There is no run to recover in this native task.');
  const enabledRules = selected?.filter(rule => rule.enabled);
  if (operation === 'run' && !enabledRules?.length) throw new Error('Enable a saved rule before running it.');
  showMessage(result, '');
  try {
    const response = await chrome.tabs.sendMessage(target, {
      type: REPLACEMENT_MESSAGE_TYPE, operation, sessionId: status.sessionId,
      ...(operation === 'run' ? { rules: enabledRules } : {})
    });
    const updated = parseResult(response, status.sessionId);
    showNativeStatus(updated);
    showMessage(result, operation === 'run'
      ? `Run complete: ${updated.count} replacements; ${updated.changedRows} segments changed.`
      : `Recovery complete: ${updated.count} replacements recovered; ${updated.changedRows} segments restored.`);
  } catch (error) {
    nativeUnavailable(error);
    throw new Error(`${message(error)} The action was not retried. Refresh task status before another action.`);
  }
}

settingsLink.addEventListener('click', event => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage().catch(error => showMessage(errorStatus, `Settings could not open: ${message(error)}`));
});
addRule.addEventListener('click', () => openEditor());
cancelEdit.addEventListener('click', () => {
  closeEditor();
  refreshControls();
  addRule.focus();
});
reloadRules.addEventListener('click', () => void perform(loadRules));
refreshTask.addEventListener('click', () => void perform(readNativeStatus));
runAll.addEventListener('click', () => void perform(() => mutateNative('run', rules)));
recover.addEventListener('click', () => void perform(() => mutateNative('recover')));
editor.addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const rule: ReplacementRule = {
      id: editingId ?? crypto.randomUUID(), find: findInput.value, replace: replaceInput.value,
      regex: regexInput.checked, caseSensitive: caseInput.checked,
      wholeWord: wordInput.checked, enabled: enabledInput.checked
    };
    if (!rule.find) throw new Error('Find must not be empty.');
    compileReplacementRule(rule);
    await saveRules(editingId ? rules.map(item => item.id === editingId ? rule : item) : [...rules, rule]);
    closeEditor();
  });
});

ensureUiStyles();
refreshControls();
void Promise.all([loadRules(), captureNativeTask()]).finally(() => {
  busy = false;
  refreshControls();
});
