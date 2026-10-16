// @ts-nocheck

export function createRowTimeApi(helper: any) {
  helper.getRowTimeRange = getRowTimeRange;

  function parseSegmentTimeValue(value) {
    if (typeof value !== 'string') { return null; }
    const trimmed = value.trim();
    if (!trimmed) { return null; }
    const match = trimmed.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
    if (!match) { return null; }
    const parts = match[0].split(':');
    let total = 0;
    for (const part of parts) {
      const numeric = Number(part);
      if (!Number.isFinite(numeric)) { return null; }
      total = total * 60 + numeric;
    }
    return total;
  }


  function getRowTimeRange(row) {
    if (!(row instanceof HTMLElement)) { return null; }
    const identity = helper.getRowIdentity(row);
    if (!identity) { return null; }
    const startSeconds = Number.isFinite(identity.startSeconds)
      ? identity.startSeconds
      : parseSegmentTimeValue(identity.startText);
    const endSeconds = Number.isFinite(identity.endSeconds)
      ? identity.endSeconds
      : parseSegmentTimeValue(identity.endText);
    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
      return null;
    }
    return { startSeconds, endSeconds };
  }


  let rowTimeCache = null;
  const indexes = new WeakMap();
  const emptyEntries = [];

  function indexEntries(entries) {
    const known = indexes.get(entries);
    if (known) return known;
    const byRow = new Map(), byAnnotation = new Map(), lanes = new Map();
    let size = 1;
    while (size < entries.length) size *= 2;
    const maximumEnd = new Float64Array(size * 2);
    maximumEnd.fill(-Infinity);
    const latest = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      byRow.set(entry.row, entry);
      if (entry.identity?.annotationId) byAnnotation.set(entry.identity.annotationId, entry);
      const speakerKey = entry.identity?.speakerKey || '';
      let lane = lanes.get(speakerKey);
      if (!lane) lanes.set(speakerKey, lane = []);
      lane.push(entry);
      maximumEnd[size + index] = entry.endSeconds;
      const previous = latest[index - 1];
      latest.push(!previous || entry.endSeconds >= previous.endSeconds ? entry : previous);
    }
    for (let index = size - 1; index > 0; index--) {
      maximumEnd[index] = Math.max(maximumEnd[index * 2], maximumEnd[index * 2 + 1]);
    }
    const result = { entries, byRow, byAnnotation, lanes, maximumEnd, size, latest };
    indexes.set(entries, result);
    return result;
  }

  function getRowTimeEntries() {
    const revision = helper.getRowIndexRevision?.() ?? 0;
    if (rowTimeCache?.revision === revision) {
      helper.perf?.count?.('row-cache.hit');
      return rowTimeCache.entries;
    }
    helper.perf?.count?.('row-cache.rebuild');
    const entries = [];
    for (const row of helper.getTranscriptRows()) {
      const identity = helper.getRowIdentity(row);
      if (!identity) continue;
      const startSeconds = Number.isFinite(identity.startSeconds) ? identity.startSeconds : parseSegmentTimeValue(identity.startText);
      const endSeconds = Number.isFinite(identity.endSeconds) ? identity.endSeconds : parseSegmentTimeValue(identity.endText);
      if (startSeconds !== null && endSeconds !== null && endSeconds > startSeconds) {
        entries.push({ row, identity, startSeconds, endSeconds });
      }
    }
    entries.sort((left, right) => left.startSeconds - right.startSeconds);
    rowTimeCache = { revision: helper.getRowIndexRevision?.() ?? revision, entries };
    indexEntries(entries);
    return entries;
  }

  function getRowTimeEntry(row, identity = null, entries = null) {
    const index = indexEntries(entries ?? getRowTimeEntries());
    const matches = entry => entry && entry.row.isConnected &&
      (!identity?.reviewActionId || entry.identity?.reviewActionId === identity.reviewActionId) &&
      (!identity?.annotationId || entry.identity?.annotationId === identity.annotationId);
    const direct = index.byRow.get(row);
    if (matches(direct)) return direct;
    const remounted = identity?.annotationId ? index.byAnnotation.get(identity.annotationId) : null;
    return matches(remounted) ? remounted : null;
  }

  function upperBound(entries, time) {
    let low = 0, high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].startSeconds <= time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function laneIndex(entries, speakerKey) {
    const index = indexEntries(entries);
    return speakerKey ? indexEntries(index.lanes.get(speakerKey) || emptyEntries) : index;
  }

  function firstContaining(index, time, end, node = 1, low = 0, high = index.size) {
    if (low >= end || index.maximumEnd[node] <= time) return null;
    if (high - low === 1) return index.entries[low] || null;
    const middle = (low + high) >>> 1;
    return firstContaining(index, time, end, node * 2, low, middle) ||
      firstContaining(index, time, end, node * 2 + 1, middle, high);
  }


  function resolveRowTimeEntry(entry) {
    if (!entry) {
      return null;
    }

    return getRowTimeEntry(entry.row, entry.identity);
  }


  function getRowSpeakerKeySafe(row) {
    if (!(row instanceof HTMLElement)) {
      return '';
    }

    if (typeof helper.getRowSpeakerKey === 'function') {
      return helper.getRowSpeakerKey(row) || '';
    }

    const identity = helper.getRowIdentity(row);
    return identity && typeof identity.speakerKey === 'string' ? identity.speakerKey : '';
  }


  function entryMatchesPlaybackOptions(entry, options) {
    const settings = options || {};
    if (!settings.speakerKey) {
      return true;
    }

    return entry.identity?.speakerKey === settings.speakerKey;
  }


  function findRowEntryByPlaybackTime(playbackTime, options, entries = null) {
    if (typeof playbackTime !== 'number' || !Number.isFinite(playbackTime)) {
      return null;
    }

    entries ??= getRowTimeEntries();
    const previous = getRowTimeEntry(helper.state.lastPlaybackRow, helper.state.lastPlaybackRowIdentity, entries);
    if (previous && playbackTime >= previous.startSeconds && playbackTime < previous.endSeconds &&
        entryMatchesPlaybackOptions(previous, options)) {
      helper.perf?.count?.('row-cache.previous-hit');
      return previous;
    }
    const index = laneIndex(entries, options?.speakerKey);
    const first = firstContaining(index, playbackTime, upperBound(index.entries, playbackTime));
    helper.perf?.count?.(first
      ? (options?.speakerKey ? 'row-cache.lane-hit' : 'row-cache.search-hit')
      : 'row-cache.miss');
    return first;
  }


  /**
   * Find the transcript row whose time range contains the given playback time.
   * Returns the first matching row, or null if none match.
   */
  function findRowByPlaybackTime(playbackTime) {
    const entry = findRowEntryByPlaybackTime(playbackTime);
    return entry ? entry.row : null;
  }


  function findLatestRowEntryBeforePlaybackTime(playbackTime, options, entries = null) {
    if (typeof playbackTime !== 'number' || !Number.isFinite(playbackTime)) {
      return null;
    }

    const index = laneIndex(entries ?? getRowTimeEntries(), options?.speakerKey);
    return index.latest[upperBound(index.entries, playbackTime) - 1] || null;
  }


  function hasRowsForSpeakerKey(speakerKey, entries = null) {
    if (!speakerKey) {
      return false;
    }

    return indexEntries(entries ?? getRowTimeEntries()).lanes.has(speakerKey);
  }


  function resolveConnectedRow(row, identity) {
    if (row instanceof HTMLElement && row.isConnected) {
      if (!identity || helper.rowMatchesIdentity(row, identity)) {
        return row;
      }
    }

    if (identity) {
      return helper.findRowByIdentity(identity);
    }

    return null;
  }


  function getLastPlaybackRow(entries = null) {
    if (entries) {
      return getRowTimeEntry(helper.state.lastPlaybackRow, helper.state.lastPlaybackRowIdentity, entries)?.row || null;
    }
    return resolveConnectedRow(
      helper.state.lastPlaybackRow,
      helper.state.lastPlaybackRowIdentity
    );
  }


  function rememberPlaybackRow(row) {
    if (row instanceof HTMLElement && row.isConnected) {
      helper.state.lastPlaybackRow = row;
      helper.state.lastPlaybackRowIdentity = helper.getRowIdentity(row);
      return row;
    }

    helper.state.lastPlaybackRow = null;
    helper.state.lastPlaybackRowIdentity = null;
    return null;
  }


  helper.invalidateRowTimeCache = function invalidateRowTimeCache() {
    rowTimeCache = null;
  };

  return { getRowSpeakerKeySafe, getRowTimeRange, getRowTimeEntries, getRowTimeEntry, resolveRowTimeEntry, resolveConnectedRow, hasRowsForSpeakerKey, findRowEntryByPlaybackTime, findLatestRowEntryBeforePlaybackTime, getLastPlaybackRow, parseSegmentTimeValue, rememberPlaybackRow, findRowByPlaybackTime };
}
