// ==UserScript==
// @name         Babel Mods - Playback Decoration Example
// @namespace    https://dashboard.babel.audio/babel-mods/examples
// @version      1.0.0
// @description  Demonstrates trusted low-level, reversible service interception in the MAIN world.
// @match        https://dashboard.babel.audio/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const definition = {
    id: 'example.playback-observer',
    name: 'Playback Observer Example',
    version: '1.0.0',
    apiVersion: 1,
    optional: ['page.playback'],

    setup({ unsafe, logger }) {
      // The interceptor is owner-scoped automatically. It keeps the original
      // method synchronous and preserves its receiver, arguments, return value,
      // and thrown errors through call.next().
      unsafe.services.intercept(
        'page.playback',
        'setPaused',
        (call) => {
          logger.info('setPaused', call.args[0]);
          return call.next(...call.args);
        }
      );
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
