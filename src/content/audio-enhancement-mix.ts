export interface SourceWavHeader {
  sampleRate: number;
  frameCount: number;
  channels: number;
  format: number;
  bytesPerSample: number;
  blockAlign: number;
  dataOffset: number;
}

/** PCM formats and arithmetic channel downmix match Gold's enhancement input. */
export function readSourceWavHeader(bytes: ArrayBuffer): SourceWavHeader {
  const view = new DataView(bytes);
  if (bytes.byteLength < 44 || view.getUint32(0, false) !== 0x52494646 ||
      view.getUint32(8, false) !== 0x57415645 || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new Error('Native source is not a complete RIFF WAV.');
  }
  let sampleRate = 0, channels = 0, format = 0, bits = 0, blockAlign = 0, dataOffset = -1, dataLength = 0;
  let formatSeen = false, dataSeen = false;
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error('Native WAV chunk is truncated.');
    const size = view.getUint32(offset + 4, true);
    const next = offset + 8 + size + (size & 1);
    if (next > bytes.byteLength) throw new Error('Native WAV data is truncated.');
    const id = view.getUint32(offset, false);
    if (id === 0x666d7420) {
      if (formatSeen || size < 16) throw new Error('Native WAV has an invalid format chunk.');
      formatSeen = true;
      format = view.getUint16(offset + 8, true); channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true); blockAlign = view.getUint16(offset + 20, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 0x64617461) {
      if (dataSeen) throw new Error('Native WAV has duplicate PCM data.');
      dataSeen = true; dataOffset = offset + 8; dataLength = size;
    }
    offset = next;
  }
  const bytesPerSample = format === 1 && bits === 16 ? 2 : format === 3 && bits === 32 ? 4 : 0;
  if (!bytesPerSample || !channels || !sampleRate || blockAlign !== channels * bytesPerSample ||
      dataOffset < 0 || dataLength < blockAlign || dataLength % blockAlign) {
    throw new Error('Native WAV requires nonempty PCM16 or float32 audio with a valid source clock.');
  }
  return { sampleRate, frameCount: dataLength / blockAlign, channels, format, bytesPerSample, blockAlign, dataOffset };
}

function monoSample(view: DataView, header: SourceWavHeader, frame: number): number {
  let sum = 0;
  for (let channel = 0; channel < header.channels; channel += 1) {
    const offset = header.dataOffset + frame * header.blockAlign + channel * header.bytesPerSample;
    const value = header.format === 1 ? view.getInt16(offset, true) / 32768 : view.getFloat32(offset, true);
    if (!Number.isFinite(value)) throw new Error('Native source PCM is nonfinite.');
    sum += value;
  }
  return Math.fround(sum / header.channels);
}

/** Endpoints retain their source bytes; intermediate output is only PCM16 quantization. */
export function mixEnhancementWav(original: ArrayBuffer, enhanced: ArrayBuffer, strength: number): ArrayBuffer {
  if (!Number.isInteger(strength) || strength < 0 || strength > 100) throw new Error('Invalid audio strength.');
  const source = readSourceWavHeader(original), output = readSourceWavHeader(enhanced);
  if (source.sampleRate !== output.sampleRate || source.frameCount !== output.frameCount ||
      output.format !== 1 || output.channels !== 1 || output.bytesPerSample !== 2) {
    throw new Error('Enhanced PCM does not match the original source clock or mono PCM16 format.');
  }
  if (strength === 0) return original;
  if (strength === 100) return enhanced;
  const bytes = new ArrayBuffer(44 + source.frameCount * 2), view = new DataView(bytes);
  view.setUint32(0, 0x52494646, false); view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(8, 0x57415645, false); view.setUint32(12, 0x666d7420, false); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, source.sampleRate, true);
  view.setUint32(28, source.sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false); view.setUint32(40, source.frameCount * 2, true);
  const originalView = new DataView(original), enhancedView = new DataView(enhanced), weight = strength / 100;
  for (let frame = 0; frame < source.frameCount; frame += 1) {
    const sample = (1 - weight) * monoSample(originalView, source, frame) + weight * monoSample(enhancedView, output, frame);
    view.setInt16(44 + frame * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), true);
  }
  return bytes;
}
