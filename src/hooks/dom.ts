export function isEditable(element: unknown) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  return element.matches('textarea, input');
}

export function isVisible(element: unknown) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function normalizeText(element: unknown) {
  if (!(element instanceof HTMLElement)) {
    return '';
  }

  return element.innerText.replace(/\s+/g, ' ').trim();
}

export function setEditableValue(element: unknown, value: unknown) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const nextValue = typeof value === 'string' ? value : String(value ?? '');
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : null;

  if (typeof setter === 'function') {
    setter.call(element, nextValue);
  } else if ('value' in element) {
    (element as HTMLInputElement | HTMLTextAreaElement).value = nextValue;
  } else {
    return false;
  }

  element.dispatchEvent(
    typeof InputEvent === 'function'
      ? new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          data: null,
          inputType: 'insertText'
        })
      : new Event('input', {
          bubbles: true,
          cancelable: false
        })
  );

  return true;
}

export function dispatchClick(element: unknown) {
  if (!(element instanceof HTMLElement)) {
    return;
  }

  if (typeof PointerEvent === 'function') {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse'
      })
    );
  }

  element.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window
    })
  );
  element.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window
    })
  );
  element.click();
}

export function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export async function waitFor<T>(getValue: () => T | null, timeoutMs?: number, intervalMs?: number) {
  const timeout = timeoutMs || 800;
  const interval = intervalMs || 50;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeout) {
    const value = getValue();
    if (value) {
      return value;
    }

    await sleep(interval);
  }

  return null;
}

export function getReactInternalValue(element: unknown, prefix: string) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  for (const name of Object.getOwnPropertyNames(element)) {
    if (typeof name === 'string' && name.indexOf(prefix) === 0) {
      return (element as unknown as Record<string, unknown>)[name];
    }
  }

  return null;
}

export function getReactFiber(element: unknown) {
  return getReactInternalValue(element, '__reactFiber$');
}


