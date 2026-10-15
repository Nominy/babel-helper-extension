import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolveObjectURL } from 'node:buffer';
import { AudioWorkerFixture } from './fixtures/audio-enhancement-worker.mjs';

const bundle = await build({ entryPoints: ['src/content/audio-enhancement-worker-client.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { AudioEnhancementWorkerClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const mixBundle = await build({ entryPoints: ['src/content/audio-enhancement-mix.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { mixEnhancementWav, readSourceWavHeader } = await import(`data:text/javascript;base64,${Buffer.from(mixBundle.outputFiles[0].contents).toString('base64')}`);

function pcm16(samples) {
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  view.setUint32(0, 0x52494646, false); view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(8, 0x57415645, false); view.setUint32(12, 0x666d7420, false); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

function owner(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: AudioWorkerFixture });
  AudioWorkerFixture.instances = [];
  AudioWorkerFixture.onRequest = null;
  const client = new AudioEnhancementWorkerClient('chrome-extension://helper/dist/content/audio-enhancement-worker.js');
  t.after(() => {
    client.dispose();
    AudioWorkerFixture.onRequest = null;
    for (const worker of AudioWorkerFixture.instances) worker.terminate();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else delete globalThis.Worker;
  });
  return client;
}

test('real worker serializes decoded channels without detaching native data, and mixes exact paired PCM', async t => {
  const client = owner(t);
  const channels = [new Float32Array([0.75, -0.75, 2, -2]), new Float32Array([-0.25, 0.25, 2, -2])];
  const before = channels.map(channel => channel.slice());
  const serialized = await client.encode({ numberOfChannels: 2, sampleRate: 48000, getChannelData: channel => channels[channel] });
  assert.deepEqual(channels, before, 'Only owned channel copies transfer to the worker');
  const header = readSourceWavHeader(serialized);
  assert.equal(header.format, 3);
  assert.equal(header.channels, 2);
  assert.equal(header.frameCount, 4);
  const data = new DataView(serialized);
  for (let frame = 0; frame < 4; frame += 1) for (let channel = 0; channel < 2; channel += 1) {
    assert.equal(data.getFloat32(header.dataOffset + (frame * 2 + channel) * 4, true), channels[channel][frame]);
  }
  const enhanced = pcm16([-8192, 8192, 32767, -32768]);
  const source = { original: new Blob([serialized]), enhanced: new Blob([enhanced]) };
  for (const strength of [10, 50, 90]) {
    const mixed = await client.mix([source, source], strength);
    for (const track of mixed) {
      assert.deepEqual(track.bytes, mixEnhancementWav(serialized, enhanced, strength));
      assert.deepEqual(await track.blob.arrayBuffer(), track.bytes, 'Native Blob and active-capture bytes represent exactly the same mix');
    }
  }
  assert.equal(AudioWorkerFixture.instances.length, 1, 'Settled strengths reuse their session worker');
  assert.equal(resolveObjectURL(AudioWorkerFixture.instances[0].url), undefined, 'Loaded bootstrap URLs are revoked');
});

test('superseded mixing terminates its real worker, rejects stale ownership and retains Original blobs', async t => {
  const client = owner(t);
  const original = pcm16([100, -200, 300]), enhanced = pcm16([500, -600, 700]);
  const source = { original: new Blob([original]), enhanced: new Blob([enhanced]) };
  const obsolete = client.mix([source, source], 90);
  const rejected = assert.rejects(obsolete, /superseded/);
  const retired = AudioWorkerFixture.instances[0];
  client.cancelMix();
  await rejected;
  assert.equal(retired.terminated, true);
  assert.equal(resolveObjectURL(retired.url), undefined);
  assert.deepEqual(await source.original.arrayBuffer(), original, 'Cancellation cannot detach the retained restoration source');
  const latest = await client.mix([source, source], 30);
  assert.equal(AudioWorkerFixture.instances.length, 2);
  assert.deepEqual(latest[0].bytes, mixEnhancementWav(original, enhanced, 30));
  const pending = client.mix([source, source], 60);
  const released = assert.rejects(pending, /session was released/);
  client.dispose();
  await released;
  assert.ok(AudioWorkerFixture.instances.every(worker => worker.terminated));
  await assert.rejects(client.mix([source, source], 70), /session was released/);
});

test('worker processing failures remain explicit and never retry or damage retained endpoint bytes', async t => {
  const client = owner(t);
  const original = pcm16([100, 200]);
  const source = { original: new Blob([original]), enhanced: new Blob([pcm16([300])]) };
  await assert.rejects(client.mix([source, source], 50), /source clock/);
  assert.ok(AudioWorkerFixture.instances[0].terminated);
  await assert.rejects(client.mix([source, source], 50), /source clock/);
  assert.equal(AudioWorkerFixture.instances.length, 1, 'A failed worker does not silently restart');
  assert.deepEqual(await source.original.arrayBuffer(), original);
});
