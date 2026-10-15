// @ts-nocheck
// Native coverage uses inclusive 100ms bins, including the final half-second.
export class BinRuns {
  runs = [];
  size = 0;
  constructor(bins = []) {
    for (const bin of [...bins].sort((a, b) => a - b)) this.add(bin, bin);
  }
  lower(bin) {
    let low = 0, high = this.runs.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.runs[mid][1] < bin) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  add(start, end) {
    if (end < start) return;
    const first = this.lower(start - 1);
    let last = first;
    while (last < this.runs.length && this.runs[last][0] <= end + 1) {
      start = Math.min(start, this.runs[last][0]);
      end = Math.max(end, this.runs[last][1]);
      this.size -= this.runs[last][1] - this.runs[last][0] + 1;
      last++;
    }
    this.runs.splice(first, last - first, [start, end]);
    this.size += end - start + 1;
  }
  remove(bin) {
    const index = this.lower(bin), run = this.runs[index];
    if (!run || run[0] > bin) return false;
    if (run[0] === run[1]) this.runs.splice(index, 1);
    else if (run[0] === bin) run[0]++;
    else if (run[1] === bin) run[1]--;
    else {
      const end = run[1];
      run[1] = bin - 1;
      this.runs.splice(index + 1, 0, [bin + 1, end]);
    }
    this.size--;
    return true;
  }
  gaps(duration) {
    return this.runs.map(([start, end]) => ({ start: start * 0.1, end: Math.min((end + 1) * 0.1, duration) }));
  }
}

export class NativeCoverageIndex {
  constructor(store) { this.store = store; this.rebuild(); }
  rebuild() {
    const store = this.store;
    this.duration = store.playableDuration();
    this.timeline = store.timeline;
    this.required = store.required;
    this.tracks = store.tracks;
    this.total = Math.max(0, Math.ceil(this.duration / 0.1));
    this.deficits = new Uint32Array(this.total);
    this.outsideDeficits = new Map();
    this.timelineMissing = new BinRuns();
    this.missing = new BinRuns();
    this.timelineHeard = new BinRuns(store.timeline);
    this.speakers = new Map();
    this.heard = new Map();
    for (const [id, track] of store.tracks) this.heard.set(id, new BinRuns(track.heard));
    for (let bin = 0; bin < this.total; bin++) {
      if (!store.timeline.has(bin)) { this.deficits[bin]++; this.timelineMissing.add(bin, bin); }
    }
    for (const [id, required] of store.required) {
      const heard = store.tracks.get(id)?.heard;
      const missing = new BinRuns();
      for (const bin of required) {
        if (heard?.has(bin)) continue;
        missing.add(bin, bin);
        if (bin >= 0 && bin < this.total) this.deficits[bin]++;
        else this.outsideDeficits.set(bin, (this.outsideDeficits.get(bin) || 0) + 1);
      }
      this.speakers.set(id, { required, missing });
    }
    for (let bin = 0; bin < this.total; bin++) if (this.deficits[bin]) this.missing.add(bin, bin);
    for (const bin of this.outsideDeficits.keys()) this.missing.add(bin, bin);
    this.dirty = true;
  }
  ensure() {
    if (this.duration !== this.store.playableDuration() || this.timeline !== this.store.timeline ||
        this.required !== this.store.required || this.tracks !== this.store.tracks) this.rebuild();
  }
  resolve(bin) {
    if (bin >= 0 && bin < this.total) {
      if (this.deficits[bin] && --this.deficits[bin] === 0) this.missing.remove(bin);
    } else {
      const remaining = this.outsideDeficits.get(bin) - 1;
      if (remaining) this.outsideDeficits.set(bin, remaining);
      else { this.outsideDeficits.delete(bin); this.missing.remove(bin); }
    }
  }
  addTo(set, runs, start, end, duration, onNew) {
    const first = Math.floor(start / 0.1), last = Math.ceil(duration / 0.1) - 1;
    const final = end >= duration - 0.5 ? last : Math.min(Math.floor(end / 0.1), last);
    let changed = false;
    for (let bin = first; bin <= final; bin++) {
      if (set.has(bin)) continue;
      set.add(bin);
      onNew(bin);
      changed = true;
    }
    if (changed) runs.add(first, final);
    return changed;
  }
  credit(id, start, end, duration) {
    this.ensure();
    const track = this.store.trackFor(id);
    let heard = this.heard.get(id);
    if (!heard) { heard = new BinRuns(track.heard); this.heard.set(id, heard); }
    const speaker = this.speakers.get(id);
    const trackChanged = this.addTo(track.heard, heard, start, end, duration, bin => {
      if (speaker?.missing.remove(bin)) { this.resolve(bin); this.dirty = true; }
    });
    const timelineChanged = this.addTo(this.store.timeline, this.timelineHeard, start, end, this.duration, bin => {
      if (this.timelineMissing.remove(bin)) { this.resolve(bin); this.dirty = true; }
    });
    return trackChanged || timelineChanged;
  }
  snapshot() {
    this.ensure();
    if (!this.dirty) return this.cached;
    this.dirty = false;
    const speakers = [];
    if (this.duration > 0) for (const [trackId, { required, missing }] of this.speakers) {
      if (required.size) speakers.push({ trackId, percent: Math.floor((required.size - missing.size) / required.size * 100), gapCount: missing.runs.length });
    }
    this.cached = this.duration <= 0
      ? { duration: 0, gaps: [], timelineGapCount: 0, speakers: [], percent: 0 }
      : { duration: this.duration, gaps: this.missing.gaps(this.duration), timelineGapCount: this.timelineMissing.runs.length,
          speakers, percent: Math.floor((this.total - this.missing.size) / this.total * 100) };
    return this.cached;
  }
  persisted(reviewActionId) {
    return { reviewActionId, timeline: this.timelineHeard.runs,
      tracks: Object.fromEntries([...this.heard].map(([id, heard]) => [id, heard.runs])) };
  }
}
