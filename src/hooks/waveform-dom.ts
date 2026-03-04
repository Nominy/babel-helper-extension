export function getRegionPartTokens(element: Element | null) {
  const part = element instanceof Element ? element.getAttribute('part') || '' : '';
  return part ? part.split(/\s+/).filter(Boolean) : [];
}

export function isRegionHandle(element: HTMLElement | null) {
  const tokens = getRegionPartTokens(element);
  return (
    tokens.includes('region-handle') ||
    tokens.includes('region-handle-left') ||
    tokens.includes('region-handle-right')
  );
}

export function isRegionBody(element: HTMLElement | null) {
  const tokens = getRegionPartTokens(element);
  return tokens.includes('region');
}
