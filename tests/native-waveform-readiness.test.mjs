import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/content/native-waveform-readiness.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
const source = bundle.outputFiles[0].text;
const first = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const second = await import(`data:text/javascript;base64,${Buffer.from(source + '\n// independent MAIN bundle').toString('base64')}`);

class Wave {
  decoded = null;
  calls = [];
  listeners = new Map();
  getDecodedData() { return this.decoded; }
  zoom(value) {
    if (!this.decoded) throw new Error('No audio loaded');
    this.calls.push(value);
    this.emit('zoom', value);
  }
  on(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
    return () => this.un(name, listener);
  }
  un(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, ...args) { for (const listener of [...this.listeners.get(name) || []]) listener(...args); }
}

test('native ready zoom synchronization waits for the other decoded lane without polling', () => {
  const a = new Wave(), b = new Wave();
  a.on('ready', () => a.zoom(100));
  a.on('zoom', value => b.zoom(value));
  const release = first.acquireNativeZoomReadiness(b);
  a.decoded = {};
  a.emit('ready');
  assert.deepEqual(a.calls, [100]);
  assert.deepEqual(b.calls, [], 'an unloaded lane cannot receive a renderer zoom');
  b.zoom(250);
  b.decoded = {};
  b.emit('ready');
  assert.deepEqual(b.calls, [250], 'the latest requested zoom is applied on actual readiness');
  release();
});

test('a newer native ready-handler zoom supersedes the earlier queued value', () => {
  const wave = new Wave();
  wave.on('ready', () => wave.zoom(300));
  const release = first.acquireNativeZoomReadiness(wave);
  wave.zoom(100);
  wave.decoded = {};
  wave.emit('ready');
  assert.deepEqual(wave.calls, [300]);
  release();
});

test('independent owners share one native guard and release pending work without stale replay', () => {
  const wave = new Wave(), original = wave.zoom;
  const a = first.acquireNativeZoomReadiness(wave);
  const b = second.acquireNativeZoomReadiness(wave);
  const wrapped = wave.zoom;
  wave.zoom(200);
  a();
  assert.equal(wave.zoom, wrapped);
  b();
  assert.equal(wave.zoom, original);
  assert.equal(Object.hasOwn(wave, 'zoom'), false);
  wave.decoded = {};
  wave.emit('ready');
  assert.deepEqual(wave.calls, []);
  assert.equal(wave.listeners.get('ready').size, 0);
  a(); b();
});

test('destroyed or invalid native readiness cannot replay zoom or hide a failure', () => {
  const wave = new Wave(), original = wave.zoom;
  const release = first.acquireNativeZoomReadiness(wave);
  wave.zoom(100);
  assert.throws(() => wave.emit('ready'), /no decoded audio/);
  wave.emit('destroy');
  assert.equal(wave.zoom, original);
  wave.decoded = {};
  wave.emit('ready');
  assert.deepEqual(wave.calls, []);
  release();
  const unsupported = new Wave();
  unsupported.un = undefined;
  assert.throws(() => first.acquireNativeZoomReadiness(unsupported), /notifications are unavailable/);
  assert.equal(unsupported.zoom, original);
});
