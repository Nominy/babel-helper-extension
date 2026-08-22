// ==UserScript==
// @name         Babel Mods - Replacer Linter
// @namespace    https://dashboard.babel.audio/babel-mods/examples
// @version      1.1.0
// @description  Adds configurable literal replacement errors and autofixes to Babel Helper's linter.
// @match        https://dashboard.babel.audio/*
// @run-at       document-start
// @sandbox      raw
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'babel-mods.replacer-linter.pairs.v1';
  const DEFAULT_PAIRS = Object.freeze([
    Object.freeze({ from: 'Да- да- да', to: 'Да-да-да' }),
    Object.freeze({ from: 'Да- да', to: 'Да-да' })
  ]);

  let pairs = loadPairs();
  let settingsHost = null;

  function normalizePairs(value) {
    if (!Array.isArray(value)) return null;

    const normalized = [];
    const sources = new Set();
    for (const pair of value) {
      if (!pair || typeof pair.from !== 'string' || typeof pair.to !== 'string') continue;
      if (!pair.from || sources.has(pair.from)) continue;
      sources.add(pair.from);
      normalized.push({ from: pair.from, to: pair.to });
    }
    return normalized;
  }

  function loadPairs() {
    try {
      const normalized = normalizePairs(GM_getValue(STORAGE_KEY, null));
      if (normalized) return normalized;
    } catch (_error) {
      // Fall back to defaults when Tampermonkey storage is unavailable or malformed.
    }
    return DEFAULT_PAIRS.map((pair) => ({ ...pair }));
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function createMatcher() {
    const sources = [...new Set(pairs.map((pair) => pair.from).filter(Boolean))]
      .sort((left, right) => right.length - left.length);
    return sources.length ? new RegExp(sources.map(escapeRegExp).join('|'), 'g') : null;
  }

  const rule = {
    id: 'community-replacer',
    reason: 'Configured sequence should be replaced',
    severity: 'error',
    get markers() {
      return pairs.map((pair) => pair.from);
    },
    getMatches(entry) {
      const text = typeof entry?.text === 'string' ? entry.text : '';
      const matcher = createMatcher();
      if (!matcher || !text) return [];

      return [...text.matchAll(matcher)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
      }));
    },
    fix(text) {
      if (typeof text !== 'string' || !text) return text;
      const matcher = createMatcher();
      if (!matcher) return text;
      const replacements = new Map(pairs.map((pair) => [pair.from, pair.to]));
      return text.replace(matcher, (match) => replacements.get(match) ?? match);
    }
  };

  function openSettings() {
    if (settingsHost?.isConnected) {
      settingsHost.shadowRoot.querySelector('input')?.focus();
      return;
    }

    const host = document.createElement('div');
    host.dataset.babelMod = 'community-replacer-settings';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        button, input { font: inherit; }
        .panel {
          position: fixed;
          top: 50%;
          left: 50%;
          z-index: 2147483647;
          display: flex;
          width: min(620px, calc(100vw - 28px));
          max-height: min(75vh, 680px);
          box-sizing: border-box;
          transform: translate(-50%, -50%);
          flex-direction: column;
          gap: 10px;
          border: 1px solid #c7c0dc;
          border-radius: 8px;
          padding: 14px;
          color: #211a35;
          background: #fff;
          box-shadow: 0 12px 45px rgb(0 0 0 / 35%);
          font: 13px/1.4 system-ui, sans-serif;
        }
        .header, .actions, .pair { display: flex; align-items: center; gap: 8px; }
        .header { justify-content: space-between; }
        h2 { margin: 0; font-size: 16px; }
        .close, .remove {
          border: 0;
          padding: 4px 7px;
          color: #544b68;
          background: transparent;
          cursor: pointer;
        }
        .help { margin: 0; color: #615a70; }
        .pairs { display: flex; overflow: auto; flex-direction: column; gap: 7px; }
        .pair input {
          min-width: 0;
          flex: 1;
          box-sizing: border-box;
          border: 1px solid #bcb5ca;
          border-radius: 4px;
          padding: 6px 7px;
          color: #211a35;
          background: #fff;
        }
        .arrow { flex: 0 0 auto; color: #736b82; }
        .actions { flex-wrap: wrap; }
        .actions button {
          border: 1px solid #a69db8;
          border-radius: 4px;
          padding: 6px 9px;
          color: #2f2840;
          background: #f6f4fa;
          cursor: pointer;
        }
        .actions .save { border-color: #6d5aa7; color: #fff; background: #4d3a86; }
        .status { min-height: 1.4em; margin-left: auto; color: #a12626; }
      </style>
      <section class="panel" role="dialog" aria-modal="true" aria-label="Replacer linter settings">
        <div class="header">
          <h2>Replacer linter</h2>
          <button class="close" type="button" aria-label="Close">Close</button>
        </div>
        <p class="help">Each literal sequence is reported as an error. Babel Helper autofix replaces it with the value on the right.</p>
        <div class="pairs"></div>
        <div class="actions">
          <button class="add" type="button">Add sequence</button>
          <button class="reset" type="button">Restore defaults</button>
          <button class="save" type="button">Save and close</button>
          <span class="status" role="status"></span>
        </div>
      </section>
    `;

    settingsHost = host;
    const rows = root.querySelector('.pairs');
    const status = root.querySelector('.status');

    function close() {
      host.remove();
      if (settingsHost === host) settingsHost = null;
    }

    function addRow(pair = { from: '', to: '' }) {
      const row = document.createElement('div');
      row.className = 'pair';

      const from = document.createElement('input');
      from.type = 'text';
      from.className = 'from';
      from.placeholder = 'Sequence to flag';
      from.value = pair.from;
      from.setAttribute('aria-label', 'Sequence to flag');

      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';

      const to = document.createElement('input');
      to.type = 'text';
      to.className = 'to';
      to.placeholder = 'Replacement';
      to.value = pair.to;
      to.setAttribute('aria-label', 'Replacement');

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => row.remove());

      row.append(from, arrow, to, remove);
      rows.append(row);
      return from;
    }

    function render(nextPairs) {
      rows.replaceChildren();
      for (const pair of nextPairs) addRow(pair);
    }

    root.querySelector('.close').addEventListener('click', close);
    root.querySelector('.add').addEventListener('click', () => addRow().focus());
    root.querySelector('.reset').addEventListener('click', () => render(DEFAULT_PAIRS));
    root.querySelector('.save').addEventListener('click', () => {
      const nextPairs = [...rows.querySelectorAll('.pair')].map((row) => ({
        from: row.querySelector('.from').value,
        to: row.querySelector('.to').value
      }));
      const emptySource = nextPairs.some((pair) => pair.from.length === 0);
      const uniqueSources = new Set(nextPairs.map((pair) => pair.from));
      if (emptySource) {
        status.textContent = 'Every source sequence must be non-empty.';
        return;
      }
      if (uniqueSources.size !== nextPairs.length) {
        status.textContent = 'Source sequences must be unique.';
        return;
      }

      pairs = nextPairs;
      try {
        GM_setValue(STORAGE_KEY, pairs);
        close();
      } catch (error) {
        console.warn('[Babel Mods:Replacer] Could not persist settings.', error);
        status.textContent = 'Applied for this page, but Tampermonkey storage failed.';
      }
    });
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    render(pairs);
    document.documentElement.append(host);
    root.querySelector('input')?.focus();
  }

  GM_registerMenuCommand('Configure Replacer linter…', openSettings, {
    title: 'Edit literal replacements used by the Babel Helper linter'
  });

  const definition = {
    id: 'community.replacer-linter',
    name: 'Replacer Linter',
    version: '1.1.0',
    apiVersion: 1,
    setup({ registries, scope }) {
      registries.add('linter.rules', rule, { id: rule.id });
      scope.add(() => {
        settingsHost?.remove();
        settingsHost = null;
      });
    }
  };

  const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;
  if (pageWindow.BabelModsSDK) {
    pageWindow.BabelModsSDK.register(definition);
  } else if (pageWindow.BabelMods) {
    pageWindow.BabelMods.register(definition);
  } else {
    (pageWindow.__BABEL_MOD_QUEUE__ ||= []).push(definition);
  }
})();
