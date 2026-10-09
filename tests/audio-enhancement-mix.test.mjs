import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/content/audio-enhancement-mix.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { mixEnhancementWav, readSourceWavHeader } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

function wav(frames, { format = 1, sampleRate = 44100, metadata = false } = {}) {
  const channels = frames[0].length, width = format === 3 ? 4 : 2;
  const extra = metadata ? 10 : 0, dataOffset = 44 + extra;
  const bytes = new ArrayBuffer(dataOffset + frames.length * channels * width), view = new DataView(bytes);
  view.setUint32(0, 0x52494646, false); view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(8, 0x57415645, false); view.setUint32(12, 0x666d7420, false); view.setUint32(16, 16, true);
  view.setUint16(20, format, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * width, true); view.setUint16(32, channels * width, true); view.setUint16(34, width * 8, true);
  if (metadata) {
    view.setUint32(36, 0x4a554e4b, false); view.setUint32(40, 1, true); view.setUint8(44, 77);
  }
  view.setUint32(dataOffset - 8, 0x64617461, false); view.setUint32(dataOffset - 4, frames.length * channels * width, true);
  frames.forEach((samples, frame) => samples.forEach((sample, channel) => {
    const offset = dataOffset + (frame * channels + channel) * width;
    if (format === 3) view.setFloat32(offset, sample, true); else view.setInt16(offset, sample, true);
  }));
  return bytes;
}

function pcm(bytes) {
  const header = readSourceWavHeader(bytes), view = new DataView(bytes);
  return Array.from({ length: header.frameCount }, (_, frame) => view.getInt16(header.dataOffset + frame * 2, true));
}

const quantize = value => Math.max(-32768, Math.min(32767, Math.round(value * 32768))) || 0;

test('all strengths preserve clocks, arithmetic downmix, and endpoint bytes including metadata', () => {
  const originalFrames = [[-32768, 32767], [12000, -4000], [-20000, -10000], [1, 0], [0, 0]];
  const enhancedFrames = [[32767], [-24000], [16000], [-1], [17]];
  const original = wav(originalFrames, { metadata: true }), enhanced = wav(enhancedFrames, { metadata: true });
  assert.equal(mixEnhancementWav(original, enhanced, 0), original, 'Original is not copied or re-encoded');
  assert.equal(mixEnhancementWav(original, enhanced, 100), enhanced, 'Enhanced is not copied or re-encoded');
  for (let strength = 1; strength < 100; strength += 1) {
    const mixed = mixEnhancementWav(original, enhanced, strength), header = readSourceWavHeader(mixed);
    assert.equal(header.sampleRate, 44100); assert.equal(header.frameCount, originalFrames.length);
    assert.equal(header.channels, 1); assert.equal(header.format, 1); assert.equal(header.bytesPerSample, 2);
    assert.deepEqual(pcm(mixed), originalFrames.map((frame, index) => {
      const originalSample = Math.fround(frame.reduce((sum, sample) => sum + sample / 32768, 0) / frame.length);
      return quantize((1 - strength / 100) * originalSample + strength / 100 * enhancedFrames[index][0] / 32768);
    }));
  }
});

test('float32 channels use enhancement downmix precision without gain, gate, or phase corrections', () => {
  const frames = [[0.75, -0.25], [-0.75, 0.25], [2, 2], [-2, -2], [0.00002, 0.00002], [0, 0]];
  const original = wav(frames, { format: 3, sampleRate: 48000 });
  const enhancedFrames = [[-8192], [8192], [32767], [-32768], [1], [0]];
  const enhanced = wav(enhancedFrames, { sampleRate: 48000 });
  for (const strength of [1, 25, 50, 75, 99]) {
    const mixed = mixEnhancementWav(original, enhanced, strength);
    assert.deepEqual(pcm(mixed), frames.map((frame, index) => {
      const downmixed = Math.fround(frame.reduce((sum, value) => sum + Math.fround(value), 0) / frame.length);
      return quantize((1 - strength / 100) * downmixed + strength / 100 * enhancedFrames[index][0] / 32768);
    }));
    assert.equal(readSourceWavHeader(mixed).sampleRate, 48000);
  }
  assert.equal(pcm(mixEnhancementWav(original, enhanced, 50))[0], 0, 'Opposite-phase samples cancel by arithmetic, without realignment');
  assert.equal(pcm(mixEnhancementWav(original, enhanced, 50))[4], 1, 'Quiet nonzero input is not gated');
  assert.equal(mixEnhancementWav(original, enhanced, 0), original);
});

test('mixing rejects mismatched clocks, malformed PCM, unsupported enhanced formats and nonfinite input', () => {
  const original = wav([[100], [200]]), enhanced = wav([[300], [400]]);
  for (const bad of [wav([[300], [400]], { sampleRate: 48000 }), wav([[300]]), wav([[1], [2]], { format: 3 }), wav([[300, 400], [500, 600]])]) {
    assert.throws(() => mixEnhancementWav(original, bad, 50), /clock|mono PCM16/);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => mixEnhancementWav(wav([[value], [0]], { format: 3 }), enhanced, 50), /nonfinite/);
  }
  const malformed = [original.slice(0, 43), original.slice(0)];
  new DataView(malformed[1]).setUint16(32, 4, true);
  for (const bytes of malformed) assert.throws(() => mixEnhancementWav(bytes, enhanced, 50), /RIFF WAV|valid source clock/);
  const unsupported = original.slice(0); new DataView(unsupported).setUint16(34, 24, true);
  assert.throws(() => mixEnhancementWav(unsupported, enhanced, 50), /PCM16 or float32/);
  const truncated = original.slice(0); new DataView(truncated).setUint32(40, 9999, true);
  assert.throws(() => mixEnhancementWav(truncated, enhanced, 50), /truncated/);
  for (const strength of [-1, 101, 0.5, NaN, '50']) assert.throws(() => mixEnhancementWav(original, enhanced, strength), /Invalid audio strength/);
});
