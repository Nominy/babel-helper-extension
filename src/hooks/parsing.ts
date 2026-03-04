export function parseTimeValue(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  const timestampMatch = normalized.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
  if (timestampMatch) {
    const parts = timestampMatch[0].split(':');
    let total = 0;
    for (const part of parts) {
      const numeric = Number(part);
      if (!Number.isFinite(numeric)) {
        return null;
      }
      total = total * 60 + numeric;
    }
    return total;
  }

  const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!numericMatch) {
    return null;
  }

  const numeric = Number(numericMatch[0]);
  return Number.isFinite(numeric) ? numeric : null;
}
