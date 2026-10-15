import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/content/audio-enhancement-worker.ts'], bundle: true,
  format: 'iife', platform: 'browser', write: false, logLevel: 'silent'
});
const source = `const { parentPort } = require('node:worker_threads');
  globalThis.addEventListener = (type, listener) => {
    if (type === 'message') parentPort.on('message', data => listener({ data }));
  };
  globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
  ${bundle.outputFiles[0].text}`;

/** Runs the actual bundled DSP in a separate thread, including real transfers. */
export class AudioWorkerFixture extends EventTarget {
  static instances = [];
  static onRequest = null;
  constructor(url) {
    super();
    this.url = url;
    this.terminated = false;
    this.requests = [];
    this.thread = new Worker(source, { eval: true });
    AudioWorkerFixture.instances.push(this);
    this.thread.on('message', data => {
      if (this.terminated) return;
      const event = new Event('message');
      event.data = data;
      this.dispatchEvent(event);
    });
    this.thread.on('error', error => {
      if (this.terminated) return;
      const event = new Event('error');
      event.message = error.message;
      this.dispatchEvent(event);
    });
  }
  postMessage(data, transfer) {
    this.requests.push(data.type);
    this.thread.postMessage(data, transfer);
    AudioWorkerFixture.onRequest?.(data, this);
  }
  terminate() {
    this.terminated = true;
    void this.thread.terminate();
  }
}
