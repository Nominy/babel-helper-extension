// @ts-nocheck
// Wavesurfer paints the waveform into a canvas and the regions plugin writes its colours as
// inline styles inside a shadow root, so neither can be themed from a page stylesheet. This
// page-world bridge locates the live Wavesurfer instances behind the dashboard's React tree
// and drives them directly, remembering every value it overwrites so a disable restores the
// page exactly.
//
// The dashboard colours lanes from a three-slot palette rotated over the track array
// (`palette[index % 3]`), so the bridge mirrors that shape: `detail.lanes` is three slots and
// a lane picks `lanes[(laneIndex - 1) % 3]`. Lane identity comes from the app's own track
// descriptors (`{ id, label, processedRecordingId, colors }`) and their position in the track
// array, falling back to document order when the descriptor cannot be reached.
//
// The payload is exactly `{ enabled, lanes }`: the runtime derives every slot colour from the
// core palette (wave from the shared wave colour, progress/region from the speaker colour,
// cursor from the text colour) and the bridge only places them. A lane without a slot is left
// entirely native, which is also what a disabled group looks like.
//
// Ownership split with website-appearance.css: the bridge owns the canvas colours
// (waveColor/progressColor), the cursor and the region fill/border of a stamped lane; the
// stylesheet owns the lane frame and the speaker-table text, keyed off the
// `data-babel-helper-lane-slot` / `data-babel-helper-lane-index` /
// `data-babel-helper-speaker-label` attributes this bridge stamps on the wavesurfer host and
// on the lane root.
(function waveformThemeBridge() {
  const CONFIG_EVENT = 'babel-helper-waveform-theme-config';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const GLOBAL_KEY = '__babelHelperWaveformThemeBridge';
  const RESCAN_DELAY_MS = 160;
  const MAX_HOSTS = 200;
  const MAX_SEEDS = 220;
  const MAX_VISITS = 600;
  const MAX_DEPTH = 3;
  const MAX_LANE_ROOT_HOPS = 6;
  const MAX_TRACK_LIST = 64;
  const MAX_PLUGINS = 16;
  const MAX_REGIONS = 400;
  const MAX_SPEAKER_CELLS = 600;
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
    // and the speaker-table text are stylesheet-owned off the stamps, so they never ride here.
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

  function getVisibleWaveHosts() {
    const elements = safe(() => Array.from(document.querySelectorAll('div')), []);
    const hosts = [];

    for (const element of elements) {
      if (hosts.length >= MAX_HOSTS) {
        break;
      }

      if (isVisibleWaveHost(element)) {
        hosts.push(element);
      }
    }

    return hosts;
  }

  function getReactInternalValue(element, prefix) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    for (const name of safe(() => Object.getOwnPropertyNames(element), [])) {
      if (typeof name === 'string' && name.indexOf(prefix) === 0) {
        return safe(() => element[name], null);
      }
    }

    return null;
  }

  function getElementChain(host) {
    const chain = [];
    let current = host;
    let depth = 0;

    while (current instanceof HTMLElement && depth < 8) {
      chain.push(current);

      if (current.parentElement instanceof HTMLElement) {
        current = current.parentElement;
        depth += 1;
        continue;
      }

      const root = safe(() => current.getRootNode(), null);
      if (root && root.host instanceof HTMLElement && root.host !== current) {
        current = root.host;
        depth += 1;
        continue;
      }

      break;
    }

    return chain;
  }

  function pushSeed(seeds, seen, value) {
    if (!isObjectLike(value) || seen.has(value) || seeds.length >= MAX_SEEDS) {
      return;
    }

    seen.add(value);
    seeds.push(value);
  }

  function pushHookSeeds(seeds, seen, fiber) {
    let hook = safe(() => fiber.memoizedState, null);
    const seenHooks = new Set();
    let index = 0;

    while (isObjectLike(hook) && !seenHooks.has(hook) && index < 12) {
      seenHooks.add(hook);
      const memoizedState = safe(() => hook.memoizedState, null);
      pushSeed(seeds, seen, memoizedState);
      pushSeed(seeds, seen, safe(() => memoizedState.current, null));
      pushSeed(seeds, seen, safe(() => memoizedState.value, null));
      hook = safe(() => hook.next, null);
      index += 1;
    }
  }

  function pushFiberSeeds(seeds, seen, fiber) {
    let current = fiber;
    let depth = 0;

    while (isObjectLike(current) && depth < 10) {
      pushSeed(seeds, seen, current);
      pushSeed(seeds, seen, safe(() => current.stateNode, null));
      pushSeed(seeds, seen, safe(() => current.ref, null));
      pushSeed(seeds, seen, safe(() => current.ref.current, null));
      pushSeed(seeds, seen, safe(() => current.memoizedProps, null));
      pushSeed(seeds, seen, safe(() => current.memoizedProps.ref, null));
      pushSeed(seeds, seen, safe(() => current.memoizedProps.ref.current, null));
      pushHookSeeds(seeds, seen, current);
      current = safe(() => current.return, null);
      depth += 1;
    }
  }

  function getSearchSeeds(host) {
    const seeds = [];
    const seen = new Set();

    for (const element of getElementChain(host)) {
      pushSeed(seeds, seen, getReactInternalValue(element, '__reactProps$'));
      pushFiberSeeds(seeds, seen, getReactInternalValue(element, '__reactFiber$'));
    }

    return seeds;
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

  // The dashboard's track descriptor, verbatim from its own bundle:
  // { id, label, description, audioUrl, processedRecordingId, colors }. Requiring all three
  // of label/processedRecordingId/colors keeps arbitrary props from being mistaken for a lane.
  function isTrackDescriptor(value) {
    return (
      isObjectLike(value) &&
      !Array.isArray(value) &&
      typeof safe(() => value.label, null) === 'string' &&
      typeof safe(() => value.processedRecordingId, null) === 'string' &&
      isObjectLike(safe(() => value.colors, null))
    );
  }

  function isTrackList(value) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_TRACK_LIST) {
      return false;
    }

    for (const entry of value) {
      if (!isTrackDescriptor(entry)) {
        return false;
      }
    }

    return true;
  }

  function collectHostInstances(host, found) {
    // Bounded breadth-first walk: the instance sits either directly on a ref/hook seed
    // or a couple of hops inside a lane registry such as { [laneId]: { wavesurfer } }.
    // The same walk harvests the lane's track descriptor and the track array it belongs to,
    // so lane identity costs no extra traversal.
    const queue = getSearchSeeds(host).map((value) => ({ value, depth: 0 }));
    const visited = new Set();
    const meta = { track: null, tracks: null };

    while (queue.length && visited.size < MAX_VISITS) {
      const current = queue.shift();
      const value = current.value;
      if (!isObjectLike(value) || visited.has(value)) {
        continue;
      }

      visited.add(value);

      if (isThemableInstance(value, host)) {
        found.add(value);
        continue;
      }

      if (!meta.track && isTrackDescriptor(value)) {
        // Nearest wins: the lane's own fiber props are seeded before its ancestors'.
        meta.track = value;
      } else if (!meta.tracks && isTrackList(value)) {
        meta.tracks = value;
      }

      if (current.depth >= MAX_DEPTH || value instanceof HTMLElement) {
        continue;
      }

      const keys = safe(() => Object.keys(value), []);
      if (!keys.length || keys.length > 64) {
        continue;
      }

      for (const key of keys) {
        queue.push({ value: safe(() => value[key], null), depth: current.depth + 1 });
      }
    }

    return meta;
  }

  function resolveLaneMeta(host, meta, documentOrderIndex) {
    const track = meta.track;
    let laneIndex = documentOrderIndex;

    if (track && meta.tracks) {
      // The app's own array order is the authority; document order is only the fallback for
      // a lane whose descriptor or array we could not reach within the bounded walk.
      const position = safe(() => meta.tracks.indexOf(track), -1);
      if (typeof position === 'number' && position >= 0) {
        laneIndex = position + 1;
      }
    }

    const label = track ? normalizeColor(safe(() => track.label, null)) : null;
    const trackId = track
      ? normalizeColor(safe(() => track.processedRecordingId, null)) ||
        normalizeColor(safe(() => track.id, null))
      : null;

    return { host, laneIndex, label, trackId };
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

  // The transcript's speaker column is a plain `<td style="color: …">` with no lane
  // identity of its own, and slots 1 and 3 ship the same blue by default, so a colour-value
  // match cannot tell them apart. Matching the cell text against a resolved lane label is
  // the only slot-correct hook, and the stylesheet colours the cell from the stamp.
  function stampSpeakerCells(laneBySpeakerLabel) {
    const labels = Object.keys(laneBySpeakerLabel);
    if (!labels.length) {
      restoreStamps(speakerCellStamps);
      return;
    }

    // Only inline-coloured cells can be ours; the attribute filter keeps the query off the
    // rest of the table and off every other `td` on the page.
    const cells = safe(() => Array.from(document.querySelectorAll('td[style*="color"]')), []);
    const stamped = new Set();
    let visited = 0;

    for (const cell of cells) {
      if (visited >= MAX_SPEAKER_CELLS) {
        break;
      }
      visited += 1;

      if (!(cell instanceof HTMLElement)) {
        continue;
      }

      const text = safe(() => cell.textContent, '');
      const lane = laneBySpeakerLabel[typeof text === 'string' ? text.trim() : ''];
      if (!lane) {
        continue;
      }

      stamped.add(cell);
      stampElements(speakerCellStamps, [cell], {
        [LANE_INDEX_ATTRIBUTE]: String(lane.laneIndex),
        [LANE_SLOT_ATTRIBUTE]: String(lane.slotIndex),
        [LANE_LABEL_ATTRIBUTE]: lane.label
      });
    }

    // A cell that was re-rendered under a different speaker, or scrolled out of the
    // virtualised table, must not keep a stamp we can no longer justify.
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

    return list.length > MAX_REGIONS ? list.slice(0, MAX_REGIONS) : list;
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

  function applyToInstance(instance, meta) {
    let record = records.get(instance);
    if (!record) {
      record = {
        original: captureOriginal(instance),
        applied: {},
        laneIndex: null,
        label: null,
        trackId: null,
        stamps: [],
        regions: new Map(),
        regionColors: null,
        regionsPlugin: getRegionsPlugin(instance),
        regionUnsubscribes: []
      };
      records.set(instance, record);
      subscribeRegions(instance, record);
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
    stampElements(record.stamps, [meta.host, getLaneRoot(meta.host)], {
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
    } finally {
      busy = wasBusy;
    }
  }

  function pruneDetachedRecords(live) {
    for (const instance of Array.from(records.keys())) {
      if (live.has(instance)) {
        continue;
      }

      // Drop a record only when the lane is provably gone; an instance that merely scrolled
      // out of discovery must stay restorable.
      const container = getInstanceContainer(instance);
      if (container && !container.isConnected) {
        const record = records.get(instance);
        unsubscribeRegions(record);
        records.delete(instance);
      }
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
      const live = new Set();
      const metaByInstance = new Map();
      const laneBySpeakerLabel = {};
      let documentOrderIndex = 0;

      for (const host of getVisibleWaveHosts()) {
        documentOrderIndex += 1;
        const hostInstances = new Set();
        const hostMeta = collectHostInstances(host, hostInstances);
        const laneMeta = resolveLaneMeta(host, hostMeta, documentOrderIndex);

        if (laneMeta.label && !laneBySpeakerLabel[laneMeta.label]) {
          laneBySpeakerLabel[laneMeta.label] = {
            laneIndex: laneMeta.laneIndex,
            slotIndex: ((laneMeta.laneIndex - 1) % LANE_SLOT_COUNT) + 1,
            label: laneMeta.label
          };
        }

        for (const instance of hostInstances) {
          live.add(instance);
          if (!metaByInstance.has(instance)) {
            metaByInstance.set(instance, laneMeta);
          }
        }
      }

      pruneDetachedRecords(live);

      for (const instance of live) {
        if (disposed || generation !== scanGeneration) {
          // A nested config change or teardown invalidated this pass mid-flight.
          break;
        }

        if (applyToInstance(instance, metaByInstance.get(instance))) {
          applied += 1;
        }
      }

      if (!disposed && config.enabled && generation === scanGeneration) {
        stampSpeakerCells(laneBySpeakerLabel);
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
      // Newly mounted lanes only ever arrive as added elements; attribute and text
      // churn on the dashboard must not cost us a rescan.
      if (hasAddedElement(mutations)) {
        scheduleRescan();
      }
    });
    safe(() => observer.observe(root, { childList: true, subtree: true }), null);
  }

  function stopObserver() {
    cancelRescan();

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
    // below is host discovery, a bounded React-tree walk per host, a `td[style*="color"]`
    // query and a setOptions on every lane, so an unchanged payload stops here. It stops
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
    delete window[GLOBAL_KEY];
  }

  window.addEventListener(CONFIG_EVENT, handleConfigEvent, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

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
