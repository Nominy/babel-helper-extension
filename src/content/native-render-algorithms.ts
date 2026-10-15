// @ts-nocheck
/** Immutable interval index. Original array order wins overlaps, never start-time order. */
export class NativeIntervalIndex {
  constructor(values, start, end) {
    this.entries = values.map((value, order) => ({ value, order, start: Number(start(value)), end: Number(end(value)) }))
      .filter(entry => !Number.isNaN(entry.start) && !Number.isNaN(entry.end))
      .sort((left, right) => left.start - right.start || left.order - right.order);
    const build = (low, high) => {
      if (low >= high) return null;
      const middle = (low + high) >>> 1;
      const entry = this.entries[middle], left = build(low, middle), right = build(middle + 1, high);
      return { entry, left, right, max: Math.max(entry.end, left?.max ?? -Infinity, right?.max ?? -Infinity) };
    };
    this.root = build(0, this.entries.length);
  }
  first(time, accept = null) {
    let found = null;
    const visit = node => {
      if (!node || node.max <= time) return;
      visit(node.left);
      const entry = node.entry;
      if (entry.start <= time && entry.end > time && (!found || entry.order < found.order) && (!accept || accept(entry.value))) found = entry;
      if (entry.start <= time) visit(node.right);
    };
    visit(this.root);
    return found;
  }
  query(start, end = start, inclusiveEnd = false) {
    const found = [];
    const visit = node => {
      if (!node || (inclusiveEnd ? node.max < start : node.max <= start)) return;
      visit(node.left);
      const entry = node.entry;
      if (entry.start <= end && (inclusiveEnd ? entry.end >= start : entry.end > start)) found.push(entry);
      if (entry.start <= end) visit(node.right);
    };
    visit(this.root);
    found.sort((left, right) => left.order - right.order);
    return found.map(entry => entry.value);
  }
}

/** Same clock and synchronous notification semantics as Oct15 iu, with row-scoped snapshots. */
export class NativeRenderPlayhead {
  time = 0;
  listeners = new Set();
  words = new Set();
  active = new Set();
  dirty = true;
  index = null;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getTime = () => this.time;
  subscribeWords(words, listener) {
    const index = new NativeIntervalIndex(words, word => word.startTime, word => word.endTime);
    const subscription = { index, listener, value: index.first(this.time)?.order ?? -1,
      start: index.entries[0]?.start ?? Infinity, end: index.root?.max ?? -Infinity };
    this.words.add(subscription);
    if (subscription.value !== -1) this.active.add(subscription);
    this.dirty = true;
    return () => { this.words.delete(subscription); this.active.delete(subscription); this.dirty = true; };
  }
  update(time) {
    if (time === this.time) return;
    this.time = time;
    for (const listener of this.listeners) listener();
    if (this.dirty) {
      this.index = new NativeIntervalIndex([...this.words], value => value.start, value => value.end);
      this.dirty = false;
    }
    const next = new Set(this.index.query(time));
    for (const subscription of this.active) {
      if (next.has(subscription)) continue;
      if (subscription.value !== -1) { subscription.value = -1; subscription.listener(); }
    }
    for (const subscription of next) {
      const value = subscription.index.first(time)?.order ?? -1;
      if (value !== subscription.value) { subscription.value = value; subscription.listener(); }
    }
    this.active = next;
  }
}

export function useNativeActiveWord(React, playhead, words) {
  const index = React.useMemo(() => new NativeIntervalIndex(words, word => word.startTime, word => word.endTime), [words]);
  const subscribe = React.useCallback(listener => playhead.subscribeWords(words, listener), [playhead, words]);
  const snapshot = React.useCallback(() => index.first(playhead.getTime())?.order ?? -1, [playhead, index]);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

const regions = new WeakMap();
const regionOwners = new WeakMap();
function regionState(plugin) {
  let state = regions.get(plugin);
  if (state) return state;
  state = { plugin, dirty: true, previous: [], highlighted: new Set(), disposers: [] };
  regions.set(plugin, state);
  const mark = region => { state.dirty = true; if (region) regionOwners.set(region, state); };
  for (const region of plugin.regions) regionOwners.set(region, state);
  for (const name of ['region-created', 'region-update', 'region-updated', 'region-removed']) state.disposers.push(plugin.on(name, mark));
  state.disposers.push(plugin.on('destroy', () => {
    for (const release of state.disposers) release();
    regions.delete(plugin);
  }));
  return state;
}
export function invalidateRegion(region) {
  const owner = regionOwners.get(region);
  if (owner) {
    owner.dirty = true;
    invalidateRegionView(owner.plugin);
  }
}
function readRegions(plugin) {
  const state = regionState(plugin);
  if (state.dirty) {
    state.index = new NativeIntervalIndex(plugin.regions, region => region.start, region => region.end);
    state.eventIndex = new NativeIntervalIndex(plugin.regions, region => region.start, region => region.end === region.start ? region.start + 0.05 : region.end);
    state.ids = new Map();
    for (const region of plugin.regions) {
      regionOwners.set(region, state);
      let values = state.ids.get(region.id);
      if (!values) state.ids.set(region.id, values = []);
      values.push(region);
    }
    state.dirty = false;
    state.eligible = null;
  }
  return state;
}
export function activeRegion(plugin, time, excludedId, excludedPrefix) {
  if (!plugin) return null;
  const state = readRegions(plugin);
  const allowed = region => region.id !== excludedId && !region.id.startsWith(excludedPrefix);
  const current = state.index.first(time, allowed)?.value;
  if (current) return current;
  if (!state.eligible || state.excludedId !== excludedId || state.excludedPrefix !== excludedPrefix) {
    state.eligible = plugin.regions.filter(allowed);
    state.excludedId = excludedId;
    state.excludedPrefix = excludedPrefix;
  }
  const last = state.eligible[state.eligible.length - 1];
  return last && time >= last.start && time === last.end ? last : null;
}
export function highlightRegion(plugin, id) {
  if (!plugin) return;
  const state = readRegions(plugin);
  const next = new Set(state.ids.get(id) || []);
  // Establish exclusive visual ownership once; subsequent updates touch only the delta.
  if (!state.initialized) {
    for (const region of plugin.regions) if (region.element?.style.filter) state.highlighted.add(region);
    state.initialized = true;
  }
  for (const region of state.highlighted) if (!next.has(region) && region.element?.style.filter) region.element.style.filter = '';
  for (const region of next) if (region.element && region.element.style.filter !== 'brightness(0.8)') region.element.style.filter = 'brightness(0.8)';
  state.highlighted = next;
}
export function updateRegionEvents(plugin, time) {
  const state = readRegions(plugin);
  const next = state.eventIndex.query(time, time, true);
  const previousSet = new Set(state.previous), nextSet = new Set(next);
  for (const region of next) if (!previousSet.has(region)) plugin.emit('region-in', region);
  for (const region of state.previous) if (!nextSet.has(region)) plugin.emit('region-out', region);
  state.previous = next;
}

const timelines = new WeakMap();
export function updateVisibleNotches(plugin, left, right, container) {
  let state = timelines.get(plugin);
  if (!state || state.container !== container || state.size !== plugin.notchElements.size) {
    const entries = [...plugin.notchElements].map(([element, notch]) => ({ element, notch }));
    state = { container, size: entries.length, entries: entries.sort((a, b) => a.notch.start - b.notch.start), visible: new Set(entries.filter(entry => entry.notch.wasVisible)) };
    timelines.set(plugin, state);
  }
  let low = 0, high = state.entries.length;
  while (low < high) { const middle = (low + high) >>> 1; if (state.entries[middle].notch.start < left) low = middle + 1; else high = middle; }
  const visible = new Set();
  for (let index = low; index < state.entries.length; index++) {
    const entry = state.entries[index];
    if (entry.notch.start >= right) break;
    if (entry.notch.start + entry.notch.width < right) visible.add(entry);
  }
  for (const entry of state.visible) if (!visible.has(entry)) { entry.notch.wasVisible = false; entry.element.remove(); }
  for (const entry of visible) if (!state.visible.has(entry)) { entry.notch.wasVisible = true; container.appendChild(entry.element); }
  state.visible = visible;
}

/** Retain native clamping and dragging rules, but perform at most one scroll write. */
export function scrollIntoView(renderer, progress, playing = false) {
  const container = renderer.scrollContainer;
  const left = container.scrollLeft, width = container.clientWidth, position = progress * container.scrollWidth;
  let target = left;
  if (renderer.isDragging) {
    if (position + 30 > left + width) target += 30;
    else if (position - 30 < left) target -= 30;
  } else {
    if (position < left || position > left + width) target = position - (renderer.options.autoCenter ? width / 2 : 0);
    // Native uses the original left here, even after the first assignment.
    if (playing && renderer.options.autoCenter && position - left - width / 2 > 0) {
      target = Math.max(0, Math.min(container.scrollWidth - width, target)) + position - left - width / 2;
    }
  }
  setScroll(container, target);
}
export function setScroll(container, target) {
  if (!container) return;
  target = Math.max(0, Math.min(Math.max(0, container.scrollWidth - container.clientWidth), target));
  if (container.scrollLeft !== target) container.scrollLeft = target;
}

const regionViews = new WeakMap();
export function virtualAppendRegion(plugin, region, container, element) {
  regionOwners.set(region, regionState(plugin));
  let state = regionViews.get(plugin);
  if (!state) {
    state = { entries: new Map(), visible: new Set(), dirty: true, width: -1, duration: -1, releases: [] };
    regionViews.set(plugin, state);
    const update = () => {
      const wave = plugin.wavesurfer;
      if (!wave) return;
      const width = container.clientWidth, duration = wave.getDuration();
      if (state.dirty || width !== state.width || duration !== state.duration) {
        state.width = width; state.duration = duration; state.dirty = false;
        state.index = new NativeIntervalIndex([...state.entries.values()], entry => Math.round(entry.region.start / duration * width), entry => Math.round(entry.region.start / duration * width) + (Math.round((entry.region.end - entry.region.start) / duration * width) || 1));
      }
      const left = wave.getScroll(), right = left + wave.getWidth();
      const next = new Set(state.index.query(left, right).filter(entry => Math.round(entry.region.start / duration * width) < right));
      for (const entry of state.visible) if (!next.has(entry) && entry.element.parentElement) entry.element.remove();
      for (const entry of next) if (!entry.element.parentElement) container.appendChild(entry.element);
      state.visible = next;
    };
    state.update = update;
    for (const event of ['scroll', 'zoom', 'resize', 'ready']) state.releases.push(plugin.wavesurfer.on(event, update));
    for (const event of ['region-update', 'region-updated']) state.releases.push(plugin.on(event, () => { state.dirty = true; update(); }));
    state.releases.push(plugin.on('destroy', () => {
      for (const release of state.releases) release();
      for (const entry of state.entries.values()) entry.release();
      state.entries.clear(); regionViews.delete(plugin);
    }));
  }
  const entry = { region, element, release: null };
  state.entries.set(region, entry);
  entry.release = region.once('remove', () => { state.entries.delete(region); state.visible.delete(entry); state.dirty = true; });
  state.dirty = true;
  // Native defers insertion until saveRegion has finished wiring its listeners.
  if (!state.queued) {
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      if (regionViews.get(plugin) === state) state.update();
    });
  }
}
export function invalidateRegionView(plugin) {
  const state = regionViews.get(plugin);
  if (!state) return;
  state.dirty = true;
  if (!state.queued) {
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      if (regionViews.get(plugin) === state) state.update();
    });
  }
}
