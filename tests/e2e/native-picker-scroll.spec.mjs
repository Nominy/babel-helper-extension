import { test, expect } from '@nominy/babel-extension-e2e/test';
import { ready, editors, fillText, readText, textSelection } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });
export const featureScenarios = {
  nativeTagDropdownKeyboard: ['native mouse-selected picker keeps keyboard selection visible', 'native typed-tag picker keeps keyboard selection visible']
};

async function outsideScroll(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('*')];
    for (let index = 0; index < nodes.length; index++) {
      if (nodes[index].shadowRoot) nodes.push(...nodes[index].shadowRoot.querySelectorAll('*'));
    }
    return { page: [window.scrollX, window.scrollY], containers: nodes
      .filter(node => node instanceof HTMLElement && !node.closest('ul[role="list"]') &&
        (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth))
      .map(node => [node.scrollTop, node.scrollLeft]) };
  });
}

async function fullyInside(list, index) {
  return list.evaluate((element, index) => {
    const item = element.children.item(index);
    const bounds = element.getBoundingClientRect(), box = item.getBoundingClientRect();
    const top = bounds.top + element.clientTop;
    return box.top >= top - 1 && box.bottom <= top + element.clientHeight + 1;
  }, index);
}

for (const [index, mode] of ['mouse-selected', 'typed-tag'].entries()) {
  test(featureScenarios.nativeTagDropdownKeyboard[index], async ({ page, babel }, testInfo) => {
    await babel.setExtensionSettings('helper', { features: {
      audioEnhancement: false, quickRegionAutocomplete: false, nativeTagDropdownKeyboard: true
    } });
    await babel.reset('baseline');
    await ready(page);
    const editor = editors(page).first();
    if (mode === 'mouse-selected') {
      await fillText(editor, 'Тихая речь.');
      const points = await editor.evaluate(element => {
        const text = element.querySelector('[data-slate-string]').firstChild;
        const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5);
        const box = range.getBoundingClientRect();
        return { x: box.left + 0.5, end: box.right - 0.5, y: (box.top + box.bottom) / 2 };
      });
      await page.mouse.move(points.x, points.y);
      await page.mouse.down();
      await page.mouse.move(points.end, points.y, { steps: 6 });
      await page.mouse.up();
    } else {
      await fillText(editor, '');
      await page.keyboard.press('Shift+Comma');
    }
    const list = page.locator('section[data-annotation-id]').first().getByRole('list');
    await expect(list).toBeVisible();
    // Constrain only the genuine popup viewport, reproducing an overflowing menu.
    await list.evaluate(element => { element.style.maxHeight = '64px'; });
    const count = await list.getByRole('button').count();
    expect(count).toBeGreaterThan(2);
    const labels = await list.getByRole('button').last().locator('span').allTextContents();
    const tag = labels[0].trim();
    const foreignCode = labels[1]?.includes(' - ') ? labels[1].split(' - ')[0].trim() : null;
    const opening = foreignCode ? `<${tag}="${foreignCode}">` : `<${tag}>`;
    const before = await outsideScroll(page);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => fullyInside(list, count - 1)).toBe(true);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await outsideScroll(page)).toEqual(before);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => fullyInside(list, 0)).toBe(true);
    expect(await outsideScroll(page)).toEqual(before);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => fullyInside(list, count - 1)).toBe(true);
    if (mode === 'mouse-selected') await expect.poll(() => textSelection(editor)).toEqual([0, 5]);
    await page.screenshot({ path: testInfo.outputPath(`native-picker-${mode}-scroll.png`) });
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect.poll(() => readText(editor)).toContain(opening);
    if (mode === 'mouse-selected') {
      await expect.poll(() => readText(editor)).toBe(`${opening} Тихая </${tag}> речь.`);
      const end = `${opening} Тихая </${tag}>`.length;
      await expect.poll(() => textSelection(editor)).toEqual([end, end]);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => readText(editor)).toBe('Тихая речь.');
      await expect(editor).toBeFocused();
      // Native remove/insert-node history owns the restored selection; it need
      // not recreate the original mouse range. DOM and native caret must agree,
      // and the next typed character must land at that exact native selection.
      const restored = await editor.evaluate(element => {
        const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
        for (let fiber = element[key]; fiber; fiber = fiber.return) {
          const slate = fiber.memoizedProps?.editor;
          if (!slate?.selection || !Array.isArray(slate.children)) continue;
          const offset = point => slate.children[0].children.slice(0, point.path[1])
            .reduce((sum, node) => sum + (node.text ?? node.raw ?? '').length, 0) + point.offset;
          const anchor = offset(slate.selection.anchor), focus = offset(slate.selection.focus);
          return [Math.min(anchor, focus), Math.max(anchor, focus)];
        }
        throw new Error('Native Undo did not retain an editor selection');
      });
      await expect.poll(() => textSelection(editor)).toEqual(restored);
      await page.keyboard.insertText('!');
      await expect.poll(() => readText(editor))
        .toBe(`Тихая речь.`.slice(0, restored[0]) + '!' + `Тихая речь.`.slice(restored[1]));
      await expect.poll(() => textSelection(editor)).toEqual([restored[0] + 1, restored[0] + 1]);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => readText(editor)).toBe('Тихая речь.');
    }
  });
}
