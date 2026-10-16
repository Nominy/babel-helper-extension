// @ts-nocheck
import { findBabelEditorFiber, readBabelPlaybackBindings, subscribeBabelEditorCommits, readBabelTurnIdentity } from '@nominy/babel-babel-runtime';
import { getActiveEditorMode } from '../../core/editor-mode';
// Wavesurfer paints the waveform into a canvas and the regions plugin writes its colours as
// inline styles inside a shadow root, so neither can be themed from a page stylesheet. This
// page-world bridge reads the workbench's native WaveSurfer registry and drives only its
// current instances, remembering every value it overwrites so a disable restores the page.
//
// The dashboard colours lanes from a three-slot palette rotated over the track array
// (`palette[index % 3]`), so the bridge mirrors that shape: `detail.lanes` is three slots and
// a lane picks `lanes[(laneIndex - 1) % 3]`. Registry recording IDs and the authoritative
// recording array determine lane identity; DOM order never substitutes for missing identity.
//
// The payload is exactly `{ enabled, lanes }`: the runtime derives every slot colour from the
// core palette (wave from the shared wave colour, progress/region from the speaker colour,
// cursor from the text colour) and the bridge only places them. A lane without a slot is left
// entirely native, which is also what a disabled group looks like.
//
// Ownership split with website-appearance.css: the bridge owns the canvas colours
// (waveColor/progressColor), the cursor and the region fill/border of a stamped lane; the
// stylesheet owns the lane frame and native turn speaker controls, keyed off the
// `data-babel-helper-lane-slot` / `data-babel-helper-lane-index` /
// `data-babel-helper-speaker-label` attributes this bridge stamps on the wavesurfer host and
// on the lane root.
(function waveformThemeBridge() {
  const CONFIG_EVENT = 'babel-helper-waveform-theme-config';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const GLOBAL_KEY = '__babelHelperWaveformThemeBridge';
  const RESCAN_DELAY_MS = 160;
  const MAX_LANE_ROOT_HOPS = 6;
  const MAX_PLUGINS = 16;
  const LANE_SLOT_COUNT = 3;
  // The app renders its own region fill as `rgba(r, g, b, 0.25)`; a lane slot carries an
  // opaque hex, so the bridge reproduces that translucency instead of asking for a second dial.
  const REGION_FILL_ALPHA = 0.25;

  const COLOR_KEYS = ['waveColor', 'progressColor', 'cursorColor'];
  const LANE_SLOT_KEYS = [
    'waveColor',
    'progressColor',
    'cursorColor',
    'regionColor',
    'regionBorderColor'
  ];

  const LANE_INDEX_ATTRIBUTE = 'data-babel-helper-lane-index';
  const LANE_SLOT_ATTRIBUTE = 'data-babel-helper-lane-slot';
  const LANE_LABEL_ATTRIBUTE = 'data-babel-helper-speaker-label';
  const LANE_ATTRIBUTES = [LANE_INDEX_ATTRIBUTE, LANE_SLOT_ATTRIBUTE, LANE_LABEL_ATTRIBUTE];

  const REGION_FILL_PROPERTY = 'background-color';
  // The app writes `border-left`/`border-right` shorthands with `!important`, so only an
  // `!important` longhand can recolour them, and a longhand keeps the app's own border width:
  // the bridge never introduces geometry.
  const REGION_BORDER_PROPERTIES = ['border-left-color', 'border-right-color'];
  const REGION_EVENTS = ['region-created', 'region-updated'];

  const existingBridge = window[GLOBAL_KEY];
  if (existingBridge) {
    if (typeof existingBridge.applyConfig === 'function') {
      return;
    }

    if (typeof existingBridge.dispose === 'function') {
      existingBridge.dispose();
    } else {
      delete window[GLOBAL_KEY];
    }
  }

  // Instance -> record. A Map (not a WeakMap) because a disable has to walk every adopted
  // instance; stale entries are pruned whenever we rescan.
  const records = new Map();
  const waveMetadata = new Map();
  let sessionId = null;
  let sessionRoot = null;
  let unsubscribeCommits = null;
  const config = {
    enabled: false,
    lanes: null
  };

  let generation = 0;
  let observer = null;
  let rescanTimer = 0;
  let disposed = false;
  // How many instances the last completed pass themed. It is what an unchanged config
  // answers with, so repeating a payload costs no scan and still reports the live figure.
  let lastApplied = 0;
  // setOptions runs page code synchronously (wavesurfer re-renders and emits), so the
  // dashboard can call back into applyConfig/refresh from inside our own write. `busy`
  // marks a pass in flight so a nested one defers instead of corrupting the records.
  let busy = false;
  // Speaker-column cells belong to a lane by label, not to any one wavesurfer instance, so
  // their stamps live beside the records and are restored with them.
  let speakerCellStamps = [];

  function safe(callback, fallbackValue) {
    try {
      const value = callback();
      return value == null ? fallbackValue : value;
    } catch (error) {
      return fallbackValue;
    }
  }

  function normalizeColor(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function isObjectLike(value) {
    return Boolean(value) && (typeof value === 'object' || typeof value === 'function');
  }

  // A lane slot ships opaque hex; the region fill has to read as the app's translucent wash.
  // Anything that is not plain hex is handed through untouched so a future rgba/color-mix
  // value still works.
  function withRegionAlpha(color) {
    if (typeof color !== 'string') {
      return null;
    }

    const trimmed = color.trim();
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
    if (!match) {
      return trimmed ? trimmed : null;
    }

    const digits = match[1];
    const full =
      digits.length === 3
        ? digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2]
        : digits;
    const red = parseInt(full.slice(0, 2), 16);
    const green = parseInt(full.slice(2, 4), 16);
    const blue = parseInt(full.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${REGION_FILL_ALPHA})`;
  }

  function normalizeLaneSlot(value) {
    if (!isObjectLike(value)) {
      return null;
    }

    const slot = {};
    let populated = false;
    for (const key of LANE_SLOT_KEYS) {
      const color = normalizeColor(safe(() => value[key], null));
      slot[key] = color;
      if (color) {
        populated = true;
      }
    }

    // A slot with nothing usable in it is dropped, which leaves that lane native: the frame
    // and the native speaker controls are stylesheet-owned off the stamps, so they never ride here.
    return populated ? slot : null;
  }

  function normalizeLanes(value) {
    if (!Array.isArray(value)) {
      return null;
    }

    const lanes = [];
    let populated = false;
    for (let index = 0; index < LANE_SLOT_COUNT; index += 1) {
      const slot = normalizeLaneSlot(value[index]);
      lanes.push(slot);
      if (slot) {
        populated = true;
      }
    }

    return populated ? lanes : null;
  }

  // Both sides are already normalized: three slots, each either null or the five keys with a
  // string-or-null value, so a fixed 15-comparison walk decides equality without allocating.
  function lanesEqual(left, right) {
    if (left === right) {
      return true;
    }

    if (!left || !right) {
      return false;
    }

    for (let index = 0; index < LANE_SLOT_COUNT; index += 1) {
      const leftSlot = left[index];
      const rightSlot = right[index];
      if (leftSlot === rightSlot) {
        continue;
      }

      if (!leftSlot || !rightSlot) {
        return false;
      }

      for (const key of LANE_SLOT_KEYS) {
        if (leftSlot[key] !== rightSlot[key]) {
          return false;
        }
      }
    }

    return true;
  }

  function getLaneSlot(laneIndex) {
    if (!config.lanes || typeof laneIndex !== 'number' || !Number.isFinite(laneIndex) || laneIndex < 1) {
      return null;
    }

    return config.lanes[(Math.floor(laneIndex) - 1) % LANE_SLOT_COUNT];
  }

  function isVisibleElement(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) {
      return false;
    }

    const style = safe(() => window.getComputedStyle(element), null);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      return false;
    }

    const rect = safe(() => element.getBoundingClientRect(), null);
    return Boolean(rect) && rect.width > 0 && rect.height > 0;
  }

  function isVisibleWaveHost(host) {
    if (!(host instanceof HTMLElement)) {
      return false;
    }

    // Shadow-part probing first: getComputedStyle/getBoundingClientRect flush style and
    // layout, so plain page divs must be rejected before any measurement happens.
    const shadowRoot = safe(() => host.shadowRoot, null);
    if (!shadowRoot || typeof shadowRoot.querySelector !== 'function') {
      return false;
    }

    const wrapper = safe(() => shadowRoot.querySelector('[part="wrapper"]'), null);
    const scroll = safe(() => shadowRoot.querySelector('[part="scroll"]'), null);
    if (!(wrapper instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
      return false;
    }

    return isVisibleElement(host) && isVisibleElement(scroll);
  }


  function getInstanceContainer(instance) {
    const direct = safe(() => instance.container, null);
    if (direct instanceof HTMLElement) {
      return direct;
    }

    const rendererContainer = safe(() => instance.renderer.container, null);
    if (rendererContainer instanceof HTMLElement) {
      return rendererContainer;
    }

    const optionContainer = safe(() => instance.options.container, null);
    if (optionContainer instanceof HTMLElement) {
      return optionContainer;
    }

    return null;
  }

  function containerMatchesHost(host, container) {
    if (!(host instanceof HTMLElement) || !(container instanceof HTMLElement)) {
      return false;
    }

    if (host === container || safe(() => host.contains(container), false) || safe(() => container.contains(host), false)) {
      return true;
    }

    const hostShadow = safe(() => host.shadowRoot, null);
    if (hostShadow && safe(() => hostShadow.contains(container), false)) {
      return true;
    }

    const containerShadow = safe(() => container.shadowRoot, null);
    if (containerShadow && safe(() => containerShadow.contains(host), false)) {
      return true;
    }

    const hostRoot = safe(() => host.getRootNode(), null);
    if (hostRoot && hostRoot.host === container) {
      return true;
    }

    const containerRoot = safe(() => container.getRootNode(), null);
    return Boolean(containerRoot && containerRoot.host === host);
  }

  function isThemableInstance(value, host) {
    // Wavesurfer signals: setOptions plus getDuration, an options bag, and a container that
    // resolves back to this host. Dashboard-side objects that merely expose setOptions must
    // never be adopted, so an unresolvable container is a rejection, not a pass.
    if (!isObjectLike(value) || typeof value.setOptions !== 'function' || typeof value.getDuration !== 'function') {
      return false;
    }

    if (!isObjectLike(safe(() => value.options, null))) {
      return false;
    }

    const container = getInstanceContainer(value);
    return Boolean(container) && containerMatchesHost(host, container);
  }
  function readWaveMetadata(instance, trackId, bindings) {
    const position = bindings.recordingTracks.findIndex((track) => track.id === trackId);
    if (position < 0) return null;
    const container = getInstanceContainer(instance);
    const wrapper = safe(() => instance.getWrapper(), null);
    const wrapperHost = safe(() => wrapper.getRootNode().host, null);
    const host = wrapperHost instanceof HTMLElement ? wrapperHost : container;
    if (!host || !isThemableInstance(instance, host)) return null;
    const media = safe(() => instance.getMediaElement(), null);
    const source = media?.currentSrc || media?.src || instance.options?.url || '';
    const decoded = safe(() => instance.getDecodedData(), null);
    const label = normalizeColor(bindings.recordingTracks[position].label);
    const laneRoot = getLaneRoot(host);
    const regionsPlugin = getRegionsPlugin(instance);
    const previous = waveMetadata.get(instance);
    if (previous && previous.host === host && previous.laneRoot === laneRoot &&
        previous.trackId === trackId && previous.laneIndex === position + 1 &&
        previous.label === label && previous.media === media &&
        previous.source === source && previous.decoded === decoded &&
        previous.regionsPlugin === regionsPlugin) return previous;
    const meta = { host, laneRoot, trackId, laneIndex: position + 1, label, media, source, decoded, regionsPlugin };
    waveMetadata.set(instance, meta);
    return meta;
  }


  // The lane root is the app's frame node: a flex row carrying inline
  // `border-left: 2.5px solid <progress>` / `border-right`. Reading the inline style bag
  // never flushes layout, so this stays free next to the host probe. There is deliberately
  // no fallback: a generic ancestor can be shared by several lanes, and stamping one lane's
  // identity onto a shared node would be worse than leaving the frame unthemed.
  function getLaneRoot(host) {
    let current = safe(() => host.parentElement, null);
    let hops = 0;

    while (current instanceof HTMLElement && hops < MAX_LANE_ROOT_HOPS) {
      const style = safe(() => current.style, null);
      if (style && (readStyleValue(style, 'border-left-color') || readStyleValue(style, 'border-right-color'))) {
        return current;
      }

      current = safe(() => current.parentElement, null);
      hops += 1;
    }

    return null;
  }

  function readStyleValue(style, property) {
    const value = safe(() => style.getPropertyValue(property), '');
    return typeof value === 'string' ? value : '';
  }

  function readStylePriority(style, property) {
    const value = safe(() => style.getPropertyPriority(property), '');
    return typeof value === 'string' ? value : '';
  }

  function writeStyleValue(style, property, value, priority) {
    return safe(() => {
      if (!value) {
        style.removeProperty(property);
      } else {
        style.setProperty(property, value, priority || '');
      }
      return true;
    }, false);
  }

  function readAttribute(element, name) {
    return safe(() => (element.getAttribute(name) == null ? null : element.getAttribute(name)), null);
  }

  function writeAttribute(element, name, value) {
    return safe(() => {
      if (value == null) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, value);
      }
      return true;
    }, false);
  }

  function stampElements(stamps, elements, values) {
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }

      let stamp = null;
      for (const candidate of stamps) {
        if (candidate.element === element) {
          stamp = candidate;
          break;
        }
      }

      if (!stamp) {
        const original = {};
        for (const name of LANE_ATTRIBUTES) {
          original[name] = readAttribute(element, name);
        }
        stamp = { element, original, applied: {} };
        stamps.push(stamp);
      }

      for (const name of LANE_ATTRIBUTES) {
        const next = values[name];
        if (stamp.applied[name] === next && readAttribute(element, name) === next) {
          continue;
        }

        if (writeAttribute(element, name, next)) {
          stamp.applied[name] = next;
        }
      }
    }
  }

  function restoreStamps(stamps) {
    for (const stamp of stamps) {
      for (const name of LANE_ATTRIBUTES) {
        if (!Object.prototype.hasOwnProperty.call(stamp.applied, name)) {
          continue;
        }

        // Leave alone anything the page rewrote after we stamped it.
        if (readAttribute(stamp.element, name) !== stamp.applied[name]) {
          continue;
        }

        writeAttribute(stamp.element, name, stamp.original[name]);
      }
    }

    stamps.length = 0;
  }

  // Native speaker selects carry recording IDs. Labels and colours are not unique.
  function stampSpeakerCells(laneByTrackId) {
    const labels = Object.keys(laneByTrackId);
    if (!labels.length) {
      restoreStamps(speakerCellStamps);
      return;
    }

    const cells = safe(() => Array.from(document.querySelectorAll('section[data-annotation-id] select[id^="speaker-"]')), []);
    const stamped = new Set();

    for (const cell of cells) {

      if (!(cell instanceof HTMLElement)) {
        continue;
      }

      const lane = laneByTrackId[cell.value];
      if (!lane) {
        continue;
      }

      const row = cell.closest('section[data-annotation-id]');
      stamped.add(cell);
      if (row) stamped.add(row);
      stampElements(speakerCellStamps, [cell, row], {
        [LANE_INDEX_ATTRIBUTE]: String(lane.laneIndex),
        [LANE_SLOT_ATTRIBUTE]: String(lane.slotIndex),
        [LANE_LABEL_ATTRIBUTE]: lane.label
      });
    }
    if (getActiveEditorMode() === 'classic') for (const row of document.querySelectorAll('[data-babel-classic-row="true"][data-annotation-id]')) {
      const identity = readBabelTurnIdentity(row.getAttribute('data-annotation-id'));
      const lane = identity && laneByTrackId[identity.processedRecordingId];
      if (!lane) continue;
      const cell = row.querySelector('[data-babel-classic-speaker="true"]');
      stamped.add(row);
      if (cell) stamped.add(cell);
      stampElements(speakerCellStamps, [row, cell], {
        [LANE_INDEX_ATTRIBUTE]: String(lane.laneIndex),
        [LANE_SLOT_ATTRIBUTE]: String(lane.slotIndex),
        [LANE_LABEL_ATTRIBUTE]: lane.label
      });
    }

    // Reassigned and unmounted turns must not retain obsolete lane identity.
    const stale = speakerCellStamps.filter((stamp) => !stamped.has(stamp.element));
    if (stale.length) {
      restoreStamps(stale);
      speakerCellStamps = speakerCellStamps.filter((stamp) => stamped.has(stamp.element));
    }
  }

  function getRegionsPlugin(instance) {
    const plugins = safe(() => instance.plugins, null);
    const candidates = [];

    if (Array.isArray(plugins)) {
      for (const plugin of plugins) {
        if (candidates.length >= MAX_PLUGINS) {
          break;
        }
        candidates.push(plugin);
      }
    } else if (isObjectLike(plugins)) {
      candidates.push(safe(() => plugins.regions, null));
    }

    for (const plugin of candidates) {
      if (isObjectLike(plugin) && typeof safe(() => plugin.getRegions, null) === 'function') {
        return plugin;
      }
    }

    return null;
  }

  function getRegionList(plugin) {
    const list = safe(() => plugin.getRegions(), null);
    if (!Array.isArray(list)) {
      return [];
    }

    return list;
  }

  function getRegionStyle(region) {
    const element = safe(() => region.element, null);
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return safe(() => element.style, null);
  }

  function captureRegionOriginal(region) {
    const style = getRegionStyle(region);
    const original = {
      hasColor: safe(() => 'color' in region, false),
      color: safe(() => region.color, undefined),
      fill: style ? readStyleValue(style, REGION_FILL_PROPERTY) : '',
      fillPriority: style ? readStylePriority(style, REGION_FILL_PROPERTY) : '',
      border: {},
      borderPriority: {}
    };

    for (const property of REGION_BORDER_PROPERTIES) {
      original.border[property] = style ? readStyleValue(style, property) : '';
      original.borderPriority[property] = style ? readStylePriority(style, property) : '';
    }

    return original;
  }

  function applyRegionColors(region, entry, colors) {
    const style = getRegionStyle(region);
    if (!style) {
      return;
    }

    if (colors.fill) {
      // Comparing against the echo (what the browser reported straight after our write)
      // rather than the requested string keeps a serialised `rgba(…)` from looking like a
      // page override on every pass, while a genuine repaint by the app still triggers a
      // rewrite. The app re-asserts its own colours around every region event.
      if (readStyleValue(style, REGION_FILL_PROPERTY) !== entry.fillEcho) {
        // The plugin's own setter keeps its cached colour and the element in step, which is
        // what it replays on the next re-render; the direct style write is the fallback for a
        // region object that does not expose it. No `!important`: the app paints this fill
        // with a plain inline style too, so plain is enough to hold it.
        const wrote =
          typeof safe(() => region.setOptions, null) === 'function'
            ? safe(() => {
                region.setOptions({ color: colors.fill });
                return true;
              }, false)
            : writeStyleValue(style, REGION_FILL_PROPERTY, colors.fill, '');

        if (wrote) {
          entry.fillEcho = readStyleValue(style, REGION_FILL_PROPERTY);
          entry.appliedFill = true;
        }
      }
    } else if (entry.appliedFill) {
      restoreRegionFill(region, entry);
    }

    for (const property of REGION_BORDER_PROPERTIES) {
      if (colors.border) {
        if (readStyleValue(style, property) === entry.borderEcho[property]) {
          continue;
        }

        // The app writes `border-left`/`border-right` shorthands with `!important`, so only
        // an `!important` longhand reaches the colour, and only the colour: the width stays
        // whatever the app chose, so the bridge never moves anything.
        if (writeStyleValue(style, property, colors.border, 'important')) {
          entry.borderEcho[property] = readStyleValue(style, property);
          entry.appliedBorder[property] = true;
        }
        continue;
      }

      if (entry.appliedBorder[property]) {
        restoreRegionBorder(region, entry, property);
      }
    }
  }

  function restoreRegionFill(region, entry) {
    const style = getRegionStyle(region);
    if (!entry.appliedFill) {
      return;
    }

    entry.appliedFill = false;
    if (style && readStyleValue(style, REGION_FILL_PROPERTY) === entry.fillEcho) {
      writeStyleValue(style, REGION_FILL_PROPERTY, entry.original.fill, entry.original.fillPriority);
    }

    safe(() => {
      if (entry.original.hasColor) {
        region.color = entry.original.color;
      } else {
        delete region.color;
      }
      return true;
    }, false);
  }

  function restoreRegionBorder(region, entry, property) {
    if (!entry.appliedBorder[property]) {
      return;
    }

    entry.appliedBorder[property] = false;
    const style = getRegionStyle(region);
    if (!style || readStyleValue(style, property) !== entry.borderEcho[property]) {
      return;
    }

    writeStyleValue(style, property, entry.original.border[property], entry.original.borderPriority[property]);
  }

  function restoreRegion(region, entry) {
    restoreRegionFill(region, entry);
    for (const property of REGION_BORDER_PROPERTIES) {
      restoreRegionBorder(region, entry, property);
    }
  }

  function restoreRegions(record) {
    for (const [region, entry] of Array.from(record.regions.entries())) {
      restoreRegion(region, entry);
    }

    record.regions.clear();
  }

  function themeRegion(record, region) {
    if (!isObjectLike(region)) {
      return;
    }

    let entry = record.regions.get(region);
    if (!entry) {
      entry = {
        original: captureRegionOriginal(region),
        appliedFill: false,
        appliedBorder: {},
        fillEcho: '',
        borderEcho: {}
      };
      for (const property of REGION_BORDER_PROPERTIES) {
        entry.appliedBorder[property] = false;
        entry.borderEcho[property] = '';
      }
      record.regions.set(region, entry);
    }

    const colors = record.regionColors;
    if (!colors || (!colors.fill && !colors.border)) {
      restoreRegion(region, entry);
      record.regions.delete(region);
      return;
    }

    // The active-region highlight is `element.style.filter = 'brightness(0.8)'`, layered on
    // top of whatever fill is in place. Recolouring the fill therefore preserves it for free,
    // and the bridge never touches `filter`.
    applyRegionColors(region, entry, colors);
  }

  function applyRegions(record) {
    const plugin = record.regionsPlugin;
    if (!plugin) {
      return;
    }

    const live = getRegionList(plugin);
    const liveSet = new Set(live);
    for (const region of Array.from(record.regions.keys())) {
      // A removed region took our styles with it; there is nothing left to restore.
      if (!liveSet.has(region)) {
        record.regions.delete(region);
      }
    }

    for (const region of live) {
      themeRegion(record, region);
    }
  }

  function handleRegionEvent(instance, region) {
    if (disposed || !config.enabled) {
      return;
    }

    const record = records.get(instance);
    if (!record || !record.regionColors) {
      return;
    }

    // The app repaints a region's border and fill immediately, then again on a 0ms and a
    // ~50ms timer. The synchronous pass below kills the flash; the debounced rescan lands
    // after that window and wins the last word.
    scheduleRescan();
    if (busy) {
      return;
    }

    const bindings = readBabelPlaybackBindings();
    const entry = bindings?.waveTracks.find((entry) => entry.wave === instance);
    if (!entry || bindings.reviewActionId !== sessionId ||
        readWaveMetadata(instance, entry.trackId, bindings) !== record.meta) return;
    busy = true;
    try {
      themeRegion(record, region);
    } finally {
      busy = false;
    }
  }

  function subscribeRegions(instance, record) {
    const plugin = record.regionsPlugin;
    if (!plugin || record.regionUnsubscribes.length || typeof safe(() => plugin.on, null) !== 'function') {
      return;
    }

    for (const eventName of REGION_EVENTS) {
      const off = safe(
        () => plugin.on(eventName, (region) => handleRegionEvent(instance, region)),
        null
      );
      if (typeof off === 'function') {
        record.regionUnsubscribes.push(off);
      }
    }
  }

  function unsubscribeRegions(record) {
    for (const off of record.regionUnsubscribes) {
      safe(() => {
        off();
        return true;
      }, false);
    }

    record.regionUnsubscribes = [];
  }

  function captureOriginal(instance) {
    const options = safe(() => instance.options, null);
    const original = {};

    // Presence, not truthiness: wavesurfer leaves unset colors absent from options, and
    // writing that explicit `undefined` back is what restores its native fallback.
    for (const key of COLOR_KEYS) {
      original[key] = safe(() => options[key], undefined);
    }

    return original;
  }

  function writeInstanceOptions(instance, patch) {
    if (!Object.keys(patch).length) {
      return true;
    }

    return safe(() => {
      instance.setOptions(patch);
      return true;
    }, false);
  }

  // Every canvas colour comes from the lane's slot; there is no global fallback. A lane the
  // payload does not cover reads back as three nulls, which is the same thing a disable says,
  // so the shared clearing path in applyToInstance hands it straight back to native.
  function resolveOptionColors(laneIndex) {
    const slot = getLaneSlot(laneIndex);
    return {
      waveColor: (slot && slot.waveColor) || null,
      progressColor: (slot && slot.progressColor) || null,
      cursorColor: (slot && slot.cursorColor) || null
    };
  }

  function resolveRegionColors(laneIndex) {
    const slot = getLaneSlot(laneIndex);
    if (!slot) {
      return null;
    }

    const fill = withRegionAlpha(slot.regionColor);
    const border = slot.regionBorderColor;
    return fill || border ? { fill: fill || null, border: border || null } : null;
  }

  function applyToInstance(instance, meta, bindings) {
    let record = records.get(instance);
    if (!record) {
      record = {
        meta,
        sourceUnsubscribes: [],
        original: captureOriginal(instance),
        applied: {},
        laneIndex: null,
        label: null,
        trackId: null,
        stamps: [],
        regions: new Map(),
        regionColors: null,
        regionsPlugin: meta.regionsPlugin,
        regionUnsubscribes: []
      };
      records.set(instance, record);
      subscribeRegions(instance, record);
      if (typeof instance.on === 'function') {
        for (const event of ['load', 'decode', 'ready']) {
          const off = instance.on(event, scheduleRescan);
          if (typeof off === 'function') record.sourceUnsubscribes.push(off);
        }
      }
    }

    const laneIndex = meta.laneIndex;
    const slotIndex = ((laneIndex - 1) % LANE_SLOT_COUNT) + 1;
    if (record.laneIndex !== laneIndex || record.label !== meta.label) {
      // A lane that moved (a track above it was removed) has to shed its old stamp before it
      // takes the new one, so the page never keeps a value we no longer own.
      restoreStamps(record.stamps);
      record.laneIndex = laneIndex;
      record.label = meta.label;
    }
    record.trackId = meta.trackId;
    record.regionColors = resolveRegionColors(laneIndex);

    // Stamp before writing: setOptions can re-enter the bridge (a disable triggered by the
    // dashboard from inside our own write), and that nested restore has to already see every
    // attribute we own.
    stampElements(record.stamps, [meta.host, meta.laneRoot], {
      [LANE_INDEX_ATTRIBUTE]: String(laneIndex),
      [LANE_SLOT_ATTRIBUTE]: String(slotIndex),
      [LANE_LABEL_ATTRIBUTE]: meta.label
    });

    const desired = resolveOptionColors(laneIndex);
    const patch = {};
    const cleared = [];
    for (const key of COLOR_KEYS) {
      const next = desired[key];
      const applied = record.applied[key];

      if (next) {
        if (applied !== next) {
          patch[key] = next;
        }
        continue;
      }

      // A key dropped from the config while the group stays on must go back to native.
      if (applied === undefined) {
        continue;
      }

      // Only hand back a key we still own; anything the page recolored stays as it is.
      if (safe(() => instance.options[key], undefined) === applied) {
        patch[key] = record.original[key];
      }
      cleared.push(key);
    }

    // Book the ownership before writing, for the same re-entrancy reason as the stamp.
    // A failed write rolls the bookkeeping back.
    const previousApplied = record.applied;
    const nextApplied = { ...previousApplied };
    for (const key of COLOR_KEYS) {
      if (desired[key]) {
        nextApplied[key] = desired[key];
      }
    }

    for (const key of cleared) {
      delete nextApplied[key];
    }

    record.applied = nextApplied;
    if (!writeInstanceOptions(instance, patch)) {
      record.applied = previousApplied;
      return false;
    }

    // setOptions may have re-entered and torn the record down; regions must not resurrect it.
    if (disposed || !config.enabled || records.get(instance) !== record) {
      return false;
    }
    if (!bindings.isCurrent() || readWaveMetadata(instance, meta.trackId, bindings) !== meta) {
      scheduleRescan();
      return false;
    }

    if (!record.regionsPlugin) {
      record.regionsPlugin = getRegionsPlugin(instance);
      subscribeRegions(instance, record);
    }

    applyRegions(record);
    return true;
  }

  function restoreInstance(instance, record) {
    const patch = {};
    for (const key of COLOR_KEYS) {
      if (record.applied[key] === undefined) {
        continue;
      }

      // Leave alone anything the page itself recolored after we wrote it.
      if (safe(() => instance.options[key], undefined) === record.applied[key]) {
        patch[key] = record.original[key];
      }
    }

    unsubscribeRegions(record);
    for (const off of record.sourceUnsubscribes) off();
    record.sourceUnsubscribes.length = 0;
    restoreRegions(record);
    restoreStamps(record.stamps);
    writeInstanceOptions(instance, patch);
  }

  function restoreAll() {
    // A restore may itself be nested inside a scan, so the flag is saved and put back
    // rather than cleared; it must never run under a re-entry guard of its own, because
    // skipping it would leave our colors on the instances after a disable.
    const wasBusy = busy;
    busy = true;
    try {
      for (const [instance, record] of Array.from(records.entries())) {
        restoreInstance(instance, record);
      }

      restoreStamps(speakerCellStamps);
      records.clear();
      waveMetadata.clear();
    } finally {
      busy = wasBusy;
    }
  }

  function pruneRecords(live) {
    for (const [instance, record] of records) {
      if (live.has(instance)) continue;
      records.delete(instance);
      restoreInstance(instance, record);
    }
    for (const instance of waveMetadata.keys()) {
      if (!live.has(instance)) waveMetadata.delete(instance);
    }
  }

  function applyCurrentConfig() {
    if (disposed || !config.enabled) {
      return 0;
    }

    if (busy) {
      // Re-entered from page code that our own write woke up. Never recurse: let the
      // debounced rescan reconcile once the outer pass has unwound.
      scheduleRescan();
      return 0;
    }

    const scanGeneration = generation;
    let applied = 0;
    busy = true;
    try {
      const bindings = readBabelPlaybackBindings();
      if (!bindings) {
        restoreAll();
        if (unsubscribeCommits) unsubscribeCommits();
        unsubscribeCommits = null;
        sessionId = null;
        sessionRoot = null;
        lastApplied = 0;
        return 0;
      }
      let editorRoot = findBabelEditorFiber();
      while (editorRoot?.return) editorRoot = editorRoot.return;
      const currentRoot = editorRoot?.stateNode;
      if (sessionId !== bindings.reviewActionId || sessionRoot !== currentRoot) {
        restoreAll();
        if (disposed || generation !== scanGeneration) return 0;
        if (unsubscribeCommits) unsubscribeCommits();
        unsubscribeCommits = null;
        sessionId = bindings.reviewActionId;
        sessionRoot = currentRoot;
      }
      if (!unsubscribeCommits) {
        // Native commits also cover property-only speaker changes and registry updates.
        // Failure to acquire the verified hook is explicit, not a polling fallback.
        unsubscribeCommits = subscribeBabelEditorCommits(scheduleRescan);
      }
      const live = new Set();
      const ambiguous = new Set();
      const laneByTrackId = Object.create(null);
      for (const entry of bindings.waveTracks) {
        const instance = entry.wave;
        if (ambiguous.has(instance)) continue;
        if (live.has(instance)) {
          live.delete(instance);
          ambiguous.add(instance);
          continue;
        }
        const meta = readWaveMetadata(instance, entry.trackId, bindings);
        if (!meta || !meta.host.isConnected) continue;
        live.add(instance);
      }
      pruneRecords(live);
      for (const instance of live) {
        if (disposed || generation !== scanGeneration || !bindings.isCurrent()) break;
        const meta = waveMetadata.get(instance);
        const record = records.get(instance);
        if (record && record.meta !== meta) {
          records.delete(instance);
          restoreInstance(instance, record);
          if (disposed || generation !== scanGeneration || !bindings.isCurrent()) break;
        }
        // Hidden native lanes remain owned/restorable but do not require canvas work.
        if (!isVisibleWaveHost(meta.host)) continue;
        laneByTrackId[meta.trackId] = {
          laneIndex: meta.laneIndex,
          slotIndex: ((meta.laneIndex - 1) % LANE_SLOT_COUNT) + 1,
          label: meta.label
        };
        if (applyToInstance(instance, meta, bindings)) applied += 1;
      }

      if (!disposed && config.enabled && generation === scanGeneration && bindings.isCurrent()) {
        stampSpeakerCells(laneByTrackId);
      }
    } finally {
      busy = false;
    }

    if (generation !== scanGeneration) {
      scheduleRescan();
    }

    // Only a pass that actually ran reports; the guarded early returns above leave the last
    // real count in place so an unchanged-config call can answer without rescanning.
    lastApplied = applied;
    return applied;
  }

  function cancelRescan() {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = 0;
    }
  }

  function scheduleRescan() {
    if (disposed || !config.enabled || rescanTimer) {
      return;
    }

    const scheduledGeneration = generation;
    rescanTimer = setTimeout(() => {
      rescanTimer = 0;
      if (disposed || !config.enabled || scheduledGeneration !== generation) {
        return;
      }

      applyCurrentConfig();
    }, RESCAN_DELAY_MS);
  }

  function hasAddedElement(mutations) {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') {
        continue;
      }

      for (const node of safe(() => Array.from(mutation.addedNodes), [])) {
        if (node instanceof HTMLElement) {
          return true;
        }
      }
    }

    return false;
  }

  function startObserver() {
    if (observer || typeof MutationObserver !== 'function') {
      return;
    }

    const root = document.body instanceof HTMLElement ? document.body : document.documentElement;
    if (!root) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      // Select options and turn identity can update without mounting a new lane.
      if (hasAddedElement(mutations) || mutations.some((mutation) =>
        mutation.type === 'attributes' &&
        ['value', 'selected', 'data-annotation-id'].includes(mutation.attributeName))) {
        scheduleRescan();
      }
    });
    safe(() => observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'selected', 'data-annotation-id'] }), null);
  }

  function handleSpeakerChange(event) {
    if (event.target instanceof Element && event.target.matches('section[data-annotation-id] select[id^="speaker-"]')) {
      scheduleRescan();
    }
  }

  function stopObserver() {
    cancelRescan();
    if (unsubscribeCommits) {
      unsubscribeCommits();
      unsubscribeCommits = null;
    }
    sessionId = null;
    sessionRoot = null;

    if (!observer) {
      return;
    }

    safe(() => observer.disconnect(), null);
    observer = null;
  }

  function applyConfig(detail) {
    if (disposed) {
      return 0;
    }

    const next = detail && typeof detail === 'object' ? detail : {};
    const enabled = Boolean(next.enabled);
    const lanes = normalizeLanes(next.lanes);

    // A colour drag re-dispatches this payload on every pointer move, and most of those
    // dispatches carry exactly what the page already wears: the dial that moved feeds a
    // token no lane slot reads, or the same slot arrived twice inside one frame. Everything
    // below reconciles the native registry, speaker cells and lane options, so an unchanged
    // payload stops here. It stops
    // before the rescan is cancelled too: a reconciliation already in flight is still owed
    // to this very config, so dropping it would strand a lane that mounted mid-debounce.
    if (enabled === config.enabled && lanesEqual(lanes, config.lanes)) {
      return config.enabled ? lastApplied : 0;
    }

    // A pending rescan belongs to the previous generation; drop it so a lane mounting right
    // after this change can arm a fresh timer instead of being swallowed by the stale one.
    cancelRescan();
    const wasEnabled = config.enabled;
    generation += 1;
    config.enabled = enabled;
    config.lanes = lanes;

    if (!config.enabled) {
      stopObserver();
      if (wasEnabled || records.size || speakerCellStamps.length) {
        restoreAll();
      }
      lastApplied = 0;
      return 0;
    }

    const applied = applyCurrentConfig();
    startObserver();
    return applied;
  }

  function handleConfigEvent(event) {
    applyConfig(event && event.detail);
  }

  function dispose() {
    if (disposed) {
      return;
    }

    disposed = true;
    stopObserver();
    restoreAll();
    config.enabled = false;
    config.lanes = null;
    window.removeEventListener(CONFIG_EVENT, handleConfigEvent, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    document.removeEventListener('change', handleSpeakerChange, true);
    delete window[GLOBAL_KEY];
  }

  window.addEventListener(CONFIG_EVENT, handleConfigEvent, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);
  document.addEventListener('change', handleSpeakerChange, true);

  window[GLOBAL_KEY] = {
    applyConfig,
    getConfig: () => ({
      enabled: config.enabled,
      lanes: config.lanes ? config.lanes.map((slot) => (slot ? { ...slot } : null)) : null
    }),
    refresh: () => applyCurrentConfig(),
    instanceCount: () => records.size,
    laneInfo: () =>
      Array.from(records.values())
        .map((record) => ({ laneIndex: record.laneIndex, label: record.label, trackId: record.trackId }))
        .sort((left, right) => left.laneIndex - right.laneIndex),
    dispose
  };
})();
