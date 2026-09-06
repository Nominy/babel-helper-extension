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

  let total = 0;
  let foundUnit = false;
  const unitPattern = /(-?\d+(?:\.\d+)?)\s*([hms])/g;
  for (const match of normalized.matchAll(unitPattern)) {
    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) {
      return null;
    }

    foundUnit = true;
    const unit = match[2];
    if (unit === 'h') {
      total += numeric * 3600;
    } else if (unit === 'm') {
      total += numeric * 60;
    } else {
      total += numeric;
    }
  }

  if (foundUnit) {
    return total;
  }

  const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!numericMatch) {
    return null;
  }

  const numeric = Number(numericMatch[0]);
  return Number.isFinite(numeric) ? numeric : null;
}
