import { themeRoot, applyComponent } from '@nominy/babel-extension-frontend';

const dismissedFailures = new Set<string>();

/** A failed native hook stops its automation; never hide it behind polling. */
export function showNativeAutomationFailure(feature: string, reason: string): void {
  const id = `babel-helper-native-failure-${feature.replace(/[^a-z0-9-]/gi, '-')}`;
  if (dismissedFailures.has(id) || document.getElementById(id)) return;
  const root = document.createElement('div');
  root.id = id;
  themeRoot(root, 'white');
  applyComponent(root, 'toast');
  root.setAttribute('role', 'alert');
  root.dataset.tone = 'danger';
  Object.assign(root.style, { position: 'fixed', right: '18px', bottom: '18px', maxWidth: '380px', padding: '14px' });
  const title = document.createElement('div');
  applyComponent(title, 'title');
  title.textContent = `${feature} automation stopped`;
  const detail = document.createElement('p');
  detail.textContent = `${reason}. Helper will not retry or switch to polling. Save your work before reloading Babel. If this persists, update Helper or report this message.`;
  const reload = document.createElement('button');
  reload.type = 'button';
  applyComponent(reload, 'button');
  reload.textContent = 'Reload Babel';
  reload.addEventListener('click', () => window.location.reload());
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  applyComponent(dismiss, 'button');
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', `Dismiss ${feature} notification`);
  dismiss.addEventListener('click', () => {
    dismissedFailures.add(id);
    root.remove();
  });
  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', gap: '8px' });
  actions.append(reload, dismiss);
  root.append(title, detail, actions);
  (document.body || document.documentElement).appendChild(root);
}
