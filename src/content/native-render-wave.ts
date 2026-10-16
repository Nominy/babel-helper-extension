// @ts-nocheck
import {
  highlightRegion, invalidateRegion, invalidateNativeTimeline, readNativeRegionState,
  releaseNativeRegionState, releaseNativeRegionView, scrollIntoView,
  updateVisibleNotches, virtualAppendRegion
} from './native-render-algorithms';

const identifier = '[A-Za-z_$][\\w$]*';
// Inspect only the small method being replaced. No source is executed or rewritten.
function source(callback) {
  const text = Function.prototype.toString.call(callback);
  let compact = '', quote = '', escaped = false;
  for (const character of text) {
    if (quote) {
      compact += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
      compact += character;
    } else if (!/\s/.test(character)) compact += character;
  }
  return compact
    .replace(/\(([A-Za-z_$][\w$]*)\)=>/g, '$1=>').replace(/;}/g, '}').replace(/\+\.05/g, '+0.05');
}
function methods(value, names) { return names.every(name => typeof value?.[name] === 'function'); }
function ownMethod(owner, key, replacement) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor && !descriptor.configurable && (!descriptor.writable || !('value' in descriptor))) return null;
  if (!descriptor && !Object.isExtensible(owner)) return null;
  Object.defineProperty(owner, key, descriptor && !descriptor.configurable
    ? { ...descriptor, value: replacement }
    : { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: replacement });
  return () => {
    const current = Object.getOwnPropertyDescriptor(owner, key);
    if (!current || current.value !== replacement || current.writable !== true ||
        current.configurable !== (descriptor?.configurable ?? true) ||
        current.enumerable !== (descriptor?.enumerable ?? false)) return false;
    if (descriptor) Object.defineProperty(owner, key, descriptor);
    else delete owner[key];
    return true;
  };
}

function timelineContract(callback) {
  const text = source(callback);
  const match = text.match(new RegExp(`^updateVisibleNotches\\((${identifier}),(${identifier}),(${identifier})\\)\\{this\\.notchElements\\.forEach\\(\\((${identifier}),(${identifier})\\)=>\\{let(${identifier})=`));
  if (!match) return false;
  const [, left, right, container, notch, element, visible] = match;
  return text === `updateVisibleNotches(${left},${right},${container}){this.notchElements.forEach((${notch},${element})=>{let${visible}=${notch}.start>=${left}&&${notch}.start+${notch}.width<${right};${visible}!==${notch}.wasVisible&&(${notch}.wasVisible=${visible},${visible}?${container}.appendChild(${element}):${element}.remove())})}`;
}
function scrollContract(callback) {
  const text = source(callback);
  const match = text.match(new RegExp(`^scrollIntoView\\((${identifier}),(${identifier})=(?:!1|false)\\)\\{let\\{scrollLeft:(${identifier}),scrollWidth:(${identifier}),clientWidth:(${identifier})\\}=this\\.scrollContainer,(${identifier})=\\1\\*\\4,(${identifier})=\\3\\+\\5,(${identifier})=\\5/2;`));
  if (!match) return false;
  const [, progress, playing, left, width, client, position, right, half] = match;
  const delta = text.match(new RegExp(`;let(${identifier})=${position}-${left}-${half};`))?.[1];
  if (!delta) return false;
  return text.slice(match[0].length) === `if(this.isDragging)${position}+30>${right}?this.scrollContainer.scrollLeft+=30:${position}-30<${left}&&(this.scrollContainer.scrollLeft-=30);else{(${position}<${left}||${position}>${right})&&(this.scrollContainer.scrollLeft=${position}-(this.options.autoCenter?${half}:0));let${delta}=${position}-${left}-${half};${playing}&&this.options.autoCenter&&${delta}>0&&(this.scrollContainer.scrollLeft+=${delta})}}`;
}
function viewportContract(callback) {
  const text = source(callback);
  const match = text.match(new RegExp(`^virtualAppend\\((${identifier}),(${identifier}),(${identifier})\\)\\{let(${identifier})=\\(\\)=>\\{if\\(!this\\.wavesurfer\\)return;let(${identifier})=this\\.wavesurfer\\.getWidth\\(\\),(${identifier})=this\\.wavesurfer\\.getScroll\\(\\),(${identifier})=\\2\\.clientWidth,(${identifier})=this\\.wavesurfer\\.getDuration\\(\\),(${identifier})=Math\\.round\\(\\1\\.start/\\8\\*\\7\\),(${identifier})=`));
  if (!match) return false;
  const [, region, container, element, update, width, left, totalWidth, duration, start, visible] = match;
  const listeners = text.match(new RegExp(`let(${identifier})=this\\.wavesurfer\\.on\\("scroll",${update}\\),(${identifier})=this\\.wavesurfer\\.on\\("zoom",${update}\\),(${identifier})=this\\.wavesurfer\\.on\\("resize",${update}\\);`));
  if (!listeners) return false;
  const [, scroll, zoom, resize] = listeners;
  return text.slice(match[0].length) === `${start}+(Math.round((${region}.end-${region}.start)/${duration}*${totalWidth})||1)>${left}&&${start}<${left}+${width};${visible}&&!${element}.parentElement?${container}.appendChild(${element}):!${visible}&&${element}.parentElement&&${element}.remove()};setTimeout(()=>{if(!this.wavesurfer||!${region}.element)return;${update}();let${scroll}=this.wavesurfer.on("scroll",${update}),${zoom}=this.wavesurfer.on("zoom",${update}),${resize}=this.wavesurfer.on("resize",${update});this.subscriptions.push(${scroll},${zoom},${resize}),${region}.once("remove",()=>{${scroll}(),${zoom}(),${resize}()})},0)}`;
}
function eventContract(callback) {
  const text = source(callback);
  const match = text.match(new RegExp(`^(${identifier})=>\\{let(${identifier})=this\\.regions\\.filter\\((${identifier})=>`));
  if (!match) return false;
  const [, time, next, region] = match;
  const rest = text.slice(match[0].length);
  const ending = rest.match(new RegExp(`;${next}\\.forEach\\((${identifier})=>\\{(${identifier})\\.includes\\(\\1\\)\\|\\|this\\.emit\\("region-in",\\1\\)\\}\\),\\2\\.forEach\\((${identifier})=>\\{${next}\\.includes\\(\\3\\)\\|\\|this\\.emit\\("region-out",\\3\\)\\}\\),\\2=${next}\\}$`));
  return !!ending && rest === `${region}.start<=${time}&&(${region}.end===${region}.start?${region}.start+0.05:${region}.end)>=${time})${ending[0]}`;
}
function queryContract(callback) {
  const text = source(callback);
  const time = text.match(new RegExp(`^(${identifier})=>\\{`))?.[1];
  if (!time || (text.match(/getRegions/g) || []).length !== 1 || (text.match(/\.filter\(/g) || []).length !== 1 || (text.match(/\.find\(/g) || []).length !== 2) return false;
  const match = text.match(new RegExp(`\\.filter\\(((${identifier})=>\\2\\.id!==${identifier}&&!${identifier}\\(\\2\\.id\\))\\),${identifier}=(${identifier})\\.find\\((${identifier})=>`));
  if (!match) return false;
  const [, predicate, , eligible, region] = match;
  const last = text.slice(match.index + match[0].length);
  const endRegion = last.match(new RegExp(`\\|\\|${eligible}\\.find\\((${identifier})=>`))?.[1];
  return endRegion && last.startsWith(`${time}>=${region}.start&&${time}<${region}.end)||${eligible}.find(${endRegion}=>${time}>=${endRegion}.start&&${time}===${endRegion}.end&&${endRegion}===${eligible}[${eligible}.length-1]);`) ? predicate : false;
}
function styleLoopContract(callback, activeId) {
  const text = typeof callback === 'string' ? callback : source(callback);
  const match = text.match(new RegExp(`^(${identifier})=>\\{let(${identifier})=\\1\\.element;`));
  if (!match) return false;
  const [, region, element] = match;
  return text === `${region}=>{let${element}=${region}.element;${element}&&(${region}.id===${activeId}?${element}.style.filter="brightness(0.8)":${element}.style.filter="")}`;
}

export function createNativeWaveAdapters(report) {
  let released = false;
  const notices = new Map(), namespaces = new WeakMap(), classes = new WeakMap(), callbacks = new WeakMap();
  const instances = new WeakMap(), owned = new Set(), tracks = new Map();
  const notify = (boundary, state, reason) => {
    if (notices.get(boundary) === 'unsupported' || notices.get(boundary) === state) return;
    notices.set(boundary, state);
    report({ boundary, state, ...(reason ? { reason } : {}) });
  };
  const unsupported = (boundary, reason) => notify(boundary, 'unsupported', reason);
  function record(instance) {
    let state = instances.get(instance);
    if (state) return state;
    state = { instance, releases: [], regions: new Map(), live: true };
    instances.set(instance, state); owned.add(state);
    state.release = (destroyed = false) => {
      if (!state.live) return;
      state.live = false;
      state.destroyed = destroyed;
      for (const dispose of state.releases.reverse()) dispose();
      for (const dispose of state.regions.values()) dispose();
      state.regions.clear(); owned.delete(state);
    };
    if (typeof instance.on === 'function') state.releases.push(instance.on('destroy', () => state.release(true)));
    return state;
  }
  function disableIndex(state, reason) {
    state.indexSupported = false;
    state.releaseViewport?.();
    unsupported('wave-regions-index', reason);
  }
  function bindRegion(plugin, state, region) {
    if (!region || state.regions.has(region) || !state.indexSupported) return;
    if (!methods(region, ['setOptions', 'once'])) {
      disableIndex(state, 'Native region mutation lifecycle changed'); return;
    }
    const original = region.setOptions;
    const restore = ownMethod(region, 'setOptions', function(...args) {
      const start = this.start, end = this.end, id = this.id;
      try { return Reflect.apply(original, this, args); }
      finally { if (this.start !== start || this.end !== end || this.id !== id) invalidateRegion(this); }
    });
    if (!restore) { disableIndex(state, 'Region setOptions is not locally writable'); return; }
    const remove = region.once('remove', () => { restore(); state.regions.delete(region); });
    state.regions.set(region, () => { remove(); restore(); });
  }
  function bindRegions(plugin) {
    if (instances.has(plugin)) return;
    if (!Array.isArray(plugin.regions) || !methods(plugin, ['on', 'onInit', 'getRegions', 'virtualAppend'])) {
      unsupported('wave-regions-index', 'Regions instance lacks its native owned array or lifecycle'); return;
    }
    const state = record(plugin);
    state.indexSupported = true;
    // Index listeners are installed before native mutations and released with this instance.
    readNativeRegionState(plugin);
    state.releases.push(() => releaseNativeRegionState(plugin));
    for (const region of plugin.regions) bindRegion(plugin, state, region);
    state.releases.push(plugin.on('region-initialized', region => bindRegion(plugin, state, region)));
    state.releases.push(plugin.on('region-created', region => bindRegion(plugin, state, region)));
    const virtualAppend = plugin.virtualAppend;
    if (state.indexSupported && viewportContract(virtualAppend)) {
      const restore = ownMethod(plugin, 'virtualAppend', function(region, container, element) {
        if (released || !state.live) return Reflect.apply(virtualAppend, this, arguments);
        return virtualAppendRegion(this, region, container, element);
      });
      if (restore) {
        state.releaseViewport = () => {
          const entries = releaseNativeRegionView(plugin);
          const ours = restore();
          if (ours && !state.destroyed && !plugin.isDestroyed) {
            // Re-establish the real deferred append/listeners for every still-live region.
            for (const entry of entries) if (entry.region.element === entry.element && !entry.region.isRemoved) virtualAppend.call(plugin, entry.region, entry.container, entry.element);
          }
        };
        state.releases.push(state.releaseViewport);
        notify('wave-regions-viewport', 'installed');
      } else unsupported('wave-regions-viewport', 'Region viewport method is not locally writable');
    } else unsupported('wave-regions-viewport', 'Native virtualAppend contract changed');
    const onInit = plugin.onInit;
    const restoreInit = ownMethod(plugin, 'onInit', function(...args) {
      if (released || !state.live || !methods(this.wavesurfer, ['on'])) return Reflect.apply(onInit, this, args);
      const wave = this.wavesurfer, on = wave.on;
      const restoreOn = ownMethod(wave, 'on', function(name, callback, ...options) {
        if (name === 'timeupdate') {
          if (eventContract(callback)) {
            const native = callback;
            callback = function(time, ...rest) {
              if (released || !state.live || !state.indexSupported) return Reflect.apply(native, this, [time, ...rest]);
              const array = plugin.regions;
              if (!Array.isArray(array) || array.filter !== Array.prototype.filter) return Reflect.apply(native, this, [time, ...rest]);
              const restoreFilter = ownMethod(array, 'filter', function(predicate, thisArg) {
                restoreFilter();
                return readNativeRegionState(plugin).eventIndex.query(time, time, true).filter(predicate, thisArg);
              });
              if (!restoreFilter) return Reflect.apply(native, this, [time, ...rest]);
              try { return Reflect.apply(native, this, [time, ...rest]); }
              finally { restoreFilter(); }
            };
            notify('wave-regions-events', 'installed');
          } else unsupported('wave-regions-events', 'Native timeupdate interval callback changed');
        }
        return Reflect.apply(on, this, [name, callback, ...options]);
      });
      if (!restoreOn) unsupported('wave-regions-events', 'Wave event registration is not locally writable');
      try { return Reflect.apply(onInit, this, args); }
      finally { restoreOn?.(); }
    });
    if (restoreInit) state.releases.push(restoreInit);
    else unsupported('wave-regions-events', 'Regions initialization is not locally writable');
  }
  function bindTimeline(plugin) {
    if (instances.has(plugin)) return;
    if (!(plugin.notchElements instanceof Map) || !timelineContract(plugin.updateVisibleNotches)) {
      unsupported('wave-timeline', 'Native visible-notch method changed'); return;
    }
    const state = record(plugin);
    const original = plugin.updateVisibleNotches, init = plugin.initTimeline;
    const restore = ownMethod(plugin, 'updateVisibleNotches', function(left, right, container) {
      if (released || !state.live) return Reflect.apply(original, this, arguments);
      return updateVisibleNotches(this, left, right, container);
    });
    const restoreInit = ownMethod(plugin, 'initTimeline', function(...args) {
      invalidateNativeTimeline(this);
      return Reflect.apply(init, this, args);
    });
    if (!restore || !restoreInit) {
      restore?.(); restoreInit?.(); state.release();
      unsupported('wave-timeline', 'Timeline methods are not locally writable'); return;
    }
    state.releases.push(restore, restoreInit, () => invalidateNativeTimeline(plugin));
    notify('wave-timeline', 'installed');
  }
  function bindWave(wave) {
    if (instances.has(wave)) return;
    const state = record(wave), renderer = wave.renderer;
    if (!renderer || !methods(renderer, ['scrollIntoView']) || !scrollContract(renderer.scrollIntoView) || !renderer.scrollContainer || !renderer.options) {
      unsupported('wave-scroll', 'Native renderer scroll method changed'); return;
    }
    const original = renderer.scrollIntoView;
    const restore = ownMethod(renderer, 'scrollIntoView', function(progress, playing) {
      if (released || !state.live) return Reflect.apply(original, this, arguments);
      return scrollIntoView(this, progress, playing);
    });
    if (restore) { state.releases.push(restore); notify('wave-scroll', 'installed'); }
    else unsupported('wave-scroll', 'Renderer scroll method is not locally writable');
  }
  function adaptClass(value) {
    if (typeof value !== 'function') return value;
    const createDescriptor = Object.getOwnPropertyDescriptor(value, 'create');
    const prototype = Object.getOwnPropertyDescriptor(value, 'prototype')?.value;
    if (typeof createDescriptor?.value !== 'function' || !prototype) return value;
    if (classes.has(value)) return classes.get(value);
    const bind = methods(prototype, ['getRegions', 'addRegion', 'enableDragSelection']) ? bindRegions
      : methods(prototype, ['initTimeline', 'updateVisibleNotches', 'defaultTimeInterval']) ? bindTimeline
        : methods(prototype, ['registerPlugin', 'getDuration', 'getCurrentTime', 'getWrapper']) ? bindWave : null;
    if (!bind) return value;
    const create = function(...args) {
      const result = Reflect.apply(value.create, value, args);
      if (!released) bind(result);
      return result;
    };
    const facade = new Proxy(value, {
      get(target, key, receiver) { return key === 'create' ? create : Reflect.get(target, key, receiver); },
      construct(target, args, newTarget) {
        const result = Reflect.construct(target, args, newTarget === facade ? target : newTarget);
        if (!released) bind(result);
        return result;
      }
    });
    classes.set(value, facade);
    return facade;
  }
  function adaptImport(namespace) {
    if (released || !namespace || !['object', 'function'].includes(typeof namespace)) return namespace;
    if (typeof namespace === 'function') return adaptClass(namespace);
    if (namespaces.has(namespace)) return namespaces.get(namespace);
    const replacements = new Map();
    for (const key of Object.keys(namespace)) {
      const value = namespace[key], facade = adaptClass(value);
      if (value !== facade) replacements.set(key, facade);
    }
    if (!replacements.size) return namespace;
    // A separate target also supports webpack's non-configurable export getters.
    const facade = Object.create(Object.getPrototypeOf(namespace));
    for (const key of Reflect.ownKeys(namespace)) {
      const descriptor = Object.getOwnPropertyDescriptor(namespace, key);
      Object.defineProperty(facade, key, { configurable: true, enumerable: descriptor.enumerable, get: () => replacements.has(key) ? replacements.get(key) : namespace[key] });
    }
    namespaces.set(namespace, facade);
    return facade;
  }
  function adaptCallback(callback) {
    if (typeof callback !== 'function') return callback;
    if (callbacks.has(callback)) return callbacks.get(callback);
    if (released) return callback;
    const text = source(callback);
    let adapted = callback;
    if (text.includes('onTimeUpdate') && text.includes('onReady') && text.includes('wavesurfer:') && text.includes('plugins:') && text.includes('regions:')) {
      adapted = function(track, container, handlers, ...rest) {
        if (released) return Reflect.apply(callback, this, arguments);
        let plugin;
        const original = handlers?.onTimeUpdate;
        let restoreTime;
        const query = typeof original === 'function' && queryContract(original);
        if (query) {
          restoreTime = ownMethod(handlers, 'onTimeUpdate', function(time, ...args) {
            if (released || !plugin || !instances.get(plugin)?.indexSupported) return Reflect.apply(original, this, [time, ...args]);
            const array = plugin.regions;
            if (!Array.isArray(array) || array.filter !== Array.prototype.filter) return Reflect.apply(original, this, [time, ...args]);
            const restoreFilter = ownMethod(array, 'filter', function(predicate, thisArg) {
              if (this !== array || typeof predicate !== 'function' || source(predicate) !== query) return Array.prototype.filter.call(this, predicate, thisArg);
              restoreFilter();
              const candidates = readNativeRegionState(plugin).index.query(time, time, true);
              // Evaluate Babel's actual exclusion predicate, including its closure,
              // against the current tail. The inclusive end rule belongs only to it.
              let last;
              for (let index = array.length - 1; index >= 0; index--) {
                if (predicate.call(thisArg, array[index], index, array)) { last = array[index]; break; }
              }
              if (last && !candidates.includes(last)) candidates.push(last);
              return candidates.filter(predicate, thisArg);
            });
            if (!restoreFilter) {
              unsupported('wave-active-query', 'Native regions filter is not locally writable');
              return Reflect.apply(original, this, [time, ...args]);
            }
            try { return Reflect.apply(original, this, [time, ...args]); }
            finally { restoreFilter(); }
          });
          if (!restoreTime) unsupported('wave-active-query', 'Native onTimeUpdate is not locally writable');
        } else if (typeof original === 'function') unsupported('wave-active-query', 'Native active-region query changed');
        let result;
        try { result = Reflect.apply(callback, this, [track, container, handlers, ...rest]); }
        catch (error) { restoreTime?.(); throw error; }
        plugin = result?.plugins?.regions;
        if (result?.wavesurfer && plugin && methods(plugin, ['getRegions', 'on']) && Array.isArray(plugin.regions)) {
          bindWave(result.wavesurfer); bindRegions(plugin);
          if (result.plugins.timeline) bindTimeline(result.plugins.timeline);
          const state = record(result.wavesurfer);
          tracks.set(track.id, result);
          state.releases.push(() => { if (tracks.get(track.id) === result) tracks.delete(track.id); });
          if (restoreTime) { state.releases.push(restoreTime); notify('wave-active-query', 'installed'); }
        } else {
          restoreTime?.();
          if (result != null) unsupported('wave-active-query', 'Native create callback did not return an owned track');
        }
        return result;
      };
    } else if (text.includes('getRegions') && text.includes('brightness(0.8)')) {
      const parameters = text.match(new RegExp(`^\\((${identifier}),(${identifier})\\)=>`));
      const loop = text.match(/\.forEach\((.*)\)\}$/)?.[1];
      if (parameters && loop) {
        // Validate the complete pure loop as text; surrounding native state updates run unchanged.
        const [, , activeId] = parameters;
        if (styleLoopContract(loop, activeId) && (text.match(/getRegions/g) || []).length === 1 && (text.match(/\.forEach\(/g) || []).length === 1) {
          adapted = function(trackId, regionId, ...args) {
            const plugin = tracks.get(trackId)?.plugins.regions;
            if (released || !plugin || !instances.get(plugin)?.indexSupported) return Reflect.apply(callback, this, [trackId, regionId, ...args]);
            const array = plugin.regions;
            if (!Array.isArray(array) || array.forEach !== Array.prototype.forEach) return Reflect.apply(callback, this, [trackId, regionId, ...args]);
            const restore = ownMethod(array, 'forEach', function(each, thisArg) {
              if (this !== array || typeof each !== 'function' || source(each) !== loop) return Array.prototype.forEach.call(this, each, thisArg);
              restore();
              return highlightRegion(plugin, regionId);
            });
            if (!restore) {
              unsupported('wave-active-style', 'Native regions iteration is not locally writable');
              return Reflect.apply(callback, this, [trackId, regionId, ...args]);
            }
            try { return Reflect.apply(callback, this, [trackId, regionId, ...args]); }
            finally { restore(); }
          };
          notify('wave-active-style', 'installed');
        } else unsupported('wave-active-style', 'Native active-region loop has additional behavior');
      } else unsupported('wave-active-style', 'Native active-region callback changed');
    }
    callbacks.set(callback, adapted);
    return adapted;
  }
  return {
    adaptImport, adaptCallback,
    release() {
      if (released) return;
      released = true;
      for (const state of [...owned]) state.release();
      tracks.clear();
    }
  };
}
