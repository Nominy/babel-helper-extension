// ==UserScript==
// @name         Babel Mods - Session Indicator Example
// @namespace    https://dashboard.babel.audio/babel-mods/examples
// @version      1.0.0
// @description  Registers a native MAIN-world Babel mod with deterministic session cleanup.
// @match        https://dashboard.babel.audio/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const definition = {
    id: 'example.session-indicator',
    name: 'Session Indicator Example',
    version: '1.0.0',
    apiVersion: 1,

    setup({ logger }) {
      logger.info('registered');
    },

    activate({ scope, logger }) {
      const indicator = document.createElement('span');
      indicator.dataset.babelMod = 'example.session-indicator';
      indicator.textContent = 'Babel Mods active';
      Object.assign(indicator.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        zIndex: '2147483647',
        padding: '5px 8px',
        borderRadius: '4px',
        color: '#fff',
        background: '#4d3a86',
        font: '12px/1.3 sans-serif'
      });
      document.documentElement.append(indicator);
      scope.add(() => indicator.remove());
      logger.info('session active');
    },

    deactivate({ logger }) {
      logger.info('session inactive');
    }
  };

  if (window.BabelModsSDK) {
    window.BabelModsSDK.register(definition);
  } else if (window.BabelMods) {
    window.BabelMods.register(definition);
  } else {
    (window.__BABEL_MOD_QUEUE__ ||= []).push(definition);
  }
})();
