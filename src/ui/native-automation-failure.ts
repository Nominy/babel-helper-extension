import { themeRoot, applyComponent } from '@nominy/babel-extension-frontend';

/** A failed native hook stops its automation; never hide it behind polling. */
export function showNativeAutomationFailure(feature: string, reason: string): void {
  const id = `babel-helper-native-failure-${feature.replace(/[^a-z0-9-]/gi, '-')}`;
  if (document.getElementById(id)) return;
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
  root.append(title, detail, reload);
  (document.body || document.documentElement).appendChild(root);
}
