// Geometry only: the inert measurement node never receives focus, input, or
// model ownership. The captured native textarea remains the sole text control.
const METRICS = ['boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'direction', 'tabSize',
  'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle'] as const;

function measure<T>(input: HTMLTextAreaElement, text: string, visit: (node: Text, root: HTMLDivElement,
  rect: DOMRect, origin: DOMRect) => T): T {
  const document = input.ownerDocument;
  const style = document.defaultView!.getComputedStyle(input);
  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  root.inert = true;
  Object.assign(root.style, { position: 'fixed', left: '0', top: '0', visibility: 'hidden',
    pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden',
    width: `${input.getBoundingClientRect().width}px`, height: 'auto', minHeight: '0', margin: '0' });
  for (const key of METRICS) root.style[key] = style[key];
  const node = document.createTextNode(text || '\u200b');
  root.appendChild(node);
  document.body.appendChild(root);
  try { return visit(node, root, input.getBoundingClientRect(), root.getBoundingClientRect()); }
  finally { root.remove(); }
}

export function classicTextRects(input: HTMLTextAreaElement, text: string, start: number, end = start): DOMRect[] {
  return measure(input, text, (node, root, rect, origin) => {
    const range = input.ownerDocument.createRange();
    const left = Math.max(0, Math.min(start, text.length));
    const right = Math.max(left, Math.min(end, text.length));
    range.setStart(node, left); range.setEnd(node, right);
    let rects = Array.from(range.getClientRects());
    if (!rects.length && left === right) {
      const marker = input.ownerDocument.createElement('span');
      marker.textContent = '\u200b';
      range.insertNode(marker);
      rects = [marker.getBoundingClientRect()];
    }
    return rects.map(box => new DOMRect(rect.left + box.left - origin.left - input.scrollLeft,
      rect.top + box.top - origin.top - input.scrollTop, box.width || 1, box.height));
  });
}

export function classicOffsetAtPoint(input: HTMLTextAreaElement, text: string, x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return measure(input, text, (node, root, rect, origin) => {
    // A textarea exposes no DOM text points. Walk native-layout line fragments,
    // retaining bidi visual positions rather than assuming monotonic x offsets.
    const range = input.ownerDocument.createRange();
    let nearest = 0, distance = Infinity;
    for (let offset = 0; offset <= text.length; offset++) {
      range.setStart(node, offset); range.collapse(true);
      const box = range.getClientRects()[0];
      if (!box) continue;
      const left = rect.left + box.left - origin.left - input.scrollLeft;
      const top = rect.top + box.top - origin.top - input.scrollTop;
      const dy = y < top ? top - y : y > top + box.height ? y - top - box.height : 0;
      const next = dy * dy * 100 + (x - left) ** 2;
      if (next < distance) { distance = next; nearest = offset; }
    }
    return nearest;
  });
}
