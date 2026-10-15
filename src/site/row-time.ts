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


  let rowTimeCache = {
    signature: '',
    rows: [],
    entries: []
  };


  function getRowTimeSignature(rows) {
    return rows.map((row) => {
      const identity = helper.getRowIdentity(row);
      return JSON.stringify([
        identity?.reviewActionId,
        identity?.annotationId,
        identity?.speakerKey,
        identity?.startSeconds,
        identity?.endSeconds,
        identity?.startText,
        identity?.endText
      ]);
    }).join('|');
  }


  function getRowTimeEntries() {
    const rows = helper.getTranscriptRows();
    const signature = getRowTimeSignature(rows);
    if (rowTimeCache.signature === signature &&
        rows.length === rowTimeCache.rows.length &&
        rows.every((row, index) => row === rowTimeCache.rows[index])) {
      helper.perf?.count?.('row-cache.hit');
      return rowTimeCache.entries;
    }

    helper.perf?.count?.('row-cache.rebuild');
    const entries = [];
    for (const row of rows) {
      const range = getRowTimeRange(row);
      if (range) {
        entries.push({
          row,
          identity: helper.getRowIdentity(row),
          ...range
        });
      }
    }
    entries.sort((left, right) => left.startSeconds - right.startSeconds);
    rowTimeCache = { signature, rows: rows.slice(), entries };
    return entries;
  }


  function resolveRowTimeEntry(entry) {
    if (!entry) {
      return null;
    }

    const row = resolveConnectedRow(entry.row, entry.identity);
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    return {
      ...entry,
      row
    };
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

    return getRowSpeakerKeySafe(entry.row) === settings.speakerKey;
  }


  function findRowEntryByPlaybackTime(playbackTime, options, entries = null) {
    if (typeof playbackTime !== 'number' || !Number.isFinite(playbackTime)) {
      return null;
    }

    // Every lookup starts from current row identities/times, unless its caller
    // already collected them for this synchronous frame. A valid gap is not
    // evidence of a stale cache and must not trigger another collection.
    entries ??= getRowTimeEntries();
    const previousRow = getLastPlaybackRow(entries);
    let first = null;
    for (const entry of entries) {
      if (playbackTime < entry.startSeconds) break;
      if (playbackTime >= entry.endSeconds || !entryMatchesPlaybackOptions(entry, options)) continue;
      if (entry.row === previousRow) {
        helper.perf?.count?.('row-cache.previous-hit');
        return entry;
      }
      first ??= entry;
    }
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

    entries ??= getRowTimeEntries();
    let latest = null;
    for (const entry of entries) {
      if (entry.startSeconds > playbackTime) {
        break;
      }
      if (!entryMatchesPlaybackOptions(entry, options)) {
        continue;
      }
      if (!latest || entry.endSeconds >= latest.endSeconds) {
        latest = entry;
      }
    }

    return latest;
  }


  function hasRowsForSpeakerKey(speakerKey, entries = null) {
    if (!speakerKey) {
      return false;
    }

    return (entries ?? getRowTimeEntries()).some((entry) => getRowSpeakerKeySafe(entry.row) === speakerKey);
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
      const row = helper.state.lastPlaybackRow;
      const identity = helper.state.lastPlaybackRowIdentity;
      const previous = entries.find((entry) =>
        entry.row === row && (!identity || helper.rowMatchesIdentity(row, identity)));
      if (previous) return previous.row;
      if (!identity) return null;
      const sameAnnotation = identity.annotationId && entries.find((entry) =>
        entry.identity?.annotationId === identity.annotationId &&
        helper.rowMatchesIdentity(entry.row, identity));
      return (sameAnnotation || entries.find((entry) => helper.rowMatchesIdentity(entry.row, identity)))?.row || null;
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
    rowTimeCache = { signature: '', rows: [], entries: [] };
  };

  return { getRowSpeakerKeySafe, getRowTimeRange, getRowTimeEntries, resolveRowTimeEntry, resolveConnectedRow, hasRowsForSpeakerKey, findRowEntryByPlaybackTime, findLatestRowEntryBeforePlaybackTime, getLastPlaybackRow, parseSegmentTimeValue, rememberPlaybackRow, findRowByPlaybackTime };
}
