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


  function getRowTimeEntries(forceRebuild = false) {
    const rows = helper.getTranscriptRows();
    const signature = getRowTimeSignature(rows);
    if (!forceRebuild && rowTimeCache.signature === signature &&
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
    rowTimeCache = { signature, rows, entries };
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


  function getActiveRowEntriesByPlaybackTime(playbackTime, options, forceRebuild = false) {
    if (typeof playbackTime !== 'number' || !Number.isFinite(playbackTime)) {
      return [];
    }

    const entries = getRowTimeEntries(forceRebuild);
    const active = [];
    for (const entry of entries) {
      if (playbackTime < entry.startSeconds) {
        break;
      }
      if (playbackTime >= entry.endSeconds) {
        continue;
      }

      const resolved = resolveRowTimeEntry(entry);
      if (!resolved) {
        helper.perf?.count?.('row-cache.stale-hit');
        continue;
      }
      if (entryMatchesPlaybackOptions(resolved, options)) {
        active.push(resolved);
      }
    }

    return active;
  }


  function findRowEntryByPlaybackTime(playbackTime, options) {
    if (typeof playbackTime !== 'number' || !Number.isFinite(playbackTime)) {
      return null;
    }

    const settings = options || {};
    const lastRow = getLastPlaybackRow();
    const lastRange = getRowTimeRange(lastRow);
    if (
      lastRange &&
      playbackTime >= lastRange.startSeconds &&
      playbackTime < lastRange.endSeconds &&
      (!settings.speakerKey || getRowSpeakerKeySafe(lastRow) === settings.speakerKey)
    ) {
      helper.perf?.count?.('row-cache.previous-hit');
      return { row: lastRow, ...lastRange };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const active = getActiveRowEntriesByPlaybackTime(playbackTime, settings, attempt > 0);
      if (active.length) {
        helper.perf?.count?.(settings.speakerKey ? 'row-cache.lane-hit' : 'row-cache.search-hit');
        return active[0];
      }
    }
    helper.perf?.count?.('row-cache.miss');
    return null;
  }


  /**
   * Find the transcript row whose time range contains the given playback time.
   * Returns the first matching row, or null if none match.
   */
  function findRowByPlaybackTime(playbackTime) {
    const entry = findRowEntryByPlaybackTime(playbackTime);
    return entry ? entry.row : null;
  }


  function findLatestRowEntryBeforePlaybackTime(playbackTime, options) {
    if (typeof playbackTime !== 'number' || !Number.isFinite(playbackTime)) {
      return null;
    }

    const entries = getRowTimeEntries();
    let latest = null;
    for (const entry of entries) {
      if (entry.startSeconds > playbackTime) {
        break;
      }
      const resolved = resolveRowTimeEntry(entry);
      if (!resolved || !entryMatchesPlaybackOptions(resolved, options)) {
        continue;
      }
      if (!latest || resolved.endSeconds >= latest.endSeconds) {
        latest = resolved;
      }
    }

    return latest;
  }


  function hasRowsForSpeakerKey(speakerKey) {
    if (!speakerKey) {
      return false;
    }

    return getRowTimeEntries().some((entry) => {
      const resolved = resolveRowTimeEntry(entry);
      return resolved && getRowSpeakerKeySafe(resolved.row) === speakerKey;
    });
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


  function getLastPlaybackRow() {
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
